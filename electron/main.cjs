const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, dialog, protocol, net } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { UsageCollector } = require("./usage.cjs");
const updater = require("./update.cjs");

if (process.env.CODEX_SPEED_PET_DEBUG_PORT) app.commandLine.appendSwitch("remote-debugging-port", process.env.CODEX_SPEED_PET_DEBUG_PORT);
const collector = new UsageCollector();
let window = null;
let tray = null;
const SIZES = { small: 0.55, medium: 0.82, large: 1.05 };
const PANEL_MIN_SIZE = "medium";
const PET_IMAGE_EXTENSIONS = new Set([".gif", ".png", ".jpg", ".jpeg", ".webp", ".apng"]);
const MAX_PET_IMAGE_BYTES = 25 * 1024 * 1024;
let settings = { alwaysOnTop: true, reducedMotion: false, launchAtLogin: false, style: "pet", size: "medium", petImage: null, autoHideChrome: true, position: null };
let panelOpen = false;
// When the renderer auto-hides the chrome (title bar + status row), the window
// shrinks by CHROME_HEIGHT so no blank space is left behind.
let chromeHidden = false;
let chromeResizeTimer = null;
const CHROME_HEIGHT = 68;
let quitting = false;
let savePositionTimer = null;

// Custom scheme that serves the user-selected pet GIF/image from the user data
// directory. Works in dev, packaged, and asar builds regardless of CSP rules.
protocol.registerSchemesAsPrivileged([
  { scheme: "speedpet", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);

function settingsPath() { return path.join(app.getPath("userData"), "settings.json"); }
function petDir() { return path.join(app.getPath("userData"), "pet"); }

function loadSettings() {
  try { settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsPath(), "utf8")) }; }
  catch { /* First launch or invalid settings. */ }
  if (!["pet", "gauge"].includes(settings.style)) settings.style = "pet";
  if (!(settings.size in SIZES)) settings.size = "medium";
  // Keep the custom pet image only when the file still exists; drop orphan files.
  try {
    const name = typeof settings.petImage === "string" ? path.basename(settings.petImage) : null;
    const dir = petDir();
    const keep = name && fs.existsSync(path.join(dir, name)) ? name : null;
    if (fs.existsSync(dir)) {
      for (const file of fs.readdirSync(dir)) {
        if (file !== keep) { try { fs.unlinkSync(path.join(dir, file)); } catch { /* Ignore locked files. */ } }
      }
    }
    settings.petImage = keep;
  } catch { settings.petImage = null; }
}

function dimensions(size) {
  const scale = SIZES[size] || 1;
  return { width: Math.round(272 * scale), height: Math.round((chromeHidden ? 360 - CHROME_HEIGHT : 360) * scale) };
}

// Panels (settings/details) stay readable: while one is open, the window never
// shrinks below the medium size. The configured size is restored on close.
function effectiveSize() {
  return panelOpen && SIZES[settings.size] < SIZES[PANEL_MIN_SIZE] ? PANEL_MIN_SIZE : settings.size;
}

function resizeWindow(size) {
  if (!window || window.isDestroyed()) return;
  const { width, height } = dimensions(size);
  const old = window.getBounds();
  const area = screen.getDisplayMatching(old).workArea;
  const x = Math.max(area.x, Math.min(area.x + area.width - width, old.x + old.width - width));
  const y = Math.max(area.y, Math.min(area.y + area.height - height, old.y + old.height - height));
  window.setBounds({ x, y, width, height });
}

function applyWindowSize() { resizeWindow(effectiveSize()); }

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
  const previousSize = settings.size;
  for (const key of ["alwaysOnTop", "reducedMotion", "launchAtLogin", "autoHideChrome"]) {
    if (typeof patch[key] === "boolean") settings[key] = patch[key];
  }
  if (["pet", "gauge"].includes(patch.style)) settings.style = patch.style;
  if (Object.hasOwn(SIZES, patch.size)) settings.size = patch.size;
  if (previousSize !== settings.size) applyWindowSize();
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
  applyWindowSize();
  broadcastSettings();
}

