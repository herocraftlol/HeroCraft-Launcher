const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Fenêtre
  closeWindow: () => ipcRenderer.send('window:close'),
  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  maximizeWindow: () => ipcRenderer.send('window:maximize'),

  // Comptes
  getAccounts: () => ipcRenderer.invoke('accounts:get'),
  addCrackAccount: (username) => ipcRenderer.invoke('accounts:add-crack', username),
  microsoftLogin: () => ipcRenderer.invoke('accounts:ms-login'),
  removeAccount: (id) => ipcRenderer.invoke('accounts:remove', id),

  // Lancement
  launchGame: (opts) => ipcRenderer.invoke('game:launch', opts),
  onLaunchStatus: (cb) => ipcRenderer.on('launch:status', (e, data) => cb(data)),

  // Utilitaires
  getDataDir: () => ipcRenderer.invoke('app:get-data-dir'),
  openExternal: (url) => ipcRenderer.send('open-external', url),
});
