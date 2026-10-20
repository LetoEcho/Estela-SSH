import { describe, expect, it } from 'vitest';
import { collapseHome, expandHome } from './paths';

describe('home paths', () => {
  it('collapses paths under home and expands them back', () => {
    expect(collapseHome('/home/u/.ssh/id', '/home/u')).toBe('~/.ssh/id');
    expect(collapseHome('/etc/key', '/home/u')).toBe('/etc/key');
    expect(expandHome('~/.ssh/id', '/home/u')).toBe('/home/u/.ssh/id');
    expect(expandHome('/abs', '/home/u')).toBe('/abs');
  });
});
