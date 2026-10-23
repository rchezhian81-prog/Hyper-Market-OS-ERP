import { describe, it, expect } from 'vitest';
import { buildBackwardTrace, batchesStillToFetch, MAX_INGREDIENT_DEPTH, type BatchOrigin, type BackwardSale } from '../../packages/quality/src/lot-trace-backward';
import type { TraceReceipt } from '../../packages/quality/src/lot-trace-chain';
import { republishWithBlocks } from '../../services/catalogue/src/recall-republish';
import { hmacSigner, verifyAsLane } from '../../services/catalogue/src/index';
import { publishPack, type SignedPack } from '../../services/catalogue/src/pack';
import { buildRecallNoticeList, type RecallBuyer } from '../../services/customer/src/recall-notices';
import type { ConsentRecord } from '../../services/customer/src/index';
import { readableMemberName, memberNameOf, LOYALTY_ENROLMENT_NOTICE } from '../../services/customer/src/loyalty-members';
import { withRecallOrderGuard, RECALL_GUARDED_ORDER_ROUTES, type RecallOrderGuardDeps } from '../../services/purchase/src/recall-order-guard';
import { lane2RecallSurface, customersNamedIn, AUDITED_TRACE_READS } from '../../services/api/src/lane2-recall-adapters';
import { buildSurface } from '../../services/api/src/main';
import { ApiError, type Route, type RequestContext } from '../../services/kernel/src/index';
import type { StoredPurchaseOrder } from '../../services/purchase/src/purchase-orders';

// Lane 2 · P1 (M10-FR-03 / M10-FR-04 / WF-09 / OB-297): the pure engines and the wiring rules, one by one.

const KEY = ['lane2', 'recall', 'unit', 'signing', 'key'].join('-').padEnd(48, '0');
const signer = hmacSigner(KEY);

// ── the backward trace engine ──────────────────────────────────────────────────────────────────────────────────────

const receipt = (over: Partial<TraceReceipt> = {}): TraceReceipt => ({
  grnId: 'grn-1', grnNumber: 'GRN-0001', supplierId: 'sup-1', poId: 'po-1', productId: 'p1', locationId: 'S1', receivedAt: '2030-01-01T00:00:00Z', quantityMinor: 10, ...over,
});
const saleOf = (saleId: string, batches: BackwardSale['lines'][number]['batches'], productId = 'p1'): BackwardSale => ({ saleId, soldDate: '2030-02-01', lines: [{ productId, quantityMinor: 1, batches }] });

