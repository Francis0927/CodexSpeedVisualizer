const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const https = require("node:https");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { compareVersions, releaseVersion } = require("../electron/github-update.cjs");

const REPOSITORY = "Francis0927/CodexSpeedVisualizer";
const ROOT = path.resolve(__dirname, "..");

function getToken() {
  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) return process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  // Capture credentials in memory. Never echo helper output or invoke a shell.
  // With multiple saved accounts GCM needs a username to avoid an interactive
  // account picker. Try the repository owner before the generic host lookup.
  for (const account of [REPOSITORY.split("/")[0], null]) {
    const result = spawnSync("git", ["-c", "credential.interactive=false", "credential", "fill"], {
      cwd: ROOT, encoding: "utf8", input: `protocol=https\nhost=github.com\n${account ? `username=${account}\n` : ""}\n`,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" }, windowsHide: true, timeout: 15000
    });
    const password = result.status === 0 && result.stdout.split(/\r?\n/).find(line => line.startsWith("password="));
    if (password) return password.slice("password=".length);
  }
  throw new Error("未找到 GitHub 凭据。请配置 Git 凭据管理器，或设置 GH_TOKEN / GITHUB_TOKEN（触发发布需要仓库 Contents 和 Actions 写权限）。");
}

function request(token, method, url, { json, file } = {}) {
  const target = new URL(url);
  if (target.protocol !== "https:" || !["api.github.com", "uploads.github.com"].includes(target.hostname)) throw new Error("Unexpected GitHub API host");
  const body = json === undefined ? null : Buffer.from(JSON.stringify(json));
  const headers = { Authorization: `Bearer ${token}`, "User-Agent": "Codex-Speed-Pet-publisher", Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  if (body) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = body.length; }
  if (file) { headers["Content-Type"] = "application/octet-stream"; headers["Content-Length"] = fs.statSync(file).size; }
  return new Promise((resolve, reject) => {
    const req = https.request(target, { method, headers }, response => {
      const chunks = []; let length = 0;
      response.on("data", chunk => {
        length += chunk.length;
        if (length > 8 * 1024 * 1024) response.destroy(new Error("GitHub metadata response is too large"));
        else chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => {
        let value;
        try { value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
        catch { reject(new Error(`GitHub returned invalid metadata (HTTP ${response.statusCode})`)); return; }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const error = new Error(`GitHub API HTTP ${response.statusCode}: ${value.message || "request failed"}`);
          error.status = response.statusCode; reject(error);
        } else resolve(value);
      });
    });
    req.setTimeout(10 * 60 * 1000, () => req.destroy(new Error("GitHub request timed out")));
    req.on("error", reject);
    if (file) { const stream = fs.createReadStream(file); stream.on("error", error => req.destroy(error)); stream.pipe(req); }
    else req.end(body);
  });
}

async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function matches(remote, local) {
  return remote.state === "uploaded" && remote.size === local.size && remote.digest?.toLowerCase() === `sha256:${local.sha256}`;
}

class GithubPublisher {
  constructor(call, { actionsToken = false } = {}) { this.call = call; this.api = `https://api.github.com/repos/${REPOSITORY}`; this.actionsToken = actionsToken; }

  async preflight(version, commit) {
    const repo = await this.call("GET", this.api);
    // Installation tokens (including GITHUB_TOKEN) do not expose user permissions.
    // The workflow declares contents: write; the API enforces that permission.
    if (!this.actionsToken && !repo.permissions?.push && !repo.permissions?.admin && !repo.permissions?.maintain) throw new Error("GitHub 凭据没有该仓库的 Release 发布权限。");
    const file = await this.call("GET", `${this.api}/contents/package.json?ref=${encodeURIComponent(commit)}`);
    const remotePackage = JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));
    if (remotePackage.version !== version) throw new Error("该版本的代码提交尚未在 GitHub。请先提交并推送版本代码，再发布。");
    try {
      const latest = await this.call("GET", `${this.api}/releases/latest`);
      if (compareVersions(version, releaseVersion(latest)) < 0) throw new Error("发布版本低于 GitHub 当前正式版本，不会回退更新渠道。");
    } catch (error) { if (error.status !== 404) throw error; }
    let ref;
    try { ref = await this.call("GET", `${this.api}/git/ref/tags/v${version}`); }
    catch (error) { if (error.status === 404) return; throw error; }
    let object = ref.object;
    for (let depth = 0; object.type === "tag" && depth < 8; depth++) {
      object = (await this.call("GET", `${this.api}/git/tags/${object.sha}`)).object;
    }
    if (object.type !== "commit" || object.sha !== commit) throw new Error("现有版本标签指向其他提交，不会自动覆盖标签。");
  }

  async findRelease(tag) {
    try { return await this.call("GET", `${this.api}/releases/tags/${encodeURIComponent(tag)}`); }
    catch (error) { if (error.status !== 404) throw error; }
    // The tag endpoint may not return an unpublished draft. Include drafts so
    // interrupted uploads can resume without creating duplicate releases.
    for (let page = 1; ; page++) {
      const releases = await this.call("GET", `${this.api}/releases?per_page=100&page=${page}`);
      const found = releases.find(release => release.tag_name === tag);
      if (found) return found;
      if (releases.length < 100) return null;
    }
  }

  async publish(version, commit, assets, notes = "") {
    const tag = `v${version}`;
    let release = await this.findRelease(tag);
    if (!release) release = await this.call("POST", `${this.api}/releases`, { json: {
      tag_name: tag, target_commitish: commit, name: `Codex Drive ${version}`, draft: true, prerelease: false,
      body: `${notes}${notes ? "\n\n" : ""}安装版与便携版均支持从 GitHub 检查、下载并更新。旧内网版及旧无更新地址版需手动升级一次。SHA256SUMS.txt 提供校验值。`
    } });
    if (release.draft && release.target_commitish !== commit) throw new Error("现有草稿指向其他源提交，不会自动改写或公开它。");
    if (release.prerelease) throw new Error("目标 Release 是预发布版本，不会作为正式更新发布。");
    const expected = new Set(assets.map(asset => asset.name));
    if (release.assets.some(asset => !expected.has(asset.name))) throw new Error("目标 Release 含有其他附件，请核对后再发布；不会自动删除或覆盖它们。");
    const existing = new Map(release.assets.map(asset => [asset.name, asset]));
    for (const asset of assets) {
      let remote = existing.get(asset.name);
      if (remote) {
        if (!matches(remote, asset)) throw new Error(`已有同名附件校验不一致，不覆盖：${asset.name}`);
        continue;
      }
      if (!release.draft) throw new Error("已公开的 Release 缺少附件，不会自动改写；请检查版本和已发布内容。");
      const upload = new URL(release.upload_url.replace(/\{.*\}$/, ""));
      if (upload.hostname !== "uploads.github.com") throw new Error("Unexpected GitHub asset upload host");
      upload.searchParams.set("name", asset.name);
      remote = await this.call("POST", upload.toString(), { file: asset.file });
      if (!matches(remote, asset)) throw new Error(`上传附件 SHA-256/大小校验失败，Release 保留草稿：${asset.name}`);
    }
    // Re-read server metadata, not just upload responses, before publishing.
    const checked = await this.call("GET", `${this.api}/releases/${release.id}`);
    for (const asset of assets) {
      if (!checked.assets.some(remote => remote.name === asset.name && matches(remote, asset))) throw new Error("GitHub Release 附件最终校验失败；不会公开草稿。");
    }
    if (checked.draft) release = await this.call("PATCH", `${this.api}/releases/${release.id}`, { json: { draft: false, make_latest: "true" } });
    else release = checked;
    return release.html_url;
  }
}

