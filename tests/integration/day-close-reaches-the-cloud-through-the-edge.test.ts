import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiHarness, TEST_IDP, type ApiHarness } from '../support/api-harness';
import type { HttpRequest } from '../../services/kernel/src/index';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';

/**
 * **The store day close reaches head office, through the real edge — M14-FR-04, §31, P-01 (Slice 3a).**
 *
 * This is the join slices 1 & 2 could not make on their own: the cloud route (slice 1) and the
 * transport route (slice 2) existed and were tested, but nothing in the running box PRODUCED a day
 * close. Now `startEdge` gives the box a fourth durable pipeline and an AUTHORITATIVE `edge.closeDay`,
 * which reads the box's LIVE state — the depth of ALL its outboxes and the exception register the
 * manager screen shows — and hands the tested engine the real numbers. The decision lives here because
 * the "no unsent items" gate can only be evaluated where the outbox is.
 *
 * Everything below the socket is production: the real `startEdge` opens real durable logs, the real
 * `SyncAgent` + `httpTransport` drain to a `fetch` that drives the real cloud API (router, token auth,
 * RBAC, the append-only day-close stream). Only the socket is replaced. The last thing it proves is the
 * safety property: a locked day the box could not send yet is re-queued after a restart, never lost.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AT = '2026-08-07T10:00:00.000Z';
const KEY = ['edge', 'day', 'close', 'seam', 'pack', 'signing', 'key'].join('-').padEnd(48, '0');

/** A store pack the box loads from disk: a CHECKED (empty) exception register + a 02:00 cut-off. Its
 *  presence is what lets the day close — an absent loss-prevention register is a hard block by design. */
const PACK_JSON = JSON.stringify({ version: 1, policies: { tradingDayCutoff: '02:00' }, lossPreventionRules: [] });

/** An edge-committed sale, in the disk shape the lane writes and `toCloudSale` reads. */
const saleRecord = (saleId: string) => JSON.stringify({
  id: saleId, number: `R-${saleId}`, laneId: 'lane-1', cashierId: 'u-lanecash',
  tradingDay: '2026-08-07', committedAt: AT, total: 15000, currency: 'INR',
  lines: [{ productId: 'P1', quantityMinor: 3, uom: 'each', unitPriceMinor: 5000, lineTotalMinor: 15000 }],
  tenders: [{ kind: 'cash', amount: { minor: 15000, currency: 'INR' } }],
});

interface Row { dayCloseId: string; locked: boolean; reopened: boolean; closedBy: string }
interface ListBody { dayCloses: Row[]; lockedCount: number }
const dayCloses = async (h: ApiHarness): Promise<ListBody> =>
  (await h.request({ method: 'GET', path: '/v1/pos/day-close', userId: 'u-owner', tenantId: A })).body as ListBody;

/** A fresh cloud + a temp data dir + the global `fetch` pointed at the cloud. `withPack` writes the
 *  store pack so the exception register is checked; omit it to prove the box refuses on an absent one. */
const cleanups: Array<() => Promise<void>> = [];
const savedFetch = globalThis.fetch;
afterEach(async () => {
  globalThis.fetch = savedFetch;
  for (const c of cleanups.splice(0)) await c();
});

async function scene(opts: { readonly withPack: boolean }): Promise<{
  h: ApiHarness;
  boot: () => Promise<EdgeProcess>;
  setOnline: (v: boolean) => void;
}> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');                     // till.dayclose.sync + .read + .approve
  await h.provisionRole(A, 'u-mgr', 'store_manager');  // till.dayclose.sync + .read — the sync identity
  const dir = await mkdtemp(join(tmpdir(), 'sre-edge-day-close-'));
  cleanups.push(async () => { await rm(dir, { recursive: true, force: true }); });
  let packFile: string | undefined;
  if (opts.withPack) {
    packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, PACK_JSON, 'utf8');
  }

  let online = true;
  globalThis.fetch = (async (url: string, init: RequestInit): Promise<Response> => {
    if (!online) throw new Error('ENETUNREACH');
    const hdr = (init.headers ?? {}) as Record<string, string>;
    const res = await h.raw({
      method: (init.method ?? 'GET') as HttpRequest['method'],
      path: new URL(url).pathname,
      token: hdr['authorization']?.replace(/^Bearer /, ''),
      idempotencyKey: hdr['idempotency-key'],
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown,
    });
    return new Response(JSON.stringify(res.body), { status: res.status });
  }) as unknown as typeof globalThis.fetch;

  const env = () => ({
    EDGE_DATA_DIR: dir, EDGE_TENANT_ID: A, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
    CLOUD_API_URL: 'https://cloud.example.test',
    // The store's sync token — a store manager who holds till.dayclose.sync. The cloud authenticates it.
    CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-mgr', tenantId: A }),
    ...(packFile === undefined ? {} : { EDGE_PACK_FILE: packFile }),
  });

  return {
    h,
    boot: async () => {
      const edge = (await startEdge(env(), () => {}))!;
      cleanups.push(async () => { await edge.stop(); });
      return edge;
    },
    setOnline: (v: boolean) => { online = v; },
  };
}

