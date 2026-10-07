import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

/**
 * **API-tier step-up for payroll release and bulk product publish (Stage E slice 1 · SEC-03 · §28 · closes the
 * GAP-SEC-06 follow-on).** Driven through the REAL pipeline via `apiHarness`, exactly as production composes it.
 *
 * A pay-run APPROVE, LOCK or REVERSE (`POST /v1/hr/payroll/pay-run/:id/append`) and the salary BANK FILE
 * (`POST /v1/hr/payroll/bank-file`) are refused 403 `reauthentication_required` unless the SIGNED token carries a
 * fresh (≤300s), MFA-backed re-authentication — and nothing is appended. Draft, submit and reject are preparation
 * and stay ordinary. A catalogue publish that adds / changes / removes at least the OWNER's threshold of products
 * (`catalogue.bulk_publish_threshold`, default 50, set through store setup) is refused the same way and nothing is
 * published; a routine publish below it is not asked. A direct raw call with a valid, non-MFA token cannot bypass any
 * of it — the browser prompt is no longer the only control.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaae1';
const CHECKER = 'u-owner-checker';
const OWNER = 'u-owner';
const STORE = 'store-01';
const AS_OF = '2030-06-01';
const GROCERY = { categoryId: 'grocery', name: 'Grocery', parentId: null };

type Evidence = { authTimeFromNowSeconds?: number | null; amr?: readonly string[] | null };
const PWD_ONLY: Evidence = { amr: ['pwd'] };
const NONE: Evidence = { authTimeFromNowSeconds: null, amr: null };
const STALE: Evidence = { authTimeFromNowSeconds: -100_000 };

const errorOf = (res: { body: unknown }) => (res.body as { error?: { code?: string; whatHappened?: string } }).error;

/** A pay-run step taken by the person signed in (ADR-0024): the maker's steps as OWNER, the checker's as a second owner,
 *  CHECKER — the body's `actor: 'maker' | 'checker'` here only picks WHICH of the two signs in; it is not sent. */
const append = (h: ApiHarness, payRunId: string, body: unknown, key: string, ev: Evidence = {}) => {
  const { actor, ...step } = body as { actor?: string };
  return h.request({ method: 'POST', path: `/v1/hr/payroll/pay-run/${payRunId}/append`, userId: actor === 'checker' ? CHECKER : OWNER, tenantId: A, idempotencyKey: key, body: step, ...ev });
};
const runState = async (h: ApiHarness, payRunId: string) =>
  ((await h.request({ method: 'GET', path: `/v1/hr/payroll/pay-run/${payRunId}`, userId: OWNER, tenantId: A })).body as { state: string }).state;

const LINES = [{ employeeId: 'e1', employeeName: 'Asha R', bankAccountNo: '123456789012', ifsc: 'HDFC0001234', netPayMinor: 1_444_000 }];
const LOCKED = [
  { kind: 'drafted', payPeriod: '2026-08', by: 'maker', at: '2026-08-28T10:00:00Z' },
  { kind: 'submitted', by: 'maker', at: '2026-08-28T10:05:00Z' },
  { kind: 'approved', by: 'checker', at: '2026-08-28T11:00:00Z' },
  { kind: 'locked', at: '2026-08-28T11:30:00Z' },
];
const bankFile = (h: ApiHarness, key: string, ev: Evidence = {}) =>
  h.request({ method: 'POST', path: '/v1/hr/payroll/bank-file', userId: OWNER, tenantId: A, idempotencyKey: key, body: { payRunId: 'pr1', events: LOCKED, lines: LINES }, ...ev });

