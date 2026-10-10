const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const POLL_MS = 2000;
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

function newFileState() {
  return {
    offset: 0,
    pending: Buffer.alloc(0),
    records: [],
    counters: [],
    lifecycle: [],
    rateLimits: null,
    previousCounter: null,
    lineNumber: 0
  };
}

function acceptLine(state, line) {
  state.lineNumber++;
  if (!["token_usage_record", "token_count", "task_started", "task_complete", "turn_aborted"].some((type) => line.includes(`"${type}"`))) return;
  let entry;
  try { entry = JSON.parse(line); } catch { return; }
  const timestamp = Date.parse(entry?.timestamp);
  if (!Number.isFinite(timestamp)) return;

  if (entry.type === "event_msg" && ["task_started", "task_complete", "turn_aborted"].includes(entry.payload?.type)) {
    state.lifecycle.push({ type: entry.payload.type, timestamp });
  }

  if (entry.type === "token_usage_record") {
    const usage = readUsage(entry.payload?.usage);
    if (!usage) return;
    state.records.push({
      ...usage,
      timestamp,
      id: entry.payload?.response_id || `line:${state.lineNumber}`
    });
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
    if (input || output) state.counters.push({ input, output, timestamp, id: `line:${state.lineNumber}` });
  }
}

function acceptBytes(state, bytes) {
  const buffer = Buffer.concat([state.pending, bytes]);
  let start = 0;
  for (let end = buffer.indexOf(10, start); end !== -1; end = buffer.indexOf(10, start)) {
    const line = buffer.subarray(start, end).toString("utf8").trim();
    if (line) acceptLine(state, line);
    start = end + 1;
  }
  state.pending = buffer.subarray(start);
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
  constructor(home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), now = () => Date.now(), historyResetAt = 0) {
    this.home = home;
    this.now = now;
    this.files = new Map();
    this.historyResetAt = Number.isFinite(historyResetAt) && historyResetAt >= 0 ? historyResetAt : 0;
    this.onUpdate = () => {};
    this.timer = null;
    this.busy = false;
    this.lastError = null;
  }

  async poll() {
    if (this.busy) return;
    this.busy = true;
    try {
      const [active, archived] = await Promise.all([
        listJsonl(path.join(this.home, "sessions")),
        listJsonl(path.join(this.home, "archived_sessions"))
      ]);
      const present = new Set([...active, ...archived]);
      for (const file of this.files.keys()) {
        if (!present.has(file)) this.files.delete(file);
      }
      for (const file of present) {
        let stat;
        try { stat = await fs.stat(file); } catch { continue; }
        let state = this.files.get(file);
        if (!state || stat.size < state.offset) {
          state = newFileState();
          this.files.set(file, state);
        }
        if (stat.size > state.offset) {
          const handle = await fs.open(file, "r");
          try {
            while (state.offset < stat.size) {
              const bytes = Buffer.allocUnsafe(Math.min(65536, stat.size - state.offset));
              const { bytesRead } = await handle.read(bytes, 0, bytes.length, state.offset);
              if (!bytesRead) break;
              state.offset += bytesRead;
              acceptBytes(state, bytes.subarray(0, bytesRead));
            }
          } finally { await handle.close(); }
        }
      }
      this.lastError = null;
      this.onUpdate(this.snapshot());
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.onUpdate(this.snapshot());
    } finally {
      this.busy = false;
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
    const seen = new Set();
    for (const [file, state] of this.files) {
      if (state.rateLimits && (!rateLimits || state.rateLimits.updatedAt > rateLimits.updatedAt)) rateLimits = state.rateLimits;
      const latestLife = state.lifecycle[state.lifecycle.length - 1];
      if (latestLife?.type === "task_started" && now - latestLife.timestamp < 2 * 60 * 60 * 1000) running = true;
      const events = state.records.length ? state.records : state.counters;
      for (const event of events) {
        const key = state.records.length ? event.id : `${file}:${event.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (event.timestamp >= this.historyResetAt) historyTotal += event.input + event.output;
        if (dayKey(event.timestamp) !== today) continue;
        input += event.input;
        output += event.output;
        eventCount++;
        const age = now - event.timestamp;
        if (age >= 0) speed += event.output * Math.exp(-age / SPEED_TAU_MS) / (SPEED_TAU_MS / 1000);
        if (lastEvent === null || event.timestamp > lastEvent) lastEvent = event.timestamp;
        // Per-turn average rate for the most recent completed turn. Records land
        // at turn completion, so pair each record with its task_started (fall
        // back to the gap between consecutive records in the same file).
        if (state.records.length && event.output > 0) {
          let turnMs = 0;
          for (let j = state.lifecycle.length - 1; j >= 0; j--) {
            const life = state.lifecycle[j];
            if (life.type === "task_started" && life.timestamp <= event.timestamp) { turnMs = event.timestamp - life.timestamp; break; }
          }
          if (!(turnMs > 0)) {
            const idx = state.records.indexOf(event);
            if (idx > 0) turnMs = event.timestamp - state.records[idx - 1].timestamp;
          }
          if (turnMs >= 1000 && (!lastTurn || event.timestamp > lastTurn.timestamp)) {
            lastTurn = { timestamp: event.timestamp, speed: event.output / (turnMs / 1000), tokens: event.output, seconds: turnMs / 1000 };
          }
        }
      }
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

  resetHistory(timestamp = this.now()) {
    this.historyResetAt = timestamp;
    const snapshot = this.snapshot();
    this.onUpdate(snapshot);
    return snapshot;
  }

  start(onUpdate) {
    this.onUpdate = onUpdate;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), POLL_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { UsageCollector, dayKey, newFileState, acceptBytes };
