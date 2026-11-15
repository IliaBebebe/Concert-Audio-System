const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createCipheriv, createDecipheriv, randomBytes } = require('node:crypto');
const { OnlineAccounts, providerCookies } = require('../online-accounts');

const cookie = (domain, name, value = 'test-only') => `${domain}\tTRUE\t/\tTRUE\t0\t${name}\t${value}\n`;
const header = '# Netscape HTTP Cookie File\n';

test('cookie import only keeps the selected service and rejects missing, expired and malformed authentication', () => {
  const text = header + cookie('.youtube.com', 'SID') + cookie('.example.org', 'secret') + cookie('.soundcloud.com', 'oauth_token');
  const youtube = providerCookies(text, 'youtube');
  assert.match(youtube, /SID/);
  assert.doesNotMatch(youtube, /example|soundcloud|secret/);
  assert.match(providerCookies(text, 'soundcloud'), /oauth_token/);
  assert.match(providerCookies(header + '#HttpOnly_' + cookie('.youtube.com', 'SAPISID'), 'youtube'), /SAPISID/);
  for (const input of [header + cookie('.youtube.com.evil.org', 'SID'), header + cookie('.notyoutube.com', 'SID'), header + cookie('.youtube.com', 'VISITOR_INFO1_LIVE'), header + cookie('.youtube.com', 'SID').replace('\t0\t', '\t1\t'), header + cookie('.youtube.com', 'SID', 'x\u0000y'), 'not cookies']) {
    assert.throws(() => providerCookies(input, 'youtube'));
  }
});

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cas-accounts-test-'));
  const key = randomBytes(32), iv = randomBytes(16);
  const safeStorage = {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async value => { const cipher = createCipheriv('aes-256-cbc', key, iv); return Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); },
    decryptStringAsync: async value => { const cipher = createDecipheriv('aes-256-cbc', key, iv); return { result: Buffer.concat([cipher.update(value), cipher.final()]).toString('utf8') }; }
  };
  const accounts = new OnlineAccounts({ file: path.join(root, 'accounts.bin'), safeStorage, ...options });
  t.after(async () => { accounts.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  return { accounts, safeStorage, root };
}

test('credentials survive encrypted persistence, disconnect separately and refuse insecure persistence', async t => {
  const { accounts, safeStorage } = await fixture(t);
  await accounts.save('yandex', { token: 'test-token-secret' });
  await accounts.save('youtube', { cookies: header + cookie('.youtube.com', 'SID') });
  assert.equal((await accounts.credentials('yandex')).token, 'test-token-secret');
  assert.equal((await fs.readFile(accounts.file)).includes(Buffer.from('test-token-secret')), false);
  assert.deepEqual(await accounts.credentials('__proto__'), {});
  await accounts.save('youtube', null);
  assert.deepEqual(await accounts.credentials('youtube'), {});
  assert.equal((await accounts.credentials('yandex')).token, 'test-token-secret');
  await accounts.save('yandex', null);
  await assert.rejects(fs.stat(accounts.file), { code: 'ENOENT' });
  safeStorage.isAsyncEncryptionAvailable = async () => false;
  await assert.rejects(accounts.save('yandex', { token: 'test-token' }), /не сохранены/);
  await assert.rejects(fs.stat(accounts.file), { code: 'ENOENT' });
});

test('device login opens only the fixed Yandex URL, stores the confirmed token and closes the prompt', async t => {
  const opened = [], requests = [];
  let promptOpened, promptClosed = false;
  const ready = new Promise(resolve => { promptOpened = resolve; });
  const { accounts } = await fixture(t, {
    shell: { openExternal: async url => opened.push(url) },
    dialog: { showMessageBox: (_parent, { signal, message }) => {
      assert.match(message, /ABCD-EFGH/);
      promptOpened();
      return new Promise(resolve => signal.addEventListener('abort', () => { promptClosed = true; resolve({ response: 0 }); }));
    } },
    request: async (endpoint, data) => {
      requests.push({ endpoint, data });
      return endpoint === 'device/code' ? { device_code: 'test-device', user_code: 'ABCD-EFGH', expires_in: 300, interval: 5 } : { access_token: 'test-token-confirmed' };
    }
  });
  const login = accounts.loginYandex({});
  await ready;
  assert.equal(await login, 'Вход в Яндекс Музыку выполнен');
  assert.deepEqual(opened, ['https://ya.ru/device']);
  assert.equal(requests[1].data.code, 'test-device');
  assert.equal((await accounts.credentials('yandex')).token, 'test-token-confirmed');
  assert.equal(promptClosed, true);
});

test('cancelling device login aborts polling and never saves credentials', async t => {
  const { accounts } = await fixture(t, {
    shell: { openExternal: async () => {} },
    dialog: { showMessageBox: async () => ({ response: 1 }) },
    request: async endpoint => {
      assert.equal(endpoint, 'device/code');
      return { device_code: 'test-device', user_code: 'ABCD', expires_in: 300 };
    }
  });
  await assert.rejects(accounts.loginYandex({}), /отменён/);
  await assert.rejects(fs.stat(accounts.file), { code: 'ENOENT' });
});

test('account management remains locked until sign-in completes and only returns a status message', async t => {
  let finish, started;
  const ready = new Promise(resolve => { started = resolve; });
  const { accounts } = await fixture(t, { dialog: { showMessageBox: async () => ({ response: 0 }) } });
  accounts.loginYandex = () => new Promise(resolve => { finish = resolve; started(); });
  const first = accounts.manage({});
  await ready;
  await assert.rejects(accounts.manage({}), /уже открыта/);
  finish('Вход подтверждён');
  assert.equal(await first, 'Вход подтверждён');
  assert.equal(accounts.busy, false);
});

test('file import uses the native selection and stores only the selected provider cookies', async t => {
  const responses = [2, 0]; // SoundCloud, then import.
  const { accounts, root } = await fixture(t, { dialog: {
    showMessageBox: async () => ({ response: responses.shift() }),
    showOpenDialog: async () => ({ canceled: false, filePaths: [path.join(root, 'cookies.txt')] })
  } });
  await fs.writeFile(path.join(root, 'cookies.txt'), header + cookie('.soundcloud.com', 'oauth_token') + cookie('.youtube.com', 'SID', 'unrelated-secret'));
  const status = await accounts.manage({});
  assert.match(status, /данные входа сохранены/);
  assert.doesNotMatch(status, /test-only|unrelated-secret/);
  const credentials = await accounts.credentials('soundcloud');
  assert.match(credentials.cookies, /oauth_token/);
  assert.doesNotMatch(credentials.cookies, /unrelated-secret|youtube/);
});

test('direct account actions skip selection menus, expose only saved-state booleans and reject unknown requests', async t => {
  const { accounts } = await fixture(t);
  await accounts.save('yandex', { token: 'test-secret-token' });
  assert.deepEqual(await accounts.status(), { yandex: true, youtube: false, soundcloud: false });
  await accounts.manage({}, { source: 'yandex', action: 'disconnect' });
  assert.equal((await accounts.status()).yandex, false);
  for (const request of [{ source: '__proto__', action: 'open' }, { source: 'youtube', action: 'https://evil.org' }, null]) await assert.rejects(accounts.manage({}, request), /Неизвестное действие/);
  await assert.rejects(accounts.openHelp('https://evil.org'), /Неизвестный раздел/);
});

test('Yandex copy button copies only the device code and cancel closes the pending login', async t => {
  const copied = [], choices = [0, 1];
  const { accounts } = await fixture(t, {
    clipboard: { writeText: code => copied.push(code) },
    shell: { openExternal: async () => {} },
    dialog: { showMessageBox: async () => ({ response: choices.shift() }) },
    request: async () => ({ device_code: 'private-device-code', user_code: 'ABCD', expires_in: 300 })
  });
  await assert.rejects(accounts.loginYandex({}), /отменён/);
  assert.deepEqual(copied, ['ABCD']);
});