describe('payroll release steps need a fresh MFA re-auth at the write boundary', () => {
  it('draft and submit are ordinary; APPROVE with a password-only session is refused and NOT appended; a fresh MFA approve lands', async () => {
    const h = apiHarness();
    await h.seedOwner(A, OWNER);
    await h.provisionOwner(A, CHECKER);
    expect((await append(h, 'pr1', { action: 'draft', actor: 'maker', payPeriod: '2026-08' }, 'a1', PWD_ONLY)).status).toBe(201);
    expect((await append(h, 'pr1', { action: 'submit', actor: 'maker' }, 'a2', PWD_ONLY)).status).toBe(200);

    const refused = await append(h, 'pr1', { action: 'approve', actor: 'checker' }, 'a3', PWD_ONLY);
    expect(refused.status).toBe(403);
    expect(errorOf(refused)?.code).toBe('reauthentication_required');
    expect(errorOf(refused)?.whatHappened).toContain("A pay-run 'approve' releases or undoes pay.");
    expect(await runState(h, 'pr1')).toBe('submitted'); // nothing appended

    const none = await append(h, 'pr1', { action: 'approve', actor: 'checker' }, 'a4', NONE);
    expect(none.status).toBe(403);
    expect(errorOf(none)?.whatHappened).toContain('carries none');

    expect((await append(h, 'pr1', { action: 'approve', actor: 'checker' }, 'a5')).status).toBe(200); // fresh MFA (harness default)
    expect(await runState(h, 'pr1')).toBe('approved');
  });

  it('LOCK with a stale re-auth is refused; a fresh one locks. REVERSE needs it too; REJECT does not', async () => {
    const h = apiHarness();
    await h.seedOwner(A, OWNER);
    await h.provisionOwner(A, CHECKER);
    await append(h, 'pr2', { action: 'draft', actor: 'maker', payPeriod: '2026-08' }, 'b1');
    await append(h, 'pr2', { action: 'submit', actor: 'maker' }, 'b2');
    await append(h, 'pr2', { action: 'approve', actor: 'checker' }, 'b3');

    const stale = await append(h, 'pr2', { action: 'lock', actor: 'checker' }, 'b4', STALE);
    expect(stale.status).toBe(403);
    expect(errorOf(stale)?.whatHappened).toContain('gone stale');
    expect(await runState(h, 'pr2')).toBe('approved');
    expect((await append(h, 'pr2', { action: 'lock', actor: 'checker' }, 'b5')).status).toBe(200);
    expect(await runState(h, 'pr2')).toBe('locked');

    expect((await append(h, 'pr2', { action: 'reverse', actor: 'checker', reason: 'wrong period' }, 'b6', PWD_ONLY)).status).toBe(403);
    expect(await runState(h, 'pr2')).toBe('locked');

    // A rejection is preparation, not release — a password-only session may send it back.
    await append(h, 'pr3', { action: 'draft', actor: 'maker', payPeriod: '2026-09' }, 'c1', PWD_ONLY);
    await append(h, 'pr3', { action: 'submit', actor: 'maker' }, 'c2', PWD_ONLY);
    expect((await append(h, 'pr3', { action: 'reject', actor: 'checker', reason: 'fix line 4' }, 'c3', PWD_ONLY)).status).toBe(200);
  });

  it('the step-up is checked BEFORE maker ≠ checker, and a self-approval is still refused after it passes', async () => {
    const h = apiHarness();
    await h.seedOwner(A, OWNER);
    await h.provisionOwner(A, CHECKER);
    await append(h, 'pr4', { action: 'draft', actor: 'maker', payPeriod: '2026-08' }, 'd1');
    await append(h, 'pr4', { action: 'submit', actor: 'maker' }, 'd2');
    expect((await append(h, 'pr4', { action: 'approve', actor: 'maker' }, 'd3', PWD_ONLY)).status).toBe(403); // step-up first
    const self = await append(h, 'pr4', { action: 'approve', actor: 'maker' }, 'd4');
    expect(self.status).toBe(422);
    expect(errorOf(self)?.code).toBe('pay_run_self_approval');
  });

  it('the salary BANK FILE needs it on every call (route-level): no evidence → 403; fresh MFA → the file', async () => {
    const h = apiHarness();
    await h.seedOwner(A, OWNER);
    await h.provisionOwner(A, CHECKER);
    const refused = await bankFile(h, 'f1', NONE);
    expect(refused.status).toBe(403);
    expect(errorOf(refused)?.code).toBe('reauthentication_required');
    expect((await bankFile(h, 'f2', PWD_ONLY)).status).toBe(403);
    const ok = await bankFile(h, 'f3');
    expect(ok.status).toBe(200);
    expect((ok.body as { recordCount: number }).recordCount).toBe(1);
  });

  it('a DIRECT raw API call with a genuinely signed, non-MFA token cannot bypass the payroll gate', async () => {
    const h = apiHarness();
    await h.seedOwner(A, OWNER);
    await h.provisionOwner(A, CHECKER);
    await append(h, 'pr5', { action: 'draft', actor: 'maker', payPeriod: '2026-08' }, 'e1');
    await append(h, 'pr5', { action: 'submit', actor: 'maker' }, 'e2');
    // The checker's OWN genuinely signed token, but with no MFA behind it.
    const token = h.idp.issue({ sub: CHECKER, tenantId: A, authTimeFromNowSeconds: null, amr: null });
    const res = await h.raw({ method: 'POST', path: '/v1/hr/payroll/pay-run/pr5/append', token, idempotencyKey: 'e3', body: { action: 'approve' } });
    expect(res.status).toBe(403);
    expect(errorOf(res)?.code).toBe('reauthentication_required');
    expect(await runState(h, 'pr5')).toBe('submitted');
  });
});

