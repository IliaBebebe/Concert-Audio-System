const test = require('node:test');
const assert = require('node:assert/strict');
const { TheatreSoundMixer } = require('../renderer');

function fixture(t) {
  const previous = { document: global.document, window: global.window, requestAnimationFrame: global.requestAnimationFrame };
  const shell = { inert: true, setAttribute(name, value) { this[name] = value; } };
  const screen = { hidden: false, dataset: {} };
  const message = {};
  const retry = { hidden: true };
  const classes = new Set(['app-starting']);
  const elements = { appShell: shell, startupScreen: screen, startupMessage: message, startupRetry: retry };
  global.document = { body: { classList: { remove: name => classes.delete(name) } },
    fonts: { ready: Promise.resolve() }, getElementById: id => elements[id] };
  global.window = { location: { reload() {} } };
  global.requestAnimationFrame = callback => setImmediate(callback);
  t.after(() => Object.assign(global, previous));
  const mixer = Object.create(TheatreSoundMixer.prototype);
  return { mixer, shell, screen, message, retry, classes };
}

test('startup keeps the interface covered and inert until restoration and fonts finish', async t => {
  const { mixer, shell, screen, classes } = fixture(t);
  let restore, fonts;
  mixer.initializeApp = () => new Promise(resolve => { restore = resolve; });
  document.fonts.ready = new Promise(resolve => { fonts = resolve; });
  const ready = mixer.startApp();
  assert.equal(screen.hidden, false);
  assert.equal(shell.inert, true);
  restore();
  await new Promise(setImmediate);
  assert.equal(classes.has('app-starting'), true, 'font metrics must settle behind the logo');
  fonts();
  assert.equal(await ready, true);
  assert.equal(screen.hidden, true);
  assert.equal(shell.inert, false);
  assert.equal(shell['aria-busy'], 'false');
  assert.equal(mixer.startupState, 'ready');
});

test('failed startup offers retry without exposing an incomplete workspace', async t => {
  const { mixer, shell, screen, message, retry, classes } = fixture(t);
  mixer.initializeApp = async () => { throw new Error('test restoration failure'); };
  assert.equal(await mixer.startApp(), false);
  assert.equal(shell.inert, true);
  assert.equal(screen.hidden, false);
  assert.equal(classes.has('app-starting'), true);
  assert.equal(screen.dataset.state, 'error');
  assert.match(message.textContent, /Повторите запуск/);
  assert.equal(retry.hidden, false);
  assert.equal(typeof retry.onclick, 'function');
});

test('startup completes when a hidden window stops delivering animation frames', async t => {
  const { mixer, screen, shell } = fixture(t);
  mixer.initializeApp = async () => {};
  global.requestAnimationFrame = () => 1;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ready = mixer.startApp();
  await new Promise(setImmediate);
  assert.equal(screen.hidden, false);
  t.mock.timers.tick(250);
  assert.equal(await ready, true);
  assert.equal(screen.hidden, true);
  assert.equal(shell.inert, false);
});
