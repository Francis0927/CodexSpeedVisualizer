const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { UsageCollector } = require("./usage.cjs");
const updater = require("./update.cjs");

if (process.env.CODEX_SPEED_PET_DEBUG_PORT) app.commandLine.appendSwitch("remote-debugging-port", process.env.CODEX_SPEED_PET_DEBUG_PORT);
const collector = new UsageCollector();
let window = null;
let tray = null;
const SIZES = { small: 0.55, medium: 0.82, large: 1.05 };
const PANEL_MIN_SIZE = "medium";
let settings = { alwaysOnTop: true, reducedMotion: false, launchAtLogin: false, size: "medium", autoHideChrome: true, position: null };
let panelOpen = false;
let quitting = false;
let savePositionTimer = null;

function settingsPath() { return path.join(app.getPath("userData"), "settings.json"); }

function loadSettings() {
  let migrated = false;
  try {
    const saved = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
    // Retire display-mode/image preferences while retaining all other settings.
    migrated = Object.hasOwn(saved, "style") || Object.hasOwn(saved, "petImage");
    const { style, petImage, ...current } = saved;
    settings = { ...settings, ...current };
  } catch { /* First launch or invalid settings. */ }
  if (!Object.hasOwn(SIZES, settings.size)) settings.size = "medium";
  if (migrated) saveSettings();
}

function dimensions(size) {
  const scale = SIZES[size] || 1;
  // Initial bounds only; the renderer reports the exact content height.
  return { width: Math.round(272 * scale), height: Math.ceil(560 * scale) };
}

// Panels (settings/details) stay readable: while one is open, the window never
// shrinks below the medium size. The configured size is restored on close.
function effectiveSize() {
  return panelOpen && SIZES[settings.size] < SIZES[PANEL_MIN_SIZE] ? PANEL_MIN_SIZE : settings.size;
}

function resizeWindow(width, height) {
  if (!window || window.isDestroyed()) return;
  const old = window.getBounds();
  if (old.width === width && old.height === height) return;
  const area = screen.getDisplayMatching(old).workArea;
  const x = Math.max(area.x, Math.min(area.x + area.width - width, old.x + old.width - width));
  const y = Math.max(area.y, Math.min(area.y + area.height - height, old.y + old.height - height));
  window.setBounds({ x, y, width, height });
}

function setContentSize(size) {
  if (!size || size.viewSize !== effectiveSize() || !Number.isInteger(size.height) || size.height < 60 || size.height > 2000) return;
  resizeWindow(Math.round(272 * SIZES[effectiveSize()]), size.height);
}

function saveSettings() {
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
}

// viewSize is the size the renderer should draw at right now; it is sent with
// every payload but never persisted.
function settingsPayload() { return { ...settings, viewSize: effectiveSize() }; }

function broadcastSettings() {
  if (window && !window.isDestroyed()) {
    window.webContents.send("settings:update", settingsPayload());
    window.setAlwaysOnTop(settings.alwaysOnTop);
  }
  rebuildTrayMenu();
}

function updateSettings(patch) {
  if (!patch || typeof patch !== "object") return settingsPayload();
  for (const key of ["alwaysOnTop", "reducedMotion", "launchAtLogin", "autoHideChrome"]) {
    if (typeof patch[key] === "boolean") settings[key] = patch[key];
  }
  if (Object.hasOwn(SIZES, patch.size)) settings.size = patch.size;
  if (process.platform === "win32" && app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin });
  }
  saveSettings();
  broadcastSettings();
  return settingsPayload();
}

function setPanelOpen(open) {
  const next = open === true;
  if (panelOpen === next) return;
  panelOpen = next;
  broadcastSettings();
}

