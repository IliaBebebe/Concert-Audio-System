const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { TheatreSoundMixer, CASDeckManager } = require('../renderer');

const root = path.join(__dirname, '..');

test('renderer scripts load in HTML order without Node globals and register startup once', () => {
  const listeners = new Map();
  const context = vm.createContext({ console });
  context.window = context;
  context.document = { addEventListener: (name, handler) => {
    const handlers = listeners.get(name) || [];
    handlers.push(handler);
    listeners.set(name, handlers);
  } };
  context.addEventListener = () => {};
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)]
    .map(match => match[1]).filter(file => !file.startsWith('assets/'));
  for (const file of scripts) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  }
  assert.equal(typeof context.CASRenderer.TheatreSoundMixer, 'function');
  assert.equal(typeof context.CASWorkspaceController, 'function');
  assert.equal(typeof context.CASOnlinePanel, 'function');
  assert.equal(listeners.get('DOMContentLoaded').length, 1);
  assert.equal(context.soundMixer, undefined, 'loading scripts must not start playback or restore a profile');
  assert.equal(context.module, undefined);
  assert.equal(context.require, undefined);
  assert.equal(context.CASPlaybackController, undefined, 'controllers stay inside the renderer namespace');
});

test('feature state stays isolated between mixers and legacy accessors keep the same identities', () => {
  const first = Object.create(TheatreSoundMixer.prototype);
  const second = Object.create(TheatreSoundMixer.prototype);
  first.deckManager = new CASDeckManager();
  second.deckManager = new CASDeckManager();
  first.decks = first.deckManager.decks;
  second.decks = second.deckManager.decks;
  first.soundEffects = new Map([[0, { path: 'first.wav', name: 'First pad' }]]);
  second.soundEffects = new Map();
  first.waveformCache = new Map([['first.wav', [0.5]]]);
  second.waveformCache = new Map();
  first.decks.A.tracks.push({ path: 'first.wav' });

  assert.notEqual(first.padsController, second.padsController);
  assert.equal(first.soundEffects, first.padsController.soundEffects);
  assert.equal(first.waveformCache, first.waveformController.waveformCache);
  assert.equal(first.decks, first.decksController.decks);
  assert.equal(first.getPadLabel(0), 'First pad');
  assert.equal(second.soundEffects.size, 0);
  assert.equal(second.waveformCache.size, 0);
  assert.equal(second.decks.A.tracks.length, 0);
});

test('compatibility facade preserves overridable callbacks across feature boundaries', () => {
  const mixer = Object.create(TheatreSoundMixer.prototype);
  mixer.deckManager = new CASDeckManager();
  mixer.decks = mixer.deckManager.decks;
  mixer.decks.B.tracks = [{ path: 'next.wav' }];
  mixer.isPlaying = true;
  mixer.isPaused = false;
  mixer.playingDeck = 'A';
  let rendered;
  mixer.displayTracks = deck => { rendered = deck; };
  mixer.saveStoredData = () => {};
  mixer.filterTracksInDeck('B', 'next');
  assert.equal(mixer.decks.B.filterQuery, 'next');
  assert.equal(mixer.playingDeck, 'A');
  assert.equal(rendered, 'B');
});
