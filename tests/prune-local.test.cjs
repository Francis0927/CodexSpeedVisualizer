const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const version = require("../package.json").version;
const current = version.split(".").map(Number);
const old = current[2] ? `${current[0]}.${current[1]}.${current[2] - 1}` : "0.0.0";
const future = `${current[0]}.${current[1]}.${current[2] + 1}`;

async function fixture() {
  const directory = await fs.mkdtemp(path.join(root, "release/.prune-test-"));
  const output = path.join(directory, `github-${version}`);
  await fs.mkdir(output);
  const names = [`Codex-Speed-Pet-Setup-${version}.exe`, `Codex-Speed-Pet-portable-${version}.zip`, "SHA256SUMS.txt", "README.txt"];
  const assets = [];
  for (const name of names) {
    const bytes = Buffer.from(`latest fixture ${name}`);
    await fs.writeFile(path.join(output, name), bytes);
    assets.push({ name, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  await fs.writeFile(path.join(output, "verified-assets.json"), JSON.stringify({ version, assets }));
  return { directory, output, cleanup: () => fs.rm(directory, { recursive: true, force: true }) };
}
function prune(directory, ...args) {
  return spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "scripts/prune-local-releases.ps1"), "-ReleaseDirectory", directory, ...args], { encoding: "utf8", windowsHide: true, timeout: 30000 });
}
async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }

test("cleanup preview is read-only; cleanup removes only old releases and completed scratch builds", { skip: process.platform !== "win32" }, async () => {
  const sample = await fixture();
  try {
    const oldFile = `Codex Speed Pet Setup ${old}.exe`;
    const oldZip = `Codex-Speed-Pet-portable-${old}.zip`;
    const oldFolder = `GitHub-Release-v${old}`;
    const scratch = `.github-build-${version}-${"a".repeat(32)}`;
    const portableScratch = `.publish-portable-${version}-${"b".repeat(32)}`;
    const keep = [`Codex Speed Pet Setup ${version}.exe`, `Codex Speed Pet Setup ${future}.exe`, "notes.txt"];
    for (const name of [oldFile, oldZip, ...keep]) await fs.writeFile(path.join(sample.directory, name), "fixture");
    for (const name of [oldFolder, scratch, portableScratch, `no-update-${future}`, "Codex-Speed-Pet-portable"]) await fs.mkdir(path.join(sample.directory, name));
    const noUpdatePortable = path.join(sample.output, "Codex-Speed-Pet-portable");
    const oldBuild = path.join(sample.directory, "win-unpacked");
    await fs.mkdir(path.join(oldBuild, "resources/app"), { recursive: true });
    await fs.writeFile(path.join(oldBuild, "resources/app/package.json"), JSON.stringify({ version: old }));
    await fs.mkdir(noUpdatePortable);
    await fs.mkdir(path.join(sample.output, "win-unpacked"));
    const preview = prune(sample.directory, "-WhatIf");
    assert.equal(preview.status, 0, preview.stdout + preview.stderr);
    assert.ok(await exists(path.join(sample.directory, oldFile)));
    assert.ok(await exists(path.join(sample.directory, scratch)));
    assert.ok(await exists(noUpdatePortable));
    assert.ok(await exists(oldBuild));
    const result = prune(sample.directory);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    for (const name of [oldFile, oldZip, oldFolder, scratch, portableScratch]) assert.equal(await exists(path.join(sample.directory, name)), false, name);
    assert.equal(await exists(noUpdatePortable), false);
    assert.equal(await exists(oldBuild), false);
    assert.equal(await exists(path.join(sample.output, "win-unpacked")), true);
    for (const name of [...keep, `github-${version}`, `no-update-${future}`, "Codex-Speed-Pet-portable"]) assert.equal(await exists(path.join(sample.directory, name)), true, name);
  } finally { await sample.cleanup(); }
});

test("a failed latest-package checksum leaves every old package untouched", { skip: process.platform !== "win32" }, async () => {
  const sample = await fixture();
  try {
    const oldFile = path.join(sample.directory, `Codex Speed Pet Setup ${old}.exe`);
    await fs.writeFile(oldFile, "old");
    await fs.appendFile(path.join(sample.output, "SHA256SUMS.txt"), "corrupt");
    const result = prune(sample.directory);
    assert.notEqual(result.status, 0);
    assert.equal(await exists(oldFile), true);
  } finally { await sample.cleanup(); }
});

test("cleanup refuses directories outside the workspace release tree", { skip: process.platform !== "win32" }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "speed-pet-prune-outside-"));
  try {
    const marker = path.join(directory, `Codex Speed Pet Setup ${old}.exe`);
    await fs.writeFile(marker, "outside");
    assert.notEqual(prune(directory).status, 0);
    assert.equal(await exists(marker), true);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("junctions in old release trees block pruning before any target is deleted", { skip: process.platform !== "win32" }, async () => {
  const sample = await fixture();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "speed-pet-prune-link-"));
  const link = path.join(sample.directory, `no-update-${old}`);
  try {
    const marker = path.join(outside, "keep.txt");
    await fs.writeFile(marker, "outside");
    await fs.symlink(outside, link, "junction");
    const result = prune(sample.directory);
    assert.notEqual(result.status, 0);
    assert.equal(await fs.readFile(marker, "utf8"), "outside");
  } finally { await fs.unlink(link); await sample.cleanup(); await fs.rm(outside, { recursive: true, force: true }); }
});
