import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dialog, ipcMain, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import type { EventApi, InvokeApi, SendApi } from '../shared/ipc';
import { MAX_ICON_BYTES, type SecretKind } from '../shared/session';
import { collapseHome } from './paths';
import { platform } from './platform';
import { Prompts } from './prompts';
import { SshShell } from './ssh/connection';
import type { KnownHosts } from './store/known-hosts';
import type { SecretStore } from './store/secrets';
import type { SessionStore } from './store/sessions';

const ICON_MIME: Record<string, string> = { '.ico': 'image/x-icon', '.png': 'image/png', '.svg': 'image/svg+xml' };

export interface Stores {
  sessions: SessionStore;
  secrets: SecretStore;
  knownHosts: KnownHosts;
}

// The renderer is a trust boundary: every argument is checked here before use.
const str = (x: unknown): string => {
  if (typeof x !== 'string' || x.length > 1_000_000) throw new Error('Expected a string');
  return x;
};
const int = (x: unknown, min = 1, max = 10_000): number => {
  if (!Number.isInteger(x) || (x as number) < min || (x as number) > max) throw new Error('Expected an integer');
  return x as number;
};
const secretKind = (x: unknown): SecretKind => {
  if (x !== 'password' && x !== 'passphrase') throw new Error('Expected a secret kind');
  return x;
};

export function registerIpc(win: BrowserWindow, { sessions, secrets, knownHosts }: Stores): () => void {
  const emit = <K extends keyof EventApi>(ch: K, payload: EventApi[K]) => {
    if (!win.isDestroyed()) win.webContents.send(ch, payload);
  };
  const fromWin = (e: IpcMainEvent | IpcMainInvokeEvent) => {
    if (e.sender !== win.webContents) throw new Error('IPC from unknown sender');
  };
  const handle = <K extends keyof InvokeApi>(ch: K, fn: (...args: unknown[]) => unknown) =>
    ipcMain.handle(ch, (e, ...args) => (fromWin(e), fn(...args)));
  const on = <K extends keyof SendApi>(ch: K, fn: (...args: unknown[]) => void) =>
    ipcMain.on(ch, (e, ...args) => {
      try {
        fromWin(e);
        fn(...args);
      } catch (err) {
        console.error(`IPC ${ch}:`, err);
      }
    });

  const changed = () => emit('sessions:changed', sessions.get());
  const prompts = new Prompts(emit);
  const shells = new Map<string, SshShell>();
  const connDeps = {
    findSession: (id: string) => sessions.find(id),
    secrets,
    knownHosts,
    agent: () => platform.sshAgent(),
    askHostKey: prompts.hostKey.bind(prompts),
    askAuth: prompts.auth.bind(prompts),
  };

  handle('sessions:get', () => sessions.get());
  handle('sessions:saveSession', (s) => (sessions.saveSession(s), changed()));
  handle('sessions:deleteSession', (id) => {
    sessions.deleteSession(str(id));
    secrets.deleteSession(str(id));
    changed();
  });
  handle('sessions:saveFolder', (f) => (sessions.saveFolder(f), changed()));
  handle('sessions:deleteFolder', (id) => (sessions.deleteFolder(str(id)), changed()));
  handle('sessions:export', async () => {
    const r = await dialog.showSaveDialog(win, {
      title: 'Exportar sesiones (sin contraseñas)',
      defaultPath: path.join(os.homedir(), 'estela-sessions.json'),
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return false;
    fs.writeFileSync(r.filePath, sessions.export());
    return true;
  });
  handle('sessions:import', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Importar sesiones',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const n = sessions.import(JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8')));
    changed();
    return n;
  });

  handle('secrets:status', () => secrets.status());
  handle('secrets:acceptInsecure', () => secrets.acceptInsecure());
  handle('secrets:has', (id, kind) => secrets.has(str(id), secretKind(kind)));
  handle('secrets:set', (id, kind, value) => secrets.set(str(id), secretKind(kind), value === null ? null : str(value)));

  handle('dialog:openFile', async (title) => {
    const r = await dialog.showOpenDialog(win, {
      title: str(title),
      defaultPath: path.join(os.homedir(), '.ssh'),
      properties: ['openFile', 'showHiddenFiles'],
    });
    return r.canceled || !r.filePaths[0] ? null : collapseHome(r.filePaths[0]);
  });

  handle('dialog:pickIcon', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Elegir icono',
      filters: [{ name: 'Iconos', extensions: ['ico', 'png', 'svg'] }],
      properties: ['openFile'],
    });
    const file = r.filePaths[0];
    if (r.canceled || !file) return null;
    if (fs.statSync(file).size > MAX_ICON_BYTES) throw new Error('El icono no puede pasar de 512 KB');
    const mime = ICON_MIME[path.extname(file).toLowerCase()];
    if (!mime) throw new Error('Formato de icono no admitido');
    return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
  });

  handle('conn:open', (sessionId, cols, rows) => {
    const connId = randomUUID();
    const shell = new SshShell(connDeps, {
      data: (data) => emit('conn:data', { connId, data }),
      status: (status, error) => {
        if (status === 'closed' || status === 'error') shells.delete(connId);
        emit('conn:status', { connId, status, error });
      },
    });
    shells.set(connId, shell);
    const [id, c, r] = [str(sessionId), int(cols), int(rows)];
    // Deferred so the renderer has the connId before the first status event arrives.
    setImmediate(() => void shell.open(id, c, r));
    return connId;
  });
  on('conn:write', (id, data) => shells.get(str(id))?.write(str(data)));
  on('conn:resize', (id, cols, rows) => shells.get(str(id))?.resize(int(cols), int(rows)));
  on('conn:close', (id) => {
    shells.get(str(id))?.close();
    shells.delete(str(id));
  });
  on('prompt:answer', (id, answer) => prompts.answer(str(id), answer));

  // A renderer reload leaves no one to answer prompts or read output.
  const reset = () => {
    prompts.cancelAll();
    for (const s of shells.values()) s.close();
    shells.clear();
  };
  win.webContents.on('did-start-navigation', (_e, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) reset();
  });
  return reset;
}
