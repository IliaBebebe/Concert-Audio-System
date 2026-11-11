const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { OnlineMusic, youtubeTarget, normalizeResult, runProcess } = require('../online-music');
const { TheatreSoundMixer, CASDeckManager } = require('../renderer');
const { CASOnlinePanel } = require('../online-ui');

test('a delayed saved library response cannot overwrite a newer search or clear its busy state', async t => {
  const oldDocument = global.document;
  const button = { disabled: false }, query = { value: 'new' };
  global.document = { getElementById: id => id === 'onlineSearchButton' ? button : query };
  t.after(() => { global.document = oldDocument; });
  let libraryReply, searchReply;
  const panel = Object.create(CASOnlinePanel.prototype);
  panel.searchGeneration = 0;
  panel.api = {
    getOnlineLibrary: () => new Promise(resolve => { libraryReply = resolve; }),
    searchOnline: () => new Promise(resolve => { searchReply = resolve; })
  };
  let busy = false;
  panel.results = { setAttribute: () => { busy = true; }, removeAttribute: () => { busy = false; } };
  panel.status = {};
  const rendered = [];
  panel.render = tracks => rendered.push(tracks);
  const library = panel.showLibrary();
  const search = panel.search();
  libraryReply({ success: true, data: [{ title: 'stale' }] });
  await library;
  assert.equal(rendered.length, 0);
  assert.equal(busy, true);
  assert.equal(button.disabled, true);
  searchReply({ success: true, data: [{ title: 'new' }] });
  await search;
  assert.equal(rendered[0][0].title, 'new');
  assert.equal(busy, false);
});

test('online query accepts only names or canonical single YouTube links', () => {
  assert.equal(youtubeTarget(' artist song '), 'ytsearch10:artist song');
  for (const url of ['https://youtu.be/aqz-KE-bpKQ?t=3', 'https://music.youtube.com/watch?v=aqz-KE-bpKQ', 'https://www.youtube.com/shorts/aqz-KE-bpKQ']) assert.equal(youtubeTarget(url), 'https://www.youtube.com/watch?v=aqz-KE-bpKQ');
  for (const url of ['file:///private', 'http://127.0.0.1/a', 'https://youtube.com.evil.org/watch?v=aqz-KE-bpKQ', 'https://youtube.com@evil.org/a', 'https://youtube.com:444/watch?v=aqz-KE-bpKQ', 'https://youtube.com/playlist?list=x', 'ytsearch9999:x']) assert.throws(() => youtubeTarget(url));
});

test('results reject live/long/invalid content and keep strings bounded', () => {
  assert.equal(normalizeResult({ id: 'invalid' }), null);
  assert.equal(normalizeResult({ id: 'aqz-KE-bpKQ', is_live: true }), null);
  assert.equal(normalizeResult({ id: 'aqz-KE-bpKQ', duration: 1801 }), null);
  assert.equal(normalizeResult({ id: 'aqz-KE-bpKQ', title: 'x'.repeat(400) }).title.length, 200);
});

async function fixture(t, run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cas-online-test-'));
  const service = new OnlineMusic({ root, toolsRoot: root, run });
  t.after(async () => { service.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  return { service, root };
}

test('download converts into atomic managed file, reuses cache, and rejects a symlink escape', async t => {
  let calls = 0;
  const { service, root } = await fixture(t, async (binary, args) => {
    calls++;
    if (binary.includes('yt-dlp')) {
      assert.ok(args.includes('--ignore-config'));
      assert.equal(args.at(-1), 'https://www.youtube.com/watch?v=aqz-KE-bpKQ');
      const folder = path.dirname(args[args.indexOf('-o') + 1]);
      await fs.writeFile(path.join(folder, 'audio.m4a'), Buffer.alloc(64));
      await fs.writeFile(path.join(folder, 'audio.info.json'), JSON.stringify({ id: 'aqz-KE-bpKQ', title: 'Test', duration: 10 }));
      return `CAS_FILE:${path.join(folder, 'audio.m4a')}\n`;
    }
    await fs.writeFile(args.at(-1), Buffer.alloc(64)); return '';
  });
  const stages = [];
  const track = await service.prepare('aqz-KE-bpKQ', p => stages.push(p.stage));
  assert.deepEqual(stages, ['queued', 'downloading', 'processing']);
  assert.equal(track.path, path.join(await fs.realpath(root), 'aqz-KE-bpKQ.m4a'));
  assert.equal((await service.list()).length, 1);
  await service.prepare('aqz-KE-bpKQ'); assert.equal(calls, 2);
  assert.equal(await service.resolve(path.join(root, '..', 'private.wav')), null);
  await fs.unlink(track.path);
  // Windows directory junctions exercise the same realpath escape without admin privileges.
  await fs.symlink(root, track.path, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await service.get('aqz-KE-bpKQ'), null);
});

test('failed download cleans partial files, queue recovers, and cancelled queued job never starts', async t => {
  let unblock;
  const gate = new Promise(resolve => { unblock = resolve; });
  let calls = 0;
  const { service, root } = await fixture(t, async () => { calls++; await gate; throw new Error('network'); });
  const first = service.prepare('aqz-KE-bpKQ');
  const second = service.prepare('YE7VzlLtp-4');
  const checks = [assert.rejects(first, /network/), assert.rejects(second, /отменена/)];
  service.cancel('YE7VzlLtp-4'); unblock();
  await Promise.all(checks);
  assert.equal(calls, 1);
  assert.equal((await fs.readdir(root)).length, 0);
  await assert.rejects(service.prepare('aqz-KE-bpKQ'), /network/);
  assert.equal(calls, 2);
});

test('process cancellation and timeout terminate an actual child', async () => {
  const controller = new AbortController();
  const task = runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal });
  controller.abort();
  await assert.rejects(task, /отменена/);
  await assert.rejects(runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 30 }), /вовремя/);
});

function mixerFixture() {
  const mixer = Object.create(TheatreSoundMixer.prototype);
  mixer.deckManager = new CASDeckManager();
  mixer.decks = mixer.deckManager.decks;
  mixer.playlistRequestId = { A: 0, B: 0 };
  for (const name of ['displayTracks', 'updateDeckUI', 'updateTrackCounter', 'saveStoredData']) mixer[name] = () => {};
  return mixer;
}

test('online insertion targets captured deck, rejects replaced playlist and superseded play request', () => {
  const mixer = mixerFixture();
  const track = { onlineId: 'aqz-KE-bpKQ', path: '/library/a.m4a' };
  const target = mixer.captureOnlineTarget('B');
  mixer.activeDeck = 'A';
  assert.equal(mixer.insertOnlineTrack(track, target), true);
  assert.equal(mixer.decks.A.tracks.length, 0);
  assert.equal(mixer.decks.B.tracks.length, 1);
  assert.equal(mixer.insertOnlineTrack(track, target), true);
  assert.equal(mixer.decks.B.tracks.length, 1);
  mixer.playlistRequestId.B++;
  assert.equal(mixer.insertOnlineTrack(track, target), false);
  const play = mixer.captureOnlineTarget('A', true);
  mixer.captureOnlineTarget('A', true);
  assert.equal(mixer.insertOnlineTrack(track, play, true), false);
});
