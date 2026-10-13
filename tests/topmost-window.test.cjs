// Real Windows z-order regression: a screenshot-like topmost overlay must stay
// above the dashboard, while ordinary windows remain below it.
const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { createTopmostGuard } = require("../electron/topmost.cjs");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let guard;

function nativeState(pet, blocker) {
  const petHandle = pet.getNativeWindowHandle().readBigUInt64LE().toString();
  const blockerHandle = blocker.getNativeWindowHandle().readBigUInt64LE().toString();
  const script = `
$ProgressPreference = 'SilentlyContinue'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class WindowOrder {
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr handle, uint command);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr handle, int index);
}
'@
$petHandle = [IntPtr]::new([long]${petHandle})
$blockerHandle = [IntPtr]::new([long]${blockerHandle})
$cursor = [WindowOrder]::GetWindow($blockerHandle, 3)
$petAbove = $false
for ($i = 0; $i -lt 10000 -and $cursor -ne [IntPtr]::Zero; $i++) {
  if ($cursor -eq $petHandle) { $petAbove = $true; break }
  $cursor = [WindowOrder]::GetWindow($cursor, 3)
}
@{ petAbove = $petAbove; foreground = [WindowOrder]::GetForegroundWindow().ToInt64().ToString(); topmost = ([WindowOrder]::GetWindowLong($petHandle, -20) -band 8) -ne 0 } | ConvertTo-Json -Compress
`;
  return JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true, timeout: 10000 }));
}

app.whenReady().then(async () => {
  assert.equal(process.platform, "win32", "this regression checks native Windows z-order");
  const pet = new BrowserWindow({ width: 180, height: 120, x: 30, y: 30, frame: false, transparent: true, show: false, skipTaskbar: true });
  const blocker = new BrowserWindow({ width: 210, height: 150, x: 30, y: 30, show: false, alwaysOnTop: true, skipTaskbar: true });
  await pet.loadURL("data:text/html,<body style='background:%23333;color:white'>Topmost recovery test</body>");
  await blocker.loadURL("data:text/html,<body>Other topmost app</body>");
  guard = createTopmostGuard(pet);
  guard.apply(true);
  assert.equal(pet.isAlwaysOnTop(), true, "enabling topmost must work while the window is still hidden");
  assert.equal(nativeState(pet, blocker).topmost, true, "Windows WS_EX_TOPMOST must be set, not only an Electron setting");
  blocker.setAlwaysOnTop(true, "screen-saver");
  pet.showInactive(); blocker.show();
  await sleep(150);
  blocker.moveTop();
  const covered = nativeState(pet, blocker);
  assert.equal(covered.petAbove, false, "the other topmost app must initially cover the pet");
  await sleep(1200);
  guard.apply(true);
  pet.emit("blur");
  await sleep(1200);
  const overlay = nativeState(pet, blocker);
  assert.equal(overlay.petAbove, false, "timer, blur and settings updates must leave the screenshot overlay above the pet");
  // The user may switch apps while this desktop test runs. Maintenance must
  // never activate the dashboard, even when another app becomes foreground.
  assert.notEqual(overlay.foreground, pet.getNativeWindowHandle().readBigUInt64LE().toString(), "maintenance must not steal foreground focus");
  assert.equal(pet.isAlwaysOnTop(), true, "dashboard must retain ordinary topmost behavior");
  assert.equal(overlay.topmost, true, "native topmost flag must survive show and maintenance");
  blocker.setAlwaysOnTop(false); blocker.moveTop();
  assert.equal(nativeState(pet, blocker).petAbove, true, "a normal window must stay below the dashboard");
  pet.setBounds({ x: 45, y: 45, width: 220, height: 180 });
  blocker.focus(); blocker.moveTop();
  await sleep(1200);
  assert.equal(nativeState(pet, blocker).petAbove, true, "moving/resizing and switching to a normal app must retain topmost");
  assert.equal(nativeState(pet, blocker).topmost, true);
  blocker.setAlwaysOnTop(true, "screen-saver"); blocker.moveTop();
  pet.setAlwaysOnTop(false);
  await sleep(1200);
  assert.equal(pet.isAlwaysOnTop(), true, "lost topmost flag must recover");
  guard.apply(false); blocker.moveTop();
  await sleep(1200);
  assert.equal(pet.isAlwaysOnTop(), false);
  assert.equal(nativeState(pet, blocker).petAbove, false, "disabled setting must stay disabled");
  guard.apply(true); pet.hide();
  await sleep(1200);
  assert.equal(pet.isVisible(), false, "a hidden dashboard must stay hidden");
  pet.showInactive();
  assert.equal(nativeState(pet, blocker).petAbove, true, "show must restore z-order immediately");
  guard.dispose(); pet.destroy(); blocker.destroy();
  console.log("Native Windows screenshot overlay z-order, ordinary topmost, foreground focus, lost flag, disabled setting and hide/show: passed");
  app.quit();
}).catch(error => { guard?.dispose(); console.error(error); app.exit(1); });
