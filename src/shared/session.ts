export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  icon?: string;
}

export type SshAuth = 'password' | 'key' | 'agent';

/** L: local port → remote dest; R: remote port → local dest; D: local SOCKS5 proxy. */
export interface Tunnel {
  id: string;
  kind: 'L' | 'R' | 'D';
  bindHost: string;
  bindPort: number;
  destHost?: string;
  destPort?: number;
  /** Start when the app starts. */
  autoStart: boolean;
}

export interface SshSession {
  type: 'ssh';
  id: string;
  name: string;
  folderId: string | null;
  color: string;
  /** An emoji, or a custom image embedded as a data: URL so exports stay self-contained. */
  icon: string;
  host: string;
  port: number;
  username: string;
  auth: SshAuth;
  /** Stored with a leading "~/" when under the home dir so the file stays portable. */
  keyPath?: string;
  jumpSessionId?: string;
  initialDir?: string;
  tunnels?: Tunnel[];
  /** Save the session output to a log file. */
  log?: boolean;
}

export interface RdpSession {
  type: 'rdp';
  id: string;
  name: string;
  folderId: string | null;
  color: string;
  icon: string;
  host: string;
  port: number;
  username: string;
  domain?: string;
  /** 'fullscreen' or a window size such as "1600x900". */
  screen: string;
  multimon: boolean;
  clipboard: boolean;
  /** Redirect the local home directory as a drive. */
  drives: boolean;
  /** RD Gateway host[:port]; uses the same credentials as the server. */
  gateway?: string;
  /** Reach the RDP host through this SSH session (automatic local tunnel). */
  viaSshSessionId?: string;
}

export type Session = SshSession | RdpSession;

export interface SessionsFile {
  version: 1;
  folders: Folder[];
  sessions: Session[];
}

export type SecretKind = 'password' | 'passphrase';

export const emptySessionsFile = (): SessionsFile => ({ version: 1, folders: [], sessions: [] });

// Validation runs on every trust boundary (IPC from the renderer, imported files).

function fail(msg: string): never {
  throw new Error(`Invalid data: ${msg}`);
}

function str(o: Record<string, unknown>, k: string, optional = false): string | undefined {
  const v = o[k];
  if (v === undefined || v === null || v === '') {
    if (optional) return undefined;
    fail(`${k} is required`);
  }
  if (typeof v !== 'string' || v.length > 4096) fail(`${k} must be a string`);
  return v;
}

function obj(x: unknown, what: string): Record<string, unknown> {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) fail(`${what} must be an object`);
  return x as Record<string, unknown>;
}

export const MAX_ICON_BYTES = 512 * 1024;
const ICON_DATA_URL = /^data:image\/(x-icon|vnd\.microsoft\.icon|png|svg\+xml);base64,[A-Za-z0-9+/]+=*$/;

function icon(o: Record<string, unknown>): string | undefined {
  const v = o['icon'];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') fail('icon must be a string');
  if (v.startsWith('data:')) {
    if (v.length > (MAX_ICON_BYTES * 4) / 3 + 64 || !ICON_DATA_URL.test(v)) fail('icon must be an .ico, .png or .svg image up to 512 KB');
  } else if (v.length > 16) {
    fail('icon must be an emoji or an image');
  }
  return v;
}

export function validateFolder(x: unknown): Folder {
  const o = obj(x, 'folder');
  const f: Folder = { id: str(o, 'id')!, name: str(o, 'name')!, parentId: str(o, 'parentId', true) ?? null };
  const i = icon(o);
  if (i) f.icon = i;
  return f;
}

function port(o: Record<string, unknown>, k: string, optional = false): number | undefined {
  const v = o[k];
  if (optional && (v === undefined || v === null)) return undefined;
  if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 65535) fail(`${k} must be 0-65535`);
  return v as number;
}

