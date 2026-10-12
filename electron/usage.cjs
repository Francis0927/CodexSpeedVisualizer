const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { watch } = require("node:fs");

const POLL_MS = 2000;
const DISCOVERY_MS = 30000;
const MAX_EVENT_AGE_MS = 12000;
// Speed is an exponential moving average over usage events: each event
// contributes output * exp(-age / TAU) / TAU_SECONDS, so a steady stream of
// R tokens/s reads as R and bursts decay smoothly instead of cliff-dropping
// out of a hard 10s window. Below MIN_SPEED_TOKENS we show 0.
const SPEED_TAU_MS = 15000;
const MIN_SPEED_TOKENS = 0.5;

function dayKey(date) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function count(value) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function readUsage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const input = count(raw.input_tokens);
  const output = count(raw.output_tokens);
  if (!("input_tokens" in raw) || !("output_tokens" in raw)) return null;
  return { input, output };
}

function readRateLimits(raw, timestamp) {
  if (!raw || typeof raw !== "object") return null;
  // Model-specific buckets must not replace the shared Codex quota.
  if (raw.limit_id != null && raw.limit_id !== "codex") return null;
  const limits = { updatedAt: timestamp, fiveHour: null, weekly: null };
  for (const window of [raw.primary, raw.secondary]) {
    if (!window || !Number.isFinite(window.used_percent)) continue;
    const key = window.window_minutes === 300 ? "fiveHour" : window.window_minutes === 10080 ? "weekly" : null;
    if (!key) continue;
    const resetsAt = Number.isFinite(window.resets_at) && window.resets_at > 0 && window.resets_at <= 8.64e12
      ? window.resets_at * 1000 : null;
    limits[key] = { remainingPercent: Math.max(0, Math.min(100, 100 - window.used_percent)), resetsAt };
  }
  return limits.fiveHour || limits.weekly ? limits : null;
}

