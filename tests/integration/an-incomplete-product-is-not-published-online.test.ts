import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { testModePaymentProvider } from '../../packages/orders/src/payment-verification';
import { serviceCaseAdapter } from '../../services/api/src/adapters';
import { seedOnlineShop, callsFor, codeOf, saidOf, OWNER, MANAGER, CASHIER, CUSTOMER } from '../support/online-shop';

/**
 * **R4 · B23 · A26 — the online store shows what the law asks before payment, and sells only the shop's own goods — on
 * the real API, in memory and on REAL PostgreSQL, across a cold restart.**
 *
 * The signed sentence (OB-227): every product online shows, before payment, the MRP, the price with tax, the delivery
 * fee and the total, the best-before where it carries one, the country of origin, the shop's legal name, address and
 * GSTIN, the return and refund terms, and the grievance officer's name and contact; a product missing any of these
 * cannot be published online ("online listing incomplete: <field>") and still sells in the shop. OB-223: the grievance
 * officer is NOT named yet — so publishing stays refused by name, and every page reads "not set" for him. Another
 * seller's item (a concession tenant's) is refused online (A26 · OB-211), and the GST line reads "not applicable".
 */

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });

const provider = testModePaymentProvider();
const backings: { name: string; harness: () => ApiHarness; restart: (h: ApiHarness) => ApiHarness }[] = [
  { name: 'the in-memory event store', harness: () => apiHarness({ paymentVerifier: provider }), restart: (h) => apiHarness({ store: h.store, paymentVerifier: provider }) },
];
if (DATABASE_URL !== undefined) {
  const pg = (): ApiHarness => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql), paymentVerifier: provider }); };
  backings.push({ name: 'real PostgreSQL', harness: pg, restart: pg });
}

type Listing = { productId: string; listed: boolean; publishable: boolean; refusal?: string; missing?: string[]; lines: { field: string; value: string }[] };
const DETAILS = { legalName: 'Synthetic Hyper Market Private Limited', address: '1 Test Road, Test Town, Tamil Nadu 600001', gstin: '33ABCDE1234F1Z5', returnTerms: 'Unopened goods may be returned within the window shown for their department; refunds go back to the way you paid.' };

