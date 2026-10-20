import { readJson, writeAtomic } from './fs-util';

/** Trusted RDP server certificates (SHA-256 thumbprints), keyed by "host:port" of the real server. */
export class RdpCerts {
  private data: Record<string, string>;

  constructor(private readonly file: string) {
    this.data = (readJson(file) as Record<string, string> | undefined) ?? {};
  }

  get(hostPort: string): string | undefined {
    return this.data[hostPort];
  }

  set(hostPort: string, thumbprint: string): void {
    this.data[hostPort] = thumbprint;
    writeAtomic(this.file, JSON.stringify(this.data, null, 2));
  }
}
