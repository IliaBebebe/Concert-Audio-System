const { app, BrowserWindow, ipcMain, dialog, screen, Menu, session } = require('electron');
const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');
const fs = require('node:fs/promises');
const { Worker } = require('node:worker_threads');

const DEFAULT_WINDOW_WIDTH = 1400;
const DEFAULT_WINDOW_HEIGHT = 900;
const MIN_WINDOW_WIDTH = 1000;
const MIN_WINDOW_HEIGHT = 700;
const WELCOME_WINDOW_WIDTH = 600;
const WELCOME_WINDOW_HEIGHT = 440;
const SAVE_STATE_DEBOUNCE_MS = 500;
const WINDOW_SHOW_FALLBACK_MS = 1000;
const METADATA_TIMEOUT_MS = 10000;
const METADATA_CONCURRENCY = 2;
const MAX_METADATA_FILE_SIZE = 1024 * 1024 * 1024;
const MAX_METADATA_CACHE_ENTRIES = 256;
const MAX_METADATA_TEXT_LENGTH = 200;
const MAX_WAVEFORM_FILE_SIZE = 350 * 1024 * 1024;
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac', '.opus', '.webm']);

const appRootPath = path.resolve(__dirname);
const configPath = path.join(app.getPath('userData'), 'config.json');
const windowStatePath = path.join(app.getPath('userData'), 'window-state.json');
const metadataWorkerPath = path.join(__dirname, 'metadata-worker.js');
const appIconPath = path.join(__dirname, 'assets', 'app-icon.ico');
const isDev = process.argv.includes('--dev');

let mainWindow = null;
let welcomeWindow = null;
let cachedConfig = null;
let configLoadPromise = null;
let configWriteQueue = Promise.resolve();
let windowStateWriteQueue = Promise.resolve();
let metadataWorkersRunning = 0;
const metadataQueue = [];
const metadataCache = new Map();
const metadataInFlight = new Map();