function dayStart(timestamp) {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

// Only today's/future numeric details are needed for clock changes and late
// lifecycle messages. Historical dates retain totals, not per-event objects.
class RecentRows {
  constructor() { this.data = new Float64Array(24); this.length = 0; }
  push(timestamp, output, previous) {
    if (this.length * 3 === this.data.length) {
      const next = new Float64Array(this.data.length * 2);
      next.set(this.data); this.data = next;
    }
    this.data.set([timestamp, output, previous], this.length++ * 3);
  }
}

function newFileState(historyResetAt = 0, now = () => Date.now(), deduplicate = null) {
  return {
    offset: 0, pendingChunks: [], pendingLength: 0,
    recordCount: 0, counterCount: 0, days: new Map(), historyTotal: 0,
    starts: [], startOrders: [], priorStart: null, startOrder: 0,
    startsSorted: true, startIndex: null, turnDirty: false,
    latestLife: null, lastRecordTime: null, maxRecentTime: -Infinity,
    recentDay: dayStart(now()), rateLimits: null, previousCounter: null,
    lineNumber: 0, historyResetAt, now, deduplicate,
    seen: deduplicate ? null : new Set(), stat: null
  };
}

function compactRecent(state, start) {
  if (state.recentDay === start) return;
  for (const [day, bucket] of state.days) {
    if (day < dayKey(start)) {
      bucket.recent = null; bucket.futureSpeed = [];
      bucket.speedValue = 0; bucket.lastTurn = null;
    }
  }
  const times = [], orders = [];
  let prior = state.priorStart;
  for (let i = 0; i < state.starts.length; i++) {
    if (state.starts[i] < start) {
      if (!prior || state.startOrders[i] > prior.order) prior = { timestamp: state.starts[i], order: state.startOrders[i] };
    } else { times.push(state.starts[i]); orders.push(state.startOrders[i]); }
  }
  state.starts = times; state.startOrders = orders; state.priorStart = prior;
  state.startIndex = null; state.recentDay = start;
}

function latestStart(state, timestamp) {
  if (!state.startIndex) {
    // Normal logs are chronological: query their timestamps directly. For
    // out-of-order logs a prefix index preserves the last-written eligible
    // task_started, matching the old reverse search without a quadratic loop.
    if (state.startsSorted) {
      let low = 0, high = state.starts.length;
      while (low < high) { const mid = (low + high) >>> 1; if (state.starts[mid] <= timestamp) low = mid + 1; else high = mid; }
      const index = low - 1;
      const prior = state.priorStart;
      if (prior && prior.timestamp <= timestamp && (index < 0 || prior.order > state.startOrders[index])) return prior.timestamp;
      return index >= 0 ? state.starts[index] : null;
    }
    const entries = state.starts.map((time, i) => ({ time, order: state.startOrders[i] }));
    if (state.priorStart) entries.push({ time: state.priorStart.timestamp, order: state.priorStart.order });
    entries.sort((a, b) => a.time - b.time);
    const times = new Float64Array(entries.length), values = new Float64Array(entries.length);
    let best = null;
    for (let i = 0; i < entries.length; i++) {
      if (!best || entries[i].order > best.order) best = entries[i];
      times[i] = entries[i].time; values[i] = best.time;
    }
    state.startIndex = { times, values };
  }
  const { times, values } = state.startIndex;
  let low = 0, high = times.length;
  while (low < high) { const mid = (low + high) >>> 1; if (times[mid] <= timestamp) low = mid + 1; else high = mid; }
  return low ? values[low - 1] : null;
}

function updateTurn(state, bucket, timestamp, output, previous) {
  if (!output || Number.isNaN(previous)) return;
  const started = latestStart(state, timestamp);
  let duration = started === null ? 0 : timestamp - started;
  if (!(duration > 0) && Number.isFinite(previous)) duration = timestamp - previous;
  if (duration >= 1000 && (!bucket.lastTurn || timestamp > bucket.lastTurn.timestamp)) {
    bucket.lastTurn = { timestamp, speed: output / (duration / 1000), tokens: output, seconds: duration / 1000 };
  }
}

function addSpeed(bucket, timestamp, output) {
  if (bucket.speedAt === null) { bucket.speedAt = timestamp; bucket.speedValue = output / 15; }
  else if (timestamp > bucket.speedAt) {
    bucket.speedValue = bucket.speedValue * Math.exp(-(timestamp - bucket.speedAt) / SPEED_TAU_MS) + output / 15;
    bucket.speedAt = timestamp;
  } else bucket.speedValue += output / 15 * Math.exp(-(bucket.speedAt - timestamp) / SPEED_TAU_MS);
}

function addUsage(state, event, previous = NaN) {
  const now = state.now();
  compactRecent(state, dayStart(now));
  const day = dayKey(event.timestamp);
  let bucket = state.days.get(day);
  if (!bucket) {
    bucket = { input: 0, output: 0, count: 0, lastEvent: null, lastTurn: null,
      recent: null, speedAt: null, speedValue: 0, speedClock: now, futureSpeed: [] };
    state.days.set(day, bucket);
  }
  bucket.input += event.input; bucket.output += event.output; bucket.count++;
  bucket.lastEvent = Math.max(bucket.lastEvent ?? -Infinity, event.timestamp);
  if (event.timestamp >= state.historyResetAt) state.historyTotal += event.input + event.output;
  if (event.timestamp >= state.recentDay) {
    bucket.recent ??= new RecentRows();
    bucket.recent.push(event.timestamp, event.output, previous);
    state.maxRecentTime = Math.max(state.maxRecentTime, event.timestamp);
    if (event.timestamp <= now) addSpeed(bucket, event.timestamp, event.output);
    else bucket.futureSpeed.push(event.timestamp, event.output);
    if (state.startsSorted && !state.turnDirty) updateTurn(state, bucket, event.timestamp, event.output, previous);
    else state.turnDirty = true;
  }
}

function acceptLine(state, line) {
  state.lineNumber++;
  if (!["token_usage_record", "token_count", "task_started", "task_complete", "turn_aborted"].some((type) => line.includes(`"${type}"`))) return;
  let entry;
  try { entry = JSON.parse(line); } catch { return; }
  const timestamp = Date.parse(entry?.timestamp);
  if (!Number.isFinite(timestamp)) return;

  if (entry.type === "event_msg" && ["task_started", "task_complete", "turn_aborted"].includes(entry.payload?.type)) {
    compactRecent(state, dayStart(state.now()));
    state.latestLife = { type: entry.payload.type, timestamp };
    if (entry.payload.type === "task_started") {
      const order = state.startOrder++;
      if (timestamp < state.recentDay) state.priorStart = { timestamp, order };
      else {
        if (state.starts.length && timestamp < state.starts[state.starts.length - 1]) state.startsSorted = false;
        state.starts.push(timestamp); state.startOrders.push(order);
      }
      state.startIndex = null;
      if (timestamp <= state.maxRecentTime) state.turnDirty = true;
    }
  }

  if (entry.type === "token_usage_record") {
    const usage = readUsage(entry.payload?.usage);
    if (!usage) return;
    if (!state.recordCount++) { state.days.clear(); state.historyTotal = 0; state.maxRecentTime = -Infinity; }
    const previous = state.lastRecordTime ?? -Infinity;
    state.lastRecordTime = timestamp;
    const id = entry.payload?.response_id || `line:${state.lineNumber}`;
    if (state.deduplicate ? state.deduplicate(id) : !state.seen.has(id)) {
      state.seen?.add(id);
      addUsage(state, { ...usage, timestamp }, previous);
    }
  } else if (entry.type === "event_msg" && entry.payload?.type === "token_count") {
    // Quota-only updates and repeated token counters are still meaningful.
    const limits = readRateLimits(entry.payload?.rate_limits, timestamp);
    if (limits && (!state.rateLimits || limits.updatedAt >= state.rateLimits.updatedAt)) state.rateLimits = limits;
    const usage = readUsage(entry.payload?.info?.total_token_usage);
    if (!usage) return;
    const prev = state.previousCounter;
    const input = prev && usage.input >= prev.input ? usage.input - prev.input : usage.input;
    const output = prev && usage.output >= prev.output ? usage.output - prev.output : usage.output;
    state.previousCounter = usage;
    if (input || output) {
      state.counterCount++;
      if (!state.recordCount) addUsage(state, { input, output, timestamp });
    }
  }
}

function acceptBytes(state, bytes) {
  let start = 0;
  for (let end = bytes.indexOf(10); end !== -1; end = bytes.indexOf(10, start)) {
    let line;
    if (state.pendingLength) {
      state.pendingChunks.push(bytes.subarray(start, end));
      const whole = Buffer.concat(state.pendingChunks, state.pendingLength + end - start);
      line = whole.toString("utf8").trim();
      state.pendingChunks = []; state.pendingLength = 0;
    } else line = bytes.subarray(start, end).toString("utf8").trim();
    if (line) acceptLine(state, line);
    start = end + 1;
  }
  if (start < bytes.length) {
    // Own only this fragment; a tiny tail must not retain the whole read buffer.
    state.pendingChunks.push(Buffer.from(bytes.subarray(start)));
    state.pendingLength += bytes.length - start;
  }
}

async function listJsonl(root, results = []) {
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); }
  catch (error) {
    if (error.code === "ENOENT") return results;
    throw error;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) await listJsonl(full, results);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) results.push(full);
  }
  return results;
}

