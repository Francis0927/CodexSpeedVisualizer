// Windows shares the topmost band with other apps. The flag alone does not
// keep us above a topmost window that was shown later; moveTop repairs z-order
// without activating this window or interrupting typing in the foreground app.
function createTopmostGuard(window, { platform = process.platform, timers = globalThis } = {}) {
  let enabled = false;
  let timer = null;
  let disposed = false;
  const level = platform === "win32" ? "screen-saver" : "floating";

  function stopTimer() {
    if (timer !== null) timers.clearInterval(timer);
    timer = null;
  }

  function maintain() {
    if (disposed || window.isDestroyed() || !enabled || !window.isVisible() || window.isMinimized()) return;
    if (!window.isAlwaysOnTop()) window.setAlwaysOnTop(true, level);
    window.moveTop();
  }

  function resume() {
    maintain();
    if (!disposed && !window.isDestroyed() && enabled && window.isVisible() && !window.isMinimized() && timer === null) {
      timer = timers.setInterval(maintain, 1000);
      timer.unref?.();
    }
  }

  function apply(value) {
    if (disposed || window.isDestroyed()) return;
    enabled = value === true;
    stopTimer();
    window.setAlwaysOnTop(enabled, enabled ? level : "normal");
    // Periodic z-order repair is only needed on Windows.
    if (platform === "win32") resume();
  }

  function dispose() {
    disposed = true;
    stopTimer();
    for (const [event, listener] of listeners) window.removeListener(event, listener);
  }

  const listeners = platform === "win32"
    ? [["show", resume], ["restore", resume], ["blur", maintain], ["hide", stopTimer], ["minimize", stopTimer], ["closed", dispose]]
    : [["closed", dispose]];
  for (const [event, listener] of listeners) window.on(event, listener);
  return { apply, dispose };
}

module.exports = { createTopmostGuard };
