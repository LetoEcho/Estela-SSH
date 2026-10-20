import { Injectable, signal } from '@angular/core';
import type { TunnelStatus } from '../../shared/ipc';
import type { Tunnel } from '../../shared/session';
import { estela } from './estela';

export function describeTunnel(t: Tunnel): string {
  const bind = `${t.bindHost}:${t.bindPort}`;
  if (t.kind === 'D') return `SOCKS5 en ${bind}`;
  if (t.kind === 'L') return `${bind} → ${t.destHost}:${t.destPort}`;
  return `remoto ${bind} → ${t.destHost}:${t.destPort}`;
}

@Injectable({ providedIn: 'root' })
export class TunnelsService {
  readonly states = signal(new Map<string, TunnelStatus>());

  constructor() {
    estela.on('tunnel:status', (s) => this.states.update((m) => new Map(m).set(s.tunnelId, s)));
    void estela.invoke('tunnel:list').then((list) => this.states.set(new Map(list.map((s) => [s.tunnelId, s]))));
  }

  start = (sessionId: string, tunnelId: string) => estela.invoke('tunnel:start', sessionId, tunnelId);
  stop = (tunnelId: string) => estela.invoke('tunnel:stop', tunnelId);
}
