// D14 / M32 round 12 — the production OUTBOUND webhook transport: HTTPS to exactly the address the SSRF guard vetted
// (P-04 secure by design · §30.1 · hard rule #4).
//
// The outbound pass judges a partner's URL just before every send (public-destination.ts) and hands the transport the
// address it vetted. This transport:
//
//   • connects ONLY to that vetted address — it never looks the name up again (a second lookup is where DNS rebinding
//     would slip a private address in between the check and the connection). No vetted address → nothing is sent;
//   • speaks TLS to the partner by NAME: SNI and the certificate check use the URL's host name, and the Host header is
//     the URL's host — so the pinned connection is still the partner's own, verified certificate;
//   • never follows a redirect — a 3xx is the answer, recorded with its status by the pass (a redirect could point
//     anywhere, including head office's own network);
//   • gives up on a connection that does not finish its TLS handshake in time, and on a whole exchange that runs too
//     long; reads at most a capped amount of the partner's reply (only the status matters);
//   • logs nothing secret — never the headers (they carry the signature), the body, the path or the query: only the
//     partner's host name, the address, the status and how long it took.
//
// It is composed into the head-office process only when the operator configures it (OUTBOUND_WEBHOOK_TRANSPORT=https).
// Configuring it turns on no partner: a partner subscription still needs two people (maker-checker) and a signing secret.

import { request } from 'node:https';
import { isIP } from 'node:net';
import { checkServerIdentity, type PeerCertificate } from 'node:tls';
import type { OutboundTransport } from './outbound-webhooks';

export interface HttpsOutboundOptions {
  /** How long the TCP connection AND TLS handshake may take (default 5 s). */
  readonly connectTimeoutMs?: number;
  /** How long the whole exchange may take, request to last byte read (default 15 s). */
  readonly totalTimeoutMs?: number;
  /** The most of the partner's reply that is read (default 64 KiB); the rest is dropped — only the status matters. */
  readonly maxResponseBytes?: number;
  /** Extra certificate authorities to trust (a test's run-time self-signed one). Default: the system's. */
  readonly ca?: string | Buffer | readonly (string | Buffer)[];
  /** Where a line about each send goes — host, address, status, time; never a header, body, path or query. */
  readonly say?: (line: string) => void;
  /**
   * TEST SEAM ONLY — production composition never sets it. Where to actually dial for a vetted address, so a test can
   * stand a local TLS server behind a synthetic public address the guard accepts. Default: the vetted address itself.
   */
  readonly dialForTest?: (address: string, port: number) => { readonly host: string; readonly port: number };
}

/** Why a send was not attempted or did not complete — said without anything the request carried. */
export class OutboundTransportError extends Error {}

