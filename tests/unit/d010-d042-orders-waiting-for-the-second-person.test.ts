import { describe, it, expect } from 'vitest';
import { ordersWaitingToIssue, waitingOrderCounts, mayIssueOrders, ISSUE_ORDER_PERMISSION } from '../../packages/purchasing/src/orders-waiting-to-issue';
import { readLiveCounts, todayLiveFigures, TODAY_LIVE_WORDS } from '../../apps/web-erp/src/today-live-counts';
import { createOrdersToIssueSession, ORDERS_TO_ISSUE_WORDS, rupeesText } from '../../apps/web-erp/src/orders-to-issue-session';
import { readOwnerOrders } from '../../apps/owner-app/src/browser-entry';
import type { HeadOfficeCall } from '../../apps/web-erp/src/supplier-bills-session';

/**
 * **Fix batch 4a — D-010 and D-042: a purchase order waiting for its second person is counted and can be seen and issued
 * from Approvals (M06-FR-02 · M02-FR-03 · §28 · P-03 · P-08).**
 *
 * D-010: the manager raised an order; Today said "Approvals waiting 0" and the owner's page "Waiting for you (0)".
 * D-042: the order could be issued only from the Buying page's Budget tab, whose row named only codes and a total.
 *
 * Now every screen reads head office's order list the one way: the orders waiting, which of them THIS person may issue
 * (they hold `purchase.order.approve` and did not raise it), and each order's lines by item name, quantity, agreed price
 * and value. Issuing goes through the Budget tab's own path (`POST /v1/purchase/orders/:poId/approval`), with a reason.
 */

const ORDERS = {
  orders: [
    {
      poId: 'PO-A', number: 'PO-A', status: 'proposed', supplierId: 'sup-foods', requisitionedBy: 'u-manager', at: '2026-11-15T09:00:00Z', totalMinor: 266_400,
      lines: [
        { productId: 'prod-biscuit', orderedQty: 48, unitCost: { minor: 3_000, currency: 'INR' }, uom: 'ea' },
        { productId: 'prod-rice', orderedQty: 25_500, unitCost: { minor: 4_800, currency: 'INR' }, uom: 'kg' },
      ],
    },
    { poId: 'PO-B', number: 'PO-B', status: 'proposed', supplierId: 'sup-oil', requisitionedBy: 'u-owner', at: '2026-11-15T08:00:00Z', totalMinor: 10_000,
      lines: [{ productId: 'prod-oil', orderedQty: 2, unitCost: { minor: 5_000, currency: 'INR' } }] },
    { poId: 'PO-C', number: 'PO-C', status: 'proposed', supplierId: 'sup-oil', requisitionedBy: 'u-buyer', at: '2026-11-15T10:00:00Z', totalMinor: 90_000,
      budgetCheck: { overBudget: true, overByMinor: 5_000 }, lines: [{ productId: 'prod-oil', orderedQty: 18, unitCost: { minor: 5_000, currency: 'INR' } }] },
    { poId: 'PO-D', status: 'issued', supplierId: 'sup-oil', requisitionedBy: 'u-buyer', totalMinor: 1, lines: [] },
    null, 'junk',
  ],
};
const OWNER = { userId: 'u-owner', permissions: ['identity.self.read', ISSUE_ORDER_PERMISSION] };
const NAMES = { products: new Map([['prod-biscuit', 'Marie biscuits 200 g'], ['prod-rice', 'Ponni rice']]), suppliers: new Map([['sup-foods', 'Sri Foods']]) };

