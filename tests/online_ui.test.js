const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.listeners = {}; this.dataset = {}; this.attributes = {};
    this.value = ''; this.hidden = false; this.textContent = '';
    this.classList = { toggle() {} };
  }
  addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
  async emit(name) {
    const event = { target: this, prevented: false, preventDefault() { this.prevented = true; } };
    for (const callback of this.listeners[name] || []) await callback(event);
    return event;
  }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  remove() { this.parent.children = this.parent.children.filter(child => child !== this); }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(selector === 'button' && child.tagName === 'BUTTON' ? [child] : []), ...child.querySelectorAll(selector)]); }
  focus() { this.focused = true; }
}

function panelFixture(overrides = {}) {
  const elements = Object.fromEntries([...fs.readFileSync(require.resolve('../index.html'), 'utf8').matchAll(/id="([^"]+)"/g)].map(match => [match[1], new Element()]));
  elements.onlineTargetDeck.value = 'A';
  const sources = ['all', 'soundcloud', 'yandex', 'youtube'].map(source => Object.assign(new Element('button'), { dataset: { onlineSource: source } }));
  const api = { onOnlineProgress() {}, cancelOnlineSearch: async () => ({}), cancelOnlineTrack: async () => ({}), getOnlineLibrary: async () => ({ success: true, data: [] }), ...overrides };
  const storage = new Map();
  const context = { document: { getElementById: id => elements[id], createElement: tag => new Element(tag), querySelectorAll: () => sources }, window: { electronAPI: api }, localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) } };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(require.resolve('../online-ui'), 'utf8'), context);
  const inserted = [], captured = [];
  const mixer = {
    decks: { A: { tracks: [] }, B: { tracks: [] } }, soundEffects: new Map(),
    captureOnlineTarget: (deck, autoplay) => { const target = { deck, autoplay }; captured.push(target); return target; },
    insertOnlineTrack: (...args) => { inserted.push(args); return true; }
  };
  return { panel: new context.window.CASOnlinePanel(mixer), elements, inserted, captured, mixer };
}

test('cancel search still works with a cleared required input and ignores a late response', async () => {
  let reply, cancellations = 0;
  const { panel, elements } = panelFixture({
    searchOnline: () => new Promise(resolve => { reply = resolve; }),
    cancelOnlineSearch: async () => { cancellations++; }
  });
  elements.onlineQuery.value = 'song';
  const pending = panel.search();
  assert.equal(elements.onlineSearchButton.type, 'button');
  elements.onlineQuery.value = '';
  const click = await elements.onlineSearchButton.emit('click');
  assert.equal(click.prevented, true);
  assert.equal(cancellations, 1);
  reply({ success: true, data: { tracks: [{ title: 'Late result' }], warnings: [] } });
  await pending;
  assert.equal(panel.rows.size, 0);
  assert.match(elements.onlineStatus.textContent, /Поиск остановлен/);
  assert.equal(elements.onlineSearchButton.type, 'submit');
});

test('preparation captures its deck and cancellation prevents a late successful reply from inserting audio', async () => {
  let reply, cancelled;
  const { panel, elements, captured, inserted } = panelFixture({
    prepareOnlineTrack: () => new Promise(resolve => { reply = resolve; }),
    cancelOnlineTrack: async id => { cancelled = id; }
  });
  elements.onlineTargetDeck.value = 'B';
  const track = { onlineId: 'soundcloud-123', source: 'soundcloud', title: 'Song', artist: 'Artist' };
  const pending = panel.prepare(track, true);
  elements.onlineTargetDeck.value = 'A';
  assert.equal(captured[0].deck, 'B');
  await elements.onlineJobs.children[0].children[1].emit('click');
  reply({ success: true, data: { ...track, path: '/library/song.m4a' } });
  await pending;
  assert.equal(cancelled, track.onlineId);
  assert.equal(inserted.length, 0);
  assert.equal(elements.onlineJobs.hidden, true);
});

test('prepared audio keeps the captured target and untrusted titles are rendered as plain text', async () => {
  let reply;
  const { panel, elements, inserted } = panelFixture({ prepareOnlineTrack: () => new Promise(resolve => { reply = resolve; }) });
  const title = '<img src=x onerror=alert(1)>';
  const track = { onlineId: 'soundcloud-123', source: 'soundcloud', title, artist: 'Artist' };
  panel.render([track]);
  assert.equal(panel.rows.get(track.onlineId).row.children[1].children[0].textContent, title);
  elements.onlineTargetDeck.value = 'B';
  const pending = panel.prepare(track, false);
  elements.onlineTargetDeck.value = 'A';
  reply({ success: true, data: { ...track, path: '/library/song.m4a' } });
  await pending;
  assert.equal(inserted[0][1].deck, 'B');
  assert.equal(inserted[0][2], false);
  assert.match(panel.rows.get(track.onlineId).origin.textContent, /Сохранён в CAS/);
  assert.equal(panel.rows.get(track.onlineId).actions.children[0].disabled, false);
});