describe.each(backings)('B23 · A26 — an incomplete product is not published online, on $name', ({ harness, restart }) => {
  it('every duty is named, "not set" is said, the grievance officer blocks publishing, a concession item is refused, and the shop still sells', async () => {
    let h = harness();
    const T = randomUUID();
    const c = callsFor(() => h, T);
    const { req, ok } = c;
    await seedOnlineShop(h, T, c);

    // Nothing set yet: every shop detail reads "not set".
    const fresh = (await ok(req('GET', '/v1/online-store/details'), 'details')).body as { details: Record<string, unknown>; onlineStore: { publishable: boolean; refusal?: string }; tcs: string };
    expect(fresh.details).toMatchObject({ legalName: 'not set', address: 'not set', gstin: 'not set', returnTerms: 'not set', grievanceOfficerName: 'not set', grievanceOfficerContact: 'not set' });
    expect(fresh.tcs).toBe('TCS (section 52): not applicable: own goods only');

    // MILK carries every product duty — but the shop's own details are missing, so it is refused naming the first.
    const r1 = await req('POST', '/v1/online-store/listings/MILK', { action: 'publish' });
    expect(r1.status).toBe(422);
    expect(codeOf(r1)).toBe('online_listing_incomplete');
    expect(saidOf(r1)).toMatch(/^online listing incomplete: shop legal name\./);

    // Permissions: a cashier may neither set the details nor publish; nor read the register.
    expect((await req('POST', '/v1/online-store/details', { ...DETAILS, reason: 'x' }, CASHIER)).status).toBe(403);
    expect((await req('POST', '/v1/online-store/listings/MILK', { action: 'publish' }, CASHIER)).status).toBe(403);
    expect((await req('GET', '/v1/online-store/listings', undefined, CASHIER)).status).toBe(403);
    // A malformed GSTIN or a detail with no reason is refused, unsaved.
    expect(codeOf(await req('POST', '/v1/online-store/details', DETAILS))).toBe('not_readable_as_shop_details');

    // The owner sets everything he has — the grievance officer is PENDING (OB-223), so he is left out.
    await ok(req('POST', '/v1/online-store/details', { ...DETAILS, reason: 'R4 online store details (synthetic)' }), 'details v1');

    // ── A cold restart: the details, and every refusal, are rebuilt from the store ──
    h = restart(h);
    const d1 = (await ok(req('GET', '/v1/online-store/details', undefined, MANAGER), 'details again')).body as { details: Record<string, unknown> & { missing: string[]; version: number }; onlineStore: { publishable: boolean; refusal?: string } };
    expect(d1.details.version).toBe(1);
    expect(d1.details.grievanceOfficerName).toBe('not set');
    expect(d1.details.missing).toEqual(['grievance officer name', 'grievance officer contact']);
    expect(d1.onlineStore).toMatchObject({ publishable: false, refusal: 'online listing incomplete: grievance officer name' });

    // OB-223: publishing the online store is refused by name until the grievance officer is named.
    const pub = await req('POST', '/v1/online-store/publish');
    expect(pub.status).toBe(409);
    expect(saidOf(pub)).toMatch(/^online listing incomplete: grievance officer name\. Still not set: grievance officer name, grievance officer contact\./);
    const r2 = await req('POST', '/v1/online-store/listings/MILK', { action: 'publish' }, MANAGER);
    expect(r2.status).toBe(422);
    expect(saidOf(r2)).toMatch(/^online listing incomplete: grievance officer name\./);

    // Each listing names every duty, with its value or "not set".
    const listings = ((await ok(req('GET', '/v1/online-store/listings'), 'listings')).body as { listings: Listing[] }).listings;
    const milk = listings.find((l) => l.productId === 'MILK')!;
    const line = (l: Listing, f: string) => l.lines.find((x) => x.field === f)?.value;
    expect(milk.listed).toBe(false);
    expect(line(milk, 'MRP')).toBe('₹70.00 (inclusive of all taxes)');
    expect(line(milk, 'selling price with tax')).toBe('₹60.00 including ₹2.86 GST at 5%');
    expect(line(milk, 'delivery fee')).toBe('₹40.00');
    expect(line(milk, 'best-before date')).toBe('2099-12-31');
    expect(line(milk, 'country of origin')).toBe('India');
    expect(line(milk, 'shop GSTIN')).toBe('33ABCDE1234F1Z5');
    expect(line(milk, 'grievance officer name')).toBe('not set');
    expect(milk.missing).toEqual(['grievance officer name', 'grievance officer contact']);
    const broom = listings.find((l) => l.productId === 'BROOM')!;
    expect(line(broom, 'best-before date')).toBe('does not carry one');
    expect(broom.missing).toEqual(['country of origin', 'grievance officer name', 'grievance officer contact']);

    // The customer, before paying, reads the same — the officer "not set", and nothing sold online yet.
    const shopper = (await ok(req('GET', '/v1/storefront/listing', undefined, CUSTOMER), 'customer listing')).body as { shop: Record<string, unknown>; onlineStore: { open: boolean; notOpenBecause?: string }; products: { productId: string; soldOnline: boolean; notOnline?: string; totalMinor?: number }[]; pages: Record<string, string> };
    expect(shopper.shop['grievanceOfficerName']).toBe('not set');
    expect(shopper.onlineStore).toEqual({ open: false, notOpenBecause: 'online listing incomplete: grievance officer name' });
    expect(shopper.products.find((p) => p.productId === 'MILK')).toMatchObject({ soldOnline: false, notOnline: 'online listing incomplete: grievance officer name', totalMinor: 100_00 });
    expect(shopper.pages).toEqual({ privacy: './privacy.html', terms: './terms.html' });

    // It still sells in the shop: the till's pack carries every product, untouched by the online listing.
    const tillPack = (await ok(req('GET', '/v1/catalogue/pack'), 'pack')).body as { snapshot: { products: { productId: string; status: string }[] } };
    expect(tillPack.snapshot.products.map((p) => p.productId).sort()).toEqual(['BROOM', 'MILK', 'SAREE']);

    // ── The gate opens only once a grievance officer is set — proven here with a SYNTHETIC officer, not the owner's ──
    await ok(req('POST', '/v1/online-store/details', { grievanceOfficerName: 'Synthetic Officer (test only)', grievanceOfficerContact: 'grievance@example.invalid', reason: 'test: prove the gate opens' }), 'details v2');
    await ok(req('POST', '/v1/online-store/publish'), 'store publish');
    expect((await ok(req('POST', '/v1/online-store/listings/MILK', { action: 'publish' }), 'MILK online')).status).toBe(201);
    // BROOM has no country of origin: refused by name.
    const b = await req('POST', '/v1/online-store/listings/BROOM', { action: 'publish' });
    expect(b.status).toBe(422);
    expect(saidOf(b)).toMatch(/^online listing incomplete: country of origin\./);
    // A26: the concession tenant's saree is another seller's goods — refused online, whatever its details.
    const s = await req('POST', '/v1/online-store/listings/SAREE', { action: 'publish' });
    expect(s.status).toBe(422);
    expect(codeOf(s)).toBe('other_sellers_goods');
    expect(saidOf(s)).toMatch(/^other seller's goods: not sold online\./);
    const tcs = (await ok(req('GET', '/v1/online-store/tcs'), 'tcs')).body as { tcs: string; collectedMinor: number; refusedOtherSellerListings: { productId: string; otherSeller: string }[] };
    expect(tcs).toMatchObject({ tcs: 'TCS (section 52): not applicable: own goods only', collectedMinor: 0 });
    expect(tcs.refusedOtherSellerListings.map((x) => [x.productId, x.otherSeller])).toEqual([['SAREE', 'silks-counter']]);

    h = restart(h);
    const after = (await ok(req('GET', '/v1/storefront/listing', undefined, CUSTOMER), 'customer listing 2')).body as { onlineStore: { open: boolean }; products: { productId: string; soldOnline: boolean; notOnline?: string }[] };
    expect(after.onlineStore.open).toBe(true);
    expect(after.products.find((p) => p.productId === 'MILK')!.soldOnline).toBe(true);
    expect(after.products.find((p) => p.productId === 'BROOM')).toMatchObject({ soldOnline: false, notOnline: 'online listing incomplete: country of origin' });
    expect(after.products.find((p) => p.productId === 'SAREE')).toMatchObject({ soldOnline: false, notOnline: "other seller's goods: not sold online" });
    // Withdrawing needs a reason; then MILK is off the online store.
    expect(codeOf(await req('POST', '/v1/online-store/listings/MILK', { action: 'withdraw' }))).toBe('reason_required');
    await ok(req('POST', '/v1/online-store/listings/MILK', { action: 'withdraw', reason: 'test' }), 'withdraw');
    expect(((await ok(req('GET', '/v1/online-store/listings'), 'l3')).body as { listedCount: number }).listedCount).toBe(0);
  }, 120_000);

  it('an online complaint is acknowledged within 48 hours, and one unresolved past a month reaches the owner', async () => {
    const h = harness();
    const T = randomUUID();
    const c = callsFor(() => h, T);
    const { req, ok } = c;
    await seedOnlineShop(h, T, c);
    // Two complaints raised in the app (synthetic history): one five weeks old and never resolved, one three days old
    // never answered, and one raised now.
    const cases = serviceCaseAdapter({ store: h.store, now: () => new Date().toISOString() });
    const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
    for (const [id, opened] of [['app-old', ago(35)], ['app-quiet', ago(3)]] as const) {
      await cases.recordCase(T, id, { caseId: id, tenantId: T, kind: 'complaint', customerRef: CUSTOMER, openedAt: opened, assignedTo: 'service-desk', priority: 'normal', state: 'open', summary: 'synthetic' }, `open|${id}`);
    }
    await ok(req('POST', '/v1/me/complaints/c-now', { summary: 'The milk was warm (synthetic)' }, CUSTOMER), 'complaint now');
    const clock = (await ok(req('GET', '/v1/online-store/complaints'), 'clock')).body as { complaints: { caseId: string; state: string; ownerException: boolean }[]; acknowledgementOverdue: number; ownerExceptions: { caseId: string }[] };
    const st = (id: string) => clock.complaints.find((x) => x.caseId === id)!;
    expect(st('app-c-now').state).toBe('awaiting_acknowledgement');
    expect(st('app-quiet').state).toBe('acknowledgement_overdue');
    expect(st('app-old')).toMatchObject({ state: 'redress_overdue', ownerException: true });
    expect(clock.ownerExceptions.map((x) => x.caseId)).toEqual(['app-old']);
    expect((await req('GET', '/v1/online-store/complaints', undefined, CASHIER)).status).toBe(403);
    // A first reply a person sent acknowledges it.
    await ok(req('POST', '/v1/service/cases/app-quiet/first-response', {}, OWNER), 'first response');
    const again = (await ok(req('GET', '/v1/online-store/complaints'), 'clock 2')).body as { complaints: { caseId: string; state: string }[] };
    expect(again.complaints.find((x) => x.caseId === 'app-quiet')!.state).toBe('acknowledged');
  }, 60_000);
});
