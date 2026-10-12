// Keep the dashboard above normal windows, but let later topmost windows
// (including screenshot selection overlays) stay above it. Only explicit
// show/restore or enabling topmost should raise the dashboard.
function createTopmostGuard(window, { platform = process.platform, timers = globalThis } = {}) {
  let enabled = false;
  let timer = null;
  let disposed = false;
  const level = "floating";

  function stopTimer() {
    if (timer !== null) timers.clearInterval(timer);
    timer = null;
  }

  function maintain() {
    if (disposed || window.isDestroyed() || !enabled || !window.isVisible() || window.isMinimized()) return;
    if (!window.isAlwaysOnTop()) window.setAlwaysOnTop(true, level);
  }

  function resume() {
    maintain();
    if (!disposed && !window.isDestroyed() && enabled && window.isVisible() && !window.isMinimized() && timer === null) {
      window.moveTop();
      timer = timers.setInterval(maintain, 1000);
      timer.unref?.();
    }
  }

  function apply(value) {
    if (disposed || window.isDestroyed()) return;
    const next = value === true;
    // Unrelated settings updates must not raise us over a capture overlay.
    if (enabled === next && window.isAlwaysOnTop() === next) return;
    enabled = next;
    stopTimer();
    window.setAlwaysOnTop(enabled, enabled ? level : "normal");
    // Repair a lost flag on Windows without competing for topmost z-order.
    if (platform === "win32") resume();
  }

  function dispose() {
    disposed = true;
    stopTimer();
    for (const [event, listener] of listeners) window.removeListener(event, listener);
  }

  const listeners = platform === "win32"
    ? [["show", resume], ["restore", resume], ["hide", stopTimer], ["minimize", stopTimer], ["closed", dispose]]
    : [["closed", dispose]];
  for (const [event, listener] of listeners) window.on(event, listener);
  return { apply, dispose };
}

module.exports = { createTopmostGuard };
