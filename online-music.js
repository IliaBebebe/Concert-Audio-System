const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const MAX_BYTES = 250 * 1024 * 1024;
const MAX_DURATION = 30 * 60;

function youtubeTarget(query) {
  if (typeof query !== 'string' || !query.trim() || query.length > 300) throw new Error('Введите название или ссылку YouTube (до 300 символов)');
  query = query.trim();
  if (/^(https?:\/\/|www\.|[\w.-]+\.[a-z]{2,}\/)/i.test(query)) {
    let url;
    try { url = new URL(query.startsWith('http') ? query : `https://${query}`); } catch { throw new Error('Некорректная ссылка YouTube'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('Поддерживаются только HTTPS-ссылки YouTube');
    const host = url.hostname.toLowerCase();
    if (!['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(host)) throw new Error('Поддерживаются только ссылки YouTube и YouTube Music');
    const id = host === 'youtu.be' ? url.pathname.slice(1) : url.pathname === '/watch' ? url.searchParams.get('v') : /^\/(shorts|embed)\//.test(url.pathname) ? url.pathname.split('/')[2] : '';
    if (!VIDEO_ID.test(id || '')) throw new Error('Нужна ссылка на один трек, а не плейлист');
    return `https://www.youtube.com/watch?v=${id}`;
  }
  if (/^[\w-]+:/.test(query)) throw new Error('Введите название или HTTPS-ссылку YouTube');
  return `ytsearch10:${query}`;
}

function normalizeResult(item) {
  if (!VIDEO_ID.test(item?.id || '') || item.is_live || item.live_status === 'is_live') return null;
  const duration = Number(item.duration) || 0;
  if (duration > MAX_DURATION) return null;
  return {
    onlineId: item.id,
    title: String(item.title || 'Без названия').slice(0, 200),
    artist: String(item.artist || item.channel || item.uploader || 'YouTube').slice(0, 200),
    duration,
    sourceUrl: `https://www.youtube.com/watch?v=${item.id}`
  };
}

function runProcess(binary, args, { signal, onLine = () => {}, timeout = 120000 } = {}) {
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
        const reason = /ENOSPC|No space left|not enough space/i.test(stderr) ? 'Недостаточно места на диске' : /sign in|bot|403|429|not available|unavailable|private|blocked/i.test(stderr) ? 'YouTube ограничил доступ к треку. Попробуйте другой результат или повторите позже' : 'Не удалось получить аудио. Проверьте сеть и доступность трека';
        return reject(new Error(reason));
      }
      resolve(stdout);
    });
  });
}

