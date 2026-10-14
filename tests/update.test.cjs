const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { Readable } = require("node:stream");
const { EventEmitter } = require("node:events");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const github = require("./reference/electron/github-update.cjs");

function release(version = "1.2.4") {
  return { tag_name: `v${version}`, draft: false, prerelease: false, body: "Release notes", assets:
    [`Codex-Speed-Pet-Setup-${version}.exe`, `Codex-Speed-Pet-portable-${version}.zip`, "SHA256SUMS.txt"].map(name => ({
      name, state: "uploaded", size: 4, digest: `sha256:${"a".repeat(64)}`,
      browser_download_url: `https://github.com/${github.REPOSITORY}/releases/download/v${version}/${name}`
    })) };
}

test("only stable versions and exact repository assets can be used", () => {
  assert.equal(github.compareVersions("1.10.0", "1.9.9"), 1);
  assert.equal(github.compareVersions("1.2.3", "1.2.3"), 0);
  assert.equal(github.releaseAssets(release()).version, "1.2.4");
  for (const patch of [{ draft: true }, { prerelease: true }, { tag_name: "v1.2.4-beta" }, { assets: [] }]) {
    assert.throws(() => github.releaseAssets({ ...release(), ...patch }));
  }
  for (const url of ["http://github.com/a", "https://example.com/a", "https://user:pass@github.com/a", "https://github.com:444/a"]) assert.throws(() => github.safeUrl(url));
  const wrong = release(); wrong.assets[0].browser_download_url = "https://github.com/other/repo/releases/download/v1.2.4/file.exe";
  assert.throws(() => github.releaseAssets(wrong));
  const duplicate = release(); duplicate.assets.push(duplicate.assets[0]);
  assert.throws(() => github.releaseAssets(duplicate));
});

test("checksums must be unique and agree with GitHub asset digests", () => {
  const asset = github.releaseAssets(release()).installer;
  const line = `${"a".repeat(64)}  ${asset.name}\n`;
  assert.equal(github.checksumFor(line, asset), "a".repeat(64));
  for (const text of [line + line, line.replace(/a/g, "b"), "garbage", ""]) assert.throws(() => github.checksumFor(text, asset));
});

test("streamed downloads reject corrupted, truncated, oversized and interrupted files", async () => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "speed-pet-download-test-"));
  const bytes = Buffer.from("verified update");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const asset = { size: bytes.length, url: "https://github.com/test" };
  try {
    const good = path.join(directory, "good");
    await github.download(asset, good, digest, async () => Readable.from([bytes]));
    assert.deepEqual(await fsp.readFile(good), bytes);
    await assert.rejects(github.download(asset, good, digest, async () => Readable.from([bytes])));
    assert.deepEqual(await fsp.readFile(good), bytes, "An existing file must never be removed by a failed exclusive download");
    for (const [name, stream, size, hash] of [
      ["bad-hash", Readable.from([bytes]), bytes.length, "0".repeat(64)],
      ["truncated", Readable.from([bytes.subarray(1)]), bytes.length, digest],
      ["oversized", Readable.from([bytes]), bytes.length - 1, digest],
      ["interrupted", Readable.from((async function* () { yield bytes.subarray(0, 3); throw Error("disconnected"); })()), bytes.length, digest]
    ]) {
      const target = path.join(directory, name);
      await assert.rejects(github.download({ ...asset, size }, target, hash, async () => stream));
      assert.equal(fs.existsSync(target), false);
    }
  } finally { await fsp.rm(directory, { recursive: true, force: true }); }
});

