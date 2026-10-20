import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { bootPos, laneDurable, laneDurableReturn, SALE_UNCONFIRMED_WORDS } from '../../apps/pos/src/browser-entry';
import { SaleUnconfirmedError, LocalCommitRefusedError } from '../../apps/pos/src/session';
import { RefundUncertainError, LocalRefundRefusedError } from '../../apps/pos/src/till-session';
import { money } from '../../packages/contracts/src/money';
import { prepareTillBox, holdSignedInAt, receiptNumberAt, operatorHeader } from '../support/till-operator';
import { useBackings } from '../support/backings';
import { TEST_IDP, TEST_PACK_KEY } from '../support/api-harness';
import type { HttpRequest } from '../../services/kernel/src/index';

/**
 * **A sale whose answer from the store computer was lost is asked about again under the SAME id until the store computer
 * answers — never called "not saved" while it might be saved, never rung twice (audit A8 · roadmap §4.2, §32 "zero
 * duplicate business effect" · P-08 · hard rule #1).**
 *
 * Before: the till posted a sale once (`safeRetry: false`, under a stale note that the box was "not yet idempotent"), and a
 * lost reply became "This lane is not ready to take payment. Do not take money". When the box had in fact saved it, that
 * was a phantom sale with a cash tender — the drawer short — and a SECOND sale when the customer was rung again. The box
 * has been idempotent on the sale id since 12 Sep 2026 (`sale-idempotency.test.ts`), so the till now does what it always
 * did for a refund: re-post the SAME record under the SAME id. If the box still does not answer, the sale is
 * UNCONFIRMED: the till holds it, refuses everything else, and keeps asking (`confirmPendingSale`) until the box says
 * "saved" or "not saved". One more case is closed: once a reply was lost, a later refusal (the cashier's session ended,
 * say) is checked against the box's own bill lookup before it is believed.
 *
 * Proven against a REAL store box (its disk, its idempotency guard, its bill lookup), across a cold restart of the box,
 * for refunds the same way, and through to head office on the in-memory store and on real PostgreSQL. Synthetic data.
 */

const KEY = TEST_PACK_KEY;
const PACK = {
  policies: { storeId: 'store-1', branchId: 'store-1', branchName: 'Main', tradingDayCutoff: '02:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, cashVarianceToleranceMinor: 10_000, privacySlaDays: 15, warehouseId: 'wh-1' },
  // The shop's refund approval threshold sits above these small refunds: the subject here is the lost answer.
  servicePolicy: { returnWindowDays: 30, approvalThresholdMinor: 1_000_000, noReceiptCapMinor: 0, agentAuthorityMinor: 0, compensationCapMinor: 0 },
  lossPreventionRules: [],
};
const AT = '2026-10-20T10:00:00.000Z';

const dirs: string[] = [];
const stops: (() => Promise<void>)[] = [];
let realFetch: typeof globalThis.fetch;
beforeEach(() => { realFetch = globalThis.fetch; });
afterEach(async () => {
  globalThis.fetch = realFetch;
  for (const s of stops.splice(0).reverse()) await s();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** A free loopback port, so a box restarted on the same folder answers on the same address the till knows. */
const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    server.close(() => resolve(port));
  });
});

const boxEnv = async (dir: string, port: number, extra: Record<string, string> = {}): Promise<Record<string, string>> => ({
  EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
  EDGE_LANE_PORT: String(port), EDGE_LANE_ID: 'lane-1',
  ...await prepareTillBox({ dir, key: KEY, people: [{ userId: 'u-meena', displayName: 'Meena' }], pack: PACK }),
  ...extra,
});
const startBox = async (env: Record<string, string>): Promise<EdgeProcess> => {
  const edge = (await startEdge(env, () => {}))!;
  stops.push(() => edge.stop());
  return edge;
};
const newBox = async (extra: Record<string, string> = {}) => {
  const dir = await mkdtemp(join(tmpdir(), 'sre-a8-')); dirs.push(dir);
  const port = await freePort();
  const env = await boxEnv(dir, port, extra);
  const edge = await startBox(env);
  return { dir, port, env, edge };
};