let windowState = {
  width: DEFAULT_WINDOW_WIDTH,
  height: DEFAULT_WINDOW_HEIGHT,
  x: undefined,
  y: undefined,
  isMaximized: false
};

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPathInside(childPath, parentPath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

function isSupportedAudioFile(filePath) {
  return typeof filePath === 'string' && AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function getTrackMetadataKey(filePath, musicFolder) {
  return path.relative(path.resolve(musicFolder), path.resolve(filePath)).split(path.sep).join('/');
}

function normalizeTrackMetadata(metadata = {}) {
  if (!isPlainObject(metadata)) {
    return {};
  }

  const normalized = {};
  const title = typeof metadata.title === 'string' ? metadata.title.trim().slice(0, MAX_METADATA_TEXT_LENGTH) : '';
  const artist = typeof metadata.artist === 'string' ? metadata.artist.trim().slice(0, MAX_METADATA_TEXT_LENGTH) : '';
  const rawTrackNumber = typeof metadata.trackNumber === 'number' || typeof metadata.trackNumber === 'string'
    ? String(metadata.trackNumber).trim()
    : '';

  if (title) normalized.title = title;
  if (artist) normalized.artist = artist;

  if (/^[1-9]\d{0,4}$/.test(rawTrackNumber)) {
    normalized.trackNumber = Number(rawTrackNumber);
  }

  return normalized;
}

function normalizeTrackMetadataOverrides(overrides) {
  const normalized = Object.create(null);
  if (!isPlainObject(overrides)) {
    return normalized;
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (typeof key !== 'string' || !key || key.length > 1024) {
      continue;
    }

    const metadata = normalizeTrackMetadata(value);
    if (Object.keys(metadata).length > 0) {
      normalized[key] = metadata;
    }
  }

  return normalized;
}

function createDefaultConfig() {
  return {
    musicFolder: null,
    firstRun: true,
    trackMetadataOverrides: Object.create(null)
  };
}

function normalizeConfig(config) {
  const source = isPlainObject(config) ? config : {};
  const musicFolder = typeof source.musicFolder === 'string' && source.musicFolder.trim()
    ? source.musicFolder
    : null;

  return {
    musicFolder,
    firstRun: typeof source.firstRun === 'boolean' ? source.firstRun : !musicFolder,
    trackMetadataOverrides: normalizeTrackMetadataOverrides(source.trackMetadataOverrides)
  };
}

function applyTrackMetadataOverride(track, override) {
  const cleanOverride = normalizeTrackMetadata(override);
  const result = { ...track, metadataOverride: cleanOverride };

  if (cleanOverride.title) result.title = cleanOverride.title;
  if (cleanOverride.artist) result.artist = cleanOverride.artist;
  if (cleanOverride.trackNumber) result.trackNumber = cleanOverride.trackNumber;

  return result;
}

function queueWrite(queueName, operation) {
  const queued = queueName === 'config'
    ? configWriteQueue.then(operation, operation)
    : windowStateWriteQueue.then(operation, operation);

  if (queueName === 'config') {
    configWriteQueue = queued.catch(() => {});
  } else {
    windowStateWriteQueue = queued.catch(() => {});
  }

  return queued;
}

async function writeJsonAtomically(targetPath, value) {
  const tempPath = targetPath + '.' + process.pid + '.' + Date.now() + '.tmp';
  const content = JSON.stringify(value, null, 2);

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  try {
    await fs.writeFile(tempPath, content, 'utf8');
    await fs.rename(tempPath, targetPath);
  } catch (error) {
    await fs.unlink(tempPath).catch(() => {});
    throw error;
  }
}

async function preserveBrokenConfig() {
  const backupPath = configPath + '.corrupt-' + new Date().toISOString().replace(/[:.]/g, '-');
  try {
    await fs.rename(configPath, backupPath);
    console.warn('Invalid config moved to:', backupPath);
  } catch (error) {
    console.warn('Failed to preserve invalid config:', error.message);
  }
}

async function loadConfig() {
  if (cachedConfig) {
    return cloneJson(cachedConfig);
  }

  if (!configLoadPromise) {
    configLoadPromise = (async () => {
      try {
        const configData = await fs.readFile(configPath, 'utf8');
        const parsedConfig = JSON.parse(configData);
        cachedConfig = normalizeConfig(parsedConfig);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          console.warn('Failed to load config:', error.message);
          await preserveBrokenConfig();
        }
        cachedConfig = createDefaultConfig();
      }

      return cloneJson(cachedConfig);
    })();
  }

  return configLoadPromise;
}

async function updateConfig(mutator) {
  return queueWrite('config', async () => {
    const currentConfig = await loadConfig();
    const nextConfig = normalizeConfig(currentConfig);
    await mutator(nextConfig);

    const normalizedConfig = normalizeConfig(nextConfig);
    await writeJsonAtomically(configPath, normalizedConfig);
    cachedConfig = normalizedConfig;
    return cloneJson(normalizedConfig);
  });
}

async function validateMusicFolder(folderPath) {
  if (typeof folderPath !== 'string' || !folderPath.trim()) {
    throw new Error('Папка с музыкой не выбрана');
  }

  const resolvedPath = await fs.realpath(folderPath);
  const stats = await fs.stat(resolvedPath);
  if (!stats.isDirectory()) {
    throw new Error('Указанный путь не является папкой');
  }

  return resolvedPath;
}

async function updateMusicFolder(folderPath) {
  const resolvedPath = await validateMusicFolder(folderPath);
  await updateConfig((config) => {
    const folderChanged = config.musicFolder !== resolvedPath;
    config.musicFolder = resolvedPath;
    config.firstRun = false;

    // Relative override keys must never be reused for a different music library.
    if (folderChanged) {
      config.trackMetadataOverrides = Object.create(null);
    }
  });
  return resolvedPath;
}

function rectanglesIntersect(first, second) {
  return first.x < second.x + second.width
    && first.x + first.width > second.x
    && first.y < second.y + second.height
    && first.y + first.height > second.y;
}

function normalizeWindowState(state) {
  const displays = screen.getAllDisplays();
  const primaryWorkArea = screen.getPrimaryDisplay().workArea;
  const defaultSize = {
    width: Math.min(DEFAULT_WINDOW_WIDTH, primaryWorkArea.width),
    height: Math.min(DEFAULT_WINDOW_HEIGHT, primaryWorkArea.height)
  };
  const nextState = {
    width: defaultSize.width,
    height: defaultSize.height,
    x: undefined,
    y: undefined,
    isMaximized: Boolean(state?.isMaximized)
  };

  if (Number.isInteger(state?.width) && Number.isInteger(state?.height)) {
    const displayThatFits = displays.find((display) => (
      state.width >= Math.min(MIN_WINDOW_WIDTH, display.workArea.width)
      && state.height >= Math.min(MIN_WINDOW_HEIGHT, display.workArea.height)
      && state.width <= display.workArea.width
      && state.height <= display.workArea.height
    ));
    if (displayThatFits) {
      nextState.width = state.width;
      nextState.height = state.height;
    }
  }

  if (Number.isInteger(state?.x) && Number.isInteger(state?.y)) {
    const savedBounds = {
      x: state.x,
      y: state.y,
      width: nextState.width,
      height: nextState.height
    };
    const isVisible = displays.some((display) => rectanglesIntersect(savedBounds, display.workArea));
    if (isVisible) {
      nextState.x = state.x;
      nextState.y = state.y;
    }
  }

  return nextState;
}

async function loadWindowState() {
  try {
    const data = await fs.readFile(windowStatePath, 'utf8');
    windowState = normalizeWindowState(JSON.parse(data));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('Failed to load window state, using defaults:', error.message);
    }
    windowState = normalizeWindowState({});
  }
}

