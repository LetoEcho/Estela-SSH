import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import type { EventApi, InvokeApi, SendApi } from '../shared/ipc';
import { MAX_ICON_BYTES, type RdpSession, type SecretKind, type SshSession } from '../shared/session';
import { EditorManager } from './editor';
import { LocalPty } from './local/pty';
import { collapseHome } from './paths';
import { RdpLauncher } from './rdp/rdp';
import { SerialPane, listSerialPorts } from './serial/serial';
import { SessionLog } from './session-log';
import { platform } from './platform';
import { Prompts } from './prompts';
import { registerSftpIpc } from './sftp-ipc';
import { SshConnection, SshShell, type ShellEvents } from './ssh/connection';
import { TunnelManager } from './ssh/tunnels';
import type { KnownHosts } from './store/known-hosts';
import type { RdpCerts } from './store/rdp-certs';
import type { SecretStore } from './store/secrets';
import type { SessionStore } from './store/sessions';
import type { SettingsStore } from './store/settings';
import { sessionsFromSshConfig } from './store/ssh-config';

const ICON_MIME: Record<string, string> = { '.ico': 'image/x-icon', '.png': 'image/png', '.svg': 'image/svg+xml' };

export interface Stores {
  sessions: SessionStore;
  secrets: SecretStore;
  knownHosts: KnownHosts;
  settings: SettingsStore;
  rdpCerts: RdpCerts;
}

export interface IpcOptions {
  /** Opens an editor window for an edit id. */
  openEditorWindow(editId: string): void;
  userData: string;
}

/** Channels editor windows may use; everything else is reserved to the main window. */
const EDITOR_CHANNELS = new Set<string>(['editor:load', 'editor:save', 'settings:get']);

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

