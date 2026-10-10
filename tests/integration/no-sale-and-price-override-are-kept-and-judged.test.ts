import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiHarness, TEST_IDP, TEST_PACK_KEY, type ApiHarness } from '../support/api-harness';
import type { HttpRequest } from '../../services/kernel/src/index';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { bootPos } from '../../apps/pos/src/browser-entry';
import { prepareTillBox, signInTill, pinOf, type TillPerson } from '../support/till-operator';
import { startRealCloud, type RealCloud } from '../support/real-store';

/**
 * **PF-07 (rest) — a NO-SALE and a PRICE OVERRIDE at the till are kept as evidence, approved by a manager on the store
 * computer, relayed once, and judged by the store's rules on head office's own record (M15-FR-01 · M12-FR-04 · §28 ·
 * P-03 · P-08 · hard rules #1 #6 #10).**
 *
 * Voids already went this way. Now the other two actions loss prevention watches: the drawer opened with no sale, and a
 * line's price lowered at the till. Each needs the one-use manager approval (PF-02) — the manager's own PIN, never the
 * cashier — issued and spent on the box, offline; is on the box's disk with the cashier and the manager the BOX verified
 * before the till acts; reaches head office through the real sync agent once (a duplicate relay is one record); and is
 * judged there — a no-sale as a no-sale, an override as a discount — by the store's thresholds, per the shop's TRADING
 * day. The sale carrying an approved override is listed as explained, not "check the lane".
 *
 * Runs on REAL PostgreSQL through the production API (`startApi`) when DATABASE_URL is set; otherwise on the in-memory
 * harness. Synthetic data only (hard rule #7).
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = DATABASE_URL ? ['no', 'sale', 'override', 'evidence', 'key'].join('-').padEnd(48, '0') : TEST_PACK_KEY;
const OWNER = 'u-owner';
const BOX = 'u-box';
const CASHIER = 'u-lanecash';
const MANAGER = 'u-manager';
const NOT_A_MANAGER = 'u-refunder'; // may approve refunds at the till, but NOT overrides
const TILL_PEOPLE: readonly TillPerson[] = [
  { userId: CASHIER, displayName: 'Lane Cashier' },
  { userId: MANAGER, displayName: 'Manager', permissions: ['pos.sale.sync', 'pos.return.approve', 'pos.override.approve'] },
  { userId: NOT_A_MANAGER, displayName: 'Refund approver', permissions: ['pos.sale.sync', 'pos.return.approve'] },
];

interface Reply { status: number; body: unknown }

describe(`PF-07 — no-sale and price override: on the box first, approved, relayed once, judged (${DATABASE_URL ? 'real PostgreSQL' : 'in-memory'})`, () => {
  let h: ApiHarness | undefined;
  let cloud: RealCloud | undefined;
  let tenant: string;
  let dir: string;
  let edge: EdgeProcess;
  let cableCut = false;
  let testCalling = false;
  const savedFetch = globalThis.fetch;
  const today = (): string => new Date().toISOString().slice(0, 10);

  const call = async (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown): Promise<Reply> => {
    if (cloud !== undefined) {
      // The test's own reads are head office's people at head office — the STORE's line is what the cut takes down.
      testCalling = true;
      try { return await cloud.request({ method, path, userId, ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }) }); } finally { testCalling = false; }
    }
    const [p, qs] = path.split('?');
    const query = qs === undefined ? undefined : Object.fromEntries(new URLSearchParams(qs));
    return h!.request({ method, path: p!, userId, tenantId: tenant, ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
  };

  const bootBox = async (): Promise<EdgeProcess> => (await startEdge({
    EDGE_DATA_DIR: dir, EDGE_TENANT_ID: tenant, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
    CLOUD_API_URL: cloud?.baseUrl ?? 'https://cloud.example.test',
    CLOUD_API_TOKEN: cloud !== undefined ? cloud.token(BOX) : TEST_IDP.issue({ sub: BOX, tenantId: tenant }),
    ...await prepareTillBox({ dir, key: KEY, people: TILL_PEOPLE }),
  }, () => {}))!;

  beforeAll(async () => {
    tenant = DATABASE_URL ? randomUUID() : 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaa707';
    if (DATABASE_URL) {
      cloud = await startRealCloud({ databaseUrl: DATABASE_URL, tenantId: tenant, owner: OWNER, packSigningKey: KEY });
      await cloud.grant(BOX, 'store_computer');
      await cloud.grant(CASHIER, 'cashier');
      await cloud.grant(MANAGER, 'store_manager');
      await cloud.grant(NOT_A_MANAGER, 'cashier');
      expect((await call('PUT', '/v1/platform/setup/locale.time_zone', OWNER, { value: 'UTC' })).status).toBe(200);
    } else {
      h = apiHarness();
      await h.seedOwner(tenant, OWNER);
      await h.provisionRole(tenant, BOX, 'store_computer');
      await h.provisionRole(tenant, CASHIER, 'cashier');
      await h.provisionRole(tenant, MANAGER, 'store_manager');
      await h.provisionRole(tenant, NOT_A_MANAGER, 'cashier');
    }
    // The store's own line to head office: cut it and every box call to the cloud fails.
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const u = String(url);
      if (u.startsWith('http://127.0.0.1:') && (cloud === undefined || !u.startsWith(cloud.baseUrl))) return savedFetch(url, init);
      if (cableCut && !testCalling) throw new Error('ENETUNREACH');
      if (cloud !== undefined) return savedFetch(url, init);
      const hdr = (init?.headers ?? {}) as Record<string, string>;
      const res = await h!.raw({
        method: (init?.method ?? 'GET') as HttpRequest['method'], path: new URL(u).pathname,
        token: hdr['authorization']?.replace(/^Bearer /, ''), idempotencyKey: hdr['idempotency-key'],
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown,
      });
      return new Response(JSON.stringify(res.body), { status: res.status });
    }) as typeof globalThis.fetch;
    dir = await mkdtemp(join(tmpdir(), 'sre-override-evidence-'));
    edge = await bootBox();
    // The store's rules: more than one no-sale a day, or any single price cut over ₹50, is an exception.
    expect((await call('POST', '/v1/loss-prevention/rules/no_sale', OWNER, { maxCount: 1 })).status).toBe(201);
    expect((await call('POST', '/v1/loss-prevention/rules/discount', OWNER, { maxSingleValueMinor: 5_000 })).status).toBe(201);
  }, 90_000);
  afterAll(async () => {
    await edge?.stop();
    globalThis.fetch = savedFetch;
    await cloud?.stop();
    await rm(dir, { recursive: true, force: true });
  });

  const tillOn = async (box: EdgeProcess) => {
    const till = bootPos({ laneId: 'lane-1', taxPercent: 0, lanePort: box.lane!.port });
    await signInTill(till, CASHIER);
    return till;
  };
  const approve = async (till: Awaited<ReturnType<typeof tillOn>>, managerId: string, r: { kind: 'no_sale' | 'price_override'; billRef?: string; valueMinor: number }) =>
    till.approveAtTill({ managerId, pin: pinOf(managerId), reason: r.kind === 'no_sale' ? 'change_for_customer' : 'damaged_pack', ...r });
  const boxEvents = async () => (await readLog(edge.deviceEventsLog.path)).flatMap((r) => (r.ok ? [JSON.parse(r.record) as { type: string; payload: Record<string, unknown> }] : []))
    .filter((e) => e.type === 'TillActivityRecorded');

  it('REFUSALS on the box, offline: no approval, the cashier approving themselves, a refund approver, a wrong amount, a re-used approval — nothing is done', async () => {
    cableCut = true; // none of this needs head office
    const till = await tillOn(edge);
    till.scan({ productId: 'P1', description: 'Ghee 1L', unitPriceMinor: 64_000, qty: 1 });
    const [line] = till.basket().map((l) => l.lineId);

    // No approval at all → refused; the price stays.
    expect(await till.priceChangeAtTill(line!, 50_000, 'damaged_pack', { approvalId: 'apr-made-up' })).toMatchObject({ ok: false, refusedBecause: 'approval_unknown' });
    expect(await till.noSaleAtTill('change_for_customer', { approvalId: '' })).toMatchObject({ ok: false, refusedBecause: 'approval_required' });
    // The cashier cannot approve their own override (§28); a person who may approve refunds may not approve overrides.
    expect(await approve(till, CASHIER, { kind: 'no_sale', valueMinor: 0 })).toMatchObject({ approved: false, refusedBecause: 'self_approval' });
    expect(await approve(till, NOT_A_MANAGER, { kind: 'no_sale', valueMinor: 0 })).toMatchObject({ approved: false, refusedBecause: 'no_approval_authority' });
    // An approval for ₹100 off does not cover ₹140 off.
    const small = await approve(till, MANAGER, { kind: 'price_override', billRef: till.currentBillRef(), valueMinor: 10_000 });
    expect(small.approved).toBe(true);
    expect(await till.priceChangeAtTill(line!, 50_000, 'damaged_pack', { approvalId: (small as { approvalId: string }).approvalId })).toMatchObject({ ok: false, refusedBecause: 'approval_does_not_match' });
    // A price change only LOWERS a price.
    expect(till.priceChangeValue(line!, 70_000)).toMatchObject({ ok: false });
    expect(till.basket()[0]!.unitPriceMinor).toBe(64_000);
    expect(await boxEvents()).toHaveLength(0);
    cableCut = false;
  });

  it('THE CASE: two no-sales and a ₹140 price cut, approved by the manager, kept on the box OFFLINE, survive a restart, reach head office once, and raise exceptions on the shop\'s trading day', async () => {
    cableCut = true;
    let till = await tillOn(edge);
    // 1 · A price override: Ghee ₹640 → ₹500, approved by the manager for exactly ₹140 off this bill.
    till.scan({ productId: 'P1', description: 'Ghee 1L', unitPriceMinor: 64_000, qty: 1 });
    const line = till.basket()[0]!.lineId;
    const value = till.priceChangeValue(line, 50_000);
    expect(value).toMatchObject({ ok: true, reductionMinor: 14_000, fromUnitMinor: 64_000 });
    const ok = await approve(till, MANAGER, { kind: 'price_override', billRef: till.currentBillRef(), valueMinor: 14_000 });
    expect(ok.approved, JSON.stringify(ok)).toBe(true);
    const approvalId = (ok as { approvalId: string }).approvalId;
    const changed = await till.priceChangeAtTill(line, 50_000, 'damaged_pack', { approvalId });
    expect(changed, JSON.stringify(changed)).toMatchObject({ ok: true });
    expect(till.basket()[0]!.unitPriceMinor).toBe(50_000);
    expect(till.payableMinor()).toBe(50_000);
    // The approval is ONE use: a second change on the same approval is refused.
    expect(await till.priceChangeAtTill(line, 40_000, 'damaged_pack', { approvalId })).toMatchObject({ ok: false });

    // 2 · Two no-sales, each with its own approval.
    for (let i = 0; i < 2; i += 1) {
      const a = await approve(till, MANAGER, { kind: 'no_sale', valueMinor: 0 });
      expect(a.approved, JSON.stringify(a)).toBe(true);
      expect(await till.noSaleAtTill('change_for_customer', { approvalId: (a as { approvalId: string }).approvalId })).toMatchObject({ ok: true });
    }

    // The bill is paid at the changed price, offline; the sale on the box's disk carries where the price came from and
    // who approved it, for head office's intake to read as explained.
    const n = await till.nextReceipt();
    await till.tenderCash(`S-${n}`, n, new Date().toISOString());
    const sold = (await readLog(edge.log.path)).flatMap((r) => (r.ok ? [JSON.parse(r.record) as Record<string, unknown>] : []));
    expect(JSON.stringify(sold)).toContain('"priceOverride":{"fromUnitPriceMinor":64000,"approvedBy":"u-manager"');

    // On the box's disk, stamped with the cashier AND the manager the box verified, with the trading day — offline.
    const onBox = await boxEvents();
    expect(onBox.map((e) => [e.payload['kind'], e.payload['cashierId'], e.payload['approvedBy'], e.payload['valueMinor']])).toEqual([
      ['price_override', CASHIER, MANAGER, 14_000], ['no_sale', CASHIER, MANAGER, 0], ['no_sale', CASHIER, MANAGER, 0],
    ]);
    expect(onBox[0]!.payload).toMatchObject({ fromUnitMinor: 64_000, toUnitMinor: 50_000, quantityMinor: 1, productId: 'P1', reason: 'damaged_pack', tradingDay: today() });
    // The line is down: nothing reached head office.
    const cut = await edge.syncOnce!();
    expect(cut.sent ?? 0).toBe(0);
    expect(((await call('GET', `/v1/loss-prevention/activity?day=${today()}`, OWNER)).body as { count: number }).count).toBe(0);

    // The box RESTARTS with the cable still out: the evidence is still there, still queued.
    await edge.stop();
    edge = await bootBox();
    expect(await boxEvents()).toHaveLength(3);
    // A spent approval stays spent across the restart.
    till = await tillOn(edge);
    till.scan({ productId: 'P2', description: 'Sugar 1kg', unitPriceMinor: 5_000, qty: 1 });
    expect(await till.priceChangeAtTill(till.basket()[0]!.lineId, 4_000, 'damaged_pack', { approvalId })).toMatchObject({ ok: false, refusedBecause: 'approval_already_used' });

    // The line returns: through the real sync agent, once.
    cableCut = false;
    expect(await edge.syncOnce!()).toMatchObject({ dead: 0, remaining: 0 });
    expect(await edge.syncOnce!()).toMatchObject({ sent: 0 });

    // A DUPLICATE relay of the same override straight to head office is the same record.
    const dup = await call('POST', `/v1/loss-prevention/activity/${String(onBox[0]!.payload['activityId'])}/synced`, BOX, onBox[0]!.payload);
    expect(dup.status).toBe(200);
    expect(dup.body).toMatchObject({ alreadyRecorded: true });

    const held = (await call('GET', `/v1/loss-prevention/activity?day=${today()}`, OWNER)).body as {
      count: number; noSales: { approvedBy: string; approverAuthorityHeld?: boolean }[]; overrides: { approvedBy: string; valueMinor: number; fromUnitMinor: number; toUnitMinor: number; approverAuthorityHeld?: boolean }[];
    };
    expect(held.count).toBe(3);
    expect(held.noSales).toHaveLength(2);
    expect(held.overrides).toEqual([expect.objectContaining({ approvedBy: MANAGER, valueMinor: 14_000, fromUnitMinor: 64_000, toUnitMinor: 50_000, approverAuthorityHeld: true })]);

    // Judged on the shop's own record: two no-sales (> 1) and one ₹140 cut (> ₹50), both for the cashier, linked.
    const ex = (await call('GET', `/v1/loss-prevention/exceptions?day=${today()}`, OWNER)).body as { exceptions: { cashierId: string; kind: string; breach: string; observed: number; linkedTxnIds: string[]; raisedAt?: string }[] };
    expect(ex.exceptions.map((x) => [x.cashierId, x.kind, x.breach, x.observed])).toEqual(expect.arrayContaining([
      [CASHIER, 'no_sale', 'count', 2], [CASHIER, 'discount', 'single_value', 14_000],
    ]));
    for (const x of ex.exceptions) {
      expect(x.raisedAt).toEqual(expect.any(String)); // raised when the evidence arrived
      expect(x.linkedTxnIds.length).toBeGreaterThan(0);
    }
    // Nothing is judged on another day.
    expect(((await call('GET', '/v1/loss-prevention/exceptions?day=2020-01-01', OWNER)).body as { exceptions: unknown[] }).exceptions).toHaveLength(0);
  }, 60_000);

  it('head office refuses an override relayed without an approver, or approved by the cashier; and an approver its own grants do not back is RAISED, not believed', async () => {
    const base = { laneId: 'lane-1', cashierId: CASHIER, reason: 'check_drawer', at: new Date().toISOString(), valueMinor: 0, kind: 'no_sale' };
    const noApprover = await call('POST', '/v1/loss-prevention/activity/N-x1/synced', BOX, { ...base, activityId: 'N-x1' });
    expect(noApprover.status).toBe(400);
    const self = await call('POST', '/v1/loss-prevention/activity/N-x2/synced', BOX, { ...base, activityId: 'N-x2', approvedBy: CASHIER, approvalId: 'apr-1' });
    expect(self.status).toBe(400);
    // A relayed no-sale "approved" by a cashier at head office: kept, flagged, raised whatever the thresholds.
    const odd = await call('POST', '/v1/loss-prevention/activity/N-x3/synced', BOX, { ...base, activityId: 'N-x3', cashierId: 'u-other', approvedBy: NOT_A_MANAGER, approvalId: 'apr-2' });
    expect(odd.status, JSON.stringify(odd.body)).toBe(201);
    const ex = (await call('GET', `/v1/loss-prevention/exceptions?day=${today()}`, OWNER)).body as { exceptions: { cashierId: string; kind: string; breach: string; severity: string; linkedTxnIds: string[] }[] };
    expect(ex.exceptions).toEqual(expect.arrayContaining([expect.objectContaining({ cashierId: 'u-other', kind: 'no_sale', breach: 'approver_without_authority', severity: 'escalate', linkedTxnIds: ['N-x3'] })]));
    // Only the box's hop may relay.
    expect((await call('POST', '/v1/loss-prevention/activity/N-x4/synced', MANAGER, { ...base, activityId: 'N-x4', approvedBy: MANAGER, approvalId: 'apr-3' })).status).toBe(403);
  });

  it('a day is the SHOP\'s trading day: an action relayed without the box\'s date is judged by head office\'s own time zone and cut-off', async () => {
    // 20:00 UTC on 7 Oct is 01:30 on 8 Oct in the shop (IST, cut-off midnight) — the shop's 8 Oct, not the server's 7 Oct.
    expect((await call('PUT', '/v1/platform/setup/locale.time_zone', OWNER, { value: 'Asia/Kolkata' })).status).toBe(200);
    const at = '2026-10-07T20:00:00.000Z';
    const r = await call('POST', '/v1/loss-prevention/activity/N-tz1/synced', BOX, {
      activityId: 'N-tz1', kind: 'no_sale', laneId: 'lane-1', cashierId: 'u-night', reason: 'check_drawer', at, valueMinor: 0, approvedBy: MANAGER, approvalId: 'apr-tz',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const on8 = (await call('GET', '/v1/loss-prevention/activity?day=2026-10-08', OWNER)).body as { noSales: { activityId: string }[] };
    const on7 = (await call('GET', '/v1/loss-prevention/activity?day=2026-10-07', OWNER)).body as { noSales: { activityId: string }[] };
    expect(on8.noSales.map((a) => a.activityId)).toContain('N-tz1');
    expect(on7.noSales.map((a) => a.activityId)).not.toContain('N-tz1');
  });
});
