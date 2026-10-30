const test = require('node:test');
const assert = require('node:assert/strict');
const { CASDeckManager, TheatreSoundMixer } = require('../renderer.js');

function mixerFixture(t) {
  const previousDocument = global.document;
  const previousWindow = global.window;
  const previousHowl = global.Howl;
  global.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
  global.window = { electronAPI: {} };
  const players = [];
  global.Howl = class {
    constructor(options) { this.options = options; this.position = 0; this.level = options.volume; players.push(this); }
    play() { this.started = true; return 1; }
    playing() { return Boolean(this.started); }
    duration() { return 60; }
    seek(value) { if (value !== undefined) this.position = value; return this.position; }
    volume(value) { if (value !== undefined) this.level = value; return this.level; }
    fade(from, to, ms) { this.faded = { from, to, ms }; }
    stop() { this.started = false; }
    unload() { this.unloaded = true; }
  };
  const mixer = Object.create(TheatreSoundMixer.prototype);
  Object.assign(mixer, {
    deckManager: new CASDeckManager(), musicPlayer: null, musicPlayerToken: 0,
    isPlaying: false, isPaused: false, pendingMusicStart: false, musicVolume: 0.7,
    crossfadeEnabled: true, deckCrossfadeEnabled: true, crossfadeDuration: 3,
    crossfadeTimers: new Set(), retiringMusicPlayers: new Set(), playbackMode: 'sequential',
    playlistRequestId: { A: 0, B: 0 }, trackLoadGeneration: { A: 0, B: 0 },
    soundEffects: new Map(), padLabels: new Map(), trackMetadataTasks: new WeakMap()
  });
  mixer.decks = mixer.deckManager.decks;
  for (const id of ['A', 'B']) {
    mixer.decks[id].playlist = { name: id, path: id };
    mixer.decks[id].tracks = [0, 1].map(i => ({ path: `${id}${i}.wav`, title: `${id}${i}` }));
  }
  for (const method of ['updateDeckUI', 'updatePlaylistSelection', 'updateTrackCounter',
    'updateCurrentTrackDisplay', 'updateMediaSessionMetadata', 'highlightCurrentTrack',
    'loadWaveformForTrack', 'stopProgressTracking', 'startProgressTracking', 'updateVuMeters',
    'resumeAudioContext', 'connectHowlToAnalyser', 'saveStoredData', 'displayTracks',
    'updateWaveformProgress', 'updateTimeDisplays']) mixer[method] = () => {};
  mixer.updateStatus = message => { mixer.status = message; };
  t.after(() => {
    mixer.crossfadeTimers.forEach(clearTimeout);
    clearTimeout(mixer.musicRetryTimeout);
    clearTimeout(mixer.musicVolumeTimeout);
    global.document = previousDocument;
    global.window = previousWindow;
    global.Howl = previousHowl;
  });
  return { mixer, players };
}

test('playing a cued track reuses its player and preserves seek position', t => {
  const { mixer, players } = mixerFixture(t);
  mixer.loadTrack(0, { deckId: 'A' });
  mixer.musicPlayer.seek(12);
  mixer.playMusic();
  assert.equal(players.length, 1);
  assert.equal(mixer.musicPlayer.seek(), 12);
});

test('searching the target deck does not change the playing deck filter', t => {
  const { mixer } = mixerFixture(t);
  mixer.playingDeck = 'A';
  mixer.activeDeck = 'B';
  mixer.decks.A.filterQuery = 'keep';
  mixer.filterTracksInDeck('B', 'signal');
  assert.equal(mixer.decks.A.filterQuery, 'keep');
  assert.equal(mixer.decks.B.filterQuery, 'signal');
});

test('selecting another target deck preserves the playing deck filter', t => {
  const { mixer } = mixerFixture(t);
  mixer.playingDeck = 'A';
  mixer.isPlaying = true;
  mixer.decks.A.filterQuery = 'keep';
  mixer.decks.B.filterQuery = 'other';
  mixer.setActiveDeck('B');
  assert.equal(mixer.decks.A.filterQuery, 'keep');
});

test('playlist response belongs to the requested deck even if target changes while loading', async t => {
  const { mixer } = mixerFixture(t);
  const originalB = mixer.decks.B.tracks;
  let respond;
  window.electronAPI.getPlaylistTracks = () => new Promise(resolve => { respond = resolve; });
  const pending = mixer.loadPlaylist({ name: 'new A', path: 'new A' }, 'A');
  mixer.activeDeck = 'B';
  respond({ success: true, data: [{ path: 'new.wav' }] });
  await pending;
  assert.equal(mixer.decks.B.tracks, originalB);
  assert.equal(mixer.decks.B.playlist.name, 'B');
  assert.equal(mixer.decks.A.tracks[0].path, 'new.wav');
});

