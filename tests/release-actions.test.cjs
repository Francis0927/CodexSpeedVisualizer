const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ActionsRelease } = require("../scripts/release-actions.cjs");
const { GithubPublisher, assertActionsContext, REPOSITORY } = require("../scripts/publish-github.cjs");
const version = "1.2.3", commit = "a".repeat(40);
const api = `https://api.github.com/repos/${REPOSITORY}`;
const notFound = () => Object.assign(new Error("Not found"), { status: 404 });

function dispatchFixture({ conflict = false, conclusion = "success", modern = false, disabled = false, noRun = false, neverComplete = false, wrongSha = false, staleWorkflow = false } = {}) {
  const calls = [], logs = [];
  let tag = null, title, polls = 0, elapsed = 0;
  const call = async (method, url, options = {}) => {
    calls.push({ method, url, ...options });
    const parsed = new URL(url);
    if (method === "POST" && url.endsWith("/dispatches")) {
      assert.equal(options.json.ref, `v${version}`);
      title = `Release v${version} (${options.json.inputs.request_id})`;
      return modern ? { workflow_run_id: 42 } : {};
    }
    if (method === "POST" && url.endsWith("/git/refs")) { tag = options.json.sha; return {}; }
    if (method !== "GET") throw new Error(`Unexpected mutation: ${method} ${url}`);
    if (url === api) return { permissions: { push: true }, default_branch: 'main' };
    if (parsed.pathname.endsWith("/contents/package.json")) return { content: Buffer.from(JSON.stringify({ version })).toString("base64") };
    if (parsed.pathname.endsWith("/contents/.github/workflows/release.yml")) return { sha: staleWorkflow && parsed.searchParams.get('ref') === 'main' ? 'd'.repeat(40) : 'c'.repeat(40) };
    if (url.endsWith("/releases/latest")) throw notFound();
    if (url.endsWith(`/git/ref/tags/v${version}`)) {
      if (conflict) return { object: { type: "commit", sha: "b".repeat(40) } };
      if (!tag) throw notFound();
      return { object: { type: "commit", sha: tag } };
    }
    if (url.endsWith("/actions/workflows/release.yml")) return { path: ".github/workflows/release.yml", state: disabled ? "disabled_manually" : "active" };
    if (parsed.pathname.endsWith("/actions/workflows/release.yml/runs")) return { workflow_runs: noRun ? [] : [
      { id: 999, head_sha: commit, display_title: "Another user's dispatch" },
      { id: 42, head_sha: commit, display_title: title }
    ] };
    if (url.endsWith("/actions/runs/42")) return { head_sha: wrongSha ? "b".repeat(40) : commit, event: "workflow_dispatch", status: polls++ && !neverComplete ? "completed" : "in_progress", conclusion };
    if (url.endsWith(`/releases/tags/v${version}`)) return { draft: false, prerelease: false, html_url: `https://github.com/${REPOSITORY}/releases/tag/v${version}` };
    throw new Error(`Unexpected call: ${method} ${url}`);
  };
  const actions = new ActionsRelease(call, { log: message => logs.push(message), now: () => elapsed, sleep: async ms => { elapsed += ms; } });
  return { actions, calls, logs };
}

test("publisher freezes the pushed commit, dispatches on its tag and waits for its own run", async () => {
  for (const modern of [false, true]) {
    const sample = dispatchFixture({ modern });
    const notes = '更新说明 "quotes"\n$(do-not-execute) `literal`';
    assert.match(await sample.actions.dispatch(version, commit, notes), /releases\/tag\/v1\.2\.3$/);
    const tag = sample.calls.find(call => call.url.endsWith("/git/refs"));
    assert.deepEqual(tag.json, { ref: `refs/tags/v${version}`, sha: commit });
    const dispatch = sample.calls.find(call => call.url.endsWith("/dispatches"));
    assert.equal(dispatch.json.inputs.notes, notes);
    assert.ok(!sample.calls.some(call => call.url.includes("/actions/runs/999")));
    assert.ok(sample.logs.some(message => message.includes("/actions/runs/42")));
  }
});

test("disabled workflows and conflicting tags never dispatch or replace a tag", async () => {
  for (const options of [{ conflict: true }, { disabled: true }]) {
    const sample = dispatchFixture(options);
    await assert.rejects(sample.actions.dispatch(version, commit));
    assert.ok(!sample.calls.some(call => call.method !== "GET"));
  }
});
test('changed release workflow must reach the default branch before any tag or dispatch mutation', async () => {
  const sample = dispatchFixture({ staleWorkflow: true });
  await assert.rejects(sample.actions.dispatch(version, commit), /尚未推送到默认分支/);
  assert.ok(!sample.calls.some(call => call.method !== 'GET'));
});

