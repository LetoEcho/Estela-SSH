import { describe, expect, it } from 'vitest';
import { parseOsc7 } from './osc7';

describe('parseOsc7', () => {
  it('extracts the path with or without host', () => {
    expect(parseOsc7('file://web01/var/log')).toBe('/var/log');
    expect(parseOsc7('file:///tmp')).toBe('/tmp');
  });
  it('decodes percent-encoding and tolerates raw paths', () => {
    expect(parseOsc7('file://h/home/u/My%20Docs')).toBe('/home/u/My Docs');
    expect(parseOsc7('file://h/home/u/My Docs')).toBe('/home/u/My Docs');
    expect(parseOsc7('file://h/tmp/100%')).toBe('/tmp/100%');
  });
  it('rejects anything that is not a file URL', () => {
    expect(parseOsc7('http://x/y')).toBeNull();
    expect(parseOsc7('file://host')).toBeNull();
  });
});
