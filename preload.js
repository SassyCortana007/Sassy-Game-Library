const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  loadGames: () => ipcRenderer.invoke('games:load'),
  saveGames: (games) => ipcRenderer.invoke('games:save', games),
  steamSearch: (term) => ipcRenderer.invoke('steam:search', term),
  steamFetchTags: (appid) => ipcRenderer.invoke('steam:fetch-tags', appid),
  steamGetSuggestions: (payload) => ipcRenderer.invoke('steam:get-suggestions', payload),
  saveCover: (payload) => ipcRenderer.invoke('covers:save', payload),
  resolveCover: (relativePath) => ipcRenderer.invoke('covers:resolve', relativePath),
  deleteCover: (relativePath) => ipcRenderer.invoke('covers:delete', relativePath),
  pickImage: () => ipcRenderer.invoke('dialog:pick-image'),
  showContextMenu: (payload) => ipcRenderer.invoke('context-menu:show', payload),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  onTriggerRefresh: (callback) => {
    ipcRenderer.on('trigger-refresh', () => callback());
  },
  onExportSuccess: (callback) => {
    ipcRenderer.on('export-success', () => callback());
  },
  onShowToast: (callback) => {
    ipcRenderer.on('show-toast', (_event, payload) => callback(payload));
  },
  onShowMergeDialog: (callback) => {
    ipcRenderer.on('show-merge-dialog', () => {
      Promise.resolve(callback()).then((result) => {
        ipcRenderer.send('merge-dialog-response', result);
      });
    });
  },
  triggerRefresh: () => ipcRenderer.send('trigger-refresh'),
  exportLibrary: () => ipcRenderer.send('export-library'),
  loadLibrary: () => ipcRenderer.send('load-library'),
  openGithub: () => ipcRenderer.send('open-github'),
});