test('crossfade keeps outgoing audio until incoming playback actually starts', t => {
  const { mixer } = mixerFixture(t);
  mixer.loadTrack(0, { deckId: 'A' });
  const outgoing = mixer.musicPlayer;
  outgoing.started = true;
  mixer.playingDeck = 'A';
  mixer.isPlaying = true;
  mixer.startCrossfadeTo('B', 0);
  assert.equal(outgoing.faded, undefined);
  const incoming = mixer.musicPlayer;
  incoming.options.onplay();
  assert.equal(outgoing.faded.to, 0);
  assert.equal(incoming.faded.to, 0.7);
});

test('Tab and Shift+Tab remain available for native focus navigation', t => {
  const { mixer } = mixerFixture(t);
  let prevented = false;
  mixer.handleHotkeys({ code: 'Tab', target: { tagName: 'BUTTON' }, preventDefault: () => { prevented = true; } });
  assert.equal(prevented, false);
  assert.equal(mixer.activeDeck, 'A');
});

test('invalid track selection does not stop current audio', t => {
  const { mixer } = mixerFixture(t);
  mixer.loadTrack(0, { deckId: 'A' });
  const player = mixer.musicPlayer;
  mixer.playTrackInDeck('B', 99);
  assert.equal(mixer.musicPlayer, player);
  assert.equal(mixer.activeDeck, 'A');
});

test('switching a stopped cue loads the target file before seeking', t => {
  const { mixer } = mixerFixture(t);
  mixer.loadTrack(0, { deckId: 'A' });
  const original = mixer.musicPlayer;
  mixer.setActiveDeck('B');
  assert.equal(original.unloaded, true);
  assert.equal(mixer.musicPlayerDeck, 'B');
  mixer.seekMusic(50);
  assert.equal(mixer.musicPlayer.seek(), 30);
  mixer.playMusic();
  assert.equal(mixer.musicPlayer.seek(), 30);
});

test('failed crossfade restores outgoing playback and blocks repeated automatic retries', t => {
  const { mixer } = mixerFixture(t);
  mixer.loadTrack(0, { deckId: 'A' });
  const outgoing = mixer.musicPlayer;
  outgoing.started = true;
  mixer.isPlaying = true;
  mixer.playingDeck = 'A';
  const originalToken = mixer.musicPlayerToken;
  mixer.startCrossfadeTo('B', 0);
  const incoming = mixer.musicPlayer;
  incoming.options.onloaderror();
  assert.equal(mixer.musicPlayer, outgoing);
  assert.equal(mixer.musicPlayerToken, originalToken);
  assert.equal(mixer.playingDeck, 'A');
  assert.equal(mixer.isPlaying, true);
  assert.equal(mixer.retiringMusicPlayers.size, 0);
  assert.equal(incoming.unloaded, true);
  mixer.startCrossfadeTo = () => assert.fail('failed automatic crossfade should not repeat');
  mixer.maybeStartAutomaticCrossfade(outgoing, originalToken, 59, 60);
});

test('same-deck crossfade failure restores the outgoing track index', t => {
  const { mixer } = mixerFixture(t);
  mixer.loadTrack(0, { deckId: 'A' });
  const outgoing = mixer.musicPlayer;
  outgoing.started = true;
  mixer.isPlaying = true;
  mixer.playingDeck = 'A';
  mixer.startCrossfadeTo('A', 1);
  mixer.musicPlayer.options.onplayerror();
  assert.equal(mixer.musicPlayer, outgoing);
  assert.equal(mixer.decks.A.currentTrackIndex, 0);
});

test('silent outgoing audio never jumps back to master volume during fade', t => {
  const { mixer } = mixerFixture(t);
  mixer.loadTrack(0, { deckId: 'A' });
  const outgoing = mixer.musicPlayer;
  outgoing.volume(0);
  mixer.fadeOutAndUnloadMusicPlayer(outgoing, 500);
  assert.equal(outgoing.faded.from, 0);
});