class UsageCollector {
  constructor(home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), now = () => Date.now(), historyResetAt = 0, options = {}) {
    this.home = home;
    this.now = now;
    this.files = new Map();
    this.historyResetAt = Number.isFinite(historyResetAt) && historyResetAt >= 0 ? historyResetAt : 0;
    this.onUpdate = () => {};
    this.timer = null;
    this.busy = false;
    this.lastError = null;
    this.responseOwners = new Map();
    this.nextRank = 0;
    this.running = false;
    this.watcher = null;
    this.watch = options.watch || watch;
    this.dirtyFiles = new Set();
    this.needsDiscovery = true;
    this.lastDiscovery = -Infinity;
    this.rebuildRequested = false;
    this.polling = null;
  }

  tryWatch() {
    if (!this.running || this.watcher) return;
    try {
      const watcher = this.watch(this.home, { recursive: true, persistent: false }, (event, filename) => {
        if (!filename) { this.needsDiscovery = true; return; }
        const relative = String(filename).replace(/\\/g, "/");
        if (!/^(sessions|archived_sessions)(\/|$)/.test(relative)) return;
        if (relative.endsWith(".jsonl")) this.dirtyFiles.add(path.join(this.home, relative));
        if (event === "rename") this.needsDiscovery = true;
      });
      watcher.on("error", () => {
        watcher.close();
        if (this.watcher === watcher) this.watcher = null;
        this.needsDiscovery = true;
      });
      this.watcher = watcher;
    } catch { /* Missing home / unsupported watcher: retain the 2s polling fallback. */ }
  }

  makeState() {
    const rank = this.nextRank++;
    const state = newFileState(this.historyResetAt, this.now, (id) => {
      const owner = this.responseOwners.get(id);
      if (owner !== undefined) {
        // An earlier file acquired a response already seen in a later file.
        // Replay in file order so duplicate precedence remains deterministic.
        if (rank < owner) this.rebuildRequested = true;
        return false;
      }
      this.responseOwners.set(id, rank); return true;
    });
    state.rank = rank;
    return state;
  }

  async readFile(file, state, stat) {
    if (stat.size > state.offset) {
      const handle = await fs.open(file, "r");
      try {
        while (state.offset < stat.size) {
          const bytes = Buffer.allocUnsafe(Math.min(65536, stat.size - state.offset));
          const { bytesRead } = await handle.read(bytes, 0, bytes.length, state.offset);
          if (!bytesRead) break;
          acceptBytes(state, bytes.subarray(0, bytesRead));
          state.offset += bytesRead;
        }
      } finally { await handle.close(); }
    }
    state.stat = { mtimeMs: stat.mtimeMs, identity: `${stat.dev}:${stat.ino}:${stat.birthtimeMs}` };
  }

  async rebuild() {
    const paths = [...this.files.keys()];
    this.files.clear(); this.responseOwners.clear(); this.nextRank = 0;
    this.rebuildRequested = false;
    for (const file of paths) {
      let stat;
      try { stat = await fs.stat(file); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
      const state = this.makeState(); this.files.set(file, state);
      await this.readFile(file, state, stat);
    }
  }

  poll(options = {}) {
    if (this.polling) return this.polling;
    this.busy = true;
    this.polling = this.collect(options).finally(() => { this.busy = false; this.polling = null; });
    return this.polling;
  }

  async collect(options) {
    try {
      const now = this.now();
      const fullScan = options.fullScan || !this.running || !this.watcher || this.needsDiscovery || now - this.lastDiscovery >= DISCOVERY_MS;
      const dirty = this.dirtyFiles; this.dirtyFiles = new Set();
      let candidates = [...dirty];
      if (fullScan) {
        this.needsDiscovery = false;
        const [active, archived] = await Promise.all([
          listJsonl(path.join(this.home, "sessions")), listJsonl(path.join(this.home, "archived_sessions"))
        ]);
        const present = new Set([...active, ...archived]);
        for (const file of this.files.keys()) {
          if (!present.has(file)) { this.files.delete(file); this.rebuildRequested = true; }
        }
        candidates = [...present]; this.lastDiscovery = now;
        this.tryWatch();
      }
      candidates.sort((a, b) => (this.files.get(a)?.rank ?? Infinity) - (this.files.get(b)?.rank ?? Infinity));
      for (const file of candidates) {
        let stat;
        try { stat = await fs.stat(file); } catch (error) {
          if (error.code !== "ENOENT") throw error;
          if (this.files.delete(file)) this.rebuildRequested = true;
          continue;
        }
        let state = this.files.get(file);
        if (!state) { state = this.makeState(); this.files.set(file, state); }
        const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
        if (state.stat && (stat.size < state.offset || identity !== state.stat.identity ||
          (stat.size === state.offset && stat.mtimeMs !== state.stat.mtimeMs))) {
          this.rebuildRequested = true;
        }
        if (!this.rebuildRequested) await this.readFile(file, state, stat);
      }
      if (this.rebuildRequested) await this.rebuild();
      this.lastError = null;
      this.onUpdate(this.snapshot());
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.onUpdate(this.snapshot());
      // Retry discovery after an I/O failure, even when notifications are lost.
      this.needsDiscovery = true;
    }
  }

  snapshot() {
    const now = this.now();
    const today = dayKey(now);
    let input = 0;
    let output = 0;
    let historyTotal = 0;
    let speed = 0;
    let lastEvent = null;
    let eventCount = 0;
    let running = false;
    let lastTurn = null;
    let rateLimits = null;
    for (const state of this.files.values()) {
      compactRecent(state, dayStart(now));
      if (state.rateLimits && (!rateLimits || state.rateLimits.updatedAt > rateLimits.updatedAt)) rateLimits = state.rateLimits;
      const latestLife = state.latestLife;
      if (latestLife?.type === "task_started" && now - latestLife.timestamp < 2 * 60 * 60 * 1000) running = true;
      historyTotal += state.historyTotal;
      if (state.turnDirty) {
        for (const bucket of state.days.values()) {
          if (!bucket.recent) continue;
          bucket.lastTurn = null;
          const { data, length } = bucket.recent;
          for (let i = 0; i < length * 3; i += 3) updateTurn(state, bucket, data[i], data[i + 1], data[i + 2]);
        }
        state.turnDirty = false;
      }
      const bucket = state.days.get(today);
      if (!bucket) continue;
      input += bucket.input; output += bucket.output; eventCount += bucket.count;
      if (lastEvent === null || bucket.lastEvent > lastEvent) lastEvent = bucket.lastEvent;
      if (bucket.lastTurn && (!lastTurn || bucket.lastTurn.timestamp > lastTurn.timestamp)) lastTurn = bucket.lastTurn;
      if (now < bucket.speedClock && bucket.recent) {
        bucket.speedAt = null; bucket.speedValue = 0; bucket.futureSpeed = [];
        const { data, length } = bucket.recent;
        for (let i = 0; i < length * 3; i += 3) {
          if (data[i] <= now) addSpeed(bucket, data[i], data[i + 1]);
          else bucket.futureSpeed.push(data[i], data[i + 1]);
        }
      }
      const pending = [];
      for (let i = 0; i < bucket.futureSpeed.length; i += 2) {
        if (bucket.futureSpeed[i] <= now) addSpeed(bucket, bucket.futureSpeed[i], bucket.futureSpeed[i + 1]);
        else pending.push(bucket.futureSpeed[i], bucket.futureSpeed[i + 1]);
      }
      bucket.futureSpeed = pending; bucket.speedClock = now;
      if (bucket.speedAt !== null) speed += bucket.speedValue * Math.exp(-(now - bucket.speedAt) / SPEED_TAU_MS);
    }
    const active = lastEvent !== null && now - lastEvent <= MAX_EVENT_AGE_MS;
    if (speed < MIN_SPEED_TOKENS) speed = 0;
    return {
      day: today,
      input,
      output,
      total: input + output,
      historyTotal,
      rateLimits,
      speed,
      turnSpeed: lastTurn ? lastTurn.speed : null,
      turnTokens: lastTurn ? lastTurn.tokens : null,
      turnSeconds: lastTurn ? Math.round(lastTurn.seconds) : null,
      active,
      running,
      lastEvent,
      eventCount,
      source: this.lastError ? "error" : this.files.size ? "ready" : "waiting",
      error: this.lastError
    };
  }

  async resetHistory(timestamp = this.now()) {
    if (this.polling) await this.polling;
    this.historyResetAt = timestamp;
    // Rare explicit reset: replay compacted history against the new cutoff so
    // arbitrary reset timestamps and future-dated records stay exact.
    this.rebuildRequested = true;
    await this.poll({ fullScan: true });
    const snapshot = this.snapshot();
    this.onUpdate(snapshot);
    return snapshot;
  }

  start(onUpdate) {
    this.stop();
    this.onUpdate = onUpdate;
    this.running = true;
    this.tryWatch();
    this.timer = setInterval(() => void this.poll(), POLL_MS);
    void this.poll();
  }

  stop() {
    this.running = false;
    this.watcher?.close(); this.watcher = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { UsageCollector, dayKey, newFileState, acceptBytes };