function setChromeHidden(hidden) {
  const next = hidden === true;
  if (chromeHidden === next) return;
  chromeHidden = next;
  if (chromeResizeTimer) { clearTimeout(chromeResizeTimer); chromeResizeTimer = null; }
  if (next) {
    // Let the CSS collapse play out (shell is transparent below) before
    // shrinking the actual window to fit.
    chromeResizeTimer = setTimeout(applyWindowSize, 250);
  } else {
    applyWindowSize();
  }
}

async function choosePetImage() {
  if (!window || window.isDestroyed()) return settingsPayload();
  const result = await dialog.showOpenDialog(window, {
    title: "选择宠物图片",
    filters: [
      { name: "GIF / 图片", extensions: ["gif", "png", "jpg", "jpeg", "webp", "apng"] },
      { name: "所有文件", extensions: ["*"] }
    ],
    properties: ["openFile"]
  });
  const source = result.canceled ? null : result.filePaths[0];
  if (!source) return settingsPayload();
  try {
    const ext = path.extname(source).toLowerCase();
    if (!PET_IMAGE_EXTENSIONS.has(ext)) return settingsPayload();
    if (fs.statSync(source).size > MAX_PET_IMAGE_BYTES) return settingsPayload();
    fs.mkdirSync(petDir(), { recursive: true });
    const name = `pet-${Date.now()}${ext}`;
    fs.copyFileSync(source, path.join(petDir(), name));
    if (settings.petImage) {
      try { fs.unlinkSync(path.join(petDir(), settings.petImage)); } catch { /* Old file already gone. */ }
    }
    settings.petImage = name;
    saveSettings();
    broadcastSettings();
  } catch { /* Keep the previous pet image on any failure. */ }
  return settingsPayload();
}

function clearPetImage() {
  if (settings.petImage) {
    try { fs.unlinkSync(path.join(petDir(), settings.petImage)); } catch { /* Old file already gone. */ }
    settings.petImage = null;
    saveSettings();
    broadcastSettings();
  }
  return settingsPayload();
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
    { label: "显示款式", submenu: [
      { label: "宠物", type: "radio", checked: settings.style === "pet", click: () => updateSettings({ style: "pet" }) },
      { label: "汽车仪表盘", type: "radio", checked: settings.style === "gauge", click: () => updateSettings({ style: "gauge" }) }
    ] },
    { label: "宠物图片", submenu: [
      { label: "更换 GIF / 图片…", click: () => { window?.show(); choosePetImage(); } },
      { label: "恢复默认宠物", enabled: !!settings.petImage, click: () => clearPetImage() }
    ] },
    { label: "窗口大小", submenu: [
      { label: "小", type: "radio", checked: settings.size === "small", click: () => updateSettings({ size: "small" }) },
      { label: "中", type: "radio", checked: settings.size === "medium", click: () => updateSettings({ size: "medium" }) },
      { label: "大", type: "radio", checked: settings.size === "large", click: () => updateSettings({ size: "large" }) }
    ] },
    { label: "减少动画", type: "checkbox", checked: settings.reducedMotion, click: (item) => updateSettings({ reducedMotion: item.checked }) },
    { label: "自动隐藏标题栏", type: "checkbox", checked: settings.autoHideChrome, click: (item) => updateSettings({ autoHideChrome: item.checked }) },
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
  tray.setToolTip("Codex Speed Pet");
  tray.on("double-click", () => { window?.show(); window?.focus(); rebuildTrayMenu(); });
  rebuildTrayMenu();
}

app.whenReady().then(() => {
  protocol.handle("speedpet", (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== "pet") return new Response("Not found", { status: 404 });
      const name = path.basename(decodeURIComponent(url.pathname));
      const file = path.join(petDir(), name);
      if (!name || !fs.existsSync(file)) return new Response("Not found", { status: 404 });
      return net.fetch(pathToFileURL(file).toString());
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
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
  ipcMain.handle("app:choosePetImage", () => choosePetImage());
  ipcMain.handle("app:clearPetImage", () => clearPetImage());
  ipcMain.on("app:panel", (_event, open) => setPanelOpen(open));
  ipcMain.on("app:chrome", (_event, hidden) => setChromeHidden(hidden));
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
