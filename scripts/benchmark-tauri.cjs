const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');

async function main() {
  if (process.argv[2] === '--node') {
    const { UsageCollector } = require('../tests/reference/electron/usage.cjs');
    const collector = new UsageCollector(process.argv[3], () => Number(process.argv[4]));
    const start = performance.now();
    collector.start(() => {}); await collector.poll();
    const scanMs = performance.now() - start;
    const snapshot = collector.snapshot();
    const time = performance.now(); for (let i = 0; i < 100; i++) collector.snapshot();
    const snapshotMs = (performance.now() - time) / 100;
    global.gc?.();
    console.log(JSON.stringify({ scanMs, snapshotMs, workingSetBytes: process.memoryUsage().rss, peakWorkingSetBytes: process.resourceUsage().maxRSS * 1024, historyTotal: snapshot.historyTotal, eventCount: snapshot.eventCount }));
    collector.stop(); return;
  }
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'tauri-benchmark-'));
  const clock = new Date(2026, 8, 25, 12).getTime();
  const timestamp = new Date(clock - 86400000).toISOString();
  try {
    await fs.mkdir(path.join(home, 'sessions'));
    const file = path.join(home, 'sessions/history.jsonl');
    for (let start = 0; start < 100000; start += 1000) {
      let data = '';
      for (let i = start; i < start + 1000; i++) data += JSON.stringify({ timestamp, type: 'token_usage_record', payload: { response_id: 'synthetic-' + i, usage: { input_tokens: 100, output_tokens: 50 } } }) + '\n';
      await fs.appendFile(file, data);
    }
    const results = {};
    for (const [name, exe, args] of [
      ['nodeReference', process.execPath, ['--expose-gc', __filename, '--node', home, String(clock)]],
      ['rust', path.resolve(__dirname, '../src-tauri/target/release/codex-speed-pet.exe'), ['--benchmark', home, String(clock)]]
    ]) {
      const result = spawnSync(exe, args, { encoding: 'utf8', windowsHide: true, timeout: 120000 });
      if (result.status !== 0) throw Error(result.stderr || result.error?.message);
      results[name] = JSON.parse(result.stdout);
      if (results[name].historyTotal !== 15000000) throw Error('Benchmark statistics differ');
    }
    console.log(JSON.stringify({ records: 100000, scope: 'collector CLI process, excluding desktop/WebView2', ...results }, null, 2));
  } finally { await fs.rm(home, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