describe('the orders waiting for their second person, read one way for every screen', () => {
  it('lists every proposed order with its lines by name, quantity in its own unit, agreed price and value; unreadable rows are left out', () => {
    const list = ordersWaitingToIssue(ORDERS, OWNER, NAMES);
    // Over budget first among the ones this person may issue, then oldest; their own last.
    expect(list.map((o) => o.poId)).toEqual(['PO-C', 'PO-A', 'PO-B']);
    const a = list.find((o) => o.poId === 'PO-A')!;
    expect(a).toMatchObject({ supplierName: 'Sri Foods', raisedBy: 'u-manager', totalMinor: 266_400, raisedByViewer: false, overBudget: false });
    expect(a.lines).toEqual([
      { productId: 'prod-biscuit', name: 'Marie biscuits 200 g', quantity: '48', unitCostMinor: 3_000, per: 1, uom: 'ea', valueMinor: 144_000 },
      { productId: 'prod-rice', name: 'Ponni rice', quantity: '25.500 kg', unitCostMinor: 4_800, per: 1, uom: 'kg', valueMinor: 122_400 },
    ]);
    // A name nobody gave → the code, never a guess.
    expect(list.find((o) => o.poId === 'PO-B')!.lines[0]!.name).toBe('prod-oil');
    expect(list.find((o) => o.poId === 'PO-C')!.supplierName).toBe('sup-oil');
    expect(list.find((o) => o.poId === 'PO-B')!.raisedByViewer).toBe(true);
    expect(list.find((o) => o.poId === 'PO-C')!.overBudget).toBe(true);
    // A proposed row with no order number or no maker is not half-shown.
    expect(ordersWaitingToIssue({ orders: [{ status: 'proposed' }, { status: 'proposed', poId: 'PO-X' }] }, OWNER)).toEqual([]);
  });

  it('counts the orders waiting and those THIS person may issue — never one they raised, never without the permission', () => {
    expect(waitingOrderCounts(ORDERS, OWNER)).toEqual({ waiting: 3, forViewer: 2 });
    expect(waitingOrderCounts(ORDERS, { userId: 'u-manager', permissions: [ISSUE_ORDER_PERMISSION] })).toEqual({ waiting: 3, forViewer: 2 });
    expect(waitingOrderCounts(ORDERS, { userId: 'u-cashier', permissions: ['identity.self.read'] })).toEqual({ waiting: 3, forViewer: 0 });
    // Permissions not told → nothing is assumed.
    expect(mayIssueOrders({ userId: 'u-owner', permissions: null })).toBe(false);
    expect(waitingOrderCounts(ORDERS, { userId: 'u-owner' })).toEqual({ waiting: 3, forViewer: 0 });
  });
});

describe('D-010: Today counts the orders waiting for their second person', () => {
  const BOX = {
    approvalsWaiting: { known: true as const, count: 0 },
    approvalsIcanClear: { known: true as const, count: 0 },
    purchaseOrdersOpen: { known: true as const, value: 0 },
  };
  const reply = (status: number, body: unknown): Response => ({ status, json: async () => body }) as unknown as Response;
  const headOffice = (async (url: string) => (url === '/v1/purchase/orders' ? reply(200, ORDERS)
    : url === '/v1/approvals/requests' ? reply(200, { waitingForMe: [], mine: [], routedToOwnerAboveYourLimit: 0 }) : reply(200, { overShort: [] }))) as unknown as typeof fetch;

  it('the walkthrough\'s "Approvals waiting 0" now counts the waiting orders, and the owner may clear the two they did not raise', async () => {
    const live = await readLiveCounts(headOffice, OWNER);
    expect(live.purchaseOrders).toEqual({ result: 'read', value: { open: 3, awaitingApproval: 3, forViewer: 2 } });
    const f = todayLiveFigures(BOX, live, 'en');
    expect(f.approvalsWaiting).toMatchObject({ known: true, count: 3 });
    expect(f.approvalsWaiting.note).toContain(`3 ${TODAY_LIVE_WORDS.en.ordersToIssue}`);
    expect(f.approvalsIcanClear).toEqual({ known: true, count: 2 });
    expect(f.headOffice).toEqual({ known: true, count: 2 });
  });

  it('the person who raised them sees them waiting but not as theirs to clear; with no viewer told, none is theirs', async () => {
    const asCashier = todayLiveFigures(BOX, await readLiveCounts(headOffice, { userId: 'u-cashier', permissions: [] }), 'en');
    expect(asCashier.approvalsWaiting).toMatchObject({ known: true, count: 3 });
    expect(asCashier.approvalsIcanClear).toEqual({ known: true, count: 0 });
    const nobody = todayLiveFigures(BOX, await readLiveCounts(headOffice), 'en');
    expect(nobody.approvalsIcanClear).toEqual({ known: true, count: 0 });
  });

  it('with the approvals inbox unreachable the orders still count, and offline nothing is added (P-01)', () => {
    const f = todayLiveFigures(BOX, { approvals: { result: 'lost_link' }, purchaseOrders: { result: 'read', value: { open: 1, awaitingApproval: 1, forViewer: 1 } } }, 'en');
    expect(f.approvalsWaiting).toMatchObject({ known: true, count: 1 });
    expect(f.headOffice).toEqual({ known: true, count: 1 });
    const off = todayLiveFigures(BOX, { approvals: { result: 'lost_link' }, purchaseOrders: { result: 'lost_link' } }, 'en');
    expect(off.approvalsWaiting).toMatchObject({ known: true, count: 0 });
    expect(off.headOffice).toBeNull();
  });
});