function updaterFixture({ packaged = true, installed = false, readText, download } = {}) {
  const calls = [], timers = [], statuses = [];
  let quit = 0;
  const shippedGithub = { ...github, readText: readText || (async () => JSON.stringify(release())), download: download || (async asset => calls.push(asset.name)) };
  const stubFs = { ...fs, appendFileSync() {}, existsSync: file => file.endsWith("Uninstall Codex Speed Pet.exe") ? installed : true };
  const stubFsp = { mkdtemp: async () => "C:\\temp\\stage", mkdir: async () => {}, readFile: async () => Buffer.from("helper"), writeFile: async () => {}, rm: async () => calls.push("cleanup") };
  const child = {
    spawn: (_exe, args) => { calls.push(args[0]); const emitter = new EventEmitter(); emitter.unref = () => {}; queueMicrotask(() => emitter.emit("spawn")); return emitter; },
    execFile: (_exe, _args, _options, callback) => callback(null, "", "")
  };
  const loaded = { exports: {} };
  const timer = (fn, delay) => { timers.push({ fn, delay }); return timers.length; };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "./reference/electron/update.cjs"), "utf8"), {
    module: loaded, __dirname: path.join(__dirname, "./reference/electron"), process, Buffer,
    setTimeout: timer, setInterval: timer, clearTimeout: () => {},
    require: name => name === "electron" ? { app: { isPackaged: packaged, getVersion: () => "1.2.3", getPath: key => key === "exe" ? "C:\\custom\\Codex Speed Pet.exe" : "C:\\userdata" } }
      : name === "./github-update.cjs" ? shippedGithub : name === "node:fs" ? stubFs : name === "node:fs/promises" ? stubFsp : name === "node:child_process" ? child : require(name)
  });
  loaded.exports.init({ onStatus: status => statuses.push(status), requestQuit: () => quit++ });
  return { updater: loaded.exports, github: shippedGithub, calls, timers, statuses, quit: () => quit };
}

test("packaged apps schedule GitHub checks; development never updates", async () => {
  const packaged = updaterFixture();
  assert.equal(packaged.updater.updateEnabled(), true);
  assert.deepEqual(packaged.timers.map(timer => timer.delay), [5000, 4 * 60 * 60 * 1000]);
  const dev = updaterFixture({ packaged: false });
  assert.equal(dev.updater.buildKind(), "dev");
  assert.equal(dev.timers.length, 0);
  assert.equal((await dev.updater.checkForUpdate()).state, "unsupported");
  await dev.updater.installUpdate();
  assert.equal(dev.quit(), 0);
});

test("checks deduplicate concurrent requests and report newer, equal, older and failed feeds", async () => {
  let resolve, count = 0;
  const sample = updaterFixture({ readText: () => { count++; return new Promise(done => { resolve = done; }); } });
  const first = sample.updater.checkForUpdate();
  assert.equal(sample.updater.checkForUpdate(), first);
  resolve(JSON.stringify(release()));
  assert.equal((await first).state, "available");
  assert.equal(count, 1);
  assert.equal(sample.quit(), 0, "detecting a newer version must never quit the app");
  assert.deepEqual(sample.calls, [], "detecting a newer version must never download or launch an update");
  for (const version of ["1.2.3", "1.2.2"]) {
    sample.github.readText = async () => JSON.stringify(release(version));
    assert.equal((await sample.updater.checkForUpdate()).state, "latest");
  }
  sample.github.readText = async () => { throw Error("timeout"); };
  assert.equal((await sample.updater.checkForUpdate()).state, "error");
  assert.match(sample.updater.getStatus().message, /timeout/);
});

test("custom-directory installers use the pinned installer and quit only after successful staging", async () => {
  const feed = release(); feed.assets[2].digest = null;
  const sum = `${"a".repeat(64)}  ${feed.assets[0].name}\n`;
  const sample = updaterFixture({ installed: true, readText: async url => url === github.LATEST_URL ? JSON.stringify(feed) : sum });
  assert.equal(sample.updater.buildKind(), "installed");
  await sample.updater.checkForUpdate();
  const first = sample.updater.installUpdate();
  assert.equal(sample.updater.installUpdate(), first);
  assert.equal((await first).state, "installing");
  assert.equal(sample.calls[0], feed.assets[0].name);
  assert.equal(sample.quit(), 1);
});

test("checksum and network failures never launch an installer or quit the app", async () => {
  for (const fail of ["sum", "download"]) {
    const feed = release(); feed.assets[2].digest = null;
    const sample = updaterFixture({ installed: true,
      readText: async url => url === github.LATEST_URL ? JSON.stringify(feed) : `${(fail === "sum" ? "b" : "a").repeat(64)}  ${feed.assets[0].name}\n`,
      download: async () => { throw Error("disconnected"); }
    });
    await sample.updater.checkForUpdate();
    assert.equal((await sample.updater.installUpdate()).state, "error");
    assert.equal(sample.quit(), 0);
    assert.ok(!sample.calls.some(call => call.endsWith(".exe")));
  }
});