describe('the store day close reaches head office through the real edge (M14-FR-04, §31, P-01)', () => {
  it('locks the day on the box and it reaches the cloud, recorded locked', async () => {
    const s = await scene({ withPack: true });
    const edge = await s.boot();

    const outcome = await edge.closeDay({ dayCloseId: 'dc-1', closedBy: 'u-mgr' });
    expect(outcome.closed).toBe(true);
    expect(edge.dayCloseAgent?.health().unsentCount).toBe(1); // queued, not yet drained

    await edge.syncOnce!();
    expect(edge.dayCloseAgent?.health().unsentCount).toBe(0); // acknowledged by the cloud

    const body = await dayCloses(s.h);
    expect(body.lockedCount).toBe(1);
    expect(body.dayCloses[0]).toMatchObject({ dayCloseId: 'dc-1', locked: true, reopened: false, closedBy: 'u-mgr' });
  });

  it('REFUSES to close when the exception register was never checked (no loss-prevention rules) — nothing reaches the cloud', async () => {
    const s = await scene({ withPack: false }); // emptyPack → lossPreventionRules not known
    const edge = await s.boot();

    const outcome = await edge.closeDay({ dayCloseId: 'dc-x', closedBy: 'u-mgr' });
    expect(outcome.closed).toBe(false);
    if (outcome.closed) return;
    expect(outcome.reason).toMatch(/loss-prevention rules/);

    await edge.syncOnce!();
    expect((await dayCloses(s.h)).dayCloses).toHaveLength(0); // never recorded — the day did not close
  });

  it('REFUSES to close while a sale is still unsent — a gate only the box can evaluate', async () => {
    const s = await scene({ withPack: true });
    const edge = await s.boot();

    // A sale committed but not drained sits in the sales outbox — the box knows it, the cloud cannot.
    await edge.node.commit('S9', saleRecord('S9'));
    expect(edge.outbox.pending().length).toBe(1);

    const outcome = await edge.closeDay({ dayCloseId: 'dc-2', closedBy: 'u-mgr' });
    expect(outcome.closed).toBe(false);
    if (outcome.closed) return;
    expect(outcome.reason).toMatch(/unsent|not yet reconciled/i);
  });

  it('waits out an outage and, after a restart, still sends the locked day (§31, hard rule #6)', async () => {
    const s = await scene({ withPack: true });
    const edge = await s.boot();

    s.setOnline(false);
    const outcome = await edge.closeDay({ dayCloseId: 'dc-3', closedBy: 'u-mgr' });
    expect(outcome.closed).toBe(true); // the day LOCKS locally with the cable out (P-01)
    await edge.syncOnce!(); // cannot reach the cloud — stays queued, durable on the disk
    expect(edge.dayCloseAgent?.health().unsentCount).toBe(1);
    expect((await dayCloses(s.h)).dayCloses).toHaveLength(0);
    await edge.stop(); // process goes; the locked day is on the disk

    // A fresh box on the SAME data dir re-queues the locked day from its log, and sends it when the line returns.
    s.setOnline(true);
    const restarted = await s.boot();
    await restarted.syncOnce!();
    expect(restarted.dayCloseAgent?.health().unsentCount).toBe(0);
    const body = await dayCloses(s.h);
    expect(body.lockedCount).toBe(1);
    expect(body.dayCloses[0]).toMatchObject({ dayCloseId: 'dc-3', locked: true });
  });
});
