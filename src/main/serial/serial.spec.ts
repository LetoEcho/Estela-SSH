import { SerialPortMock } from 'serialport';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConnStatus } from '../../shared/ipc';
import type { SerialSession } from '../../shared/session';
import type { ShellEvents } from '../ssh/connection';
import { SerialPane, explainOpenError, serialOptions, toDevice } from './serial';

const PATH = '/dev/estela-mock';

const session = (over: Partial<SerialSession> = {}): SerialSession => ({
  type: 'serial',
  id: 's1',
  name: 'router',
  folderId: null,
  color: '#fff',
  icon: '🔌',
  path: PATH,
  baudRate: 9600,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
  newline: 'cr',
  localEcho: false,
  ...over,
});

/** Collects what the pane reports to the renderer. */
function recorder() {
  const out: string[] = [];
  const status: { s: ConnStatus; error?: string }[] = [];
  const events: ShellEvents = {
    data: (d) => out.push(d),
    status: (s, error) => status.push({ s, error }),
    hook: () => {},
  };
  return { events, text: () => out.join(''), status };
}

/** The mock binding writes and reads on the next ticks, so every assertion waits for them. */
const settle = () => new Promise((r) => setTimeout(r, 10));

function connect(s: SerialSession = session()) {
  const rec = recorder();
  const pane = new SerialPane(rec.events, (opts, cb) => new SerialPortMock(opts, cb));
  pane.open(s);
  return { pane, ...rec, port: () => (pane as unknown as { port: SerialPortMock }).port };
}

describe('serialOptions', () => {
  it('maps hardware flow control to rtscts only', () => {
    expect(serialOptions(session({ flowControl: 'rtscts' }))).toMatchObject({ rtscts: true, xon: false, xoff: false });
  });

  it('maps software flow control to both xon and xoff', () => {
    expect(serialOptions(session({ flowControl: 'xonxoff' }))).toMatchObject({ rtscts: false, xon: true, xoff: true });
  });

  it('carries the line settings through unchanged', () => {
    expect(serialOptions(session({ baudRate: 115200, dataBits: 7, stopBits: 2, parity: 'even' }))).toMatchObject({
      path: PATH,
      baudRate: 115200,
      dataBits: 7,
      stopBits: 2,
      parity: 'even',
    });
  });
});

describe('toDevice', () => {
  it('leaves CR alone, and rewrites every CR for lf and crlf', () => {
    expect(toDevice('a\rb\r', 'cr')).toBe('a\rb\r');
    expect(toDevice('a\rb\r', 'lf')).toBe('a\nb\n');
    expect(toDevice('a\rb\r', 'crlf')).toBe('a\r\nb\r\n');
  });
});

describe('explainOpenError', () => {
  it('explains the two settings only Windows supports and leaves anything else alone', () => {
    // What the unix binding really answers (serialport_unix.cpp): a number, with no hint.
    expect(explainOpenError('Error: Invalid parity setting 4')).toMatch(/mark ni space.*Invalid parity setting 4/s);
    expect(explainOpenError('Error: Invalid stop bits setting 3')).toMatch(/1,5 bits de parada/);
    expect(explainOpenError('Opening COM3: Access denied')).toBe('Opening COM3: Access denied');
  });
});

describe('SerialPane', () => {
  afterEach(() => SerialPortMock.binding.reset());

  it('connects, passes data through and reports the close', async () => {
    SerialPortMock.binding.createPort(PATH, { echo: false, record: true });
    const c = connect();
    await settle();
    expect(c.status.map((x) => x.s)).toEqual(['connected']);

    c.port().port?.emitData(Buffer.from('listo> '));
    await settle();
    expect(c.text()).toBe('listo> ');

    c.pane.close();
    await settle();
    // close() is the user closing the pane: the renderer already knows, so no extra status.
    expect(c.status.map((x) => x.s)).toEqual(['connected']);
  });

  it('keeps a multi-byte character that arrives split across two reads', async () => {
    SerialPortMock.binding.createPort(PATH, { echo: false, record: true });
    const c = connect();
    await settle();
    const enye = Buffer.from('ñ', 'utf8');
    c.port().port?.emitData(enye.subarray(0, 1));
    await settle();
    c.port().port?.emitData(enye.subarray(1));
    await settle();
    expect(c.text()).toBe('ñ');
    c.pane.close();
  });

  it('writes the configured newline and echoes locally when asked', async () => {
    SerialPortMock.binding.createPort(PATH, { echo: false, record: true });
    const c = connect(session({ newline: 'crlf', localEcho: true }));
    await settle();
    c.pane.write('ls\r');
    await settle();
    expect(c.port().port?.recording.toString()).toBe('ls\r\n');
    // The echo is what the user sees: CR alone would leave the cursor on the same line.
    expect(c.text()).toBe('ls\r\n');
    c.pane.close();
  });

  it('does not echo by default', async () => {
    SerialPortMock.binding.createPort(PATH, { echo: false, record: true });
    const c = connect();
    await settle();
    c.pane.write('x');
    await settle();
    expect(c.port().port?.recording.toString()).toBe('x');
    expect(c.text()).toBe('');
    c.pane.close();
  });

  it('reports a port that cannot be opened as an error', async () => {
    const c = connect(session({ path: '/dev/does-not-exist' }));
    await settle();
    expect(c.status[0].s).toBe('error');
    expect(c.status[0].error).toBeTruthy();
  });

  it('reports the device hanging up as a close', async () => {
    SerialPortMock.binding.createPort(PATH, { echo: false, record: true });
    const c = connect();
    await settle();
    await new Promise<void>((done) => c.port().close(() => done()));
    await settle();
    expect(c.status.map((x) => x.s)).toEqual(['connected', 'closed']);
  });
});
