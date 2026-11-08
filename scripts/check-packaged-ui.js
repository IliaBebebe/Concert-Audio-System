const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const asar = require('@electron/asar');
const resources = process.platform === 'win32' ? 'release/win-unpacked/resources'
    : process.platform === 'darwin' ? 'release/mac-universal/Concert Audio System.app/Contents/Resources'
    : 'release/linux-unpacked/resources';
const archive = path.join(resources, 'app.asar');
const files = ['main.js', 'preload.js', 'index.html', 'renderer.js', 'workspaces.js', 'console.css', 'welcome.html', 'welcome.js', 'welcome.css',
    'assets/app-icon.png', 'assets/cas-logo-transparent.png', 'assets/fonts/manrope-regular.ttf', 'assets/fonts/manrope-bold.ttf', 'assets/fonts/Manrope-OFL.txt',
    'assets/lucide.min.js', 'remote-server.js', 'qr-generator.js', 'remote-client/index.html', 'remote-client/remote.js', 'remote-client/remote.css'];
for (const file of files) {
    assert.deepEqual(asar.extractFile(archive, path.normalize(file)), fs.readFileSync(file), `Packaged UI differs: ${file}`);
}
const packagedVersion = JSON.parse(asar.extractFile(archive, 'package.json').toString()).version;
assert.equal(packagedVersion, require('../package.json').version);
console.log(`Packaged interface ${packagedVersion}: ${files.length} files verified`);
