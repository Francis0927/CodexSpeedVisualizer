const { test } = require("node:test");
const assert = require("node:assert/strict");
const { GithubPublisher } = require("../scripts/publish-github.cjs");
const { verifyRelease } = require("./reference/verify-release.cjs");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const asar = require("@electron/asar");
const version = "1.2.3", commit = "a".repeat(40);
const assets = [
  { name: "Codex-Speed-Pet-Setup-1.2.3.exe", size: 10, sha256: "a".repeat(64), file: "installer" },
  { name: "Codex-Speed-Pet-portable-1.2.3.zip", size: 20, sha256: "b".repeat(64), file: "portable" }
];
function fixture({ release = null, badHash = false, failFile = null } = {}) {
  const calls = [];
  const call = async (method, url, options = {}) => {
    calls.push({ method, url, ...options });
    const parsed = new URL(url);
    if (method === "GET" && parsed.pathname.endsWith("/releases/tags/v1.2.3")) {
      if (release && !release.draft) return release;
      const error = new Error("Not found"); error.status = 404; throw error;
    }
    if (method === "GET" && parsed.pathname.endsWith("/releases")) return release ? [release] : [];
    if (method === "POST" && parsed.hostname === "api.github.com") {
      assert.equal(options.json.draft, true);
      assert.equal(options.json.target_commitish, commit);
      release = { id: 1, draft: true, target_commitish: commit, tag_name: "v1.2.3", assets: [], upload_url: "https://uploads.github.com/repos/owner/repo/releases/1/assets{?name,label}", html_url: "https://github.com/owner/repo/releases/tag/v1.2.3" };
      return release;
    }
    if (method === "POST" && parsed.hostname === "uploads.github.com") {
      if (options.file === failFile) throw new Error("Network failure");
      const local = assets.find(asset => asset.name === parsed.searchParams.get("name"));
      const remote = { name: local.name, state: "uploaded", size: local.size, digest: `sha256:${badHash ? "0".repeat(64) : local.sha256}` };
      release.assets.push(remote); return remote;
    }
    if (method === "GET" && parsed.pathname.endsWith("/releases/1")) return release;
    if (method === "PATCH") { release.draft = false; return release; }
    throw new Error(`Unexpected call: ${method} ${url}`);
  };
  return { publisher: new GithubPublisher(call), calls, release: () => release };
}

test("GitHub release stays a draft until every upload and final digest are verified", async () => {
  const sample = fixture();
  await sample.publisher.publish(version, commit, assets, "notes");
  assert.equal(sample.release().draft, false);
  const mutation = sample.calls.filter(call => ["POST", "PATCH"].includes(call.method));
  assert.equal(mutation[0].json.draft, true);
  assert.equal(mutation.at(-1).method, "PATCH");
  assert.equal(mutation.at(-1).json.make_latest, "true");
  assert.equal(mutation.filter(call => call.file).length, 2);
});

test("failed upload or incorrect SHA-256 never publishes the draft", async () => {
  for (const options of [{ badHash: true }, { failFile: "portable" }]) {
    const sample = fixture(options);
    await assert.rejects(sample.publisher.publish(version, commit, assets));
    assert.equal(sample.release().draft, true);
    assert.ok(!sample.calls.some(call => call.method === "PATCH"));
  }
});

test("interrupted drafts resume without uploading identical attachments again", async () => {
  const sample = fixture({ failFile: "portable" });
  await assert.rejects(sample.publisher.publish(version, commit, assets));
  const recovered = fixture({ release: sample.release() });
  await recovered.publisher.publish(version, commit, assets);
  assert.equal(recovered.calls.filter(call => call.file).length, 1);
  assert.equal(recovered.release().draft, false);
});

test("existing public releases are idempotent and conflicting attachment contents are not overwritten", async () => {
  const first = fixture();
  await first.publisher.publish(version, commit, assets);
  const repeated = fixture({ release: first.release() });
  await repeated.publisher.publish(version, commit, assets);
  assert.ok(!repeated.calls.some(call => ["POST", "PATCH"].includes(call.method)));
  first.release().assets[0].digest = `sha256:${"0".repeat(64)}`;
  const conflict = fixture({ release: first.release() });
  await assert.rejects(conflict.publisher.publish(version, commit, assets), /不覆盖/);
  assert.ok(!conflict.calls.some(call => ["POST", "PATCH"].includes(call.method)));
});

