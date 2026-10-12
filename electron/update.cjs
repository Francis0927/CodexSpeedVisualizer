const { app } = require("electron");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { createHash } = require("node:crypto");
const github = require("./github-update.cjs");
const execFileAsync = promisify(execFile);

const STARTUP_CHECK_DELAY_MS = 5000;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
let status = { state: "idle", version: null, notes: null, message: null };
let onStatus = null, requestQuit = null, candidate = null, checking = null, installing = null;
let timers = [];

function log(line) {
  try { fs.appendFileSync(path.join(app.getPath("userData"), "update.log"), `[${new Date().toISOString()}] ${line}\r\n`); } catch { /* Logs must not break updates. */ }
}
function updateEnabled() { return app.isPackaged; }
function buildKind() {
  if (!app.isPackaged) return "dev";
  // NSIS creates this file even for a custom installation directory.
  return fs.existsSync(path.join(path.dirname(app.getPath("exe")), "Uninstall Codex Speed Pet.exe")) ? "installed" : "portable";
}
function getStatus() { return status; }
function setStatus(patch) { status = { ...status, ...patch }; onStatus?.(status); }

function checkForUpdate() {
  if (!updateEnabled()) { setStatus({ state: "unsupported", message: "开发环境不支持更新" }); return Promise.resolve(status); }
  if (installing) return installing;
  if (checking) return checking;
  checking = (async () => {
    setStatus({ state: "checking", version: null, notes: null, message: null });
    candidate = null;
    try {
      const release = JSON.parse(await github.readText(github.LATEST_URL));
      const version = github.releaseVersion(release);
      if (github.compareVersions(version, app.getVersion()) > 0) {
        candidate = github.releaseAssets(release);
        setStatus({ state: "available", version, notes: typeof release.body === "string" ? release.body.slice(0, 4000) : null });
      } else setStatus({ state: "latest" });
    } catch (error) {
      log(`check failed: ${error.message}`);
      setStatus({ state: "error", message: `无法检查 GitHub 更新：${error.message}` });
    }
    return status;
  })().finally(() => { checking = null; });
  return checking;
}

function launch(target) {
  return new Promise((resolve, reject) => {
    const child = spawn("explorer.exe", [target], { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

function installUpdate() {
  if (installing) return installing;
  if (!updateEnabled() || status.state !== "available" || !candidate) return Promise.resolve(status);
  const release = candidate;
  installing = (async () => {
    let staging = null;
    try {
      setStatus({ state: "downloading", message: null });
      const kind = buildKind();
      const asset = kind === "installed" ? release.installer : release.portable;
      const sums = await github.readText(release.checksums.url, 64 * 1024);
      if (release.checksums.digest && createHash("sha256").update(sums).digest("hex") !== release.checksums.digest) throw new Error("校验文件 SHA-256 不一致");
      const digest = github.checksumFor(sums, asset);
      staging = await fsp.mkdtemp(path.join(os.tmpdir(), "codex-speed-pet-update-"));
      const target = path.join(staging, asset.name);
      await github.download(asset, target, digest);
      log(`verified GitHub update v${release.version}, kind=${kind}`);
      if (kind === "installed") {
        await launch(target);
      } else {
        const files = path.join(staging, "files");
        await fsp.mkdir(files);
        await execFileAsync("tar", ["-xf", target, "-C", files], { timeout: 120000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
        if (!fs.existsSync(path.join(files, "Codex Speed Pet.exe")) || !fs.existsSync(path.join(files, "resources", "app.asar"))) throw new Error("便携更新包结构无效");
        const script = path.join(staging, "apply-update.ps1");
        await fsp.writeFile(script, await fsp.readFile(path.join(__dirname, "portable-update.ps1")));
        await fsp.writeFile(path.join(staging, "update.json"), JSON.stringify({ source: files, target: path.dirname(app.getPath("exe")), exe: path.basename(app.getPath("exe")), appPid: process.pid, logDir: app.getPath("userData") }), "utf8");
        const launcher = path.join(staging, "run-hidden.vbs");
        const command = `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${script}"`;
        await fsp.writeFile(launcher, "\uFEFF" + `Set sh = CreateObject("WScript.Shell")\r\nsh.Run "${command.replace(/"/g, '""')}", 0, False\r\n`, "utf16le");
        await launch(launcher);
      }
      setStatus({ state: "installing" });
      requestQuit?.();
    } catch (error) {
      log(`install failed: ${error.message}`);
      setStatus({ state: "error", message: `更新失败：${error.message}` });
      if (staging) await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    }
    return status;
  })().finally(() => { installing = null; });
  return installing;
}

function init(options) {
  stop();
  onStatus = options.onStatus || null;
  requestQuit = options.requestQuit || null;
  if (!updateEnabled()) return;
  timers.push(setTimeout(checkForUpdate, STARTUP_CHECK_DELAY_MS));
  timers.push(setInterval(() => {
    if (["idle", "latest", "error"].includes(status.state)) checkForUpdate();
  }, CHECK_INTERVAL_MS));
}
function stop() { for (const timer of timers) clearTimeout(timer); timers = []; }

module.exports = { init, stop, checkForUpdate, installUpdate, getStatus, buildKind, updateEnabled };
