// LAN shared-folder updater. The update feed is a plain SMB share containing:
//   version.json          { version, notes?, installer?, portableZip? }
//   <installer>           NSIS setup exe, used by installed copies
//   <portableZip>         zipped portable folder contents, used by portable copies
// The share path comes from a local configuration file shared with the publisher.
// All share I/O is async so an unreachable share never freezes the main process.
const { app } = require("electron");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execFileAsync = promisify(execFile);

// The local JSON is intentionally absent from Git. A build without it can run,
// but only builds made with a configured share can check for updates.
function configuredUpdateShare() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, "update-share.json"), "utf8").replace(/^\uFEFF/, "");
    const value = JSON.parse(raw).share;
    return typeof value === "string" && value.trim() ? value.trim() : null;
  } catch { return null; }
}
const UPDATE_SHARE = process.env.CODEX_SPEED_PET_UPDATE_SHARE || configuredUpdateShare();

const MANIFEST_NAME = "version.json";
const LOG_FILE = () => path.join(app.getPath("userData"), "update.log");
function log(line) {
  try { fs.appendFileSync(LOG_FILE(), `[${new Date().toISOString()}] ${line}\r
`); } catch { /* logging must never break updates */ }
}
const STARTUP_CHECK_DELAY_MS = 5000;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

let status = { state: "idle", version: null, notes: null, message: null };
let onStatus = null;
let requestQuit = null;
let timers = [];

function updateEnabled() {
  return !!UPDATE_SHARE && (app.isPackaged || !!process.env.CODEX_SPEED_PET_UPDATE_SHARE);
}

function buildKind() {
  if (!app.isPackaged) return "dev";
  const localPrograms = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs") : null;
  const exe = app.getPath("exe");
  if (localPrograms && exe.toLowerCase().startsWith(localPrograms.toLowerCase())) return "installed";
  return "portable";
}

function emit() { if (onStatus) onStatus(status); }
function setStatus(patch) { status = { ...status, ...patch }; emit(); }
function getStatus() { return status; }

function compareVersions(a, b) {
  const pa = String(a).split(".").map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

async function readManifest() {
  const raw = await fsp.readFile(path.join(UPDATE_SHARE, MANIFEST_NAME), "utf8");
  const manifest = JSON.parse(raw);
  if (!manifest || typeof manifest.version !== "string") throw new Error("version.json 内容不完整");
  return manifest;
}

async function checkForUpdate() {
  if (!updateEnabled()) { setStatus({ state: "unsupported", message: "当前环境不支持更新" }); return status; }
  setStatus({ state: "checking", version: null, notes: null, message: null });
  try {
    const manifest = await readManifest();
    if (compareVersions(manifest.version, app.getVersion()) > 0) {
      setStatus({ state: "available", version: manifest.version, notes: typeof manifest.notes === "string" ? manifest.notes : null });
    } else {
      setStatus({ state: "latest" });
    }
  } catch (error) {
    setStatus({ state: "error", message: `无法访问更新目录：${error.message}` });
  }
  return status;
}

// Copy one file from the share into a fresh staging dir; returns { target, dir }.
async function stageFile(name) {
  const source = path.join(UPDATE_SHARE, name);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "codex-speed-pet-update-"));
  const target = path.join(dir, name);
  await fsp.copyFile(source, target);
  return { target, dir };
}