// ── the catalogue publish, through the REAL master-data chain ──────────────────────────────────────────────
const publishProduct = (h: ApiHarness, productId: string, sku: string) =>
  h.request({ method: 'POST', path: `/v1/catalogue/products/${productId}/publish`, userId: OWNER, tenantId: A, idempotencyKey: `k-${productId}`,
    body: { product: { sku, name: `Item ${sku}`, baseUom: 'each', primaryCategoryId: 'grocery', taxClass: '25010020', lifecycle: 'draft' }, categories: [GROCERY] } });
const setPrice = (h: ApiHarness, productId: string, entryId: string, priceMinor: number, effectiveFrom: string) =>
  h.request({ method: 'POST', path: `/v1/prices/list/${productId}/entries/${entryId}`, userId: OWNER, tenantId: A, idempotencyKey: `k-price-${productId}-${entryId}`,
    body: { scope: 'store', scopeRef: STORE, priceMinor, mrpMinor: 9_900, costMinor: 1, marginFloorBps: 0, currency: 'INR', effectiveFrom } });
const publishPack = (h: ApiHarness, key: string, ev: Evidence = {}) =>
  h.request({ method: 'POST', path: '/v1/catalogue/pack', userId: OWNER, tenantId: A, idempotencyKey: key, body: { storeId: STORE, asOf: AS_OF }, ...ev });
const packVersion = async (h: ApiHarness) => {
  const res = await h.request({ method: 'GET', path: '/v1/catalogue/pack', userId: OWNER, tenantId: A });
  return res.status === 200 ? (res.body as { snapshot: { version: number } }).snapshot.version : undefined;
};
const setThreshold = (h: ApiHarness, value: unknown, key: string) =>
  h.request({ method: 'PUT', path: '/v1/platform/setup/catalogue.bulk_publish_threshold', userId: OWNER, tenantId: A, idempotencyKey: key, body: { value } });