describe('the backward trace engine (packages/quality/src/lot-trace-backward.ts)', () => {
  it('a till-recorded batch with a receipt from a supplier is complete', () => {
    const t = buildBackwardTrace({ sales: [saleOf('S1', [{ batchId: 'B1', knownBy: 'till_recorded' }])], origins: new Map([['B1', { receipts: [receipt()], madeBy: [] }]]) });
    expect(t.complete).toBe(true);
    expect(t.gaps).toEqual([]);
    expect(t.suppliers).toEqual([{ supplierId: 'sup-1', batchIds: ['B1'], references: ['GRN GRN-0001 (PO po-1)'] }]);
  });

  it('names every gap: unknown batch, estimate, no receipt note, no supplier, nothing on record, unrecorded ingredients', () => {
    const sales = [
      saleOf('S1', []),
      saleOf('S2', [{ batchId: 'B2', knownBy: 'fifo_estimate' }]),
      saleOf('S3', [{ batchId: 'B3', knownBy: 'till_recorded' }]),
      saleOf('S4', [{ batchId: 'B4', knownBy: 'till_recorded' }]),
      saleOf('S5', [{ batchId: 'B5', knownBy: 'till_recorded' }]),
    ];
    const origins = new Map<string, BatchOrigin>([
      ['B2', { receipts: [receipt({ grnId: null, movementId: 'mv-1', supplierId: null, poId: null })], madeBy: [] }],
      ['B3', { receipts: [receipt({ supplierId: null, poId: null })], madeBy: [] }],
      ['B5', { receipts: [], madeBy: [{ runId: 'r1', inputsRecorded: false, inputBatchIds: [] }] }],
    ]);
    const t = buildBackwardTrace({ sales, origins });
    const g = t.gaps.join(' | ');
    expect(g).toMatch(/sale S1: which batch of p1 was sold is not known/);
    expect(g).toMatch(/sale S2: the batch of p1 is a FIFO estimate/);
    expect(g).toMatch(/batch B2: 10 received at S1 on 2030-01-01 with no goods-receipt note/);
    expect(g).toMatch(/batch B3: goods receipt GRN-0001 names no purchase order/);
    expect(g).toMatch(/batch B4: nothing about it is on record/);
    expect(g).toMatch(/batch B5: production run r1 made it before runs kept their ingredient batches/);
    expect(t.complete).toBe(false);
    expect(t.suppliers).toEqual([]);
  });

  it('walks back through ingredients, asks for what it lacks, and stops (said) past the depth limit; a cycle ends', () => {
    const sales = [saleOf('S1', [{ batchId: 'D0', knownBy: 'till_recorded' }])];
    const origins = new Map<string, BatchOrigin>();
    expect(batchesStillToFetch(sales, origins)).toEqual(['D0']);
    // A chain D0 ← D1 ← … ← D7, each made from the next; D3 also lists D0 (a cycle).
    for (let i = 0; i <= 7; i += 1) origins.set(`D${i}`, { receipts: i === 7 ? [receipt()] : [], madeBy: [{ runId: `r${i}`, inputsRecorded: true, inputBatchIds: i === 3 ? ['D4', 'D0'] : [`D${i + 1}`] }] });
    expect(batchesStillToFetch(sales, origins)).toEqual([]);
    const t = buildBackwardTrace({ sales, origins });
    expect(t.batches.map((b) => b.batchId)).toEqual(['D0', 'D1', 'D2', 'D3', 'D4', 'D5']);
    expect(Math.max(...t.batches.map((b) => b.depth))).toBe(MAX_INGREDIENT_DEPTH);
    expect(t.gaps.join(' | ')).toMatch(/the walk back stopped at 5 steps of ingredients — D6/);
  });

  it('an ingredient recorded with no batch is a gap', () => {
    const t = buildBackwardTrace({
      sales: [saleOf('S1', [{ batchId: 'BUN', knownBy: 'till_recorded' }])],
      origins: new Map([['BUN', { receipts: [], madeBy: [{ runId: 'r1', inputsRecorded: true, inputBatchIds: [], inputsWithoutBatch: 2 }] }]]),
    });
    expect(t.gaps).toEqual(['batch BUN: production run r1 used 2 ingredient(s) with no batch recorded — where those came from is not known']);
  });
});

// ── the recall pack ────────────────────────────────────────────────────────────────────────────────────────────────

function pack(products: { productId: string; recallBlock?: boolean; blockedBatches?: string[] }[]): SignedPack {
  const r = publishPack({
    snapshot: {
      tenantId: 't', version: 4, builtAt: '2030-01-01T00:00:00Z', barcodes: [],
      products: products.map((p) => ({ productId: p.productId, sku: p.productId, name: p.productId, baseUom: 'ea', unitPriceMinor: 100, taxBps: 500, status: 'active' as const, ...(p.recallBlock === undefined ? {} : { recallBlock: p.recallBlock }), ...(p.blockedBatches === undefined ? {} : { blockedBatches: p.blockedBatches }) })),
    },
    approvals: [], signer, publishedBy: 'u-mgr', publishedAt: '2030-01-01T00:00:00Z',
  });
  return r.pack!;
}

