import { describe, it, expect } from 'vitest';
import {
  policyNumbersSection, indentChangesSection, dsdHeldSection, osaSection, traceRequestsSection, ingredientCostSection, binsSection,
  paiseOf, bpsOf, wholeOf, waitingReturnsOf, type W5Section, type W5Said, type Lang,
} from '../../apps/web-erp/src/w5-store-ops-sections';
import { facilitiesRecordsSection, lpRecordsSection, noReceiptReportSection } from '../../apps/web-erp/src/w5-facilities-lp-sections';
import { w5SectionsFor } from '../../apps/web-erp/src/w5-store-ops-browser-wiring';
import * as OPS from '../../apps/web-erp/src/w5-store-ops-sections';
import * as FAC from '../../apps/web-erp/src/w5-facilities-lp-sections';
import { viewerIdentity } from '../../apps/web-erp/src/browser-entry';

/**
 * **W5 · bundle 5 (store operations) — the sections that put head office's uncalled routes on their pages, as tested,
 * DOM-free models.** M13-FR-01/02/03 · M28-FR-01 · SP-2b · SP-7b (the owner's numbers on Settings: "not set" until set, never
 * a pre-filled figure, head office's own safe rule SAID); M09-FR-03 (indent reject / cancel / return); OB-141 (held DSD goods
 * decided by a second person); OB-147 (on-shelf availability: the owner's minimum, count tasks); M10-FR-03 (trace requests in
 * 24 hours); M11-FR-02 (an ingredient's production cost); M09-FR-01 (bins); M26-FR-01/02/04 (facilities records);
 * M15-FR-04 · M13 (rule feedback, sealed evidence, over-returns, the no-receipt report). Each action asks its own word; head
 * office's refusals are shown in its own words; a lost link is said.
 */

type Reply = { status: number; body: unknown };
function fakeHeadOffice(answers: Record<string, Reply | ((body: unknown) => Reply)>) {
  const calls: { method: string; path: string; body: unknown; key: string | null }[] = [];
  const fetch = (async (input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ method, path: input, body, key: headers['idempotency-key'] ?? null });
    const a = answers[`${method} ${input}`] ?? answers[`${method} ${input.split('?')[0]}`];
    if (a === undefined) return new Response(JSON.stringify({ error: { code: 'not_found', whatHappened: `no route ${input}` } }), { status: 404 });
    const r = typeof a === 'function' ? a(body) : a;
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}
const lost = (async () => { throw new Error('offline'); }) as unknown as typeof globalThis.fetch;
const ok = (body: unknown): Reply => ({ status: 200, body });
const refused = (whatHappened: string, status = 422): Reply => ({ status, body: { error: { code: 'x', whatHappened } } });
const action = (s: W5Section | null, id: string) => { const a = s?.actions.find((x) => x.id === id); if (a === undefined) throw new Error(`no action ${id}`); return a; };
const text = (s: W5Said, lang: Lang = 'en') => [s.text(lang), ...(s.lines ?? []).map((l) => l.text(lang))].join(' | ');
const ids = (s: W5Section | null) => (s === null ? [] : s.actions.map((a) => a.id));
const OWNER_POLICY = ['pos.return.record', 'waste.view', 'inventory.count.policy.read', 'purchase.commitment.read', 'pos.return.window.set', 'pos.return.threshold.set', 'pos.storecredit.cap.set', 'pos.return.noreceipt.cap.set', 'inventory.writeoff.threshold.set', 'inventory.count.policy.set', 'purchase.match.policy.set'];

describe('what a person types (W5)', () => {
  it('reads rupees, percentages and whole numbers exactly — never a guess', () => {
    expect(paiseOf('500')).toBe(50_000); expect(paiseOf('₹1,499.5')).toBe(149_950); expect(paiseOf('0')).toBe(0);
    expect(paiseOf('')).toBeUndefined(); expect(paiseOf('12.345')).toBeUndefined(); expect(paiseOf('-5')).toBeUndefined(); expect(paiseOf('five')).toBeUndefined();
    expect(bpsOf('1')).toBe(100); expect(bpsOf('0.5%')).toBe(50); expect(bpsOf('100')).toBe(10_000); expect(bpsOf('100.01')).toBeUndefined(); expect(bpsOf('')).toBeUndefined();
    expect(wholeOf('7')).toBe(7); expect(wholeOf('7.5')).toBeUndefined(); expect(wholeOf(' ')).toBeUndefined();
  });
});

