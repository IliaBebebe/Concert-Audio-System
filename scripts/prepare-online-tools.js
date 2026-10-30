// Pinned, hash-verified build dependencies. Never downloads executables at app runtime.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const manifest = require('./online-tools.json');

async function main() {
  const targets = process.platform === 'darwin' || process.argv.includes('--universal') ? ['darwin-x64', 'darwin-arm64'] : [`${process.platform}-${process.arch}`];
  for (const target of targets) {
    if (!manifest.targets[target]) throw new Error(`Unsupported target: ${target}`);
    const folder = path.resolve(__dirname, '..', 'tools', target);
    await fs.mkdir(folder, { recursive: true });
    const marker = JSON.stringify(manifest.targets[target]);
    if (await fs.readFile(path.join(folder, 'verified.json'), 'utf8').catch(() => '') === marker && await Promise.all(manifest.targets[target].map(a => fs.access(path.join(folder, a.file)).then(() => true, () => false))).then(values => values.every(Boolean))) continue;
    for (const asset of manifest.targets[target]) {
      const response = await fetch(asset.url, { signal: AbortSignal.timeout(180000) });
      if (!response.ok) throw new Error(`Download failed: ${response.status} ${asset.file}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (crypto.createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error(`Checksum mismatch: ${target}/${asset.file}`);
      const output = path.join(folder, asset.file);
      if (asset.archive === 'zip') {
        const zip = path.join(folder, 'runtime.zip');
        await fs.writeFile(zip, bytes);
        if (process.platform === 'win32') {
          const literal = value => "'" + value.replace(/'/g, "''") + "'";
          execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath ${literal(zip)} -DestinationPath ${literal(folder)} -Force`], { windowsHide: true });
        } else execFileSync('unzip', ['-o', zip, '-d', folder]);
        await fs.unlink(zip);
      } else await fs.writeFile(output, asset.archive === 'gz' ? zlib.gunzipSync(bytes) : bytes);
      await fs.chmod(output, 0o755);
      console.log(`Verified ${target}/${asset.file}`);
    }
    await fs.writeFile(path.join(folder, 'verified.json'), marker);
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
