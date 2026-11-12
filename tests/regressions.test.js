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

test('remote track selection rejects unknown decks and out-of-range indices', t => {
  const { mixer } = mixerFixture(t);
  let receiveCommand;
  const selected = [];
  global.window.electronAPI.onRemoteCommand = callback => { receiveCommand = callback; };
  mixer.setupRemoteControlDialog = () => {};
  mixer.refreshRemoteControlStatus = () => {};
  mixer.broadcastRemoteState = () => {};
  mixer.setActiveDeck = id => selected.push(id);
  mixer.playTrackInDeck = () => {};
  mixer.initRemoteControl();
  for (const command of [
    { deck: 'invalid', index: 0 }, { deck: 'A', index: -1 },
    { deck: 'B', index: 100 }, { deck: 'A', index: 0.5 }
  ]) receiveCommand({ action: 'selectTrack', autoplay: true, ...command });
  assert.deepEqual(selected, []);
  receiveCommand({ action: 'selectTrack', deck: 'B', index: 1, autoplay: true });
  assert.deepEqual(selected, ['B']);
});

test('remote snapshot includes lazy assigned pads and their full display names', t => {
  const { mixer } = mixerFixture(t);
  const name = 'A long effect name that should reach the phone intact';
  mixer.soundEffects.set(0, { path: 'effect.wav', name, sound: null });
  const state = mixer.getRemoteStateSnapshot();
  assert.equal(state.pads[0].isAssigned, true);
  assert.equal(state.pads[0].isPlaying, false);
  assert.equal(state.pads[0].name, name);
  assert.equal(state.pads[1].isAssigned, false);
});

