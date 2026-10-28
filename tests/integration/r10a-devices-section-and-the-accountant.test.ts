import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';
import { P3, p3Shop, caller, issuedOrder, received, capturedAndMatched } from '../support/p3-purchase';
import type { ApiHarness } from '../support/api-harness';
import { createQuotationsSession } from '../../apps/web-erp/src/quotations-session';
import { fetchGoodsReceipt, goodsReceiptPortsFromData, goodsReceiptListPathFor } from '../../apps/web-erp/src/browser-entry';
import { createGoodsReceiptSession } from '../../apps/web-erp/src/goods-receipt-session';
import { openGrnBillMatchPort } from '../../apps/web-erp/src/goods-receipt-bill-match';
import { fleetVersionExceptionsPort } from '../../apps/web-erp/src/fleet-version-exceptions';
import { ROLE_CATALOGUE } from '../../services/api/src/roles';

/**
 * **Round 10 · R10-A — by the owner's decisions of 28 Oct 2026, on head office's real routes — in memory and, with DATABASE_URL,
 * on real PostgreSQL, each with a cold restart.**
 *   • OB-540: the Devices page's section reads head office's register of handheld work on a barred build (a queue-till basket
 *     reported through the real route), as the person; a reader without the Devices word is told so; after a restart too.
 *   • OB-542: the OWNER's own quotation on a product with no known floor is approved by the ACCOUNTANT of that store through the
 *     maker-checker engine — never by the owner himself, a store manager, or an accountant of another store.
 *   • OB-543: the accountant opens the goods-receipt screen through its own narrow read (and is still refused the broad stock
 *     reads) and matches the supplier bill there; the person who received the goods is refused.
 * Synthetic data only.
 */

const backings = useRestartableBackings();
const savedFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = savedFetch; });

const STORE = 'store-1';
const OWNER = 'u-owner'; const MANAGER = 'u-mgr'; const ACCOUNTANT = 'u-acct'; const ACCOUNTANT_ELSEWHERE = 'u-acct-s2'; const CASHIER = 'u-cash'; const BOX = 'u-box';
type Res = { status: number; body: unknown };

/** A browser's same-origin fetch (as the store computer carries it to head office), answered by the harness as one person. */
function asPerson(get: () => ApiHarness, tenantId: string, userId: string, branchId?: string): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), 'http://screen.local');
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const r = await get().request({
      method: (init?.method ?? 'GET') as 'GET', path: url.pathname, userId, tenantId, ...(branchId === undefined ? {} : { branchId }),
      ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) as unknown }),
      ...(headers['idempotency-key'] === undefined ? {} : { idempotencyKey: headers['idempotency-key'] }),
      ...(url.search === '' ? {} : { query: Object.fromEntries(url.searchParams) }),
    });
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
}
/** A checker decides in their own session, working in a branch (a branch-scoped grant counts only there). */
const decide = (h: ApiHarness, tenantId: string, checker: string, requestId: string, branchId?: string) => h.request({
  method: 'POST', path: `/v1/approvals/requests/${requestId}/decide`, userId: checker, tenantId, ...(branchId === undefined ? {} : { branchId }),
  idempotencyKey: `decide-${randomUUID()}`, body: { decision: 'approved', reason: 'checked' },
});
const permissionsOf = (roleId: string): readonly string[] => ROLE_CATALOGUE.find((r) => r.id === roleId)!.permissions;

