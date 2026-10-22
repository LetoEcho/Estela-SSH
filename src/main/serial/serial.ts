import { StringDecoder } from 'node:string_decoder';
import { SerialPort } from 'serialport';
import type { SerialPortInfo } from '../../shared/ipc';
import type { Newline, Parity, SerialSession } from '../../shared/session';
import type { ShellEvents } from '../ssh/connection';

/** serialport's open options, as far as we set them. */
export interface SerialOptions {
  path: string;
  baudRate: number;
  dataBits: 5 | 6 | 7 | 8;
  stopBits: 1 | 1.5 | 2;
  parity: Parity;
  rtscts: boolean;
  xon: boolean;
  xoff: boolean;
}

/** The part of a serialport stream this class uses; SerialPortMock also matches it, which is how the spec drives it. */
export interface PortLike {
  isOpen: boolean;
  on(event: 'data', cb: (d: Buffer) => void): unknown;
  on(event: 'close', cb: () => void): unknown;
  on(event: 'error', cb: (e: Error) => void): unknown;
  write(data: string | Buffer, encoding?: BufferEncoding): unknown;
  close(cb?: (e?: Error | null) => void): unknown;
}

export type OpenPort = (opts: SerialOptions, onOpen: (err: Error | null) => void) => PortLike;

export function serialOptions(s: SerialSession): SerialOptions {
  return {
    path: s.path,
    baudRate: s.baudRate,
    dataBits: s.dataBits,
    stopBits: s.stopBits,
    parity: s.parity,
    rtscts: s.flowControl === 'rtscts',
    // Software flow control is symmetric: both directions or neither.
    xon: s.flowControl === 'xonxoff',
    xoff: s.flowControl === 'xonxoff',
  };
}

/** xterm sends CR for Enter; devices may want LF or CRLF instead. Pasted text carries CRs too. */
export function toDevice(data: string, newline: Newline): string {
  return newline === 'cr' ? data : data.replace(/\r/g, newline === 'lf' ? '\n' : '\r\n');
}

/** A terminal only moves to column 0 on CR and down a line on LF, so a local echo of Enter needs both. */
export const toEcho = (data: string): string => data.replace(/\r/g, '\r\n');

/** A serial console in a pane; same surface as SshShell / LocalPty for the renderer. */
export class SerialPane {
  private port?: PortLike;
  private closed = false;
  private newline: Newline = 'cr';
  private localEcho = false;
  /** Keeps a multi-byte character split across two reads from turning into two replacement chars. */
  private readonly decoder = new StringDecoder('utf8');

  constructor(
    private readonly events: ShellEvents,
    private readonly openPort: OpenPort = (opts, cb) => new SerialPort({ ...opts, autoOpen: true }, cb),
  ) {}

  open(session: SerialSession): void {
    this.newline = session.newline;
    this.localEcho = session.localEcho;
    try {
      const port = (this.port = this.openPort(serialOptions(session), (err) => {
        if (err) return this.fail(err);
        this.events.status('connected');
      }));
      port.on('data', (d) => this.events.data(this.decoder.write(d)));
      port.on('error', (e) => this.fail(e));
      port.on('close', () => {
        if (!this.closed) this.events.status('closed');
        this.closed = true;
      });
    } catch (e) {
      this.fail(e instanceof Error ? e : new Error(String(e)));
    }
  }

  private fail(e: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.events.status('error', e.message);
  }

  write(data: string): void {
    if (this.closed) return;
    if (this.localEcho) this.events.data(toEcho(data));
    // ponytail: text only. A serial file transfer (xmodem…) would need a binary channel, which no pane has.
    this.port?.write(toDevice(data, this.newline), 'utf8');
  }

  /** A serial line has no window size. */
  resize(): void {}

  /** No cwd hook on a serial console: there is no shell to ask. */
  retryHook(): void {}

  async cwd(): Promise<string | null> {
    return null;
  }

  close(): void {
    this.closed = true;
    if (this.port?.isOpen) this.port.close();
  }
}

/** Ports the OS reports. Windows' friendlyName is the only label a user recognises ("USB Serial Port (COM3)"). */
export async function listSerialPorts(): Promise<SerialPortInfo[]> {
  const ports = await SerialPort.list();
  return ports.map((p) => {
    const label = (p as { friendlyName?: string }).friendlyName ?? p.manufacturer;
    return label ? { path: p.path, label } : { path: p.path };
  });
}