async function installUpdate() {
  if (status.state !== "available") return status;
  try {
    const manifest = await readManifest();
    if (buildKind() === "installed") {
      if (!manifest.installer) throw new Error("更新目录缺少安装包");
      setStatus({ state: "downloading" });
      log(`installed install start, share=${UPDATE_SHARE}`);
      const { target } = await stageFile(manifest.installer);
      log(`staged ${target}`);
      setStatus({ state: "installing" });
      // Launch via explorer.exe: the shell starts the installer outside this
      // process's job object, so it survives app.quit() below.
      spawn("explorer.exe", [target], { detached: true, stdio: "ignore", windowsHide: true }).unref();
      if (requestQuit) requestQuit();
      return status;
    }
    if (!manifest.portableZip) throw new Error("更新目录缺少便携版压缩包");
    setStatus({ state: "downloading" });
    log(`portable install start, share=${UPDATE_SHARE}`);
    const { target: zip, dir } = await stageFile(manifest.portableZip);
    log(`staged ${zip}`);
    const files = path.join(dir, "files");
    await fsp.mkdir(files, { recursive: true });
    await execFileAsync("tar", ["-xf", zip, "-C", files], { maxBuffer: 16 * 1024 * 1024 }); // Windows 10+ 自带 bsdtar，可直接解压 zip
    log("extracted");
    const script = path.join(dir, "apply-update.cmd");
    const exePath = app.getPath("exe");
    await fsp.writeFile(script, portableUpdaterScript(files, path.dirname(exePath), path.basename(exePath), process.pid, dir, app.getPath("userData")), { encoding: "ascii" });
    const launcher = path.join(dir, "run-hidden.vbs");
    await fsp.writeFile(launcher, hiddenLauncherScript(script, exePath, path.dirname(exePath)), { encoding: "ascii" });
    log(`script written ${script}`);
    setStatus({ state: "installing" });
    // explorer.exe shell-executes the vbs -> wscript -> hidden cmd. The updater
    // ends up under explorer.exe, outside this process's job object, so it
    // survives app.quit() and can replace + relaunch the portable build.
    spawn("explorer.exe", [launcher], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    log("updater spawned, quitting");
    if (requestQuit) requestQuit();
  } catch (error) {
    log(`install failed: ${error.stack || error.message}`);
    setStatus({ state: "error", message: `更新失败：${error.message}` });
  }
  return status;
}

// Waits for the running portable app to exit, mirrors the new files over the
// old folder, then relaunches. User data lives in %APPDATA%, so a full mirror
// of the program folder is safe. Paths are baked directly into the script.
// The vbs is the real launcher: it runs the updater batch (waiting for it to
// finish), then starts the app itself. WScript.Shell.Run is a plain
// CreateProcess wrapper and does not suffer the console-attach hang that
// "start" has inside an orphaned hidden cmd.
function hiddenLauncherScript(cmdPath, exePath, workDir) {
  const q = (value) => `Chr(34) & "${String(value).replace(/"/g, "")}" & Chr(34)`;
  return [
    "Set sh = CreateObject(\"WScript.Shell\")",
    `sh.CurrentDirectory = "${String(workDir).replace(/"/g, "")}"`,
    `sh.Run "cmd.exe /c " & ${q(cmdPath)}, 0, True`,
    "On Error Resume Next",
    "sh.Environment(\"PROCESS\").Remove(\"CODEX_SPEED_PET_DEBUG_PORT\")",
    "On Error Goto 0",
    `sh.Run ${q(exePath)}, 1, False`,
    ""
  ].join("\r\n");
}
function portableUpdaterScript(source, target, exeName, appPid, stagingDir, logDir) {
  const logFile = path.join(stagingDir, "updater-script.log");
  return [
    "@echo off",
    `set "SOURCE=${source}"`,
    `set "TARGET=${target}"`,
    `set "EXE=${exeName}"`,
    `set "STAGING=${stagingDir}"`,
    `set "LOG=${logFile}"`,
    'echo [%date% %time%] updater start>"%LOG%"',
    ":wait",
    `tasklist /FI "PID eq ${appPid}" 2>NUL | find "${appPid}" >NUL`,
    'if %ERRORLEVEL%==0 (ping -n 2 127.0.0.1 >NUL & goto wait)',
    // Main process exit does not mean all child processes are gone; give the
    // renderer/GPU children a moment to release profile and file locks.
    'ping -n 4 127.0.0.1 >NUL',
    'echo [%date% %time%] app exited, replacing files>>"%LOG%"',
    'robocopy "%SOURCE%" "%TARGET%" /MIR /NFL /NDL /NJH /NJS >>"%LOG%" 2>&1',
    'echo [%date% %time%] files replaced, vbs will relaunch>>"%LOG%"',
    `copy /y "%LOG%" "${path.join(logDir, "updater-script-last.log")}" >NUL`,
    'rmdir /s /q "%STAGING%"',
    ""
  ].join("\r\n");
}
function init(options) {
  onStatus = options.onStatus || null;
  requestQuit = options.requestQuit || null;
  if (!updateEnabled()) return;
  timers.push(setTimeout(checkForUpdate, STARTUP_CHECK_DELAY_MS));
  timers.push(setInterval(() => {
    // Background checks only report availability; installing is always user-triggered.
    if (status.state === "idle" || status.state === "latest" || status.state === "error") checkForUpdate();
  }, CHECK_INTERVAL_MS));
}

function stop() {
  for (const timer of timers) { clearTimeout(timer); clearInterval(timer); }
  timers = [];
}

module.exports = { init, stop, checkForUpdate, installUpdate, getStatus, buildKind, updateEnabled };