describe('a BULK catalogue publish needs a fresh MFA re-auth; the owner draws the line', () => {
  it('below the default threshold (50) a password-only publish is routine; once the owner sets the threshold to 2, a 2-line re-price is bulk and is refused with nothing published; fresh MFA publishes it; a 1-line change is routine again', async () => {
    const h = apiHarness();
    await h.seedOwner(A, OWNER);
    await h.provisionOwner(A, CHECKER);
    await h.request({ method: 'POST', path: '/v1/catalogue/tax-classes/25010020/rates/2017-07-01', userId: OWNER, tenantId: A, idempotencyKey: 'k-tax', body: { rateBps: 500 } });
    for (const [id, sku] of [['p-1', 'SKU-1'], ['p-2', 'SKU-2'], ['p-3', 'SKU-3']] as const) {
      expect((await publishProduct(h, id, sku)).status).toBeLessThan(300);
      expect((await setPrice(h, id, 'e1', 2_000, '2030-01-01')).status).toBeLessThan(300);
    }

    // 3 products added on a first publish — below the visible default of 50: routine, no step-up asked.
    expect((await publishPack(h, 'pub-1', PWD_ONLY)).status).toBe(201);
    expect(await packVersion(h)).toBe(1);

    // The owner lowers the line to 2 through store setup (a validated, versioned, reversible answer).
    expect((await setThreshold(h, 0, 'thr-bad')).status).toBe(422); // not a product count
    expect((await setThreshold(h, 2, 'thr-1')).status).toBeLessThan(300);

    // Two lines re-priced → 2 changed ≥ 2: BULK. Password-only → refused; the shop still holds v1.
    await setPrice(h, 'p-1', 'e2', 2_500, '2030-03-01');
    await setPrice(h, 'p-2', 'e2', 2_600, '2030-03-01');
    const refused = await publishPack(h, 'pub-2', PWD_ONLY);
    expect(refused.status).toBe(403);
    expect(errorOf(refused)?.code).toBe('reauthentication_required');
    expect(errorOf(refused)?.whatHappened).toContain('changes 2 products');
    expect(errorOf(refused)?.whatHappened).toContain('bulk threshold of 2');
    expect(await packVersion(h)).toBe(1);

    expect((await publishPack(h, 'pub-3')).status).toBe(201); // fresh MFA
    expect(await packVersion(h)).toBe(2);

    // One line re-priced → 1 < 2: routine again, no step-up.
    await setPrice(h, 'p-3', 'e2', 2_700, '2030-03-01');
    expect((await publishPack(h, 'pub-4', PWD_ONLY)).status).toBe(201);
    expect(await packVersion(h)).toBe(3);
  });

  it('a DIRECT raw API call with a valid non-MFA token cannot bypass the bulk gate', async () => {
    const h = apiHarness();
    await h.seedOwner(A, OWNER);
    await h.provisionOwner(A, CHECKER);
    await h.request({ method: 'POST', path: '/v1/catalogue/tax-classes/25010020/rates/2017-07-01', userId: OWNER, tenantId: A, idempotencyKey: 'k-tax', body: { rateBps: 500 } });
    await publishProduct(h, 'p-1', 'SKU-1');
    await setPrice(h, 'p-1', 'e1', 2_000, '2030-01-01');
    await setThreshold(h, 1, 'thr-1');
    const token = h.idp.issue({ sub: OWNER, tenantId: A, authTimeFromNowSeconds: null, amr: null });
    const res = await h.raw({ method: 'POST', path: '/v1/catalogue/pack', token, idempotencyKey: 'raw-1', body: { storeId: STORE, asOf: AS_OF } });
    expect(res.status).toBe(403);
    expect(errorOf(res)?.code).toBe('reauthentication_required');
    expect(await packVersion(h)).toBeUndefined();
  });
});

// ── the SENSITIVE leg on the REAL chain (E1b · M03-FR-03 → M12-FR-04) ──────────────────────────────────────────
const LIQUOR = { categoryId: 'liquor', name: 'Liquor', parentId: null, regulated: ['age_restricted'] };
const publishBeer = (h: ApiHarness, minimumAge: number, key: string) =>
  h.request({ method: 'POST', path: '/v1/catalogue/products/p-beer/publish', userId: OWNER, tenantId: A, idempotencyKey: key,
    body: { product: { sku: 'SKU-BEER', name: 'Beer 650ml', baseUom: 'each', primaryCategoryId: 'liquor', taxClass: '22030000', lifecycle: 'draft', safety: { minimumAge } }, categories: [LIQUOR] } });
