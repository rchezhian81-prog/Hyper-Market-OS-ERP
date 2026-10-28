import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { issueQuotation, type QuotationLine } from '../../packages/suspended-sales/src/index';
import { HeldBills } from '../../edge/store-edge/src/held-bills';
import { billVoidRecorder, heldQuotationReleaser, QUOTATION_FREED_EVENT } from '../../edge/store-edge/src/bill-void-at-lane';
import { billCancelAtTill, type BillCancelOps } from '../../apps/pos/src/bill-cancel-at-till';
import { PosSession, taxRateFromPercent } from '../../apps/pos/src/session';
import { money } from '../../packages/contracts/src/money';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/index';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { pathFor } from '../../edge/sync-agent/src/http-transport';
import type { DurableLog } from '../../edge/store-edge/src/durability';
import { APPROVAL_KINDS, fingerprintOf, actionDetails, type ApprovalPort, type ApprovalState } from '../../services/identity/src/approval-requests';
import { quotationsRoutes } from '../../services/pos/src/quotations';
import type { Quotation } from '../../packages/suspended-sales/src/index';
import { ROLE_CATALOGUE, OWNER_ROLE_ID } from '../../services/api/src/roles';
import { createQuotationsSession, quotationsOutcomeWords, QUOTATIONS_COPY } from '../../apps/web-erp/src/quotations-session';
import { createGoodsReceiptSession, GOODS_RECEIPT_COPY, type GrnRecordView, type GrnBillMatchPort, type BillMatchPostResult } from '../../apps/web-erp/src/goods-receipt-session';
import { openGrnBillMatchPort, billCostsOfReceipt } from '../../apps/web-erp/src/goods-receipt-bill-match';

/**
 * **Round 9 · R9-A (owner, 28 Oct 2026).**
 *   • OB-532 — a quotation for a product with no known floor (never received at a cost) needs the OWNER's approval (like
 *     OB-520), through the maker-checker engine; the quoter can never approve.
 *   • OB-533 — a quotation rung up on a bill that is then HELD: the held basket carries the quotation number; giving the held
 *     basket up frees the quotation with the reason on record (the OB-523 release, through the store computer, queued, sent
 *     once). Recalling it keeps the quotation attached.
 *   • OB-534 — a "Match the bill" button on the goods-receipt screen (`POST …/goods-receipt/:grnId/bill-match`), refused for the
 *     person who received the goods; shows the matched bill afterwards; English and Tamil.
 * The pure pieces. Synthetic data only.
 */

const line = (over: Partial<QuotationLine> = {}): QuotationLine => ({ lineId: 'l1', productId: 'p-new', description: 'New brand oil 1 L', unitPriceMinor: 180_00, quantityMinor: 10, uom: 'ea', taxBps: 500, ...over });
const base = { quotationId: 'Q9', tenantId: 't', storeId: 'store-1', customerRef: 'Murugan Stores', currency: 'INR', issuedBy: 'u-mgr', issuedAt: '2030-06-01T06:00:00.000Z', validUntil: '2030-06-30' };

