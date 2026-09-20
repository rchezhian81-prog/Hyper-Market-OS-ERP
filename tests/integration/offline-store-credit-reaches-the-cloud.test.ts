import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiHarness, TEST_IDP, type ApiHarness } from '../support/api-harness';
import type { HttpRequest } from '../../services/kernel/src/index';
import { startEdge } from '../../edge/store-edge/src/main';

/**
 * **A store-credit refund taken at the lane with the cable out becomes real, spendable credit at the
 * cloud when it reconciles — M13-FR-03, §31, hard rules #1 #10, P-08.**
 *
 * This is the offline mirror of the SC-3 cloud desk path. A refund settled offline as store credit has
 * ALREADY handed the customer their credit at the lane — the money moved. So when it syncs, the cloud's
 * record-and-flag synced-return route ISSUES the credit (never rejects it — the desk-route refusals are
 * for a decision still being made; here it is already made). It issues to the customer captured at the
 * lane, and surfaces a visible governance exception (never a silent drop) when the lane ignored the
 * owner's cap, or when no customer was captured to issue the credit to.
 *
 * Everything below the socket is production: the real `startEdge` opens real durable logs, the real sync
 * agent + transport drain to a `fetch` that drives the real cloud API (router, token auth, RBAC, the
 * append-only register and the stored-value read side). Only the socket is replaced. The `customerRef`
 * is carried the whole way — `toReturnRecord` → `toCloudReturn` → the transport body → the synced route.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AT = '2026-08-07T10:00:00.000Z';
const KEY = ['edge', 'storecredit', 'seam', 'pack', 'signing', 'key'].join('-').padEnd(48, '0');

/** A bill banked in the cloud so a return has something to reconcile against — 3 units at ₹50. */
const sale = (saleId: string) => ({
  saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', cashierId: 'u-cash',
  tradingDay: '2026-08-07', committedAt: AT, totalMinor: 15000, currency: 'INR', packVersion: 0,
  lines: [{ productId: 'P1', quantityMinor: 3, uom: 'each', unitPriceMinor: 5000, lineTotalMinor: 15000 }],
  tenders: [{ kind: 'cash', amountMinor: 15000 }],
});
const bank = (h: ApiHarness, saleId: string) =>
  h.request({ method: 'POST', path: '/v1/sales', userId: 'u-owner', tenantId: A, idempotencyKey: `bank-${saleId}`, body: sale(saleId) });

/** A store-credit refund as the lane commits it offline — the exact disk shape `toCloudReturn` reads,
 * carrying the customer the credit belongs to (or, for the no-customer case, omitting it). */
const scRecord = (returnId: string, originalSaleId: string, customerRef?: string) => JSON.stringify({
  returnId, number: returnId, originalSaleId, noReceipt: false, laneId: 'lane-1',
  processedBy: 'u-lanecash', approvedBy: 'u-mgr', reasonCode: 'customer_changed_mind',
  refundMinor: 5000, currency: 'INR', refundTender: 'store_credit', refundStatus: 'settled', processedAt: AT,
  ...(customerRef === undefined ? {} : { customerRef }),
  lines: [{ productId: 'P1', uom: 'each', quantityMinor: 1, disposition: 'resell' }],
});

const setCap = (h: ApiHarness, capMinor: number, key: string) =>
  h.request({ method: 'POST', path: '/v1/pos/store-credit-cap', userId: 'u-owner', tenantId: A, idempotencyKey: key, body: { capMinor } });
const instrument = (h: ApiHarness, id: string) =>
  h.request({ method: 'GET', path: `/v1/stored-value/instruments/${id}`, userId: 'u-owner', tenantId: A });
const exceptionsFor = async (h: ApiHarness, returnId: string): Promise<string[]> => {
  const body = (await h.request({ method: 'GET', path: '/v1/pos/return-governance-exceptions', userId: 'u-owner', tenantId: A })).body as
    { exceptions: { returnId: string; governanceFlags: string[] }[] };
  return body.exceptions.find((e) => e.returnId === returnId)?.governanceFlags ?? [];
};

