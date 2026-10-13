const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

async function fixture(lock = true) {
  const calls = { quits: 0, starts: 0, updates: 0, windows: [], trays: [], sent: [] };
  const handlers = new Map();
  const app = Object.assign(new EventEmitter(), {
    isPackaged: true, requestSingleInstanceLock: () => lock,
    quit: () => calls.quits++, whenReady: () => Promise.resolve(),
    getPath: () => 'C:/test', getVersion: () => '1.0.0', setLoginItemSettings() {}
  });
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.bounds = options; this.webContents = { send: (channel, value) => calls.sent.push({ channel, value }) };
      this.shown = 0; this.focused = 0; this.minimized = false; calls.windows.push(this);
    }
    isDestroyed() { return false; }
    isVisible() { return this.shown > 0; }
    isMinimized() { return this.minimized; }
    restore() { this.minimized = false; }
    show() { this.shown++; }
    focus() { this.focused++; }
    setMenuBarVisibility() {}
    loadFile() {}
  }
  class Tray extends EventEmitter {
    constructor() { super(); calls.trays.push(this); }
    setToolTip() {}
    setContextMenu(menu) { this.menu = menu; }
  }
  const ipcMain = Object.assign(new EventEmitter(), { handle: (channel, handler) => handlers.set(channel, handler) });
  const status = { state: 'available', version: '1.0.1', notes: 'Fix', message: null };
  const updater = {
    init(options) { calls.updates++; calls.updateOptions = options; assert.ok(handlers.has('app:initial')); },
    stop() {}, getStatus: () => status, buildKind: () => 'installed', updateEnabled: () => true,
    checkForUpdate: async () => status
  };
  const electron = { app, BrowserWindow: Window, Tray, ipcMain,
    Menu: { buildFromTemplate: value => value }, screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
    nativeImage: { createFromPath: () => ({ resize() { return {}; } }) } };
  const loaded = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../electron/main.cjs'), 'utf8'), {
    module: loaded, __dirname: path.resolve(__dirname, '../electron'), process: { env: {}, platform: 'win32' },
    setTimeout, clearTimeout, require: name => name === 'electron' ? electron
      : name === 'node:fs' ? { readFileSync() { throw Error('first launch'); } }
      : name === './usage.cjs' ? { UsageCollector: class { start() { calls.starts++; } snapshot() { return {}; } stop() {} } }
      : name === './update.cjs' ? updater
      : name === './topmost.cjs' ? { createTopmostGuard: () => ({ apply() {}, dispose() {} }) }
      : require(name)
  });
  await Promise.resolve();
  return { calls, handlers, app, status };
}

test('a second instance exits before creating windows, tray, collectors or update timers', async () => {
  const { calls } = await fixture(false);
  assert.equal(calls.quits, 1);
  assert.equal(calls.windows.length, 0);
  assert.equal(calls.trays.length, 0);
  assert.equal(calls.starts, 0);
  assert.equal(calls.updates, 0);
});

test('a repeat launch restores and focuses the existing dashboard', async () => {
  const { calls, app } = await fixture();
  const window = calls.windows[0];
  window.minimized = true;
  app.emit('second-instance');
  assert.equal(window.minimized, false);
  assert.equal(window.shown, 1);
  assert.equal(window.focused, 1);
  assert.equal(calls.windows.length, 1);
  assert.equal(calls.starts, 1);
  assert.equal(calls.updates, 1);
});

test('initial IPC retains available updates; only manual tray checks request settings', async () => {
  const { calls, handlers, status } = await fixture();
  assert.equal(handlers.get('app:initial')().updateStatus, status);
  calls.updateOptions.onStatus(status);
  assert.equal(calls.windows[0].shown, 0);
  assert.equal(calls.sent[0].channel, 'update:status');
  const check = calls.trays[0].menu.find(item => item.label === '检查更新');
  check.click();
  await Promise.resolve();
  assert.equal(calls.sent[1].channel, 'app:openSettings');
  assert.equal(calls.windows[0].shown, 1);
  assert.equal(calls.windows[0].focused, 1);
  assert.equal(calls.quits, 0);
});