describe('D-010: the owner\'s page counts the orders waiting for them', () => {
  const fetchOf = (status: number, body: unknown, seen: string[] = []) => (async (url: string) => { seen.push(url); return { ok: status < 300, status, json: async () => body }; }) as unknown as typeof fetch;

  it('lists the orders they may issue (not their own), reads only, and says so when head office could not be read', async () => {
    const seen: string[] = [];
    const got = await readOwnerOrders(fetchOf(200, ORDERS, seen), { userId: 'u-owner', permissions: [ISSUE_ORDER_PERMISSION] });
    expect(got.state).toBe('read');
    expect(got.state === 'read' ? got.orders.map((o) => o.poId) : []).toEqual(['PO-C', 'PO-A']);
    expect(seen).toEqual(['/v1/purchase/orders', '/v1/purchase/suppliers']); // GETs only
    expect(await readOwnerOrders(fetchOf(502, {}), { userId: 'u-owner', permissions: [ISSUE_ORDER_PERMISSION] })).toEqual({ state: 'not_read' });
    expect(await readOwnerOrders((async () => { throw new Error('offline'); }) as unknown as typeof fetch, { userId: 'u-owner', permissions: [ISSUE_ORDER_PERMISSION] })).toEqual({ state: 'not_read' });
    // One who may not issue orders: nothing to read, nothing waiting for them.
    expect(await readOwnerOrders(fetchOf(200, ORDERS), { userId: 'u-x', permissions: [] })).toEqual({ state: 'read', orders: [] });
  });
});

