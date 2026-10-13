const { app, BrowserWindow, ipcMain, screen } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'speed-pet-update-window-test-'));
app.setPath('userData', data);
app.disableHardwareAcceleration();
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ size: 'small', autoHideChrome: true, reducedMotion: true }));
const { UsageCollector } = require('../electron/usage.cjs');
UsageCollector.prototype.start = function () {};
const updater = require('../electron/update.cjs');
updater.init = function () {};
updater.updateEnabled = () => true;
updater.buildKind = () => 'installed';
BrowserWindow.prototype.show = function () {};
const reports = [], boundsChanges = [], crashes = [];
ipcMain.on('app:contentSize', (_event, size) => reports.push(size));
const mainPath = path.resolve(__dirname, '../electron/main.cjs');
const loadModule = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron' && parent?.filename === mainPath) {
    return { ...require('electron'), BrowserWindow: function (options) {
      const win = new BrowserWindow({ ...options, webPreferences: { ...options.webPreferences, offscreen: true, backgroundThrottling: false } });
      const setBounds = win.setBounds.bind(win);
      win.setBounds = (bounds) => { boundsChanges.push(bounds); return setBounds(bounds); };
      win.webContents.on('render-process-gone', (_event, details) => crashes.push(details));
      return win;
    } };
  }
  return loadModule.call(this, request, parent, isMain);
};
try { require(mainPath); } finally { Module._load = loadModule; }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function ui(win) {
  return win.webContents.executeJavaScript(`(() => {
    const viewport = document.querySelector('.viewport');
    return { collapsed: document.querySelector('.shell').classList.contains('is-collapsed'),
      panel: !!document.querySelector('.overlay'), scale: Number(viewport.style.zoom),
      height: Math.ceil(viewport.offsetHeight * Number(viewport.style.zoom)),
      update: document.querySelector('.update-info')?.innerText,
      button: document.querySelector('.update-now')?.innerText,
      badge: document.querySelector('.live-tag')?.innerText,
      settingsHighlighted: document.querySelector('[aria-label="设置"]').classList.contains('has-update') };
  })()`);
}

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0];
  win.webContents.setBackgroundThrottling(false);
  if (win.webContents.isLoading()) await new Promise(resolve => win.webContents.once('did-finish-load', resolve));
  console.log(JSON.stringify({ displays: screen.getAllDisplays().map(({ workArea, scaleFactor }) => ({ workArea, scaleFactor })) }));
  await sleep(4500);
  assert.equal((await ui(win)).collapsed, true);
  for (const size of ['small', 'medium', 'large']) {
    await win.webContents.executeJavaScript(`window.speedPet.updateSettings({size:'${size}'})`);
    await sleep(300);
    const before = win.getBounds(), changesBefore = boundsChanges.length;
    const available = { state: 'available', version: '9.9.9', notes: '更新说明'.repeat(1000), message: null };
    win.webContents.send('update:status', available);
    await sleep(1800);
    const notified = await ui(win);
    assert.equal(notified.panel, false, 'background update checks must not force a panel open');
    assert.equal(notified.collapsed, true, 'background update checks must not expand a folded window');
    assert.equal(notified.badge, '有更新');
    assert.equal(notified.settingsHighlighted, true);
    assert.deepEqual(win.getBounds(), before, 'background update checks must not move or resize the native window');
    assert.equal(boundsChanges.length, changesBefore);
    win.webContents.send('app:openSettings');
    await sleep(600);
    const current = await ui(win);
    assert.equal(current.panel, true);
    assert.equal(current.collapsed, false);
    assert.equal(current.scale, size === 'large' ? 1.05 : .82);
    assert.equal(current.button, '立即更新');
    assert.ok(Math.abs(win.getBounds().height - current.height) <= 1);
    const start = boundsChanges.length;
    await sleep(1800);
    assert.equal(boundsChanges.length, start, `update panel must settle without repeatedly resizing: ${JSON.stringify(boundsChanges.slice(-10))}`);
    assert.deepEqual(crashes, []);
    console.log(JSON.stringify({ size, ui: { ...current, update: current.update?.slice(0, 40) }, changes: boundsChanges.length, reports: reports.length }));
    await win.webContents.executeJavaScript(`document.querySelector('.panel-close').click()`);
    await win.webContents.executeJavaScript(`document.querySelector('.gauge-wrap').dispatchEvent(new MouseEvent('mouseover',{bubbles:true,relatedTarget:null}));`);
    await sleep(150);
    await win.webContents.executeJavaScript(`document.querySelector('.shell').dispatchEvent(new MouseEvent('mouseout',{bubbles:true,relatedTarget:document.body}));`);
    await sleep(1800);
  }
  await win.webContents.executeJavaScript(`document.querySelector('.speed-card').click()`);
  await sleep(300);
  win.webContents.send('update:status', { state: 'available', version: '9.9.9', notes: '', message: null });
  await sleep(300);
  assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.panel-head strong').innerText`), '用量详情', 'an update must not replace the panel being used');
  updater.getStatus = () => ({ state: 'available', version: '9.9.9', notes: '', message: null });
  win.webContents.reload();
  await new Promise(resolve => win.webContents.once('did-finish-load', resolve));
  await sleep(4500);
  const reloaded = await ui(win);
  assert.equal(reloaded.badge, '有更新', 'initial IPC must restore an update detected before renderer load');
  assert.equal(reloaded.panel, false);
  assert.equal(reloaded.collapsed, true);
  assert.deepEqual(crashes, []);
  console.log('Background updates preserve native bounds, explicit settings open, reload retains update state and renderer survives: passed');
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
