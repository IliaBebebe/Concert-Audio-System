const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const { createHash } = require('node:crypto');

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const TRACK_ID = /^(?:[A-Za-z0-9_-]{11}|soundcloud-\d{1,20}|yandexmusic-\d{1,20})$/;
const MAX_BYTES = 250 * 1024 * 1024;
const MAX_DURATION = 30 * 60;
const SOURCES = { soundcloud: 'SoundCloud', yandex: 'Яндекс Музыка', youtube: 'YouTube' };

function trackSource(id) {
  if (typeof id !== 'string' || !TRACK_ID.test(id)) throw new Error('Некорректный ID трека');
  return /^soundcloud-\d+$/.test(id) ? 'soundcloud' : /^yandexmusic-\d+$/.test(id) ? 'yandex' : 'youtube';
}

function onlineTarget(query, source = 'all') {
  if (typeof query !== 'string' || !query.trim() || query.length > 300) throw new Error('Введите название или ссылку на трек (до 300 символов)');
  if (source !== 'all' && !Object.hasOwn(SOURCES, source)) throw new Error('Неизвестный источник музыки');
  query = query.trim();
  if (/^(https?:\/\/|www\.|[\w.-]+\.[a-z]{2,}\/)/i.test(query)) {
    let url;
    try { url = new URL(/^https?:\/\//i.test(query) ? query : `https://${query}`); } catch { throw new Error('Некорректная ссылка на трек'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('Используйте HTTPS-ссылку без пароля и нестандартного порта');
    const host = url.hostname.toLowerCase();
    if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(host)) {
      const id = host === 'youtu.be' ? url.pathname.slice(1) : url.pathname === '/watch' ? url.searchParams.get('v') : /^\/(shorts|embed)\//.test(url.pathname) ? url.pathname.split('/')[2] : '';
      if (!VIDEO_ID.test(id || '')) throw new Error('Нужна ссылка на один трек, а не плейлист');
      return { source: 'youtube', target: `https://www.youtube.com/watch?v=${id}` };
    }
    if (['soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com'].includes(host)) {
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length !== 2 || parts.some(part => !/^[\w-]+$/.test(part)) || ['sets', 'likes', 'tracks', 'albums', 'reposts', 'popular-tracks'].includes(parts[1]) || ['discover', 'search', 'charts', 'stations', 'you'].includes(parts[0])) throw new Error('Вставьте ссылку SoundCloud на один трек, а не профиль или подборку');
      return { source: 'soundcloud', target: `https://soundcloud.com/${parts.join('/')}` };
    }
    if (/^music\.yandex\.(ru|com|kz|by|ua|uz)$/.test(host)) {
      const match = url.pathname.match(/^\/(?:album\/\d{1,20}\/)?track\/(\d{1,20})\/?$/);
      if (!match) throw new Error('Вставьте ссылку Яндекс Музыки на один трек');
      return { source: 'yandex', target: match[1] };
    }
    throw new Error('Поддерживаются ссылки SoundCloud, Яндекс Музыки и YouTube');
  }
  if (/^[\w-]+:/.test(query) || query.startsWith('//')) throw new Error('Введите название или HTTPS-ссылку на трек');
  return { source, query };
}

function youtubeTarget(query) {
  const parsed = onlineTarget(query, 'youtube');
  if (parsed.source !== 'youtube') throw new Error('Нужна ссылка YouTube');
  return parsed.target || `ytsearch10:${parsed.query}`;
}