describe('offline store credit reaches the cloud through the real edge (M13-FR-03, §31)', () => {
  let h: ApiHarness;
  let dir: string;
  const savedFetch = globalThis.fetch;

  beforeAll(async () => {
    h = apiHarness();
    await h.seedOwner(A, 'u-owner');                     // pos.return.sync + approve + cap-set + stored-value read
    await h.provisionRole(A, 'u-mgr', 'store_manager');  // a genuine refund approver
    for (const s of ['S1', 'S2', 'S3']) await bank(h, s);

    globalThis.fetch = (async (url: string, init: RequestInit): Promise<Response> => {
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

    dir = await mkdtemp(join(tmpdir(), 'sre-edge-sc-'));
  });

  afterAll(async () => {
    globalThis.fetch = savedFetch;
    await rm(dir, { recursive: true, force: true });
  });

  const env = () => ({
    EDGE_DATA_DIR: dir, EDGE_TENANT_ID: A, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
    CLOUD_API_URL: 'https://cloud.example.test',
    // The store's sync token — a cashier who holds pos.return.sync. The cloud authenticates it and
    // issues/records the credit under that identity; the credit's authority was decided at the lane.
    CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-owner', tenantId: A }),
  });

  it('issues real spendable credit to the captured customer when the offline refund reconciles', async () => {
    expect((await setCap(h, 100000, 'cap-hi')).status).toBe(200); // ₹1000 cap — well above the ₹50 refund
    const edge = (await startEdge(env(), () => {}))!;
    await edge.node.commitReturn('RT-SC1', scRecord('RT-SC1', 'S1', 'c-asha'));
    await edge.stop(); // drains before it goes

    const inst = await instrument(h, 'store-credit:RT-SC1');
    expect(inst.status).toBe(200);
    expect(inst.body).toMatchObject({ kind: 'store_credit', ownerRef: 'c-asha', balanceMinor: 5000 });
    // A clean issuance carries no store-credit governance flag.
    expect(await exceptionsFor(h, 'RT-SC1')).not.toContain('store_credit_over_cap');
  });

  it('STILL issues the credit but flags it when the lane exceeded the owner cap (record-and-flag, never rejected)', async () => {
    expect((await setCap(h, 4000, 'cap-lo')).status).toBe(200); // ₹40 cap, refund is ₹50
    const edge = (await startEdge(env(), () => {}))!;
    await edge.node.commitReturn('RT-SC2', scRecord('RT-SC2', 'S2', 'c-asha'));
    await edge.stop();

    // The credit was handed over at the lane, so it is recorded — the money already moved.
    const inst = await instrument(h, 'store-credit:RT-SC2');
    expect(inst.status).toBe(200);
    expect((inst.body as { balanceMinor: number }).balanceMinor).toBe(5000);
    // …and the breach is a visible exception for a person, never silent (hard rule #10, P-08).
    expect(await exceptionsFor(h, 'RT-SC2')).toContain('store_credit_over_cap');
  });

  it('issues NOTHING but flags it when a store-credit refund arrives with no customer to credit', async () => {
    expect((await setCap(h, 100000, 'cap-hi2')).status).toBe(200);
    const edge = (await startEdge(env(), () => {}))!;
    await edge.node.commitReturn('RT-SC3', scRecord('RT-SC3', 'S3', undefined)); // no customerRef
    await edge.stop();

    // Credit cannot be issued to nobody — no instrument exists…
    expect((await instrument(h, 'store-credit:RT-SC3')).status).toBe(404);
    // …and a person must resolve who it belongs to (visible exception, not a silent drop).
    expect(await exceptionsFor(h, 'RT-SC3')).toContain('store_credit_no_customer');
  });
});
