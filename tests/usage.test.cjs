const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { UsageCollector, dayKey, newFileState, acceptBytes } = require("./reference/electron/usage.cjs");

function record(time, id, input, output) {
  return JSON.stringify({ timestamp: new Date(time).toISOString(), type: "token_usage_record", payload: {
    response_id: id, usage: { input_tokens: input, output_tokens: output, cached_input_tokens: 20 }
  } }) + "\n";
}

function counter(time, input, output) {
  return JSON.stringify({ timestamp: new Date(time).toISOString(), type: "event_msg", payload: {
    type: "token_count", info: { total_token_usage: { input_tokens: input, output_tokens: output } }
  } }) + "\n";
}

function lifecycle(time, type) {
  return JSON.stringify({ timestamp: new Date(time).toISOString(), type: "event_msg", payload: { type } }) + "\n";
}

function quotaEvent(time, primary, secondary, extra = {}) {
  return JSON.stringify({ timestamp: new Date(time).toISOString(), type: "event_msg", payload: {
    type: "token_count", ...extra,
    rate_limits: { limit_id: "codex", primary, secondary, ...extra.rate_limits }
  } }) + "\n";
}

function quotaWindow(used, minutes, resetsAt) {
  return { used_percent: used, window_minutes: minutes, resets_at: resetsAt };
}

async function fixture(now) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "speed-pet-test-"));
  const folder = path.join(home, "sessions", "2026", "09", "24");
  await fs.mkdir(folder, { recursive: true });
  const file = path.join(folder, "rollout-test.jsonl");
  await fs.writeFile(file, "");
  await fs.utimes(file, now, now);
  return { home, file, cleanup: () => fs.rm(home, { recursive: true, force: true }) };
}

test("uses response records once, excludes cached tokens from extra addition, and survives restart", async () => {
  const now = new Date(2026, 8, 24, 12, 0, 0);
  const sample = await fixture(now);
  try {
    const time = new Date(now.getTime() - 2000);
    await fs.writeFile(sample.file, record(time, "resp-a", 100, 40) + record(time, "resp-a", 100, 40) + counter(time, 100, 40));
    const first = new UsageCollector(sample.home, () => now.getTime());
    await first.poll();
    assert.equal(first.snapshot().total, 140);
    assert.equal(first.snapshot().historyTotal, 140);
    assert.equal(first.snapshot().input, 100);
    assert.equal(first.snapshot().output, 40);
    // EMA: 40 tokens, 2s old, tau=15s -> 40/15 * e^(-2/15) ~= 2.334
    assert.ok(Math.abs(first.snapshot().speed - (40 / 15) * Math.exp(-2 / 15)) < 0.01);
    await first.poll();
    assert.equal(first.snapshot().total, 140);
    const restarted = new UsageCollector(sample.home, () => now.getTime());
    await restarted.poll();
    assert.equal(restarted.snapshot().total, 140);
    assert.equal(restarted.snapshot().historyTotal, 140);
  } finally { await sample.cleanup(); }
});

test("handles a partially written line and then a new event", () => {
  const state = newFileState();
  const line = record(new Date(2026, 8, 24, 12), "resp-a", 30, 10);
  acceptBytes(state, Buffer.from(line.slice(0, 22)));
  assert.equal(state.recordCount, 0);
  acceptBytes(state, Buffer.from(line.slice(22)));
  assert.equal(state.recordCount, 1);
  assert.equal(state.days.get(dayKey(new Date(2026, 8, 24, 12))).output, 10);
});

test("falls back to cumulative counters and attributes deltas to local calendar day", async () => {
  const now = new Date(2026, 8, 24, 0, 1, 0);
  const sample = await fixture(now);
  try {
    const yesterday = new Date(2026, 8, 23, 23, 59, 0);
    const today = new Date(2026, 8, 24, 0, 0, 30);
    await fs.writeFile(sample.file, counter(yesterday, 120, 30) + counter(today, 220, 55));
    const collector = new UsageCollector(sample.home, () => now.getTime());
    await collector.poll();
    assert.equal(collector.snapshot().input, 100);
    assert.equal(collector.snapshot().output, 25);
    assert.equal(collector.snapshot().speed, 0);
    assert.equal(dayKey(today), collector.snapshot().day);
  } finally { await sample.cleanup(); }
});