function createWindow() {
  const display = screen.getPrimaryDisplay().workArea;
  const { width, height } = dimensions(effectiveSize());
  const saved = settings.position;
  const visible = saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) && screen.getAllDisplays().some(({ workArea }) =>
    saved.x + width > workArea.x + 30 && saved.x < workArea.x + workArea.width - 30 &&
    saved.y + height > workArea.y + 30 && saved.y < workArea.y + workArea.height - 30
  );
  const x = visible ? saved.x : display.x + display.width - width - 24;
  const y = visible ? saved.y : display.y + display.height - height - 24;
  window = new BrowserWindow({
    width, height, x, y,
    frame: false,
    transparent: true,
    resizable: false,
    hasShadow: false,
    show: false,
    alwaysOnTop: settings.alwaysOnTop,
    skipTaskbar: true,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  window.setMenuBarVisibility(false);
  window.once("ready-to-show", () => window.show());
  window.on("move", () => {
    if (!window || window.isDestroyed()) return;
    const [nextX, nextY] = window.getPosition();
    settings.position = { x: nextX, y: nextY };
    if (savePositionTimer) clearTimeout(savePositionTimer);
    savePositionTimer = setTimeout(saveSettings, 200);
  });
  window.on("close", (event) => {
    if (!quitting) { event.preventDefault(); window.hide(); rebuildTrayMenu(); }
  });
  if (process.env.CODEX_SPEED_PET_DEV_URL) window.loadURL(process.env.CODEX_SPEED_PET_DEV_URL);
  else window.loadFile(path.join(__dirname, "..", "dist", "index.html"));
}

function rebuildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: window?.isVisible() ? "隐藏仪表盘" : "显示仪表盘", click: () => {
      if (window?.isVisible()) window.hide();
      else { window?.show(); window?.focus(); }
      rebuildTrayMenu();
    } },
    { label: "始终置顶", type: "checkbox", checked: settings.alwaysOnTop, click: (item) => updateSettings({ alwaysOnTop: item.checked }) },
    { label: "窗口大小", submenu: [
      { label: "小", type: "radio", checked: settings.size === "small", click: () => updateSettings({ size: "small" }) },
      { label: "中", type: "radio", checked: settings.size === "medium", click: () => updateSettings({ size: "medium" }) },
      { label: "大", type: "radio", checked: settings.size === "large", click: () => updateSettings({ size: "large" }) }
    ] },
    { label: "减少动画", type: "checkbox", checked: settings.reducedMotion, click: (item) => updateSettings({ reducedMotion: item.checked }) },
    { label: "自动折叠窗口", type: "checkbox", checked: settings.autoHideChrome, click: (item) => updateSettings({ autoHideChrome: item.checked }) },
    { label: "开机启动", type: "checkbox", checked: settings.launchAtLogin, click: (item) => updateSettings({ launchAtLogin: item.checked }) },
    { label: "检查更新", click: () => {
      updater.checkForUpdate().then((result) => {
        if (result.state === "available") { window?.show(); window?.focus(); }
      });
    } },
    { type: "separator" },
    { label: "退出", click: () => { quitting = true; app.quit(); } }
  ]));
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, "..", "assets", "icon.png"));
  tray = new Tray(icon.resize({ width: 20, height: 20 }));
  tray.setToolTip("Codex Drive");
  tray.on("double-click", () => { window?.show(); window?.focus(); rebuildTrayMenu(); });
  rebuildTrayMenu();
}

app.whenReady().then(() => {
  loadSettings();
  collector.historyResetAt = Number.isFinite(settings.historyResetAt) && settings.historyResetAt >= 0 ? settings.historyResetAt : 0;
  createWindow();
  createTray();
  collector.start((snapshot) => {
    if (window && !window.isDestroyed()) window.webContents.send("usage:update", snapshot);
  });
  ipcMain.handle("app:initial", () => ({ usage: collector.snapshot(), settings: settingsPayload(), appInfo: appInfo() }));
  ipcMain.handle("app:settings", (_event, patch) => updateSettings(patch));
  ipcMain.handle("app:resetHistory", () => {
    settings.historyResetAt = Date.now();
    saveSettings();
    return collector.resetHistory(settings.historyResetAt);
  });
  ipcMain.on("app:panel", (_event, open) => setPanelOpen(open));
  ipcMain.on("app:contentSize", (_event, size) => setContentSize(size));
  ipcMain.handle("app:checkUpdate", () => updater.checkForUpdate());
  ipcMain.handle("app:installUpdate", () => updater.installUpdate());
  ipcMain.on("app:hide", () => { window?.hide(); rebuildTrayMenu(); });
  ipcMain.on("app:quit", () => { quitting = true; app.quit(); });
});

updater.init({
  onStatus: (status) => { if (window && !window.isDestroyed()) window.webContents.send("update:status", status); },
  requestQuit: () => { quitting = true; app.quit(); }
});

function appInfo() {
  return { version: app.getVersion(), buildKind: updater.buildKind(), updateEnabled: updater.updateEnabled() };
}

app.on("before-quit", () => {
  quitting = true;
  updater.stop();
  collector.stop();
  if (savePositionTimer) { clearTimeout(savePositionTimer); saveSettings(); }
});
app.on("window-all-closed", () => { /* Keep the tray app alive. */ });
