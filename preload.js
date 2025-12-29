const { contextBridge, ipcRenderer } = require('electron');

// Упрощенный API для локального использования
contextBridge.exposeInMainWorld('electronAPI', {
  readDirectory: (path) => ipcRenderer.invoke('read-directory', path),
  getPlaylistTracks: (path) => ipcRenderer.invoke('get-playlist-tracks', path),
  openFileDialog: (options) => ipcRenderer.invoke('open-file-dialog', options),
  selectMusicFolder: () => ipcRenderer.invoke('select-music-folder'),
  setMusicFolder: (folderPath) => ipcRenderer.invoke('set-music-folder', folderPath),
  getConfig: () => ipcRenderer.invoke('get-config'),
  getAudioMetadata: (filePath) => ipcRenderer.invoke('get-audio-metadata', filePath)
});
