import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiHarness, TEST_IDP, TEST_PACK_KEY, type ApiHarness } from '../support/api-harness';
import type { HttpRequest } from '../../services/kernel/src/index';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { bootPos } from '../../apps/pos/src/browser-entry';
import { prepareTillBox, signInTill, managerApprovesOn } from '../support/till-operator';
import { loyaltyMemberKey, memberRefFor } from '../../packages/loyalty/src/index';

/**
 * **The till spends a member's points and store credit — offline-safe, durable on the box, synced, never twice (PF-09 step 3
 * · M17-FR-01/03/04 · M12-FR-03 split tender · §31 · hard rules #1 #10 · OB-28 "C and 1").**
 *
 * The real box (`startEdge`) pulls head office's wallet feed through the real API (router, RBAC, the append-only store);
 * the till's own session model splits a bill across points, store credit and a card attempt recorded on the box; the box
 * decides the spend against its copy, before the disk, within the owner's daily till limit. With the cable out the box
 * still decides from its copy and its own record of spends — across a restart — and when the line returns head office
 * applies each spend once. A bill partly paid with points cannot be refunded as money for the points part.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0f09';
const MOBILE = '98400 77777';
const MEMBER = memberRefFor(loyaltyMemberKey(TEST_PACK_KEY), MOBILE)!;

describe('the till spends points and store credit, decided on the box, applied once at head office', () => {
  let h: ApiHarness;
  let dir: string;
  let online = true;
  const savedFetch = globalThis.fetch;

  beforeAll(async () => {
    h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-meena', 'cashier');
    await h.provisionRole(A, 'u-box', 'cashier');
    await h.provisionRole(A, 'u-mgr', 'store_manager');
    const set = async (key: string, value: number) =>
      expect((await h.request({ method: 'PUT', path: `/v1/platform/setup/${key}`, userId: 'u-owner', tenantId: A, idempotencyKey: `set-${key}`, body: { value } })).status).toBeLessThan(300);
    await set('loyalty.points_per_100_inr', 1);
    await set('loyalty.point_value_paise', 100);       // one point = ₹1
    await set('loyalty.till_spend_cap_paise', 50_000); // ₹500 a day at the till
    expect((await h.request({ method: 'POST', path: '/v1/loyalty/members', userId: 'u-mgr', tenantId: A, idempotencyKey: 'join', body: { mobile: MOBILE, consent: true, verifiedHow: 'seen_on_phone' } })).status).toBe(201);
    // The member already holds 50 points (an earlier ₹5,000 bill) and ₹300 of store credit.
    expect((await h.request({ method: 'POST', path: '/v1/sales', userId: 'u-box', tenantId: A, idempotencyKey: 'earlier', body: {
      saleId: 'S-earlier', receiptNumber: 'R-earlier', laneId: 'lane-9', cashierId: 'u-meena', tradingDay: '2026-10-01', committedAt: new Date().toISOString(),
      totalMinor: 500_000, currency: 'INR', packVersion: 1, customerRef: MEMBER,
      lines: [{ productId: 'P1', quantityMinor: 1, uom: 'ea', unitPriceMinor: 500_000, lineTotalMinor: 500_000 }], tenders: [{ kind: 'cash', amountMinor: 500_000 }],
    } })).status).toBe(202);
    expect((await h.request({ method: 'POST', path: '/v1/stored-value/instruments', userId: 'u-box', tenantId: A, idempotencyKey: 'sc', body: { instrumentId: 'sc-1', kind: 'store_credit', ownerRef: MEMBER, faceValueMinor: 30_000 } })).status).toBe(201);

    globalThis.fetch = (async (url: string, init: RequestInit): Promise<Response> => {
      if (String(url).startsWith('http://127.0.0.1:')) return savedFetch(url, init);
      if (!online) throw new Error('ENETUNREACH');
      const hdr = (init.headers ?? {}) as Record<string, string>;
      const res = await h.raw({
        method: (init.method ?? 'GET') as HttpRequest['method'], path: new URL(url).pathname,
        token: hdr['authorization']?.replace(/^Bearer /, ''), idempotencyKey: hdr['idempotency-key'],
        body: init.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown,
      });
      return new Response(JSON.stringify(res.body), { status: res.status });
    }) as unknown as typeof globalThis.fetch;
    dir = await mkdtemp(join(tmpdir(), 'sre-till-spends-'));
    await prepareTillBox({
      dir, key: TEST_PACK_KEY, people: [{ userId: 'u-meena', displayName: 'Meena' }, { userId: 'u-mgr', displayName: 'Manager', manager: true }],
      pack: {
        policies: { storeId: 'store-1', branchId: 'store-1', branchName: 'Main', tradingDayCutoff: '00:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, cashVarianceToleranceMinor: 10_000, privacySlaDays: 30, warehouseId: 'wh-1' },
        lossPreventionRules: [],
      },
    });
  });
  afterAll(async () => {
    globalThis.fetch = savedFetch;
    await rm(dir, { recursive: true, force: true });
  });

  const start = async (): Promise<EdgeProcess> => (await startEdge({
    EDGE_DATA_DIR: dir, EDGE_TENANT_ID: A, PACK_SIGNING_KEY: TEST_PACK_KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_LANE_ID: 'lane-1',
    EDGE_PACK_FILE: join(dir, 'store-pack.json'), CLOUD_API_URL: 'https://cloud.example.test', CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-box', tenantId: A }),
  }, () => {}))!;
  const tillOn = async (edge: EdgeProcess) => {
    const till = bootPos({ laneId: 'lane-1', taxPercent: 0, lanePort: edge.lane!.port, tradingDayCutoff: '00:00' });
    await signInTill(till, 'u-meena');
    return till;
  };
  const headOffice = async () => ({
    points: ((await h.request({ method: 'GET', path: `/v1/customers/${MEMBER}/points`, userId: 'u-owner', tenantId: A })).body as { pointsBalance?: number }).pointsBalance,
    credit: ((await h.request({ method: 'GET', path: '/v1/stored-value/instruments/sc-1', userId: 'u-owner', tenantId: A })).body as { balanceMinor: number }).balanceMinor,
  });
  const refusalOf = async (p: Promise<unknown>): Promise<string> => {
    try { await p; return 'committed'; } catch (e) { return (e as { laneMessage?: string }).laneMessage ?? String(e); }
  };

  it('pulls the balances, splits a bill across points + store credit + card, refuses what the copy or the cap cannot cover, keeps spending safe offline and across a restart, and head office applies each spend once', async () => {
    let edge = await start();
    expect(await edge.refreshLoyaltyWallets!()).toMatchObject({ status: 'updated' });
    let till = await tillOn(edge);

    // Before a member is named, the till cannot ask; once named it sees what they may spend here.
    expect(await till.loyaltyWallet()).toMatchObject({ ok: false, refusedBecause: 'no_member_named' });
    expect(till.setLoyaltyMobile(MOBILE)).toMatchObject({ ok: true, last4: '7777' });
    expect(await till.loyaltyWallet()).toMatchObject({ ok: true, points: 50, pointValuePaise: 100, pointsValueMinor: 5_000, storeCreditMinor: 30_000, capRemainingMinor: 50_000, last4: '7777' });

    // ── A ₹1,000 bill: 20 points (₹20) + ₹50 store credit + ₹930 by card (an attempt the box recorded and the machine approved).
    till.scan({ productId: 'P1', description: 'Basmati rice 5kg', unitPriceMinor: 100_000, qty: 1 });
    const card = await till.startCardPayment('card', 93_000);
    expect(card).toMatchObject({ ok: true });
    expect(await till.answerCardPayment(card.attemptId!, 'approved')).toMatchObject({ ok: true });
    // Spending more points than the copy holds, or more than today's limit, is refused before the disk.
    const r1 = await till.nextReceipt();
    expect(await refusalOf(till.tenderSplit({ saleId: 'S-1', receiptNumber: r1, atIsoUtc: new Date().toISOString(), parts: [
      { kind: 'loyalty_points', amountMinor: 6_000 }, { kind: 'store_credit', amountMinor: 1_000 }, { kind: 'card', amountMinor: 93_000, ref: card.attemptId! },
    ] }))).toMatch(/50 point\(s\)/);
    const r1b = await till.nextReceipt();
    const receipt1 = await till.tenderSplit({ saleId: 'S-1', receiptNumber: r1b, atIsoUtc: new Date().toISOString(), parts: [
      { kind: 'loyalty_points', amountMinor: 2_000 }, { kind: 'store_credit', amountMinor: 5_000 }, { kind: 'card', amountMinor: 93_000, ref: card.attemptId! },
    ] });
    expect(receipt1).toBe(r1b);
    till.newSale();
    // On the box's disk: the member code, the split, and the points the box took — stamped by the box.
    const saved = (await readLog(edge.log.path)).map((r) => JSON.parse((r as { record: string }).record) as { id: string; customerRef?: string; tenders: { kind: string; points?: number }[] });
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ id: 'S-1', customerRef: MEMBER });
    expect(saved[0]!.tenders.map((t) => [t.kind, t.points])).toEqual([['loyalty_points', 20], ['store_credit', undefined], ['card', undefined]]);
    expect(await till.loyaltyWallet()).toMatchObject({ ok: false, refusedBecause: 'no_member_named' }); // the next bill names nobody
    till.setLoyaltyMobile(MOBILE);
    expect(await till.loyaltyWallet()).toMatchObject({ points: 30, storeCreditMinor: 25_000, capRemainingMinor: 43_000 });

    // A spend with no member named is refused, not saved.
    till.setLoyaltyMobile(null);
    till.scan({ productId: 'P2', description: 'Dal 1kg', unitPriceMinor: 5_000, qty: 1 });
    expect(await refusalOf(till.tenderSplit({ saleId: 'S-nobody', receiptNumber: await till.nextReceipt(), atIsoUtc: new Date().toISOString(), parts: [{ kind: 'store_credit', amountMinor: 5_000 }] }))).toMatch(/mobile number first/);
    expect(await readLog(edge.log.path)).toHaveLength(1);
    till.newSale();

    // ── The cable is cut. The box still decides from its copy and its own record: a ₹500 bill, 10 points + ₹490 cash.
    online = false;
    till.setLoyaltyMobile(MOBILE);
    till.scan({ productId: 'P3', description: 'Ghee 1L', unitPriceMinor: 50_000, qty: 1 });
    const r2 = await till.nextReceipt();
    expect(await till.tenderSplit({ saleId: 'S-2', receiptNumber: r2, atIsoUtc: new Date().toISOString(), parts: [
      { kind: 'loyalty_points', amountMinor: 1_000 }, { kind: 'cash', amountMinor: 49_000 },
    ] })).toBe(r2);
    till.newSale();
    expect((await edge.syncOnce!()).sent).toBe(0); // nothing reached head office
    expect(await headOffice()).toEqual({ points: 50, credit: 30_000 });

    // ── The box restarts with the cable still out: it remembers what it let the member spend (read back from its sale log).
    await edge.stop();
    edge = await start();
    till = await tillOn(edge);
    till.setLoyaltyMobile(MOBILE);
    expect(await till.loyaltyWallet()).toMatchObject({ ok: true, points: 20, storeCreditMinor: 25_000, capRemainingMinor: 42_000 });
    // Spending the same points again here is refused — no double spend through a restart.
    till.scan({ productId: 'P2', description: 'Dal 1kg', unitPriceMinor: 5_000, qty: 1 });
    expect(await refusalOf(till.tenderSplit({ saleId: 'S-3', receiptNumber: await till.nextReceipt(), atIsoUtc: new Date().toISOString(), parts: [{ kind: 'loyalty_points', amountMinor: 2_100 }, { kind: 'cash', amountMinor: 2_900 }] }))).toMatch(/20 point\(s\)/);
    till.newSale();

    // ── The line returns: head office applies each spend once and earns on the part not paid with points.
    online = true;
    expect(await edge.syncOnce!()).toMatchObject({ dead: 0, remaining: 0 });
    // 50 − 20 (S-1) + 9 (₹980 earned on S-1) − 10 (S-2) + 4 (₹490 on S-2) = 33 points; ₹300 − ₹50 = ₹250 credit.
    expect(await headOffice()).toEqual({ points: 33, credit: 25_000 });
    // The same sale relayed again is one effect.
    const relayed = await h.request({ method: 'POST', path: '/v1/sales', userId: 'u-box', tenantId: A, idempotencyKey: 'relay-again', body: edge.outbox.pending()[0]?.event.payload ?? (await (async () => {
      const rec = JSON.parse(((await readLog(edge.log.path))[0] as { record: string }).record) as Record<string, unknown>;
      const { toCloudSale } = await import('../../edge/store-edge/src/cloud-sale');
      return toCloudSale(rec, 1, 'store-1', 'lane-1');
    })()) });
    expect(relayed.status).toBe(202);
    expect(await headOffice()).toEqual({ points: 33, credit: 25_000 });
    // The box takes the new copy: head office's balances, with both spends applied, are not reduced twice.
    expect(await edge.refreshLoyaltyWallets!()).toMatchObject({ status: 'updated' });
    till.setLoyaltyMobile(MOBILE);
    expect(await till.loyaltyWallet()).toMatchObject({ points: 33, storeCreditMinor: 25_000, capRemainingMinor: 42_000 });
    till.setLoyaltyMobile(null);

    // ── A refund of the bill paid partly with points: the points part cannot come back as money.
    const bill = (await till.lookupRefund(r1b))!;
    const approval = await managerApprovesOn(till, 'u-mgr', { kind: 'refund', billRef: 'S-1', valueMinor: 100_000, reason: 'damaged' });
    const tooMuch = await bill.submit({ returnId: 'RT-1', number: await till.nextReceipt(), reasonCode: 'damaged', lines: [{ productId: 'P1', uom: 'ea', quantityMinor: 1, disposition: 'resell' }], refundMinor: 100_000, refundTender: 'card', approval });
    expect(JSON.stringify(tooMuch)).toMatch(/paid with loyalty points/);
    await edge.stop();
  }, 60_000);
});