const latestPack = async (h: ApiHarness) =>
  ((await h.request({ method: 'GET', path: '/v1/catalogue/pack', userId: OWNER, tenantId: A })).body as
    { snapshot: { version: number; products: { productId: string; regulatedFlags?: Record<string, unknown> }[] } }).snapshot;
const beerFlags = async (h: ApiHarness) => (await latestPack(h)).products.find((p) => p.productId === 'p-beer')?.regulatedFlags;

describe('a SENSITIVE catalogue publish — an age-restricted product added or changed — needs a fresh MFA re-auth on the REAL master-data chain', () => {
  it('ONE age-restricted product (far below the bulk line): password-only is refused with the product named and nothing published; fresh MFA publishes a pack whose product carries { minimumAge }; changing its age is sensitive again; an unrelated re-price is routine', async () => {
    const h = apiHarness();
    await h.seedOwner(A, OWNER);
    await h.provisionOwner(A, CHECKER);
    await h.request({ method: 'POST', path: '/v1/catalogue/tax-classes/25010020/rates/2017-07-01', userId: OWNER, tenantId: A, idempotencyKey: 'k-tax', body: { rateBps: 500 } });
    await h.request({ method: 'POST', path: '/v1/catalogue/tax-classes/22030000/rates/2017-07-01', userId: OWNER, tenantId: A, idempotencyKey: 'k-tax-beer', body: { rateBps: 1800 } });

    // An unrestricted product first — a routine publish; password-only is fine and the shop holds v1.
    await publishProduct(h, 'p-1', 'SKU-1');
    await setPrice(h, 'p-1', 'e1', 2_000, '2030-01-01');
    expect((await publishPack(h, 'pub-1', PWD_ONLY)).status).toBe(201);
    expect(await packVersion(h)).toBe(1);

    // The age-restricted product master arrives (the engine made it declare its minimum age) and is priced.
    expect((await publishBeer(h, 21, 'k-beer')).status).toBe(201);
    await setPrice(h, 'p-beer', 'e1', 9_000, '2030-01-01');

    // One product added — 1 ≪ 50, so not bulk — but it is REGULATED: refused, named, nothing published.
    const refused = await publishPack(h, 'pub-2', PWD_ONLY);
    expect(refused.status).toBe(403);
    expect(errorOf(refused)?.code).toBe('reauthentication_required');
    expect(errorOf(refused)?.whatHappened).toContain('regulated product');
    expect(errorOf(refused)?.whatHappened).toContain('p-beer');
    expect(await packVersion(h)).toBe(1);

    // Fresh MFA: published, and the pack carries the restriction the till's age gate keys on.
    expect((await publishPack(h, 'pub-3')).status).toBe(201);
    expect((await latestPack(h)).version).toBe(2);
    expect(await beerFlags(h)).toEqual({ minimumAge: 21 });

    // Changing the regulated product (its minimum age) is sensitive again; fresh MFA lands the new age.
    expect((await publishBeer(h, 18, 'k-beer-2')).status).toBe(201);
    expect(errorOf(await publishPack(h, 'pub-4', PWD_ONLY))?.code).toBe('reauthentication_required');
    expect((await latestPack(h)).version).toBe(2);
    expect((await publishPack(h, 'pub-5')).status).toBe(201);
    expect(await beerFlags(h)).toEqual({ minimumAge: 18 });

    // An unrelated re-price (the salt line) touches no regulated product and is below the bulk line: routine.
    await setPrice(h, 'p-1', 'e2', 2_500, '2030-03-01');
    expect((await publishPack(h, 'pub-6', PWD_ONLY)).status).toBe(201);
    expect((await latestPack(h)).version).toBe(4);
  });
});
