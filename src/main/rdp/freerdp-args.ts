import type { RdpSession } from '../../shared/session';

export interface FreerdpTarget {
  host: string;
  port: number;
  /** SHA-256 thumbprint the user trusted; FreeRDP then accepts only that certificate (also through tunnels). */
  thumbprint?: string;
}

/**
 * FreeRDP 3 command line. The password is never here (it would show in `ps`): it goes through
 * stdin thanks to /from-stdin:force. Field values were validated to contain no separators.
 */
export function freerdpArgs(s: RdpSession, target: FreerdpTarget): string[] {
  const args = [`/v:${target.host}:${target.port}`, `/u:${s.username}`];
  if (s.domain) args.push(`/d:${s.domain}`);
  args.push('/from-stdin:force', `/t:${s.name}`);
  args.push(s.screen === 'fullscreen' ? '/f' : `/size:${s.screen}`);
  if (s.multimon) args.push('/multimon');
  if (!s.clipboard) args.push('-clipboard');
  if (s.drives) args.push('+home-drive');
  // Without u:/p: FreeRDP reuses the server credentials for the gateway.
  if (s.gateway) args.push(`/gateway:g:${s.gateway}`);
  if (target.thumbprint) args.push(`/cert:fingerprint:sha256:${target.thumbprint}`);
  args.push('/log-level:WARN');
  return args;
}
