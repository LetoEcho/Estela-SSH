import type { RdpSession } from '../../shared/session';
import type { FreerdpTarget } from './freerdp-args';

/**
 * .rdp file for mstsc. No password here: it goes to Credential Manager (TERMSRV/<host>).
 * Field values were validated to contain no whitespace, so no line injection.
 * `driveRoot` (e.g. "C:\\") is the drive shared when the session shares the home folder.
 */
export function mstscFile(s: RdpSession, target: FreerdpTarget, driveRoot: string): string {
  const [w, h] = s.screen === 'fullscreen' ? [] : s.screen.split('x');
  const lines = [
    `full address:s:${target.host}:${target.port}`,
    `username:s:${s.domain ? `${s.domain}\\` : ''}${s.username}`,
    'prompt for credentials:i:0',
    // 2 = warn on certificate problems and let the user decide (mstsc shows its own dialog).
    'authentication level:i:2',
    `screen mode id:i:${s.screen === 'fullscreen' ? 2 : 1}`,
    ...(w ? [`desktopwidth:i:${w}`, `desktopheight:i:${h}`] : []),
    `use multimon:i:${s.multimon ? 1 : 0}`,
    `redirectclipboard:i:${s.clipboard ? 1 : 0}`,
    ...(s.drives ? [`drivestoredirect:s:${driveRoot.replace(/\\$/, '')}\\;`] : []),
    // Same credentials for the gateway as for the server, like with FreeRDP.
    ...(s.gateway ? [`gatewayhostname:s:${s.gateway}`, 'gatewayusagemethod:i:1', 'gatewaycredentialssource:i:0', 'promptcredentialonce:i:1'] : []),
  ];
  return lines.join('\r\n') + '\r\n';
}

/** Credential Manager target mstsc looks up (host only, no port). */
export const mstscCredTarget = (host: string) => `TERMSRV/${host}`;