class OnlineMusic {
  constructor({ root, toolsRoot, platform = process.platform, arch = process.arch, run = runProcess }) {
    this.root = root;
    this.toolsPath = path.join(toolsRoot, `${platform}-${arch}`);
    this.ext = platform === 'win32' ? '.exe' : '';
    this.run = run;
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
        if (/^job-[A-Za-z0-9_-]{11}$/.test(name)) await fs.rm(path.join(this.root, name), { recursive: true, force: true });
      }
    })();
    return this.ready;
  }

  baseArgs() {
    return ['--ignore-config', '--no-cache-dir', '--no-playlist', '--no-warnings', '--socket-timeout', '15', '--retries', '1', '--extractor-retries', '1', '--no-js-runtimes', '--js-runtimes', `deno:${this.binary('deno')}`];
  }

  async search(query) {
    const target = youtubeTarget(query);
    const output = await this.run(this.binary('yt-dlp'), [...this.baseArgs(), '--flat-playlist', '--dump-single-json', '--skip-download', '--', target], { timeout: 60000 });
    let parsed;
    try { parsed = JSON.parse(output); } catch { throw new Error('Источник вернул непонятный ответ'); }
    return (parsed.entries || [parsed]).map(normalizeResult).filter(Boolean).slice(0, 10);
  }

  async get(id) {
    if (!VIDEO_ID.test(id || '')) throw new Error('Некорректный ID трека');
    await this.initialize();
    try {
      const item = JSON.parse(await fs.readFile(path.join(this.root, `${id}.json`), 'utf8'));
      const filePath = path.join(this.root, `${id}.m4a`);
      const real = await fs.realpath(filePath);
      const stats = await fs.stat(real);
      if (real !== filePath || !stats.isFile()) return null;
      const metadata = normalizeResult({ ...item, id });
      return metadata ? { ...metadata, path: real, filename: `${id}.m4a`, name: metadata.title, ext: '.m4a', size: stats.size } : null;
    } catch { return null; }
  }

  async list() {
    await this.initialize();
    const names = await fs.readdir(this.root);
    return (await Promise.all(names.filter(name => /^[A-Za-z0-9_-]{11}\.json$/.test(name)).map(name => this.get(name.slice(0, 11))))).filter(Boolean);
  }

  async resolve(filePath) {
    await this.initialize();
    if (typeof filePath !== 'string' || path.dirname(filePath) !== this.root || !/^[A-Za-z0-9_-]{11}\.m4a$/.test(path.basename(filePath))) return null;
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
  dispose() { for (const task of this.tasks.values()) task.abort(); }

  prepare(id, onProgress = () => {}) {
    if (!VIDEO_ID.test(id || '')) return Promise.reject(new Error('Некорректный ID трека'));
    if (this.tasks.has(id)) return Promise.reject(new Error('Этот трек уже подготавливается'));
    if (this.tasks.size >= 10) return Promise.reject(new Error('Очередь заполнена (максимум 10 треков)'));
    const controller = new AbortController();
    this.tasks.set(id, controller);
    onProgress({ id, stage: 'queued' });
    const task = this.tail.then(async () => {
      if (controller.signal.aborted) throw new Error('Подготовка отменена');
      const cached = await this.get(id);
      if (cached) return cached;
      const folder = path.join(this.root, `job-${id}`);
      await fs.mkdir(folder, { recursive: true });
      const signal = controller.signal;
      try {
        onProgress({ id, stage: 'downloading' });
        const output = await this.run(this.binary('yt-dlp'), [...this.baseArgs(), '--restrict-filenames', '--max-filesize', String(MAX_BYTES), '--match-filters', `!is_live & duration <= ${MAX_DURATION}`, '-f', 'bestaudio[ext=m4a]/bestaudio', '--write-info-json', '--no-simulate', '--newline', '--progress', '--progress-template', 'download:CAS_PROGRESS:%(progress._percent_str)s', '--print', 'after_move:CAS_FILE:%(filepath)s', '-o', path.join(folder, 'audio.%(ext)s'), '--', `https://www.youtube.com/watch?v=${id}`], {
          signal, timeout: 180000,
          onLine: line => { if (line.startsWith('CAS_PROGRESS:')) onProgress({ id, stage: 'downloading', percent: Math.min(100, Math.max(0, parseFloat(line.slice(13)) || 0)) }); }
        });
        const audioPath = output.split(/\r?\n/).find(line => line.startsWith('CAS_FILE:'))?.slice(9).trim();
        if (!audioPath || path.dirname(audioPath) !== folder || !/^audio\.(m4a|webm|opus|ogg|mp3|aac)$/.test(path.basename(audioPath))) throw new Error('Источник не предоставил подходящий аудиофайл (до 30 минут)');
        const realAudio = await fs.realpath(audioPath);
        if (realAudio !== audioPath || (await fs.stat(realAudio)).size > MAX_BYTES) throw new Error('Аудиофайл превышает допустимый размер');
        const info = JSON.parse(await fs.readFile(path.join(folder, 'audio.info.json'), 'utf8'));
        const metadata = normalizeResult(info);
        if (!metadata || metadata.onlineId !== id) throw new Error('Метаданные трека не прошли проверку');
        onProgress({ id, stage: 'processing' });
        const codec = path.extname(realAudio) === '.m4a' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k'];
        await this.run(this.binary('ffmpeg'), ['-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file,pipe', '-i', realAudio, '-map', '0:a:0', '-vn', '-t', String(MAX_DURATION), ...codec, '-metadata', `title=${metadata.title}`, '-metadata', `artist=${metadata.artist}`, '-movflags', '+faststart', '-y', path.join(folder, 'ready.m4a')], { signal });
        if (signal.aborted) throw new Error('Подготовка отменена');
        const size = (await fs.stat(path.join(folder, 'ready.m4a'))).size;
        if (size < 32 || size > MAX_BYTES) throw new Error('Не удалось подготовить аудиофайл');
        await fs.writeFile(path.join(folder, 'ready.json'), JSON.stringify(metadata));
        await fs.rename(path.join(folder, 'ready.m4a'), path.join(this.root, `${id}.m4a`));
        await fs.rename(path.join(folder, 'ready.json'), path.join(this.root, `${id}.json`));
        return this.get(id);
      } finally { await fs.rm(folder, { recursive: true, force: true }); }
    }).finally(() => this.tasks.delete(id));
    this.tail = task.catch(() => {});
    return task;
  }
}

module.exports = { OnlineMusic, youtubeTarget, normalizeResult, runProcess };