describe('the recall pack (services/catalogue/src/recall-republish.ts)', () => {
  const batches = (m: Record<string, string[]>) => (p: string) => m[p] ?? [];
  it('blocks only what must not be sold, one version on, prices and build time untouched, signed', () => {
    const previous = pack([{ productId: 'a' }, { productId: 'b' }]);
    const r = republishWithBlocks({ previous, blocked: new Set(['a', 'zz']), batchesOf: batches({ a: ['B2', 'B1'] }), signer, publishedBy: 'recall-block:u', publishedAt: '2030-02-01T00:00:00Z' });
    expect(r.outcome).toBe('published');
    if (r.outcome !== 'published') return;
    expect(r.newlyBlocked).toEqual(['a']);
    expect(r.pack.snapshot.version).toBe(5);
    expect(r.pack.snapshot.builtAt).toBe(previous.snapshot.builtAt);
    expect(r.pack.snapshot.products.find((p) => p.productId === 'a')).toMatchObject({ recallBlock: true, blockedBatches: ['B1', 'B2'] });
    expect(r.pack.snapshot.products.find((p) => p.productId === 'b')?.recallBlock).toBeUndefined();
    expect(r.pack.snapshot.products.some((p) => p.productId === 'zz')).toBe(false); // a product no till carries is not added
    expect(verifyAsLane(r.pack, signer)).toBe(true);
  });
  it('adds batches to a batch block, widens to the whole product when a block names none, never lifts one', () => {
    const previous = pack([{ productId: 'a', recallBlock: true, blockedBatches: ['B1'] }, { productId: 'b', recallBlock: true, blockedBatches: ['X'] }, { productId: 'c', recallBlock: true }]);
    const r = republishWithBlocks({ previous, blocked: new Set(['a', 'b']), batchesOf: batches({ a: ['B3'] }), signer, publishedBy: 'x', publishedAt: '2030-02-01T00:00:00Z' });
    if (r.outcome !== 'published') throw new Error(r.detail);
    expect(r.pack.snapshot.products.find((p) => p.productId === 'a')!.blockedBatches).toEqual(['B1', 'B3']);
    const b = r.pack.snapshot.products.find((p) => p.productId === 'b')!;
    expect(b.recallBlock).toBe(true);
    expect(b.blockedBatches).toBeUndefined();
    // c is not in the blocked set any more (a released hold): the recall pack does not lift it.
    expect(r.pack.snapshot.products.find((p) => p.productId === 'c')!.recallBlock).toBe(true);
  });
  it('says when the tills already have every block', () => {
    const previous = pack([{ productId: 'a', recallBlock: true, blockedBatches: ['B1'] }]);
    expect(republishWithBlocks({ previous, blocked: new Set(['a']), batchesOf: batches({ a: ['B1'] }), signer, publishedBy: 'x', publishedAt: 'y' }).outcome).toBe('already_on_pack');
  });
});

// ── the call list ──────────────────────────────────────────────────────────────────────────────────────────────────

const consent = (customerId: string, channel: ConsentRecord['channel'], given: boolean, recordedAt: string, purpose: ConsentRecord['purpose'] = 'transactional'): ConsentRecord =>
  ({ customerId, purpose, channel, given, recordedAt, evidence: 'at the desk' });
const buyer = (saleId: string, customerRef?: string, over: Partial<RecallBuyer> = {}): RecallBuyer =>
  ({ saleId, soldDate: '2030-06-10', quantityMinor: 1, source: 'captured', ...(customerRef === undefined ? {} : { customerRef }), via: { kind: 'this_batch' }, ...over });
const recall = { batchId: 'M-9', status: 'open' as const, reason: 'r', initiatedAt: '2030-06-11T00:00:00Z', closedAt: null };

