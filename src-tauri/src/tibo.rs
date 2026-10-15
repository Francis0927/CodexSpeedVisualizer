use serde::{Deserialize, Serialize};
use std::{
    io::Read,
    time::{Duration, Instant},
};

const STATUS_URL: &str = "https://codex-resets.com/api/v1/status";
pub const POLL_INTERVAL: Duration = Duration::from_secs(30 * 60);

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ResetType {
    Regular,
    Banked,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Reset {
    pub reset_type: ResetType,
    pub announced_at: String,
    pub text: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ScheduledReset {
    pub reset_type: ResetType,
    pub scheduled_for: Option<String>,
    pub announced_at: String,
    pub text: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WatchLevel {
    Elevated,
    Strong,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Watch {
    pub level: WatchLevel,
    pub reset_chance_percent: Option<u8>,
    pub forecast_window: String,
    pub observed_at: String,
    pub expires_at: String,
    pub text: String,
}

// A missing field is a malformed response, whereas an explicit null means
// there is currently no announcement/watch. Do not silently clear cached data.
fn required_option<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Data {
    #[serde(deserialize_with = "required_option")]
    pub latest_reset: Option<Reset>,
    #[serde(deserialize_with = "required_option")]
    pub scheduled_reset: Option<ScheduledReset>,
    #[serde(deserialize_with = "required_option")]
    pub active_watch: Option<Watch>,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub data: Option<Data>,
    pub fetched_at: Option<i64>,
    pub error: Option<String>,
}

fn parse_response(bytes: &[u8]) -> Result<Data, String> {
    #[derive(Deserialize)]
    struct Response {
        data: Data,
    }
    let data = serde_json::from_slice::<Response>(bytes)
        .map_err(|_| "预测接口返回了无效数据".to_string())?
        .data;
    let valid_date = |date: &str| chrono::DateTime::parse_from_rfc3339(date).is_ok();
    let valid = data
        .latest_reset
        .as_ref()
        .is_none_or(|r| valid_date(&r.announced_at))
        && data.scheduled_reset.as_ref().is_none_or(|r| {
            valid_date(&r.announced_at) && r.scheduled_for.as_deref().is_none_or(valid_date)
        })
        && data.active_watch.as_ref().is_none_or(|w| {
            valid_date(&w.observed_at)
                && valid_date(&w.expires_at)
                && w.reset_chance_percent.is_none_or(|p| p <= 100)
        });
    if !valid {
        return Err("预测接口返回了无效数据".into());
    }
    Ok(data)
}

fn fetch() -> Result<Data, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "无法初始化预测查询".to_string())?;
    let response = client
        .get(STATUS_URL)
        .header("Accept", "application/json")
        .send()
        .map_err(|_| "预测查询失败，请检查网络连接".to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "预测服务暂不可用（HTTP {}）",
            response.status().as_u16()
        ));
    }
    let mut bytes = Vec::new();
    response
        .take(256 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "预测数据读取失败".to_string())?;
    if bytes.len() > 256 * 1024 {
        return Err("预测接口响应过大".into());
    }
    parse_response(&bytes)
}

pub struct Tracker {
    pub snapshot: Snapshot,
    next_poll: Instant,
}

impl Tracker {
    pub fn new() -> Self {
        Self {
            snapshot: Snapshot::default(),
            next_poll: Instant::now(),
        }
    }

    pub fn poll(&mut self) -> bool {
        self.poll_with(Instant::now(), fetch)
    }

    fn poll_with(&mut self, now: Instant, request: impl FnOnce() -> Result<Data, String>) -> bool {
        if now < self.next_poll {
            return false;
        }
        // Schedule from the current attempt, so resume never causes catch-up bursts.
        self.next_poll = now + POLL_INTERVAL;
        match request() {
            Ok(data) => {
                self.snapshot.data = Some(data);
                self.snapshot.fetched_at = Some(crate::usage::now());
                self.snapshot.error = None;
            }
            Err(error) => self.snapshot.error = Some(error),
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn empty() -> Data {
        parse_response(
            br#"{"data":{"latest_reset":null,"scheduled_reset":null,"active_watch":null}}"#,
        )
        .unwrap()
    }

    #[test]
    fn polls_immediately_then_every_half_hour_including_after_failure() {
        let mut tracker = Tracker::new();
        let start = Instant::now();
        assert!(tracker.poll_with(start, || Ok(empty())));
        let fetched_at = tracker.snapshot.fetched_at;
        assert!(
            !tracker.poll_with(start + POLL_INTERVAL - Duration::from_millis(1), || panic!(
                "too soon"
            ))
        );
        assert!(tracker.poll_with(start + POLL_INTERVAL, || Err("offline".into())));
        assert!(tracker.snapshot.data.is_some());
        assert_eq!(tracker.snapshot.fetched_at, fetched_at);
        assert_eq!(tracker.snapshot.error.as_deref(), Some("offline"));
        assert!(
            !tracker.poll_with(start + POLL_INTERVAL + Duration::from_secs(1), || panic!(
                "no rapid retry"
            ))
        );
        assert!(tracker.poll_with(start + POLL_INTERVAL * 2, || Ok(empty())));
        assert!(tracker.snapshot.error.is_none());
    }

    #[test]
    fn accepts_announcements_and_watch_without_inventing_probability() {
        let data = parse_response(br#"{"data":{"latest_reset":null,"scheduled_reset":{"reset_type":"banked","announced_at":"2026-10-15T04:00:00Z","scheduled_for":null,"text":"Soon"},"active_watch":{"level":"strong","reset_chance_percent":null,"forecast_window":"today","observed_at":"2026-10-15T04:00:00Z","expires_at":"2026-10-16T04:00:00Z","text":"Maybe"}}}"#).unwrap();
        assert!(data.scheduled_reset.unwrap().scheduled_for.is_none());
        assert!(data.active_watch.unwrap().reset_chance_percent.is_none());
    }

    #[test]
    fn rejects_missing_fields_bad_dates_and_invalid_probability() {
        assert!(parse_response(br#"{"data":{}}"#).is_err());
        assert!(parse_response(br#"not json"#).is_err());
        for (date, probability) in [("bad", "50"), ("2026-10-15T04:00:00Z", "101")] {
            let body = format!(
                r#"{{"data":{{"latest_reset":null,"scheduled_reset":null,"active_watch":{{"level":"elevated","reset_chance_percent":{probability},"forecast_window":"today","observed_at":"{date}","expires_at":"2026-10-16T04:00:00Z","text":"Maybe"}}}}}}"#
            );
            assert!(parse_response(body.as_bytes()).is_err());
        }
    }
}