export function validateTunnel(x: unknown): Tunnel {
  const o = obj(x, 'tunnel');
  const kind = o['kind'];
  if (kind !== 'L' && kind !== 'R' && kind !== 'D') fail('tunnel kind must be L, R or D');
  const t: Tunnel = {
    id: str(o, 'id')!,
    kind,
    bindHost: str(o, 'bindHost', true) ?? '127.0.0.1',
    bindPort: port(o, 'bindPort')!,
    autoStart: o['autoStart'] === true,
  };
  if (kind !== 'D') {
    t.destHost = str(o, 'destHost')!;
    t.destPort = port(o, 'destPort')!;
    if (t.destPort === 0) fail('destPort must be 1-65535');
  }
  if (kind !== 'R' && t.bindPort === 0) fail('bindPort must be 1-65535');
  return t;
}

function validateRdp(o: Record<string, unknown>): RdpSession {
  const screen = str(o, 'screen', true) ?? 'fullscreen';
  if (screen !== 'fullscreen' && !/^\d{3,5}x\d{3,5}$/.test(screen)) fail('screen must be fullscreen or WIDTHxHEIGHT');
  const s: RdpSession = {
    type: 'rdp',
    id: str(o, 'id')!,
    name: str(o, 'name')!,
    folderId: str(o, 'folderId', true) ?? null,
    color: str(o, 'color', true) ?? '#4a90d9',
    icon: icon(o) ?? '🪟',
    host: str(o, 'host')!,
    port: port(o, 'port', true) ?? 3389,
    username: str(o, 'username')!,
    domain: str(o, 'domain', true),
    screen,
    multimon: o['multimon'] === true,
    clipboard: o['clipboard'] !== false,
    drives: o['drives'] === true,
    gateway: str(o, 'gateway', true),
    viaSshSessionId: str(o, 'viaSshSessionId', true),
  };
  if (s.port === 0) fail('port must be 1-65535');
  // FreeRDP options are built from these: keep them free of separators that could inject options.
  for (const [k, v] of Object.entries({ host: s.host, username: s.username, domain: s.domain, gateway: s.gateway })) {
    if (v && /[\s,/\\]/.test(v)) fail(`${k} contains invalid characters`);
  }
  return s;
}

export function validateSession(x: unknown): Session {
  const o = obj(x, 'session');
  if (o['type'] === 'rdp') return validateRdp(o);
  if (o['type'] !== 'ssh') fail(`unsupported session type ${String(o['type'])}`);
  const port = o['port'];
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) fail('port must be 1-65535');
  const auth = o['auth'];
  if (auth !== 'password' && auth !== 'key' && auth !== 'agent') fail('auth must be password, key or agent');
  const s: SshSession = {
    type: 'ssh',
    id: str(o, 'id')!,
    name: str(o, 'name')!,
    folderId: str(o, 'folderId', true) ?? null,
    color: str(o, 'color', true) ?? '#4a90d9',
    icon: icon(o) ?? '🖥️',
    host: str(o, 'host')!,
    port: port as number,
    username: str(o, 'username')!,
    auth,
    keyPath: str(o, 'keyPath', true),
    jumpSessionId: str(o, 'jumpSessionId', true),
    initialDir: str(o, 'initialDir', true),
  };
  if (Array.isArray(o['tunnels']) && o['tunnels'].length) s.tunnels = o['tunnels'].map(validateTunnel);
  if (o['log'] === true) s.log = true;
  if (s.auth === 'key' && !s.keyPath) fail('keyPath is required for key auth');
  if (s.jumpSessionId === s.id) fail('a session cannot be its own jump host');
  return s;
}

export function validateSessionsFile(x: unknown): SessionsFile {
  const o = obj(x, 'sessions file');
  if (o['version'] !== 1) fail('unsupported version');
  if (!Array.isArray(o['folders']) || !Array.isArray(o['sessions'])) fail('folders and sessions must be arrays');
  return {
    version: 1,
    folders: o['folders'].map(validateFolder),
    sessions: o['sessions'].map(validateSession),
  };
}