function normalizeResult(item, source = 'youtube') {
  if (!item || !Object.hasOwn(SOURCES, source) || item.is_live || ['is_live', 'is_upcoming', 'post_live'].includes(item.live_status)) return null;
  const id = String(item.id || '');
  if (!(source === 'youtube' ? VIDEO_ID : /^\d{1,20}$/).test(id)) return null;
  const duration = Number(item.duration) || 0;
  if (duration < 0 || duration > MAX_DURATION || !Number.isFinite(duration)) return null;
  let sourceUrl = source === 'youtube' ? `https://www.youtube.com/watch?v=${id}` : source === 'yandex' ? `https://music.yandex.ru/track/${id}` : item.webpage_url || item.sourceUrl;
  if (source !== 'youtube') {
    try {
      const parsed = onlineTarget(sourceUrl);
      if (parsed.source !== source || (source === 'yandex' && parsed.target !== id)) return null;
      if (source === 'soundcloud') sourceUrl = parsed.target;
    } catch { return null; }
  }
  return {
    onlineId: source === 'youtube' ? id : `${source === 'soundcloud' ? 'soundcloud' : 'yandexmusic'}-${id}`,
    source,
    title: String(item.title || 'Без названия').slice(0, 200),
    artist: String(item.artist || item.channel || item.uploader || SOURCES[source]).slice(0, 200),
    duration,
    sourceUrl
  };
}

function sourceError(stderr, source = '', operation = 'audio') {
  const name = SOURCES[source] || 'Источник';
  if (/ENOSPC|No space left|not enough space/i.test(stderr)) return 'Недостаточно места на диске';
  if (source === 'soundcloud' && /requested format.*not available/i.test(stderr)) return 'SoundCloud: полная запись недоступна, источник может предлагать только превью. Откройте «Аккаунты» или выберите другой результат';
  if (/captcha|sign in|login|bot|premium|subscription|403|401/i.test(stderr)) return `${name}: требуется вход или доступ к полной записи. Откройте «Аккаунты» в музыке онлайн. Доступ также зависит от подписки и региона`;
  if (/429|too many requests/i.test(stderr)) return `${name}: слишком много запросов. Повторите позже или выберите другой источник`;
  if (/not available|unavailable|private|blocked|404|geo.?restrict/i.test(stderr)) return `${name}: трек недоступен или удалён. Попробуйте другой результат`;
  return `${name}: не удалось ${operation === 'search' ? 'выполнить поиск' : 'получить аудио'}. Проверьте сеть или выберите другой источник`;
}

async function fetchJson(url, { signal, headers } = {}) {
  let response;
  try { response = await fetch(url, { headers, signal: AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]), redirect: 'error' }); }
  catch { throw new Error(signal?.aborted ? 'Запрос отменён' : 'Яндекс Музыка не ответила. Проверьте сеть или повторите позже'); }
  if (!response.ok) throw new Error(sourceError(String(response.status), 'yandex'));
  let size = 0;
  const chunks = [];
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) throw new Error('Слишком большой ответ источника');
      chunks.push(chunk);
    }
  } catch (error) {
    if (['AbortError', 'TimeoutError', 'TypeError'].includes(error.name)) throw new Error('Ответ Яндекс Музыки прерван. Повторите поиск');
    throw error;
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('Яндекс Музыка вернула непонятный ответ. Повторите позже'); }
}

function yandexMetadata(item) {
  return normalizeResult({ id: item?.id, title: item?.title, artist: item?.artists?.map(artist => artist.name).filter(Boolean).join(', '), duration: Number(item?.durationMs) / 1000 }, 'yandex');
}

function yandexDownloadUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Яндекс Музыка вернула некорректную ссылку на аудио'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !/(?:^|\.)(?:storage\.yandex\.net|music\.yandex\.net|music\.yandex\.ru)$/.test(url.hostname)) throw new Error('Яндекс Музыка вернула неподдерживаемый адрес аудио');
  return url;
}

