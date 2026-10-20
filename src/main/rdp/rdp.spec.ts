import { describe, expect, it } from 'vitest';
import { FreerdpOutput } from './rdp';

// Real FreeRDP 3.32 output for an untrusted self-signed certificate (stdin is not a terminal).
const REJECTED = `[20:44:19:498] [889827:000d93e6] [ERROR][com.freerdp.crypto] - [freerdp_tls_handshake]: certificate not trusted, aborting.
[20:44:19:498] [889827:000d93e6] [ERROR][com.freerdp.core] - [transport_default_connect_tls]: ERRCONNECT_TLS_CONNECT_FAILED [0x00020008]

Certificate details for 127.0.0.1:3390 (RDP-Server):
\tCommon Name: (null)
\tSubject:     (null)
\tIssuer:      (null)
\tValid from:  Oct 20 18:43:28 2026 GMT
\tValid to:    Oct 19 18:43:28 2031 GMT
\tThumbprint:  a6:ee:0b:74:6d:89:90:56:ef:21:e9:36:bb:6c:34:71:73:bb:2c:45:9c:26:ea:81:0e:bf:4f:8b:8d:2e:1b:26
The above X.509 certificate could not be verified, possibly because you do not have
the CA certificate in your certificate store, or the certificate has expired.
`;

describe('FreerdpOutput', () => {
  it('extracts the rejected certificate, even when split across chunks', () => {
    const o = new FreerdpOutput();
    o.feed(REJECTED.slice(0, 300));
    o.feed(REJECTED.slice(300));
    const r = o.certRejection();
    expect(r?.thumbprint).toBe('a6:ee:0b:74:6d:89:90:56:ef:21:e9:36:bb:6c:34:71:73:bb:2c:45:9c:26:ea:81:0e:bf:4f:8b:8d:2e:1b:26');
    expect(r?.details).toMatch(/^Certificate details for 127.0.0.1:3390/);
    expect(r?.details).toContain('Valid to:');
    expect(r?.details).not.toContain('could not be verified');
  });

  it('does not report a certificate problem for other failures', () => {
    const o = new FreerdpOutput();
    o.feed('[20:19:50:971] [1:2] [ERROR][com.freerdp.core] - [freerdp_connect]: ERRCONNECT_LOGON_FAILURE [0x00020014]\n');
    expect(o.certRejection()).toBeNull();
    expect(o.errors()).toBe('[freerdp_connect]: ERRCONNECT_LOGON_FAILURE [0x00020014]');
  });
});