test('master volume changes preserve the remaining outgoing fade', async t => {
  const { mixer } = mixerFixture(t);
  mixer.loadTrack(0, { deckId: 'A' });
  const outgoing = mixer.musicPlayer;
  mixer.fadeOutAndUnloadMusicPlayer(outgoing, 1000);
  mixer.musicPlayer = null;
  mixer.setMusicVolume(0.2);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(outgoing.faded.from, 0.2);
  assert.equal(outgoing.faded.to, 0);
  assert.ok(outgoing.faded.ms > 0 && outgoing.faded.ms < 1000);
});

test('stale playlist responses cannot overwrite a later request', async t => {
  const { mixer } = mixerFixture(t);
  const pendingResponses = [];
  window.electronAPI.getPlaylistTracks = () => new Promise(resolve => pendingResponses.push(resolve));
  const first = mixer.loadPlaylist({ name: 'old', path: 'old' }, 'A');
  const second = mixer.loadPlaylist({ name: 'new', path: 'new' }, 'A');
  pendingResponses[1]({ success: true, data: [{ path: 'new.wav' }] });
  await second;
  pendingResponses[0]({ success: true, data: [{ path: 'old.wav' }] });
  await first;
  assert.equal(mixer.decks.A.playlist.path, 'new');
});

test('editing an invalid deck never writes metadata for another deck', async t => {
  const { mixer } = mixerFixture(t);
  window.electronAPI.saveTrackMetadata = () => assert.fail('unexpected write');
  window.electronAPI.clearTrackMetadata = () => assert.fail('unexpected write');
  assert.equal(await mixer.saveTrackMetadata('C', 0, { title: 'wrong' }), false);
  assert.equal(await mixer.clearTrackMetadata('C', 0), false);
});

test('space on a focused button is left for native activation', t => {
  const { mixer } = mixerFixture(t);
  mixer.playMusic = () => assert.fail('global play shortcut must not run');
  mixer.handleHotkeys({ code: 'Space', target: { tagName: 'BUTTON', closest: () => ({}) },
    preventDefault: () => assert.fail('native button activation must remain available') });
});

test('Shift+B changes target deck without interrupting current playback', t => {
  const { mixer } = mixerFixture(t);
  mixer.loadTrack(0, { deckId: 'A' });
  const player = mixer.musicPlayer;
  mixer.isPlaying = true;
  mixer.playingDeck = 'A';
  mixer.handleHotkeys({ code: 'KeyB', shiftKey: true, target: { tagName: 'BODY' }, preventDefault() {} });
  assert.equal(mixer.activeDeck, 'B');
  assert.equal(mixer.musicPlayer, player);
  assert.equal(mixer.playingDeck, 'A');
});

test('changing target while a file is starting does not cancel its pending playback', t => {
  const { mixer } = mixerFixture(t);
  mixer.loadTrack(0, { deckId: 'A' });
  const player = mixer.musicPlayer;
  mixer.playMusic();
  assert.equal(mixer.pendingMusicStart, true);
  mixer.setActiveDeck('B');
  mixer.playMusic();
  assert.equal(mixer.musicPlayer, player);
  assert.equal(mixer.musicPlayerDeck, 'A');
  assert.equal(mixer.pendingMusicStart, true);
});

test('deck order and selected tracks restore without starting playback', async t => {
  const { mixer } = mixerFixture(t);
  const previousStorage = global.localStorage;
  const data = { musicFolder: 'music', activeDeck: 'B', decks: {
    A: { playlist: { path: 'A' }, trackOrder: ['A1.wav', 'A0.wav'], currentTrackPath: 'A0.wav' },
    B: { playlist: { path: 'B' }, trackOrder: ['B0.wav', 'B1.wav'], currentTrackPath: 'B1.wav' }
  } };
  global.localStorage = { getItem: () => JSON.stringify(data) };
  t.after(() => { global.localStorage = previousStorage; });
  mixer.config = { musicFolder: 'music' };
  mixer.updateCrossfadeControls = () => {};
  window.electronAPI.getPlaylistTracks = async path => ({ success: true, data: [0, 1].map(i => ({ path: `${path}${i}.wav` })) });
  await mixer.loadStoredData();
  assert.deepEqual(mixer.decks.A.tracks.map(track => track.path), ['A1.wav', 'A0.wav']);
  assert.equal(mixer.decks.A.currentTrackIndex, 1);
  assert.equal(mixer.decks.B.currentTrackIndex, 1);
  assert.equal(mixer.activeDeck, 'B');
  assert.equal(mixer.isPlaying, false);
  assert.equal(mixer.musicPlayerDeck, 'B');
});