/** What the box has on its disk for sales and refunds. */
const salesOnDisk = async (edge: EdgeProcess) => (await readLog(edge.log.path)).length;
const refundsOnDisk = async (edge: EdgeProcess) => (await readLog(edge.returnsLog.path)).length;

/** The fetch the till uses, with a hand on it: drop the answer of the Nth sale/refund post, or refuse every post. */
const tap = (rules: { dropAnswerOf?: readonly number[]; neverDeliver?: readonly number[]; down?: () => boolean; between?: (n: number) => Promise<void> }) => {
  let n = 0;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const isWrite = /\/lane\/(sales|returns)$/.test(String(url));
    if (!isWrite) return realFetch(url, init);
    n += 1;
    await rules.between?.(n);
    if (rules.down?.() === true) throw new Error('ECONNREFUSED: the store computer is not answering');
    if (rules.neverDeliver?.includes(n) === true) throw new Error('the request was lost on the way');
    const response = await realFetch(url, init); // the box has processed it
    if (rules.dropAnswerOf?.includes(n) === true) throw new Error('connection reset after the write');
    return response;
  }) as unknown as typeof globalThis.fetch;
  return { posts: () => n };
};

const saleRecord = (id: string, number: string) => JSON.stringify({
  id, number, laneId: 'lane-1', cashierId: 'u-meena', tradingDay: '2026-10-20', committedAt: AT,
  lines: [{ productId: 'P1', quantityMinor: 1, uom: 'ea', unitPriceMinor: 48_000, lineTotalMinor: 48_000, taxRateBps: 0 }],
  tenders: [{ kind: 'cash', amount: { minor: 48_000, currency: 'INR' }, status: 'settled' }],
  total: 48_000, netMinor: 48_000, taxMinor: 0, currency: 'INR',
});
const signOut = (port: number, token: string) => realFetch(`http://127.0.0.1:${port}/lane/operator/sign-out`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...operatorHeader(token) }, body: '{}',
});

describe('A8 — the lane write re-sends a sale whose answer was lost, under the same id', () => {
  it('the box saved it and the answer was lost: the re-send is answered "saved", and the box holds ONE sale', async () => {
    const { port, edge } = await newBox();
    const token = await holdSignedInAt(port, 'u-meena');
    const number = await receiptNumberAt(port, token);
    const wire = tap({ dropAnswerOf: [1] });
    const outcome = await laneDurable(port)(`S-${number}`, saleRecord(`S-${number}`, number));
    expect(outcome.committed).toBe(true);
    expect(outcome.unconfirmed).toBeUndefined();
    expect(wire.posts()).toBe(2);              // asked again
    expect(await salesOnDisk(edge)).toBe(1);   // saved once
    expect(edge.outbox.unsentCount()).toBe(1); // queued for head office once
  });

  it('the box does not answer at all: UNCONFIRMED — never "do not take money", never "not saved"', async () => {
    tap({ down: () => true });
    const outcome = await laneDurable(9, { retryDelayMs: 1 })('S-9', saleRecord('S-9', 'R-9'));
    expect(outcome.committed).toBe(false);
    expect(outcome.unconfirmed).toBe(true);
    expect(outcome.laneMessage).toBe(SALE_UNCONFIRMED_WORDS);
    expect(outcome.laneMessage).not.toMatch(/do not take money|not ready to take payment|was not saved|nothing was saved/i);
  });

  it('answer lost, then the re-send is refused (the cashier signed out between): the box\'s bill lookup says it IS saved', async () => {
    const { port, edge } = await newBox();
    const token = await holdSignedInAt(port, 'u-meena');
    const number = await receiptNumberAt(port, token);
    tap({ dropAnswerOf: [1], between: async (n) => { if (n === 2) await signOut(port, token); } });
    const outcome = await laneDurable(port, { retryDelayMs: 1 })(`S-${number}`, saleRecord(`S-${number}`, number));
    expect(outcome.committed).toBe(true);      // the refusal of the re-send was not believed over the box's own disk
    expect(await salesOnDisk(edge)).toBe(1);
  });

  it('the first post never reached the box and the re-send is refused: the lookup says it is NOT there, so the refusal stands', async () => {
    const { port, edge } = await newBox();
    const token = await holdSignedInAt(port, 'u-meena');
    const number = await receiptNumberAt(port, token);
    tap({ neverDeliver: [1], between: async (n) => { if (n === 2) await signOut(port, token); } });
    const outcome = await laneDurable(port, { retryDelayMs: 1 })(`S-${number}`, saleRecord(`S-${number}`, number));
    expect(outcome.committed).toBe(false);
    expect(outcome.unconfirmed).toBeUndefined(); // a real answer: not saved
    expect(await salesOnDisk(edge)).toBe(0);
  });
});