async function saveWindowState(window = mainWindow) {
  if (!window || window.isDestroyed()) {
    return;
  }

  const bounds = window.isMaximized() ? window.getNormalBounds() : window.getBounds();
  const nextState = {
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    isMaximized: window.isMaximized()
  };
  windowState = normalizeWindowState(nextState);

  await queueWrite('window', () => writeJsonAtomically(windowStatePath, windowState));
}

function isAppFileUrl(url) {
  try {
    const filePath = fileURLToPath(url);
    return isPathInside(filePath, appRootPath);
  } catch {
    return false;
  }
}

function isTrustedSender(event, expectedWindow) {
  if (!expectedWindow || expectedWindow.isDestroyed() || event.sender !== expectedWindow.webContents) {
    return false;
  }

  const senderUrl = event.senderFrame?.url || event.sender.getURL();
  return isAppFileUrl(senderUrl);
}

function configureWebContents(window, pagePath) {
  const allowedUrl = pathToFileURL(pagePath).href;

  window.webContents.on('will-navigate', (event, navigationUrl) => {
    if (navigationUrl !== allowedUrl) {
      event.preventDefault();
      console.warn('Blocked navigation to:', navigationUrl);
    }
  });

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
}

function getWindowWebPreferences() {
  return {
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    webviewTag: false,
    backgroundThrottling: false,
    preload: path.join(__dirname, 'preload.js')
  };
}

function focusWindow(window) {
  if (!window || window.isDestroyed()) {
    return;
  }
  if (window.isMinimized()) {
    window.restore();
  }
  window.show();
  window.focus();
}

function createWelcomeWindow() {
  if (welcomeWindow && !welcomeWindow.isDestroyed()) {
    focusWindow(welcomeWindow);
    return welcomeWindow;
  }

  const welcomePagePath = path.join(__dirname, 'welcome.html');
  const window = new BrowserWindow({
    width: WELCOME_WINDOW_WIDTH,
    height: WELCOME_WINDOW_HEIGHT,
    resizable: false,
    frame: false,
    center: true,
    show: false,
    backgroundColor: '#0f0f0f',
    icon: appIconPath,
    webPreferences: getWindowWebPreferences()
  });
  welcomeWindow = window;
  configureWebContents(window, welcomePagePath);

  window.loadFile(welcomePagePath).catch((error) => {
    console.error('Failed to load welcome page:', error);
    dialog.showErrorBox('Ошибка запуска', 'Не удалось открыть стартовое окно приложения.');
  });
  window.once('ready-to-show', () => {
    if (welcomeWindow === window && !window.isDestroyed()) {
      window.show();
      window.focus();
    }
  });
  window.on('closed', () => {
    if (welcomeWindow === window) {
      welcomeWindow = null;
    }
  });

  return window;
}

