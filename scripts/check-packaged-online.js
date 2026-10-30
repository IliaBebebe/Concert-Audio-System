const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const manifest = require('./online-tools.json');
const resources = process.platform === 'win32' ? 'release/win-unpacked/resources'
  : process.platform === 'darwin' ? 'release/mac-universal/Concert Audio System.app/Contents/Resources'
  : 'release/linux-unpacked/resources';
const toolsRoot = path.resolve(resources, 'online-tools');
const targets = process.platform === 'darwin' ? ['darwin-x64', 'darwin-arm64'] : [`${process.platform}-${process.arch}`];
for (const target of targets) {
  for (const asset of manifest.targets[target]) {
    if (!fs.statSync(path.join(toolsRoot, target, asset.file)).size) throw new Error(`Empty packaged resource: ${target}/${asset.file}`);
  }
  console.log(`Packaged resources complete: ${target}`);
}
execFileSync(process.execPath, [path.join(__dirname, 'check-online-tools.js'), toolsRoot], { stdio: 'inherit' });
