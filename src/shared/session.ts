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

export type Parity = 'none' | 'even' | 'odd' | 'mark' | 'space';
export type FlowControl = 'none' | 'rtscts' | 'xonxoff';
/** What Enter (and every CR in pasted text) sends to the device. */
export type Newline = 'cr' | 'lf' | 'crlf';

/** Serial console over a COM / tty port, as MobaXterm's serial sessions. */
export interface SerialSession {
  type: 'serial';
  id: string;
  name: string;
  folderId: string | null;
  color: string;
  icon: string;
  /** `COM3` on Windows, `/dev/ttyUSB0` on Linux. Opened as given: it is a device, never a command. */
  path: string;
  baudRate: number;
  dataBits: 5 | 6 | 7 | 8;
  stopBits: 1 | 1.5 | 2;
  parity: Parity;
  flowControl: FlowControl;
  newline: Newline;
  /** Echo what is typed: serial devices usually do not echo by themselves. */
  localEcho: boolean;
  /** Save the session output to a log file. */
  log?: boolean;
}

export type Session = SshSession | RdpSession | SerialSession;

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

/** Anything that could start a new line (or confuse a line-based protocol) in the files we write. */
const CONTROL = /[\u0000-\u001f\u007f]/;

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
  // A user name is "DOMINIO\usuario" more often than not, and nothing here can escape its field:
  // FreeRDP is spawned with an argv array (no shell), so a value never becomes a second option.
  // What can escape is a line: mstsc's .rdp file is "key:s:value" per line and the Windows
  // credential is fed to PowerShell one line at a time, so control characters stay out.
  for (const [k, v] of Object.entries({ username: s.username, domain: s.domain })) {
    if (v && CONTROL.test(v)) fail(`${k} contains control characters`);
  }
  // Host and gateway are a name with a port, and the host is also the Credential Manager target
  // ("TERMSRV/<host>"): a separator there would change what we connect to.
  for (const [k, v] of Object.entries({ host: s.host, gateway: s.gateway })) {
    if (v && (/[\s,/\\]/.test(v) || CONTROL.test(v))) fail(`${k} contains invalid characters`);
  }
  return s;
}

/** Common serial speeds offered in the UI; any other integer is accepted too. */
export const BAUD_RATES = [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];
export const PARITIES: readonly Parity[] = ['none', 'even', 'odd', 'mark', 'space'];
export const FLOW_CONTROLS: readonly FlowControl[] = ['none', 'rtscts', 'xonxoff'];
export const NEWLINES: readonly Newline[] = ['cr', 'lf', 'crlf'];

function pick<T extends string>(o: Record<string, unknown>, k: string, allowed: readonly T[], fallback: T): T {
  const v = o[k];
  if (v === undefined || v === null || v === '') return fallback;
  if (!allowed.includes(v as T)) fail(`${k} must be one of ${allowed.join(', ')}`);
  return v as T;
}

function oneOfNum<T extends number>(o: Record<string, unknown>, k: string, allowed: readonly T[], fallback: T): T {
  const v = o[k];
  if (v === undefined || v === null) return fallback;
  if (!allowed.includes(v as T)) fail(`${k} must be one of ${allowed.join(', ')}`);
  return v as T;
}

function validateSerial(o: Record<string, unknown>): SerialSession {
  const baudRate = o['baudRate'];
  // The port is handed straight to the OS open(), so there is nothing to escape; only the speed needs a range.
  if (!Number.isInteger(baudRate) || (baudRate as number) < 50 || (baudRate as number) > 4_000_000) fail('baudRate must be 50-4000000');
  const s: SerialSession = {
    type: 'serial',
    id: str(o, 'id')!,
    name: str(o, 'name')!,
    folderId: str(o, 'folderId', true) ?? null,
    color: str(o, 'color', true) ?? '#4a90d9',
    icon: icon(o) ?? '🔌',
    path: str(o, 'path')!,
    baudRate: baudRate as number,
    dataBits: oneOfNum(o, 'dataBits', [5, 6, 7, 8] as const, 8),
    stopBits: oneOfNum(o, 'stopBits', [1, 1.5, 2] as const, 1),
    parity: pick(o, 'parity', PARITIES, 'none'),
    flowControl: pick(o, 'flowControl', FLOW_CONTROLS, 'none'),
    newline: pick(o, 'newline', NEWLINES, 'cr'),
    localEcho: o['localEcho'] === true,
  };
  if (o['log'] === true) s.log = true;
  return s;
}

export function validateSession(x: unknown): Session {
  const o = obj(x, 'session');
  if (o['type'] === 'rdp') return validateRdp(o);
  if (o['type'] === 'serial') return validateSerial(o);
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