async function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    focusWindow(mainWindow);
    return mainWindow;
  }

  await loadWindowState();

  const htmlPath = path.join(__dirname, 'index.html');
  const window = new BrowserWindow({
    width: windowState.width,
    height: windowState.height,
    x: windowState.x,
    y: windowState.y,
    minWidth: Math.min(MIN_WINDOW_WIDTH, windowState.width),
    minHeight: Math.min(MIN_WINDOW_HEIGHT, windowState.height),
    show: false,
    titleBarStyle: 'default',
    backgroundColor: '#0f0f0f',
    icon: appIconPath,
    webPreferences: getWindowWebPreferences()
  });
  mainWindow = window;
  configureWebContents(window, htmlPath);
  Menu.setApplicationMenu(null);

  window.loadFile(htmlPath).catch((error) => {
    console.error('Failed to load main page:', error);
    dialog.showErrorBox('Ошибка запуска', 'Не удалось открыть главное окно приложения.');
  });

  window.once('ready-to-show', () => {
    if (mainWindow !== window || window.isDestroyed()) {
      return;
    }
    if (windowState.isMaximized) {
      window.maximize();
    }
    window.show();
    window.focus();
  });

  setTimeout(() => {
    if (mainWindow === window && !window.isDestroyed() && !window.isVisible()) {
      window.show();
      window.focus();
    }
  }, WINDOW_SHOW_FALLBACK_MS);

  if (isDev) {
    window.webContents.openDevTools({ mode: 'detach' });
  }

  let saveTimeout = null;
  let isClosing = false;
  const scheduleSave = () => {
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
      saveWindowState(window).catch((error) => {
        console.warn('Failed to save window state:', error.message);
      });
    }, SAVE_STATE_DEBOUNCE_MS);
  };

  window.on('resize', scheduleSave);
  window.on('move', scheduleSave);
  window.on('close', (event) => {
    if (isClosing) {
      return;
    }

    event.preventDefault();
    isClosing = true;
    clearTimeout(saveTimeout);
    saveWindowState(window)
      .catch((error) => console.warn('Failed to save window state:', error.message))
      .finally(() => {
        if (!window.isDestroyed()) {
          window.destroy();
        }
      });
  });
  window.on('closed', () => {
    clearTimeout(saveTimeout);
    if (mainWindow === window) {
      mainWindow = null;
    }
  });
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl) => {
    console.error('Failed to load:', errorCode, errorDescription, validatedUrl);
  });

  return window;
}

async function resolveMusicPath(candidatePath, expectedType) {
  if (typeof candidatePath !== 'string' || !candidatePath.trim()) {
    throw new Error('Некорректный путь');
  }

  const config = await loadConfig();
  const musicFolder = await validateMusicFolder(config.musicFolder);
  const resolvedPath = await fs.realpath(candidatePath);

  if (!isPathInside(resolvedPath, musicFolder)) {
    throw new Error('Доступ запрещён: путь вне разрешённой директории');
  }

  const stats = await fs.stat(resolvedPath);
  if (expectedType === 'directory' && !stats.isDirectory()) {
    throw new Error('Указанный путь не является папкой');
  }
  if (expectedType === 'file' && !stats.isFile()) {
    throw new Error('Указанный путь не является файлом');
  }

  return { config, musicFolder, resolvedPath, stats };
}

