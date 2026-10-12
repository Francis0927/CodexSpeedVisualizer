const fs = require("node:fs");
const path = require("node:path");
const asar = require("@electron/asar");

function readVersion(directory) {
  for (const relative of ["resources/app/package.json", "resources/app.asar", "win-unpacked/resources/app.asar", "package.json"]) {
    const file = path.join(directory, relative);
    if (!fs.existsSync(file)) continue;
    try {
      const bytes = file.endsWith(".asar") ? asar.extractFile(file, "package.json") : fs.readFileSync(file);
      const version = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, "")).version;
      if (/^\d+\.\d+\.\d+$/.test(version)) return version;
    } catch { /* An incomplete build is not evidence of a specific version. */ }
  }
  return "";
}
module.exports = { readVersion };
if (require.main === module) console.log(readVersion(path.resolve(process.argv[2])));