test("new day resets visible total without double counting earlier records", async () => {
  const day1 = new Date(2026, 8, 24, 23, 59, 59);
  const day2 = new Date(2026, 8, 25, 0, 0, 2);
  const sample = await fixture(day1);
  try {
    await fs.writeFile(sample.file, record(day1, "resp-a", 20, 10));
    let current = day1.getTime();
    const collector = new UsageCollector(sample.home, () => current);
    await collector.poll();
    assert.equal(collector.snapshot().total, 30);
    current = day2.getTime();
    await fs.appendFile(sample.file, record(day2, "resp-b", 50, 20));
    await fs.utimes(sample.file, day2, day2);
    await collector.poll();
    assert.equal(collector.snapshot().total, 70);
    assert.equal(collector.snapshot().historyTotal, 100);
  } finally { await sample.cleanup(); }
});

test("history includes older sessions and stays reset across restarts", async () => {
  const now = new Date(2026, 8, 25, 12, 0, 0);
  const yesterday = new Date(2026, 8, 24, 12, 0, 0);
  const sample = await fixture(yesterday);
  try {
    await fs.writeFile(sample.file,
      record(yesterday, "resp-old", 20, 10) +
      record(new Date(now.getTime() - 1000), "resp-today", 7, 3));
    await fs.utimes(sample.file, yesterday, yesterday);
    const collector = new UsageCollector(sample.home, () => now.getTime());
    await collector.poll();
    assert.equal(collector.snapshot().total, 10);
    assert.equal(collector.snapshot().historyTotal, 40);

    const resetAt = await collector.resetHistory();
    assert.equal(resetAt.historyTotal, 0);
    assert.equal(resetAt.total, 10);
    await fs.appendFile(sample.file, record(new Date(now.getTime() + 1000), "resp-new", 50, 20));
    await collector.poll();
    assert.equal(collector.snapshot().historyTotal, 70);
    assert.equal(collector.snapshot().total, 80);

    const restarted = new UsageCollector(sample.home, () => now.getTime() + 2000, now.getTime());
    await restarted.poll();
    assert.equal(restarted.snapshot().historyTotal, 70);
    assert.equal(restarted.snapshot().total, 80);
  } finally { await sample.cleanup(); }
});


test("speed is an exponential moving average that decays bursts smoothly", async () => {
  const now = new Date(2026, 8, 24, 12, 0, 0);
  const sample = await fixture(now);
  try {
    const time = new Date(now.getTime() - 30000);
    await fs.writeFile(sample.file, record(time, "resp-a", 0, 1500));
    const collector = new UsageCollector(sample.home, () => now.getTime());
    await collector.poll();
    // 1500 tokens 30s ago: 1500/15 * e^(-2) ~= 13.53
    assert.ok(Math.abs(collector.snapshot().speed - (1500 / 15) * Math.exp(-2)) < 0.01);
    // The same burst 90s later decays below the 0.5 floor and reads as 0.
    const later = new UsageCollector(sample.home, () => now.getTime() + 90000);
    await later.poll();
    assert.equal(later.snapshot().speed, 0);
  } finally { await sample.cleanup(); }
});

test("reports the average rate of the most recent turn from lifecycle events", async () => {
  const now = new Date(2026, 8, 24, 12, 0, 0);
  const sample = await fixture(now);
  try {
    await fs.writeFile(sample.file,
      lifecycle(new Date(now.getTime() - 40000), "task_started") +
      record(now, "resp-a", 100, 200));
    const collector = new UsageCollector(sample.home, () => now.getTime());
    await collector.poll();
    assert.equal(collector.snapshot().turnSpeed, 5);
    assert.equal(collector.snapshot().turnTokens, 200);
    assert.equal(collector.snapshot().turnSeconds, 40);
  } finally { await sample.cleanup(); }
});