async function readAudioFiles(directoryPath) {
  const items = await fs.readdir(directoryPath, { withFileTypes: true });

  return items
    .filter((item) => item.isFile() && isSupportedAudioFile(item.name))
    .map((item) => ({
      name: path.basename(item.name, path.extname(item.name)),
      filename: item.name,
      path: path.join(directoryPath, item.name),
      ext: path.extname(item.name).toLowerCase()
    }))
    .sort((first, second) => first.name.localeCompare(second.name, undefined, {
      numeric: true,
      sensitivity: 'base'
    }));
}

function enqueueMetadataTask(task) {
  return new Promise((resolve, reject) => {
    metadataQueue.push({ task, resolve, reject });
    drainMetadataQueue();
  });
}

function drainMetadataQueue() {
  while (metadataWorkersRunning < METADATA_CONCURRENCY && metadataQueue.length > 0) {
    const queued = metadataQueue.shift();
    metadataWorkersRunning += 1;
    Promise.resolve()
      .then(queued.task)
      .then(queued.resolve, queued.reject)
      .finally(() => {
        metadataWorkersRunning -= 1;
        drainMetadataQueue();
      });
  }
}

function parseMetadataInWorker(filePath) {
  return new Promise((resolve, reject) => {
    let worker;
    let completed = false;
    const timeout = setTimeout(() => {
      finish(new Error('Не удалось прочитать метаданные: превышено время ожидания'));
    }, METADATA_TIMEOUT_MS);

    const finish = (error, result) => {
      if (completed) {
        return;
      }
      completed = true;
      clearTimeout(timeout);
      worker?.removeAllListeners();
      worker?.terminate().catch(() => {});
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    };

    try {
      worker = new Worker(metadataWorkerPath, { workerData: { filePath } });
      worker.once('message', (message) => {
        if (!message?.success) {
          finish(new Error(message?.error || 'Не удалось прочитать метаданные'));
          return;
        }
        finish(null, message.data);
      });
      worker.once('error', (error) => finish(error));
      worker.once('exit', (code) => {
        if (!completed) {
          finish(new Error('Процесс чтения метаданных завершился с кодом ' + code));
        }
      });
    } catch (error) {
      finish(error);
    }
  });
}

async function getAudioMetadata(filePath, stats) {
  const cacheKey = filePath + '\0' + stats.size + '\0' + stats.mtimeMs;
  if (metadataCache.has(cacheKey)) {
    return metadataCache.get(cacheKey);
  }
  if (metadataInFlight.has(cacheKey)) {
    return metadataInFlight.get(cacheKey);
  }

  const metadataPromise = enqueueMetadataTask(() => parseMetadataInWorker(filePath))
    .then((metadata) => {
      metadataCache.set(cacheKey, metadata);
      while (metadataCache.size > MAX_METADATA_CACHE_ENTRIES) {
        metadataCache.delete(metadataCache.keys().next().value);
      }
      return metadata;
    })
    .finally(() => metadataInFlight.delete(cacheKey));

  metadataInFlight.set(cacheKey, metadataPromise);
  return metadataPromise;
}

function unauthorizedResponse() {
  return { success: false, error: 'Доступ запрещён' };
}

function getSafeFileDialogOptions(options) {
  const allowedExtensions = new Set([...AUDIO_EXTENSIONS].map((extension) => extension.slice(1)));
  const filters = Array.isArray(options?.filters)
    ? options.filters
      .map((filter) => ({
        name: typeof filter?.name === 'string' ? filter.name.slice(0, 100) : 'Аудиофайлы',
        extensions: Array.isArray(filter?.extensions)
          ? filter.extensions
            .filter((extension) => typeof extension === 'string')
            .map((extension) => extension.toLowerCase().replace(/^\./, ''))
            .filter((extension) => allowedExtensions.has(extension))
          : []
      }))
      .filter((filter) => filter.extensions.length > 0)
    : [];

  return {
    title: typeof options?.title === 'string' ? options.title.slice(0, 200) : 'Выберите аудиофайл',
    buttonLabel: typeof options?.buttonLabel === 'string' ? options.buttonLabel.slice(0, 100) : undefined,
    filters: filters.length > 0 ? filters : [{ name: 'Аудиофайлы', extensions: [...allowedExtensions] }],
    properties: ['openFile']
  };
}

