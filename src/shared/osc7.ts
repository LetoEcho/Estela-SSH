/** Decodes the path from an OSC 7 payload: file://host/path (percent-encoded or raw). */
export function parseOsc7(data: string): string | null {
  const m = /^file:\/\/[^/]*(\/.*)$/.exec(data);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1]; // raw $PWD containing a literal '%'
  }
}
