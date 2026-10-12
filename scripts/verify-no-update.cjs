const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const Module = require("node:module");
const asar = require("@electron/asar");

async function verifyNoUpdate(archive, version, root = path.resolve(__dirname, "..")) {
  const names = asar.listPackage(archive).map(name => name.replace(/\\/g, "/"));
  assert.ok(!names.some(name => /(?:^|\/)update-share(?:\.example)?\.json$/i.test(name)), "Public package contains an update configuration");
  assert.equal(JSON.parse(asar.extractFile(archive, "package.json")).version, version, "Public package version mismatch");
  let blocked = [];
  const config = path.join(root, "electron/update-share.json");
  if (fs.existsSync(config)) {
    const share = JSON.parse(fs.readFileSync(config, "utf8").replace(/^\uFEFF/, "")).share;
    if (typeof share === "string" && share) blocked = [share, JSON.stringify(share).slice(1, -1)];
  }
  for (const name of names.filter(name => /\.(cjs|js|html|json|css)$/i.test(name))) {
    const text = asar.extractFile(archive, path.normalize(name.replace(/^\//, ""))).toString("utf8");
    assert.ok(!blocked.some(address => text.includes(address)), "Public package contains the local update address");
  }
  // Exercise the shipped updater with a packaged Electron stub and no manual
  // environment override. A missing config must disable all scheduled checks.
  const source = asar.extractFile(archive, path.join("electron", "update.cjs")).toString("utf8");
  const updaterModule = new Module(path.join(root, "release/no-update-verification/update.cjs"), module);
  updaterModule.filename = updaterModule.id;
  updaterModule.paths = module.paths;
  updaterModule.require = name => name === "electron" ? { app: { isPackaged: true } } : require(name);
  const override = process.env.CODEX_SPEED_PET_UPDATE_SHARE;
  delete process.env.CODEX_SPEED_PET_UPDATE_SHARE;
  try {
    updaterModule._compile(source, updaterModule.filename);
    const updater = updaterModule.exports;
    assert.equal(updater.updateEnabled(), false, "Default updater must be disabled");
    const statuses = [];
    updater.init({ onStatus: status => statuses.push(status) });
    assert.equal(statuses.length, 0, "Initialization must not start a background update");
    assert.equal((await updater.checkForUpdate()).state, "unsupported");
    updater.stop();
  } finally {
    if (override === undefined) delete process.env.CODEX_SPEED_PET_UPDATE_SHARE;
    else process.env.CODEX_SPEED_PET_UPDATE_SHARE = override;
  }
  return true;
}

module.exports = { verifyNoUpdate };
if (require.main === module) verifyNoUpdate(path.resolve(process.argv[2]), process.argv[3]).then(() => {
  console.log("No-update archive: configuration/address absent; version and disabled-update behavior verified");
}).catch(error => { console.error(error.message); process.exitCode = 1; });
