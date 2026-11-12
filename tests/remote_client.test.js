const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// A small DOM/network boundary lets the actual browser script run without adding dependencies.
class Element {
  constructor() {
    this.listeners = {}; this.children = []; this.dataset = {}; this.attributes = {};
    this.value = ''; this.style = {}; this.hidden = false; this.disabled = false;
    const classes = new Set();
    this.classList = { toggle: (name, value) => value ? classes.add(name) : classes.delete(name), contains: name => classes.has(name) };
  }
  addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
  async emit(name, event = {}) { for (const callback of this.listeners[name] || []) await callback({ target: this, preventDefault() {}, ...event }); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  toggleAttribute(name, value) { if (value) this.attributes[name] = ''; else delete this.attributes[name]; }
  focus() { this.focused = true; }
  closest(selector) { return selector === '[data-index]' && this.dataset.index !== undefined || selector === '[data-pad]' && this.dataset.pad !== undefined ? this : null; }
}

function snapshot() {
  return {
    activeDeck: 'A', playingDeck: 'A', isPlaying: true, isPaused: false, isMuted: false, masterVolume: .7,
    currentTrack: { deck: 'A', title: 'Opening', duration: 120, currentTime: 20, remainingTime: 100 },
    deckA: { name: 'Main', tracks: [{ index: 0, name: 'Opening', durationStr: '2:00', isPlaying: true }] },
    deckB: { name: 'Reserve', tracks: [{ index: 0, name: '<img src=x onerror=alert(1)>', durationStr: '1:00', isPlaying: false }] },
    pads: Array.from({ length: 12 }, (_, index) => ({ index, name: `Pad ${index + 1}`, isAssigned: index === 0, isPlaying: false }))
  };
}

async function client(options = {}) {
  const elements = {};
  const html = fs.readFileSync(require.resolve('../remote-client/index.html'), 'utf8');
  for (const match of html.matchAll(/id="([^"]+)"/g)) elements[match[1]] = new Element();
  const app = new Element();
  const decks = ['A', 'B'].map(deck => Object.assign(new Element(), { dataset: { deck } }));
  const nav = ['screenTransport', 'screenTracks', 'screenPads'].map(screen => Object.assign(new Element(), { dataset: { screen } }));
  const controls = [...html.matchAll(/<\w+[^>]*id="([^"]+)"[^>]*data-command/g)].map(match => elements[match[1]]);
  const document = Object.assign(new Element(), {
    visibilityState: 'visible', getElementById: id => elements[id], createElement: () => new Element(), createTextNode: text => text,
    querySelector: () => app,
    querySelectorAll: selector => ({ '[data-deck]': decks, '[data-screen]': nav, '[data-command]': controls,
      '.screen': ['screenTransport', 'screenTracks', 'screenPads'].map(id => Object.assign(elements[id], { id })) })[selector]
  });
  const requests = [], sources = [], timers = new Map();
  let current = snapshot();
  let nextStatus = 200;
  let commandGate = null;
  const storage = new Map();
  const window = new Element();
  const context = {
    document, window, URL, URLSearchParams, AbortSignal, console,
    location: { search: options.noToken ? '' : '?token=test', href: 'http://cas.local/' }, history: { replaceState() {} },
    sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    setTimeout: (callback, delay) => { const id = {}; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id), setInterval: () => ({}), clearInterval() {},
    fetch: async (url, init) => {
      requests.push({ url, init });
      if (url.includes('/command') && commandGate) {
        const gate = commandGate;
        commandGate = null;
        await gate;
      }
      const status = nextStatus; nextStatus = 200;
      return { ok: status === 200, status, headers: { get: () => null }, json: async () => url.includes('/status') ? { state: current } : { success: true } };
    },
    EventSource: class {
      constructor(url) { this.url = url; this.listeners = {}; sources.push(this); }
      addEventListener(name, callback) { this.listeners[name] = callback; }
      close() { this.closed = true; }
    }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../remote-client/remote.js'), 'utf8'), context);
  const settle = () => new Promise(resolve => setImmediate(resolve));
  await settle();
  function open() { sources.at(-1).onopen(); }
  function update(value = current) { current = value; sources.at(-1).listeners.state({ data: JSON.stringify(value) }); }
  if (!options.noToken) open();
  return { elements, decks, nav, document, sources, timers, requests, settle, open, update,
    holdCommand: () => { let release; commandGate = new Promise(resolve => { release = resolve; }); return release; },
    fail: status => { nextStatus = status; },
    commands: () => requests.filter(request => request.init.method === 'POST').map(request => JSON.parse(request.init.body)) };
}

test('phone browsing and cueing do not touch desktop playback; launch explicitly targets the chosen deck', async () => {
  const c = await client();
  await c.decks[1].emit('click');
  const row = c.elements.tracklist.children[0];
  await c.elements.tracklist.emit('click', { target: row });
  assert.equal(c.commands().length, 0);
  assert.equal(c.elements.cueTitle.textContent, '<img src=x onerror=alert(1)>');
  assert.equal(c.elements.playingDeck.textContent, 'Дека A');
  await c.elements.btnLaunch.emit('click');
  assert.deepEqual(c.commands(), [{ action: 'selectTrack', deck: 'B', index: 0, autoplay: true }]);
  assert.equal(c.elements.cueBar.hidden, true);
});

test('playback ticks preserve track and pad nodes, focused controls, and local deck choice', async () => {
  const c = await client();
  await c.decks[1].emit('click');
  const track = c.elements.tracklist.children[0];
  const pad = c.elements.padsGrid.children[0];
  track.focus();
  c.update(snapshot());
  assert.equal(c.elements.tracklist.children[0], track);
  assert.equal(c.elements.padsGrid.children[0], pad);
  assert.equal(track.focused, true);
  assert.equal(c.decks[1].attributes['aria-pressed'], 'true');
  assert.equal(c.elements.playIcon.attributes.hidden, '');
  assert.equal(c.elements.pauseIcon.attributes.hidden, undefined);
});

test('playlist changes invalidate a prepared track before launch', async () => {
  const c = await client();
  await c.elements.tracklist.emit('click', { target: c.elements.tracklist.children[0] });
  const next = snapshot(); next.deckA.tracks[0].name = 'Replacement';
  c.update(next);
  await c.elements.btnLaunch.emit('click');
  assert.equal(c.commands().length, 0);
  assert.equal(c.elements.cueBar.hidden, true);
  assert.match(c.elements.commandError.textContent, /изменился/);
});

test('invalid PIN is checked once without opening SSE or scheduling a retry', async () => {
  const c = await client({ noToken: true });
  c.fail(401);
  c.elements.pinInput.value = '9999';
  await c.elements.pinForm.emit('submit');
  await c.settle();
  assert.equal(c.requests.length, 1);
  assert.equal(c.sources.length, 0);
  assert.equal(c.timers.size, 0);
  assert.match(c.elements.pinError.textContent, /PIN не принят/);
});

test('lost connection disables every action and reconnect does not replay commands', async () => {
  const c = await client();
  await c.elements.btnNext.emit('click');
  c.sources[0].onerror();
  assert.equal(c.elements.btnNext.disabled, true);
  assert.equal(c.elements.volumeSlider.disabled, true);
  assert.equal(c.elements.tracklist.children[0].disabled, true);
  const timer = [...c.timers.values()][0];
  await timer.callback(); await c.settle(); c.open();
  assert.equal(c.commands().length, 1);
  assert.equal(c.sources[0].closed, true);
  assert.equal(c.elements.btnNext.disabled, false);
});

test('volume input is coalesced and the final slider value is sent', async () => {
  const c = await client();
  for (const value of [31, 42, 57, 63]) {
    c.elements.volumeSlider.value = value;
    await c.elements.volumeSlider.emit('input');
  }
  assert.equal(c.commands().length, 0);
  await c.elements.volumeSlider.emit('change');
  assert.deepEqual(c.commands(), [{ action: 'setVolume', volume: .63 }]);
});

test('unassigned pads are disabled and disconnect clears the cue', async () => {
  const c = await client();
  const emptyPad = c.elements.padsGrid.children[1];
  assert.equal(emptyPad.disabled, true);
  await c.elements.padsGrid.emit('click', { target: emptyPad });
  assert.equal(c.commands().length, 0);
  await c.elements.tracklist.emit('click', { target: c.elements.tracklist.children[0] });
  c.sources[0].onerror();
  assert.equal(c.elements.cueBar.hidden, true);
});

test('expired access stops reconnecting and old stream events cannot re-enable controls', async () => {
  const c = await client();
  c.sources[0].onerror();
  c.fail(401);
  await [...c.timers.values()][0].callback();
  await c.settle();
  c.sources[0].listeners.state({ data: JSON.stringify(snapshot()) });
  assert.equal(c.elements.pairing.hidden, false);
  assert.equal(c.elements.btnNext.disabled, true);
  assert.equal(c.timers.size, 0);
});

test('volume updates stay ordered while a command is in flight', async () => {
  const c = await client();
  const release = c.holdCommand();
  c.elements.volumeSlider.value = 20;
  await c.elements.volumeSlider.emit('input');
  const first = c.elements.volumeSlider.emit('change');
  c.elements.volumeSlider.value = 85;
  await c.elements.volumeSlider.emit('input');
  await c.elements.volumeSlider.emit('change');
  assert.equal(c.commands().length, 1);
  release(); await first; await c.settle();
  assert.deepEqual(c.commands().map(item => item.volume), [.2, .85]);
});

test('different pads can launch together while duplicate in-flight taps are blocked', async () => {
  const c = await client();
  const state = snapshot(); state.pads[1].isAssigned = true; c.update(state);
  const release = c.holdCommand();
  const first = c.elements.padsGrid.emit('click', { target: c.elements.padsGrid.children[0] });
  await c.elements.padsGrid.emit('click', { target: c.elements.padsGrid.children[0] });
  await c.elements.padsGrid.emit('click', { target: c.elements.padsGrid.children[1] });
  release(); await first; await c.settle();
  assert.deepEqual(c.commands().map(item => item.index), [0, 1]);
});
