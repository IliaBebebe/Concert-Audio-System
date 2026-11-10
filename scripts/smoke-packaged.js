// Native CI smoke test of the actual Electron executable, using a disposable profile.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');

async function waitFor(check, label, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check().catch(() => false);
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cas-native-smoke-'));
  const profile = path.join(root, 'profile');
  const library = path.join(root, 'music');
  const playlist = path.join(library, 'Playlist');
  await fs.mkdir(profile, { recursive: true });
  await fs.mkdir(playlist, { recursive: true });
  const wav = Buffer.alloc(44 + 16000 * 12 * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  for (let i = 44; i < wav.length; i += 2) wav.writeInt16LE(Math.round(1000 * Math.sin(i / 2 * 2 * Math.PI * 440 / 16000)), i);
  const files = ['01 Проверка # 100%.wav', '02 Finale.wav'];
  for (const name of files) await fs.writeFile(path.join(playlist, name), wav);
  await fs.writeFile(path.join(profile, 'config.json'), JSON.stringify({ musicFolder: library, firstRun: false,
    trackMetadataOverrides: { [`Playlist/${files[0]}`]: { title: 'Native start marker', startOffset: 3.5 } } }));
  const savedDeck = { playlist: { name: 'Playlist', path: playlist }, trackOrder: files.map(name => path.join(playlist, name)), currentTrackPath: path.join(playlist, files[0]) };
  const seed = { musicFolder: library, musicVolume: .42, effectsVolume: .36, activeDeck: 'A', viewMode: 'split',
    decks: { A: savedDeck, B: savedDeck }, soundEffects: [{ index: 0, name: 'Native pad', path: path.join(playlist, files[1]) }] };
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const executable = process.argv.includes('--source') ? require('electron')
    : process.platform === 'win32' ? path.resolve('release/win-unpacked/Concert Audio System.exe')
    : process.platform === 'darwin' ? path.resolve('release/mac-universal/Concert Audio System.app/Contents/MacOS/Concert Audio System')
    : path.resolve('release/linux-unpacked/theatre-sound-mixer');
  const args = process.argv.includes('--source') ? [path.resolve('.')] : [];
  args.push(`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--mute-audio');
  if (process.platform === 'linux' && process.env.CI) args.push('--no-sandbox');
  const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '', socket, nextId = 0;
  const pending = new Map();
  child.stdout.on('data', bytes => { logs = (logs + bytes).slice(-5000); });
  child.stderr.on('data', bytes => { logs = (logs + bytes).slice(-5000); });
  child.on('error', error => { logs += error.message; });
  try {
    const target = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page' && t.url.endsWith('/index.html')), 'app window');
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id); clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    });
    const call = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 60000);
      pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async expression => {
      const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    await waitFor(() => evaluate(`window.soundMixer?.startupState === 'ready' && document.readyState === 'complete'`), 'first navigation');
    await call('Page.enable');
    // Seed only the first reload; later reloads exercise the application's own persistence.
    await call('Page.addScriptToEvaluateOnNewDocument', { source: `
      window.__smokeNavigation = Math.random();
      window.__smokeErrors = [];
      addEventListener('error', e => window.__smokeErrors.push(e.message));
      addEventListener('unhandledrejection', e => window.__smokeErrors.push(String(e.reason)));
      if (!sessionStorage.getItem('casSmokeSeeded')) {
        localStorage.setItem('theatreSoundMixer', ${JSON.stringify(JSON.stringify(seed))});
        sessionStorage.setItem('casSmokeSeeded', 'true');
      }
      addEventListener('DOMContentLoaded', () => {
        window.__initiallyCovered = document.body.classList.contains('app-starting') && document.getElementById('appShell').inert;
      });` });
    await call('Page.reload');
    await waitFor(() => evaluate(`window.__initiallyCovered && window.soundMixer?.startupState === 'ready'`), 'restored workspace');
    const state = await evaluate(`({ platform: window.electronAPI.platform, arch: window.electronAPI.arch, coveredInitially: window.__initiallyCovered,
      hidden: document.getElementById('startupScreen').hidden, inert: document.getElementById('appShell').inert,
      tracks: ['A','B'].map(id => window.soundMixer.decks[id].tracks.map(t => ({loaded:t.metadataLoaded,duration:t.duration,start:t.startOffset}))),
      badges: [...document.querySelectorAll('.track-start-badge')].map(e => e.checkVisibility()),
      search: [...document.querySelectorAll('.track-search')].map(e => {const a=e.querySelector('input').getBoundingClientRect(),b=e.querySelector('svg').getBoundingClientRect(); return b.left>=a.left&&b.right<=a.right&&b.top>=a.top&&b.bottom<=a.bottom;}),
      volumes:[window.soundMixer.musicVolume,window.soundMixer.effectsVolume], pads:document.querySelectorAll('.sound-pad').length, errors:window.__smokeErrors })`);
    assert.equal(state.platform, process.platform);
    assert.equal(state.arch, process.arch);
    assert.equal(state.coveredInitially, true); assert.equal(state.hidden, true); assert.equal(state.inert, false);
    assert.deepEqual(state.tracks.map(ts => ts.length), [2, 2]);
    assert.ok(state.tracks.flat().every(t => t.loaded && t.duration === 12));
    assert.ok(state.badges.length === 2 && state.badges.every(Boolean));
    assert.ok(state.search.every(Boolean)); assert.deepEqual(state.volumes, [.42, .36]);
    assert.equal(state.pads, 12); assert.deepEqual(state.errors, []);
    await evaluate(`window.soundMixer.playTrackInDeck('A',0); true`);
    await waitFor(() => evaluate(`window.soundMixer.musicPlayer?.playing() && window.soundMixer.musicPlayer.seek() >= 3.5`), 'native audio playback from cue');
    await evaluate(`window.soundMixer.pauseMusic();window.soundMixer.playSoundEffect(0);true`);
    await waitFor(() => evaluate(`window.soundMixer.soundEffects.get(0)?.sound?.playing()`), 'native pad playback');
    await evaluate(`window.soundMixer.stopAllEffects();window.soundMixer.stopMusic();window.soundMixer.saveStoredDataImmediate();true`);
    const previousNavigation = await evaluate('window.__smokeNavigation');
    await call('Page.reload');
    await waitFor(() => evaluate(`window.__smokeNavigation !== ${previousNavigation} && window.soundMixer?.startupState === 'ready'`), 'second startup');
    assert.equal(await evaluate(`window.soundMixer.isPlaying`), false);
    assert.deepEqual(await evaluate(`window.__smokeErrors`), []);
    await evaluate(`window.electronAPI.windowControl('close')`);
    console.log(`Native packaged smoke passed: ${process.platform}/${process.arch}; startup, both decks, cues, Unicode paths, audio, pads, restart`);
  } catch (error) {
    console.error(logs);
    throw error;
  } finally {
    socket?.close();
    for (const item of pending.values()) clearTimeout(item.timer);
    if (child.exitCode === null) child.kill();
    await waitFor(async () => child.exitCode !== null || child.signalCode !== null, 'test process exit', 10000);
    assert.ok(root.startsWith(path.join(os.tmpdir(), 'cas-native-smoke-')));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
