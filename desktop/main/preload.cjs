const { contextBridge, ipcRenderer, webUtils } = require('electron');
const invoke = (name, ...args) => ipcRenderer.invoke(`terrain:${name}`, ...args);
const importFile = (name, file) => {
  try {
    const path = webUtils.getPathForFile(file);
    if (!path) return Promise.resolve({ ok: false, error: { code: 'INPUT_INVALID', message: '请从文件夹中拖入本地文件。' } });
    return invoke(name, path);
  } catch { return Promise.resolve({ ok: false, error: { code: 'INPUT_INVALID', message: '无法读取所选文件，请使用文件选择按钮。' } }); }
};
contextBridge.exposeInMainWorld('terrain', {
  getRuntime: () => invoke('runtime'),
  getCacheInfo: () => invoke('cache-info'), clearCache: () => invoke('clear-cache'),
  getSession: () => invoke('session-get'), saveSession: request => invoke('session-save', request), restoreSession: () => invoke('session-restore'),
  chooseRoute: () => invoke('choose-route'), chooseDem: () => invoke('choose-dem'),
  chooseImage:()=>invoke('choose-image'), removeImage:id=>invoke('remove-image',id),
  importRouteFile: file => importFile('import-route', file), importDemFile: file => importFile('import-dem', file),
  importImageFile:file=>importFile('import-image',file),
  inspect: request => invoke('inspect', request), startJob: request => invoke('start', request),
  cancelJob: id => invoke('cancel', id), getJob: id => invoke('get', id), getPreview: id => invoke('preview', id),
  saveStl: id => invoke('save', id),
  saveModel:request=>invoke('save-model',request),
  onJob: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, job) => callback(job);
    ipcRenderer.on('terrain:job', listener);
    return () => ipcRenderer.removeListener('terrain:job', listener);
  },
});
