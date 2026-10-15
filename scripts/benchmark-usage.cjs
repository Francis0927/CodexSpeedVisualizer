// Reproducible synthetic workloads. Use --baseline <old usage.cjs> to compare.
// Run with --expose-gc; each case runs in its own process to isolate memory/GC.
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { performance } = require("node:perf_hooks");
const { execFileSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
const cases = ["turns", "history", "large-line", "idle-files", "memory"];
const round = n => Math.round(n * 1000) / 1000;
const date = new Date(); date.setHours(12, 0, 0, 0);
const now = date.getTime();

function record(timestamp, id, input = 100, output = 50) {
  return JSON.stringify({ timestamp: new Date(timestamp).toISOString(), type: "token_usage_record", payload: { response_id: id, usage: { input_tokens: input, output_tokens: output } } }) + "\n";
}
function lifecycle(timestamp, type) {
  return JSON.stringify({ timestamp: new Date(timestamp).toISOString(), type: "event_msg", payload: { type } }) + "\n";
}
function populate(api, count, old, withTurns) {
  const collector = new api.UsageCollector("unused", () => now);
  const state = api.newFileState(0, () => now);
  collector.files.set("sample", state);
  const base = old ? now - 86400000 : now - 21600000;
  for (let start = 0; start < count; start += 100) {
    let lines = "";
    for (let i = start; i < Math.min(start + 100, count); i++) {
      const timestamp = old ? base : base + i * 1000;
      if (withTurns) lines += lifecycle(timestamp - 1000, "task_started");
      lines += record(timestamp, `response-${i}`);
      if (withTurns) lines += lifecycle(timestamp, "task_complete");
    }
    api.acceptBytes(state, Buffer.from(lines));
  }
  return collector;
}
function snapshotTime(collector) {
  collector.snapshot(); collector.snapshot();
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const started = performance.now(); collector.snapshot(); samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  return { medianMs: round(samples[2]), maxMs: round(samples[4]) };
}

async function runCase(name, modulePath) {
  const api = require(modulePath);
  if (name === "turns") return { events: 20000, ...snapshotTime(populate(api, 20000, false, true)) };
  if (name === "history") return { events: 300000, ...snapshotTime(populate(api, 300000, true, false)) };
  if (name === "large-line") {
    const state = api.newFileState(0, () => now), chunk = Buffer.alloc(65536, 120);
    const started = performance.now();
    api.acceptBytes(state, Buffer.from('{"type":"response_item","payload":{"text":"'));
    for (let i = 0; i < 256; i++) api.acceptBytes(state, chunk);
    api.acceptBytes(state, Buffer.from('"}}\n'));
    const processingMs = round(performance.now() - started);
    const retainedBufferBytes = state.pending ? state.pending.buffer.byteLength : state.pendingChunks.reduce((total, value) => total + value.buffer.byteLength, 0);
    return { lineMB: 16, processingMs, retainedBufferMB: round(retainedBufferBytes / 1048576) };
  }
  if (name === "memory") {
    global.gc(); const before = process.memoryUsage();
    global.benchmarkCollector = populate(api, 100000, true, true);
    global.gc(); const after = process.memoryUsage();
    return { usageEvents: 100000, lifecycleEvents: 200000, heapMB: round((after.heapUsed - before.heapUsed) / 1048576), buffersMB: round((after.arrayBuffers - before.arrayBuffers) / 1048576) };
  }
  if (name === "idle-files") {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "speed-pet-benchmark-"));
    try {
      const folder = path.join(home, "sessions"); await fs.mkdir(folder);
      for (let start = 0; start < 1000; start += 64) {
        await Promise.all(Array.from({ length: Math.min(64, 1000 - start) }, (_, j) => {
          const file = start + j;
          const data = Array.from({ length: 10 }, (_, i) => record(now - 86400000, `file-${file}-response-${i}`)).join("");
          return fs.writeFile(path.join(folder, `${file}.jsonl`), data);
        }));
      }
      const collector = new api.UsageCollector(home, () => now, 0, { watch: () => {
        const watcher = new EventEmitter(); watcher.close = () => {}; return watcher;
      } });
      await collector.poll();
      // Mirror the production watcher path without leaving timers running.
      collector.running = true; collector.tryWatch?.();
      const originalStat = fs.stat;
      let statCalls = 0;
      fs.stat = (...args) => { statCalls++; return originalStat(...args); };
      const samples = [];
      try {
        for (let i = 0; i < 5; i++) { const started = performance.now(); await collector.poll(); samples.push(performance.now() - started); }
      } finally { fs.stat = originalStat; collector.stop(); }
      samples.sort((a, b) => a - b);
      return { files: 1000, medianMs: round(samples[2]), totalStatCalls: statCalls };
    } finally {
      const safeRoot = path.resolve(os.tmpdir()) + path.sep;
      if (!path.resolve(home).startsWith(safeRoot) || !path.basename(home).startsWith("speed-pet-benchmark-")) throw new Error("Unexpected benchmark directory");
      await fs.rm(home, { recursive: true, force: true });
    }
  }
  throw new Error(`Unknown benchmark case: ${name}`);
}

(async () => {
  if (args.includes("--case")) {
    console.log(JSON.stringify(await runCase(option("--case"), path.resolve(option("--module")))));
    return;
  }
  console.log(JSON.stringify({ node: process.version, samples: "synthetic; same inputs for baseline and current" }));
  const versions = [{ version: "current", module: path.resolve(__dirname, "../tests/reference/electron/usage.cjs") }];
  if (args.includes("--baseline")) versions.unshift({ version: "baseline", module: path.resolve(option("--baseline")) });
  for (const version of versions) {
    for (const name of cases) {
      const output = execFileSync(process.execPath, ["--expose-gc", __filename, "--case", name, "--module", version.module], { encoding: "utf8", windowsHide: true, timeout: 120000 });
      console.log(JSON.stringify({ version: version.version, case: name, ...JSON.parse(output) }));
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