describe('A8 — the till holds an unconfirmed sale, refuses everything else, and keeps asking until the box answers', () => {
  const till = (port: number) => {
    const view = bootPos({ laneId: 'lane-1', taxPercent: 0, lanePort: port, durable: laneDurable(port, { retryDelayMs: 1 }) });
    view.signIn('u-meena');
    view.scan({ productId: 'P1', description: 'Toor dal 1kg', unitPriceMinor: 48_000, qty: 1 });
    return view;
  };

  it('the box is down at the sale: unconfirmed; nothing else can be done; once it is back the SAME sale is saved, once', async () => {
    const { port, edge } = await newBox();
    await holdSignedInAt(port, 'u-meena');
    const view = till(port);
    const number = await view.nextReceipt();
    let down = true;
    tap({ down: () => down });

    const first = await view.tenderCash(`S-${number}`, number, AT).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(SaleUnconfirmedError);
    expect((first as SaleUnconfirmedError).laneMessage).not.toMatch(/do not take money/i);
    expect(view.state()).toBe('unconfirmed');
    expect(view.pendingSale()).toEqual({ saleId: `S-${number}`, number });
    // Nothing else may happen on the till while it does not know.
    expect(() => view.newSale()).toThrow(SaleUnconfirmedError);
    expect(() => view.scan({ productId: 'P2', description: 'Sugar 1kg', unitPriceMinor: 5_000, qty: 1 })).toThrow(SaleUnconfirmedError);
    await expect(view.tenderCash('S-other', 'R-other', AT)).rejects.toBeInstanceOf(SaleUnconfirmedError);
    // Still down: asking again is still unconfirmed.
    await expect(view.confirmPendingSale()).rejects.toBeInstanceOf(SaleUnconfirmedError);
    expect(await salesOnDisk(edge)).toBe(0);

    down = false;
    expect(await view.confirmPendingSale()).toBe(number);
    expect(view.state()).toBe('committed');
    expect(view.pendingSale()).toBeNull();
    expect(await salesOnDisk(edge)).toBe(1);
    view.newSale(); // the till moves on
    expect(view.state()).toBe('idle');
  });

  it('the box saved it, its answer was lost and the box went down — after a COLD RESTART the same sale is "saved", still one', async () => {
    const { port, env, edge } = await newBox();
    await holdSignedInAt(port, 'u-meena');
    const view = till(port);
    const number = await view.nextReceipt();
    let down = false;
    tap({ dropAnswerOf: [1], down: () => down, between: async (n) => { if (n === 2) { down = true; await edge.stop(); } } });

    await expect(view.tenderCash(`S-${number}`, number, AT)).rejects.toBeInstanceOf(SaleUnconfirmedError);
    // The box comes back on the same folder: its log, its idempotency guard and its sessions are rebuilt from the disk.
    const again = await startBox(env);
    down = false;
    expect(await view.confirmPendingSale()).toBe(number);
    expect(await salesOnDisk(again)).toBe(1);
    expect(again.outbox.unsentCount()).toBe(1);
  });

  it('the box answers "not saved": the till says so, and the basket is back as it was (nothing recorded, no second sale)', async () => {
    const { port, edge } = await newBox();
    const token = await holdSignedInAt(port, 'u-meena');
    const view = till(port);
    const number = await view.nextReceipt();
    let down = true;
    tap({ down: () => down });
    await expect(view.tenderCash(`S-${number}`, number, AT)).rejects.toBeInstanceOf(SaleUnconfirmedError);

    // The cashier's session ends while the box is away; when it answers, it refuses the re-send and its lookup has no sale.
    await signOut(port, token);
    down = false;
    const answer = await view.confirmPendingSale().catch((e: unknown) => e);
    expect(answer).toBeInstanceOf(LocalCommitRefusedError);
    expect(view.pendingSale()).toBeNull();
    expect(view.state()).not.toBe('unconfirmed');
    expect(view.basket()).toHaveLength(1); // the goods are still on the bill
    expect(await salesOnDisk(edge)).toBe(0);
  });
});

