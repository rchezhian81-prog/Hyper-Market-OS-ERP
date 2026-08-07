// The node:http adapter — the only place in the product that knows what a socket is.
//
// Everything above it works on plain request and response objects, which is why the whole API
// surface is testable without opening a port and why swapping the transport is a change to this
// file alone (P-06).
//
// Three deployment behaviours live here rather than in the handlers, because a handler cannot be
// trusted to remember them and there are thirteen services' worth of handlers:
//
//   • **A body that never ends does not hang the process.** An unbounded read is how one bad
//     client takes a service down without meaning to.
//   • **Shutdown drains.** On SIGTERM the listener stops accepting and in-flight requests finish.
//     Killing them means a sale that reached the process and did not reach the database, while the
//     till believes it was delivered.
//   • **Liveness and readiness are separate endpoints**, so an orchestrator can take a service out
//     of rotation without restart-looping it.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handle, type KernelOptions } from './pipeline';
import type { Method } from './router';
import { probes } from './config';

const MAX_BODY_BYTES = 1_048_576;

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // Bounded, because an unbounded read is how one bad client takes a service down.
    if (size > MAX_BODY_BYTES) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(text); } catch { return text; }
}

export interface ServerOptions extends KernelOptions {
  readonly port: number;
  /** Answers the readiness probe. Liveness never asks it — see `probes()`. */
  readonly dependenciesReachable: () => Promise<boolean> | boolean;
  /** A request-metrics snapshot served at `/metricz`, before authentication. Optional. */
  readonly metricsSnapshot?: () => unknown;
}

export interface RunningServer {
  readonly server: Server;
  /** Stops accepting, lets in-flight requests finish, then resolves. */
  readonly stop: () => Promise<void>;
}

export function startHttpServer(opts: ServerOptions): RunningServer {
  let started = false;
  let draining = false;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;

      // The two probes, before authentication: an orchestrator holds no token, and a service that
      // needs credentials to say whether it is alive cannot be managed.
      if (path === '/livez' || path === '/readyz') {
        const p = probes({
          started,
          configValid: true, // the process would not be running otherwise — see main.ts
          dependenciesReachable: path === '/livez' ? true : await opts.dependenciesReachable(),
        });
        const ok = path === '/livez' ? p.live : p.ready;
        res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ...p, probe: path.slice(1) }));
        return;
      }

      // Request metrics, before authentication like the probes: an operator's scraper holds no token,
      // and the numbers say nothing a token would protect (counts and latencies, never a body).
      if (path === '/metricz') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(opts.metricsSnapshot?.() ?? { totalRequests: 0, byStatusClass: {}, byRoute: {} }));
        return;
      }

      if (draining) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          error: {
            code: 'shutting_down',
            whatHappened: 'This instance is shutting down and is not taking new work.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send it again — another instance will take it, and nothing was changed here.',
          },
        }));
        return;
      }

      let body: unknown;
      try {
        body = await readBody(req);
      } catch {
        res.writeHead(413, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          error: {
            code: 'body_too_large',
            whatHappened: `A request body over ${MAX_BODY_BYTES} bytes was refused.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send it in smaller pieces. Nothing was changed.',
          },
        }));
        return;
      }

      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers[k.toLowerCase()] = v;
      }

      const query: Record<string, string> = {};
      url.searchParams.forEach((v, k) => { query[k] = v; });

      const reply = await handle(opts, {
        method: (req.method ?? 'GET') as Method,
        path, headers, query,
        ...(body === undefined ? {} : { body }),
      });

      res.writeHead(reply.status, reply.headers as Record<string, string>);
      res.end(JSON.stringify(reply.body));
    })();
  });

  server.listen(opts.port, () => { started = true; });

  return {
    server,
    stop: () => new Promise<void>((resolve) => {
      // Drain rather than kill. A request cut off mid-flight is a sale that reached the process
      // and not the database, while the till believes it was delivered.
      draining = true;
      server.close(() => { resolve(); });
    }),
  };
}