function runProcess(binary, args, { signal, onLine = () => {}, timeout = 120000, source, operation } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Подготовка отменена'));
    const child = spawn(binary, args, { shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', pending = '', failure;
    const kill = () => {
      if (!child.pid) return;
      if (process.platform === 'win32') execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => { try { child.kill('SIGKILL'); } catch {} });
      else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    };
    const stop = () => { failure = new Error('Подготовка отменена'); kill(); };
    const timer = setTimeout(() => { failure = new Error('Источник не ответил вовремя. Повторите попытку'); kill(); }, timeout);
    signal?.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', data => {
      stdout += data.toString();
      pending += data.toString();
      const lines = pending.split(/\r?\n/); pending = lines.pop();
      lines.forEach(onLine);
      if (stdout.length > 4 * 1024 * 1024) { failure = new Error('Слишком большой ответ источника'); kill(); }
    });
    child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-6000); });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); };
    child.on('error', error => { cleanup(); reject(new Error(error.code === 'ENOENT' ? 'Инструменты поиска отсутствуют. Переустановите CAS или выполните npm run prepare:online' : 'Не удалось запустить инструменты поиска')); });
    child.on('close', code => {
      cleanup();
      if (failure) return reject(failure);
      if (code !== 0) {
        return reject(new Error(sourceError(stderr, source, operation)));
      }
      resolve(stdout);
    });
  });
}

class OnlineMusic {
  constructor({ root, toolsRoot, platform = process.platform, arch = process.arch, run = runProcess, request = fetchJson, credentials = async () => ({}) }) {
    this.root = root;
    this.toolsPath = path.join(toolsRoot, `${platform}-${arch}`);
    this.ext = platform === 'win32' ? '.exe' : '';
    this.run = run;
    this.request = request;
    this.credentials = credentials;
    this.searchController = null;
    this.knownTracks = new Map();
    this.tasks = new Map();
    this.tail = Promise.resolve();
    this.ready = null;
  }

  binary(name) { return path.join(this.toolsPath, name + this.ext); }

  initialize() {
    if (!this.ready) this.ready = (async () => {
      await fs.mkdir(this.root, { recursive: true });
      this.root = await fs.realpath(this.root);
      // Only unfinished jobs are removed; completed user audio is preserved.
      for (const name of await fs.readdir(this.root)) {
        if (name.startsWith('job-') && TRACK_ID.test(name.slice(4))) await fs.rm(path.join(this.root, name), { recursive: true, force: true });
      }
    })();
    return this.ready;
  }

  baseArgs() {
    return ['--ignore-config', '--no-cache-dir', '--no-playlist', '--no-warnings', '--socket-timeout', '15', '--retries', '1', '--extractor-retries', '1', '--no-js-runtimes', '--js-runtimes', `deno:${this.binary('deno')}`];
  }