describe('OB-532: a quotation on a product with no known floor needs the OWNER\'s approval — never the quoter\'s', () => {
  it('is refused without approval, and with a second person\'s approval that is not the owner\'s', () => {
    expect(issueQuotation({ ...base, lines: [line()], lineFloorsMinor: {}, floorNotKnown: ['p-new'] }))
      .toMatchObject({ issued: false, outcome: 'floor_not_known_unapproved' });
    const r = issueQuotation({ ...base, lines: [line()], lineFloorsMinor: {}, floorNotKnown: ['p-new'], approval: { subjectRef: 'Q9', status: 'approved', decidedBy: 'u-mgr2', reason: 'ok' } });
    expect(r).toMatchObject({ issued: false, outcome: 'floor_not_known_unapproved' });
    expect(r.detail).toContain('only the owner may approve');
    expect(r.detail).toContain('New brand oil 1 L');
    // An owner's approval for ANOTHER quotation does not count.
    expect(issueQuotation({ ...base, lines: [line()], floorNotKnown: ['p-new'], approval: { subjectRef: 'Q-other', status: 'approved', decidedBy: 'u-owner', reason: 'ok', byOwner: true } }).outcome).toBe('floor_not_known_unapproved');
  });

  it('the owner\'s approval for exactly it lets it through (and stands for a below-floor line beside it); the owner never approves his own', () => {
    const owner = { subjectRef: 'Q9', status: 'approved' as const, decidedBy: 'u-owner', reason: 'new line, introductory price', byOwner: true };
    const ok = issueQuotation({ ...base, lines: [line(), line({ lineId: 'l2', productId: 'p-rice', description: 'Rice', unitPriceMinor: 100_00 })], lineFloorsMinor: { 'p-rice': 120_00 }, floorNotKnown: ['p-new'], approval: owner });
    expect(ok).toMatchObject({ issued: true, quotation: { marginApprovedBy: 'u-owner', floorNotKnown: ['p-new'] } });
    expect(issueQuotation({ ...base, issuedBy: 'u-owner', lines: [line()], floorNotKnown: ['p-new'], approval: owner })).toMatchObject({ issued: false, outcome: 'self_approved' });
  });

  it('a product named as not known but not on the quotation changes nothing; a quotation with a known floor is judged as before', () => {
    expect(issueQuotation({ ...base, lines: [line({ productId: 'p-rice', unitPriceMinor: 130_00 })], lineFloorsMinor: { 'p-rice': 120_00 }, floorNotKnown: ['p-new'] }).issued).toBe(true);
  });

  it('the engine knows the owner-only kind, and ONLY the owner role holds its checker word', () => {
    expect(APPROVAL_KINDS['quotation_floor_not_known']).toMatchObject({ makerPermission: 'pos.quotation.write', checkerPermission: 'pos.quotation.nofloor.approve' });
    expect(ROLE_CATALOGUE.filter((r) => r.permissions.includes('pos.quotation.nofloor.approve')).map((r) => r.id)).toEqual([OWNER_ROLE_ID]);
  });
});

describe('OB-532 at head office\'s issue route: the owner\'s approval counts only from someone who holds the OWNER role at that store', () => {
  const body = { storeId: 'store-1', customerRef: 'Murugan Stores', currency: 'INR', validUntil: '2099-12-31', lines: [{ lineId: 'l1', productId: 'p-new', description: 'New brand oil 1 L', unitPriceMinor: 170_00, quantityMinor: 10, uom: 'ea', taxBps: 500 }] };
  const run = async (decidedBy: string, kind: string, owners: readonly string[]) => {
    const recorded: Quotation[] = [];
    let spent = 0;
    const state: ApprovalState = {
      request: { requestId: 'areq-1', kind, subjectRef: 'Q9', valueMinor: null, fingerprint: fingerprintOf(actionDetails(body, { quotationId: 'Q9' })), details: {}, summary: 's', reason: 'r', requestedBy: 'u-mgr', requestedAt: '2030-06-01T05:00:00.000Z' },
      decision: { requestId: 'areq-1', decision: 'approved', decidedBy, reason: 'ok', decidedAt: '2030-06-01T05:30:00.000Z', expiresAt: '2030-06-02T05:30:00.000Z' },
    };
    const approvals: ApprovalPort = {
      approvalState: () => state, approvalVersion: () => 1, spendApproval: () => { spent += 1; return true; },
      permissionsOfUser: () => ['pos.quotation.nofloor.approve', 'price.change.approve'],
    };
    const route = quotationsRoutes({
      quotations: () => recorded, record: (_t, q) => { recorded.push(q); }, approvals, now: () => '2030-06-01T06:00:00.000Z',
      floorsAt: async () => ({ floors: {}, notKnown: ['p-new'] }), ownersAt: async () => owners,
    }).find((r) => r.method === 'POST' && r.path === '/v1/pos/quotations/:quotationId')!;
    try {
      const out = await route.handler({ tenantId: 't', userId: 'u-mgr', params: { quotationId: 'Q9' }, body: { ...body, approvalId: 'areq-1' }, query: {} } as unknown as Parameters<typeof route.handler>[0]);
      return { status: out.status, recorded: recorded.length, spent };
    } catch (e) {
      return { status: (e as { status?: number }).status, code: (e as { body?: { code?: string } }).body?.code, recorded: recorded.length, spent };
    }
  };
  it('made with the owner\'s approval; refused (nothing spent) when the decider is not an owner at the quotation\'s store, or the kind is not the owner\'s', async () => {
    expect(await run('u-owner', 'quotation_floor_not_known', ['u-owner'])).toEqual({ status: 201, recorded: 1, spent: 1 });
    expect(await run('u-owner-s2', 'quotation_floor_not_known', ['u-owner'])).toMatchObject({ status: 422, code: 'quotation_floor_not_known_unapproved', recorded: 0, spent: 0 });
    expect(await run('u-owner', 'quotation_below_floor', ['u-owner'])).toMatchObject({ status: 422, code: 'approval_does_not_match', recorded: 0, spent: 0 });
  });
});

