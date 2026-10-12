const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createTopmostGuard } = require("../electron/topmost.cjs");

function fixture() {
  const window = new EventEmitter();
  Object.assign(window, {
    visible: false, minimized: false, destroyed: false, topmost: false, raised: 0, calls: [],
    isVisible() { return this.visible; },
    isMinimized() { return this.minimized; },
    isDestroyed() { return this.destroyed; },
    isAlwaysOnTop() { return this.topmost; },
    setAlwaysOnTop(flag, level) { this.topmost = flag; this.calls.push([flag, level]); },
    moveTop() { this.raised++; },
    focus() { assert.fail("topmost recovery must not steal focus"); },
    show() { assert.fail("topmost recovery must not reveal a hidden window"); }
  });
  const active = new Map();
  const timers = {
    setInterval(callback, delay) { assert.equal(delay, 1000); const id = {}; active.set(id, callback); return id; },
    clearInterval(id) { active.delete(id); }
  };
  const guard = createTopmostGuard(window, { platform: "win32", timers });
  const tick = () => { for (const callback of active.values()) callback(); };
  return { window, guard, active, tick };
}

test("repairs lost topmost flag and raises above later topmost apps without focusing", () => {
  const { window, guard, active, tick } = fixture();
  guard.apply(true);
  assert.deepEqual(window.calls, [[true, "screen-saver"]]);
  assert.equal(active.size, 0);
  window.visible = true; window.emit("show");
  assert.equal(active.size, 1);
  assert.equal(window.raised, 1);
  tick(); assert.equal(window.raised, 2);
  window.topmost = false;
  tick(); assert.equal(window.topmost, true);
  window.emit("blur"); assert.equal(window.raised, 4);
  guard.apply(true); window.emit("show");
  assert.equal(active.size, 1, "reapplying settings must not accumulate timers");
  guard.dispose();
});

test("honors disabled, hidden and minimized states, then resumes on show/restore", () => {
  const { window, guard, active, tick } = fixture();
  window.visible = true; guard.apply(true);
  guard.apply(false);
  const raised = window.raised;
  assert.equal(window.topmost, false); assert.equal(active.size, 0);
  window.emit("blur"); window.emit("show"); tick();
  assert.equal(window.raised, raised);
  guard.apply(true);
  window.visible = false; window.emit("hide");
  assert.equal(active.size, 0);
  guard.apply(true); window.emit("blur"); tick();
  assert.equal(active.size, 0);
  window.visible = true; window.emit("show");
  assert.equal(active.size, 1);
  window.minimized = true; window.emit("minimize");
  assert.equal(active.size, 0);
  window.emit("blur"); tick();
  window.minimized = false; window.emit("restore");
  assert.equal(active.size, 1);
  guard.dispose();
});

test("cleans up on close/quit and safely ignores destroyed windows", () => {
  const { window, guard, active, tick } = fixture();
  window.visible = true; guard.apply(true);
  window.destroyed = true; tick(); guard.apply(false);
  window.emit("closed");
  assert.equal(active.size, 0);
  assert.deepEqual(window.eventNames(), []);
  guard.dispose(); guard.apply(true);
  assert.equal(active.size, 0);
});
