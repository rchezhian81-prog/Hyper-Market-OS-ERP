import { describe, it, expect } from 'vitest';
import {
  createPriceListSession, figuresFromPageData, priceListWords, priceListOutcomeWords, needsSecondPerson, entryWords, inForceWords, zonesOf, paiseOf, rupeesOf,
  PRICE_LIST_COPY, PRICE_LIST_COPY_KEYS, type PriceFiguresOf, type PriceListHttp,
} from '../../apps/web-erp/src/price-lists-session';
import type { ApprovalAsk, ApprovalRequestView, InboxRead } from '../../apps/web-erp/src/approvals-session';
import { actionDetails } from '../../services/identity/src/approval-requests';

// M05-FR-01 (re-audit 30 Oct 2026, lane-1) — the Price lists panel's model: a DATED price for one store, a zone, a channel
// or a customer, sent to head office's own route (`POST /v1/prices/list/:productId/entries/:entryId`) with the SAME MRP,
// cost and margin floor the "Change a price" tab sends — never typed, and nothing sent when one is missing (P-08); a price
// that needs a second person (below cost / floor, or more than the owner's set size, OB-291) is asked for under kind
// `price_list_entry` with EXACTLY the body that is then sent (head office's own fingerprint rule), and saved naming that
// approval; zones and the channel switches over their own routes, each behind the permission head office checks.

const ALL = ['catalogue.pack.read', 'price.change.propose', 'price.zone.manage', 'price.change.approve'];
const figures: PriceFiguresOf = (productId) => (productId === 'p-nomrp' ? { ok: false, missing: 'mrp' } : productId === 'p-nocost' ? { ok: false, missing: 'cost' } : { ok: true, mrpMinor: 120_00, costMinor: 80_00, marginFloorBps: 1_000 });

function fakeHttp(answers: Record<string, { status: number; body: unknown }> = {}) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const http: PriceListHttp = {
    get: async (path) => { calls.push({ method: 'GET', path }); return answers[`GET ${path.split('?')[0]}`] ?? { status: 200, body: {} }; },
    post: async (path, body) => { calls.push({ method: 'POST', path, body }); return answers[`POST ${path}`] ?? { status: 201, body: { approvedBy: null } }; },
  };
  return { http, calls };
}
let n = 0;
const ids = () => `id${++n}`;
const ENTRY = { productId: 'p-dal', scope: 'store', scopeRef: 'store-2', price: '99.50', from: '2026-11-10', to: '2026-11-30' };