describe('OB-532 on the Quotations page: a no-floor refusal offers to ask the OWNER for exactly that quotation', () => {
  it('keeps the quotation\'s number and lines, asks with kind quotation_floor_not_known, and says so in English and Tamil', async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); const method = init?.method ?? 'GET';
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown;
      calls.push({ url, method, body });
      const reply = url === '/v1/approvals/requests'
        ? { status: 201, body: { requestId: 'areq-1', kind: 'quotation_floor_not_known', status: 'waiting' } }
        : { status: 422, body: { error: { code: 'quotation_floor_not_known_unapproved', whatHappened: 'only the owner may approve', wasItSaved: 'not_saved', nextSafeAction: 'ask' } } };
      return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
    }) as typeof globalThis.fetch;
    const s = createQuotationsSession({ viewer: { userId: 'u-mgr', permissions: ['pos.quotation.read', 'pos.quotation.write'] }, fetch, newNumber: () => '27182818', now: () => '2030-06-01T06:00:00.000Z' });
    const lines = [{ productId: 'p-new', description: 'New brand oil 1 L', quantity: 10, unitPriceMinor: 180_00, uom: 'ea', taxBps: 500 }];
    const made = await s.make({ storeId: 'store-1', customerRef: 'Murugan Stores', validUntil: '2030-06-30', approvalId: '', lines });
    expect(made.result).toBe('refused');
    expect(s.belowFloor()).toBe('27182818');
    expect(s.needsOwner()).toBe(true);
    const asked = await s.askApproval();
    expect(calls[1]).toMatchObject({ method: 'POST', url: '/v1/approvals/requests', body: { kind: 'quotation_floor_not_known', subjectRef: '27182818', valueMinor: null } });
    expect((calls[1]!.body as { details: Record<string, unknown> }).details).toEqual({ ...(calls[0]!.body as Record<string, unknown>), quotationId: '27182818' });
    expect(quotationsOutcomeWords('en', asked)).toBe(`${QUOTATIONS_COPY.en.askedOwner} areq-1`);
    expect(quotationsOutcomeWords('ta', asked)).toBe(`${QUOTATIONS_COPY.ta.askedOwner} areq-1`);
    expect(QUOTATIONS_COPY.ta.askOwner).not.toBe(QUOTATIONS_COPY.en.askOwner);
  });
});

/** An in-memory durable log (what the box's fsync'd file is to the recorder). */
function memoryLog(): DurableLog & { records: string[]; fail: boolean } {
  const log = { records: [] as string[], fail: false, capacityBytes: 1e9, usedBytes: async () => 0, append: async (r: string) => { if (log.fail) throw new Error('disk'); log.records.push(r); } };
  return log;
}
const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

const QUOTED_LINE = { lineId: 'L1', productId: 'p-rice', description: 'Rice 25 kg', unitPriceMinor: 1_380_00, quantityMinor: 2, uom: 'ea', taxBps: 0, voided: false, priceOverride: { fromUnitMinor: 1_450_00, approvedBy: 'quotation 48151623', activityId: 'quotation:48151623' } };

