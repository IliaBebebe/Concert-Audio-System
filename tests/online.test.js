const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { OnlineMusic, youtubeTarget, onlineTarget, normalizeResult, runProcess, sourceError, trackSource } = require('../online-music');
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
  panel.source = 'all';
  for (const method of ['setView', 'showWarnings', 'renderLoading', 'updateSummary']) panel[method] = () => {};
  panel.api = {
    getOnlineLibrary: () => new Promise(resolve => { libraryReply = resolve; }),
    searchOnline: () => new Promise(resolve => { searchReply = resolve; })
  };
  let busy = false;
  panel.results = { setAttribute: () => { busy = true; }, removeAttribute: () => { busy = false; } };
  panel.status = { classList: { toggle() {} } };
  const rendered = [];
  panel.render = tracks => rendered.push(tracks);
  const library = panel.showLibrary();
  const search = panel.search();
  libraryReply({ success: true, data: [{ title: 'stale' }] });
  await library;
  assert.equal(rendered.length, 0);
  assert.equal(busy, true);
  assert.equal(button.textContent, 'Отмена');
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

test('provider links are canonical, auto-detected, and cannot target arbitrary sites or playlists', () => {
  assert.deepEqual(onlineTarget('soundcloud.com/scottholmesmusic/together-we-stand?utm_source=test', 'youtube'), { source: 'soundcloud', target: 'https://soundcloud.com/scottholmesmusic/together-we-stand' });
  assert.deepEqual(onlineTarget('https://music.yandex.ru/album/540508/track/4878838?from=copy'), { source: 'yandex', target: '4878838' });
  assert.deepEqual(onlineTarget('https://music.yandex.com/track/4878838'), { source: 'yandex', target: '4878838' });
  assert.deepEqual(onlineTarget(' artist song ', 'soundcloud'), { source: 'soundcloud', query: 'artist song' });
  for (const query of ['https://soundcloud.com.evil.org/a/b', 'https://music.yandex.ru@evil.org/track/123', 'https://api.music.yandex.net/tracks/123', 'https://soundcloud.com/a/sets/b', 'https://soundcloud.com/a/tracks', 'https://soundcloud.com/a', 'https://music.yandex.ru/album/123', 'https://music.yandex.ru:444/track/123', 'https://127.0.0.1/a.mp3', '//localhost/a', 'scsearch999:query']) assert.throws(() => onlineTarget(query), query);
  assert.throws(() => onlineTarget('song', '__proto__'));
});

test('provider IDs stay separate from legacy YouTube IDs and unsafe metadata is discarded', () => {
  assert.equal(trackSource('soundcloud-'), 'youtube');
  assert.equal(trackSource('soundcloud-123'), 'soundcloud');
  assert.equal(trackSource('yandexmusic-123'), 'yandex');
  for (const id of ['../anything', 'soundcloud-1/../file', 'unknown-source-123', 12345678901]) assert.throws(() => trackSource(id));
  const soundcloud = normalizeResult({ id: '123', title: 'Song', webpage_url: 'https://soundcloud.com/artist/song' }, 'soundcloud');
  assert.equal(soundcloud.onlineId, 'soundcloud-123');
  assert.equal(normalizeResult({ id: '123' }, 'yandex').onlineId, 'yandexmusic-123');
  assert.equal(normalizeResult({ id: '123', webpage_url: 'https://evil.org/song' }, 'soundcloud'), null);
  assert.equal(normalizeResult({ id: '../file', webpage_url: 'https://soundcloud.com/artist/song' }, 'soundcloud'), null);
});

test('a failed provider preserves results from the others, with their source and a warning', async t => {
  const { service } = await fixture(t, async (_binary, _args, { source }) => {
    if (source === 'youtube') throw new Error('Too many requests');
    return JSON.stringify({ entries: [{ id: '123', title: 'SC', webpage_url: 'https://soundcloud.com/artist/song' }] });
  }, { request: async () => ({ result: { tracks: { results: [{ id: 123, title: 'YM', artists: [{ name: 'Artist' }], durationMs: 10000 }, { id: 456, available: false }] } } }) });
  const result = await service.search({ query: 'song', source: 'all' });
  assert.deepEqual(result.tracks.map(track => track.onlineId), ['soundcloud-123', 'yandexmusic-123']);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].source, 'youtube');
  assert.equal(result.tracks[1].artist, 'Artist');
});

test('a newer search aborts the old processes without overwriting the new results', async t => {
  let previousSignal;
  const { service } = await fixture(t, (_binary, _args, { signal }) => new Promise((_resolve, reject) => {
    previousSignal = signal;
    signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  }), { request: async () => ({ result: { tracks: { results: [{ id: 12, title: 'Latest' }] } } }) });
  const first = service.search({ query: 'old', source: 'soundcloud' });
  const oldCheck = assert.rejects(first, /Поиск отменён/);
  const second = await service.search({ query: 'new', source: 'yandex' });
  await oldCheck;
  assert.equal(previousSignal.aborted, true);
  assert.equal(second.tracks[0].title, 'Latest');
  assert.equal(service.knownTracks.has('yandexmusic-12'), true);
});

