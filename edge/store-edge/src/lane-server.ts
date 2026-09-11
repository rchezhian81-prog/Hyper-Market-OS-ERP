// The socket between the till's screen and the till's disk — P-01, hard rule #1, ADR-0004.
//
// The POS is a web shell and a browser cannot call `fsync`. The disk belongs to the edge process,
// which is why `PosSession` takes the durable write as a port — and until this file, that port had
// nothing on the other side of it. The shell's default was a refusal, which was honest and meant a
// lane could not take money.
//
// ── Loopback first, then server-side authorization ──────────────────────────
//
// This binds to `127.0.0.1`. Not `0.0.0.0`, not the machine's LAN address: the lane's browser and
// the lane's edge are the same machine (ADR-0004), so nothing off that machine can reach the socket,
// and no device on the shop wifi — a customer's phone included — can post into the till's log.
//
// The bind is necessary but **not sufficient**, and an earlier version of this file wrongly treated
// it (with CORS response headers) as the whole control. A page open in the till's own browser is ON
// this machine: it can issue a cross-origin request to loopback, and a CORS *simple* request — one
// carrying `text/plain` — is delivered with no preflight. The server then wrote the record and only
// the missing CORS header stopped the attacker reading the reply, which is too late: the durable
// mutation already happened (review finding RR-F01). CORS is a control on reading a reply in a
// browser; it is not authorization to mutate.
//
// So authorization is now decided **server-side, before the body is read or anything is written**
// (`laneCallRefusal`): a foreign `Origin` is refused (403), and the content type must be
// `application/json` (415 otherwise) — the one type a cross-origin caller cannot send without a
// preflight this socket refuses for non-loopback origins. A request with no `Origin` (a same-origin
// call, or a non-browser client already on this machine) is allowed with the right content type: an
// attacker who can forge headers from a shell on the till is already inside the trust boundary the
// loopback bind draws, and a shared secret in the same browser would buy nothing against them.
//
// ── The screen and the socket are the same machine but not the same port ────
//
// The till's screen is served on one loopback port (the screens server) and this write socket is on
// another. A browser treats two ports as two ORIGINS, so the screen's `fetch` to this socket is a
// cross-origin request, and a cross-origin POST carrying JSON is one the browser refuses to send at
// all unless this socket answers the preflight `OPTIONS` first and names the caller's origin back.
// The first version answered neither — it hard-coded `access-control-allow-origin: null` and ignored
// `OPTIONS` — so a real browser till could never post a sale, only the in-process tests could. That
// is the same class of "every piece works apart, the join was never exercised in a browser" gap the
// sale-to-books seam was.
//
// So this permits a cross-origin call **from a loopback origin only** — `127.0.0.1`, `localhost` or
// `[::1]`, on any port. That is not a widening of the security control: the bind address already
// means nothing off this machine can reach the socket at all, and every loopback origin is by
// definition another page on this same till. A request from any other origin gets no allow header,
// so the browser blocks it — belt to the bind's braces.
//
// ── Why it is otherwise deliberately tiny ───────────────────────────────────
//
// Two write routes, one method. Everything this server can do is commit a sale — or a refund — that
// has already been priced and settled by the tested session model. It holds no pricing, no tender
// rules and no catalogue: adding any of them would put a second, untested copy of the shop's rules on
// the far side of a socket from the first. `/lane/returns` is the exact mirror of `/lane/sales`: the
// refund is durable on the disk before the lane calls it done, then queued for the cloud (M13-FR-01).

import { createServer, type Server, type ServerResponse } from 'node:http';
import { returnIdOf } from './cloud-return';
import type { EdgeNode } from './index';

/** The one address this may listen on. Named so the test can assert on it. */
export const LANE_HOST = '127.0.0.1';

/** The write routes this socket serves — a sale, and a refund. Both loopback-only, both POST. */
const LANE_ROUTES = ['/lane/sales', '/lane/returns'] as const;

/**
 * Is this `Origin` header another page on this same machine? `127.0.0.1`, `localhost` and IPv6
 * `[::1]` on any port; nothing else. Undefined (a same-origin or non-browser call that sends no
 * Origin) is not cross-origin, so it needs no allowance and is not one of these.
 *
 * Pure and exported so the decision is unit-tested directly rather than only through a socket.
 */
export function isLoopbackOrigin(origin: string | undefined): boolean {
  if (typeof origin !== 'string' || origin === '') return false;
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return false;
  }
  // A URL parses `[::1]` back to `::1`; accept both the bracketed and bare forms.
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

/**
 * Is this the lane protocol's content type? `application/json` only (a charset parameter is fine).
 *
 * This is a **server-side authorization control, not tidiness** (RR-F01). A cross-origin `fetch`
 * carrying `application/json` is never a CORS "simple request", so the browser must ask this socket's
 * permission with a preflight `OPTIONS` first — which is refused for any non-loopback origin. The
 * bypass the review found used `text/plain`, which *is* a simple request and is sent with no
 * preflight at all: the browser delivers it, the server writes the record, and only then does the
 * missing CORS header stop the attacker reading the reply — too late, the durable mutation happened.
 * Requiring `application/json` closes that door: the only content type the real till ever sends, and
 * the one that cannot cross an origin without this socket's say-so.
 */
export function isJsonContentType(contentType: string | undefined): boolean {
  if (typeof contentType !== 'string') return false;
  const base = contentType.split(';', 1)[0]!.trim().toLowerCase();
  return base === 'application/json';
}

/**
 * May this request mutate the lane's log at all? Decided BEFORE the body is read or anything is
 * written (RR-F01). Loopback binding and CORS response headers do not establish caller
 * authorization — a request that carries a foreign `Origin`, or a content type the lane protocol
 * does not speak, is refused here rather than parsed and committed. A request with no `Origin` (a
 * same-origin call, or a non-browser client already on this machine, which the loopback bind treats
 * as in the trust boundary — see the note at the top) is allowed if its content type is right.
 */