export function registerIpc(win: BrowserWindow, { sessions, secrets, knownHosts, settings, rdpCerts }: Stores, opts: IpcOptions) {
  const emit = <K extends keyof EventApi>(ch: K, payload: EventApi[K]) => {
    if (!win.isDestroyed()) win.webContents.send(ch, payload);
  };
  const fromWin = (e: IpcMainEvent | IpcMainInvokeEvent, ch: string) => {
    if (e.sender === win.webContents) return;
    if (EDITOR_CHANNELS.has(ch) && BrowserWindow.fromWebContents(e.sender)) return;
    throw new Error('IPC from unknown sender');
  };
  const handle = (ch: keyof InvokeApi, fn: (...args: unknown[]) => unknown) =>
    ipcMain.handle(ch, (e, ...args) => (fromWin(e, ch), fn(...args)));
  const on = (ch: keyof SendApi, fn: (...args: unknown[]) => void) =>
    ipcMain.on(ch, (e, ...args) => {
      try {
        fromWin(e, ch);
        fn(...args);
      } catch (err) {
        console.error(`IPC ${ch}:`, err);
      }
    });

  const changed = () => emit('sessions:changed', sessions.get());
  const prompts = new Prompts(emit);
  const shells = new Map<string, SshShell | LocalPty | SerialPane>();
  const connDeps = {
    findSession: (id: string) => sessions.find(id),
    secrets,
    knownHosts,
    agent: () => platform.sshAgent(),
    askHostKey: prompts.hostKey.bind(prompts),
    askAuth: prompts.auth.bind(prompts),
    keepaliveSec: () => settings.get().keepaliveSec,
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

  handle('dialog:openFiles', async (title) => {
    const r = await dialog.showOpenDialog(win, { title: str(title), properties: ['openFile', 'multiSelections'] });
    return r.canceled ? [] : r.filePaths;
  });
  handle('dialog:openDir', async (title) => {
    const r = await dialog.showOpenDialog(win, { title: str(title), properties: ['openDirectory', 'createDirectory'] });
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  });

  const sftp = registerSftpIpc({ win, shells, handle, on, emit, str });
  const editor = new EditorManager({
    sftp: (connId) => {
      const s = shells.get(connId);
      if (!(s instanceof SshShell)) throw new Error('La conexión ya no está abierta');
      return s.sftp();
    },
    settings: () => settings.get(),
    openWindow: opts.openEditorWindow,
    openExternal: (cmd, file) => platform.openInEditor(cmd, file),
    notice: (message) => emit('app:notice', { message }),
    tempDir: opts.userData,
  });

  const logs = new Map<string, SessionLog>();
  const defaultLogDir = () => path.join(app.getPath('documents'), 'Estela SSH logs');
  const closeLog = (connId: string) => {
    void logs.get(connId)?.close();
    logs.delete(connId);
  };
  const shellEvents = (connId: string): ShellEvents => ({
    data: (data) => {
      logs.get(connId)?.write(data);
      emit('conn:data', { connId, data });
    },
    status: (status, error) => {
      if (status === 'closed' || status === 'error') {
        closeLog(connId);
        shells.delete(connId);
        sftp.connectionClosed(connId);
        editor.connectionClosed(connId);
      }
      emit('conn:status', { connId, status, error });
    },
    hook: (r) => emit('conn:hook', { connId, ...r }),
  });

  const startLog = (connId: string, name: string) => {
    const dir = settings.get().logDir || defaultLogDir();
    try {
      logs.set(connId, new SessionLog(dir, name));
    } catch (e) {
      emit('app:notice', { message: `No se pudo crear el log: ${e instanceof Error ? e.message : e}` });
    }
  };

  handle('conn:open', (sessionId, cols, rows) => {
    const connId = randomUUID();
    const [id, c, r] = [str(sessionId), int(cols), int(rows)];
    const session = sessions.find(id);
    if ((session?.type === 'ssh' || session?.type === 'serial') && session.log) startLog(connId, session.name);
    // Both branches defer the open so the renderer has the connId before the first status event arrives.
    if (session?.type === 'serial') {
      const serial = new SerialPane(shellEvents(connId));
      shells.set(connId, serial);
      setImmediate(() => serial.open(session));
      return connId;
    }
    const shell = new SshShell(connDeps, shellEvents(connId));
    shells.set(connId, shell);
    setImmediate(() => void shell.open(id, c, r));
    return connId;
  });

  handle('serial:list', () => listSerialPorts());

  handle('local:shells', () => platform.localShells());
  handle('conn:openLocal', (shellPath, cols, rows) => {
    const shell = str(shellPath);
    // Only shells the platform listed: the renderer must not pick arbitrary executables.
    if (!platform.localShells().some((s) => s.path === shell)) throw new Error(`Shell no permitida: ${shell}`);
    const connId = randomUUID();
    const pty = new LocalPty(shellEvents(connId));
    shells.set(connId, pty);
    const [c, r] = [int(cols), int(rows)];
    setImmediate(() => pty.open(shell, c, r, path.join(opts.userData, 'shell-hooks')));
    return connId;
  });

  // --- tunnels ---
  const tunnels = new TunnelManager(() => new SshConnection(connDeps), (s) => emit('tunnel:status', s));
  const findTunnel = (sessionId: string, tunnelId: string) => {
    const s = sessions.find(sessionId);
    const t = s?.type === 'ssh' ? s.tunnels?.find((x) => x.id === tunnelId) : undefined;
    if (!t) throw new Error('Túnel no encontrado');
    return t;
  };
  handle('tunnel:list', () => tunnels.list());
  handle('tunnel:start', (sessionId, tunnelId) => void tunnels.start(str(sessionId), findTunnel(str(sessionId), str(tunnelId))));
  handle('tunnel:stop', (tunnelId) => tunnels.stop(str(tunnelId)));
  let autoStarted = false;
  win.webContents.once('did-finish-load', () => {
    // Once per app run, after the UI can answer host-key / password prompts.
    if (autoStarted) return;
    autoStarted = true;
    for (const s of sessions.get().sessions) {
      if (s.type === 'ssh') for (const t of s.tunnels ?? []) if (t.autoStart) void tunnels.start(s.id, t);
    }
  });

  // --- RDP ---
  const rdp = new RdpLauncher({
    platform,
    tunnels,
    secrets,
    certs: rdpCerts,
    askAuth: prompts.auth.bind(prompts),
    askChoice: prompts.choice.bind(prompts),
    emit: (s) => emit('rdp:status', s),
  });
  handle('rdp:launch', (sessionId) => {
    const s = sessions.find(str(sessionId));
    if (s?.type !== 'rdp') throw new Error('No es una sesión RDP');
    const rdpId = randomUUID();
    setImmediate(() => void rdp.launch(rdpId, s as RdpSession));
    return rdpId;
  });
  handle('rdp:focus', (id) => rdp.focus(str(id)));
  handle('rdp:stop', (id) => rdp.stop(str(id)));

  // --- imports from OpenSSH ---
  handle('import:sshConfig', () => {
    const file = path.join(os.homedir(), '.ssh', 'config');
    if (!fs.existsSync(file)) throw new Error('No existe ~/.ssh/config');
    const data = sessions.get();
    let folder = data.folders.find((f) => f.name === '~/.ssh/config' && !f.parentId);
    if (!folder) {
      folder = { id: randomUUID(), name: '~/.ssh/config', parentId: null };
      sessions.saveFolder(folder);
    }
    const created = sessionsFromSshConfig(fs.readFileSync(file, 'utf8'), {
      existing: data.sessions.filter((s): s is SshSession => s.type === 'ssh'),
      defaultUser: os.userInfo().username,
      hasAgent: !!platform.sshAgent(),
      folderId: folder.id,
      newId: randomUUID,
    });
    // Jump hosts first so references always point at saved sessions.
    const ordered = [...created].sort((a, b) => Number(!!a.jumpSessionId) - Number(!!b.jumpSessionId));
    for (const s of ordered) sessions.saveSession(s);
    changed();
    return created.length;
  });
  handle('import:knownHosts', () => {
    const file = path.join(os.homedir(), '.ssh', 'known_hosts');
    if (!fs.existsSync(file)) throw new Error('No existe ~/.ssh/known_hosts');
    return knownHosts.importFrom(fs.readFileSync(file, 'utf8'));
  });

  // --- settings & editor ---
  handle('settings:get', () => settings.get());
  handle('settings:set', (s) => settings.set(s));
  handle('app:info', () => ({ version: app.getVersion(), defaultLogDir: defaultLogDir() }));
  handle('editor:open', (connId, remotePath) => editor.open(str(connId), str(remotePath)));
  handle('editor:load', (id) => editor.load(str(id)));
  handle('editor:save', (id, content) => editor.save(str(id), str(content)));
  on('conn:write', (id, data) => shells.get(str(id))?.write(str(data)));
  on('conn:resize', (id, cols, rows) => shells.get(str(id))?.resize(int(cols), int(rows)));
  on('conn:close', (id) => {
    closeLog(str(id));
    shells.get(str(id))?.close();
    shells.delete(str(id));
    sftp.connectionClosed(str(id));
    editor.connectionClosed(str(id));
  });
  on('prompt:answer', (id, answer) => prompts.answer(str(id), answer));

  // A renderer reload leaves no one to answer prompts or read output. Tunnels keep running.
  const reset = () => {
    prompts.cancelAll();
    for (const [id, s] of shells) {
      closeLog(id);
      s.close();
      sftp.connectionClosed(id);
      editor.connectionClosed(id);
    }
    shells.clear();
    sftp.dispose();
  };
  win.webContents.on('did-start-navigation', (_e, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) reset();
  });
  return {
    /** The main window is gone: stop everything, including tunnels and RDP windows. */
    dispose: () => {
      reset();
      tunnels.stopAll();
      rdp.stopAll();
      editor.dispose();
    },
  };
}