test('source errors distinguish access restrictions, rate limits, missing audio and disk space', () => {
  assert.match(sourceError('HTTP 403', 'soundcloud'), /^SoundCloud:/);
  assert.match(sourceError('HTTP 429', 'yandex'), /слишком много запросов/);
  assert.match(sourceError('not available', 'youtube'), /недоступен/);
  assert.match(sourceError('ENOSPC', 'soundcloud'), /места на диске/);
  assert.doesNotMatch(sourceError('network error', 'soundcloud'), /YouTube/);
});

async function fixture(t, run, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cas-online-test-'));
  const service = new OnlineMusic({ root, toolsRoot: root, run, ...options });
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

test('SoundCloud imports restore from disk with source metadata and resolve through the managed boundary', async t => {
  const { service, root } = await fixture(t, async (binary, args) => {
    if (binary.includes('yt-dlp')) {
      const folder = path.dirname(args[args.indexOf('-o') + 1]);
      await fs.writeFile(path.join(folder, 'audio.mp3'), Buffer.alloc(64));
      await fs.writeFile(path.join(folder, 'audio.info.json'), JSON.stringify({ id: '123', title: 'SoundCloud song', artist: 'Artist', duration: 120, webpage_url: 'https://soundcloud.com/artist/song' }));
      return `CAS_FILE:${path.join(folder, 'audio.mp3')}\n`;
    }
    await fs.writeFile(args.at(-1), Buffer.alloc(64));
    return 'out_time_us=120000000\n';
  });
  const track = await service.prepare('soundcloud-123');
  assert.equal(track.source, 'soundcloud');
  const restored = new OnlineMusic({ root, toolsRoot: root });
  t.after(() => restored.dispose());
  assert.equal((await restored.list())[0].onlineId, 'soundcloud-123');
  assert.equal((await restored.resolve(track.path)).sourceUrl, 'https://soundcloud.com/artist/song');
  assert.equal(await restored.resolve(path.join(root, '..', 'soundcloud-123.m4a')), null);
  await restored.remove(track.onlineId);
  assert.deepEqual(await service.list(), []);
});

test('Yandex previews never reach the downloader or library', async t => {
  let downloads = 0;
  const { service, root } = await fixture(t, async () => { downloads++; }, {
    request: async url => ({ result: url.endsWith('/download-info') ? [{ codec: 'mp3', preview: true, downloadInfoUrl: 'https://example.org/preview' }] : [{ id: '123', title: 'Song', durationMs: 180000 }] })
  });
  await assert.rejects(service.prepare('yandexmusic-123'), /не предоставила полную запись/);
  assert.equal(downloads, 0);
  assert.deepEqual(await fs.readdir(root), []);
});

test('Yandex full recordings use validated provider addresses and restore with the same ID', async t => {
  const { service } = await fixture(t, async (binary, args) => {
    if (binary.includes('yt-dlp')) {
      assert.match(args.at(-1), /^https:\/\/test\.storage\.yandex\.net\/get-mp3\/[a-f0-9]{32}\/123\/audio\.mp3$/);
      const file = args[args.indexOf('-o') + 1]; await fs.writeFile(file, Buffer.alloc(64));
      return `CAS_FILE:${file}\n`;
    }
    await fs.writeFile(args.at(-1), Buffer.alloc(64)); return 'out_time_us=120000000\n';
  }, { request: async url => {
    if (url.endsWith('/download-info')) return { result: [{ codec: 'mp3', preview: false, downloadInfoUrl: 'https://test.storage.yandex.net/info', bitrateInKbps: 192 }] };
    if (url.includes('storage.yandex.net')) return { host: 'test.storage.yandex.net', path: '/audio.mp3', ts: '123', s: 'salt' };
    return { result: [{ id: '123', title: 'Full song', durationMs: 120000 }] };
  } });
  const track = await service.prepare('yandexmusic-123');
  assert.equal(track.source, 'yandex');
  assert.equal((await service.list())[0].onlineId, 'yandexmusic-123');
});

test('an untrusted Yandex media address is rejected before making a request or download', async t => {
  let requests = 0;
  const { service } = await fixture(t, async () => assert.fail('must not download'), { request: async url => {
    requests++;
    return { result: url.endsWith('/download-info') ? [{ codec: 'mp3', preview: false, downloadInfoUrl: 'https://127.0.0.1/audio' }] : [{ id: '123', title: 'Song' }] };
  } });
  await assert.rejects(service.prepare('yandexmusic-123'), /неподдерживаемый адрес/);
  assert.equal(requests, 2);
});

test('a truncated recording is cleaned up even when its metadata claims the full duration', async t => {
  const { service, root } = await fixture(t, async (binary, args) => {
    if (binary.includes('yt-dlp')) {
      const folder = path.dirname(args[args.indexOf('-o') + 1]);
      await fs.writeFile(path.join(folder, 'audio.mp3'), Buffer.alloc(64));
      await fs.writeFile(path.join(folder, 'audio.info.json'), JSON.stringify({ id: '123', title: 'Song', duration: 180, webpage_url: 'https://soundcloud.com/artist/song' }));
      return `CAS_FILE:${path.join(folder, 'audio.mp3')}\n`;
    }
    await fs.writeFile(args.at(-1), Buffer.alloc(64)); return 'out_time_us=30000000\n';
  });
  await assert.rejects(service.prepare('soundcloud-123'), /неполную запись/);
  assert.deepEqual(await fs.readdir(root), []);
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