describe('D-042: the Approvals page lists the waiting orders with their lines and issues through the one issue path', () => {
  const headOffice = (log: { method: string; path: string; body?: unknown; idempotencyKey?: string }[], issueStatus = 200, issueBody: unknown = { order: {}, budgetAtApproval: { overBudget: false } }): HeadOfficeCall => async (req) => {
    log.push(req);
    if (req.method === 'GET' && req.path === '/v1/purchase/orders') return { status: 200, body: ORDERS };
    if (req.method === 'GET' && req.path === '/v1/purchase/suppliers') return { status: 200, body: { suppliers: [{ supplierId: 'sup-foods', name: 'Sri Foods' }, { supplierId: 'sup-oil', name: 'Gold Oil Traders' }] } };
    if (req.method === 'GET' && req.path === '/v1/catalogue/products') return { status: 200, body: { products: [{ productId: 'prod-oil', name: 'Groundnut oil 1 L' }, { productId: 'prod-rice', name: 'NOT the box name' }] } };
    if (req.method === 'POST') return { status: issueStatus, body: issueBody };
    return { status: 404, body: {} };
  };

  it('reads (GETs only) the orders with supplier and item names — the store computer\'s names first, head office\'s for the rest', async () => {
    const log: { method: string; path: string }[] = [];
    const s = createOrdersToIssueSession(headOffice(log), OWNER, async () => new Map([['prod-biscuit', 'Marie biscuits 200 g'], ['prod-rice', 'Ponni rice']]));
    expect(s.mayIssue).toBe(true);
    const read = await s.read();
    expect(log.every((r) => r.method === 'GET')).toBe(true);
    expect(read.state).toBe('read');
    const orders = read.state === 'read' ? read.orders : [];
    expect(orders.find((o) => o.poId === 'PO-C')).toMatchObject({ supplierName: 'Gold Oil Traders', lines: [{ name: 'Groundnut oil 1 L', quantity: '18' }] });
    expect(orders.find((o) => o.poId === 'PO-A')!.lines.map((l) => l.name)).toEqual(['Marie biscuits 200 g', 'Ponni rice']);
  });

  it('issues with a reason through POST /v1/purchase/orders/:poId/approval; refuses a blank reason and the person\'s own order before any call', async () => {
    const log: { method: string; path: string; body?: unknown; idempotencyKey?: string }[] = [];
    const s = createOrdersToIssueSession(headOffice(log), OWNER);
    expect(await s.issue({ poId: 'PO-A', raisedByViewer: false }, '   ')).toEqual({ kind: 'needs_reason' });
    expect(await s.issue({ poId: 'PO-B', raisedByViewer: true }, 'fine')).toEqual({ kind: 'not_yours' });
    expect(log).toEqual([]);
    expect(await s.issue({ poId: 'PO-A', raisedByViewer: false }, 'checked against last week\'s sales')).toEqual({ kind: 'issued', overBudget: false });
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ method: 'POST', path: '/v1/purchase/orders/PO-A/approval', body: { reason: 'checked against last week\'s sales' } });
    expect(typeof log[0]!.idempotencyKey).toBe('string');
    // An over-budget reason is carried as the Budget tab carries it.
    await s.issue({ poId: 'PO-C', raisedByViewer: false }, 'festival stock', 'Deepavali week');
    expect(log[1]).toMatchObject({ path: '/v1/purchase/orders/PO-C/approval', body: { reason: 'festival stock', overBudgetReason: 'Deepavali week' } });
  });

  it('head office\'s refusal is shown in its own words; no connection is said plainly', async () => {
    const refused = createOrdersToIssueSession(headOffice([], 409, { error: { code: 'proposer_cannot_approve', whatHappened: 'u-owner raised this purchase order and cannot also approve it' } }), OWNER);
    const out = await refused.issue({ poId: 'PO-A', raisedByViewer: false }, 'ok');
    expect(out).toEqual({ kind: 'refused', whatHappened: 'u-owner raised this purchase order and cannot also approve it' });
    expect(refused.outcomeWords('en', out)).toBe(`${ORDERS_TO_ISSUE_WORDS.en.refused} u-owner raised this purchase order and cannot also approve it`);
    const dead = createOrdersToIssueSession(async () => 'unreachable', OWNER);
    expect(await dead.read()).toEqual({ state: 'unreachable' });
    expect(await dead.issue({ poId: 'PO-A', raisedByViewer: false }, 'ok')).toEqual({ kind: 'lost_link' });
    const notRole = createOrdersToIssueSession(async () => ({ status: 403, body: {} }), { userId: 'u-cashier', permissions: [] });
    expect(notRole.mayIssue).toBe(false);
    expect(await notRole.read()).toEqual({ state: 'not_your_role' });
  });

  it('every word has its Tamil twin; money reads as rupees', () => {
    for (const k of Object.keys(ORDERS_TO_ISSUE_WORDS.en) as (keyof typeof ORDERS_TO_ISSUE_WORDS.en)[]) expect(ORDERS_TO_ISSUE_WORDS.ta[k], k).toMatch(/[஀-௿]/);
    expect(TODAY_LIVE_WORDS.ta.ordersToIssue).toMatch(/[஀-௿]/);
    expect(rupeesText(266_400)).toBe('₹2,664.00');
  });
});
