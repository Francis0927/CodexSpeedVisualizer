const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const Module = require("node:module");
const asar = require("@electron/asar");

async function verifyRelease(archive, version, root = path.resolve(__dirname, "..")) {
  const names = asar.listPackage(archive).map(name => name.replace(/\\/g, "/"));
  assert.ok(!names.some(name => /(?:^|\/)update-share(?:\.example)?\.json$/i.test(name)), "Package contains a retired update configuration");
  assert.equal(JSON.parse(asar.extractFile(archive, "package.json")).version, version, "Package version mismatch");
  const config = path.join(root, "electron/update-share.json");
  let blocked = [];
  if (fs.existsSync(config)) {
    const share = JSON.parse(fs.readFileSync(config, "utf8").replace(/^\uFEFF/, "")).share;
    if (typeof share === "string" && share) blocked = [share, JSON.stringify(share).slice(1, -1)];
  }
  for (const name of names.filter(name => /\.(cjs|js|html|json|css|ps1)$/i.test(name))) {
    const text = asar.extractFile(archive, path.normalize(name.replace(/^\//, ""))).toString("utf8");
    assert.ok(!blocked.some(address => text.includes(address)), "Package contains a local update address");
    assert.ok(!text.includes("CODEX_SPEED_PET_UPDATE_SHARE"), "Package still supports the retired updater");
  }
  const cache = new Map();
  function load(name) {
    if (cache.has(name)) return cache.get(name).exports;
    const filename = path.join(root, "release/verification", name);
    const loaded = new Module(filename, module);
    loaded.filename = filename;
    loaded.paths = module.paths;
    cache.set(name, loaded);
    loaded.require = dependency => {
      if (dependency === "electron") return { app: { isPackaged: true, getVersion: () => version } };
      if (dependency.startsWith("./")) return load(path.posix.join(path.posix.dirname(name), dependency));
      return require(dependency);
    };
    loaded._compile(asar.extractFile(archive, path.normalize(name)).toString("utf8"), filename);
    return loaded.exports;
  }
  const github = load("electron/github-update.cjs");
  assert.equal(github.REPOSITORY, "Francis0927/CodexSpeedVisualizer");
  assert.equal(github.LATEST_URL, `https://api.github.com/repos/${github.REPOSITORY}/releases/latest`);
  // Exercise the shipped updater using a deterministic latest-release response.
  github.readText = async url => {
    assert.equal(url, github.LATEST_URL);
    return JSON.stringify({ tag_name: `v${version}`, draft: false, prerelease: false });
  };
  const updater = load("electron/update.cjs");
  assert.equal(updater.updateEnabled(), true, "Packaged GitHub updates must be enabled");
  assert.equal((await updater.checkForUpdate()).state, "latest", "Packaged updater must read the GitHub release feed");
  updater.stop();
  assert.ok(names.includes("/electron/portable-update.ps1"), "Portable update helper missing");
  return true;
}

module.exports = { verifyRelease };
if (require.main === module) verifyRelease(path.resolve(process.argv[2]), process.argv[3]).then(() => {
  console.log("Release archive verified: version, GitHub updates enabled, no private update configuration/address");
}).catch(error => { console.error(error.message); process.exitCode = 1; });
