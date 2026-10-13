// Edit only packaged copies, never the development Electron runtime. The
// standalone Windows editor avoids winCodeSign's macOS symlink extraction.
const path = require('node:path');
const rcedit = require('rcedit');
const manifest = require('../package.json');

async function setExecutableIcon(executable) {
  await rcedit(path.resolve(executable), {
    icon: path.resolve(__dirname, '../assets/icon.ico'),
    'file-version': manifest.version,
    'product-version': manifest.version,
    'version-string': { ProductName: 'Codex Speed Pet', FileDescription: 'Codex Speed Pet' }
  });
}

module.exports = async context => {
  if (context.electronPlatformName === 'win32') {
    await setExecutableIcon(path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`));
  }
};

if (require.main === module) {
  const executable = process.argv[2];
  if (!executable) throw new Error('Pass the copied portable executable path.');
  setExecutableIcon(executable).catch(error => { console.error(error.message); process.exitCode = 1; });
}