test("falls back to the gap between records when no task_started exists", async () => {
  const now = new Date(2026, 8, 24, 12, 0, 0);
  const sample = await fixture(now);
  try {
    await fs.writeFile(sample.file,
      record(new Date(now.getTime() - 25000), "resp-a", 100, 50) +
      record(new Date(now.getTime() - 5000), "resp-b", 100, 100));
    const collector = new UsageCollector(sample.home, () => now.getTime());
    await collector.poll();
    assert.equal(collector.snapshot().turnSpeed, 5);
    assert.equal(collector.snapshot().turnSeconds, 20);
  } finally { await sample.cleanup(); }
});
test("shows a running task while waiting for its first usage record", async () => {
  const now = new Date(2026, 8, 24, 12, 0, 0);
  const sample = await fixture(now);
  try {
    await fs.writeFile(sample.file, lifecycle(new Date(now.getTime() - 1000), "task_started"));
    const collector = new UsageCollector(sample.home, () => now.getTime());
    await collector.poll();
    assert.equal(collector.snapshot().running, true);
    assert.equal(collector.snapshot().speed, 0);
    await fs.appendFile(sample.file, lifecycle(now, "task_complete"));
    await collector.poll();
    assert.equal(collector.snapshot().running, false);
  } finally { await sample.cleanup(); }
});

test("does not double count a session copied into the archive", async () => {
  const now = new Date(2026, 8, 24, 12, 0, 0);
  const sample = await fixture(now);
  try {
    const archive = path.join(sample.home, "archived_sessions", "rollout-copy.jsonl");
    await fs.mkdir(path.dirname(archive), { recursive: true });
    const data = record(now, "resp-shared", 75, 25);
    await fs.writeFile(sample.file, data);
    await fs.writeFile(archive, data);
    const collector = new UsageCollector(sample.home, () => now.getTime());
    await collector.poll();
    assert.equal(collector.snapshot().total, 100);
    assert.equal(collector.snapshot().historyTotal, 100);
  } finally { await sample.cleanup(); }
});

test("reads quota-only events and repeated counters without changing token totals", async () => {
  const now = Date.now();
  const sample = await fixture(new Date(now));
  try {
    const resetsAt = Math.floor(now / 1000) + 3600;
    await fs.writeFile(sample.file, counter(now - 3000, 100, 20) + quotaEvent(now - 2000,
      quotaWindow(25.5, 300, resetsAt), quotaWindow(60, 10080, resetsAt + 86400)));
    const collector = new UsageCollector(sample.home, () => now);
    await collector.poll();
    assert.equal(collector.snapshot().total, 120);
    assert.deepEqual(collector.snapshot().rateLimits, {
      updatedAt: now - 2000,
      fiveHour: { remainingPercent: 74.5, resetsAt: resetsAt * 1000 },
      weekly: { remainingPercent: 40, resetsAt: (resetsAt + 86400) * 1000 }
    });
    await fs.appendFile(sample.file, quotaEvent(now - 1000, quotaWindow(30, 300, resetsAt), null,
      { info: { total_token_usage: { input_tokens: 100, output_tokens: 20 } } }));
    await collector.poll();
    assert.equal(collector.snapshot().total, 120);
    assert.equal(collector.snapshot().eventCount, 1);
    assert.equal(collector.snapshot().rateLimits.fiveHour.remainingPercent, 70);
    assert.equal(collector.snapshot().rateLimits.weekly, null);
    await collector.resetHistory();
    assert.equal(collector.snapshot().rateLimits.fiveHour.remainingPercent, 70);
  } finally { await sample.cleanup(); }
});

test("selects the newest account quota across sessions, archives, days and out-of-order events", async () => {
  const now = Date.now();
  const sample = await fixture(new Date(now));
  try {
    const reset = Math.floor(now / 1000) + 3600;
    const archive = path.join(sample.home, "archived_sessions", "old-session.jsonl");
    await fs.mkdir(path.dirname(archive), { recursive: true });
    await fs.writeFile(archive, quotaEvent(now - 86400000, quotaWindow(10, 300, reset), null));
    await fs.writeFile(sample.file,
      quotaEvent(now - 1000, quotaWindow(81, 300, reset), quotaWindow(23, 10080, reset + 86400)) +
      quotaEvent(now - 2000, quotaWindow(50, 300, reset), null) +
      quotaEvent(now, quotaWindow(99, 300, reset), null, { rate_limits: { limit_id: "codex_other" } }));
    const collector = new UsageCollector(sample.home, () => now);
    await collector.poll();
    assert.equal(collector.snapshot().rateLimits.updatedAt, now - 1000);
    assert.equal(collector.snapshot().rateLimits.fiveHour.remainingPercent, 19);
    assert.equal(collector.snapshot().rateLimits.weekly.remainingPercent, 77);
    const restarted = new UsageCollector(sample.home, () => now);
    await restarted.poll();
    assert.deepEqual(restarted.snapshot().rateLimits, collector.snapshot().rateLimits);
  } finally { await sample.cleanup(); }
});