async function quotingShop(h: ApiHarness, T: string) {
  await h.seedOwner(T, OWNER);
  await h.provisionRole(T, MANAGER, 'store_manager', [STORE]);
  await h.provisionRole(T, ACCOUNTANT, 'accountant', [STORE]);
  await h.provisionRole(T, ACCOUNTANT_ELSEWHERE, 'accountant', ['store-2']);
  await h.provisionRole(T, CASHIER, 'cashier', [STORE]);
  await h.provisionRole(T, BOX, 'store_computer', [STORE]);
  const req = (method: 'GET' | 'POST', path: string, body?: unknown, userId = OWNER, branchId?: string): Promise<Res> =>
    h.request({ method, path, userId, tenantId: T, ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }), ...(branchId === undefined ? {} : { branchId }) });
  const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
  await ok(req('POST', '/v1/catalogue/tax-classes/07139010/rates/2017-07-01', { rateBps: 500 }), 'tax');
  // A new oil NEVER received at a cost: head office cannot read its floor.
  await ok(req('POST', '/v1/catalogue/products/p-oil/publish', { product: { sku: 'OIL-1L', name: 'New brand oil 1 L', baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '07139010', lifecycle: 'draft', safety: { netQuantity: '1 pack' }, mrpHistory: [{ value: { minor: 20_000, currency: 'INR' }, effectiveFrom: '2030-01-01' }] }, categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }] }), 'publish oil');
  await ok(req('POST', '/v1/prices/list/p-oil/entries/e1', { scope: 'store', scopeRef: STORE, priceMinor: 18_000, mrpMinor: 20_000, costMinor: 1, marginFloorBps: 0, currency: 'INR', effectiveFrom: '2030-01-01' }), 'price oil');
  await ok(req('POST', '/v1/catalogue/products/p-oil/barcodes/8901000000057', { kind: 'ean' }), 'barcode oil');
  await ok(req('POST', '/v1/catalogue/pack', { storeId: STORE, asOf: '2030-06-01' }), 'publish the pack');
  return { req };
}

