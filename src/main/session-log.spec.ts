import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionLog, stripAnsi } from './session-log';

describe('session log', () => {
  it('strips colours, OSC titles/cwd and carriage returns', () => {
    expect(stripAnsi('\x1b[01;32muser@host\x1b[00m:~$ ls\r\n\x1b]7;file://h/tmp\x1b\\\x1b]0;title\x07file.txt\r\n')).toBe('user@host:~$ ls\nfile.txt\n');
  });

  it('writes to a timestamped file and handles escapes split across chunks', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'estela-log-'));
    const log = new SessionLog(dir, 'web 01/prod', new Date('2026-10-20T10:11:12Z'));
    expect(path.basename(log.file)).toBe('web_01_prod-20261020-101112.log');
    log.write('hola \x1b[3');
    log.write('1mrojo\x1b[0m\r\n\x1b]7;file://h/ho');
    log.write('me\x1b');
    log.write('\\$ ');
    log.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(fs.readFileSync(log.file, 'utf8')).toBe('hola rojo\n$ ');
  });
});
