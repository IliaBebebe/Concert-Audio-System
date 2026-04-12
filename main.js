const { app, BrowserWindow, ipcMain, dialog, shell, screen } = require('electron');
const path = require('path');
const fs = require('fs').promises;

// Константы
const DEFAULT_WINDOW_WIDTH = 1400;
const DEFAULT_WINDOW_HEIGHT = 900;
const MIN_WINDOW_WIDTH = 1200;
const MIN_WINDOW_HEIGHT = 700;
const WELCOME_WINDOW_WIDTH = 600;
const WELCOME_WINDOW_HEIGHT = 400;
const SAVE_STATE_DEBOUNCE_MS = 500;
const WINDOW_SHOW_FALLBACK_MS = 1000;
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac', '.opus', '.webm']);

let mainWindow;
let welcomeWindow;

// Путь к файлу конфигурации
const configPath = path.join(app.getPath('userData'), 'config.json');
const windowStatePath = path.join(app.getPath('userData'), 'window-state.json');

// Режим разработки
const isDev = process.argv.includes('--dev') || !app.isPackaged;

// Кэшированная конфигурация
let cachedConfig = null;

// Состояние окна
let windowState = {
  width: DEFAULT_WINDOW_WIDTH,
  height: DEFAULT_WINDOW_HEIGHT,
  x: undefined,
  y: undefined,
  isMaximized: false
};

// Загрузка состояния окна
async function loadWindowState() {
  try {
    const data = await fs.readFile(windowStatePath, 'utf8');
    const state = JSON.parse(data);
    const display = screen.getPrimaryDisplay();
    const { width, height } = display.workAreaSize;

    if (state.width && state.width <= width && state.width >= MIN_WINDOW_WIDTH) {
      windowState.width = state.width;
    }
    if (state.height && state.height <= height && state.height >= MIN_WINDOW_HEIGHT) {
      windowState.height = state.height;
    }
    if (state.x !== undefined && state.x >= 0 && state.x < width) {
      windowState.x = state.x;
    }
    if (state.y !== undefined && state.y >= 0 && state.y < height) {
      windowState.y = state.y;
    }
    if (state.isMaximized !== undefined) {
      windowState.isMaximized = state.isMaximized;
    }
  } catch (error) {
    console.warn('Failed to load window state, using defaults:', error.message);
  }
}

// Сохранение состояния окна
async function saveWindowState() {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const bounds = mainWindow.getBounds();
      windowState.width = bounds.width;
      windowState.height = bounds.height;
      windowState.x = bounds.x;
      windowState.y = bounds.y;
      windowState.isMaximized = mainWindow.isMaximized();
      await fs.writeFile(windowStatePath, JSON.stringify(windowState, null, 2));
    }
  } catch (error) {
    console.warn('Failed to save window state:', error.message);
  }
}

// Загрузка конфигурации
async function loadConfig() {
  if (cachedConfig) {
    return cachedConfig;
  }
  try {
    const configData = await fs.readFile(configPath, 'utf8');
    cachedConfig = JSON.parse(configData);
    return cachedConfig;
  } catch (error) {
    cachedConfig = {
      musicFolder: null,
      firstRun: true
    };
    return cachedConfig;
  }
}

// Сохранение конфигурации
async function saveConfig(config) {
  try {
    cachedConfig = config;
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
    return true;
  } catch (error) {
    console.error('Failed to save config:', error.message);
    return false;
  }
}

// Обновление папки с музыкой
async function updateMusicFolder(folderPath) {
  const config = await loadConfig();
  config.musicFolder = folderPath;
  config.firstRun = false;
  return await saveConfig(config);
}

function createWelcomeWindow() {
  welcomeWindow = new BrowserWindow({
    width: WELCOME_WINDOW_WIDTH,
    height: WELCOME_WINDOW_HEIGHT,
    resizable: false,
    frame: false,
    center: true,
    show: false,
    backgroundColor: '#0f0f0f',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      sandbox: false // TODO: установить true после тестирования
    }
  });

  welcomeWindow.loadFile('welcome.html');
  welcomeWindow.once('ready-to-show', () => {
    welcomeWindow.show();
  });

  welcomeWindow.on('closed', () => {
    welcomeWindow = null;
  });
}