describe('the Price lists panel model (M05-FR-01)', () => {
  it('sends a dated store entry with the page\'s MRP, cost and floor — the last day ends at 23:59:59 on the shop\'s clock', async () => {
    const { http, calls } = fakeHttp();
    const s = createPriceListSession({ permissions: ALL, timeZone: 'Asia/Kolkata' }, http, figures, {}, () => 'x1');
    const out = await s.setEntry(ENTRY);
    expect(out.kind).toBe('done');
    expect(calls).toEqual([{
      method: 'POST', path: '/v1/prices/list/p-dal/entries/ple-x1',
      body: { scope: 'store', scopeRef: 'store-2', priceMinor: 99_50, currency: 'INR', mrpMinor: 120_00, costMinor: 80_00, marginFloorBps: 1_000, effectiveFrom: '2026-11-10', effectiveTo: '2026-11-30T18:29:59.000Z' },
    }]);
  });

  it('sends nothing when a figure is missing, a field is unreadable, or the role may not', async () => {
    const { http, calls } = fakeHttp();
    const s = createPriceListSession({ permissions: ALL }, http, figures, {}, ids);
    expect(await s.setEntry({ ...ENTRY, productId: 'p-nomrp' })).toEqual({ kind: 'invalid', detail: 'mrp' });
    expect(await s.setEntry({ ...ENTRY, productId: 'p-nocost' })).toEqual({ kind: 'invalid', detail: 'cost' });
    expect(await s.setEntry({ ...ENTRY, price: 'ninety' })).toEqual({ kind: 'invalid', detail: '' });
    expect(await s.setEntry({ ...ENTRY, scope: 'region' })).toEqual({ kind: 'invalid', detail: '' });
    expect(await s.setEntry({ ...ENTRY, to: '2026-11-01' })).toEqual({ kind: 'invalid', detail: '' }); // ends before it starts
    const reader = createPriceListSession({ permissions: ['catalogue.pack.read'] }, http, figures, {}, ids);
    expect(reader.may).toEqual({ read: true, set: false, zones: false, approve: false });
    expect(await reader.setEntry(ENTRY)).toEqual({ kind: 'not_allowed', needs: 'price.change.propose' });
    expect(await reader.putStoreInZone('south', 'store-2')).toEqual({ kind: 'not_allowed', needs: 'price.zone.manage' });
    expect(await reader.askSwitch('zone', 'on', 'festival zones')).toEqual({ kind: 'not_allowed', needs: 'price.change.propose' });
    expect(await reader.approveSwitch('r1', 'ok')).toEqual({ kind: 'not_allowed', needs: 'price.change.approve' });
    expect(calls).toEqual([]);
    expect(priceListOutcomeWords('en', { kind: 'invalid', detail: 'mrp' }).text).toMatch(/^Nothing was sent — no MRP/);
  });

  it('shows head office\'s refusal in its own words and knows which refusals a second person answers', async () => {
    const refusal = { status: 422, body: { error: { code: 'price_change_needs_second_person', whatHappened: 'p-dal for store store-2 would move from ₹80.00 to ₹99.50 … (OB-291).', nextSafeAction: 'Ask for approval.' } } };
    const { http } = fakeHttp({ 'POST /v1/prices/list/p-dal/entries/ple-z': refusal });
    const s = createPriceListSession({ permissions: ALL }, http, figures, {}, () => 'z');
    const out = await s.setEntry(ENTRY);
    expect(needsSecondPerson(out)).toBe(true);
    expect(priceListOutcomeWords('en', out).text).toBe('Head office refused: p-dal for store store-2 would move from ₹80.00 to ₹99.50 … (OB-291). Ask for approval.');
    expect(needsSecondPerson({ kind: 'refused', status: 422, code: 'price_above_mrp', whatHappened: '', nextSafeAction: '' })).toBe(false);
    expect(needsSecondPerson({ kind: 'refused', status: 409, code: 'channel_pricing_switched_off', whatHappened: '', nextSafeAction: '' })).toBe(false);
    const lost = createPriceListSession({ permissions: ALL }, { get: async () => ({ status: 0, body: null }), post: async () => ({ status: 0, body: null }) }, figures);
    expect(priceListOutcomeWords('en', await lost.setEntry(ENTRY)).text).toMatch(/^Head office cannot be reached — nothing was saved\./);
  });

  it('asks for exactly the entry it then sends, under kind price_list_entry, and saves naming the caller\'s own approval', async () => {
    const asks: ApprovalAsk[] = [];
    const mine: ApprovalRequestView[] = [];
    const approvals = {
      askApproval: async (ask: ApprovalAsk) => {
        asks.push(ask);
        const request = { requestId: 'req-1', kind: ask.kind, subjectRef: ask.subjectRef, details: ask.details, valueMinor: ask.valueMinor, summary: ask.summary, reason: ask.reason, requestedBy: 'u-mgr', requestedAt: '2026-11-01T05:00:00Z', status: 'waiting' } as ApprovalRequestView;
        mine.push(request);
        return { result: 'asked' as const, request };
      },
      approvalInbox: async (): Promise<InboxRead> => ({ result: 'read', inbox: { waitingForMe: [], mine, asAt: null } }),
    };
    const { http, calls } = fakeHttp({ 'POST /v1/prices/list/p-dal/entries/ple-a1': { status: 201, body: { approvedBy: 'u-owner' } } });
    const s = createPriceListSession({ permissions: ['catalogue.pack.read', 'price.change.propose'] }, http, figures, approvals, () => 'a1');
    expect((await s.askEntryApproval('en', ENTRY, 'short')).kind).toBe('needs_why');
    const asked = await s.askEntryApproval('en', ENTRY, 'Pongal week price for the second store');
    expect(asked.kind).toBe('asked');
    expect(asks[0]).toMatchObject({ kind: 'price_list_entry', subjectRef: 'p-dal/ple-a1', valueMinor: 99_50, summary: 'Price of p-dal for store store-2 to ₹99.50 from 2026-11-10' });

    // Still waiting: nothing is sent.
    expect(await s.saveEntryWithApproval('en', ENTRY)).toEqual({ kind: 'waiting' });
    expect(calls).toEqual([]);
    // Approved by someone else: sent to the SAME entry id, naming the approval; the body is what was approved, by
    // head office's own fingerprint rule (actionDetails of the body plus the route's path ids).
    mine[0] = { ...mine[0]!, status: 'approved', decidedBy: 'u-owner' };
    expect(await s.saveEntryWithApproval('en', ENTRY)).toEqual({ kind: 'done', verdict: 'approved', approvedBy: 'u-owner' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe('/v1/prices/list/p-dal/entries/ple-a1');
    expect(calls[0]!.body).toMatchObject({ approvalId: 'req-1' });
    expect(actionDetails(calls[0]!.body, { productId: 'p-dal', entryId: 'ple-a1' })).toEqual(asks[0]!.details);
    // A different price is not what was approved.
    expect(await s.saveEntryWithApproval('en', { ...ENTRY, price: '98' })).toEqual({ kind: 'changed' });
    // Nobody asked for this product yet.
    expect(await s.saveEntryWithApproval('en', { ...ENTRY, productId: 'p-rice' })).toEqual({ kind: 'not_asked' });
  });

  it('reads the history, the price in force on a date (an empty list and no price are said, not errors), zones and switches', async () => {
    const { http, calls } = fakeHttp({
      'GET /v1/prices/list/p-dal/history': { status: 404, body: { error: { code: 'not_found', whatHappened: 'no list' } } },
      'GET /v1/prices/list/p-dal/resolve': { status: 404, body: { error: { code: 'not_found', whatHappened: 'none' } } },
    });
    const s = createPriceListSession({ permissions: ALL, timeZone: 'Asia/Kolkata' }, http, figures, {}, () => 'r1');
    expect(await s.history('p-dal')).toEqual({ kind: 'done', status: 200, body: { entries: [] } });
    expect(await s.inForce('p-dal', { on: '2026-11-12', storeId: 'store-2', channel: 'app' })).toEqual({ kind: 'done', status: 200, body: null });
    expect(calls[1]!.path).toBe('/v1/prices/list/p-dal/resolve?at=2026-11-12T06%3A30%3A00.000Z&storeId=store-2&channel=app');
    await s.zones(); await s.channelPricing(); await s.differences('store-2');
    await s.putStoreInZone('south', 'store-2');
    expect(await s.askSwitch('zone', 'on', '')).toEqual({ kind: 'invalid', detail: 'reason' });
    await s.askSwitch('channel:app', 'on', 'app-only festival prices');
    await s.approveSwitch('switch-r1', 'agreed with the owner');
    expect(calls.slice(2).map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /v1/prices/zones', 'GET /v1/prices/channel-pricing', 'GET /v1/prices/channel-differences?storeId=store-2',
      'POST /v1/prices/zones/south/stores/store-2',
      'POST /v1/prices/channel-pricing/requests/switch-r1', 'POST /v1/prices/channel-pricing/requests/switch-r1/approve',
    ]);
    expect(calls[6]!.body).toEqual({ subject: 'channel:app', to: 'on', reason: 'app-only festival prices' });
  });

  it('takes the MRP in force on the first day, the cost and the store\'s floor from the page — a missing one is never defaulted', () => {
    const data = {
      products: [{ productId: 'p-dal', mrpHistory: [{ effectiveFrom: '2026-01-01', value: { minor: 110_00 } }, { effectiveFrom: '2026-12-01', value: { minor: 130_00 } }] }],
      costsMinor: { 'p-dal': 80_00 }, marginFloorBps: 1_200,
    };
    expect(figuresFromPageData(data)('p-dal', '2026-11-10')).toEqual({ ok: true, mrpMinor: 110_00, costMinor: 80_00, marginFloorBps: 1_200 });
    expect(figuresFromPageData(data)('p-dal', '2026-12-01')).toMatchObject({ mrpMinor: 130_00 });
    expect(figuresFromPageData(data)('p-dal', '2025-12-31')).toEqual({ ok: false, missing: 'mrp' });
    expect(figuresFromPageData({ ...data, costsMinor: {} })('p-dal', '2026-11-10')).toEqual({ ok: false, missing: 'cost' });
    expect(figuresFromPageData({ products: data.products, costsMinor: data.costsMinor })('p-dal', '2026-11-10')).toEqual({ ok: false, missing: 'floor' });
  });

  it('says entries, the price in force and zones in plain words, in English and Tamil, with every word twinned', () => {
    expect(PRICE_LIST_COPY_KEYS.every((k) => PRICE_LIST_COPY.ta[k].trim() !== '' && PRICE_LIST_COPY.en[k].trim() !== '')).toBe(true);
    const e = { id: 'e1', productId: 'p-dal', scope: 'zone' as const, scopeRef: 'south', price: { minor: 95_00, currency: 'INR' }, effectiveFrom: '2026-11-10', effectiveTo: '2026-11-30T18:29:59.000Z', status: 'active', version: 2 };
    expect(entryWords('en', e, 'Asia/Kolkata')).toBe('₹95.00 for zone south, from 2026-11-10, until 2026-11-30 · version 2');
    expect(entryWords('ta', e, 'Asia/Kolkata')).toContain('மண்டலம் south');
    expect(inForceWords('en', { productId: 'p-dal', entryId: 'e1', version: 1, scope: 'store', scopeRef: 'store-2', priceMinor: 99_50, effectiveFrom: '2026-11-10', effectiveTo: null })).toBe('In force: ₹99.50 — the store price for store-2, from 2026-11-10.');
    expect(inForceWords('en', null)).toBe('No price is in force for this item there on that day.');
    expect(zonesOf([{ storeId: 'store-3', zoneId: 'south', setBy: 'u', setAt: 'x' }, { storeId: 'store-2', zoneId: 'south', setBy: 'u', setAt: 'x' }, { storeId: 'store-1', zoneId: 'city', setBy: 'u', setAt: 'x' }]))
      .toEqual([{ zoneId: 'city', storeIds: ['store-1'] }, { zoneId: 'south', storeIds: ['store-2', 'store-3'] }]);
    expect(paiseOf('₹1,234.5')).toBe(1_234_50);
    expect(paiseOf('12.345')).toBeUndefined();
    expect(rupeesOf(5)).toBe('₹0.05');
    expect(priceListWords('ta')('tab')).toBe('விலைப் பட்டியல்கள்');
  });
});