describe('the recall call list (services/customer/src/recall-notices.ts, OB-297 · OB-328 · OB-329)', () => {
  it('OB-328: everyone known is on it, with notes for what they said no to; SMS only on a yes to service messages by SMS', () => {
    const list = buildRecallNoticeList({
      recall,
      buyers: [buyer('S1', 'a'), buyer('S2', 'b'), buyer('S3', 'c'), buyer('S4'), buyer('S5', 'd', { source: 'fifo_receipt_estimate', via: { kind: 'made_from_it', productId: 'BUN', batchId: 'BUN-1', runId: 'r1' } }), buyer('S6', 'e')],
      consentOf: new Map([
        ['a', [consent('a', 'sms', true, '2030-01-01')]],
        ['b', [consent('b', 'sms', true, '2030-01-01'), consent('b', 'sms', false, '2030-02-01')]],
        ['c', [consent('c', 'sms', true, '2030-01-01', 'marketing')]],
        ['d', [consent('d', 'email', true, '2030-01-01')]],
        ['e', [consent('e', 'sms', true, '2030-01-01'), consent('e', 'sms', false, '2030-01-02', 'marketing')]],
      ]),
      nameOf: new Map([['a', 'Anitha']]),
      phoneLast4Of: new Map([['a', '+91 98765 43210'], ['d', '12']]),
      now: '2030-06-12T00:00:00Z',
    });
    expect(list.callList.map((c) => [c.customerRef, c.name, c.phoneLast4, c.serviceMessagesOn, c.smsAllowed, c.notes])).toEqual([
      ['a', 'Anitha', '3210', ['sms'], true, []],
      ['b', null, null, [], false, ['said_no_to_service_messages']],
      ['c', null, null, [], false, ['no_answer_on_service_messages']],
      ['d', null, '12', ['email'], false, []],
      ['e', null, null, ['sms'], true, ['said_no_to_promotions']],
    ]);
    expect(list.callList[4]!.noteSay).toEqual(['said no to promotions — safety call only']);
    expect(list.callList[3]!.bought).toEqual([{ lot: 'BUN-1', date: '2030-06-10', saleId: 'S5', quantityMinor: 1, madeFromLot: 'M-9', estimate: true }]);
    expect(list).toMatchObject({ anonymousSales: 1, estimatedSales: 1, smsConsented: 2, decisions: ['OB-297', 'OB-328', 'OB-329'] });
    expect(list.dataLawBasis.en).toBe('Data-law basis to be confirmed by your CA or lawyer.');
    expect(list.detail).toMatch(/Data-law basis to be confirmed by your CA or lawyer\./);
  });
});

describe('the optional name at enrolment (services/customer/src/loyalty-members.ts, OB-329)', () => {
  it('a skipped name is not on record; a non-name is refused; an erased name is not on record', () => {
    expect(readableMemberName(undefined)).toBeUndefined();
    expect(readableMemberName('   ')).toBeUndefined();
    expect(readableMemberName('  Anitha   Raman ')).toBe('Anitha Raman');
    expect(readableMemberName('அனிதா')).toBe('அனிதா');
    expect(readableMemberName('9876543210')).toBe('unreadable');
    expect(readableMemberName('x')).toBe('unreadable');
    expect(readableMemberName(42)).toBe('unreadable');
    const rec = (fullName?: string) => ({ memberRef: 'm', mobileLast4: '1234', status: 'member' as const, consentGivenAt: 'a', enrolledBy: 'u', verifiedHow: 'seen_on_phone' as const, ...(fullName === undefined ? {} : { fullName }) });
    expect(memberNameOf([rec()])).toBeUndefined();
    expect(memberNameOf([rec('Anitha'), rec()])).toBe('Anitha');
    expect(memberNameOf([rec('[erased]')])).toBeUndefined();
    expect(LOYALTY_ENROLMENT_NOTICE.en).toMatch(/your name only if you choose to give it/);
    expect(LOYALTY_ENROLMENT_NOTICE.ta).toMatch(/பெயர்/);
  });
});

// ── the ordering guard ─────────────────────────────────────────────────────────────────────────────────────────────