async function box(withReleaser = true) {
  const dir = await mkdtemp(join(tmpdir(), 'sre-r9a-held-'));
  dirs.push(dir);
  const log = memoryLog();
  const outbox = new SyncOutbox();
  const keys = new Set<string>();
  const deps = { tenantId: 't', keys, log, outbox, now: () => '2030-06-02T06:20:00.000Z', tradingDayOf: () => '2030-06-02' };
  const held = await HeldBills.open({ dataDir: dir, capacityBytes: 1_048_576, tenantId: 't', policy: () => null, storeId: () => 'store-1', now: () => '2030-06-02T06:15:00.000Z',
    ...(withReleaser ? { freeQuotations: heldQuotationReleaser(deps) } : {}) });
  return { dir, held, log, outbox, deps };
}

describe('OB-533: a held basket carries its quotation — giving it up frees it; recalling it keeps it attached', () => {
  it('the hold keeps the quotation (and the line\'s price evidence) on the disk; a recall gives both back', async () => {
    const { held } = await box();
    const h = await held.hold({ laneId: 'lane-1', cashierId: 'u-cash', billId: 'H-1', lines: [QUOTED_LINE], quotations: [{ quotationId: '48151623', saleId: 'B-lane-1-a' }] });
    expect(h.held).toBe(true);
    const r = await held.recall({ laneId: 'lane-1', byUserId: 'u-cash', billId: 'H-1' });
    expect(r.recalled).toBe(true);
    if (!r.recalled) return;
    expect(r.bill.quotations).toEqual([{ quotationId: '48151623', saleId: 'B-lane-1-a' }]);
    expect(r.bill.lines[0]!.priceOverride).toEqual(QUOTED_LINE.priceOverride);
  });

  it('a held basket\'s quotations survive the box restarting (read back from its disk)', async () => {
    const { dir, held } = await box();
    await held.hold({ laneId: 'lane-1', cashierId: 'u-cash', billId: 'H-2', lines: [QUOTED_LINE], quotations: [{ quotationId: '48151623', saleId: 'B-lane-1-a' }] });
    await held.close();
    const again = await HeldBills.open({ dataDir: dir, capacityBytes: 1_048_576, tenantId: 't', policy: () => null, storeId: () => 'store-1' });
    const r = await again.recall({ laneId: 'lane-1', byUserId: 'u-cash', billId: 'H-2' });
    expect(r.recalled && r.bill.quotations).toEqual([{ quotationId: '48151623', saleId: 'B-lane-1-a' }]);
    await again.close();
  });

  it('giving it up keeps a release (who, why, the bill it was rung up on) on the disk, queued once for head office\'s own route', async () => {
    const { held, log, outbox } = await box();
    await held.hold({ laneId: 'lane-1', cashierId: 'u-cash', billId: 'H-3', lines: [QUOTED_LINE], quotations: [{ quotationId: '48151623', saleId: 'B-lane-1-a' }] });
    const out = await held.abandon({ laneId: 'lane-1', byUserId: 'u-cash2', billId: 'H-3', reason: 'customer_left' });
    expect(out).toMatchObject({ abandoned: true, quotationsFreed: ['48151623'] });
    expect(out.laneMessage).toContain('Quotation 48151623 is freed again');
    expect(out.laneMessageTa).toContain('விலைப்புள்ளி 48151623 மீண்டும் விடுவிக்கப்பட்டது');
    const events = log.records.map((r) => JSON.parse(r) as { type: string; payload: Record<string, unknown> });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: QUOTATION_FREED_EVENT, payload: { freeId: 'H-3-48151623', quotationId: '48151623', saleId: 'B-lane-1-a', freedBy: 'u-cash2', reason: 'customer_left', laneId: 'lane-1', via: 'held_basket_given_up', heldBillId: 'H-3', tradingDay: '2030-06-02' } });
    expect(pathFor(outbox.pending()[0]!.event)).toBe('/v1/pos/quotations/48151623/free/synced');
    // The give-up re-sent (its reply lost): the release is made sure of — nothing written twice.
    expect(await held.abandon({ laneId: 'lane-1', byUserId: 'u-cash2', billId: 'H-3', reason: 'customer_left' })).toMatchObject({ abandoned: true, quotationsFreed: ['48151623'] });
    expect(log.records).toHaveLength(1);
    expect(outbox.pending()).toHaveLength(1);
    // A basket with no quotation is given up exactly as before — no release.
    await held.hold({ laneId: 'lane-1', cashierId: 'u-cash', billId: 'H-4', lines: [{ ...QUOTED_LINE, priceOverride: undefined }] });
    expect(await held.abandon({ laneId: 'lane-1', byUserId: 'u-cash', billId: 'H-4', reason: 'held_by_mistake' })).toEqual({ abandoned: true, laneMessage: 'Basket given up. It stays on the record.' });
    expect(log.records).toHaveLength(1);
  });

  it('a disk that refuses the release is SAID (the quotation stays used); giving it up again retries; no releaser → not given up', async () => {
    const { held, log, outbox } = await box();
    await held.hold({ laneId: 'lane-1', cashierId: 'u-cash', billId: 'H-5', lines: [QUOTED_LINE], quotations: [{ quotationId: '48151623', saleId: 'B-lane-1-a' }] });
    log.fail = true;
    const out = await held.abandon({ laneId: 'lane-1', byUserId: 'u-cash', billId: 'H-5', reason: 'customer_left' });
    expect(out).toMatchObject({ abandoned: true, quotationsNotFreed: ['48151623'] });
    expect(out.laneMessage).toContain('could NOT be freed');
    expect(outbox.pending()).toHaveLength(0);
    log.fail = false;
    expect(await held.abandon({ laneId: 'lane-1', byUserId: 'u-cash', billId: 'H-5', reason: 'customer_left' })).toMatchObject({ abandoned: true, quotationsFreed: ['48151623'] });
    expect(outbox.pending()).toHaveLength(1);

    const bare = await box(false);
    await bare.held.hold({ laneId: 'lane-1', cashierId: 'u-cash', billId: 'H-6', lines: [QUOTED_LINE], quotations: [{ quotationId: '48151623', saleId: 'B-lane-1-a' }] });
    expect(await bare.held.abandon({ laneId: 'lane-1', byUserId: 'u-cash', billId: 'H-6', reason: 'customer_left' })).toMatchObject({ abandoned: false });
    expect((await bare.held.recall({ laneId: 'lane-1', byUserId: 'u-cash', billId: 'H-6' })).recalled).toBe(true); // still held
  });

  it('a basket whose quotation the box cannot read is not held (nothing pretended)', async () => {
    const { held } = await box();
    for (const bad of [[{ quotationId: 'no spaces!', saleId: 'B-1' }], [{ quotationId: '48151623' }], 'x']) {
      expect(await held.hold({ laneId: 'lane-1', cashierId: 'u-cash', billId: 'H-7', lines: [QUOTED_LINE], quotations: bad })).toMatchObject({ held: false, refusedBecause: 'basket_not_readable' });
    }
  });

  it('a recalled basket\'s bill, cancelled, frees its quotation from the bill it was rung up on — not the new bill\'s number', async () => {
    const log = memoryLog();
    const record = billVoidRecorder({ tenantId: 't', keys: new Set(), log, outbox: new SyncOutbox(), now: () => '2030-06-02T06:30:00.000Z', tradingDayOf: () => '2030-06-02' });
    const out = await record({ laneId: 'lane-1', cashierId: 'u-cash', via: 'pin', body: { kind: 'bill_void', activityId: 'BV-9', billRef: 'B-lane-1-new', reason: 'customer_left', lines: [], quotationIds: ['48151623'], quotationBills: { '48151623': 'B-lane-1-a' } } });
    expect(out.recorded).toBe(true);
    expect((JSON.parse(log.records[0]!) as { payload: Record<string, unknown> }).payload).toMatchObject({ quotationId: '48151623', saleId: 'B-lane-1-a', billVoidId: 'BV-9' });
    expect((await record({ laneId: 'lane-1', cashierId: 'u-cash', via: 'pin', body: { kind: 'bill_void', activityId: 'BV-10', billRef: 'B-x', reason: 'r', lines: [], quotationIds: ['1'], quotationBills: { 1: 'bad id!' } } })).recorded).toBe(false);
  });

  it('the till\'s cancel names each recalled quotation\'s own bill', async () => {
    const sent: Record<string, unknown>[] = [];
    const ops: BillCancelOps = {
      signedIn: () => true, committed: () => false, awaitingSave: () => false, billRef: () => 'B-lane-1-new',
      liveLines: () => [], quotationsOnBill: () => ['48151623'], quotationBills: () => ({ '48151623': 'B-lane-1-a' }),
      voidLine: () => {}, newSale: () => {}, newActivityId: () => 'BV-9',
    };
    await billCancelAtTill({ ops, post: async (b) => { sent.push(b); return { recorded: true }; } })('customer_left');
    expect(sent[0]).toMatchObject({ quotationIds: ['48151623'], quotationBills: { '48151623': 'B-lane-1-a' } });
  });

  it('the till session parks a lowered line with its price evidence and brings it back with it', () => {
    const s = new PosSession(
      { laneId: 'lane-1', cashierId: 'u-cash', tradingDay: '2030-06-02', currency: 'INR', defaultTaxRate: taxRateFromPercent(0) },
      new Ledger(new InMemoryLedgerStore()), new SyncOutbox(),
      () => Promise.resolve({ committed: true as const, durable: true as const, detail: 'test double', laneMessage: 'Sale complete.' }),
    );
    s.setNow('2030-06-02T06:00:00Z');
    s.restoreHeld([QUOTED_LINE]);
    const parked = s.basketToHold().lines[0]!;
    expect(parked.priceOverride).toEqual(QUOTED_LINE.priceOverride);
    expect(parked.unitPriceMinor).toBe(1_380_00);
    expect(s.basket()[0]).toMatchObject({ unitPrice: money(1_380_00, 'INR'), priceOverride: QUOTED_LINE.priceOverride });
  });
});

