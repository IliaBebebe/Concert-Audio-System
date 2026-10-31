const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const assets = path.join(__dirname, '..', 'assets');
const pngMagic = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

test('Windows ICO contains valid transparent PNG entries down to 16 px', () => {
  const ico = fs.readFileSync(path.join(assets, 'app-icon.ico'));
  assert.equal(ico.readUInt16LE(2), 1);
  const sizes = [];
  for (let i = 0; i < ico.readUInt16LE(4); i++) {
    const entry = 6 + 16 * i;
    const size = ico[entry] || 256;
    const length = ico.readUInt32LE(entry + 8);
    const start = ico.readUInt32LE(entry + 12);
    assert.ok(start + length <= ico.length);
    assert.deepEqual(ico.subarray(start, start + 8), pngMagic);
    assert.equal(ico.readUInt32BE(start + 16), size);
    sizes.push(size);
  }
  assert.deepEqual(sizes.sort((a, b) => a - b), [16, 24, 32, 48, 64, 128, 256]);
});

test('macOS ICNS has a valid chunk table and a 1024 px Retina representation', () => {
  const icns = fs.readFileSync(path.join(assets, 'app-icon.icns'));
  assert.equal(icns.toString('ascii', 0, 4), 'icns');
  assert.equal(icns.readUInt32BE(4), icns.length);
  const types = [];
  for (let offset = 8; offset < icns.length;) {
    const length = icns.readUInt32BE(offset + 4);
    assert.ok(length >= 8 && offset + length <= icns.length);
    types.push(icns.toString('ascii', offset, offset + 4));
    offset += length;
  }
  assert.ok(types.includes('ic10'));
});

test('Linux PNG sizes and runtime icon dimensions match packaging configuration', () => {
  for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
    const png = fs.readFileSync(path.join(assets, 'icons', `${size}x${size}.png`));
    assert.deepEqual(png.subarray(0, 8), pngMagic);
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
    assert.equal(png[25], 6, 'RGBA transparency');
  }
  const runtime = fs.readFileSync(path.join(assets, 'app-icon.png'));
  assert.equal(runtime.readUInt32BE(16), 512);
  const config = require('../package.json').build;
  assert.equal(config.mac.icon, 'assets/app-icon.icns');
  assert.equal(config.linux.icon, 'assets/icons');
  assert.ok(config.files.includes('assets/app-icon.png'));
});