describe('A8 · RR-F02 — a refund whose answer was lost is held and asked about the same way', () => {
  const refundInput = (number: string) => ({
    id: `RT-${number}`, number, originalSaleId: 'S-1', processedAt: AT, reasonCode: 'damaged',
    lines: [{ productId: 'P1', uom: 'ea', quantityMinor: 1, originalQtyMinor: 1, disposition: 'resell' as const }],
    refund: money(5_000, 'INR'), refundTender: 'cash' as const,
    maxRefund: money(48_000, 'INR'), approvalThresholdMinor: 1_000_000,
  });

  it('box down: uncertain; no other refund is taken; once back, the SAME refund is saved once and shown as settled', async () => {
    const { port, edge } = await newBox();
    await holdSignedInAt(port, 'u-meena');
    const view = bootPos({ laneId: 'lane-1', taxPercent: 0, lanePort: port, durableReturn: laneDurableReturn(port, { retryDelayMs: 1 }) });
    view.signIn('u-meena');
    const number = await view.nextReceipt();
    let down = true;
    tap({ down: () => down });

    await expect(view.till.refund(refundInput(number))).rejects.toBeInstanceOf(RefundUncertainError);
    expect(view.pendingRefund()).toEqual({ returnId: `RT-${number}`, number });
    await expect(view.till.refund(refundInput('R-other'))).rejects.toBeInstanceOf(RefundUncertainError);
    expect((await view.confirmPendingRefund()).kind).toBe('uncertain');

    down = false;
    const outcome = await view.confirmPendingRefund();
    expect(outcome).toMatchObject({ kind: 'settled', number });
    expect(view.pendingRefund()).toBeNull();
    expect(await refundsOnDisk(edge)).toBe(1);
  });

  it('the box answers "not saved" for the refund (its bill lookup does not list it): a plain refusal, and the till moves on', async () => {
    const { port, edge } = await newBox();
    const token = await holdSignedInAt(port, 'u-meena');
    // The bill the refund is against, rung on this box — so the box's lookup can say what is and is not refunded on it.
    const saleNumber = await receiptNumberAt(port, token);
    expect((await laneDurable(port)(`S-${saleNumber}`, saleRecord(`S-${saleNumber}`, saleNumber))).committed).toBe(true);
    const view = bootPos({ laneId: 'lane-1', taxPercent: 0, lanePort: port, durableReturn: laneDurableReturn(port, { retryDelayMs: 1 }) });
    view.signIn('u-meena');
    const number = await view.nextReceipt();
    let down = true;
    tap({ down: () => down });
    await expect(view.till.refund({ ...refundInput(number), originalSaleId: `S-${saleNumber}` })).rejects.toBeInstanceOf(RefundUncertainError);

    // The session ends while the box is away; back, it refuses the re-send — and its lookup of the bill lists no such refund.
    await signOut(port, token);
    down = false;
    await expect(view.till.confirmPendingRefund()).rejects.toBeInstanceOf(LocalRefundRefusedError);
    expect(view.pendingRefund()).toBeNull();
    expect(await refundsOnDisk(edge)).toBe(0);
  });

  it('a refund with no bill (no receipt) whose re-send is refused cannot be looked up, so it stays UNCONFIRMED — never guessed', async () => {
    const { port } = await newBox();
    const token = await holdSignedInAt(port, 'u-meena');
    const number = await receiptNumberAt(port, token);
    tap({ dropAnswerOf: [1], between: async (n) => { if (n === 2) await signOut(port, token); } });
    const record = JSON.stringify({ returnId: `RT-${number}`, number, originalSaleId: null, noReceipt: true, processedBy: 'u-meena', reasonCode: 'damaged', refundMinor: 5_000, currency: 'INR', refundTender: 'cash', processedAt: AT, lines: [] });
    const outcome = await laneDurableReturn(port, { retryDelayMs: 1 })(`RT-${number}`, record);
    expect(outcome.committed).toBe(false);
    expect(outcome.unconfirmed).toBe(true);
  });
});

