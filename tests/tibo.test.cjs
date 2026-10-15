const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const filename = path.resolve(__dirname, '../src/TiboPrediction.tsx');
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020 }
}).outputText;
const loaded = new Module(filename, module);
loaded.filename = filename;
loaded.paths = Module._nodeModulePaths(path.dirname(filename));
loaded._compile(compiled, filename);
const { default: TiboPrediction, describeTibo, EMPTY_TIBO } = loaded.exports;
const now = Date.parse('2026-10-15T06:00:00Z');
const baseData = { latest_reset: null, scheduled_reset: null, active_watch: null };
const snapshot = data => ({ data: { ...baseData, ...data }, fetchedAt: now, error: null });
const watch = { level: 'strong', reset_chance_percent: 75, forecast_window: 'today', observed_at: '2026-10-15T04:00:00Z', expires_at: '2026-10-15T08:00:00Z', text: 'Maybe' };
const render = value => renderToStaticMarkup(React.createElement(TiboPrediction, { snapshot: value, now }));

test('scheduled announcements take priority and never become executed just because their time passed', () => {
  const value = snapshot({ scheduled_reset: { reset_type: 'regular', announced_at: watch.observed_at, scheduled_for: '2026-10-15T05:00:00Z', text: 'Soon' }, active_watch: watch });
  assert.equal(describeTibo(value, now).status, '等待执行确认');
  assert.doesNotMatch(render(value), /概率|75%/);
  value.data.scheduled_reset.scheduled_for = null;
  assert.match(describeTibo(value, now).detail, /时间待定/);
});

test('unknown probability, zero probability and expired predictions remain distinct', () => {
  assert.equal(describeTibo(snapshot({ active_watch: watch }), now).status, '重置概率 75%');
  assert.equal(describeTibo(snapshot({ active_watch: { ...watch, reset_chance_percent: 0 } }), now).status, '重置概率 0%');
  assert.equal(describeTibo(snapshot({ active_watch: { ...watch, reset_chance_percent: null } }), now).status, '重置信号较强');
  assert.equal(describeTibo(snapshot({ active_watch: watch }), Date.parse(watch.expires_at)).status, '预测已过期');
});

test('empty, loading, failed and stale states are explicit while preserving the cached result', () => {
  assert.equal(describeTibo(EMPTY_TIBO, now).status, '正在查询…');
  assert.equal(describeTibo({ ...EMPTY_TIBO, error: 'offline' }, now).status, '暂时无法查询');
  assert.equal(describeTibo(snapshot({}), now).status, '暂无重置信号');
  const value = snapshot({ active_watch: watch });
  assert.match(render({ ...value, error: 'offline' }), /重置概率 75%.*查询失败，显示上次结果/);
  assert.match(render({ ...value, fetchedAt: now - 32 * 60 * 1000 }), /结果待更新/);
});

test('display keeps the requested title and Chinese summary without English content or query metadata', () => {
  const html = render(snapshot({ active_watch: { ...watch, text: '<script>alert(1)</script>' } }));
  assert.match(html, /Tibo Reset 预测/);
  assert.match(html, /有效至/);
  assert.doesNotMatch(html, /today|script|alert|查询于|来源|Codex Resets|每 30 分钟|href=/);
});
