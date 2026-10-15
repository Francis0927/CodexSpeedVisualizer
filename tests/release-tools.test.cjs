const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { duration, formatDuration, summarizeRun, inspectRuns } = require('../scripts/release-diagnostics.cjs');

test('release note check uses process-scoped bypass without invoking the publisher', { skip: process.platform !== 'win32' }, () => {
  const pkg = require('../package.json');
  assert.match(pkg.scripts['check:release-notes'], /-ExecutionPolicy Bypass .* -CheckNotes$/);
  assert.match(pkg.scripts['publish:github'], /-ExecutionPolicy Bypass -File/);
  const script = path.resolve(__dirname, '../scripts/publish-github.ps1');
  const before = fs.readFileSync(script);
  for (const notes of ['新增 Tibo Reset 预测', '引号 "中文"\n第二行 $(literal) `text`']) {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-CheckNotes', '-Notes', notes], {
      encoding: 'utf8', windowsHide: true, timeout: 15000,
      env: { ...process.env, PSExecutionPolicyPreference: 'Restricted', GH_TOKEN: '', GITHUB_TOKEN: '' },
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.deepEqual(JSON.parse(result.stdout), { notes });
  }
  assert.deepEqual(fs.readFileSync(script), before);
});

test('timings distinguish wall time, job time and incomplete steps', () => {
  const run = { id: 1, status: 'completed', created_at: '2026-10-15T06:00:00Z', updated_at: '2026-10-15T06:08:00Z' };
  const report = summarizeRun(run, [{ name: 'release', started_at: run.created_at, completed_at: '2026-10-15T06:07:58Z', steps: [
    { name: 'compile', status: 'completed', conclusion: 'success', started_at: '2026-10-15T06:00:00Z', completed_at: '2026-10-15T06:02:50Z' },
    { name: 'upload', status: 'in_progress', started_at: '2026-10-15T06:07:00Z', completed_at: null },
    { name: 'retry', status: 'completed', conclusion: 'skipped' },
  ] }]);
  assert.equal(report.seconds, 480);
  assert.equal(report.jobs[0].seconds, 478);
  assert.equal(report.jobs[0].steps[0].seconds, 170);
  assert.equal(report.jobs[0].steps[1].seconds, null);
  assert.equal(report.jobs[0].steps[2].seconds, null);
  assert.equal(formatDuration(170), '2分50秒');
  assert.equal(formatDuration(null), '未完成');
  assert.equal(duration('invalid', run.updated_at), null);
});

test('diagnostics only issue GETs, paginate jobs and reject invalid IDs before requests', async () => {
  const calls = [];
  const inspect = async (method, url) => {
    calls.push({ method, url });
    assert.equal(method, 'GET');
    if (url.endsWith('/actions/runs/42')) return { id: 42, status: 'in_progress' };
    if (url.endsWith('page=1')) return { jobs: Array.from({ length: 100 }, (_, i) => ({ name: String(i) })) };
    if (url.endsWith('page=2')) return { jobs: [{ name: 'last' }] };
    throw Error('Unexpected request');
  };
  const [run] = await inspectRuns(['42'], inspect);
  assert.equal(run.jobs.length, 101);
  assert.equal(run.seconds, null);
  assert.equal(calls.length, 3);
  for (const ids of [[], ['42/dispatches'], ['-1']]) {
    await assert.rejects(inspectRuns(ids, () => { throw Error('must not call'); }), /用法/);
  }
});