// Создание окна (упрощенная версия для локального использования)
async function createWindow() {
  // Загружаем состояние окна
  await loadWindowState();

  mainWindow = new BrowserWindow({
    width: windowState.width,
    height: windowState.height,
    x: windowState.x,
    y: windowState.y,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    show: false,
    titleBarStyle: 'default',
    backgroundColor: '#0f0f0f',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: true, // Включено для безопасности
      backgroundThrottling: false, // Важно для аудио
      enableRemoteModule: false,
      sandbox: false // TODO: установить true после тестирования
    }
  });

  // Загружаем HTML
  const htmlPath = path.join(__dirname, 'index.html');
  console.log(`Loading HTML from: ${htmlPath}`);
  
  mainWindow.loadFile(htmlPath).catch((error) => {
    console.error('Error loading HTML:', error);
  });

  // Показываем окно после загрузки
  mainWindow.once('ready-to-show', () => {
    if (windowState.isMaximized) {
      mainWindow.maximize();
    }
    mainWindow.show();
    mainWindow.focus();
  });

  // Fallback - показываем через задержку
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show();
      mainWindow.focus();
    }
  }, WINDOW_SHOW_FALLBACK_MS);

  // Открываем DevTools в режиме разработки
  if (isDev) {
    mainWindow.webContents.openDevTools();
  }

  // Обработка закрытия
  mainWindow.on('close', () => {
    saveWindowState().catch(() => {});
  });

  // Очистка ссылки при закрытии
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Сохранение состояния при изменении
  let saveTimeout;
  const scheduleSave = () => {
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => saveWindowState().catch(() => {}), SAVE_STATE_DEBOUNCE_MS);
  };
  mainWindow.on('resize', scheduleSave);
  mainWindow.on('move', scheduleSave);

  // Обработка ошибок загрузки
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    console.error('Failed to load:', errorCode, errorDescription, validatedURL);
  });

  // Обработка навигации
  mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    try {
      const parsedUrl = new URL(navigationUrl);
      if (parsedUrl.origin !== 'file://') {
        event.preventDefault();
        shell.openExternal(navigationUrl);
      }
    } catch (e) {
      // Игнорируем ошибки парсинга URL
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// Запуск приложения
app.whenReady().then(async () => {
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
    } else if (mainWindow) {
      mainWindow.focus();
    }
  });
});

// Закрытие приложения
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Предотвращение множественных экземпляров
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// IPC обработчики (упрощенные для локального использования)
ipcMain.handle('read-directory', async (event, customPath) => {
  try {
    const config = await loadConfig();
    const basePath = config.musicFolder;
    const dirPath = customPath || basePath;

    if (!dirPath) {
      return { success: false, error: 'Папка с музыкой не выбрана', needsSetup: true };
    }

    // Защита от path traversal
    const resolvedPath = path.resolve(dirPath);
    const resolvedBase = path.resolve(basePath);
    if (customPath && !resolvedPath.startsWith(resolvedBase)) {
      return { success: false, error: 'Доступ запрещён: путь вне разрешённой директории' };
    }

    try {
      const stats = await fs.stat(dirPath);
      if (!stats.isDirectory()) {
        return { success: false, error: 'Указанный путь не является папкой', needsSetup: true };
      }
    } catch (error) {
      return { success: false, error: 'Папка не существует', needsSetup: true };
    }

    const items = await fs.readdir(dirPath, { withFileTypes: true });
    const result = [];

    for (const item of items) {
      if (item.isDirectory()) {
        try {
          const audioFiles = await getAudioFiles(path.join(dirPath, item.name));
          if (audioFiles.length > 0) {
            result.push({
              name: item.name,
              type: 'playlist',
              trackCount: audioFiles.length,
              path: path.join(dirPath, item.name)
            });
          }
        } catch (error) {
          console.warn(`Failed to read playlist ${item.name}:`, error.message);
        }
      }
    }

    return { success: true, data: result };
  } catch (error) {
    return { success: false, error: error.message, needsSetup: true };
  }
});

