const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const assetsDirectory = path.join(projectRoot, 'assets');

function copyFile(source, destination) {
  if (!fs.existsSync(source)) {
    return;
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function copyDirectory(source, destination) {
  if (!fs.existsSync(source)) {
    return;
  }
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true });
}

copyFile(
  path.join(projectRoot, 'node_modules', 'howler', 'dist', 'howler.min.js'),
  path.join(assetsDirectory, 'howler.min.js')
);

const fontAwesomeDirectory = path.join(projectRoot, 'node_modules', '@fortawesome', 'fontawesome-free');
copyFile(
  path.join(fontAwesomeDirectory, 'css', 'all.min.css'),
  path.join(assetsDirectory, 'fontawesome', 'css', 'all.min.css')
);
copyDirectory(
  path.join(fontAwesomeDirectory, 'webfonts'),
  path.join(assetsDirectory, 'fontawesome', 'webfonts')
);

console.log('Runtime assets copied to assets/.');
