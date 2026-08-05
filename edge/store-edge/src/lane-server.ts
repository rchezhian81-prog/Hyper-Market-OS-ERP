// The socket between the till's screen and the till's disk — P-01, hard rule #1, ADR-0004.
//
// The POS is a web shell and a browser cannot call `fsync`. The disk belongs to the edge process,
// which is why `PosSession` takes the durable write as a port — and until this file, that port had
// nothing on the other side of it. The shell's default was a refusal, which was honest and meant a
// lane could not take money.
//
// ── Loopback, and only loopback ─────────────────────────────────────────────
//
// This binds to `127.0.0.1`. Not `0.0.0.0`, not the machine's LAN address. **The bind address is
// the entire security control**, and it is sufficient: the lane's browser and the lane's edge are
// the same machine (ADR-0004), so nothing outside that machine has any business writing a sale.
// Bound to the network instead, any device on the shop wifi — including a customer's phone — could
// post sales into the till's log.
//
// A shared secret would be theatre here. An attacker who can reach loopback is already running code
// on the till, and a token sitting in the same browser buys nothing against them.
//
// ── Why it is deliberately tiny ─────────────────────────────────────────────
//
// One route, one method. Everything this server can do is commit a sale that has already been
// priced and settled by the tested session model. It holds no pricing, no tender rules and no
// catalogue: adding any of them would put a second, untested copy of the shop's rules on the far
// side of a socket from the first.

import { createServer, type Server, type ServerResponse } from 'node:http';
import type { EdgeNode } from './index';

/** The one address this may listen on. Named so the test can assert on it. */
export const LANE_HOST = '127.0.0.1';

export interface LaneServer {
  readonly port: number;
  stop(): Promise<void>;
}

const send = (res: ServerResponse, status: number, body: unknown): void => {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(text)),
    // The shell is served from the same machine and origin; nothing else may call this.
    'access-control-allow-origin': 'null',
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

  const server: Server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/lane/sales') {
      send(res, 404, { error: 'the lane socket serves one route: POST /lane/sales' });
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let refused = false;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes && !refused) {
        refused = true;
        send(res, 413, { error: 'sale payload too large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (refused) return;
      void (async () => {
        // `id`, not `saleId`. The record is the sale exactly as `commitSale` shapes it, and its
        // identity field is `id` — the first version of this guessed `saleId` and refused every
        // real sale with "could not read the sale", which is a lane that cannot take money because
        // two files disagreed about a field name. Read the shape that exists, not the hoped-for one.
        let sale: { id?: string };
        try {
          sale = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id?: string };
        } catch {
          send(res, 400, {
            committed: false,
            refusedBecause: 'could_not_write_durably',
            laneMessage: 'This lane could not read the sale. Do not take payment — use another lane and tell the manager.',
          });
          return;
        }
        if (typeof sale.id !== 'string' || sale.id === '') {
          send(res, 400, {
            committed: false,
            refusedBecause: 'could_not_write_durably',
            laneMessage: 'This lane could not read the sale. Do not take payment — use another lane and tell the manager.',
          });
          return;
        }

        try {
          // The whole of this server. `commit` writes to the disk, waits for the fsync, and only
          // then queues for the cloud — the order is the rule and it lives in the edge, not here.
          const outcome = await input.node.commit(sale.id, JSON.stringify(sale));
          // 200 on a refusal too: the *request* was understood, and the answer is in the body. A
          // 5xx here would make a refused sale look like a broken lane, and the cashier needs to
          // know which it is — one means use another lane, the other means try again.
          send(res, 200, outcome);
        } catch (e) {
          send(res, 200, {
            committed: false,
            refusedBecause: 'could_not_write_durably',
            detail: e instanceof Error ? e.message : String(e),
            laneMessage: 'This lane could not save the sale. Do not take payment and do not hand over the goods — use another lane and tell the manager.',
          });
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
