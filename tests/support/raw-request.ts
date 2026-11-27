// A request written byte for byte onto a socket, for the cases an HTTP client will not send.
//
// `fetch` and node's own client tidy a request line before it leaves (`GET //` becomes `GET /`), so a test that must prove
// what a server does with an UNREADABLE address (audit 27 Nov 2026, item 4) has to write the line itself. The answer is read
// until the server closes the connection (`Connection: close`), or the wait runs out — then it says so instead of hanging.

import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

export interface RawAnswer {
  /** The status code from the answer's first line, or 0 when nothing came back. */
  readonly status: number;
  /** Every byte the server sent, as text. */
  readonly text: string;
  /** True when the wait ran out before the server finished answering. */
  readonly timedOut: boolean;
}

/**
 * Sends `requestLine` (for example `GET // HTTP/1.1`) with a Host header and `Connection: close`, then reads the answer.
 * `tls.ca` talks TLS to a door that trusts that authority (the handheld door, OB-422) — never with certificate checks off.
 */
export function rawRequest(port: number, requestLine: string, opts: { readonly host?: string; readonly hostHeader?: string; readonly tls?: { readonly ca: string }; readonly waitMs?: number } = {}): Promise<RawAnswer> {
  const host = opts.host ?? '127.0.0.1';
  const bytes = `${requestLine}\r\nHost: ${opts.hostHeader ?? `${host}:${port}`}\r\nConnection: close\r\n\r\n`;
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let done = false;
    const finish = (timedOut: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      const text = Buffer.concat(chunks).toString('utf8');
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(text)?.[1] ?? '0');
      resolve({ status, text, timedOut });
    };
    const socket = opts.tls === undefined
      ? netConnect({ host, port }, () => { socket.write(bytes); })
      : tlsConnect({ host, port, ca: opts.tls.ca, servername: host === '127.0.0.1' ? undefined : host, minVersion: 'TLSv1.2' }, () => { socket.write(bytes); });
    const timer = setTimeout(() => { finish(true); }, opts.waitMs ?? 3000);
    socket.on('data', (c: Buffer) => { chunks.push(c); });
    socket.on('end', () => { finish(false); });
    socket.on('close', () => { finish(false); });
    socket.on('error', () => { finish(false); });
  });
}
