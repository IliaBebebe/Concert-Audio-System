const { app, BrowserWindow, ipcMain, dialog, shell, screen } = require('electron');
const path = require('path');
const fs = require('fs').promises;

let mainWindow;
let welcomeWindow;

// Путь к файлу конфигурации
const configPath = path.join(app.getPath('userData'), 'config.json');
const windowStatePath = path.join(app.getPath('userData'), 'window-state.json');

// Режим разработки
const isDev = process.argv.includes('--dev') || !app.isPackaged;

// Состояние окна
let windowState = {
  width: 1400,
  height: 900,
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
    
    if (state.width && state.width <= width && state.width >= 800) {
      windowState.width = state.width;
    }
    if (state.height && state.height <= height && state.height >= 600) {
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
    // Используем значения по умолчанию
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
    // Игнорируем ошибки сохранения
  }
}

// Загрузка конфигурации
async function loadConfig() {
  try {
    const configData = await fs.readFile(configPath, 'utf8');
    return JSON.parse(configData);
  } catch (error) {
    return {
      musicFolder: null,
      firstRun: true
    };
  }
}

// Сохранение конфигурации
async function saveConfig(config) {
  try {
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
    return true;
  } catch (error) {
    return false;
  }
}

function createWelcomeWindow() {
  welcomeWindow = new BrowserWindow({
    width: 600,
    height: 400,
    resizable: false,
    frame: false,
    center: true,
    show: false,
    backgroundColor: '#0f0f0f',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      sandbox: false
    }
  });

  welcomeWindow.loadFile('welcome.html');
  welcomeWindow.once('ready-to-show', () => {
    welcomeWindow.show();
  });
}

// Создание окна (упрощенная версия для локального использования)
function createWindow() {
  // Загружаем состояние синхронно для ускорения
  loadWindowState().catch(() => {});
  
  mainWindow = new BrowserWindow({
    width: windowState.width,
    height: windowState.height,
    x: windowState.x,
    y: windowState.y,
    minWidth: 1200,
    minHeight: 700,
    show: true, // Показываем сразу для локального использования
    titleBarStyle: 'default',
    backgroundColor: '#0f0f0f',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: false, // Для локальных файлов
      backgroundThrottling: false, // Важно для аудио
      enableRemoteModule: false,
      sandbox: false
    }
  });

  // Загружаем HTML
  const htmlPath = path.join(__dirname, 'index.html');
  console.log(`Loading HTML from: ${htmlPath}`);
  mainWindow.loadFile(htmlPath).catch((error) => {
    console.error('Error loading HTML:', error);
    // Fallback - показываем окно даже при ошибке
    mainWindow.show();
    mainWindow.focus();
  });

  // Показываем окно сразу после создания (fallback)
  mainWindow.once('ready-to-show', () => {
    if (windowState.isMaximized) {
      mainWindow.maximize();
    }
    mainWindow.show();
    mainWindow.focus();
  });

  // Дополнительный fallback - показываем через небольшую задержку
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show();
      mainWindow.focus();
    }
  }, 1000);

  // Открываем DevTools в режиме разработки
  if (isDev) {
    mainWindow.webContents.openDevTools();
  }

  // Обработка закрытия
  mainWindow.on('close', () => {
    saveWindowState().catch(() => {});
  });

  // Сохранение состояния при изменении
  let saveTimeout;
  const scheduleSave = () => {
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => saveWindowState().catch(() => {}), 500);
  };
  mainWindow.on('resize', scheduleSave);
  mainWindow.on('move', scheduleSave);

  // Обработка ошибок загрузки
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    console.error('Failed to load:', errorCode, errorDescription, validatedURL);
    // Показываем окно даже при ошибке
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
    }
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
    createWindow();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      if (config.firstRun || !config.musicFolder) {
        createWelcomeWindow();
      } else {
        createWindow();
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
    const dirPath = customPath || config.musicFolder;
    
    if (!dirPath) {
      return { success: false, error: 'Папка с музыкой не выбрана', needsSetup: true };
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
          // Пропускаем папки с ошибками
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
    const tracks = await getAudioFiles(playlistPath);
    return { success: true, data: tracks };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('open-file-dialog', async (event, options) => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, options);
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
      const config = await loadConfig();
      config.musicFolder = folderPath;
      config.firstRun = false;
      await saveConfig(config);
      
      createWindow();
      if (welcomeWindow) {
        welcomeWindow.close();
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
    const config = await loadConfig();
    config.musicFolder = folderPath;
    config.firstRun = false;
    const saved = await saveConfig(config);
    return { success: saved };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-config', async () => {
  return await loadConfig();
});

// Получение метаданных аудиофайла
ipcMain.handle('get-audio-metadata', async (event, filePath) => {
  try {
    // Проверяем существование файла
    try {
      await fs.access(filePath);
    } catch {
      return { success: false, error: 'Файл не существует' };
    }

    // Динамический импорт ESM модуля
    const { parseFile } = await import('music-metadata');
    const metadata = await parseFile(filePath);
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
    const audioExtensions = new Set(['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac', '.opus', '.webm']);
    
    const audioFiles = items
      .filter(item => {
        if (item.isDirectory()) return false;
        const ext = path.extname(item.name).toLowerCase();
        return audioExtensions.has(ext);
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
    return [];
  }
}

// Обработка ошибок
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason);
});
