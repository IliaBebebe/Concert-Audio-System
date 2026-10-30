const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

async function mainFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cas-main-test-'));
  const library = path.join(root, 'music');
  await fs.mkdir(library);
  await fs.writeFile(path.join(root, 'config.json'), JSON.stringify({ musicFolder: library, firstRun: false }));
  const handlers = new Map();
  const electron = {
    app: { getPath: () => root, requestSingleInstanceLock: () => false, quit() {}, on() {} },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) }
  };
  const project = path.resolve(__dirname, '..');
  const module = { exports: {} };
  const source = await fs.readFile(path.join(project, 'main.js'), 'utf8');
  vm.runInNewContext(source + `\nmodule.exports = { isPathInside, normalizeTrackMetadata,
    resolveMusicPath, readAudioFiles, getSafeFileDialogOptions, updateMusicFolder,
    loadConfig, isTrustedSender, parseMetadataInWorker };`, {
    require: name => name === 'electron' ? electron : require(name), __dirname: project,
    module, process: { platform: process.platform, argv: [], on() {} }, console, setTimeout, clearTimeout
  }, { filename: 'main.js' });
  t.after(async () => {
    assert.ok(root.startsWith(path.join(os.tmpdir(), 'cas-main-test-')));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { api: module.exports, root, library, handlers, project };
}

test('filesystem boundary rejects sibling directories with the same prefix', async t => {
  const { api, library } = await mainFixture(t);
  assert.equal(api.isPathInside(path.join(library, 'album', 'song.wav'), library), true);
  assert.equal(api.isPathInside(`${library}-private`, library), false);
  assert.equal(api.isPathInside(path.join(library, '..', 'secret.wav'), library), false);
});

test('resolved music paths reject traversal and junction escapes', async t => {
  const { api, library, root } = await mainFixture(t);
  const outside = path.join(root, 'private');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'secret.wav'), 'private');
  await fs.symlink(outside, path.join(library, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(api.resolveMusicPath(path.join(outside, 'secret.wav'), 'file'), /Доступ запрещён/);
  await assert.rejects(api.resolveMusicPath(path.join(library, 'escape', 'secret.wav'), 'file'), /Доступ запрещён/);
});

test('audio files are filtered and sorted naturally', async t => {
  const { api, library } = await mainFixture(t);
  await Promise.all(['10.wav', '2.MP3', '1.txt'].map(name => fs.writeFile(path.join(library, name), 'test')));
  const files = await api.readAudioFiles(library);
  assert.equal(files.map(file => file.filename).join(','), '2.MP3,10.wav');
});

test('metadata normalization constrains numeric fields and long text', async t => {
  const { api } = await mainFixture(t);
  const valid = api.normalizeTrackMetadata({ title: '  Intro  ', artist: 'x'.repeat(500), trackNumber: '12', startOffset: 1.23456 });
  assert.equal(valid.title, 'Intro');
  assert.equal(valid.artist.length, 200);
  assert.equal(valid.trackNumber, 12);
  assert.equal(valid.startOffset, 1.235);
  const invalid = api.normalizeTrackMetadata({ trackNumber: '-1', startOffset: Infinity });
  assert.equal(Object.keys(invalid).length, 0);
});

test('file dialog cannot request unsupported files or directory selection', async t => {
  const { api } = await mainFixture(t);
  const options = api.getSafeFileDialogOptions({ filters: [{ name: 'test', extensions: ['exe', '.MP3', '*'] }], properties: ['openDirectory', 'multiSelections'] });
  assert.equal(options.filters[0].extensions.join(','), 'mp3');
  assert.equal(options.properties.join(','), 'openFile');
});

test('all filesystem IPC handlers reject an unknown sender', async t => {
  const { handlers } = await mainFixture(t);
  for (const [name, handler] of handlers) {
    const result = await handler({ sender: {}, senderFrame: { url: 'https://example.com' } });
    if (name === 'get-config') assert.equal(result, null, name);
    else if (name === 'open-file-dialog') {
      assert.equal(result.canceled, true, name);
      assert.equal(result.filePaths.length, 0, name);
    } else assert.equal(result.success, false, name);
  }
});

test('trusted sender must belong to the expected app window and local app URL', async t => {
  const { api, project } = await mainFixture(t);
  const sender = { getURL: () => pathToFileURL(path.join(project, 'index.html')).href };
  const window = { isDestroyed: () => false, webContents: sender };
  assert.equal(api.isTrustedSender({ sender }, window), true);
  assert.equal(api.isTrustedSender({ sender, senderFrame: { url: 'https://example.com' } }, window), false);
  assert.equal(api.isTrustedSender({ sender: { getURL: sender.getURL } }, window), false);
});

test('changing the music folder clears metadata overrides for the previous library', async t => {
  const { api, root } = await mainFixture(t);
  const replacement = path.join(root, 'replacement');
  await fs.mkdir(replacement);
  await api.updateMusicFolder(replacement);
  const config = await api.loadConfig();
  assert.equal(config.musicFolder, await fs.realpath(replacement));
  assert.equal(config.firstRun, false);
  assert.equal(Object.keys(config.trackMetadataOverrides).length, 0);
});

test('metadata worker reads an actual WAV with the installed parser', async t => {
  const { api, library } = await mainFixture(t);
  const wav = Buffer.alloc(44 + 3200);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(3200, 40);
  const file = path.join(library, 'tone.wav');
  await fs.writeFile(file, wav);
  const metadata = await api.parseMetadataInWorker(file);
  assert.equal(metadata.title, null);
  assert.equal(metadata.artist, null);
});
