const path = require('node:path');
const { execFileSync } = require('node:child_process');
const folder = path.resolve(process.argv[2] || path.join(__dirname, '..', 'tools'), `${process.platform}-${process.arch}`);
for (const [name, args] of [['yt-dlp', ['--version']], ['deno', ['--version']], ['ffmpeg', ['-version']]]) {
  const version = execFileSync(path.join(folder, name + (process.platform === 'win32' ? '.exe' : '')), args, { windowsHide: true, encoding: 'utf8', timeout: 30000 }).split(/\r?\n/)[0];
  console.log(`${name}: ${version}`);
}
