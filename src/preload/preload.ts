import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { EVENT_CHANNELS, INVOKE_CHANNELS, SEND_CHANNELS, type EstelaApi } from '../shared/ipc';

const allowed = (list: readonly string[], ch: string) => {
  if (!list.includes(ch)) throw new Error(`IPC channel not allowed: ${ch}`);
};

const api: EstelaApi = {
  os: process.platform,
  pathForFile: (file) => webUtils.getPathForFile(file),
  invoke: (ch, ...args) => (allowed(INVOKE_CHANNELS, ch), ipcRenderer.invoke(ch, ...args)),
  send: (ch, ...args) => (allowed(SEND_CHANNELS, ch), ipcRenderer.send(ch, ...args)),
  on: (ch, cb) => {
    allowed(EVENT_CHANNELS, ch);
    const listener = (_e: Electron.IpcRendererEvent, payload: Parameters<typeof cb>[0]) => cb(payload);
    ipcRenderer.on(ch, listener);
    return () => ipcRenderer.removeListener(ch, listener);
  },
};

contextBridge.exposeInMainWorld('estela', api);