const ctx = (params: Record<string, string>, body: unknown): RequestContext => ({ tenantId: 't', userId: 'u', branchId: null, params, query: {}, body, traceId: 'tr' });
const po = (lines: [string, number][], status: 'proposed' | 'issued' = 'proposed'): StoredPurchaseOrder => ({
  poId: 'po', number: 'po', supplierId: 's', requisitionedBy: 'x', at: 'a', lines: lines.map(([productId, orderedQty]) => ({ productId, orderedQty, unitCost: { minor: 1, currency: 'INR' } })),
  totalMinor: 1, currency: 'INR', status, approvedBy: null, issuedAt: null, receivedByProduct: {}, cancelledByProduct: {}, amendmentCount: 0,
} as StoredPurchaseOrder);
const routes = (): Route[] => Object.values(RECALL_GUARDED_ORDER_ROUTES).map((r) => ({ api: 'API-03', method: r.method, path: r.path, permission: 'purchase.order.propose', idempotent: true, handler: () => ({ status: 201, body: { reached: r.path } }) }));

describe('the recall ordering guard (services/purchase/src/recall-order-guard.ts)', () => {
  const deps = (stored: StoredPurchaseOrder | undefined, audits: unknown[]): RecallOrderGuardDeps => ({
    underRecall: async (_t, ids) => ids.filter((p) => p === 'bad').map((productId) => ({ productId, batchIds: ['B1'], because: 'open_batch_recall' as const, reason: 'r', since: null })),
    order: () => stored, recordAudit: (_t, e) => { audits.push(e); }, now: () => '2030-01-01T00:00:00Z',
  });
  const call = async (r: Route, c: RequestContext) => { try { return await r.handler(c); } catch (e) { if (e instanceof ApiError) return { status: e.status, body: e.body }; throw e; } };

  it('refuses a new order, an approval and a raising amendment naming a recalled product; lets a lower one and a replay through; audits each refusal', async () => {
    const audits: unknown[] = [];
    let guarded = withRecallOrderGuard(routes(), deps(undefined, audits));
    expect((await call(guarded[0]!, ctx({ poId: 'po' }, { lines: [{ productId: 'ok' }, { productId: 'bad' }] }))).status).toBe(409);
    expect((await call(guarded[0]!, ctx({ poId: 'po' }, { lines: [{ productId: 'ok' }] }))).status).toBe(201);
    guarded = withRecallOrderGuard(routes(), deps(po([['bad', 10]]), audits));
    expect((await call(guarded[0]!, ctx({ poId: 'po' }, { lines: [{ productId: 'bad' }] }))).status).toBe(201); // a replay
    expect((await call(guarded[1]!, ctx({ poId: 'po' }, {}))).status).toBe(409);
    guarded = withRecallOrderGuard(routes(), deps(po([['bad', 10]], 'issued'), audits));
    expect((await call(guarded[1]!, ctx({ poId: 'po' }, {}))).status).toBe(201); // already issued: the route answers
    expect((await call(guarded[2]!, ctx({ poId: 'po' }, { lines: [{ productId: 'bad', orderedQty: 11 }] }))).status).toBe(409);
    expect((await call(guarded[2]!, ctx({ poId: 'po' }, { lines: [{ productId: 'bad', orderedQty: 4 }] }))).status).toBe(201);
    expect(audits).toHaveLength(3);
    expect(audits[0]).toMatchObject({ action: 'purchase.order.refused_under_recall', objectId: 'po', after: { step: 'propose', products: 'bad', batches: 'B1' } });
  });

  it('throws when a route it guards is missing — never a guard that guards nothing', () => {
    expect(() => withRecallOrderGuard(routes().slice(1), deps(undefined, []))).toThrow(/cannot find POST \/v1\/purchase\/orders\/:poId/);
  });
});

// ── the wiring: every trace read is sealed, and fails closed ───────────────────────────────────────────────────────