// ── OB-534: "Match the bill" on the goods-receipt screen ──────────────────────────────────────────────────────

const GRN = (over: Partial<GrnRecordView> = {}): GrnRecordView => ({
  grnId: 'GRN-1', number: 'GRN-0001', poId: null, warehouseId: 'store-1', receivedBy: 'u-recv', receivedAt: '2030-06-01T05:00:00.000Z',
  requiresApproval: false, discrepancyValueMinor: 0, currency: 'INR', sellableMinor: 1000, quarantinedMinor: 0, rejectedMinor: 0, discrepancies: [],
  costNotKnown: [{ lineId: 'L1', productId: 'p-oil', because: 'no_issued_order' }], unbilledLineCount: 1, ...over,
});
function screen(userId: string | null, grn: GrnRecordView, answer: BillMatchPostResult | 'none', perms = true) {
  const posts: { grnId: string; invoiceId: string }[] = [];
  const port: GrnBillMatchPort = { post: async (i) => { posts.push(i); return answer as BillMatchPostResult; } };
  const session = createGoodsReceiptSession({ userId }, {
    snapshot: () => ({ receipts: [grn], asAt: '2030-06-02T06:00:00.000Z' }), mayRead: () => true,
    mayMatchBill: () => perms, billMatchPort: () => (answer === 'none' ? null : port),
  });
  return { session, posts };
}
const MATCHED = [{ lineId: 'L1', productId: 'p-oil', invoiceId: 'INV-77', unitCostMinor: 152_50, currency: 'INR', matchedBy: 'u-buyer', matchedAt: '2030-06-02T06:01:00.000Z' }];

