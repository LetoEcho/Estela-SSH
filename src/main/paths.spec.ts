import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { collapseHome, expandHome, localName } from './paths';

describe('home paths', () => {
  it('collapses paths under home and expands them back', () => {
    expect(collapseHome('/home/u/.ssh/id', '/home/u')).toBe('~/.ssh/id');
    expect(collapseHome('/etc/key', '/home/u')).toBe('/etc/key');
    expect(expandHome('~/.ssh/id', '/home/u')).toBe(path.join('/home/u', '.ssh', 'id'));
    expect(expandHome('/abs', '/home/u')).toBe('/abs');
  });
});

describe('localName', () => {
  it('keeps names untouched outside Windows', () => {
    expect(localName('a:b?.txt', false)).toBe('a:b?.txt');
  });

  it('makes remote names valid on Windows', () => {
    expect(localName('backup 2024-01-01 10:00.tar', true)).toBe('backup 2024-01-01 10_00.tar');
    expect(localName('what?.', true)).toBe('what__');
    expect(localName('nul.txt', true)).toBe('_nul.txt');
    expect(localName('console.log', true)).toBe('console.log');
  });
});