test("identifies quota windows by duration, clamps percentages, and preserves unknown reset times", () => {
  const now = Date.now();
  const state = newFileState();
  acceptBytes(state, Buffer.from(quotaEvent(now,
    quotaWindow(-2, 10080, null), quotaWindow(102, 300, "123"))));
  assert.deepEqual(state.rateLimits, {
    updatedAt: now,
    fiveHour: { remainingPercent: 0, resetsAt: null },
    weekly: { remainingPercent: 100, resetsAt: null }
  });
  const collector = new UsageCollector("unused", () => now + 1000);
  collector.files.set("session", state);
  assert.equal(collector.snapshot().rateLimits.fiveHour.remainingPercent, 0);
});

test("missing, invalid and unrelated quota windows do not fabricate remaining allowance", () => {
  const now = Date.now();
  const state = newFileState();
  acceptBytes(state, Buffer.from(counter(now, 20, 5) + quotaEvent(now,
    quotaWindow(null, 300, null), quotaWindow(20, 60, now / 1000))));
  assert.equal(state.rateLimits, null);
  acceptBytes(state, Buffer.from(quotaEvent(now + 1, quotaWindow(30, 300, 8.65e12), null,
    { rate_limits: { limit_id: null } })));
  assert.equal(state.rateLimits.fiveHour.remainingPercent, 70);
  assert.equal(state.rateLimits.fiveHour.resetsAt, null);
  acceptBytes(state, Buffer.from(quotaEvent(now + 2, null, null)));
  assert.equal(state.rateLimits.updatedAt, now + 1);
});

test("chunked large UTF-8 lines release their backing buffers and preserve the following record", () => {
  const now = Date.now();
  const state = newFileState(0, () => now);
  const line = Buffer.from(JSON.stringify({ type: "response_item", payload: { text: "中文".repeat(700000) } }) + "\n" + record(now, "after-large-line", 7, 3));
  for (let start = 0; start < line.length; start += 65536) acceptBytes(state, line.subarray(start, start + 65536));
  assert.equal(state.recordCount, 1);
  assert.equal(state.days.get(dayKey(now)).input, 7);
  assert.equal(state.pendingLength, 0);
  assert.deepEqual(state.pendingChunks, [], "completed lines must release all native buffers");
  assert.equal(state.lineNumber, 2);
});

test("late and out-of-order lifecycle events repair cached turn duration once", () => {
  const now = new Date(2026, 8, 24, 12).getTime();
  const state = newFileState(0, () => now);
  const collector = new UsageCollector("unused", () => now);
  collector.files.set("one", state);
  acceptBytes(state, Buffer.from(record(now, "turn", 100, 200)));
  assert.equal(collector.snapshot().turnSpeed, null);
  acceptBytes(state, Buffer.from(lifecycle(now - 40000, "task_started")));
  assert.equal(collector.snapshot().turnSpeed, 5);
  acceptBytes(state, Buffer.from(lifecycle(now - 50000, "task_started") + lifecycle(now + 1000, "task_started")));
  assert.equal(collector.snapshot().turnSpeed, 4, "last-written eligible start wins, even when timestamps are unsorted");
  const cached = state.days.get(dayKey(now)).lastTurn;
  collector.snapshot();
  assert.equal(state.days.get(dayKey(now)).lastTurn, cached, "unchanged snapshots must reuse the turn result");
});

test("future events and a backwards clock retain the original EMA semantics", () => {
  let now = new Date(2026, 8, 24, 12).getTime();
  const base = now;
  const state = newFileState(0, () => now);
  const collector = new UsageCollector("unused", () => now);
  collector.files.set("one", state);
  acceptBytes(state, Buffer.from(record(base - 1000, "past", 0, 150) + record(base + 1000, "future", 0, 300)));
  assert.ok(Math.abs(collector.snapshot().speed - 10 * Math.exp(-1 / 15)) < 1e-10);
  now = base + 2000;
  assert.ok(Math.abs(collector.snapshot().speed - (10 * Math.exp(-3 / 15) + 20 * Math.exp(-1 / 15))) < 1e-10);
  now = base;
  assert.ok(Math.abs(collector.snapshot().speed - 10 * Math.exp(-1 / 15)) < 1e-10);
});