ipcMain.handle('read-directory', async (event, customPath) => {
  if (!isTrustedSender(event, mainWindow)) {
    return unauthorizedResponse();
  }

  try {
    const config = await loadConfig();
    if (!config.musicFolder) {
      return { success: false, error: 'Папка с музыкой не выбрана', needsSetup: true };
    }

    const { resolvedPath } = await resolveMusicPath(customPath || config.musicFolder, 'directory');
    const items = await fs.readdir(resolvedPath, { withFileTypes: true });
    const playlists = [];

    for (const item of items) {
      if (!item.isDirectory()) {
        continue;
      }

      const playlistPath = path.join(resolvedPath, item.name);
      try {
        const audioFiles = await readAudioFiles(playlistPath);
        if (audioFiles.length > 0) {
          playlists.push({
            name: item.name,
            type: 'playlist',
            trackCount: audioFiles.length,
            path: playlistPath
          });
        }
      } catch (error) {
        console.warn('Failed to read playlist ' + item.name + ':', error.message);
      }
    }

    playlists.sort((first, second) => first.name.localeCompare(second.name, undefined, {
      numeric: true,
      sensitivity: 'base'
    }));
    return { success: true, data: playlists };
  } catch (error) {
    return { success: false, error: error.message, needsSetup: true };
  }
});