describe('Settings — the owner\'s shop policy numbers (M13-FR-01/02/03 · M28-FR-01 · SP-2b · SP-7b)', () => {
  const unsetAnswers = {
    'GET /v1/pos/return-window': ok({ returnWindowDays: null, isSet: false }),
    'GET /v1/pos/refund-threshold': ok({ thresholdMinor: 0, isDefault: true }),
    'GET /v1/pos/store-credit-cap': ok({ capMinor: null, isSet: false }),
    'GET /v1/pos/no-receipt-cap': ok({ capMinor: null, isSet: false }),
    'GET /v1/inventory/write-off-threshold': ok({ thresholdMinor: 50_000, isDefault: true }),
    'GET /v1/inventory/count-policy': ok({ policy: null, defaultApprovalThresholdMinor: 100_000, inForceMinor: 100_000 }),
    'GET /v1/purchase/match-policy': ok({ policy: null, defaultPolicy: { quantityToleranceBps: 0, priceToleranceBps: 100, immaterialMinor: 100 }, inForce: { quantityToleranceBps: 0, priceToleranceBps: 100, immaterialMinor: 100 } }),
  };

  it('a number the owner never set reads NOT SET — and head office\'s own safe rule is said, never hidden; no field is pre-filled', async () => {
    const ho = fakeHeadOffice(unsetAnswers);
    const s = policyNumbersSection({ viewer: { userId: 'u-owner', permissions: OWNER_POLICY }, fetch: ho.fetch });
    expect(ids(s)).toEqual(['read', 'set-return-window', 'set-refund-threshold', 'set-store-credit-cap', 'set-no-receipt-cap', 'set-write-off-threshold', 'set-count-policy', 'set-match-policy']);
    for (const a of s!.actions) for (const f of a.fields) expect(f.initial).toBeUndefined();
    const said = await action(s, 'read').run({});
    expect(said.lines?.map((l) => [l.key, l.tone])).toEqual([
      ['return-window', 'warn'], ['refund-threshold', 'warn'], ['store-credit-cap', 'warn'], ['no-receipt-cap', 'warn'], ['write-off-threshold', 'warn'], ['count-policy', 'warn'], ['match-policy', 'warn'],
    ]);
    const t = text(said);
    expect(t).toContain('Return window: Not set by the owner — returns are not limited by age until it is set.');
    // OB-686: the kept safety limits say they are built-in and not the owner's — one wording.
    expect(t).toContain('Refund approval threshold: Every refund needs a manager\'s approval — built-in, not yet set by the owner.');
    expect(t).toContain('Store-credit cap: Not set by the owner — store credit cannot be given until it is set.');
    expect(t).toContain('No-receipt return cap: Not set by the owner — returns without a bill are switched off until it is set.');
    expect(t).toContain('Write-off threshold: ₹500.00 — built-in, not yet set by the owner.');
    expect(t).toContain('Count approval threshold: ₹1,000.00 — built-in, not yet set by the owner.');
    expect(t).toContain('Supplier bill match tolerances: quantity 0% · price 1% · differences under ₹1.00 are ignored — built-in, not yet set by the owner.');
    expect(t.match(/built-in, not yet set by the owner/g)).toHaveLength(4);
    expect(text(said, 'ta')).toContain('உரிமையாளர் அமைக்கவில்லை');
    expect(text(said, 'ta').match(/உள்ளமைந்தது, உரிமையாளர் இன்னும் அமைக்கவில்லை/g)).toHaveLength(4);
    expect(ho.calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('the owner sets each number in rupees, days or percent; head office gets paise and basis points; the list is read again', async () => {
    const ho = fakeHeadOffice({
      ...unsetAnswers,
      'POST /v1/pos/return-window': ok({ returnWindowDays: 7 }), 'POST /v1/pos/refund-threshold': ok({}), 'POST /v1/pos/store-credit-cap': ok({}),
      'POST /v1/pos/no-receipt-cap': ok({}), 'POST /v1/inventory/write-off-threshold': ok({}), 'POST /v1/inventory/count-policy': { status: 201, body: {} },
      'POST /v1/purchase/match-policy': { status: 201, body: {} },
    });
    const s = policyNumbersSection({ viewer: { userId: 'u-owner', permissions: OWNER_POLICY }, fetch: ho.fetch });
    expect((await action(s, 'set-return-window').run({ days: '7' })).tone).toBe('ok');
    await action(s, 'set-refund-threshold').run({ amount: '2000' });
    await action(s, 'set-store-credit-cap').run({ amount: '1500.50' });
    await action(s, 'set-no-receipt-cap').run({ amount: '0' });
    await action(s, 'set-write-off-threshold').run({ amount: '750' });
    await action(s, 'set-count-policy').run({ amount: '1200' });
    await action(s, 'set-match-policy').run({ qty: '0', price: '1.5', small: '2' });
    expect(ho.calls.filter((c) => c.method === 'POST').map((c) => [c.path, c.body])).toEqual([
      ['/v1/pos/return-window', { returnWindowDays: 7 }], ['/v1/pos/refund-threshold', { thresholdMinor: 200_000 }], ['/v1/pos/store-credit-cap', { capMinor: 150_050 }],
      ['/v1/pos/no-receipt-cap', { capMinor: 0 }], ['/v1/inventory/write-off-threshold', { thresholdMinor: 75_000 }], ['/v1/inventory/count-policy', { approvalThresholdMinor: 120_000 }],
      ['/v1/purchase/match-policy', { quantityToleranceBps: 0, priceToleranceBps: 150, immaterialMinor: 200 }],
    ]);
    expect(ho.calls.filter((c) => c.method === 'POST').every((c) => c.key !== null)).toBe(true);
    expect(action(s, 'set-count-policy').refresh).toEqual(['read']);
    // a set number reads as set
    const set = fakeHeadOffice({ ...unsetAnswers, 'GET /v1/pos/no-receipt-cap': ok({ capMinor: 0, isSet: true }), 'GET /v1/inventory/count-policy': ok({ policy: { approvalThresholdMinor: 120_000, setBy: 'u-owner', setAt: '2026-11-03T05:00:00.000Z' }, inForceMinor: 120_000 }) });
    const t = text(await action(policyNumbersSection({ viewer: { userId: 'u-owner', permissions: OWNER_POLICY }, fetch: set.fetch }), 'read').run({}));
    expect(t).toContain('No-receipt return cap: ₹0 — returns without a bill are switched off.');
    expect(t).toContain('Count approval threshold: ₹1,200.00 — a count difference worth this or more needs a second person. (set by u-owner on 2026-11-03 10:30)');
  });

  it('nothing typed wrong is sent; head office\'s refusal and a lost link are said', async () => {
    const ho = fakeHeadOffice({ 'POST /v1/pos/refund-threshold': refused('Only the owner sets this.', 403) });
    const s = policyNumbersSection({ viewer: { userId: 'u-owner', permissions: OWNER_POLICY }, fetch: ho.fetch });
    expect(text(await action(s, 'set-refund-threshold').run({ amount: 'lots' }))).toBe('Type an amount in rupees, like 500 or 499.50.');
    expect(text(await action(s, 'set-match-policy').run({ qty: '200', price: '1', small: '1' }))).toMatch(/percentage from 0 to 100/);
    expect(ho.calls).toEqual([]);
    expect(text(await action(s, 'set-refund-threshold').run({ amount: '10' }))).toBe('Head office refused: Only the owner sets this.');
    const off = policyNumbersSection({ viewer: { userId: 'u-owner', permissions: OWNER_POLICY }, fetch: lost });
    expect(text(await action(off, 'set-return-window').run({ days: '3' }))).toMatch(/cannot be reached — nothing was read or changed/);
  });

  it('a manager who may only read sees the numbers and no setter; nobody signed in sees nothing', () => {
    expect(ids(policyNumbersSection({ viewer: { userId: 'u-mgr', permissions: ['pos.return.record', 'waste.view'] } }))).toEqual(['read']);
    expect(policyNumbersSection({ viewer: { permissions: OWNER_POLICY } })).toBeNull();
    expect(policyNumbersSection({ viewer: { userId: 'u-x', permissions: ['platform.setup.read'] } })).toBeNull();
  });
});

describe('Indents — reject, cancel, send back (M09-FR-03 · §28)', () => {
  const register = { indents: [{ indentId: 'ind-1', returns: [{ returnId: 'ret-a', state: 'requested', returnedBy: 'u-floor', reason: 'overstock', lines: [{ productId: 'RICE', batchId: null, quantityMinor: 2000 }] }, { returnId: 'ret-b', state: 'accepted', returnedBy: 'u-floor', reason: 'x', lines: [] }] }] };

  it('lists the returns waiting at the back store — and says they are counted in on the handheld', async () => {
    expect(waitingReturnsOf(register).map((r) => r.returnId)).toEqual(['ret-a']);
    const ho = fakeHeadOffice({ 'GET /v1/floor/indents': ok(register) });
    const s = indentChangesSection({ viewer: { userId: 'u-mgr', permissions: ['inventory.indent.read'] }, products: [{ productId: 'RICE', uom: 'kg' }], fetch: ho.fetch });
    expect(ids(s)).toEqual(['waiting']);
    const said = await action(s, 'waiting').run({});
    expect(text(said)).toBe(' | ind-1 · return ret-a — 2.000 kg × RICE — sent back by u-floor: overstock');
    expect(ho.calls[0]!.path).toBe('/v1/floor/indents?open=true');
    expect(s!.lead('en')).toMatch(/warehouse handheld/);
  });

  it('rejects with a reason, cancels the rest, and sends stock back in the item\'s own unit', async () => {
    const ho = fakeHeadOffice({
      'POST /v1/floor/indents/ind-1/rejection': ok({ alreadyRejected: false }), 'POST /v1/floor/indents/ind-2/cancel': ok({ alreadyCancelled: true }),
      'POST /v1/floor/indents/ind-3/returns/ret-1': { status: 201, body: {} },
    });
    const s = indentChangesSection({ viewer: { userId: 'u-mgr', permissions: ['inventory.indent.approve', 'inventory.indent.request'] }, products: [{ productId: 'RICE', uom: 'kg' }, { productId: 'SOAP', uom: 'ea' }], fetch: ho.fetch, ids: () => '1' });
    expect(text(await action(s, 'reject').run({ indent: 'ind-1', reason: '' }))).toMatch(/Fill in every box/);
    expect(text(await action(s, 'reject').run({ indent: 'ind-1', reason: 'not needed' }))).toBe('Indent ind-1 is rejected. Nothing moved.');
    expect(text(await action(s, 'cancel').run({ indent: 'ind-2', reason: 'shelf full' }))).toBe('The rest of indent ind-2 was already cancelled.');
    expect(text(await action(s, 'return').run({ indent: 'ind-3', product: 'NOPE', qty: '1', reason: 'x' }))).toBe('That product is not one this store sells.');
    expect(text(await action(s, 'return').run({ indent: 'ind-3', product: 'RICE', qty: '1.5', batch: 'B7', reason: 'wrong item' }))).toMatch(/Return ret-1 on indent ind-3 is recorded\. The back store counts it in on the warehouse handheld\./);
    expect(ho.calls.map((c) => [c.path, c.body])).toEqual([
      ['/v1/floor/indents/ind-1/rejection', { reason: 'not needed' }], ['/v1/floor/indents/ind-2/cancel', { reason: 'shelf full' }],
      ['/v1/floor/indents/ind-3/returns/ret-1', { lines: [{ productId: 'RICE', batchId: 'B7', quantityMinor: 1500 }], reason: 'wrong item' }],
    ]);
  });

  it('each change asks its own word: a floor person may cancel and send back but not reject', () => {
    expect(ids(indentChangesSection({ viewer: { userId: 'u-floor', permissions: ['inventory.indent.request'] } }))).toEqual(['cancel', 'return']);
    expect(indentChangesSection({ viewer: { userId: 'u-x', permissions: [] } })).toBeNull();
  });
});

describe('Goods receipt — goods a direct delivery held (OB-141 · §28)', () => {
  it('lists only check-ins holding goods for a decision, marks the viewer\'s own, and passes the decision with its reason', async () => {
    const ho = fakeHeadOffice({
      'GET /v1/inventory/dsd-checkins': ok({ checkIns: [
        { checkInId: 'dsd-1', supplierId: 'sup-milk', receivedBy: 'u-recv', held: { state: 'pending', lines: [{ productId: 'MILK', quantityMinor: 6 }] } },
        { checkInId: 'dsd-2', supplierId: 'sup-milk', receivedBy: 'u-mgr', held: { state: 'pending', lines: [{ productId: 'CURD', quantityMinor: 2 }] } },
        { checkInId: 'dsd-3', supplierId: 'sup-milk', receivedBy: 'u-recv', held: { state: 'none', lines: [] } },
      ] }),
      'POST /v1/inventory/dsd-checkins/dsd-1/held/decide': ok({ checkIn: {} }),
      'POST /v1/inventory/dsd-checkins/dsd-2/held/decide': refused('u-mgr received this delivery and cannot approve keeping goods beyond the order (§28).'),
    });
    const s = dsdHeldSection({ viewer: { userId: 'u-mgr', permissions: ['inventory.adjustment.approve', 'inventory.availability.read'] }, fetch: ho.fetch });
    const list = await action(s, 'held').run({});
    expect(list.lines?.map((l) => l.key)).toEqual(['dsd-1', 'dsd-2']);
    expect(text(list)).toContain('dsd-2 · sup-milk · received by u-mgr — 2 × CURD (you received it — another person decides)');
    expect(text(await action(s, 'decide').run({ checkIn: 'dsd-1', decision: 'approved', reason: 'we sell it' }))).toBe('Kept: the held goods on dsd-1 are in stock now.');
    expect(text(await action(s, 'decide').run({ checkIn: 'dsd-2', decision: 'rejected', reason: 'no' }))).toMatch(/^Head office refused: u-mgr received this delivery/);
    expect(ho.calls[1]!.body).toEqual({ decision: 'approved', reason: 'we sell it' });
    expect(dsdHeldSection({ viewer: { userId: 'u-recv', permissions: ['inventory.availability.read'] } })).toBeNull();
  });
});

describe('Stock health — on-shelf availability (OB-147)', () => {
  it('says so when the owner has not set the minimum, and judges nothing', async () => {
    const ho = fakeHeadOffice({ 'GET /v1/inventory/on-shelf-availability': ok({ state: 'minimum_not_set', detail: 'x', suspects: [] }) });
    const s = osaSection({ viewer: { userId: 'u-mgr', permissions: ['inventory.availability.read'] }, fetch: ho.fetch });
    const said = await action(s, 'suspects').run({});
    expect(said.tone).toBe('warn');
    expect(text(said)).toBe('The owner has not set the minimum days yet — nothing is judged until he does.');
  });

  it('raises a count on head office\'s own proposed task id, records the count, and a difference is a REQUEST — stock untouched', async () => {
    const ho = fakeHeadOffice({
      'GET /v1/inventory/on-shelf-availability': ok({ state: 'judged', minimum: { minimumDays: 7 }, suspects: [{ productId: 'OIL', locationId: 'store-1', onHandMinor: 12, daysWithoutSale: 20, thresholdDays: 7, proposedCountTask: { taskId: 'osa-store-1-OIL-2026-11-03' }, openCountTask: null }] }),
      'POST /v1/inventory/on-shelf-availability/count-tasks/osa-store-1-OIL-2026-11-03': { status: 201, body: { task: {} } },
      'POST /v1/inventory/on-shelf-availability/count-tasks/osa-store-1-OIL-2026-11-03/count': ok({ task: {}, adjustmentRequest: { requestId: 'adj-osa-1' } }),
      'POST /v1/inventory/on-shelf-availability/minimum': ok({}),
      'GET /v1/inventory/on-shelf-availability/count-tasks': ok({ tasks: [{ taskId: 'osa-store-1-OIL-2026-11-03', productId: 'OIL', locationId: 'store-1', state: 'adjustment_requested', countedMinor: 4, expectedMinor: 12, adjustmentRequestId: 'adj-osa-1', adjustmentStatus: 'pending' }] }),
    });
    const s = osaSection({ viewer: { userId: 'u-mgr', permissions: ['inventory.availability.read', 'inventory.osa.task.raise', 'inventory.osa.count.record', 'inventory.osa.configure'] }, storeId: 'store-1', fetch: ho.fetch });
    expect(action(s, 'raise').fields.find((f) => f.key === 'place')?.initial).toBe('store-1');
    expect(action(s, 'minimum').fields[0]!.initial).toBeUndefined();
    const sus = await action(s, 'suspects').run({});
    expect(text(sus)).toContain('Owner\'s minimum: 7 day(s). | OIL at store-1 — 12 on the books, no sale for 20 day(s) (expected within 7)');
    expect(text(await action(s, 'raise').run({ product: 'OIL', place: 'store-1' }))).toBe('Count task osa-store-1-OIL-2026-11-03 is raised for OIL.');
    const counted = await action(s, 'count').run({ task: 'osa-store-1-OIL-2026-11-03', counted: '4', reasonCode: 'theft_suspected', note: '' });
    expect(text(counted)).toBe('Counted. The difference is adjustment request adj-osa-1, waiting for a second person to decide. Stock has not changed.');
    expect(ho.calls.at(-1)!.body).toEqual({ countedMinor: 4, reasonCode: 'theft_suspected' });
    expect(text(await action(s, 'tasks').run({}))).toContain('counted 4, books 12: adjustment request adj-osa-1 (pending)');
    expect(text(await action(s, 'minimum').run({ days: 'seven' }))).toBe('Type a whole number.');
  });
});

describe('Recalls and trace — trace requests in 24 hours (M10-FR-03)', () => {
  it('lists requests with the overdue one in error tone, records a request and answers one with its fingerprint', async () => {
    const ho = fakeHeadOffice({
      'GET /v1/quality/lot-trace/requests': ok({ overdue: 1, detail: '1 trace request(s) were not answered within 24 hours.', requests: [
        { requestId: 'tr-1', batchId: 'B7', askedBy: 'FSSAI', reason: 'complaint', state: 'overdue', dueAt: '2026-11-02T05:00:00.000Z' },
        { requestId: 'tr-2', batchId: 'B8', askedBy: 'Supplier', reason: 'recall', state: 'answered', dueAt: '2026-11-04T05:00:00.000Z', answer: { answeredAt: '2026-11-03T06:00:00.000Z' } },
      ] }),
      'POST /v1/quality/lot-trace/requests/tr-9': { status: 201, body: { request: { dueAt: '2026-11-04T04:30:00.000Z' } } },
      'POST /v1/quality/lot-trace/requests/tr-1/answer': { status: 201, body: { answer: { rowCount: 3, gapCount: 1, csvSha256: 'abcdef0123456789abcd' } } },
    });
    const s = traceRequestsSection({ viewer: { userId: 'u-q', permissions: ['quality.lottrace.read', 'quality.lottrace.request'] }, fetch: ho.fetch, ids: () => '9' });
    const list = await action(s, 'requests').run({});
    expect(list.tone).toBe('error');
    expect(list.lines?.map((l) => [l.key, l.tone])).toEqual([['tr-1', 'error'], ['tr-2', 'ok']]);
    expect(text(list)).toContain('tr-1 · batch B7 — asked by FSSAI (complaint) — OVERDUE — was due 2026-11-02 10:30');
    expect(text(await action(s, 'ask').run({ batch: 'B9', askedBy: 'FSSAI', why: 'complaint' }))).toBe('Request tr-9 is recorded. Answer it by 2026-11-04 10:00.');
    expect(text(await action(s, 'answer').run({ request: 'tr-1' }))).toBe('Answered: 3 line(s) in the trace, 1 gap(s). Fingerprint abcdef012345.');
    expect(ho.calls[1]!.body).toEqual({ batchId: 'B9', askedBy: 'FSSAI', reason: 'complaint' });
    expect(ids(traceRequestsSection({ viewer: { userId: 'u-v', permissions: ['quality.lottrace.read'] } }))).toEqual(['requests']);
  });
});

describe('Production costs — an ingredient\'s cost (M11-FR-02) · Bins (M09-FR-01)', () => {
  it('registers a cost per smallest unit in paise, only for the person who manages recipes', async () => {
    const ho = fakeHeadOffice({ 'POST /v1/production/costs/YEAST': { status: 201, body: {} } });
    const s = ingredientCostSection({ viewer: { userId: 'u-mgr', permissions: ['production.recipe.manage'] }, fetch: ho.fetch });
    expect(text(await action(s, 'register').run({ product: 'YEAST', cost: '0.04' }))).toBe('YEAST is now costed at ₹0.04 per smallest unit for production.');
    expect(ho.calls[0]!.body).toEqual({ unitCostMinor: 4, currency: 'INR' });
    expect(ingredientCostSection({ viewer: { userId: 'u-acc', permissions: ['production.cost.read'] } })).toBeNull();
  });

  it('sets up a bin on the box\'s own store and reads what a bin holds', async () => {
    const ho = fakeHeadOffice({
      'POST /v1/warehouse/bins/A-01': { status: 201, body: {} },
      'GET /v1/warehouse/bins/A-01': ok({ binId: 'A-01', capacityMinor: 100, pickable: true, occupancyMinor: 30, held: [{ key: 'A-01|RICE|B7', quantityMinor: 30 }] }),
    });
    const s = binsSection({ viewer: { userId: 'u-sup', permissions: ['inventory.movement.append', 'inventory.availability.read'] }, storeId: 'store-1', fetch: ho.fetch });
    expect(text(await action(s, 'register').run({ bin: 'A-01', capacity: '100', pickable: 'yes', zone: 'chilled', place: '' }))).toBe('Bin A-01 is set up: capacity 100, pickable.');
    expect(ho.calls[0]!.body).toEqual({ storeId: 'store-1', capacityMinor: 100, pickable: true, zone: 'chilled' });
    expect(text(await action(s, 'holds').run({ bin: 'A-01' }))).toBe('Bin A-01: 30 of 100 used — pickable | RICE · B7: 30');
    expect(ids(binsSection({ viewer: { userId: 'u-sup', permissions: ['inventory.movement.append', 'inventory.availability.read'] } }))).toEqual(['holds']);
  });
});

describe('Facilities set-up — breakdowns, energy, power, contents (M26-FR-01/02/04)', () => {
  const FAC = ['facilities.asset.read', 'facilities.asset.manage', 'facilities.reading.record'];
  it('a typed time is the SHOP\'s clock; downtime is measured from the failure; an estimate is said to be one', async () => {
    const ho = fakeHeadOffice({
      'POST /v1/facilities/assets/CHILLER-1/downtime/down-1': { status: 201, body: { stillDown: true } },
      'GET /v1/facilities/assets/downtime': ok({ summaries: [{ assetId: 'CHILLER-1', name: 'Dairy chiller', events: 1, totalMinutes: 300, unreportedMinutes: 240, stillDown: true }] }),
      'POST /v1/facilities/energy/kwh-1': { status: 201, body: {} },
      'GET /v1/facilities/energy': ok({ kilowattHours: 120, costMinor: 96_000, estimatedShareBps: 2500 }),
      'POST /v1/facilities/power/pwr-1': { status: 201, body: {} },
      'GET /v1/facilities/power': ok({ unprotectedMinutes: 47, assetsAtRisk: ['Dairy chiller'], severity: 'unprotected', detail: 'Dairy chiller has had no power for 47 minutes' }),
      'POST /v1/facilities/equipment/CHILLER-1/contents': { status: 201, body: { batches: 2, valueMinor: 150_000 } },
      'GET /v1/facilities/assets/health': ok({ critical: [{ assetId: 'CHILLER-1', name: 'Dairy chiller', kind: 'amc_expired', detail: 'Dairy chiller\'s maintenance contract expired 3 day(s) ago' }], other: [], detail: 'x' }),
    });
    const s = facilitiesRecordsSection({ viewer: { userId: 'u-fac', permissions: FAC }, storeId: 'store-1', fetch: ho.fetch, ids: () => '1', now: () => '2026-11-03T19:00:00.000Z', timeZone: 'Asia/Kolkata' });
    expect(ids(s)).toEqual(['health', 'downtime', 'record-downtime', 'energy', 'energy-report', 'power', 'power-report', 'contents']);
    // 19:00 UTC is 00:30 the NEXT day at the shop — the day field starts on the shop's day, never the UTC date
    expect(action(s, 'health').fields[0]!.initial).toBe('2026-11-04');
    expect(text(await action(s, 'record-downtime').run({ asset: 'CHILLER-1', failedAt: '2026-11-03T06:00', reportedAt: '2026-11-03T10:00', restoredAt: '', cause: '' }))).toBe('Breakdown down-1 recorded — the equipment is still down.');
    expect(ho.calls[0]!.body).toEqual({ failedAt: '2026-11-03T00:30:00.000Z', reportedAt: '2026-11-03T04:30:00.000Z' });
    expect(text(await action(s, 'downtime').run({}))).toBe(' | Dairy chiller: 300 minute(s) down over 1 breakdown(s) — STILL DOWN — 240 minute(s) before anyone reported it');
    expect(text(await action(s, 'energy').run({ onDate: '2026-11-03', kwh: '40', cost: '320', source: 'estimate', asset: '' }))).toBe('Reading kwh-1 recorded (Estimated).');
    expect(ho.calls.at(-1)!.body).toEqual({ branchId: 'store-1', onDate: '2026-11-03', kilowattHours: 40, costMinor: 32_000, source: 'estimate' });
    const report = await action(s, 'energy-report').run({ from: '2026-10-04', to: '2026-11-03' });
    expect([report.tone, text(report)]).toEqual(['warn', '120 kWh costing ₹960.00 — 25.0% of the cost estimated, not metered']);
    expect(text(await action(s, 'power').run({ kind: 'dg_failed_to_start', at: '2026-11-03T21:15', note: '' }))).toBe('Power event pwr-1 recorded: Generator FAILED to start.');
    expect(ho.calls.at(-1)!.body).toEqual({ branchId: 'store-1', kind: 'dg_failed_to_start', at: '2026-11-03T15:45:00.000Z' });
    const power = await action(s, 'power-report').run({});
    expect([power.tone, text(power)]).toEqual(['error', '47 minute(s) with no power and nothing behind it. Dairy chiller has had no power for 47 minutes | Lost power with no backup behind: Dairy chiller']);
    expect(text(await action(s, 'contents').run({ room: 'CHILLER-1', lines: 'B1, MILK-1L, 1200\nB2, CURD, 300' }))).toBe('CHILLER-1 holds 2 batch(es) worth ₹1,500.00 — a temperature breach would hold them.');
    expect(ho.calls.at(-1)!.body).toEqual({ contents: [{ batchId: 'B1', productId: 'MILK-1L', valueMinor: 120_000 }, { batchId: 'B2', productId: 'CURD', valueMinor: 30_000 }] });
    expect(text(await action(s, 'contents').run({ room: 'CHILLER-1', lines: 'B1 MILK' }))).toBe('Line 1 is not "batch, product, value in ₹".');
    const health = await action(s, 'health').run({ day: '2026-11-03' });
    expect([health.tone, text(health)]).toEqual(['error', 'x | Critical: Dairy chiller (CHILLER-1) — MAINTENANCE CONTRACT EXPIRED — Dairy chiller\'s maintenance contract expired 3 day(s) ago']);
    expect(text(health, 'ta')).toContain('முக்கியம்');
  });

  it('no store, no records; a reader gets only the reports', () => {
    expect(facilitiesRecordsSection({ viewer: { userId: 'u-fac', permissions: FAC } })).toBeNull();
    expect(ids(facilitiesRecordsSection({ viewer: { userId: 'u-r', permissions: ['facilities.asset.read'] }, storeId: 'store-1' }))).toEqual(['health', 'downtime', 'energy-report', 'power-report']);
  });
});

describe('Loss prevention and Return governance (M15-FR-04 · M13-FR-01 · M13)', () => {
  it('shows the rule feedback, seals evidence with its chain of custody, and names an over-returned bill', async () => {
    const ho = fakeHeadOffice({
      'GET /v1/loss-prevention/rule-feedback': ok({ adjustments: [{ ruleRef: 'void_burst', action: 'retire', detail: '5 cases, every one unfounded' }] }),
      'POST /v1/loss-prevention/cases/case-1/evidence/ev-1': { status: 201, body: { items: 2, seal: 'f00dfeed1234abcd' } },
      'GET /v1/sales/s-1/over-returns': ok({ overReturned: [{ productId: 'TV', soldMinor: 1, returnedMinor: 2 }] }),
      'GET /v1/sales/s-2/over-returns': ok({ overReturned: [] }),
    });
    const s = lpRecordsSection({ viewer: { userId: 'u-lp', permissions: ['lp.case.read', 'lp.case.manage'] }, fetch: ho.fetch, ids: () => '1' });
    expect(text(await action(s, 'feedback').run({}))).toBe(' | void_burst: RETIRE — 5 cases, every one unfounded');
    const ev = action(s, 'evidence');
    expect(ev.fields.find((f) => f.key === 'collectedBy')?.initial).toBe('u-lp');
    expect(ev.fields.find((f) => f.key === 'kind')?.options?.map((o) => o.value)).not.toContain('cctv_reference');
    expect(text(await ev.run({ case: 'case-1', kind: 'witness_statement', ref: 'stmt-4', description: 'saw the void', collectedBy: 'u-lp', collectedFrom: 'counter 2' }))).toBe('Sealed onto case case-1 as item 2 — seal f00dfeed1234. It can never be edited or removed.');
    expect(ho.calls[1]!.body).toEqual({ kind: 'witness_statement', ref: 'stmt-4', description: 'saw the void', collectedBy: 'u-lp', collectedFrom: 'counter 2' });
    const over = await action(s, 'over-returns').run({ sale: 's-1' });
    expect([over.tone, text(over)]).toEqual(['error', ' | TV: 2 came back, 1 were sold — 1 too many']);
    expect(text(await action(s, 'over-returns').run({ sale: 's-2' }))).toBe('Nothing on bill s-2 came back more than once.');
  });

  it('the no-receipt report says the money, who gave and who approved, and marks a breach', async () => {
    const ho = fakeHeadOffice({ 'GET /v1/pos/no-receipt-returns': ok({
      count: 2, totalRefundedMinor: 45_000, flaggedCount: 1, byProcessor: [{ userId: 'u-cash', count: 2, refundedMinor: 45_000 }],
      returns: [
        { returnId: 'nr-2', processedAt: '2026-11-03T05:00:00.000Z', processedBy: 'u-cash', approvedBy: 'u-mgr', refundMinor: 40_000, lines: [{ productId: 'FAN' }], governanceFlags: ['over_no_receipt_cap'] },
        { returnId: 'nr-1', processedAt: '2026-11-02T05:00:00.000Z', processedBy: 'u-cash', refundMinor: 5_000, lines: [{ productId: 'SOAP' }], governanceFlags: [] },
      ],
    }) });
    const s = noReceiptReportSection({ viewer: { userId: 'u-lp', permissions: ['lp.case.read'] }, fetch: ho.fetch });
    const r = await action(s, 'report').run({});
    expect(r.tone).toBe('error');
    expect(text(r)).toBe('2 return(s) without a bill, ₹450.00 refunded; 1 marked against a rule. | Given by u-cash: 2 return(s), ₹450.00 | 2026-11-03 10:30 · FAN · ₹400.00 · given by u-cash, approved by u-mgr — MARKED: over_no_receipt_cap | 2026-11-02 10:30 · SOAP · ₹50.00 · given by u-cash, approved by (nobody)');
    expect(noReceiptReportSection({ viewer: { userId: 'u-cash', permissions: ['pos.return.record'] } })).toBeNull();
  });
});

describe('the wiring — each page gets ITS sections from the global its server injected', () => {
  it('reads who is looking and the store from the page\'s own global; a page with no global gets none', () => {
    const win: Record<string, unknown> = {
      settingsData: { userId: 'u-owner', permissions: OWNER_POLICY },
      facilitiesSetupData: { userId: 'u-owner', permissions: ['facilities.asset.read'], storeId: 'store-1' },
    };
    expect(w5SectionsFor(win, viewerIdentity).map((s) => s.id)).toEqual(['w5-policy', 'w5-facilities']);
    expect(w5SectionsFor({ warehouseSupervisorData: { userId: 'u', permissions: ['inventory.availability.read'], storeId: 'store-1' } }, viewerIdentity).map((s) => s.id)).toEqual(['w5-bins']);
    expect(w5SectionsFor({}, viewerIdentity)).toEqual([]);
  });
});

describe('every word has a Tamil twin (NFR-08)', () => {
  it('each section\'s word table has the same keys in English and Tamil, and no Tamil word is left in English', () => {
    const tables = Object.entries({ ...OPS, ...FAC }).filter(([k]) => k.endsWith('_COPY')) as [string, { en: Record<string, string>; ta: Record<string, string> }][];
    expect(tables.map(([k]) => k).sort()).toEqual(['BINS_COPY', 'DSD_HELD_COPY', 'FACILITIES_RECORDS_COPY', 'INDENT_CHANGES_COPY', 'INGREDIENT_COST_COPY', 'LP_RECORDS_COPY', 'NO_RECEIPT_REPORT_COPY', 'OSA_COPY', 'POLICY_COPY', 'TRACE_REQUESTS_COPY', 'W5_COMMON_COPY']);
    for (const [name, t] of tables) {
      expect(Object.keys(t.ta).sort(), name).toEqual(Object.keys(t.en).sort());
      for (const k of Object.keys(t.en)) if (/[a-z]{4,}/.test(t.en[k]!.replace(/\{\w+\}/g, '')) && !/^[A-Z0-9 ·—()₹%.,:/'"-]*$/.test(t.en[k]!)) expect(t.ta[k], `${name}.${k}`).not.toBe(t.en[k]);
    }
  });
});