describe.each(backings)('R10-A — on $name', ({ harness }) => {
  it('OB-542: the owner\'s own no-floor quotation is made only with THIS store\'s accountant\'s approval; it survives a restart', async () => {
    let h = harness();
    const T = randomUUID();
    await quotingShop(h, T);
    const page = createQuotationsSession({ viewer: { userId: OWNER, permissions: ['pos.quotation.read', 'pos.quotation.write'] }, fetch: asPerson(() => h, T, OWNER, STORE), newNumber: () => '16180339', now: () => '2030-06-01T06:00:00.000Z' });
    const oil = await page.line({ code: 'OIL-1L', qty: '10', priceRupees: '170' });
    if (oil.result !== 'ok') throw new Error(`line: ${JSON.stringify(oil)}`);
    const form = { storeId: STORE, customerRef: 'Murugan Stores', validUntil: '2099-12-31', approvalId: '', lines: [oil.value] };
    expect(await page.make(form)).toMatchObject({ result: 'refused', status: 422, code: 'quotation_floor_not_known_owner_quoted_unapproved' });
    expect(page.needsAccountant()).toBe(true);
    const ask = async (): Promise<string> => {
      const asked = await page.askApproval();
      expect(asked.result, JSON.stringify(asked)).toBe('ok');
      expect(asked).toMatchObject({ value: { kind: 'quotation_floor_not_known_owner_quoted' } });
      return (asked as { value: { requestId: string } }).value.requestId;
    };
    const first = await ask();
    // The owner never approves his own; a store manager does not hold the accountant's word.
    expect((await decide(h, T, OWNER, first)).status).toBeGreaterThanOrEqual(400);
    expect((await decide(h, T, MANAGER, first, STORE)).status).toBe(403);
    // An accountant of ANOTHER store may hold the word, but head office's quotation route does not count her approval.
    expect((await decide(h, T, ACCOUNTANT_ELSEWHERE, first, 'store-2')).status).toBeLessThan(300);
    expect(await page.make({ ...form, approvalId: first })).toMatchObject({ result: 'refused', code: 'quotation_floor_not_known_owner_quoted_unapproved' });
    // THIS store's accountant decides a fresh request in her own session; the owner then makes the quotation.
    const second = await ask();
    expect((await decide(h, T, ACCOUNTANT, second, STORE)).status).toBeLessThan(300);
    const made = await page.make({ ...form, approvalId: second });
    expect(made, JSON.stringify(made)).toMatchObject({ result: 'ok', value: { quotationId: '16180339', floorNotKnown: ['p-oil'] } });

    // Anyone else's such quotation is unchanged (OB-532): a manager's is refused as the OWNER's to approve.
    const managerPage = createQuotationsSession({ viewer: { userId: MANAGER, permissions: ['pos.quotation.read', 'pos.quotation.write'] }, fetch: asPerson(() => h, T, MANAGER, STORE), newNumber: () => '16180340', now: () => '2030-06-01T06:00:00.000Z' });
    expect(await managerPage.make(form)).toMatchObject({ result: 'refused', code: 'quotation_floor_not_known_unapproved' });
    expect(managerPage.needsOwner()).toBe(true);

    // Cold restart: the quotation and who approved it are on record.
    h = harness(h);
    const listed = (await h.request({ method: 'GET', path: '/v1/pos/quotations', userId: OWNER, tenantId: T })).body as { quotations: { quotationId: string; state: string; marginApprovedBy?: string; issuedBy: string }[] };
    expect(listed.quotations.find((q) => q.quotationId === '16180339')).toMatchObject({ state: 'issued', issuedBy: OWNER, marginApprovedBy: ACCOUNTANT });
  }, 120_000);

  it('OB-543: the accountant opens the goods-receipt screen on its own narrow read and matches the bill; the receiver is refused', async () => {
    let h = harness();
    const T = randomUUID();
    await p3Shop(h, T);
    const call = caller(h, T);
    expect((await call('POST', '/v1/catalogue/products/p-brm/publish', P3.OWNER, { product: { sku: 'SKU-BRM', name: 'Synthetic broom', baseUom: 'each', primaryCategoryId: 'loose', taxClass: '96031000', lifecycle: 'active', mrpHistory: [{ value: { minor: 90_00, currency: 'INR' }, effectiveFrom: '2026-01-01' }] }, categories: [{ categoryId: 'loose', name: 'Loose household', parentId: null }] })).status).toBe(201);
    await issuedOrder(call, 'po-1', [{ productId: 'p-brm', qty: 10, unitMinor: 4_000 }]);
    await received(call, 'grn-1', 'po-1', [{ productId: 'p-brm', qty: 10, unitMinor: 4_000 }]);
    await capturedAndMatched(call, 'INV-1', 'po-1', [{ productId: 'p-brm', qty: 10, unitMinor: 4_200 }]);

    // Least privilege: the accountant (P3.MATCHER) is still refused the broad stock reads.
    const asAccountant = (path: string) => h.request({ method: 'GET', path, userId: P3.MATCHER, tenantId: T });
    expect((await asAccountant('/v1/inventory/goods-receipt')).status).toBe(403);
    expect((await asAccountant('/v1/inventory/availability')).status).toBe(403);
    expect((await asAccountant('/v1/inventory/goods-receipt-review')).status).toBe(200);
    // A cashier holds neither word.
    expect((await h.request({ method: 'GET', path: '/v1/inventory/goods-receipt-review', userId: P3.CASHIER, tenantId: T })).status).toBe(403);

    const screenFor = async (userId: string, roleId: string) => {
      globalThis.fetch = asPerson(() => h, T, userId);
      const permissions = permissionsOf(roleId);
      const data = await fetchGoodsReceipt(goodsReceiptListPathFor(permissions));
      expect(data, `${userId} read the list`).not.toBeNull();
      return createGoodsReceiptSession({ userId }, goodsReceiptPortsFromData({ userId, permissions }, data!, undefined, undefined, openGrnBillMatchPort()));
    };
    const g = (s: Awaited<ReturnType<typeof screenFor>>) => s.view('en').receipts.find((r) => r.grnId === 'grn-1')!;
    // The person who RECEIVED the goods (a store manager) is told someone else matches it; head office refuses them too.
    const receiver = await screenFor(P3.RECEIVER, 'store_manager');
    expect(g(receiver).billMatch).toEqual({ matched: [], canMatch: false, receivedByYou: true });
    expect(await openGrnBillMatchPort().post({ grnId: 'grn-1', invoiceId: 'INV-1' })).toMatchObject({ result: 'self_match' });

    // The ACCOUNTANT reads the screen through the narrow list and matches the bill there.
    const accountant = await screenFor(P3.MATCHER, 'accountant');
    expect(g(accountant).billMatch.canMatch).toBe(true);
    const out = await accountant.matchBill({ grnId: 'grn-1', invoiceId: 'INV-1' });
    expect(out, JSON.stringify(out)).toMatchObject({ outcome: 'matched', matched: [{ lineId: 'L1', invoiceId: 'INV-1', unitCostMinor: 4_200, matchedBy: P3.MATCHER }] });

    // Cold restart: the accountant's screen reads the matched bill back, by her.
    h = harness(h);
    const after = await screenFor(P3.MATCHER, 'accountant');
    expect(g(after).billMatch.matched.map((m) => m.label)).toEqual([expect.stringContaining(`by ${P3.MATCHER}`)]);
    expect(g(after).billMatch.canMatch).toBe(false);
  }, 120_000);

  it('OB-540: the Devices page reads head office\'s register (a barred queue-till build reported through the real route), after a restart too', async () => {
    let h = harness();
    const T = randomUUID();
    await quotingShop(h, T);
    // The store computer reports a queue-till basket handed over on a build its signed pack withdraws.
    const reported = await h.request({
      method: 'POST', path: '/v1/platform/handheld-work/queue-baskets/QB-1/build/synced', userId: BOX, tenantId: T, branchId: STORE, idempotencyKey: `k-${randomUUID()}`,
      body: { basketId: 'QB-1', handheldLane: 'queue-1', handedOverBy: 'u-cash', handedOverAt: '2030-06-01T04:30:00.000Z', reportedBuild: { client: 'queue_till', appVersion: '0.9.0', storeComputerVersionCheck: { verdict: 'version_killed', reported: '0.9.0', minimumSupportedVersion: null } } },
    });
    expect(reported.status, JSON.stringify(reported.body)).toBe(200);
    expect(reported.body).toMatchObject({ flagged: true, severity: 'material' });

    const section = async (userId: string, roleId: string) => {
      const port = fleetVersionExceptionsPort(permissionsOf(roleId), asPerson(() => h, T, userId, STORE));
      return { port, read: await port.read() };
    };
    const owner = await section(OWNER, 'owner');
    expect(owner.read).toMatchObject({ state: 'read', unreadable: 0 });
    const en = owner.port.view('en', owner.read);
    expect(en.rows).toEqual([expect.objectContaining({ kind: 'Queue till', version: '0.9.0', what: 'A queue-till basket handed over (record queue-1/QB-1)', finding: 'Version withdrawn by head office (the store computer marked it too)' })]);
    expect(owner.port.view('ta', owner.read).rows[0]).toMatchObject({ kind: 'வரிசைக் கல்லா', what: 'வரிசைக் கல்லா கூடை ஒப்படைப்பு (பதிவு queue-1/QB-1)' });

    // A cashier does not hold the Devices page's word: told so, nothing read. If one did ask, head office refuses (403).
    const cashier = await section(CASHIER, 'cashier');
    expect(cashier.read).toEqual({ state: 'not_permitted' });
    expect((await h.request({ method: 'GET', path: '/v1/platform/handheld-work/version-exceptions', userId: CASHIER, tenantId: T })).status).toBe(403);

    // Cold restart: the same finding is on head office's register; the section reads it again.
    h = harness(h);
    const again = await section(OWNER, 'owner');
    expect(again.read.state === 'read' ? again.read.material.map((m) => m.recordRef) : []).toEqual(['queue-1/QB-1']);
  }, 120_000);
});
