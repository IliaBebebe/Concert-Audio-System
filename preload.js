const { contextBridge, ipcRenderer } = require('electron');

/**
 * Упрощенный API для локального использования
 * Все методы валидируют входные параметры перед отправкой в main process
 */
contextBridge.exposeInMainWorld('electronAPI', {
  /**
   * Читает директории из папки с музыкой
   * @param {string} [customPath] - Опциональный путь (должен быть внутри musicFolder)
   * @returns {Promise<{success: boolean, data?: Array, error?: string, needsSetup?: boolean}>}
   */
  readDirectory: (customPath) => {
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
  getPlaylistTracks: (playlistPath) => {
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
  openFileDialog: (options) => {
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
   * Устанавливает папку с музыкой
   * @param {string} folderPath - Путь к папке
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  setMusicFolder: (folderPath) => {
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
  getAudioMetadata: (filePath) => {
    if (typeof filePath !== 'string') {
      throw new Error('filePath должен быть строкой');
    }
    return ipcRenderer.invoke('get-audio-metadata', filePath);
  },

  /**
   * Выбирает папку и открывает главное окно
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  selectMusicFolderAndOpenMain: () => ipcRenderer.invoke('select-music-folder-and-open-main')
});