test("authentication errors never become new-release creation attempts", async () => {
  let writes = 0;
  const publisher = new GithubPublisher(async (method) => {
    if (method !== "GET") writes++;
    const error = new Error("Not authorized"); error.status = 403; throw error;
  });
  await assert.rejects(publisher.publish(version, commit, assets));
  assert.equal(writes, 0);
});

test("a draft pointing to different source code is not reused or made public", async () => {
  const first = fixture({ failFile: "portable" });
  await assert.rejects(first.publisher.publish(version, commit, assets));
  first.release().target_commitish = "b".repeat(40);
  const changed = fixture({ release: first.release() });
  await assert.rejects(changed.publisher.publish(version, commit, assets), /其他源提交/);
  assert.ok(!changed.calls.some(call => ["POST", "PATCH"].includes(call.method)));
});

test("preflight requires release permission, the pushed version and a matching existing tag", async () => {
  for (const bad of ["permission", "version", "tag"]) {
    const publisher = new GithubPublisher(async (method, url) => {
      assert.equal(method, "GET");
      if (url.endsWith("/CodexSpeedVisualizer")) return { permissions: { push: bad !== "permission" } };
      if (url.includes("/contents/")) return { content: Buffer.from(JSON.stringify({ version: bad === "version" ? "0.0.0" : version })).toString("base64") };
      if (url.endsWith("/releases/latest")) return { tag_name: "v1.2.2", draft: false, prerelease: false };
      return { object: { type: "commit", sha: bad === "tag" ? "b".repeat(40) : commit } };
    });
    await assert.rejects(publisher.preflight(version, commit));
  }
});

test("preflight allows first releases and matching retries, and rejects a version downgrade", async () => {
  for (const latest of [null, "1.2.3", "1.2.4"]) {
    const publisher = new GithubPublisher(async (_method, url) => {
      if (url.endsWith("/CodexSpeedVisualizer")) return { permissions: { push: true } };
      if (url.includes("/contents/")) return { content: Buffer.from(JSON.stringify({ version })).toString("base64") };
      if (url.endsWith("/releases/latest")) {
        if (!latest) { const error = Error("not found"); error.status = 404; throw error; }
        return { tag_name: `v${latest}`, draft: false, prerelease: false };
      }
      return { object: { type: "commit", sha: commit } };
    });
    if (latest === "1.2.4") await assert.rejects(publisher.preflight(version, commit), /回退/);
    else await publisher.preflight(version, commit);
  }
});

async function archiveFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "speed-pet-public-test-"));
  const source = path.join(root, "source");
  await fs.mkdir(path.join(source, "electron"), { recursive: true });
  await fs.writeFile(path.join(source, "package.json"), JSON.stringify({ version }));
  for (const name of ["update.cjs", "github-update.cjs", "portable-update.ps1"]) await fs.copyFile(path.resolve(__dirname, "./reference/electron", name), path.join(source, "electron", name));
  await fs.mkdir(path.join(source, "dist/assets"), { recursive: true });
  await fs.writeFile(path.join(source, "dist/assets/example.js"), "const example = true;");
  return { root, source, archive: path.join(root, "app.asar"), cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

test("public archive verification handles Windows paths and proves GitHub updates are enabled", async () => {
  const sample = await archiveFixture();
  try {
    await asar.createPackage(sample.source, sample.archive);
    assert.equal(await verifyRelease(sample.archive, version, sample.root), true);
  } finally { await sample.cleanup(); }
});

test("public archive verification rejects update configuration and embedded local addresses", async () => {
  for (const kind of ["config", "embedded-address"]) {
    const sample = await archiveFixture();
    try {
      if (kind === "config") await fs.writeFile(path.join(sample.source, "electron/update-share.json"), "{}");
      else {
        await fs.mkdir(path.join(sample.root, "electron"));
        await fs.writeFile(path.join(sample.root, "electron/update-share.json"), JSON.stringify({ share: "test-private-update-address" }));
        await fs.writeFile(path.join(sample.source, "address.json"), JSON.stringify({ value: "test-private-update-address" }));
      }
      await asar.createPackage(sample.source, sample.archive);
      await assert.rejects(verifyRelease(sample.archive, version, sample.root));
    } finally { await sample.cleanup(); }
  }
});