test("failed or cancelled Actions runs return an error with the actual run link", async () => {
  for (const conclusion of ["failure", "cancelled", "timed_out"]) {
    const sample = dispatchFixture({ conclusion });
    await assert.rejects(sample.actions.dispatch(version, commit), /发布未完成.*actions\/runs\/42/);
    assert.ok(!sample.calls.some(call => call.url.includes("/releases/tags/")));
  }
});

test("unlocated, timed-out or mismatched runs never report a successful release", async () => {
  for (const [options, message] of [
    [{ noRun: true }, /工作流已触发，但未能定位运行/],
    [{ neverComplete: true }, /等待超时.*actions\/runs\/42/],
    [{ wrongSha: true }, /工作流源提交不一致/]
  ]) {
    const sample = dispatchFixture(options);
    await assert.rejects(sample.actions.dispatch(version, commit), message);
    assert.equal(sample.calls.filter(call => call.url.endsWith("/dispatches")).length, 1);
    assert.ok(!sample.calls.some(call => call.url.includes("/releases/tags/")));
  }
});

test("tag creation races must resolve to the same source commit", async () => {
  let existing = false;
  const actions = new ActionsRelease(async (method, url) => {
    if (method === "POST") { existing = true; throw Object.assign(new Error("Already exists"), { status: 422 }); }
    if (url === api) return { permissions: { push: true } };
    if (url.includes("/contents/")) return { content: Buffer.from(JSON.stringify({ version })).toString("base64") };
    if (url.endsWith("/releases/latest")) throw notFound();
    if (!existing) throw notFound();
    return { object: { type: "commit", sha: "b".repeat(40) } };
  });
  await assert.rejects(actions.ensureTag(version, commit), /不会自动覆盖标签/);
});

function artifactFixture({ available = true, wrongWorkflow = false, attachments = [] } = {}) {
  const artifact = { id: 7, name: `release-v${version}-${commit}`, expired: !available, workflow_run: { id: 42, head_sha: commit } };
  return new ActionsRelease(async (_method, url) => {
    if (url.includes("/actions/artifacts?")) return { artifacts: [
      { ...artifact, id: 6, workflow_run: { id: 41, head_sha: "b".repeat(40) } }, artifact
    ] };
    if (url.endsWith("/actions/runs/42")) return { id: 42, head_sha: commit, event: "workflow_dispatch", path: wrongWorkflow ? ".github/workflows/other.yml" : ".github/workflows/release.yml", head_branch: `v${version}` };
    if (url.includes("/releases/tags/")) return { assets: attachments, draft: true };
    throw new Error(`Unexpected request: ${url}`);
  });
}

test("upload retries restore the exact source artifact and its original run ID", async () => {
  const artifact = await artifactFixture().reusableArtifact(version, commit);
  assert.deepEqual(artifact, { name: `release-v${version}-${commit}`, id: 7, runId: 42 });
});

test("missing/expired or unrelated artifacts cannot cause existing attachments to be rebuilt", async () => {
  for (const options of [{ available: false }, { wrongWorkflow: true }]) {
    await assert.rejects(artifactFixture({ ...options, attachments: [{ name: "installer" }] }).reusableArtifact(version, commit), /递增版本号/);
    assert.equal((await artifactFixture(options).reusableArtifact(version, commit)).id, "");
  }
});

test("Release upload accepts only the intended repository, tag, commit and Actions event", () => {
  const context = { version, commit };
  const env = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: REPOSITORY, GITHUB_SHA: commit, GITHUB_REF: `refs/tags/v${version}`, GITHUB_EVENT_NAME: "workflow_dispatch" };
  assert.doesNotThrow(() => assertActionsContext(context, env));
  for (const [key, value] of Object.entries({ GITHUB_ACTIONS: "false", GITHUB_REPOSITORY: "other/repo", GITHUB_SHA: "b".repeat(40), GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "pull_request" })) {
    assert.throws(() => assertActionsContext(context, { ...env, [key]: value }));
  }
});

test("workflow installation token preflight does not depend on user permissions metadata", async () => {
  const call = async (_method, url) => {
    if (url === api) return {};
    if (url.includes("/contents/")) return { content: Buffer.from(JSON.stringify({ version })).toString("base64") };
    if (url.endsWith("/releases/latest")) throw notFound();
    return { object: { type: "commit", sha: commit } };
  };
  await new GithubPublisher(call, { actionsToken: true }).preflight(version, commit);
  await assert.rejects(new GithubPublisher(call).preflight(version, commit), /发布权限/);
});
