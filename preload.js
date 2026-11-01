const { contextBridge, ipcRenderer } = require('electron');

/**
 * Упрощенный API для локального использования
 * Все методы валидируют входные параметры перед отправкой в main process
 */
contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  windowControl: (action) => {
    if (typeof action !== 'string' || !['minimize', 'maximize', 'close'].includes(action)) {
      throw new Error('action must be one of: minimize, maximize, close');
    }
    return ipcRenderer.invoke('window-control', action);
  },
  isMaximized: async () => {
    const res = await ipcRenderer.invoke('window-is-maximized');
    return Boolean(res?.isMaximized);
  },
  onWindowStateChange: (callback) => {
    if (typeof callback !== 'function') throw new Error('Ожидался обработчик изменения состояния окна');
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('window-state-changed', listener);
    return () => ipcRenderer.removeListener('window-state-changed', listener);
  },
  onWindowVisibilityChange: callback => {
    if (typeof callback !== 'function') throw new Error('Ожидался обработчик видимости');
    const listener = (_event, visible) => {
      if (typeof visible === 'boolean') callback(visible);
    };
    ipcRenderer.on('window-visibility', listener);
    return () => ipcRenderer.removeListener('window-visibility', listener);
  },
  searchOnline: query => ipcRenderer.invoke('online-search', query),
  getOnlineLibrary: () => ipcRenderer.invoke('online-library'),
  removeOnlineTrack: id => ipcRenderer.invoke('online-remove', id),
  prepareOnlineTrack: id => ipcRenderer.invoke('online-prepare', id),
  cancelOnlineTrack: id => ipcRenderer.invoke('online-cancel', id),
  openOnlineLibrary: () => ipcRenderer.invoke('online-open-library'),
  onOnlineProgress: callback => {
    if (typeof callback !== 'function') throw new Error('Ожидался обработчик прогресса');
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('online-progress', listener);
    return () => ipcRenderer.removeListener('online-progress', listener);
  },
  toggleRemoteServer: (enable) => ipcRenderer.invoke('remote-server-toggle', Boolean(enable)),
  getRemoteServerStatus: () => ipcRenderer.invoke('remote-server-status'),
  pushRemoteState: (state) => ipcRenderer.send('remote-state-push', state),
  onRemoteCommand: (callback) => {
    if (typeof callback !== 'function') throw new Error('Ожидался обработчик команд пульта');
    const listener = (_event, cmd) => callback(cmd);
    ipcRenderer.on('remote-command', listener);
    return () => ipcRenderer.removeListener('remote-command', listener);
  },
  onRemoteClientCount: (callback) => {
    if (typeof callback !== 'function') throw new Error('Ожидался обработчик количества клиентов');
    const listener = (_event, count) => callback(count);
    ipcRenderer.on('remote-client-count', listener);
    return () => ipcRenderer.removeListener('remote-client-count', listener);
  },
  /**
   * Читает директории из папки с музыкой
   * @param {string} [customPath] - Опциональный путь (должен быть внутри musicFolder)
   * @returns {Promise<{success: boolean, data?: Array, error?: string, needsSetup?: boolean}>}
   */
  readDirectory: async (customPath) => {
    if (customPath !== undefined && typeof customPath !== 'string') {
      throw new Error('customPath должен быть строкой');
    }
    return ipcRenderer.invoke('read-directory', customPath);
  },

  /**
   * Получает треки из плейлиста
   * @param {string} playlistPath - Путь к плейлисту
   * @returns {Promise<{success: boolean, data?: Array, error?: string}>}
   */
  getPlaylistTracks: async (playlistPath) => {
    if (typeof playlistPath !== 'string') {
      throw new Error('playlistPath должен быть строкой');
    }
    return ipcRenderer.invoke('get-playlist-tracks', playlistPath);
  },

  /**
   * Открывает диалог выбора файла
   * @param {object} options - Настройки диалога
   * @returns {Promise<{canceled: boolean, filePaths?: string[]}>}
   */
  openFileDialog: async (options) => {
    if (typeof options !== 'object' || options === null) {
      throw new Error('options должен быть объектом');
    }
    return ipcRenderer.invoke('open-file-dialog', options);
  },

  /**
   * Выбирает папку с музыкой
   * @returns {Promise<{success: boolean, path?: string, error?: string}>}
   */
  selectMusicFolder: () => ipcRenderer.invoke('select-music-folder'),

  /**
   * Открывает текущую папку с музыкой в системном файловом менеджере.
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  openMusicFolder: () => ipcRenderer.invoke('open-music-folder'),

  /**
   * Устанавливает папку с музыкой
   * @param {string} folderPath - Путь к папке
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  setMusicFolder: async (folderPath) => {
    if (typeof folderPath !== 'string') {
      throw new Error('folderPath должен быть строкой');
    }
    return ipcRenderer.invoke('set-music-folder', folderPath);
  },

  /**
   * Получает текущую конфигурацию
   * @returns {Promise<{musicFolder?: string, firstRun?: boolean}>}
   */
  getConfig: () => ipcRenderer.invoke('get-config'),

  /**
   * Получает метаданные аудиофайла
   * @param {string} filePath - Путь к файлу
   * @returns {Promise<{success: boolean, data?: {artist?, title?, album?}, error?: string}>}
   */
  getAudioMetadata: async (filePath) => {
    if (typeof filePath !== 'string') {
      throw new Error('filePath должен быть строкой');
    }
    return ipcRenderer.invoke('get-audio-metadata', filePath);
  },

  getAudioFileBuffer: async (filePath) => {
    if (typeof filePath !== 'string') {
      throw new Error('filePath must be a string');
    }
    return ipcRenderer.invoke('get-audio-file-buffer', filePath);
  },

  saveTrackMetadata: async (filePath, metadata) => {
    if (typeof filePath !== 'string') {
      throw new Error('filePath must be a string');
    }
    if (typeof metadata !== 'object' || metadata === null) {
      throw new Error('metadata must be an object');
    }
    return ipcRenderer.invoke('save-track-metadata', filePath, metadata);
  },

  clearTrackMetadata: async (filePath) => {
    if (typeof filePath !== 'string') {
      throw new Error('filePath must be a string');
    }
    return ipcRenderer.invoke('clear-track-metadata', filePath);
  },

  /**
   * Выбирает папку и открывает главное окно
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  selectMusicFolderAndOpenMain: () => ipcRenderer.invoke('select-music-folder-and-open-main')
});