test("portable apps download the pinned ZIP and launch the hidden replacement helper", async () => {
  const feed = release(); feed.assets[2].digest = null;
  const sample = updaterFixture({ readText: async url => url === github.LATEST_URL ? JSON.stringify(feed) : `${"a".repeat(64)}  ${feed.assets[1].name}\n` });
  assert.equal(sample.updater.buildKind(), "portable");
  await sample.updater.checkForUpdate();
  assert.equal((await sample.updater.installUpdate()).state, "installing");
  assert.equal(sample.calls[0], feed.assets[1].name);
  assert.ok(sample.calls.some(call => call.endsWith("run-hidden.vbs")));
  assert.equal(sample.quit(), 1);
});

test("portable replacement restarts successfully and restores a backup on failure", { skip: process.platform !== "win32" }, async () => {
  for (const failStart of [false, true]) {
    const stage = await fsp.mkdtemp(path.join(os.tmpdir(), "codex-speed-pet-update-test-"));
    const target = await fsp.mkdtemp(path.join(os.tmpdir(), "speed-pet-target-test-"));
    const source = path.join(stage, "files");
    const logDir = await fsp.mkdtemp(path.join(os.tmpdir(), "speed-pet-log-test-"));
    try {
      await fsp.mkdir(source);
      await fsp.mkdir(path.join(source, "resources"));
      await fsp.writeFile(path.join(source, "resources/app.asar"), "new archive");
      await fsp.mkdir(path.join(target, "resources/app"), { recursive: true });
      await fsp.writeFile(path.join(target, "resources/app/package.json"), JSON.stringify({ name: "codex-speed-pet", main: "electron/main.cjs" }));
      await fsp.writeFile(path.join(source, "Codex Speed Pet.exe"), "new-version");
      await fsp.writeFile(path.join(target, "Codex Speed Pet.exe"), "old-version");
      const sameTime = new Date("2026-01-01T00:00:00Z");
      for (const folder of [source, target]) await fsp.utimes(path.join(folder, "Codex Speed Pet.exe"), sameTime, sameTime);
      await fsp.writeFile(path.join(target, "old-only.txt"), "old");
      await fsp.copyFile(path.join(__dirname, "./reference/electron/portable-update.ps1"), path.join(stage, "apply-update.ps1"));
      await fsp.writeFile(path.join(stage, "update.json"), JSON.stringify({ source, target, exe: "Codex Speed Pet.exe", appPid: 2147483647, logDir }));
      const driver = path.join(stage, "test-driver.ps1");
      await fsp.writeFile(driver, `param([string]$scriptPath)\n$global:starts = 0\nfunction Start-Sleep {}\nfunction Start-Process { $global:starts++; ${failStart ? "if ($global:starts -eq 1) { throw 'simulated restart failure' }" : ""} }\n& $scriptPath\n`, "utf8");
      const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", driver, path.join(stage, "apply-update.ps1")], { encoding: "utf8", windowsHide: true, timeout: 30000 });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(await fsp.readFile(path.join(target, "Codex Speed Pet.exe"), "utf8"), failStart ? "old-version" : "new-version", result.stdout + result.stderr + await fsp.readFile(path.join(logDir, "updater-script-last.log"), "utf8").catch(() => ""));
      assert.equal(fs.existsSync(path.join(target, "old-only.txt")), true, "Unrelated portable files must be preserved");
      assert.equal(fs.existsSync(path.join(target, "resources/app/package.json")), failStart, "Legacy loose payload is retired or restored on rollback");
      assert.equal(fs.existsSync(path.join(target, "resources/app.asar")), !failStart, "New files are removed during rollback");
      assert.equal(fs.existsSync(stage), failStart);
    } finally { await fsp.rm(stage, { recursive: true, force: true }); await fsp.rm(target, { recursive: true, force: true }); await fsp.rm(logDir, { recursive: true, force: true }); }
  }
});
