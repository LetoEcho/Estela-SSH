import type { SshSession } from '../../shared/session';

// Reads ~/.ssh/config into sessions. OpenSSH semantics: blocks apply in file order and the
// first value obtained for each keyword wins (so `Host *` at the top overrides later blocks).
// ponytail: Include, Match and ProxyCommand are ignored; add them if a real config needs them.

interface Block {
  patterns: string[];
  options: Map<string, string>;
}

const globToRegex = (g: string) =>
  new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');

function blockMatches(b: Block, alias: string): boolean {
  let hit = false;
  for (const p of b.patterns) {
    if (p.startsWith('!')) {
      if (globToRegex(p.slice(1)).test(alias)) return false;
    } else if (globToRegex(p).test(alias)) hit = true;
  }
  return hit;
}

export function parseSshConfig(text: string): Block[] {
  const blocks: Block[] = [{ patterns: ['*'], options: new Map() }]; // options before any Host apply to all
  let current: Block | null = blocks[0];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(\S+?)(?:\s*=\s*|\s+)(.+)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim().replace(/^"(.*)"$/, '$1');
    if (key === 'host') {
      current = { patterns: value.split(/\s+/), options: new Map() };
      blocks.push(current);
    } else if (key === 'match') {
      current = null; // unsupported: skip its options
    } else if (current && !current.options.has(key)) {
      current.options.set(key, value);
    }
  }
  return blocks;
}

/** Effective options for a host alias. */
export function resolveHost(blocks: Block[], alias: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const b of blocks) {
    if (!blockMatches(b, alias)) continue;
    for (const [k, v] of b.options) if (!out.has(k)) out.set(k, v);
  }
  return out;
}

/** Aliases that name concrete hosts (no wildcards, no negations). */
export function concreteAliases(blocks: Block[]): string[] {
  const seen = new Set<string>();
  for (const b of blocks.slice(1)) for (const p of b.patterns) if (!/[*?!]/.test(p)) seen.add(p);
  return [...seen];
}

export interface ImportOptions {
  existing: SshSession[];
  defaultUser: string;
  hasAgent: boolean;
  folderId: string;
  newId: () => string;
}

/** Sessions for every concrete Host (and for ProxyJump hops not defined as Hosts). Skips duplicates. */
export function sessionsFromSshConfig(text: string, o: ImportOptions): SshSession[] {
  const blocks = parseSshConfig(text);
  const created: SshSession[] = [];
  const all = () => [...o.existing, ...created];
  const same = (s: SshSession, host: string, port: number, user: string) =>
    s.host.toLowerCase() === host.toLowerCase() && s.port === port && s.username === user;

  const byAlias = new Map<string, SshSession>();
  // Two passes: create sessions, then link ProxyJump chains (hops may be defined later in the file).
  const aliases = concreteAliases(blocks);
  for (const alias of aliases) {
    const opt = resolveHost(blocks, alias);
    const host = (opt.get('hostname') ?? alias).replace(/%h/g, alias);
    const port = Number(opt.get('port') ?? 22);
    const user = opt.get('user') ?? o.defaultUser;
    const dup = all().find((s) => same(s, host, port, user));
    if (dup) {
      byAlias.set(alias, dup);
      continue;
    }
    const identity = opt.get('identityfile');
    const s: SshSession = {
      type: 'ssh', id: o.newId(), name: alias, folderId: o.folderId, color: '#56b6c2', icon: '🖥️',
      host, port, username: user,
      auth: identity ? 'key' : o.hasAgent ? 'agent' : 'password',
      ...(identity ? { keyPath: identity.replace(/^%d\//, '~/') } : {}),
    };
    created.push(s);
    byAlias.set(alias, s);
  }

  /** A hop is either a known alias or "[user@]host[:port]". */
  const hopSession = (hop: string): SshSession => {
    const known = byAlias.get(hop);
    if (known) return known;
    const m = /^(?:([^@]+)@)?(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(hop);
    const host = (m?.[2] ?? hop).replace(/^\[|\]$/g, '');
    const port = Number(m?.[3] ?? 22);
    const user = m?.[1] ?? o.defaultUser;
    const existing = all().find((s) => same(s, host, port, user));
    if (existing) return existing;
    const s: SshSession = {
      type: 'ssh', id: o.newId(), name: hop, folderId: o.folderId, color: '#56b6c2', icon: '🖥️',
      host, port, username: user, auth: o.hasAgent ? 'agent' : 'password',
    };
    created.push(s);
    byAlias.set(hop, s);
    return s;
  };

  for (const alias of aliases) {
    const s = byAlias.get(alias)!;
    const jump = resolveHost(blocks, alias).get('proxyjump');
    if (!jump || jump.toLowerCase() === 'none' || !created.includes(s)) continue;
    // "a,b" = first a, then b, then the target: target → b → a.
    let prev: SshSession | undefined;
    for (const hop of jump.split(',').map((h) => h.trim())) {
      const h = hopSession(hop);
      if (prev && created.includes(h) && !h.jumpSessionId && h.id !== prev.id) h.jumpSessionId = prev.id;
      prev = h;
    }
    if (prev && prev.id !== s.id) s.jumpSessionId = prev.id;
  }
  return created;
}
