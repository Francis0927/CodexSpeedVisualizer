const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { UsageCollector, dayKey, newFileState, acceptBytes } = require("../electron/usage.cjs");

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
  assert.equal(state.records.length, 0);
  acceptBytes(state, Buffer.from(line.slice(22)));
  assert.equal(state.records.length, 1);
  assert.equal(state.records[0].output, 10);
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

    const resetAt = collector.resetHistory();
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