test("historical records compact to daily totals and response IDs; midnight releases recent details", () => {
  let now = new Date(2026, 8, 24, 12).getTime();
  const state = newFileState(0, () => now);
  const collector = new UsageCollector("unused", () => now);
  collector.files.set("one", state);
  const old = now - 86400000;
  const lines = [];
  for (let i = 0; i < 10000; i++) {
    lines.push(lifecycle(old - 1000, "task_started"), record(old, `old-${i}`, 20, 10), lifecycle(old, "task_complete"));
  }
  acceptBytes(state, Buffer.from(lines.join("")));
  assert.equal(state.days.size, 1);
  assert.equal(state.days.get(dayKey(old)).recent, null);
  assert.equal(state.starts.length, 0);
  assert.equal(state.historyTotal, 300000);
  assert.equal(state.seen.size, 10000, "exact deduplication retains IDs, not usage/lifecycle objects");
  acceptBytes(state, Buffer.from(lifecycle(now - 1000, "task_started") + record(now, "today", 50, 20)));
  assert.equal(collector.snapshot().total, 70);
  assert.equal(state.days.get(dayKey(now)).recent.length, 1);
  now += 86400000;
  assert.equal(collector.snapshot().total, 0);
  assert.equal(state.days.get(dayKey(now - 86400000)).recent, null);
  assert.equal(state.starts.length, 0);
  assert.equal(collector.snapshot().historyTotal, 300070);
});

test("deletion, truncation and earlier-file duplicate ownership rebuild exact cached totals", async () => {
  const now = new Date(2026, 8, 24, 12).getTime();
  const sample = await fixture(new Date(now));
  const archive = path.join(sample.home, "archived_sessions", "copy.jsonl");
  try {
    await fs.mkdir(path.dirname(archive), { recursive: true });
    await fs.writeFile(sample.file, record(now, "first", 20, 10));
    await fs.writeFile(archive, record(now, "shared", 70, 30));
    const collector = new UsageCollector(sample.home, () => now);
    await collector.poll(); assert.equal(collector.snapshot().historyTotal, 130);
    await fs.appendFile(sample.file, record(now, "shared", 7, 3));
    await collector.poll(); assert.equal(collector.snapshot().historyTotal, 40, "earlier file wins after an append collision");
    await fs.unlink(sample.file);
    await collector.poll(); assert.equal(collector.snapshot().historyTotal, 100, "surviving duplicate replaces deleted owner");
    await fs.writeFile(archive, record(now, "new", 2, 1));
    await collector.poll(); assert.equal(collector.snapshot().historyTotal, 3, "truncation replaces old contributions");
  } finally { await sample.cleanup(); }
});

test("same-length file replacement and fallback-to-record migration refresh summaries", async () => {
  const now = Date.now();
  const sample = await fixture(new Date(now));
  try {
    await fs.writeFile(sample.file, record(now, "a", 10, 20));
    const collector = new UsageCollector(sample.home, () => now);
    await collector.poll(); assert.equal(collector.snapshot().total, 30);
    await fs.writeFile(sample.file, record(now, "b", 40, 50));
    await fs.utimes(sample.file, new Date(now + 1000), new Date(now + 1000));
    await collector.poll(); assert.equal(collector.snapshot().total, 90);
    await fs.writeFile(sample.file, counter(now, 1000, 200));
    await collector.poll(); assert.equal(collector.snapshot().total, 1200);
    await fs.appendFile(sample.file, record(now, "real-record", 8, 2));
    await collector.poll(); assert.equal(collector.snapshot().total, 10, "real records replace all counter fallback contributions");
    assert.equal(collector.snapshot().eventCount, 1);
  } finally { await sample.cleanup(); }
});

