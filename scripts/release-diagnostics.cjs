const { getToken, request, REPOSITORY } = require('./publish-github.cjs');

function duration(start, end) {
  const from = Date.parse(start), to = Date.parse(end);
  return Number.isFinite(from) && Number.isFinite(to) && to >= from
    ? Math.round((to - from) / 1000) : null;
}

function formatDuration(seconds) {
  if (seconds === null) return '未完成';
  const minutes = Math.floor(seconds / 60), remainder = seconds % 60;
  return minutes ? `${minutes}分${remainder}秒` : `${remainder}秒`;
}

function summarizeRun(run, jobs) {
  return {
    id: run.id, name: run.name, url: run.html_url, commit: run.head_sha,
    status: run.status, conclusion: run.conclusion,
    seconds: run.status === 'completed' ? duration(run.created_at, run.updated_at) : null,
    // Keep overlapping jobs separate instead of adding them as wall time.
    jobs: jobs.map(job => ({
      name: job.name, seconds: duration(job.started_at, job.completed_at),
      steps: (job.steps || []).map(step => ({
        name: step.name, status: step.status, conclusion: step.conclusion,
        seconds: step.status === 'completed' ? duration(step.started_at, step.completed_at) : null,
      })),
    })),
  };
}

function validateIds(ids) {
  if (!ids.length || ids.length > 10 || ids.some(id => !/^[1-9]\d*$/.test(String(id)))) {
    throw Error('用法：npm run diagnose:release -- <Actions运行ID> [另一个运行ID]（最多10个）');
  }
}

async function inspectRuns(ids, call) {
  validateIds(ids);
  const base = `https://api.github.com/repos/${REPOSITORY}`;
  return Promise.all(ids.map(async id => {
    const run = await call('GET', `${base}/actions/runs/${id}`);
    const jobs = [];
    for (let page = 1; ; page++) {
      const result = await call('GET', `${base}/actions/runs/${id}/jobs?filter=latest&per_page=100&page=${page}`);
      jobs.push(...result.jobs);
      if (result.jobs.length < 100) break;
    }
    return summarizeRun(run, jobs);
  }));
}

async function main(ids) {
  validateIds(ids); // Reject bad input before reading credentials.
  const token = getToken();
  const runs = await inspectRuns(ids, (...args) => request(token, ...args));
  for (const run of runs) {
    console.log(`${run.name} #${run.id}：${run.conclusion || run.status}，总耗时 ${formatDuration(run.seconds)}`);
    console.log(run.url);
    for (const job of run.jobs) {
      console.log(`  ${job.name}：${formatDuration(job.seconds)}`);
      const steps = job.steps.filter(step => step.conclusion !== 'skipped')
        .sort((a, b) => (b.seconds ?? -1) - (a.seconds ?? -1));
      for (const step of steps) console.log(`    ${formatDuration(step.seconds).padEnd(9)} ${step.name} [${step.conclusion || step.status}]`);
    }
  }
}

module.exports = { duration, formatDuration, summarizeRun, inspectRuns };
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
