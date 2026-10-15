use chrono::{DateTime, Local, TimeZone};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashMap},
    fs::{self, File, Metadata},
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::mpsc::{self, Receiver},
};

pub fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
fn trim_line(line: &str) -> &str {
    line.trim_matches(|c: char| c == '\u{feff}' || (c.is_whitespace() && c != '\u{85}'))
}
pub fn day(ts: i64) -> String {
    Local
        .timestamp_millis_opt(ts)
        .single()
        .unwrap()
        .format("%Y-%m-%d")
        .to_string()
}
fn day_start(ts: i64) -> i64 {
    let date = Local
        .timestamp_millis_opt(ts)
        .single()
        .unwrap()
        .date_naive();
    Local
        .from_local_datetime(&date.and_hms_opt(0, 0, 0).unwrap())
        .earliest()
        .map(|d| d.timestamp_millis())
        .unwrap_or(ts)
}
fn count(v: &Value) -> u64 {
    v.as_f64()
        .filter(|n| n.is_finite() && *n >= 0.0)
        .unwrap_or(0.0)
        .floor() as u64
}
fn tokens(v: &Value) -> Option<(u64, u64)> {
    (v.get("input_tokens").is_some() && v.get("output_tokens").is_some())
        .then(|| (count(&v["input_tokens"]), count(&v["output_tokens"])))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaWindow {
    remaining_percent: f64,
    resets_at: Option<i64>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RateLimits {
    updated_at: i64,
    five_hour: Option<QuotaWindow>,
    weekly: Option<QuotaWindow>,
}
fn quota(raw: &Value, ts: i64) -> Option<RateLimits> {
    if !raw.is_object()
        || raw
            .get("limit_id")
            .is_some_and(|v| !v.is_null() && v != "codex")
    {
        return None;
    }
    let mut result = RateLimits {
        updated_at: ts,
        five_hour: None,
        weekly: None,
    };
    for key in ["primary", "secondary"] {
        let value = &raw[key];
        let Some(used) = value["used_percent"].as_f64().filter(|n| n.is_finite()) else {
            continue;
        };
        let item = QuotaWindow {
            remaining_percent: (100.0 - used).clamp(0.0, 100.0),
            resets_at: value["resets_at"]
                .as_f64()
                .filter(|n| *n > 0.0 && *n <= 8.64e12)
                .map(|n| (n * 1000.0) as i64),
        };
        match value["window_minutes"].as_u64() {
            Some(300) => result.five_hour = Some(item),
            Some(10080) => result.weekly = Some(item),
            _ => {}
        }
    }
    (result.five_hour.is_some() || result.weekly.is_some()).then_some(result)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub day: String,
    pub input: u64,
    pub output: u64,
    pub total: u64,
    pub history_total: u64,
    pub rate_limits: Option<RateLimits>,
    pub speed: f64,
    pub turn_speed: Option<f64>,
    pub turn_tokens: Option<u64>,
    pub turn_seconds: Option<f64>,
    pub active: bool,
    pub running: bool,
    pub last_event: Option<i64>,
    pub event_count: u64,
    pub source: String,
    pub error: Option<String>,
}
#[derive(Clone, Copy)]
struct Row {
    ts: i64,
    output: u64,
    previous: Option<i64>,
}
#[derive(Clone, Copy)]
struct Turn {
    ts: i64,
    speed: f64,
    tokens: u64,
    seconds: f64,
}
#[derive(Default)]
struct Bucket {
    input: u64,
    output: u64,
    count: u64,
    last_event: Option<i64>,
    last_turn: Option<Turn>,
    recent: Option<Vec<Row>>,
    speed_at: Option<i64>,
    speed_value: f64,
    speed_clock: i64,
    future: Vec<(i64, u64)>,
}
impl Bucket {
    fn add_speed(&mut self, ts: i64, output: u64) {
        if let Some(at) = self.speed_at {
            if ts > at {
                self.speed_value =
                    self.speed_value * (-((ts - at) as f64) / 15000.0).exp() + output as f64 / 15.0;
                self.speed_at = Some(ts);
            } else {
                self.speed_value += output as f64 / 15.0 * (-((at - ts) as f64) / 15000.0).exp();
            }
        } else {
            self.speed_at = Some(ts);
            self.speed_value = output as f64 / 15.0;
        }
    }
    fn turn(&mut self, row: Row, started: Option<i64>) {
        if row.output == 0 || row.previous.is_none() {
            return;
        }
        let mut duration = started.map(|s| row.ts - s).unwrap_or(0);
        if duration <= 0 {
            if let Some(previous) = row.previous.filter(|t| *t != i64::MIN) {
                duration = row.ts - previous;
            }
        }
        if duration >= 1000 && self.last_turn.is_none_or(|t| row.ts > t.ts) {
            let seconds = duration as f64 / 1000.0;
            self.last_turn = Some(Turn {
                ts: row.ts,
                speed: row.output as f64 / seconds,
                tokens: row.output,
                seconds,
            });
        }
    }
}
struct FileState {
    offset: u64,
    pending: Vec<u8>,
    line_number: u64,
    record_count: u64,
    days: BTreeMap<String, Bucket>,
    history_total: u64,
    starts: Vec<(i64, u64)>,
    prior_start: Option<(i64, u64)>,
    start_order: u64,
    starts_sorted: bool,
    start_index: Option<Vec<(i64, i64)>>,
    turn_dirty: bool,
    latest_life: Option<(String, i64)>,
    last_record: Option<i64>,
    max_recent: i64,
    recent_day: i64,
    limits: Option<RateLimits>,
    previous_counter: Option<(u64, u64)>,
    stat: Option<(
        u64,
        Option<std::time::SystemTime>,
        Option<std::time::SystemTime>,
    )>,
}
impl FileState {
    fn new(clock: i64) -> Self {
        Self {
            offset: 0,
            pending: vec![],
            line_number: 0,
            record_count: 0,
            days: BTreeMap::new(),
            history_total: 0,
            starts: vec![],
            prior_start: None,
            start_order: 0,
            starts_sorted: true,
            start_index: None,
            turn_dirty: false,
            latest_life: None,
            last_record: None,
            max_recent: i64::MIN,
            recent_day: day_start(clock),
            limits: None,
            previous_counter: None,
            stat: None,
        }
    }
    fn compact(&mut self, clock: i64) {
        let start = day_start(clock);
        if start == self.recent_day {
            return;
        }
        let key = day(start);
        for (d, b) in &mut self.days {
            if d < &key {
                b.recent = None;
                b.future.clear();
                b.speed_value = 0.0;
                b.last_turn = None;
            }
        }
        let mut prior = self.prior_start;
        self.starts.retain(|&(ts, order)| {
            if ts < start {
                if prior.is_none_or(|p| order > p.1) {
                    prior = Some((ts, order));
                }
                false
            } else {
                true
            }
        });
        self.prior_start = prior;
        self.start_index = None;
        self.recent_day = start;
    }
    fn latest_start(&mut self, ts: i64) -> Option<i64> {
        if self.starts_sorted {
            let at = self.starts.partition_point(|v| v.0 <= ts);
            let latest = at.checked_sub(1).map(|i| self.starts[i]);
            if let Some(prior) = self.prior_start {
                if prior.0 <= ts && latest.is_none_or(|l| prior.1 > l.1) {
                    return Some(prior.0);
                }
            }
            return latest.map(|v| v.0);
        }
        if self.start_index.is_none() {
            let mut entries = self.starts.clone();
            if let Some(p) = self.prior_start {
                entries.push(p);
            }
            entries.sort_by_key(|v| v.0);
            let mut best: Option<(i64, u64)> = None;
            self.start_index = Some(
                entries
                    .into_iter()
                    .map(|v| {
                        if best.is_none_or(|b| v.1 > b.1) {
                            best = Some(v);
                        }
                        (v.0, best.unwrap().0)
                    })
                    .collect(),
            );
        }
        let index = self.start_index.as_ref().unwrap();
        let at = index.partition_point(|v| v.0 <= ts);
        at.checked_sub(1).map(|i| index[i].1)
    }
    fn add(
        &mut self,
        ts: i64,
        input: u64,
        output: u64,
        previous: Option<i64>,
        clock: i64,
        reset: i64,
    ) {
        self.compact(clock);
        let started = if ts >= self.recent_day && self.starts_sorted && !self.turn_dirty {
            self.latest_start(ts)
        } else {
            None
        };
        let b = self.days.entry(day(ts)).or_insert_with(|| Bucket {
            speed_clock: clock,
            ..Default::default()
        });
        b.input += input;
        b.output += output;
        b.count += 1;
        b.last_event = Some(b.last_event.unwrap_or(i64::MIN).max(ts));
        if ts >= reset {
            self.history_total += input + output;
        }
        if ts >= self.recent_day {
            let row = Row {
                ts,
                output,
                previous,
            };
            b.recent.get_or_insert_with(Vec::new).push(row);
            self.max_recent = self.max_recent.max(ts);
            if ts <= clock {
                b.add_speed(ts, output);
            } else {
                b.future.push((ts, output));
            }
            if self.starts_sorted && !self.turn_dirty {
                b.turn(row, started);
            } else {
                self.turn_dirty = true;
            }
        }
    }
    fn line(
        &mut self,
        line: &str,
        clock: i64,
        reset: i64,
        rank: usize,
        owners: &mut HashMap<String, usize>,
        rebuild: &mut bool,
    ) {
        self.line_number += 1;
        if ![
            "\"token_usage_record\"",
            "\"token_count\"",
            "\"task_started\"",
            "\"task_complete\"",
            "\"turn_aborted\"",
        ]
        .iter()
        .any(|s| line.contains(s))
        {
            return;
        }
        let Ok(e) = serde_json::from_str::<Value>(line) else {
            return;
        };
        let Some(ts) = e["timestamp"]
            .as_str()
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            .map(|d| d.timestamp_millis())
        else {
            return;
        };
        let p = &e["payload"];
        if e["type"] == "event_msg"
            && ["task_started", "task_complete", "turn_aborted"]
                .iter()
                .any(|s| p["type"] == *s)
        {
            self.compact(clock);
            self.latest_life = Some((p["type"].as_str().unwrap().to_string(), ts));
            if p["type"] == "task_started" {
                let order = self.start_order;
                self.start_order += 1;
                if ts < self.recent_day {
                    self.prior_start = Some((ts, order));
                } else {
                    if self.starts.last().is_some_and(|v| ts < v.0) {
                        self.starts_sorted = false;
                    }
                    self.starts.push((ts, order));
                }
                self.start_index = None;
                if ts <= self.max_recent {
                    self.turn_dirty = true;
                }
            }
        }
        if e["type"] == "token_usage_record" {
            let Some((input, output)) = tokens(&p["usage"]) else {
                return;
            };
            if self.record_count == 0 {
                self.days.clear();
                self.history_total = 0;
                self.max_recent = i64::MIN;
            }
            self.record_count += 1;
            let previous = self.last_record.unwrap_or(i64::MIN);
            self.last_record = Some(ts);
            let id = p["response_id"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .unwrap_or_else(|| format!("line:{}", self.line_number));
            if let Some(owner) = owners.get(&id) {
                if rank < *owner {
                    *rebuild = true;
                }
            } else {
                owners.insert(id, rank);
                self.add(ts, input, output, Some(previous), clock, reset);
            }
        } else if e["type"] == "event_msg" && p["type"] == "token_count" {
            if let Some(limits) = quota(&p["rate_limits"], ts) {
                if self.limits.as_ref().is_none_or(|l| ts >= l.updated_at) {
                    self.limits = Some(limits);
                }
            }
            let Some((input, output)) = tokens(&p["info"]["total_token_usage"]) else {
                return;
            };
            let (delta_in, delta_out) = self
                .previous_counter
                .map(|(a, b)| {
                    (
                        if input >= a { input - a } else { input },
                        if output >= b { output - b } else { output },
                    )
                })
                .unwrap_or((input, output));
            self.previous_counter = Some((input, output));
            if self.record_count == 0 && (delta_in > 0 || delta_out > 0) {
                self.add(ts, delta_in, delta_out, None, clock, reset);
            }
        }
    }
    fn bytes(
        &mut self,
        bytes: &[u8],
        clock: i64,
        reset: i64,
        rank: usize,
        owners: &mut HashMap<String, usize>,
        rebuild: &mut bool,
    ) {
        let mut start = 0;
        for (end, &byte) in bytes.iter().enumerate() {
            if byte == b'\n' {
                if self.pending.is_empty() {
                    let line = String::from_utf8_lossy(&bytes[start..end]);
                    if !trim_line(&line).is_empty() {
                        self.line(trim_line(&line), clock, reset, rank, owners, rebuild);
                    }
                } else {
                    self.pending.extend_from_slice(&bytes[start..end]);
                    let data = std::mem::take(&mut self.pending);
                    let line = String::from_utf8_lossy(&data);
                    if !trim_line(&line).is_empty() {
                        self.line(trim_line(&line), clock, reset, rank, owners, rebuild);
                    }
                }
                start = end + 1;
            }
        }
        self.pending.extend_from_slice(&bytes[start..]);
    }
    fn read(
        &mut self,
        path: &Path,
        meta: &Metadata,
        clock: i64,
        reset: i64,
        rank: usize,
        owners: &mut HashMap<String, usize>,
        rebuild: &mut bool,
    ) -> Result<(), String> {
        if meta.len() > self.offset {
            let mut file = File::open(path).map_err(|e| e.to_string())?;
            file.seek(SeekFrom::Start(self.offset))
                .map_err(|e| e.to_string())?;
            let mut buffer = [0u8; 65536];
            while self.offset < meta.len() {
                let length = (meta.len() - self.offset).min(65536) as usize;
                let n = file
                    .read(&mut buffer[..length])
                    .map_err(|e| e.to_string())?;
                if n == 0 {
                    break;
                }
                self.bytes(&buffer[..n], clock, reset, rank, owners, rebuild);
                self.offset += n as u64;
            }
        }
        self.stat = Some((meta.len(), meta.modified().ok(), meta.created().ok()));
        Ok(())
    }
}
fn list(root: &Path, result: &mut Vec<PathBuf>) -> Result<(), String> {
    let entries = match fs::read_dir(root) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.to_string()),
    };
    let mut entries = entries
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let t = entry.file_type().map_err(|e| e.to_string())?;
        if t.is_dir() {
            list(&entry.path(), result)?;
        } else if t.is_file() && entry.path().extension().is_some_and(|s| s == "jsonl") {
            result.push(entry.path());
        }
    }
    Ok(())
}
pub struct Collector {
    home: PathBuf,
    files: Vec<(PathBuf, FileState)>,
    owners: HashMap<String, usize>,
    pub reset_at: i64,
    error: Option<String>,
    last_discovery: i64,
    discover: bool,
    watcher: Option<RecommendedWatcher>,
    events: Receiver<notify::Result<notify::Event>>,
    watch_sender: mpsc::Sender<notify::Result<notify::Event>>,
}
impl Collector {
    pub fn new(home: PathBuf, reset_at: i64) -> Self {
        let home = if home.is_absolute() {
            home
        } else {
            std::env::current_dir().unwrap_or_default().join(home)
        };
        let (sender, events) = mpsc::channel();
        Self {
            home,
            files: vec![],
            owners: HashMap::new(),
            reset_at,
            error: None,
            last_discovery: i64::MIN,
            discover: true,
            watcher: None,
            events,
            watch_sender: sender,
        }
    }
    pub fn home() -> PathBuf {
        std::env::var_os("CODEX_HOME")
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(std::env::var_os("USERPROFILE").unwrap_or_default()).join(".codex")
            })
    }
    fn watch(&mut self) {
        if self.watcher.is_some() {
            return;
        }
        let sender = self.watch_sender.clone();
        if let Ok(mut watcher) = notify::recommended_watcher(move |e| {
            let _ = sender.send(e);
        }) {
            if watcher.watch(&self.home, RecursiveMode::Recursive).is_ok() {
                self.watcher = Some(watcher);
            }
        }
    }
    pub fn poll(&mut self, clock: i64, force: bool) -> Snapshot {
        let result = self.collect(clock, force);
        self.error = result.err();
        if self.error.is_some() {
            self.discover = true;
        }
        self.snapshot(clock)
    }
    fn collect(&mut self, clock: i64, force: bool) -> Result<(), String> {
        let mut dirty = vec![];
        while let Ok(event) = self.events.try_recv() {
            match event {
                Ok(e) => {
                    for p in e.paths {
                        if p.strip_prefix(&self.home)
                            .ok()
                            .and_then(|s| s.components().next())
                            .is_some_and(|c| {
                                c.as_os_str() == "sessions" || c.as_os_str() == "archived_sessions"
                            })
                        {
                            if p.extension().is_some_and(|s| s == "jsonl") {
                                dirty.push(p);
                            }
                            if e.kind.is_create()
                                || e.kind.is_remove()
                                || matches!(
                                    e.kind,
                                    notify::EventKind::Modify(notify::event::ModifyKind::Name(_))
                                )
                            {
                                self.discover = true;
                            }
                        }
                    }
                }
                Err(_) => {
                    self.watcher = None;
                    self.discover = true;
                }
            }
        }
        let full = force
            || self.discover
            || self.watcher.is_none()
            || clock.saturating_sub(self.last_discovery) >= 30000;
        let mut rebuild = false;
        if full {
            dirty.clear();
            list(&self.home.join("sessions"), &mut dirty)?;
            list(&self.home.join("archived_sessions"), &mut dirty)?;
            let present: std::collections::HashSet<_> = dirty.iter().collect();
            if self.files.iter().any(|(p, _)| !present.contains(p)) {
                self.files.retain(|(p, _)| present.contains(p));
                rebuild = true;
            }
            self.discover = false;
            self.last_discovery = clock;
            self.watch();
        }
        let mut seen_paths = std::collections::HashSet::new();
        dirty.retain(|path| seen_paths.insert(path.clone()));
        if dirty.is_empty() && !rebuild {
            return Ok(());
        }
        let mut ranks: HashMap<PathBuf, usize> = self
            .files
            .iter()
            .enumerate()
            .map(|(i, (p, _))| (p.clone(), i))
            .collect();
        dirty.sort_by_key(|p| ranks.get(p).copied().unwrap_or(usize::MAX));
        for path in dirty {
            let meta = match fs::metadata(&path) {
                Ok(m) => m,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    if let Some(i) = self.files.iter().position(|(p, _)| p == &path) {
                        self.files.remove(i);
                        rebuild = true;
                        ranks = self
                            .files
                            .iter()
                            .enumerate()
                            .map(|(i, (p, _))| (p.clone(), i))
                            .collect();
                    }
                    continue;
                }
                Err(e) => return Err(e.to_string()),
            };
            let rank = ranks.get(&path).copied().unwrap_or_else(|| {
                self.files.push((path.clone(), FileState::new(clock)));
                let rank = self.files.len() - 1;
                ranks.insert(path.clone(), rank);
                rank
            });
            let state = &mut self.files[rank].1;
            if let Some((_, modified, created)) = state.stat {
                if meta.len() < state.offset
                    || created != meta.created().ok()
                    || (meta.len() == state.offset && modified != meta.modified().ok())
                {
                    rebuild = true;
                }
            }
            if !rebuild {
                state.read(
                    &path,
                    &meta,
                    clock,
                    self.reset_at,
                    rank,
                    &mut self.owners,
                    &mut rebuild,
                )?;
            }
        }
        if rebuild {
            self.owners.clear();
            for (rank, (p, s)) in self.files.iter_mut().enumerate() {
                *s = FileState::new(clock);
                let meta = fs::metadata(p.as_path()).map_err(|e| e.to_string())?;
                let mut ignored = false;
                s.read(
                    p,
                    &meta,
                    clock,
                    self.reset_at,
                    rank,
                    &mut self.owners,
                    &mut ignored,
                )?;
            }
        }
        Ok(())
    }
    pub fn reset(&mut self, clock: i64, cutoff: i64) -> Snapshot {
        self.reset_at = cutoff;
        for (_, state) in &mut self.files {
            *state = FileState::new(clock);
        }
        self.owners.clear();
        self.poll(clock, true)
    }
    pub fn snapshot(&mut self, clock: i64) -> Snapshot {
        let today = day(clock);
        let mut result = Snapshot {
            day: today.clone(),
            input: 0,
            output: 0,
            total: 0,
            history_total: 0,
            rate_limits: None,
            speed: 0.0,
            turn_speed: None,
            turn_tokens: None,
            turn_seconds: None,
            active: false,
            running: false,
            last_event: None,
            event_count: 0,
            source: if self.error.is_some() {
                "error"
            } else if self.files.is_empty() {
                "waiting"
            } else {
                "ready"
            }
            .into(),
            error: self.error.clone(),
        };
        let mut last_turn: Option<Turn> = None;
        for (_, s) in &mut self.files {
            s.compact(clock);
            if let Some(l) = &s.limits {
                if result
                    .rate_limits
                    .as_ref()
                    .is_none_or(|r| l.updated_at > r.updated_at)
                {
                    result.rate_limits = Some(l.clone());
                }
            }
            if let Some((t, ts)) = &s.latest_life {
                if t == "task_started" && clock - ts < 7200000 {
                    result.running = true;
                }
            }
            result.history_total += s.history_total;
            if s.turn_dirty {
                let keys: Vec<_> = s.days.keys().cloned().collect();
                for key in keys {
                    if let Some(rows) = s.days[&key].recent.clone() {
                        s.days.get_mut(&key).unwrap().last_turn = None;
                        for row in rows {
                            let started = s.latest_start(row.ts);
                            s.days.get_mut(&key).unwrap().turn(row, started);
                        }
                    }
                }
                s.turn_dirty = false;
            }
            let Some(b) = s.days.get_mut(&today) else {
                continue;
            };
            result.input += b.input;
            result.output += b.output;
            result.event_count += b.count;
            if let Some(ts) = b.last_event {
                result.last_event = Some(result.last_event.unwrap_or(i64::MIN).max(ts));
            }
            if let Some(turn) = b.last_turn {
                if last_turn.is_none_or(|t| turn.ts > t.ts) {
                    last_turn = Some(turn);
                }
            }
            if clock < b.speed_clock {
                if let Some(rows) = b.recent.clone() {
                    b.speed_at = None;
                    b.speed_value = 0.0;
                    b.future.clear();
                    for row in rows {
                        if row.ts <= clock {
                            b.add_speed(row.ts, row.output);
                        } else {
                            b.future.push((row.ts, row.output));
                        }
                    }
                }
            }
            let pending = std::mem::take(&mut b.future);
            for (ts, output) in pending {
                if ts <= clock {
                    b.add_speed(ts, output);
                } else {
                    b.future.push((ts, output));
                }
            }
            b.speed_clock = clock;
            if let Some(at) = b.speed_at {
                result.speed += b.speed_value * (-((clock - at) as f64) / 15000.0).exp();
            }
        }
        result.total = result.input + result.output;
        result.active = result.last_event.is_some_and(|t| clock - t <= 12000);
        if result.speed < 0.5 {
            result.speed = 0.0;
        }
        if let Some(t) = last_turn {
            result.turn_speed = Some(t.speed);
            result.turn_tokens = Some(t.tokens);
            result.turn_seconds = Some(t.seconds.round());
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn quota_filters_shared_windows() {
        let v = serde_json::json!({"primary":{"used_percent":120,"window_minutes":300,"resets_at":42},"secondary":{"used_percent":-5,"window_minutes":10080}});
        let q = quota(&v, 100).unwrap();
        assert_eq!(q.five_hour.unwrap().remaining_percent, 0.0);
        assert_eq!(q.weekly.unwrap().remaining_percent, 100.0);
        assert!(quota(&serde_json::json!({"limit_id":"other","primary":{"used_percent":5,"window_minutes":300}}),100).is_none());
    }
    #[test]
    fn partial_utf8_and_record_precedence() {
        let clock = now();
        let ts = chrono::Utc::now().to_rfc3339();
        let line=format!("{{\"timestamp\":\"{ts}\",\"type\":\"token_usage_record\",\"payload\":{{\"response_id\":\"中文\",\"usage\":{{\"input_tokens\":30,\"output_tokens\":10}}}}}}\n");
        let mut s = FileState::new(clock);
        let mut owners = HashMap::new();
        let mut rebuild = false;
        for b in line.as_bytes().chunks(3) {
            s.bytes(b, clock, 0, 0, &mut owners, &mut rebuild);
        }
        s.bytes(line.as_bytes(), clock, 0, 0, &mut owners, &mut rebuild);
        assert_eq!(s.history_total, 40);
        assert!(s.pending.is_empty());
    }
    #[test]
    fn missing_home_recovers_then_watcher_tracks_appends() {
        let directory = tempfile::tempdir().unwrap();
        let home = directory.path().join("codex");
        let mut c = Collector::new(home.clone(), 0);
        let clock = now();
        assert_eq!(c.poll(clock, false).source, "waiting");
        let folder = home.join("sessions");
        std::fs::create_dir_all(&folder).unwrap();
        let file = folder.join("rollout.jsonl");
        let line = |id: &str| {
            format!("{{\"timestamp\":\"{}\",\"type\":\"token_usage_record\",\"payload\":{{\"response_id\":\"{id}\",\"usage\":{{\"input_tokens\":10,\"output_tokens\":20}}}}}}\n",chrono::Utc::now().to_rfc3339())
        };
        std::fs::write(&file, line("a")).unwrap();
        assert_eq!(c.poll(clock + 1000, false).total, 30);
        {
            use std::io::Write;
            let mut f = std::fs::OpenOptions::new()
                .append(true)
                .open(&file)
                .unwrap();
            f.write_all(line("b").as_bytes()).unwrap();
        }
        let mut result = c.snapshot(clock + 2000);
        for _ in 0..20 {
            std::thread::sleep(std::time::Duration::from_millis(50));
            result = c.poll(clock + 2000, false);
            if result.total == 60 {
                break;
            }
        }
        assert_eq!(result.total, 60);
        assert_eq!(c.poll(clock + 3000, false).total, 60);
    }
}
