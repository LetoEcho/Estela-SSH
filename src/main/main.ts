import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, Menu, net, protocol, safeStorage, session, shell } from 'electron';
import { registerIpc } from './ipc';
import { platform } from './platform';
import { KnownHosts } from './store/known-hosts';
import { SecretStore } from './store/secrets';
import { SessionStore } from './store/sessions';

const DEV_URL = process.env['ESTELA_DEV_URL'];
const RENDERER_DIR = path.join(__dirname, '../renderer/browser');
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'", // xterm.js and Angular set inline styles
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
].join('; ');

// Keep the data dir free of spaces: ~/.config/estela-ssh. ESTELA_USER_DATA isolates test runs.
app.setPath('userData', process.env['ESTELA_USER_DATA'] ?? path.join(app.getPath('appData'), 'estela-ssh'));
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

async function serveRenderer(req: Request): Promise<Response> {
  let file = path.join(RENDERER_DIR, decodeURIComponent(new URL(req.url).pathname));
  if (!file.startsWith(RENDERER_DIR + path.sep)) return new Response('Forbidden', { status: 403 });
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(RENDERER_DIR, 'index.html');
  const res = await net.fetch(pathToFileURL(file).toString());
  const headers = new Headers(res.headers);
  headers.set('Content-Security-Policy', CSP);
  return new Response(res.body, { status: res.status, headers });
}

app.whenReady().then(() => {
  if (!DEV_URL) protocol.handle('app', serveRenderer);
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) =>
    cb(perm === 'clipboard-read' || perm === 'clipboard-sanitized-write'),
  );
  Menu.setApplicationMenu(null);

  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stores = {
    sessions: new SessionStore(path.join(dir, 'sessions.json')),
    secrets: new SecretStore(path.join(dir, 'secrets.json'), safeStorage, platform.secretBackend()),
    knownHosts: new KnownHosts(path.join(dir, 'known_hosts')),
  };

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'Estela SSH',
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const dispose = registerIpc(win, stores);
  win.on('closed', dispose);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });
  void win.loadURL(DEV_URL ?? 'app://estela/index.html');
});

app.on('window-all-closed', () => app.quit());
