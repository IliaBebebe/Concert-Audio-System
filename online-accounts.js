const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');

const PROVIDERS = { yandex: 'Яндекс Музыка', youtube: 'YouTube', soundcloud: 'SoundCloud' };
// Public client credentials used by the open-source yandex-music-api device flow.
const YANDEX_CLIENT = '23cabbbdc6cd418abb4b39c32c41195d';
const YANDEX_CLIENT_SECRET = '53bc75238f0c4d08a118e51fe9203300';

function providerCookies(text, source, now = Date.now() / 1000) {
  if (!['youtube', 'soundcloud'].includes(source) || typeof text !== 'string' || Buffer.byteLength(text) > 1024 * 1024 || !/^# (?:Netscape HTTP Cookie File|HTTP Cookie File)/.test(text.replace(/^\uFEFF/, ''))) {
    throw new Error('Выберите cookies.txt в формате Netscape, экспортированный после входа в сервис');
  }
  const domain = source === 'youtube' ? 'youtube.com' : 'soundcloud.com';
  const lines = text.split(/\r?\n/).filter(line => line && (!line.startsWith('#') || line.startsWith('#HttpOnly_')));
  const selected = [];
  let authenticated = false;
  for (const line of lines) {
    const parts = line.replace(/^#HttpOnly_/, '').split('\t');
    if (parts.length !== 7) throw new Error('Некорректный формат cookies.txt');
    const [host, subdomains, cookiePath, secure, expires, name, value] = parts;
    const cleanHost = host.replace(/^\./, '').toLowerCase();
    if (cleanHost !== domain && !cleanHost.endsWith(`.${domain}`)) continue;
    if (!/^[.a-z0-9-]+$/i.test(host) || !/^(TRUE|FALSE)$/.test(subdomains) || !/^(TRUE|FALSE)$/.test(secure) || !/^\d+$/.test(expires) || !cookiePath.startsWith('/') || /[\x00-\x20\x7f]/.test(name + value + cookiePath)) throw new Error('Некорректные данные cookies.txt');
    if (Number(expires) !== 0 && Number(expires) <= now) continue;
    selected.push(parts.join('\t'));
    authenticated ||= Boolean(value) && (source === 'soundcloud' ? name === 'oauth_token' : /^(?:SID|SAPISID|__Secure-[13]PAPISID)$/.test(name));
  }
  if (!authenticated) throw new Error(`${PROVIDERS[source]}: в файле нет действующих cookies входа. Войдите в сервис и экспортируйте cookies заново`);
  return '# Netscape HTTP Cookie File\n' + selected.join('\n') + '\n';
}

async function oauthRequest(endpoint, data, signal) {
  let response;
  try {
    response = await fetch(`https://oauth.yandex.ru/${endpoint}`, { method: 'POST', body: new URLSearchParams(data), redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
    const text = await response.text();
    if (text.length > 65536) throw new Error();
    const result = JSON.parse(text);
    if (!response.ok && !['authorization_pending', 'slow_down'].includes(result.error)) throw new Error();
    return result;
  } catch {
    throw new Error(signal.aborted ? 'Вход отменён' : 'Яндекс не подтвердил вход. Повторите попытку');
  }
}

class OnlineAccounts {
  constructor({ file, safeStorage, dialog, shell, clipboard, request = oauthRequest }) {
    Object.assign(this, { file, safeStorage, dialog, shell, clipboard, request });
    this.busy = false;
    this.controller = null;
  }

  async read() {
    try {
      const encrypted = await fs.readFile(this.file);
      const { result } = await this.safeStorage.decryptStringAsync(encrypted);
      return JSON.parse(result);
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw new Error('Не удалось открыть сохранённые аккаунты. Проверьте доступ к системному хранилищу ключей');
    }
  }

  async credentials(source) {
    if (!Object.hasOwn(PROVIDERS, source)) return {};
    return (await this.read())[source] || {};
  }

  async status() {
    const accounts = await this.read();
    return Object.fromEntries(Object.keys(PROVIDERS).map(source => [source, Boolean(accounts[source])]));
  }

  async connect(source, parent) {
    if (source === 'yandex') return await this.loginYandex(parent);
    const picked = await this.dialog.showOpenDialog(parent, { title: `${PROVIDERS[source]}: cookies.txt`, properties: ['openFile'], filters: [{ name: 'Netscape cookies', extensions: ['txt'] }] });
    if (picked.canceled || !picked.filePaths.length) return 'Подключение отменено';
    if ((await fs.stat(picked.filePaths[0])).size > 1024 * 1024) throw new Error('Файл cookies.txt слишком большой');
    const cookies = providerCookies(await fs.readFile(picked.filePaths[0], 'utf8'), source);
    await this.save(source, { cookies });
    return `${PROVIDERS[source]}: данные входа сохранены. Повторите подготовку трека для проверки доступа`;
  }

  async openHelp(topic) {
    const urls = {
      guide: 'https://github.com/IliaBebebe/Concert-Audio-System/blob/v1.9.3/docs/ONLINE_MUSIC.md',
      chrome: 'https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc',
      firefox: 'https://addons.mozilla.org/firefox/addon/cookies-txt/'
    };
    if (!Object.hasOwn(urls, topic)) throw new Error('Неизвестный раздел справки');
    await this.shell.openExternal(urls[topic]);
    return true;
  }

  async save(source, credentials) {
    if (!Object.hasOwn(PROVIDERS, source)) throw new Error('Неизвестный источник');
    const data = await this.read();
    if (credentials) data[source] = credentials; else delete data[source];
    // Removing the last account must also work when the key store is unavailable.
    if (!Object.keys(data).length) { await fs.rm(this.file, { force: true }); return; }
    if (!await this.safeStorage.isAsyncEncryptionAvailable()) throw new Error('Системное хранилище ключей недоступно. Данные входа не сохранены');
    const encrypted = await this.safeStorage.encryptStringAsync(JSON.stringify(data));
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temporary = this.file + '.tmp';
    try {
      await fs.writeFile(temporary, encrypted, { mode: 0o600 });
      await fs.rename(temporary, this.file);
    } finally { await fs.rm(temporary, { force: true }); }
  }

  async loginYandex(parent) {
    const controller = new AbortController();
    this.controller = controller;
    const signal = controller.signal;
    try {
      const code = await this.request('device/code', { client_id: YANDEX_CLIENT, device_id: randomBytes(16).toString('hex'), device_name: 'Concert Audio System' }, signal);
      if (!code.device_code || !/^[\w-]{3,20}$/.test(code.user_code || '') || !(code.expires_in > 0)) throw new Error('Яндекс не выдал код входа');
      await this.shell.openExternal('https://ya.ru/device');
      const showCode = async () => {
        while (!signal.aborted) {
          const choice = await this.dialog.showMessageBox(parent, { type: 'info', title: 'Вход в Яндекс Музыку', message: `Код входа: ${code.user_code}`, detail: 'Скопируйте код, вставьте его на открытой странице Яндекса и подтвердите вход. CAS завершит подключение автоматически.', buttons: ['Скопировать код', 'Отмена'], cancelId: 1, signal });
          if (signal.aborted) return;
          if (choice.response === 0 && this.clipboard) this.clipboard.writeText(code.user_code);
          else { controller.abort(); return; }
        }
      };
      showCode().catch(() => controller.abort());
      const deadline = Date.now() + Math.min(600, code.expires_in) * 1000;
      let interval = Math.max(5, Number(code.interval) || 5);
      while (!signal.aborted && Date.now() < deadline) {
        await delay(interval * 1000, undefined, { signal });
        const result = await this.request('token', { grant_type: 'device_code', code: code.device_code, client_id: YANDEX_CLIENT, client_secret: YANDEX_CLIENT_SECRET }, signal);
        if (signal.aborted) throw new Error('Вход отменён');
        if (typeof result.access_token === 'string' && /^[\w.-]{10,4096}$/.test(result.access_token)) {
          await this.save('yandex', { token: result.access_token });
          return 'Вход в Яндекс Музыку выполнен';
        }
        if (result.error === 'slow_down') interval += 5;
        else if (result.error !== 'authorization_pending') throw new Error('Яндекс не подтвердил вход. Повторите попытку');
      }
      throw new Error(signal.aborted ? 'Вход отменён' : 'Время входа истекло. Повторите попытку');
    } catch (error) {
      if (signal.aborted) throw new Error('Вход отменён');
      throw error;
    } finally { controller.abort(); this.controller = null; }
  }

  async manage(parent, request) {
    if (this.busy) throw new Error('Настройка аккаунта уже открыта');
    this.busy = true;
    try {
      if (request !== undefined) {
        const { source, action } = request || {};
        if (!Object.hasOwn(PROVIDERS, source) || !['connect', 'disconnect', 'open'].includes(action)) throw new Error('Неизвестное действие аккаунта');
        if (action === 'connect') return await this.connect(source, parent);
        if (action === 'disconnect') { await this.save(source, null); return `${PROVIDERS[source]}: аккаунт отключён в CAS`; }
        await this.shell.openExternal(source === 'yandex' ? 'https://music.yandex.ru/' : source === 'youtube' ? 'https://www.youtube.com/' : 'https://soundcloud.com/');
        return `${PROVIDERS[source]} открыт в браузере`;
      }
      const accounts = await this.read();
      const sources = Object.keys(PROVIDERS);
      const { response } = await this.dialog.showMessageBox(parent, { title: 'Аккаунты музыки онлайн', message: 'Выберите сервис', detail: sources.map(source => `${PROVIDERS[source]}: ${accounts[source] ? 'данные входа сохранены' : 'не подключён'}`).join('\n') + '\n\nДоступность треков зависит от подписки, региона и сети.', buttons: [...sources.map(source => PROVIDERS[source]), 'Закрыть'], cancelId: 3 });
      const source = sources[response];
      if (!source) return 'Настройка аккаунтов закрыта';
      const action = await this.dialog.showMessageBox(parent, { title: PROVIDERS[source], message: accounts[source] ? 'Данные входа сохранены' : 'Подключите аккаунт', detail: source === 'yandex' ? 'Вход откроется на странице Яндекса в вашем браузере.' : 'Войдите в сервис в своём браузере и экспортируйте cookies.txt в формате Netscape. Затем выберите этот файл. CAS сохраняет только cookies выбранного сервиса в зашифрованном виде. Файл даёт доступ к аккаунту, не передавайте его другим людям. Оригинал экспортированного файла CAS не удаляет.', buttons: [source === 'yandex' ? 'Войти' : 'Выбрать cookies.txt', 'Открыть сервис', 'Отключить', 'Отмена'], cancelId: 3 });
      if (action.response === 2) {
        await this.save(source, null);
        return `${PROVIDERS[source]}: аккаунт отключён в CAS`;
      }
      if (action.response === 1) {
        await this.shell.openExternal(source === 'yandex' ? 'https://music.yandex.ru/' : source === 'youtube' ? 'https://www.youtube.com/' : 'https://soundcloud.com/');
        return 'После входа откройте «Аккаунты» для подключения сервиса к CAS';
      }
      if (action.response !== 0) return 'Подключение отменено';
      return await this.connect(source, parent);
    } finally { this.busy = false; }
  }

  dispose() { this.controller?.abort(); }
}

module.exports = { OnlineAccounts, providerCookies };