test("reset can replay compacted history with an arbitrary cutoff without changing today's totals", async () => {
  const now = new Date(2026, 8, 24, 12).getTime();
  const sample = await fixture(new Date(now));
  try {
    await fs.writeFile(sample.file, record(now - 2 * 86400000, "older", 20, 10) + record(now - 86400000, "yesterday", 50, 20) + record(now, "today", 7, 3));
    const collector = new UsageCollector(sample.home, () => now);
    await collector.poll(); assert.equal(collector.snapshot().historyTotal, 110);
    const reset = await collector.resetHistory(now - 86400000);
    assert.equal(reset.historyTotal, 80);
    assert.equal(reset.total, 10);
  } finally { await sample.cleanup(); }
});

test("watch notifications inspect only dirty files; periodic discovery catches lost events", async () => {
  const { EventEmitter } = require("node:events");
  let now = Date.now(), notify, closed = 0;
  const sample = await fixture(new Date(now));
  let collector;
  const originalStat = fs.stat;
  let stats = 0;
  try {
    await fs.writeFile(sample.file, record(now, "initial", 20, 10));
    collector = new UsageCollector(sample.home, () => now, 0, { watch: (_home, _options, callback) => {
      notify = callback;
      const watcher = new EventEmitter(); watcher.close = () => { closed++; };
      return watcher;
    } });
    collector.start(() => {}); await collector.poll();
    fs.stat = async (...args) => { stats++; return originalStat(...args); };
    await collector.poll(); assert.equal(stats, 0, "idle poll must not stat every unchanged file");
    await fs.appendFile(sample.file, record(now, "notified", 50, 20));
    notify("change", path.relative(sample.home, sample.file));
    await collector.poll(); assert.equal(stats, 1); assert.equal(collector.snapshot().total, 100);
    await fs.appendFile(sample.file, record(now, "missed-notification", 7, 3));
    await collector.poll(); assert.equal(collector.snapshot().total, 100);
    now += 30000;
    await collector.poll(); assert.equal(collector.snapshot().total, 110);
    assert.equal(stats, 2);
    notify("change", null);
    await collector.poll(); assert.equal(stats, 3, "missing filename must force discovery");
    collector.stop(); assert.equal(closed, 1);
  } finally { fs.stat = originalStat; collector?.stop(); await sample.cleanup(); }
});

test("watch failures fall back to polling, and a failed read retries without losing a record", async () => {
  const now = Date.now();
  const sample = await fixture(new Date(now));
  let collector;
  const originalOpen = fs.open;
  try {
    await fs.writeFile(sample.file, record(now, "first", 20, 10));
    collector = new UsageCollector(sample.home, () => now, 0, { watch: () => { throw new Error("unsupported watcher"); } });
    collector.start(() => {}); await collector.poll();
    await fs.appendFile(sample.file, record(now, "second", 50, 20));
    let fail = true;
    fs.open = async (...args) => { if (fail) { fail = false; throw new Error("transient read failure"); } return originalOpen(...args); };
    await collector.poll(); assert.equal(collector.snapshot().source, "error");
    await collector.poll(); assert.equal(collector.snapshot().total, 100);
    assert.equal(collector.snapshot().source, "ready");
  } finally { fs.open = originalOpen; collector?.stop(); await sample.cleanup(); }
});

test("native Windows recursive notifications discover appended and newly created session files", { skip: process.platform !== "win32" }, async () => {
  const now = Date.now();
  const sample = await fixture(new Date(now));
  let collector;
  const waitForTotal = async (expected) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 30));
      await collector.poll();
      if (collector.snapshot().total === expected) return;
    }
    assert.equal(collector.snapshot().total, expected);
  };
  try {
    await fs.writeFile(sample.file, record(now, "initial", 20, 10));
    collector = new UsageCollector(sample.home, () => now);
    collector.start(() => {}); await collector.poll();
    assert.ok(collector.watcher, "native watcher must be active");
    await fs.appendFile(sample.file, record(now, "append", 50, 20));
    await waitForTotal(100);
    const newFolder = path.join(sample.home, "sessions", "new-day");
    await fs.mkdir(newFolder);
    await fs.writeFile(path.join(newFolder, "new-session.jsonl"), record(now, "new-file", 7, 3));
    await waitForTotal(110);
  } finally { collector?.stop(); await sample.cleanup(); }
});