  async runDownloader(args, options) {
    const { cookies } = await this.credentials(options.source);
    if (options.signal?.aborted) throw new Error('Подготовка отменена');
    if (!cookies) return this.run(this.binary('yt-dlp'), [...this.baseArgs(), ...args], options);
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'cas-online-auth-'));
    try {
      const file = path.join(folder, 'cookies.txt');
      await fs.writeFile(file, cookies, { mode: 0o600 });
      return await this.run(this.binary('yt-dlp'), [...this.baseArgs(), '--cookies', file, ...args], options);
    } finally { await fs.rm(folder, { recursive: true, force: true }); }
  }

  async requestYandex(url, signal) {
    const { token } = await this.credentials('yandex');
    return this.request(url, { signal, headers: token ? { Authorization: `OAuth ${token}` } : {} });
  }

  async search(request) {
    const parsed = onlineTarget(typeof request === 'string' ? request : request?.query, typeof request === 'string' ? 'all' : request?.source || 'all');
    this.cancelSearch();
    const controller = new AbortController();
    this.searchController = controller;
    const signal = controller.signal;
    const sources = parsed.source === 'all' ? Object.keys(SOURCES) : [parsed.source];
    try {
      const responses = await Promise.allSettled(sources.map(async source => {
        if (source === 'yandex') {
          const endpoint = parsed.target ? `/tracks/${parsed.target}` : `/search?${new URLSearchParams({ text: parsed.query, type: 'track', page: '0', 'page-size': '10' })}`;
          const response = await this.requestYandex(`https://api.music.yandex.net${endpoint}`, signal);
          if (response.error || !response.result) throw new Error('Яндекс Музыка: поиск сейчас недоступен');
          const items = parsed.target ? response.result : response.result.tracks?.results || [];
          return items.filter(item => item.available !== false).map(yandexMetadata).filter(Boolean).slice(0, 10);
        }
        const target = parsed.target || `${source === 'soundcloud' ? 'sc' : 'yt'}search10:${parsed.query}`;
        const output = await this.runDownloader(['--flat-playlist', '--dump-single-json', '--skip-download', '--', target], { signal, source, operation: 'search', timeout: 30000 });
        let response;
        try { response = JSON.parse(output); } catch { throw new Error(`${SOURCES[source]}: источник вернул непонятный ответ`); }
        return (response.entries || [response]).map(item => normalizeResult(item, source)).filter(Boolean).slice(0, 10);
      }));
      if (signal.aborted) throw new Error('Поиск отменён');
      const warnings = responses.flatMap((response, i) => response.status === 'rejected' ? [{ source: sources[i], message: `${SOURCES[sources[i]]}: ${response.reason.message}`.replace(`${SOURCES[sources[i]]}: ${SOURCES[sources[i]]}: `, `${SOURCES[sources[i]]}: `) }] : []);
      if (responses.every(response => response.status === 'rejected')) throw new Error(warnings.map(warning => warning.message).join('\n'));
      // Interleave providers so a slow or unavailable source never hides the others.
      const tracks = [];
      const seen = new Set();
      for (let index = 0; index < 10; index++) for (const response of responses) {
        const track = response.status === 'fulfilled' && response.value[index];
        if (track && !seen.has(track.onlineId)) { seen.add(track.onlineId); tracks.push(track); }
      }
      for (const track of tracks) this.knownTracks.set(track.onlineId, track);
      while (this.knownTracks.size > 500) this.knownTracks.delete(this.knownTracks.keys().next().value);
      return { tracks, warnings, source: parsed.source };
    } finally { if (this.searchController === controller) this.searchController = null; }
  }

  cancelSearch() { this.searchController?.abort(); }

  async get(id) {
    const source = trackSource(id);
    await this.initialize();
    try {
      const item = JSON.parse(await fs.readFile(path.join(this.root, `${id}.json`), 'utf8'));
      const filePath = path.join(this.root, `${id}.m4a`);
      const real = await fs.realpath(filePath);
      const stats = await fs.stat(real);
      if (real !== filePath || !stats.isFile()) return null;
      const metadata = normalizeResult({ ...item, id: source === 'youtube' ? id : id.slice(id.indexOf('-') + 1) }, source);
      return metadata ? { ...metadata, fullAudioValidated: item.fullAudioValidated === 1, path: real, filename: `${id}.m4a`, name: metadata.title, ext: '.m4a', size: stats.size } : null;
    } catch { return null; }
  }

  async list() {
    await this.initialize();
    const names = await fs.readdir(this.root);
    return (await Promise.all(names.filter(name => name.endsWith('.json') && TRACK_ID.test(name.slice(0, -5))).map(name => this.get(name.slice(0, -5))))).filter(Boolean);
  }

  async resolve(filePath) {
    await this.initialize();
    if (typeof filePath !== 'string' || path.dirname(filePath) !== this.root || path.extname(filePath) !== '.m4a' || !TRACK_ID.test(path.basename(filePath, '.m4a'))) return null;
    return this.get(path.basename(filePath, '.m4a'));
  }

  cancel(id) { this.tasks.get(id)?.abort(); }
  async remove(id) {
    if (this.tasks.has(id)) throw new Error('Дождитесь завершения подготовки');
    const track = await this.get(id);
    if (!track) throw new Error('Трек уже удалён');
    await fs.unlink(path.join(this.root, `${id}.json`));
    await fs.unlink(track.path);
    return true;
  }
  dispose() { this.cancelSearch(); for (const task of this.tasks.values()) task.abort(); }

  async downloadYandex(id, folder, signal) {
    const rawId = id.slice('yandexmusic-'.length);
    const response = await this.requestYandex(`https://api.music.yandex.net/tracks/${rawId}`, signal);
    const item = response.result?.find(track => String(track.id) === rawId);
    const metadata = yandexMetadata(item);
    if (!metadata || item.available === false) throw new Error('Яндекс Музыка: трек недоступен');
    const downloads = await this.requestYandex(`https://api.music.yandex.net/tracks/${rawId}/download-info`, signal);
    const full = downloads.result?.filter(format => format.preview === false && format.codec === 'mp3').sort((a, b) => b.bitrateInKbps - a.bitrateInKbps)[0];
    if (!full) throw new Error('Яндекс Музыка не предоставила полную запись. Фрагмент не загружен. Откройте «Аккаунты» и войдите в аккаунт с доступом к треку');
    const infoUrl = yandexDownloadUrl(full.downloadInfoUrl);
    infoUrl.searchParams.set('format', 'json');
    const info = await this.request(infoUrl.href, { signal });
    if (typeof info.path !== 'string' || !/^\/[\w/.-]+$/.test(info.path) || !/^\d+$/.test(String(info.ts)) || typeof info.s !== 'string') throw new Error('Яндекс Музыка вернула некорректные данные аудио');
    const hash = createHash('md5').update('XGRlBW9FXlekgbPrRHuSiA' + info.path.slice(1) + info.s).digest('hex');
    const audioUrl = yandexDownloadUrl(`https://${info.host}/get-mp3/${hash}/${info.ts}${info.path}`);
    // Only the provider's verified full recording reaches the generic downloader.
    const output = await this.run(this.binary('yt-dlp'), [...this.baseArgs(), '--force-generic-extractor', '--max-filesize', String(MAX_BYTES), '--print', 'after_move:CAS_FILE:%(filepath)s', '-o', path.join(folder, 'audio.mp3'), '--', audioUrl.href], { signal, source: 'yandex', timeout: 180000 });
    return { output, metadata };
  }

  prepare(id, onProgress = () => {}) {
    if (typeof id !== 'string' || !TRACK_ID.test(id)) return Promise.reject(new Error('Некорректный ID трека'));
    if (this.tasks.has(id)) return Promise.reject(new Error('Этот трек уже подготавливается'));
    if (this.tasks.size >= 10) return Promise.reject(new Error('Очередь заполнена (максимум 10 треков)'));
    const controller = new AbortController();
    this.tasks.set(id, controller);
    onProgress({ id, stage: 'queued' });
    const task = this.tail.then(async () => {
      if (controller.signal.aborted) throw new Error('Подготовка отменена');
      const source = trackSource(id);
      const cached = await this.get(id);
      // Older imports could save a SoundCloud preview whose own metadata says 30s.
      // Retry those after login; preserve the old file until a full replacement succeeds.
      const suspectPreview = source === 'soundcloud' && cached && !cached.fullAudioValidated && cached.duration <= 35;
      const expectedDuration = this.knownTracks.get(id)?.duration || 0;
      const shorterThanSearch = cached && expectedDuration > cached.duration + Math.max(2, expectedDuration * .05);
      if (cached && !suspectPreview && !shorterThanSearch) return cached;
      const folder = path.join(this.root, `job-${id}`);
      await fs.mkdir(folder, { recursive: true });
      const signal = controller.signal;
      const sourceUrl = this.knownTracks.get(id)?.sourceUrl || cached?.sourceUrl;
      try {
        onProgress({ id, stage: 'downloading' });
        let output, metadata;
        if (source === 'yandex') ({ output, metadata } = await this.downloadYandex(id, folder, signal));
        else output = await this.runDownloader(['--restrict-filenames', '--max-filesize', String(MAX_BYTES), '--match-filters', `!is_live & duration <= ${MAX_DURATION}`, '-f', 'bestaudio[ext=m4a][format_id!*=preview]/bestaudio[format_id!*=preview]', '--write-info-json', '--no-simulate', '--newline', '--progress', '--progress-template', 'download:CAS_PROGRESS:%(progress._percent_str)s', '--print', 'after_move:CAS_FILE:%(filepath)s', '-o', path.join(folder, 'audio.%(ext)s'), '--', source === 'youtube' ? `https://www.youtube.com/watch?v=${id}` : sourceUrl || `https://api.soundcloud.com/tracks/${id.slice('soundcloud-'.length)}`], {
          signal, source, timeout: 180000,
          onLine: line => { if (line.startsWith('CAS_PROGRESS:')) onProgress({ id, stage: 'downloading', percent: Math.min(100, Math.max(0, parseFloat(line.slice(13)) || 0)) }); }
        });
        const audioPath = output.split(/\r?\n/).find(line => line.startsWith('CAS_FILE:'))?.slice(9).trim();
        if (!audioPath || path.dirname(audioPath) !== folder || !/^audio\.(m4a|webm|opus|ogg|mp3|aac)$/.test(path.basename(audioPath))) throw new Error('Источник не предоставил подходящий аудиофайл (до 30 минут)');
        const realAudio = await fs.realpath(audioPath);
        if (realAudio !== audioPath || (await fs.stat(realAudio)).size > MAX_BYTES) throw new Error('Аудиофайл превышает допустимый размер');
        if (!metadata) {
          const info = JSON.parse(await fs.readFile(path.join(folder, 'audio.info.json'), 'utf8'));
          const selected = [info, ...(info.requested_downloads || [])];
          if (selected.some(format => /preview|snippet/i.test(`${format.format_id || ''} ${format.format || ''} ${format.format_note || ''}`))) throw new Error(`${SOURCES[source]} предоставил только фрагмент записи. Откройте «Аккаунты» или выберите другой источник`);
          metadata = normalizeResult(info, source);
        }
        if (!metadata || metadata.onlineId !== id) throw new Error('Метаданные трека не прошли проверку');
        metadata.duration = Math.max(metadata.duration, this.knownTracks.get(id)?.duration || 0);
        onProgress({ id, stage: 'processing' });
        const codec = path.extname(realAudio) === '.m4a' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k'];
        const conversion = await this.run(this.binary('ffmpeg'), ['-nostdin', '-hide_banner', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats', '-protocol_whitelist', 'file,pipe', '-i', realAudio, '-map', '0:a:0', '-vn', '-t', String(MAX_DURATION), ...codec, '-metadata', `title=${metadata.title}`, '-metadata', `artist=${metadata.artist}`, '-movflags', '+faststart', '-y', path.join(folder, 'ready.m4a')], { signal, source });
        const elapsed = [...conversion.matchAll(/out_time_us=(\d+)/g)].at(-1)?.[1];
        if ((source !== 'youtube' && (!elapsed || Number(elapsed) <= 0)) || (elapsed && metadata.duration > 0 && Number(elapsed) / 1000000 < metadata.duration - Math.max(2, metadata.duration * 0.05))) throw new Error(`${SOURCES[source]} предоставил неполную запись. Фрагмент не сохранён; откройте «Аккаунты» или выберите другой источник`);
        if (signal.aborted) throw new Error('Подготовка отменена');
        const size = (await fs.stat(path.join(folder, 'ready.m4a'))).size;
        if (size < 32 || size > MAX_BYTES) throw new Error('Не удалось подготовить аудиофайл');
        await fs.writeFile(path.join(folder, 'ready.json'), JSON.stringify({ ...metadata, fullAudioValidated: 1 }));
        await fs.rename(path.join(folder, 'ready.m4a'), path.join(this.root, `${id}.m4a`));
        await fs.rename(path.join(folder, 'ready.json'), path.join(this.root, `${id}.json`));
        return this.get(id);
      } finally { await fs.rm(folder, { recursive: true, force: true }); }
    }).finally(() => this.tasks.delete(id));
    this.tail = task.catch(() => {});
    return task;
  }
}

module.exports = { OnlineMusic, youtubeTarget, onlineTarget, normalizeResult, runProcess, sourceError, trackSource };