describe('OB-534: "Match the bill" on the goods-receipt screen — never by the person who received the goods', () => {
  it('offers the button to a holder of the right; posts exactly the bill number; shows the matched bill at once, in both languages', async () => {
    const { session, posts } = screen('u-buyer', GRN(), { result: 'matched', matched: MATCHED });
    expect(session.view('en').receipts[0]!.billMatch).toEqual({ matched: [], canMatch: true, receivedByYou: false });
    expect(await session.matchBill({ grnId: 'GRN-1', invoiceId: '  ' })).toEqual({ outcome: 'invoice_missing' });
    const out = await session.matchBill({ grnId: 'GRN-1', invoiceId: ' INV-77 ' });
    expect(out).toEqual({ outcome: 'matched', matched: MATCHED });
    expect(posts).toEqual([{ grnId: 'GRN-1', invoiceId: 'INV-77' }]);
    expect(session.presentBillMatchOutcome('en', out).label).toBe(GOODS_RECEIPT_COPY.en.billMatchDone);
    expect(session.presentBillMatchOutcome('ta', out).label).toBe(GOODS_RECEIPT_COPY.ta.billMatchDone);
    const after = session.view('en').receipts[0]!.billMatch;
    expect(after.canMatch).toBe(false); // nothing left waiting
    expect(after.matched).toEqual([{ invoiceId: 'INV-77', label: 'Bill INV-77 matched: p-oil at ₹152.50 each — by u-buyer' }]);
    expect(session.view('ta').receipts[0]!.billMatch.matched[0]!.label).toBe('பில் INV-77 பொருத்தப்பட்டது: p-oil ஒன்றுக்கு ₹152.50 — பொருத்தியவர் u-buyer');
    expect(await session.matchBill({ grnId: 'GRN-1', invoiceId: 'INV-77' })).toEqual({ outcome: 'nothing_waiting' });
  });

  it('the person who received the goods sees why not, and nothing is sent', async () => {
    const { session, posts } = screen('u-recv', GRN(), { result: 'matched', matched: MATCHED });
    expect(session.view('en').receipts[0]!.billMatch).toEqual({ matched: [], canMatch: false, receivedByYou: true });
    const out = await session.matchBill({ grnId: 'GRN-1', invoiceId: 'INV-77' });
    expect(out).toEqual({ outcome: 'received_by_you' });
    expect(posts).toEqual([]);
    expect(session.presentBillMatchOutcome('en', out).label).toBe(GOODS_RECEIPT_COPY.en.billMatchNotYou);
  });

  it('says head office\'s refusals by name, no connection, no right — and shows bills already on record', async () => {
    for (const [answer, outcome, key] of [
      [{ result: 'self_match', reason: 'u-x received this delivery' }, 'self_match', 'billMatchSelf'],
      [{ result: 'bill_unknown', reason: 'No supplier bill INV-0' }, 'bill_unknown', 'billMatchUnknownBill'],
      [{ result: 'refused', reason: 'Bill is for order PO-2' }, 'refused', 'billMatchRefused'],
      [{ result: 'lost_link' }, 'lost_link', 'billMatchLostLink'],
    ] as const) {
      const { session } = screen('u-buyer', GRN(), answer);
      const out = await session.matchBill({ grnId: 'GRN-1', invoiceId: 'INV-0' });
      expect(out.outcome).toBe(outcome);
      expect(session.presentBillMatchOutcome('en', out).label.startsWith(GOODS_RECEIPT_COPY.en[key])).toBe(true);
    }
    expect(await screen('u-buyer', GRN(), 'none').session.matchBill({ grnId: 'GRN-1', invoiceId: 'INV-0' })).toEqual({ outcome: 'no_link' });
    const noRight = screen('u-buyer', GRN(), { result: 'lost_link' }, false);
    expect(noRight.session.view('en').receipts[0]!.billMatch).toEqual({ matched: [], canMatch: false, receivedByYou: false });
    expect(await noRight.session.matchBill({ grnId: 'GRN-1', invoiceId: 'INV-0' })).toEqual({ outcome: 'not_permitted' });
    expect(await screen(null, GRN(), { result: 'lost_link' }).session.matchBill({ grnId: 'GRN-1', invoiceId: 'INV-0' })).toEqual({ outcome: 'not_permitted' });
    expect(await screen('u-buyer', GRN(), { result: 'lost_link' }).session.matchBill({ grnId: 'GRN-404', invoiceId: 'INV-0' })).toEqual({ outcome: 'receipt_unknown' });
    const done = screen('u-buyer', GRN({ billCosts: [{ ...MATCHED[0]!, costWasKnown: true }], unbilledLineCount: 0 }), { result: 'lost_link' }).session.view('en').receipts[0]!.billMatch;
    expect(done.canMatch).toBe(false);
    expect(done.matched[0]!.label).toContain(GOODS_RECEIPT_COPY.en.billMatchedKnown);
  });

  it('every new word has its Tamil twin', () => {
    for (const k of Object.keys(GOODS_RECEIPT_COPY.en).filter((x) => x.startsWith('billMatch'))) {
      expect((GOODS_RECEIPT_COPY.ta as Record<string, string>)[k], k).toBeTruthy();
      expect((GOODS_RECEIPT_COPY.ta as Record<string, string>)[k]).not.toBe((GOODS_RECEIPT_COPY.en as Record<string, string>)[k]);
    }
  });

  it('the page reads a receipt\'s bills as head office listed them, and the port posts { invoiceId } only, naming each refusal', async () => {
    expect(billCostsOfReceipt({ captured: { lines: [{ lineId: 'L1' }, { lineId: 'L2' }] }, billCosts: [{ lineId: 'L1', productId: 'p', invoiceId: 'INV-1', unitCost: { minor: 100, currency: 'INR' }, matchedBy: 'u', matchedAt: 'x', costWasKnown: true }] }))
      .toEqual({ billCosts: [{ lineId: 'L1', productId: 'p', invoiceId: 'INV-1', unitCostMinor: 100, currency: 'INR', matchedBy: 'u', matchedAt: 'x', costWasKnown: true }], unbilledLineCount: 1 });
    expect(billCostsOfReceipt({ captured: { lines: [{ lineId: 'L1' }] } })).toEqual({ unbilledLineCount: 1 });
    const g = globalThis as { fetch?: typeof fetch };
    const real = g.fetch;
    const seen: { url: string; body: unknown }[] = [];
    let reply: { status: number; body: unknown } = { status: 201, body: { matched: [{ lineId: 'L1', productId: 'p', invoiceId: 'INV-1', unitCost: { minor: 100, currency: 'INR' }, matchedBy: 'u', matchedAt: 'x' }], alreadyMatched: false } };
    g.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), body: JSON.parse(String(init?.body)) as unknown });
      return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
    }) as typeof globalThis.fetch;
    try {
      const port = openGrnBillMatchPort();
      expect(await port.post({ grnId: 'GRN 1', invoiceId: 'INV-1' })).toMatchObject({ result: 'matched', matched: [{ invoiceId: 'INV-1', unitCostMinor: 100 }] });
      expect(seen[0]).toEqual({ url: '/v1/inventory/goods-receipt/GRN%201/bill-match', body: { invoiceId: 'INV-1' } });
      reply = { status: 403, body: { error: { code: 'self_match', whatHappened: 'u received it' } } };
      expect(await port.post({ grnId: 'G', invoiceId: 'I' })).toEqual({ result: 'self_match', reason: 'u received it' });
      reply = { status: 404, body: { error: { code: 'bill_unknown', whatHappened: 'no bill' } } };
      expect(await port.post({ grnId: 'G', invoiceId: 'I' })).toEqual({ result: 'bill_unknown', reason: 'no bill' });
      reply = { status: 403, body: { error: { code: 'forbidden', whatHappened: 'no right' } } };
      expect(await port.post({ grnId: 'G', invoiceId: 'I' })).toEqual({ result: 'not_permitted', reason: 'no right' });
      reply = { status: 409, body: { error: { code: 'bill_for_another_order', whatHappened: 'other order' } } };
      expect(await port.post({ grnId: 'G', invoiceId: 'I' })).toEqual({ result: 'refused', reason: 'other order' });
      g.fetch = (async () => { throw new TypeError('Failed to fetch'); }) as typeof globalThis.fetch;
      expect(await port.post({ grnId: 'G', invoiceId: 'I' })).toEqual({ result: 'lost_link' });
    } finally {
      g.fetch = real;
    }
  });
});