describe('lane 2 recall wiring (services/api/src/lane2-recall-adapters.ts)', () => {
  it('counts the customers a reply names, including a D-26 chain row', () => {
    expect(customersNamedIn({ outbound: [{ customerId: 'a' }, { customerId: 'a' }, {}], rows: [{ hop: 'sale', to: 'b' }, { hop: 'sale', to: 'walk-in' }, { hop: 'transfer', to: 'S1' }], start: { customerRef: 'c' } })).toBe(3);
  });

  it('every audited trace read is on the real surface; a read whose seal cannot be written is not handed out (fail closed)', async () => {
    const surface = buildSurface({ signingKey: KEY, migrationTargetKind: 'rehearsal' });
    for (const t of AUDITED_TRACE_READS) expect(surface.some((r) => r.method === t.method && r.path === t.path), `${t.method} ${t.path}`).toBe(true);
    // The least surface the wiring needs (the order steps and the forward-trace reads it wraps), with an audit sink that refuses.
    const stub = (method: 'GET' | 'POST', path: string): Route => ({ api: 'API-04', method, path, permission: 'quality.lottrace.read', ...(method === 'POST' ? { idempotent: true } : {}), handler: () => ({ status: 200, body: { outbound: [{ customerId: 'c-9' }] } }) });
    const raw: Route[] = [
      ...routes(),
      stub('POST', '/v1/quality/lot-trace/export'), stub('GET', '/v1/quality/lot-trace/:batchId/sold'),
      stub('GET', '/v1/quality/lot-trace/:batchId/chain'), stub('POST', '/v1/quality/lot-trace/requests/:requestId/answer'),
    ];
    lane2RecallSurface(raw, { store: undefined, now: () => '2030-01-01T00:00:00Z', signer, recordAudit: () => { throw new Error('disk full'); } });
    const sold = raw.find((r) => r.method === 'GET' && r.path === '/v1/quality/lot-trace/:batchId/sold')!;
    await expect(Promise.resolve(sold.handler(ctx({ batchId: 'B-1' }, undefined)))).rejects.toMatchObject({ status: 503, body: { code: 'trace_read_not_recorded', wasItSaved: 'not_saved' } });
    // With a sink that takes the record, the same read is answered and the record says who, what and how many customers.
    const kept: { actorId: string; objectId: string; after: Record<string, string> | null }[] = [];
    const ok: Route[] = [
      ...routes(),
      stub('POST', '/v1/quality/lot-trace/export'), stub('GET', '/v1/quality/lot-trace/:batchId/sold'),
      stub('GET', '/v1/quality/lot-trace/:batchId/chain'), stub('POST', '/v1/quality/lot-trace/requests/:requestId/answer'),
    ];
    lane2RecallSurface(ok, { store: undefined, now: () => '2030-01-01T00:00:00Z', signer, recordAudit: (_t, e) => { kept.push(e as never); } });
    const answered = await ok.find((r) => r.method === 'GET' && r.path === '/v1/quality/lot-trace/:batchId/sold')!.handler(ctx({ batchId: 'B-1' }, undefined));
    expect(answered.status).toBe(200);
    expect(kept).toEqual([expect.objectContaining({ actorId: 'u', objectId: 'batch:B-1', after: expect.objectContaining({ query: 'GET /v1/quality/lot-trace/B-1/sold', customersNamed: '1' }) })]);
  });

  it('refuses to start when a route it wraps is missing', () => {
    const surface = [...buildSurface({ signingKey: KEY, migrationTargetKind: 'rehearsal' })].filter((r) => r.path !== '/v1/quality/lot-trace/:batchId/chain');
    expect(() => lane2RecallSurface(surface, { store: undefined, now: () => 'x', signer, recordAudit: () => {} })).toThrow(/cannot find GET \/v1\/quality\/lot-trace\/:batchId\/chain/);
  });
});