async function localAssets(version, commit) {
  const directory = path.join(ROOT, `release/github-${version}`);
  const index = JSON.parse(await fsp.readFile(path.join(directory, "verified-assets.json"), "utf8"));
  const names = [`Codex-Speed-Pet-Setup-${version}.exe`, `Codex-Speed-Pet-portable-${version}.zip`, "SHA256SUMS.txt", "README.txt"];
  if (index.version !== version || index.assets.length !== names.length || new Set(index.assets.map(asset => asset.name)).size !== names.length) throw new Error("Release asset index mismatch");
  if (commit && index.sourceCommit !== commit) throw new Error("Release artifacts were built from a different source commit");
  const assets = [];
  for (const name of names) {
    const expected = index.assets.find(asset => asset.name === name);
    if (!expected) throw new Error("Only verified GitHub release assets may be uploaded");
    const file = path.join(directory, name);
    const stat = await fsp.stat(file);
    if (stat.size !== expected.size || await hashFile(file) !== expected.sha256) throw new Error(`Local asset checksum mismatch: ${name}`);
    assets.push({ ...expected, file });
  }
  await require("./verify-release.cjs").verifyRelease(path.join(directory, "win-unpacked/resources/app.asar"), version);
  return assets;
}

function sourceContext() {
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Invalid release version");
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8", windowsHide: true });
  const commit = head.stdout?.trim();
  if (head.status !== 0 || !/^[a-f0-9]{40}$/.test(commit)) throw new Error("Cannot identify the source commit");
  const dirty = spawnSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8", windowsHide: true });
  if (dirty.status !== 0 || dirty.stdout.trim()) throw new Error("发布前必须提交所有修改；构建代码必须与 GitHub 源提交一致。");
  return { version, commit };
}

function assertActionsContext({ version, commit }, env = process.env) {
  if (env.GITHUB_ACTIONS !== "true" || env.GITHUB_REPOSITORY !== REPOSITORY || env.GITHUB_SHA !== commit || env.GITHUB_REF !== `refs/tags/v${version}` || env.GITHUB_EVENT_NAME !== "workflow_dispatch") {
    throw new Error("Release 上传必须在对应版本标签的 GitHub Actions 中执行；请使用 npm run publish:github。");
  }
}

async function main(args) {
  const context = sourceContext();
  assertActionsContext(context);
  const { version, commit } = context;
  const token = getToken();
  const publisher = new GithubPublisher((...parameters) => request(token, ...parameters), { actionsToken: true });
  await publisher.preflight(version, commit);
  if (args.includes("--preflight")) {
    console.log(`GitHub Releases preflight passed: ${REPOSITORY}, v${version}, source ${commit.slice(0, 7)}`);
    return;
  }
  const url = await publisher.publish(version, commit, await localAssets(version, commit), process.env.RELEASE_NOTES || "");
  console.log(`GitHub release published and verified: ${url}`);
}

module.exports = { GithubPublisher, matches, request, getToken, sourceContext, assertActionsContext, localAssets, REPOSITORY, ROOT };
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
