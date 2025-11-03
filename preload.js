const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openFileDialog: (opts) => ipcRenderer.invoke('show-open-dialog', opts),
  convertFiles: (files) => ipcRenderer.invoke('convert-files', files),
  onProgress: (cb) => {
    ipcRenderer.on('conversion-progress', (e, data) => cb(data));
  }
});