describe('A8 — through to head office: a sale whose answer was lost reaches it ONCE', () => {
  for (const backing of useBackings()) {
    it(`on ${backing.name}`, async () => {
      const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaa0a8';
      const h = backing.harness();
      await h.seedOwner(A, 'u-owner');
      await h.provisionRole(A, 'u-meena', 'cashier');
      await h.provisionRole(A, 'u-box', 'store_computer', ['store-1']);

      const dir = await mkdtemp(join(tmpdir(), 'sre-a8-cloud-')); dirs.push(dir);
      const port = await freePort();
      const env = await boxEnv(dir, port, {
        EDGE_TENANT_ID: A, EDGE_PACK_FILE: join(dir, 'store-pack.json'),
        CLOUD_API_URL: 'https://cloud.example.test', CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-box', tenantId: A, branchId: 'store-1' }),
      });
      let n = 0;
      globalThis.fetch = (async (url: string, init: RequestInit): Promise<Response> => {
        if (String(url).startsWith('http://127.0.0.1:')) {
          const isSale = String(url).endsWith('/lane/sales');
          if (isSale) n += 1;
          const response = await realFetch(url, init);
          if (isSale && n === 1) throw new Error('connection reset after the write'); // the box saved it; its answer is lost
          return response;
        }
        const hdr = (init.headers ?? {}) as Record<string, string>;
        const res = await h.raw({
          method: (init.method ?? 'GET') as HttpRequest['method'], path: new URL(url).pathname,
          token: hdr['authorization']?.replace(/^Bearer /, ''), idempotencyKey: hdr['idempotency-key'],
          body: init.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown,
        });
        return new Response(JSON.stringify(res.body), { status: res.status });
      }) as unknown as typeof globalThis.fetch;
      const edge = await startBox(env);
      await holdSignedInAt(port, 'u-meena');
      const view = bootPos({ laneId: 'lane-1', taxPercent: 0, lanePort: port, durable: laneDurable(port, { retryDelayMs: 1 }) });
      view.signIn('u-meena');
      view.scan({ productId: 'P1', description: 'Toor dal 1kg', unitPriceMinor: 48_000, qty: 1 });
      const number = await view.nextReceipt();
      expect(await view.tenderCash(`S-${number}`, number, AT)).toBe(number); // asked again, answered "saved"
      expect(n).toBe(2);

      const pass = await edge.syncOnce!();
      expect(pass).toMatchObject({ sent: 1, dead: 0, remaining: 0 });
      expect((await edge.syncOnce!()).sent).toBe(0); // nothing more to send
      const banked = await h.request({ method: 'GET', path: `/v1/sales/S-${number}`, userId: 'u-owner', tenantId: A });
      expect(banked.status).toBe(200);
      expect(banked.body).toMatchObject({ saleId: `S-${number}` });
    }, 30_000);
  }
});
