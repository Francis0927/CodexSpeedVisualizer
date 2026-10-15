const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { UsageCollector } = require('./reference/electron/usage.cjs');
const executable = path.resolve(__dirname, '../src-tauri/target/debug/codex-speed-pet.exe');
const clock = new Date(2026, 8, 25, 12).getTime();
const jsonl = (time, type, payload) => JSON.stringify({ timestamp: new Date(time).toISOString(), type, payload }) + '\n';
const record = (time, id, input = 100, output = 40) => jsonl(time, 'token_usage_record', { response_id: id, usage: { input_tokens: input, output_tokens: output, cached_input_tokens: 20 } });
const counter = (time, input, output) => jsonl(time, 'event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: input, output_tokens: output } } });
const life = (time, type) => jsonl(time, 'event_msg', { type });
const quota = (time, used = 25) => jsonl(time, 'event_msg', { type: 'token_count', rate_limits: { limit_id: 'codex', primary: { used_percent: used, window_minutes: 300, resets_at: Math.floor((time + 60000) / 1000) }, secondary: { used_percent: 45, window_minutes: 10080 } } });

async function compare(name, operations) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'tauri-parity-'));
  const nodeHome = path.join(temporary, 'node');
  const rustHome = path.join(temporary, 'rust');
  let now = clock;
  const collector = new UsageCollector(nodeHome, () => now);
  const expected = [];
  const modified = new Map();
  try {
    for (const op of operations) {
      now = op.now;
      for (const write of op.writes || []) {
        const file = path.join(nodeHome, write.file);
        if (write.delete) { await fs.unlink(file); modified.delete(write.file); }
        else {
          await fs.mkdir(path.dirname(file), { recursive: true });
          await fs[write.append ? 'appendFile' : 'writeFile'](file, write.text);
          // Node writes asynchronously; Rust replays synchronously. Do not let
          // host clock granularity decide whether a same-size rewrite is seen.
          const mtimeMs = write.mtimeMs ?? op.now;
          await fs.utimes(file, new Date(mtimeMs), new Date(mtimeMs));
          modified.set(write.file, mtimeMs);
        }
      }
      if (op.reset !== undefined) await collector.resetHistory(op.reset); else await collector.poll();
      expected.push(collector.snapshot());
    }
    const ops = operations.map(op => ({ ...op, writes: op.writes?.map(write => ({ ...write, mtimeMs: write.mtimeMs ?? op.now, path: path.join(rustHome, write.file) })) }));
    const result = spawnSync(executable, ['--replay'], { input: JSON.stringify({ home: rustHome, ops }), encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    for (const [file, mtimeMs] of modified) {
      assert.equal((await fs.stat(path.join(rustHome, file))).mtimeMs, mtimeMs, 'replay must apply the fixture modification time');
    }
    const actual = JSON.parse(result.stdout);
    assert.equal(actual.length, expected.length);
    for (let i = 0; i < actual.length; i++) {
      for (const key of ['speed', 'turnSpeed']) {
        if (expected[i][key] === null) assert.equal(actual[i][key], null);
        else assert.ok(Math.abs(actual[i][key] - expected[i][key]) <= 1e-9 * Math.max(1, Math.abs(expected[i][key])), name + ' snapshot ' + i + ' ' + key + ': actual=' + actual[i][key] + ', expected=' + expected[i][key]);
        delete actual[i][key]; delete expected[i][key];
      }
      assert.deepEqual(actual[i], expected[i], name + ' snapshot ' + i);
    }
  } finally { collector.stop(); await fs.rm(temporary, { recursive: true, force: true }); }
}
const file = 'sessions/rollout.jsonl';
const write = text => ({ file, text });
const scenarios = {
  'BOM, response deduplication, cached input and record precedence': [{ now: clock, writes: [write('\uFEFF' + record(clock - 2000, 'a') + record(clock - 2000, 'a') + counter(clock - 1000, 100, 40))] }, { now: clock + 14000 }],
  'old counters and midnight': [{ now: clock, writes: [write(counter(clock - 86400000, 120, 30) + counter(clock - 1000, 220, 55))] }, { now: clock + 86400000 }],
  'partial UTF-8, malformed and irrelevant lines': [{ now: clock, writes: [write('{bad}\n' + JSON.stringify({ type: 'other', payload: { text: '不读取对话' } }) + '\n' + record(clock - 1000, '中文').slice(0, 65))] }, { now: clock + 2000, writes: [{ file, append: true, text: record(clock - 1000, '中文').slice(65) }] }],
  'history reset, future records and clock rollback': [{ now: clock, writes: [write(record(clock - 86400000, 'old') + record(clock - 1000, 'a') + record(clock + 3000, 'future'))] }, { now: clock + 1000, reset: clock }, { now: clock + 4000 }, { now: clock - 2000 }],
  'archive duplicate priority and deletion': [{ now: clock, writes: [write(record(clock - 1000, 'a')), { file: 'archived_sessions/copy.jsonl', text: record(clock - 1000, 'a', 500, 40) + record(clock - 1000, 'b') }] }, { now: clock + 2000, writes: [{ file: 'archived_sessions/copy.jsonl', delete: true }] }],
  'truncate and same-size replacement': [{ now: clock, writes: [write(record(clock - 1000, 'a', 100, 10) + record(clock - 1000, 'b', 100, 10))] }, { now: clock + 2000, writes: [write(record(clock - 1000, 'c', 100, 10))] }, { now: clock + 4000, writes: [write(record(clock - 1000, 'd', 200, 20))] }],
  'late lifecycle repairs and most recent turn': [{ now: clock, writes: [write(record(clock - 10000, 'a', 10, 50) + record(clock - 1000, 'b', 20, 90))] }, { now: clock + 1000, writes: [{ file, append: true, text: life(clock - 11000, 'task_started') + life(clock, 'task_complete') }] }],
  'out-of-order task start precedence': [{ now: clock, writes: [write(life(clock - 5000, 'task_started') + life(clock - 15000, 'task_started') + record(clock - 1000, 'a', 20, 90))] }],
  'running and aborted tasks without usage': [{ now: clock, writes: [write(life(clock - 1000, 'task_started'))] }, { now: clock + 2000, writes: [{ file, append: true, text: life(clock + 1000, 'turn_aborted') }] }],
  'quota-only, newest across files and clamping': [{ now: clock, writes: [write(quota(clock - 1000, 150)), { file: 'archived_sessions/old.jsonl', text: quota(clock - 86400000) }] }, { now: clock + 1000, writes: [{ file, append: true, text: quota(clock, -5) + quota(clock - 3000, 50) }] }],
  'counter to records transition': [{ now: clock, writes: [write(counter(clock - 3000, 150, 60))] }, { now: clock + 1000, writes: [{ file, append: true, text: record(clock - 1000, 'a', 10, 20) }] }],
  'earlier file acquires duplicate ownership': [{ now: clock, writes: [write(''), { file: 'sessions/second.jsonl', text: record(clock - 1000, 'a') }] }, { now: clock + 1000, writes: [{ file, append: true, text: record(clock - 1000, 'a', 50, 20) }] }],
  'large history compaction and EMA decay': [{ now: clock, writes: [write(Array.from({ length: 2000 }, (_, i) => record(clock - 86400000, 'old-' + i)).join('') + record(clock - 3000, 'now'))] }, { now: clock + 86400000 }],
  'many out-of-order turns rebuild their summary once': [{ now: clock, writes: [write(Array.from({ length: 1000 }, (_, i) => life(clock - 20000 - i * 1000, 'task_started') + record(clock - 10000 + i * 2, 'late-' + i, 50, 10)).join(''))] }]
};
for (const [name, ops] of Object.entries(scenarios)) test(name, () => compare(name, ops));