ipcMain.handle('get-playlist-tracks', async (event, playlistPath) => {
  if (!isTrustedSender(event, mainWindow)) {
    return unauthorizedResponse();
  }

  try {
    const { config, musicFolder, resolvedPath } = await resolveMusicPath(playlistPath, 'directory');
    const tracks = (await readAudioFiles(resolvedPath)).map((track) => {
      const metadataKey = getTrackMetadataKey(track.path, musicFolder);
      const override = config.trackMetadataOverrides?.[metadataKey] || {};
      return {
        ...applyTrackMetadataOverride(track, override),
        metadataKey
      };
    });
    return { success: true, data: tracks };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('open-file-dialog', async (event, options) => {
  if (!isTrustedSender(event, mainWindow)) {
    return { canceled: true, filePaths: [] };
  }

  try {
    return await dialog.showOpenDialog(mainWindow, getSafeFileDialogOptions(options));
  } catch (error) {
    console.warn('Failed to open file dialog:', error.message);
    return { canceled: true, filePaths: [] };
  }
});

ipcMain.handle('select-music-folder', async (event) => {
  if (!isTrustedSender(event, mainWindow)) {
    return unauthorizedResponse();
  }

  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Выберите папку с музыкой',
      properties: ['openDirectory']
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, error: 'Папка не выбрана' };
    }
    return { success: true, path: result.filePaths[0] };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

let isOpeningMainFromWelcome = false;
ipcMain.handle('select-music-folder-and-open-main', async (event) => {
  if (!isTrustedSender(event, welcomeWindow) || isOpeningMainFromWelcome) {
    return unauthorizedResponse();
  }

  isOpeningMainFromWelcome = true;
  try {
    const result = await dialog.showOpenDialog(welcomeWindow, {
      title: 'Выберите папку с музыкой',
      properties: ['openDirectory']
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, error: 'Папка не выбрана' };
    }

    await updateMusicFolder(result.filePaths[0]);
    await createWindow();

    if (welcomeWindow && !welcomeWindow.isDestroyed()) {
      welcomeWindow.close();
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  } finally {
    isOpeningMainFromWelcome = false;
  }
});

ipcMain.handle('set-music-folder', async (event, folderPath) => {
  if (!isTrustedSender(event, mainWindow)) {
    return unauthorizedResponse();
  }

  try {
    const savedPath = await updateMusicFolder(folderPath);
    return { success: true, path: savedPath };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-config', async (event) => {
  if (!isTrustedSender(event, mainWindow)) {
    return null;
  }
  return loadConfig();
});

ipcMain.handle('save-track-metadata', async (event, filePath, metadata) => {
  if (!isTrustedSender(event, mainWindow)) {
    return unauthorizedResponse();
  }

  try {
    const { musicFolder, resolvedPath } = await resolveMusicPath(filePath, 'file');
    if (!isSupportedAudioFile(resolvedPath)) {
      return { success: false, error: 'Поддерживаются только аудиофайлы' };
    }

    const metadataKey = getTrackMetadataKey(resolvedPath, musicFolder);
    const normalizedMetadata = normalizeTrackMetadata(metadata);
    await updateConfig((config) => {
      if (Object.keys(normalizedMetadata).length > 0) {
        config.trackMetadataOverrides[metadataKey] = normalizedMetadata;
      } else {
        delete config.trackMetadataOverrides[metadataKey];
      }
    });

    return {
      success: true,
      data: {
        metadataKey,
        metadataOverride: normalizedMetadata,
        ...normalizedMetadata
      }
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('clear-track-metadata', async (event, filePath) => {
  if (!isTrustedSender(event, mainWindow)) {
    return unauthorizedResponse();
  }

  try {
    const { musicFolder, resolvedPath } = await resolveMusicPath(filePath, 'file');
    if (!isSupportedAudioFile(resolvedPath)) {
      return { success: false, error: 'Поддерживаются только аудиофайлы' };
    }

    const metadataKey = getTrackMetadataKey(resolvedPath, musicFolder);
    await updateConfig((config) => {
      delete config.trackMetadataOverrides[metadataKey];
    });
    return { success: true, data: { metadataKey, metadataOverride: {} } };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-audio-metadata', async (event, filePath) => {
  if (!isTrustedSender(event, mainWindow)) {
    return unauthorizedResponse();
  }

  try {
    const { resolvedPath, stats } = await resolveMusicPath(filePath, 'file');
    if (!isSupportedAudioFile(resolvedPath)) {
      return { success: false, error: 'Поддерживаются только аудиофайлы' };
    }
    if (stats.size > MAX_METADATA_FILE_SIZE) {
      return { success: false, error: 'Файл слишком большой для безопасного чтения метаданных' };
    }

    return { success: true, data: await getAudioMetadata(resolvedPath, stats) };
  } catch (error) {
    console.warn('Error getting audio metadata:', error.message);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-audio-file-buffer', async (event, filePath) => {
  if (!isTrustedSender(event, mainWindow)) {
    return unauthorizedResponse();
  }

  try {
    const { resolvedPath, stats } = await resolveMusicPath(filePath, 'file');
    if (!isSupportedAudioFile(resolvedPath)) {
      return { success: false, error: 'Поддерживаются только аудиофайлы' };
    }
    if (stats.size > MAX_WAVEFORM_FILE_SIZE) {
      return { success: false, error: 'Файл слишком большой для построения waveform' };
    }

    const fileBuffer = await fs.readFile(resolvedPath);
    const data = fileBuffer.buffer.slice(
      fileBuffer.byteOffset,
      fileBuffer.byteOffset + fileBuffer.byteLength
    );
    return { success: true, data };
  } catch (error) {
    console.warn('Error reading audio file for waveform:', error.message);
    return { success: false, error: error.message };
  }
});

async function startApplication() {
  app.setAppUserModelId('com.concertaudiosystem.cas');
  Menu.setApplicationMenu(null);
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);

  const config = await loadConfig();
  if (config.firstRun || !config.musicFolder) {
    createWelcomeWindow();
  } else {
    await createWindow();
  }

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const currentConfig = await loadConfig();
      if (currentConfig.firstRun || !currentConfig.musicFolder) {
        createWelcomeWindow();
      } else {
        await createWindow();
      }
      return;
    }
    focusWindow(mainWindow || welcomeWindow);
  });
}

app.whenReady().then(startApplication).catch((error) => {
  console.error('Application startup failed:', error);
  dialog.showErrorBox('Ошибка запуска', 'Не удалось запустить Concert Audio System.');
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    focusWindow(mainWindow || welcomeWindow);
  });
}

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});