test('remote idle updates run only while phones are connected', t => {
  const { mixer } = mixerFixture(t);
  let receiveCount;
  let snapshots = 0;
  global.window.electronAPI.onRemoteClientCount = callback => { receiveCount = callback; };
  mixer.setupRemoteControlDialog = () => {};
  mixer.refreshRemoteControlStatus = () => {};
  mixer.broadcastRemoteState = () => { snapshots++; };
  mixer.initRemoteControl();
  t.after(() => clearInterval(mixer.remoteStateInterval));
  assert.equal(mixer.remoteStateInterval, undefined);
  receiveCount(1);
  const timer = mixer.remoteStateInterval;
  assert.ok(timer);
  assert.equal(snapshots, 1);
  receiveCount(2);
  assert.equal(mixer.remoteStateInterval, timer);
  receiveCount(0);
  assert.equal(mixer.remoteStateInterval, null);
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

test('metadata refresh updates every duplicate in both decks, including filtered-out tracks', t => {
  const { mixer } = mixerFixture(t);
  const source = { path: 'shared.wav', title: 'Edited', artist: 'Artist', trackNumber: 7,
    startOffset: 5.5, metadataOverride: { title: 'Edited', startOffset: 5.5 } };
  const duplicates = Array.from({ length: 3 }, () => ({ path: source.path, title: 'Old', startOffset: 1 }));
  mixer.decks.A.tracks = [source, duplicates[0], duplicates[1]];
  mixer.decks.B.tracks = [duplicates[2]];
  mixer.updateTrackRowDetails(source);
  for (const track of duplicates) {
    assert.equal(track.title, 'Edited');
    assert.equal(track.startOffset, 5.5);
    assert.equal(track.trackNumber, 7);
    assert.deepEqual(track.metadataOverride, source.metadataOverride);
  }
  source.startOffset = 0;
  source.trackNumber = null;
  source.metadataOverride = {};
  mixer.updateTrackRowDetails(source);
  for (const track of duplicates) {
    assert.equal(track.startOffset, 0);
    assert.equal(track.trackNumber, null);
    assert.deepEqual(track.metadataOverride, {});
  }
});

test('clearing a manual track number restores queue numbering in every visible row', t => {
  const { mixer } = mixerFixture(t);
  const source = { path: 'shared.wav', title: 'Title', trackNumber: null };
  mixer.decks.A.tracks = [source, { ...source }];
  mixer.decks.B.tracks = [{ path: 'other.wav' }, { ...source }];
  const numbers = new Map();
  document.querySelector = selector => ({ querySelector: field => {
    if (field !== '.track-num-text') return null;
    const number = { textContent: '99' };
    numbers.set(selector, number);
    return number;
  } });
  mixer.updateTrackRowDetails(source);
  assert.equal(numbers.get('#tracksContainerA .track-row[data-index="0"]').textContent, '1');
  assert.equal(numbers.get('#tracksContainerA .track-row[data-index="1"]').textContent, '2');
  assert.equal(numbers.get('#tracksContainerB .track-row[data-index="1"]').textContent, '2');
});

test('space on a focused button is left for native activation', t => {
  const { mixer } = mixerFixture(t);
  mixer.playMusic = () => assert.fail('global play shortcut must not run');
  mixer.handleHotkeys({ code: 'Space', target: { tagName: 'BUTTON', closest: () => ({}) },
    preventDefault: () => assert.fail('native button activation must remain available') });
});

test('Space opens a focused details summary without toggling music', t => {
  const { mixer } = mixerFixture(t);
  let played = false;
  mixer.playMusic = () => { played = true; };
  mixer.handleHotkeys({ code: 'Space', target: { tagName: 'SUMMARY', closest: selector => selector.includes('summary') ? {} : null },
    preventDefault() { throw new Error('Native summary activation must stay available'); } });
  assert.equal(played, false);
});

test('resizing with the main workspace hidden keeps finite panel proportions', t => {
  const { mixer } = mixerFixture(t);
  let boxWidth = 1400;
  const values = new Map();
  const listeners = new Map();
  const container = { getBoundingClientRect: () => ({ width: boxWidth }), style: { setProperty: (name, value) => values.set(name, value) } };
  document.querySelector = selector => selector === '.app-container' ? container : null;
  window.innerWidth = 1400;
  window.addEventListener = (name, handler) => listeners.set(name, handler);
  mixer.setupBlockHeightPersistence = () => {};
  mixer.setupResizers();
  boxWidth = 0;
  window.innerWidth = 1000;
  listeners.get('resize')();
  for (const value of values.values()) assert.ok(Number.isFinite(parseFloat(value)) && parseFloat(value) > 0);
  boxWidth = 1000;
  listeners.get('resize')();
  const total = [...values.values()].reduce((sum, value) => sum + parseFloat(value), 0);
  assert.ok(total <= 63, 'side panels must leave room for the center at the minimum window size');
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

test('transferred queues restore exact contents across folders, including an emptied source deck', async t => {
  const { mixer } = mixerFixture(t);
  const previousStorage = global.localStorage;
  let stored;
  global.localStorage = { setItem: (_key, value) => { stored = value; }, getItem: () => stored };
  t.after(() => { global.localStorage = previousStorage; });
  mixer.config = { musicFolder: '/music' };
  mixer.updateCrossfadeControls = () => {};
  const folderA = [{ path: '/music/A/0.wav' }, { path: '/music/A/1.wav' }];
  const folderB = [{ path: '/music/B/0.wav' }];
  mixer.decks.A.playlist = { path: '/music/A', name: 'A' };
  mixer.decks.A.tracks = [...folderA];
  mixer.decks.B.playlist = { path: '/music/B', name: 'B' };
  mixer.decks.B.tracks = [...folderB];
  mixer.moveTrackBetweenDecks('A', 1, 'B');
  mixer.moveTrackBetweenDecks('A', 0, 'B');
  // Keep a repeated cue too; restoration must not deduplicate deliberate repeats.
  mixer.decks.B.tracks.push(folderA[1]);
  mixer._writeStoredData();
  assert.equal(JSON.parse(stored).decks.A.customQueue, true);
  mixer.deckManager.reset();
  window.electronAPI.getPlaylistTracks = async folder => ({ success: true, data:
    folder === '/music/A/' ? [...folderA, { path: '/music/A/new.wav' }] : folderB });
  await mixer.loadStoredData();
  assert.deepEqual(mixer.decks.A.tracks, []);
  assert.deepEqual(mixer.decks.B.tracks.map(track => track.path),
    ['/music/B/0.wav', '/music/A/1.wav', '/music/A/0.wav', '/music/A/1.wav']);
  assert.equal(mixer.isPlaying, false);
  await mixer.loadPlaylist({ path: '/music/A/', name: 'A' }, 'A');
  assert.equal(mixer.decks.A.customQueue, false);
  assert.equal(mixer.decks.A.tracks.length, 3);
});

test('panel widths shrink and grow with the window while preserving preferred proportions', t => {
  const { mixer } = mixerFixture(t);
  const normal = mixer.getResponsivePanelWidths(1400);
  const narrow = mixer.getResponsivePanelWidths(1000);
  const wide = mixer.getResponsivePanelWidths(1800);
  assert.ok(Math.abs(normal.leftWidth - 360) < 0.001);
  assert.ok(Math.abs(normal.rightWidth - 340) < 0.001);
  assert.ok(narrow.leftWidth < normal.leftWidth && narrow.rightWidth < normal.rightWidth);
  assert.ok(wide.leftWidth > normal.leftWidth && wide.rightWidth > normal.rightWidth);
  assert.ok(narrow.leftWidth + narrow.rightWidth + 360 + 12 <= 1000);
});

test('mixed and online-only decks restore imported IDs in saved order without autoplay', async t => {
  const { mixer } = mixerFixture(t);
  const previousStorage = global.localStorage;
  const data = { musicFolder: 'music', activeDeck: 'B', decks: {
    A: { playlist: { path: 'A' }, trackOrder: ['online.m4a', 'A0.wav'], onlineTrackIds: ['aqz-KE-bpKQ'], currentTrackPath: 'online.m4a' },
    B: { playlist: { name: 'Моя очередь', path: null }, trackOrder: ['online.m4a'], onlineTrackIds: ['aqz-KE-bpKQ'], currentTrackPath: 'online.m4a' }
  } };
  global.localStorage = { getItem: () => JSON.stringify(data) };
  t.after(() => { global.localStorage = previousStorage; });
  mixer.config = { musicFolder: 'music' };
  mixer.updateCrossfadeControls = () => {};
  window.electronAPI.getPlaylistTracks = async () => ({ success: true, data: [{ path: 'A0.wav' }] });
  window.electronAPI.getOnlineLibrary = async () => ({ success: true, data: [{ onlineId: 'aqz-KE-bpKQ', path: 'online.m4a' }] });
  await mixer.loadStoredData();
  assert.deepEqual(mixer.decks.A.tracks.map(track => track.path), ['online.m4a', 'A0.wav']);
  assert.equal(mixer.decks.B.tracks[0].onlineId, 'aqz-KE-bpKQ');
  assert.equal(mixer.isPlaying, false);
});

test('online handoff with fades disabled keeps outgoing sound until incoming onplay and starts at master volume', t => {
  const { mixer } = mixerFixture(t);
  mixer.loadTrack(0, { deckId: 'A' });
  mixer.isPlaying = true; mixer.playingDeck = 'A';
  const outgoing = mixer.musicPlayer;
  outgoing.play();
  mixer.crossfadeEnabled = false; mixer.deckCrossfadeEnabled = false;
  mixer.startCrossfadeTo('B', 0, { onlineHandoff: true });
  const incoming = mixer.musicPlayer;
  assert.equal(Boolean(outgoing.unloaded), false);
  assert.equal(incoming.volume(), mixer.musicVolume);
  incoming.options.onplay();
  assert.equal(outgoing.faded.to, 0);
  assert.equal(outgoing.faded.ms, 0);
});

test('oversized saved panel preferences cannot hide the center panel', t => {
  const { mixer } = mixerFixture(t);
  const sizes = mixer.getResponsivePanelWidths(1000, 0.8, 0.8);
  assert.ok(sizes.leftWidth >= 260 && sizes.rightWidth >= 260);
  assert.ok(sizes.leftWidth + sizes.rightWidth + 360 + 12 <= 1000.001);
});

test('select controls keep their arrow keys without changing playback or volume', t => {
  const { mixer } = mixerFixture(t);
  mixer.nextTrack = mixer.previousTrack = mixer.setMusicVolume = () => assert.fail('native select key reached transport');
  for (const code of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'KeyM', 'Digit1']) {
    mixer.handleHotkeys({ code, target: { tagName: 'SELECT' }, preventDefault: () => assert.fail('native key was consumed') });
  }
});

test('a transferred player resumes in its new deck and advances that queue', t => {
  const { mixer } = mixerFixture(t);
  mixer.loadTrack(0, { deckId: 'A' });
  const player = mixer.musicPlayer;
  player.started = true;
  player.options.onplay();
  mixer.moveTrackBetweenDecks('A', 0, 'B', 0);
  assert.equal(mixer.playingDeck, 'B');
  player.options.onpause();
  player.options.onplay();
  assert.equal(mixer.playingDeck, 'B');
  assert.equal(mixer.musicPlayerDeck, 'B');
  mixer.nextTrack = () => { assert.equal(mixer.playingDeck, 'B'); };
  mixer.handleTrackEnd(player, mixer.musicPlayerToken);
});

test('looping restarts at the cue after the trimmed end and keeps progress tracking', t => {
  const { mixer } = mixerFixture(t);
  mixer.playbackMode = 'loop';
  mixer.audioSettings = { trimSilenceEnabled: true, trimSilenceEnd: true };
  mixer.decks.A.tracks[0].startOffset = 4;
  mixer.decks.A.tracks[0].silenceBounds = { endSec: 50 };
  mixer.loadTrack(0, { deckId: 'A' });
  const player = mixer.musicPlayer;
  player.started = true;
  player.options.onplay();
  player.seek(51);
  let progressStarts = 0;
  mixer.startProgressTracking = () => progressStarts++;
  mixer.handleTrackEnd(player, mixer.musicPlayerToken);
  assert.equal(player.seek(), 4);
  assert.equal(player.playing(), true);
  assert.equal(progressStarts, 1);
});

test('native loop reentry applies the cue without starting another sound during its pending play', t => {
  const { mixer } = mixerFixture(t);
  mixer.playbackMode = 'loop';
  mixer.decks.A.tracks[0].startOffset = 4;
  mixer.loadTrack(0, { deckId: 'A' });
  const player = mixer.musicPlayer;
  player.play = () => assert.fail('Howler is already restarting the native loop');
  player.started = false;
  mixer.handleTrackEnd(player, mixer.musicPlayerToken);
  assert.equal(player.seek(), 0);
  player.started = true;
  player.options.onplay();
  assert.equal(player.seek(), 4);
});

test('pause during an asynchronous resume still pauses the transferred player', t => {
  const { mixer } = mixerFixture(t);
  mixer.loadTrack(0, { deckId: 'A' });
  const player = mixer.musicPlayer;
  mixer.isPlaying = true;
  mixer.isPaused = true;
  mixer.pendingMusicStart = true;
  let pauses = 0;
  player.pause = () => { pauses++; player.options.onpause(); };
  mixer.pauseMusic();
  assert.equal(pauses, 1);
  assert.equal(mixer.pendingMusicStart, false);
  assert.equal(mixer.isPaused, true);
});

test('file import renders and persists an exact custom queue without starting audio', async t => {
  const { mixer } = mixerFixture(t);
  window.electronAPI.openFileDialog = async () => ({ canceled: false, filePaths: ['selected.wav'] });
  window.electronAPI.getAudioTracks = async files => ({ success: true, data: files.map(path => ({ path, name: 'selected' })) });
  let renders = 0, saves = 0;
  mixer.displayTracks = id => { assert.equal(id, 'B'); renders++; };
  mixer.saveStoredData = () => saves++;
  await mixer.openTrackForDeck('B');
  assert.equal(mixer.decks.B.tracks.at(-1).path, 'selected.wav');
  assert.equal(mixer.decks.B.customQueue, true);
  assert.equal(renders, 1);
  assert.ok(saves > 0);
  assert.equal(mixer.isPlaying, false);
  assert.equal(mixer.status, 'Добавлено треков в деку B: 1');
});

test('changed silence settings discard per-track analysis as well as caches before rebuilding', async t => {
  const { mixer } = mixerFixture(t);
  const track = mixer.decks.A.tracks[0];
  track.silenceBounds = { startSec: 1, endSec: 50 };
  track.peakLevel = .2;
  mixer.silenceBoundsCache = new Map([[track.path, track.silenceBounds]]);
  mixer.waveformCache = new Map([[track.path, [1, 2]]]);
  mixer.currentWaveformTrack = track;
  mixer.waveformRequestId = 2;
  mixer.loadWaveformForTrack = async selected => {
    assert.equal(selected, track);
    assert.equal(selected.silenceBounds, undefined);
    assert.equal(selected.peakLevel, undefined);
    assert.equal(mixer.silenceBoundsCache.size, 0);
    assert.equal(mixer.waveformCache.size, 0);
    assert.ok(mixer.waveformRequestId > 2);
    selected.silenceBounds = { startSec: .75, endSec: 50.25 };
  };
  await mixer.refreshAudioAnalysis();
  assert.equal(track.silenceBounds.startSec, .75);
});

test('an invalid timer restart preserves the running countdown instead of making it negative', t => {
  const { mixer } = mixerFixture(t);
  const minutes = { value: '0' }, seconds = { value: '5' };
  document.getElementById = id => id === 'countdownMinutes' ? minutes : id === 'countdownSeconds' ? seconds : null;
  let tick;
  t.mock.method(global, 'setInterval', callback => { tick = callback; return 1; });
  t.mock.method(global, 'clearInterval', () => {});
  mixer.startCountdown();
  seconds.value = '0';
  mixer.startCountdown();
  assert.equal(mixer.countdownTime, 5);
  tick();
  assert.equal(mixer.countdownTime, 4);
  assert.equal(mixer.isCountdownRunning, true);
});

test('advertised menu shortcuts run their actions without reloading or firing transport hotkeys', t => {
  const { mixer } = mixerFixture(t);
  const actions = [];
  mixer.refreshPlaylists = () => actions.push('refresh');
  mixer.changeMusicFolder = () => actions.push('folder');
  mixer.workspaces = { activateSettings: () => actions.push('settings') };
  window.electronAPI.windowControl = async action => actions.push(action);
  for (const keys of [{ code: 'F5' }, { code: 'KeyO', ctrlKey: true }, { code: 'Comma', metaKey: true }, { code: 'KeyQ', ctrlKey: true }]) {
    let prevented = false;
    mixer.handleHotkeys({ ...keys, target: { tagName: 'INPUT' }, preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true);
  }
  assert.deepEqual(actions, ['refresh', 'folder', 'settings', 'close']);
});