ipcMain.handle('get-playlist-tracks', async (event, playlistPath) => {
  try {
    const config = await loadConfig();
    const resolvedBase = path.resolve(config.musicFolder);
    const resolvedPath = path.resolve(playlistPath);
    
    // Защита от path traversal
    if (!resolvedPath.startsWith(resolvedBase)) {
      return { success: false, error: 'Доступ запрещён: путь вне разрешённой директории' };
    }
    
    const tracks = await getAudioFiles(playlistPath);
    return { success: true, data: tracks };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('open-file-dialog', async (event, options) => {
  try {
    const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
    if (!win || win.isDestroyed()) {
      return { canceled: true, filePaths: [] };
    }
    const result = await dialog.showOpenDialog(win, options);
    return result;
  } catch (error) {
    return { canceled: true, filePaths: [] };
  }
});

ipcMain.handle('select-music-folder', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Выберите папку с музыкой',
      properties: ['openDirectory']
    });
    
    if (!result.canceled && result.filePaths.length > 0) {
      return { success: true, path: result.filePaths[0] };
    }
    
    return { success: false, error: 'Папка не выбрана' };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('select-music-folder-and-open-main', async () => {
  const focusedWindow = BrowserWindow.getFocusedWindow();
  try {
    const result = await dialog.showOpenDialog(focusedWindow, {
      title: 'Выберите папку с музыкой',
      properties: ['openDirectory']
    });

    if (!result.canceled && result.filePaths.length > 0) {
      const folderPath = result.filePaths[0];
      await updateMusicFolder(folderPath);

      await createWindow();
      if (welcomeWindow && !welcomeWindow.isDestroyed()) {
        welcomeWindow.close();
        welcomeWindow = null;
      }
      return { success: true };
    }
    return { success: false, error: 'Папка не выбрана' };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('set-music-folder', async (event, folderPath) => {
  try {
    const saved = await updateMusicFolder(folderPath);
    return { success: saved };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-config', async () => {
  return await loadConfig();
});

// Получение метаданных аудиофайла
let parseFileFn = null;
ipcMain.handle('get-audio-metadata', async (event, filePath) => {
  try {
    // Проверяем существование файла
    try {
      await fs.access(filePath);
    } catch {
      return { success: false, error: 'Файл не существует' };
    }

    // Кэшируем импорт
    if (!parseFileFn) {
      const { parseFile } = await import('music-metadata');
      parseFileFn = parseFile;
    }
    
    const metadata = await parseFileFn(filePath);
    const artist = metadata.common.artist || metadata.common.albumArtist || null;
    const title = metadata.common.title || null;
    const album = metadata.common.album || null;

    return {
      success: true,
      data: {
        artist: artist,
        title: title,
        album: album
      }
    };
  } catch (error) {
    console.error('Error getting audio metadata:', error);
    return { success: false, error: error.message };
  }
});

// Получение аудиофайлов
async function getAudioFiles(dirPath) {
  try {
    const items = await fs.readdir(dirPath, { withFileTypes: true });

    const audioFiles = items
      .filter(item => {
        if (item.isDirectory()) return false;
        const ext = path.extname(item.name).toLowerCase();
        return AUDIO_EXTENSIONS.has(ext);
      })
      .map(item => ({
        name: path.basename(item.name, path.extname(item.name)),
        filename: item.name,
        path: path.join(dirPath, item.name),
        ext: path.extname(item.name).toLowerCase()
      }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

    return audioFiles;
  } catch (error) {
    console.warn(`Failed to read audio files from ${dirPath}:`, error.message);
    return [];
  }
}

// Обработка ошибок
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  app.quit();
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason);
  app.quit();
});