export function httpsOutboundTransport(options: HttpsOutboundOptions = {}): OutboundTransport {
  const connectMs = options.connectTimeoutMs ?? 5_000;
  const totalMs = options.totalTimeoutMs ?? 15_000;
  const cap = options.maxResponseBytes ?? 64 * 1024;
  return {
    name: 'https',
    send: ({ url, headers, body, address }) => new Promise((resolve, reject) => {
      if (address === undefined || isIP(address) === 0) {
        reject(new OutboundTransportError('not sent: no vetted address — this transport never looks a name up itself'));
        return;
      }
      let u: URL;
      try { u = new URL(url); } catch { reject(new OutboundTransportError('not sent: not a URL')); return; }
      if (u.protocol !== 'https:' || u.username !== '' || u.password !== '') { reject(new OutboundTransportError('not sent: only a plain https address is sent to')); return; }
      const hostname = u.hostname.replace(/^\[|\]$/g, '');
      const port = u.port === '' ? 443 : Number(u.port);
      const target = options.dialForTest?.(address, port) ?? { host: address, port };
      const started = Date.now();
      let settled = false;
      let connectTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (outcome: { status: number } | Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(totalTimer);
        if (connectTimer !== undefined) clearTimeout(connectTimer);
        options.say?.(`POST to ${hostname} at ${address} → ${outcome instanceof Error ? outcome.message : outcome.status} in ${Date.now() - started} ms`);
        if (outcome instanceof Error) reject(outcome); else resolve({ status: outcome.status });
      };
      const req = request({
        host: target.host, port: target.port, method: 'POST', path: `${u.pathname}${u.search}`,
        // SNI names the partner (never an IP literal); the certificate is checked against the partner's NAME.
        ...(isIP(hostname) === 0 ? { servername: hostname } : {}),
        checkServerIdentity: (_host: string, cert: PeerCertificate) => checkServerIdentity(hostname, cert),
        headers: { ...headers, host: u.host, 'content-length': String(Buffer.byteLength(body)) },
        agent: false, rejectUnauthorized: true,
        ...(options.ca === undefined ? {} : { ca: options.ca as string | Buffer | (string | Buffer)[] }),
        // The host dialled is an IP address, so nothing is looked up; refuse outright if anything ever asks.
        lookup: (_name: string, _opts: unknown, cb: (err: Error | null, address: string, family: number) => void) => cb(new OutboundTransportError('no lookups: the vetted address is dialled'), '', 0),
      });
      const totalTimer = setTimeout(() => { req.destroy(new OutboundTransportError(`no complete answer within ${totalMs} ms`)); }, totalMs);
      req.on('socket', (socket) => {
        connectTimer = setTimeout(() => { req.destroy(new OutboundTransportError(`no secure connection within ${connectMs} ms`)); }, connectMs);
        socket.once('secureConnect', () => { if (connectTimer !== undefined) clearTimeout(connectTimer); });
      });
      req.on('error', (e) => finish(e instanceof OutboundTransportError ? e : new OutboundTransportError(`not delivered: ${(e as NodeJS.ErrnoException).code ?? 'connection failed'}`)));
      req.on('response', (res) => {
        const status = res.statusCode ?? 0;
        // Never followed: a redirect is the partner's answer, recorded as it is.
        let read = 0;
        res.on('data', (chunk: Buffer) => {
          read += chunk.length;
          if (read > cap) { res.destroy(); req.destroy(); finish({ status }); }
        });
        res.on('end', () => finish({ status }));
        res.on('error', () => finish({ status }));
        res.on('close', () => finish({ status }));
      });
      req.end(body);
    }),
  };
}

/**
 * The production composition: the HTTPS transport only when the operator configures it (OUTBOUND_WEBHOOK_TRANSPORT=https),
 * with optional limits (OUTBOUND_WEBHOOK_CONNECT_TIMEOUT_MS, OUTBOUND_WEBHOOK_TOTAL_TIMEOUT_MS,
 * OUTBOUND_WEBHOOK_MAX_RESPONSE_BYTES). Anything else: no transport — outbound messages wait, listed.
 */
export function outboundTransportFromEnv(env: Readonly<Record<string, string | undefined>>, say?: (line: string) => void): OutboundTransport | undefined {
  if (env['OUTBOUND_WEBHOOK_TRANSPORT'] !== 'https') return undefined;
  const num = (k: string): number | undefined => { const n = Number(env[k]); return Number.isInteger(n) && n > 0 ? n : undefined; };
  const connectTimeoutMs = num('OUTBOUND_WEBHOOK_CONNECT_TIMEOUT_MS');
  const totalTimeoutMs = num('OUTBOUND_WEBHOOK_TOTAL_TIMEOUT_MS');
  const maxResponseBytes = num('OUTBOUND_WEBHOOK_MAX_RESPONSE_BYTES');
  return httpsOutboundTransport({
    ...(connectTimeoutMs === undefined ? {} : { connectTimeoutMs }),
    ...(totalTimeoutMs === undefined ? {} : { totalTimeoutMs }),
    ...(maxResponseBytes === undefined ? {} : { maxResponseBytes }),
    ...(say === undefined ? {} : { say }),
  });
}
