const test = require('node:test');
const assert = require('node:assert/strict');
const { TheatreSoundMixer } = require('../renderer');

function fixture(t) {
  const previousDocument = global.document;
  const previousWindow = global.window;
  const timers = new Map();
  let nextTimer = 1;
  let now = 0;
  const displays = new Map();
  const writes = [];
  for (const type of ['music', 'effects']) {
    displays.set(`${type}VuMeter`, {
      style: { setProperty: (name, value) => writes.push([type, name, value]) },
      dataset: {}, querySelector: () => ({ hidden: true })
    });
    displays.set(`${type}LevelValue`, { textContent: '' });
  }
  global.document = { hidden: false, getElementById: id => displays.get(id) || null, addEventListener() {} };
  global.window = { electronAPI: {} };
  t.mock.method(global, 'setInterval', callback => { const id = nextTimer++; timers.set(id, callback); return id; });
  t.mock.method(global, 'clearInterval', id => timers.delete(id));
  t.mock.method(performance, 'now', () => now);
  t.after(() => { global.document = previousDocument; global.window = previousWindow; });
  const mixer = Object.create(TheatreSoundMixer.prototype);
  Object.assign(mixer, { musicPlayer: null, isPlaying: false, isPaused: false,
    retiringMusicPlayers: new Set(), soundEffects: new Map(), vuMeterInterval: null,
    waveformRequestId: 0, waveformCache: new Map(), waveformPeaks: [] });
  return { mixer, timers, writes, setTime: value => { now = value; } };
}

test('idle startup creates neither an audio analyser nor a meter polling timer', t => {
  const { mixer, timers } = fixture(t);
  let analyserSetups = 0;
  mixer.setupAudioAnalysers = () => { analyserSetups++; };
  mixer.initVuMeters();
  assert.equal(analyserSetups, 0);
  assert.equal(timers.size, 0);
});

test('meters wake for music and effects, preserve peak decay, and stop when silent', t => {
  const { mixer, timers, setTime } = fixture(t);
  mixer.setupAudioAnalysers = () => {};
  mixer.connectHowlToAnalyser = () => {};
  mixer.initVuMeters();
  mixer.audioContext = { state: 'running' };
  mixer.meterChannels = {};
  for (const type of ['music', 'effects']) {
    mixer[`${type}AnalyserData`] = new Float32Array(4096);
    mixer.meterChannels[type] = [0, 1].map(() => ({ getFloatTimeDomainData: data => data.fill(0.5) }));
  }
  mixer.isPlaying = true;
  mixer.updateVuMeters();
  assert.equal(timers.size, 1);
  assert.ok(Math.abs(mixer.levelMeters.music.levelDb + 6.0206) < 0.001);
  mixer.updateVuMeters();
  assert.equal(timers.size, 1, 'one polling loop per mixer');
  mixer.isPaused = true;
  setTime(250);
  mixer.updateVuMeters();
  assert.equal(timers.size, 1, 'peak hold must complete after pausing');
  setTime(5000);
  mixer.updateVuMeters();
  assert.equal(timers.size, 0);
  mixer.soundEffects.set(0, { sound: { playing: () => true } });
  mixer.updateVuMeters();
  assert.equal(timers.size, 1, 'an effect restarts meters even while music is paused');
  assert.ok(mixer.levelMeters.effects.levelDb > -7);
});

test('unchanged meter readings do not repeat DOM style writes', t => {
  const { mixer, writes } = fixture(t);
  mixer.setupAudioAnalysers = () => {};
  mixer.initVuMeters();
  const reading = { level: 0.25, peak: 0.5, db: -45, clipping: false };
  mixer.renderLevelMeter('music', reading);
  const count = writes.length;
  mixer.renderLevelMeter('music', { ...reading });
  assert.equal(writes.length, count);
});

test('native window minimization stops visuals but keeps background crossfade tracking', t => {
  const { mixer } = fixture(t);
  let notify;
  window.electronAPI.onWindowVisibilityChange = callback => { notify = callback; return () => {}; };
  const calls = [];
  for (const name of ['pauseVuMeters', 'stopProgressTracking', 'startBackgroundCrossfadeTracking',
    'stopBackgroundCrossfadeTracking', 'startVuMeters', 'startProgressTracking']) mixer[name] = () => calls.push(name);
  mixer.isPlaying = true;
  mixer.setupVisibilityHandlers();
  assert.equal(typeof notify, 'function');
  notify(false);
  assert.equal(document.hidden, false, 'Chromium may remain visible with backgroundThrottling disabled');
  assert.equal(mixer.isVisualsHidden(), true);
  assert.deepEqual(calls, ['pauseVuMeters', 'stopProgressTracking', 'startBackgroundCrossfadeTracking']);
  calls.length = 0;
  notify(true);
  assert.equal(mixer.isVisualsHidden(), false);
  assert.deepEqual(calls, ['stopBackgroundCrossfadeTracking', 'startVuMeters', 'startProgressTracking']);
});

test('visual progress is capped at 20 Hz while crossfade checks keep their cadence', t => {
  const { mixer } = fixture(t);
  let pending;
  let nextId = 1;
  const previousRaf = global.requestAnimationFrame;
  const previousCancel = global.cancelAnimationFrame;
  global.requestAnimationFrame = callback => { pending = callback; return nextId++; };
  global.cancelAnimationFrame = () => {};
  t.after(() => { global.requestAnimationFrame = previousRaf; global.cancelAnimationFrame = previousCancel; });
  mixer.musicPlayer = { seek: () => 1, duration: () => 60 };
  mixer.musicPlayerToken = 1;
  mixer.isPlaying = true;
  let paints = 0;
  let crossfadeChecks = 0;
  mixer.updateWaveformProgress = () => { paints++; };
  mixer.maybeStartAutomaticCrossfade = () => { crossfadeChecks++; };
  mixer.updateTimeDisplays = () => {};
  mixer.startProgressTracking();
  for (let timestamp = 0; timestamp < 150; timestamp += 10) pending(timestamp);
  assert.equal(paints, 3);
  assert.equal(crossfadeChecks, 15);
});

test('waveforms decode one at a time and discard superseded queued tracks before reading', async t => {
  const { mixer } = fixture(t);
  const reads = [];
  const inputs = new Map();
  const decodes = [];
  const releases = [];
  window.electronAPI.getAudioFileBuffer = async file => {
    reads.push(file);
    const data = new ArrayBuffer(8);
    inputs.set(file, data);
    return { success: true, data };
  };
  mixer.getWaveformAudioContext = () => ({ decodeAudioData: data => {
    decodes.push(data);
    return new Promise(resolve => releases.push(resolve));
  } });
  mixer.createWaveformPeaks = buffer => [buffer.peak];
  for (const name of ['clearWaveform', 'drawWaveform', 'setWaveformState', 'updateWaveformProgress']) mixer[name] = () => {};
  const first = mixer.loadWaveformForTrack({ path: 'A' });
  await new Promise(resolve => setImmediate(resolve));
  const second = mixer.loadWaveformForTrack({ path: 'B' });
  const third = mixer.loadWaveformForTrack({ path: 'C' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(reads, ['A']);
  assert.equal(decodes[0], inputs.get('A'), 'decode the owned IPC buffer without duplicating it');
  releases[0]({ peak: 0.1 });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(reads, ['A', 'C']);
  releases[1]({ peak: 0.9 });
  await Promise.all([first, second, third]);
  assert.deepEqual(mixer.waveformPeaks, [0.9]);
  assert.equal(mixer.waveformLoadTask, null);
});
