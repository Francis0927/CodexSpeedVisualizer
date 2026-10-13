const fs = require("node:fs/promises");
const { randomUUID } = require("node:crypto");
const { GithubPublisher, request, getToken, sourceContext, assertActionsContext, REPOSITORY } = require("./publish-github.cjs");

const WORKFLOW = "release.yml";
const API = `https://api.github.com/repos/${REPOSITORY}`;
const WORKFLOW_API = `${API}/actions/workflows/${WORKFLOW}`;
const ACTIONS_URL = `https://github.com/${REPOSITORY}/actions/workflows/${WORKFLOW}`;
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

class ActionsRelease {
  constructor(call, { sleep = delay, now = Date.now, log = console.log } = {}) {
    this.call = call; this.sleep = sleep; this.now = now; this.log = log;
  }

  async ensureTag(version, commit) {
    // preflight resolves annotated tags as well and rejects an existing mismatch.
    await new GithubPublisher(this.call).preflight(version, commit);
    try { await this.call("GET", `${API}/git/ref/tags/v${version}`); }
    catch (error) {
      if (error.status !== 404) throw error;
      try { await this.call("POST", `${API}/git/refs`, { json: { ref: `refs/tags/v${version}`, sha: commit } }); }
      catch (creation) {
        if (creation.status !== 422) throw creation;
        // Another caller may have created it; never replace a conflicting ref.
      }
    }
    await new GithubPublisher(this.call).preflight(version, commit);
  }

  async dispatch(version, commit, notes = "") {
    let workflow;
    try { workflow = await this.call("GET", WORKFLOW_API); }
    catch (error) {
      if (error.status === 404) throw new Error("未找到 Release workflow。请先将 .github/workflows/release.yml 提交并推送到 GitHub 默认分支，再运行发布命令。");
      throw error;
    }
    if (workflow.state !== "active" || workflow.path !== `.github/workflows/${WORKFLOW}`) throw new Error("Release workflow 不可用。请先将工作流提交并推送到默认分支，并启用 GitHub Actions。");
    // Verify the frozen commit includes the workflow before creating a tag.
    await this.call("GET", `${API}/contents/.github/workflows/${WORKFLOW}?ref=${commit}`);
    await this.ensureTag(version, commit);
    const requestId = randomUUID();
    const title = `Release v${version} (${requestId})`;
    const response = await this.call("POST", `${WORKFLOW_API}/dispatches`, { json: {
      ref: `v${version}`, inputs: { notes, request_id: requestId }
    } });
    this.log(`GitHub Actions 已触发 v${version}，源提交 ${commit.slice(0, 7)}：${ACTIONS_URL}`);
    // New API versions return a run ID. Older versions return HTTP 204; locate
    // only our unique run-name so simultaneous dispatches cannot be confused.
    const deadline = this.now() + 5 * 60 * 1000;
    let runId = response.workflow_run_id;
    while (!runId && this.now() < deadline) {
      const result = await this.call("GET", `${WORKFLOW_API}/runs?event=workflow_dispatch&head_sha=${commit}&per_page=100`);
      runId = result.workflow_runs.find(run => run.head_sha === commit && run.display_title === title)?.id;
      if (!runId) await this.sleep(10000);
    }
    if (!runId) throw new Error(`工作流已触发，但未能定位运行。请查看 ${ACTIONS_URL}；确认状态后再重试。`);
    const runUrl = `https://github.com/${REPOSITORY}/actions/runs/${runId}`;
    this.log(`构建与发布进度：${runUrl}`);
    const completionDeadline = this.now() + 60 * 60 * 1000;
    let lastStatus;
    while (this.now() < completionDeadline) {
      const run = await this.call("GET", `${API}/actions/runs/${runId}`);
      if (run.head_sha !== commit || run.event !== "workflow_dispatch") throw new Error(`工作流源提交不一致：${runUrl}`);
      if (run.status !== lastStatus) { this.log(`GitHub Actions: ${run.status}`); lastStatus = run.status; }
      if (run.status === "completed") {
        if (run.conclusion !== "success") throw new Error(`GitHub Actions ${run.conclusion}，发布未完成。已保存的产物和 Release 草稿保留，请检查失败步骤并重新运行：${runUrl}`);
        const release = await new GithubPublisher(this.call).findRelease(`v${version}`);
        if (!release || release.draft || release.prerelease) throw new Error(`工作流结束但正式 Release 尚未确认：${runUrl}`);
        this.log(`GitHub Release 已完成：${release.html_url}`);
        return release.html_url;
      }
      await this.sleep(20000);
    }
    throw new Error(`等待超时，工作流可能仍在运行；请先查看状态，勿重复发布：${runUrl}`);
  }

  async reusableArtifact(version, commit) {
    const name = `release-v${version}-${commit}`;
    const candidates = [];
    for (let page = 1; ; page++) {
      const result = await this.call("GET", `${API}/actions/artifacts?name=${encodeURIComponent(name)}&per_page=100&page=${page}`);
      candidates.push(...result.artifacts.filter(artifact => artifact.name === name && !artifact.expired && artifact.workflow_run?.head_sha === commit));
      if (result.artifacts.length < 100) break;
    }
    // Accept only artifacts produced by this release workflow at the exact tag.
    for (const artifact of candidates.sort((a, b) => a.id - b.id)) {
      const run = await this.call("GET", `${API}/actions/runs/${artifact.workflow_run.id}`);
      if (run.head_sha === commit && run.event === "workflow_dispatch" && run.path === `.github/workflows/${WORKFLOW}` && run.head_branch === `v${version}`) {
        return { name, id: artifact.id, runId: run.id };
      }
    }
    const release = await new GithubPublisher(this.call, { actionsToken: true }).findRelease(`v${version}`);
    if (release?.assets.length) throw new Error("该版本已有 Release 附件，但可复用的 Actions 产物已过期或不可用。保留现有附件；请递增版本号，禁止重新构建后覆盖。");
    return { name, id: "", runId: "" };
  }
}

async function main(args) {
  const { version, commit } = sourceContext();
  const token = getToken();
  const call = (...parameters) => request(token, ...parameters);
  const actions = new ActionsRelease(call);
  if (args.includes("--prepare")) {
    assertActionsContext({ version, commit });
    await new GithubPublisher(call, { actionsToken: true }).preflight(version, commit);
    const artifact = await actions.reusableArtifact(version, commit);
    if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is missing");
    await fs.appendFile(process.env.GITHUB_OUTPUT, `version=${version}\nartifact_name=${artifact.name}\nartifact_id=${artifact.id}\nartifact_run_id=${artifact.runId}\n`);
    console.log(artifact.id ? `复用已验证产物 ${artifact.id}` : `GitHub Actions 将构建 v${version}`);
    return;
  }
  try { await actions.dispatch(version, commit, process.env.RELEASE_NOTES || ""); }
  catch (error) {
    if ([401, 403].includes(error.status)) throw new Error(`GitHub 认证或权限不足；发布凭据需要 Contents 和 Actions 写权限。${error.message}`);
    throw error;
  }
}

module.exports = { ActionsRelease };
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