export function laneCallRefusal(
  origin: string | undefined,
  contentType: string | undefined,
): { readonly status: number; readonly reason: string } | undefined {
  if (typeof origin === 'string' && origin !== '' && !isLoopbackOrigin(origin)) {
    return { status: 403, reason: 'this request did not come from this till and was refused before anything was written' };
  }
  if (!isJsonContentType(contentType)) {
    return { status: 415, reason: 'the lane accepts application/json only; this request was refused before anything was written' };
  }
  return undefined;
}

/** The CORS headers to answer a loopback caller with — or nothing at all for any other origin. */
function corsHeadersFor(origin: string | undefined): Record<string, string> {
  if (!isLoopbackOrigin(origin)) return {};
  return {
    'access-control-allow-origin': origin!,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type, idempotency-key',
    'access-control-max-age': '600',
    // The allowed origin depends on the request, so caches must key on it.
    vary: 'Origin',
  };
}

export interface LaneServer {
  readonly port: number;
  stop(): Promise<void>;
}

const send = (res: ServerResponse, status: number, body: unknown, cors: Record<string, string> = {}): void => {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(text)),
    // Present only for a loopback caller (another page on this same till); absent for any other
    // origin, so the browser blocks it. See the note at the top of this file.
    ...cors,
  });
  res.end(text);
};

export function startLaneServer(input: {
  readonly node: EdgeNode;
  readonly port: number;
  /** Largest sale payload accepted. A body cap is a denial-of-service control, not tidiness. */
  readonly maxBytes?: number;
}): Promise<LaneServer> {
  const maxBytes = input.maxBytes ?? 256 * 1024;

  // A refused-durable-write answer, in the words the cashier needs with a customer watching. `noun`
  // is 'sale' or 'refund' so the same shape serves both routes without either lying about the other.
  const refusal = (noun: string, detail?: string): Record<string, unknown> => ({
    committed: false,
    refusedBecause: 'could_not_write_durably',
    ...(detail === undefined ? {} : { detail }),
    laneMessage: `This lane could not save the ${noun}. Do not take payment or hand over ${noun === 'sale' ? 'the goods' : 'cash'} — use another lane and tell the manager.`,
  });

  const server: Server = createServer((req, res) => {
    const cors = corsHeadersFor(req.headers.origin);
    const route = LANE_ROUTES.find((r) => r === req.url);

    // The browser's preflight for the cross-origin POST from the till's screen. Answered only for a
    // loopback origin; anything else gets no allow header and the browser refuses to send the POST.
    if (req.method === 'OPTIONS' && route !== undefined) {
      res.writeHead(isLoopbackOrigin(req.headers.origin) ? 204 : 403, { 'content-length': '0', ...cors });
      res.end();
      return;
    }

    if (req.method !== 'POST' || route === undefined) {
      send(res, 404, { error: `the lane socket serves: ${LANE_ROUTES.map((r) => `POST ${r}`).join(', ')}` }, cors);
      return;
    }
    const isReturn = route === '/lane/returns';
    const noun = isReturn ? 'refund' : 'sale';

    // Server-side authorization, BEFORE the body is read or anything is written (RR-F01). A foreign
    // Origin or a non-JSON content type is refused here — CORS headers and the loopback bind are not
    // caller authorization. This is what stops a `text/plain` cross-origin write from mutating the
    // log and only being "blocked" after the durable record already exists.
    const authRefusal = laneCallRefusal(req.headers.origin, req.headers['content-type']);
    if (authRefusal !== undefined) {
      send(res, authRefusal.status, { committed: false, refusedBecause: 'unauthorized_request', detail: authRefusal.reason }, cors);
      req.resume(); // drain and discard the body; nothing here reads or persists it
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let refused = false;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes && !refused) {
        refused = true;
        send(res, 413, { error: `${noun} payload too large` }, cors);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (refused) return;
      void (async () => {
        // Read the record's OWN identity field: a sale's is `id` (as `commitSale` shapes it); a
        // refund's is `returnId` (the shape `packages/returns` mints), tolerating a bare `id`. Read
        // the shape that exists, not a hoped-for one — that mismatch is a lane that cannot take money.
        let parsed: unknown;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
        } catch {
          send(res, 400, refusal(noun), cors);
          return;
        }
        const id = isReturn
          ? returnIdOf(parsed)
          : ((parsed as { id?: string } | null)?.id);
        if (typeof id !== 'string' || id === '') {
          send(res, 400, refusal(noun), cors);
          return;
        }

        try {
          // The whole of this server. `commit`/`commitReturn` writes to the disk, waits for the
          // fsync, and only then queues for the cloud — the order is the rule and it lives in the
          // edge, not here.
          const outcome = isReturn
            ? await input.node.commitReturn(id, JSON.stringify(parsed))
            : await input.node.commit(id, JSON.stringify(parsed));
          // 200 on a refusal too: the *request* was understood, and the answer is in the body. A
          // 5xx here would make a refused sale look like a broken lane, and the cashier needs to
          // know which it is — one means use another lane, the other means try again.
          send(res, 200, outcome, cors);
        } catch (e) {
          send(res, 200, refusal(noun, e instanceof Error ? e.message : String(e)), cors);
        }
      })();
    });
  });

  return new Promise((resolve) => {
    // The bind address IS the control. See the note at the top of this file.
    server.listen(input.port, LANE_HOST, () => {
      const address = server.address();
      resolve({
        port: typeof address === 'object' && address !== null ? address.port : input.port,
        stop: () => new Promise<void>((done) => { server.close(() => { done(); }); }),
      });
    });
  });
}
