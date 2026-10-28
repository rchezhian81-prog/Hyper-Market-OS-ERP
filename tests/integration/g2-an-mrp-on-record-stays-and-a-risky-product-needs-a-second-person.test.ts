import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { r3OpsBackings, tenantClient } from '../support/r3-ops-backings';
import type { ApiHarness } from '../support/api-harness';
import { actionDetails } from '../../services/identity/src/approval-requests';
import { dayFromToday } from '../support/p3-backings';

/**
 * **Two owner decisions on the product publish, through the real route.**
 *
 *   OB-512 · B2  head office's HELD MRP history is the truth. A publish may only ADD an MRP with a new date. An MRP on record
 *                that a publish leaves out — or sends with another figure — is refused by name, so nobody can drop an MRP in
 *                one publish and send a different one for its date in the next (the two-step bypass). An MRP not yet in
 *                force is still REPLACED the one approved way (`mrpReplacement` + a second person's approval), as before.
 *   OB-503       only risky new products need a second person before reaching the tills: a product reaching the tills
 *                age-restricted or regulated (or newly made so) needs another person's approval of exactly that record
 *                (kind `regulated_product_publish`, checker `catalogue.tax.approve`); the maker can never approve it; an
 *                ordinary new product is published by one person.
 * On the in-memory store and — with DATABASE_URL — on real PostgreSQL, with a cold restart. Synthetic data only.
 */

const backings = r3OpsBackings();
const inr = (minor: number) => ({ minor, currency: 'INR' });
const PACKED = { categoryId: 'packed', name: 'Packed household', parentId: null, regulated: ['packed'] };
const RESTRICTED = { categoryId: 'restricted', name: 'Age-restricted drinks', parentId: null, regulated: ['age_restricted'] };
const DETERGENT = {
  sku: 'SKU-DET-G2', name: 'Synthetic detergent 1kg', baseUom: 'each', primaryCategoryId: 'packed', taxClass: '34022010', lifecycle: 'draft',
  safety: { netQuantity: '1 kg', packerDetails: 'Synthetic Packers, Chennai', countryOfOrigin: 'India', consumerCareContact: 'Synthetic Care, 1800-000-0000' },
};
const ENERGY = { sku: 'SKU-ENERGY-G2', name: 'Synthetic energy drink 250ml', baseUom: 'each', primaryCategoryId: 'restricted', taxClass: '22029920', lifecycle: 'draft', safety: { minimumAge: 18 } };

describe.each(backings)('G2 — an MRP on record stays, and a risky product needs a second person — on $name', ({ harness, restart }) => {
  it('OB-512 · B2: an MRP on record cannot be dropped and then re-sent with another figure — not yet in force, nor in force; the approved replacement still works', async () => {
    let h: ApiHarness = harness();
    const A = randomUUID();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-acct', 'accountant');
    const { req, code } = tenantClient(() => h, A);
    const future = dayFromToday(30);
    const later = dayFromToday(60);
    const past = dayFromToday(-30);
    const body = (mrpHistory: unknown[], extra: Record<string, unknown> = {}) => ({ product: { ...DETERGENT, mrpHistory }, categories: [PACKED], ...extra });
    const publish = (b: Record<string, unknown>, userId = 'u-owner') => req('POST', '/v1/catalogue/products/p-det/publish', b, userId);
    const mrps = async () => ((await req('GET', '/v1/catalogue/products/p-det')).body as { product: { mrpHistory: unknown[] } }).product.mrpHistory;
    const ON_RECORD = [{ value: inr(120_00), effectiveFrom: past }, { value: inr(150_00), effectiveFrom: future }];
    expect((await publish(body(ON_RECORD))).status).toBe(201);

    h = restart(h); // ── COLD RESTART ────────────────────────────────────────────────────────────────────────────────────────

    // Step 1 of the bypass: the MRP not yet in force is left out — refused by name, with the approved way to replace it.
    const dropFuture = await publish(body([{ value: inr(120_00), effectiveFrom: past }]));
    expect(dropFuture.status, JSON.stringify(dropFuture.body)).toBe(409);
    expect(code(dropFuture)).toBe('mrp_on_record_not_kept');
    expect(JSON.stringify(dropFuture.body)).toContain(`₹150.00 taking effect on ${future}`);
    expect(JSON.stringify(dropFuture.body)).toContain('mrp_replacement');
    // Step 2 of the bypass is therefore judged against the MRP still on record — a different figure for that date is refused.
    const reSet = await publish(body([{ value: inr(120_00), effectiveFrom: past }, { value: inr(140_00), effectiveFrom: future }]));
    expect(reSet.status).toBeGreaterThanOrEqual(400);
    expect(await mrps()).toEqual(ON_RECORD);

    // The same trick on the MRP already in force: leaving it out is refused, and it says the price moves only with a later date.
    const dropInForce = await publish(body([{ value: inr(150_00), effectiveFrom: future }]));
    expect(dropInForce.status).toBe(409);
    expect(code(dropInForce)).toBe('mrp_on_record_not_kept');
    expect(JSON.stringify(dropInForce.body)).toContain(`₹120.00 taking effect on ${past}`);
    expect(JSON.stringify(dropInForce.body)).toContain('already in force');
    const reSetInForce = await publish(body([{ value: inr(99_00), effectiveFrom: past }, { value: inr(150_00), effectiveFrom: future }]));
    expect(reSetInForce.status).toBeGreaterThanOrEqual(400);
    // Leaving the whole history out is the same as leaving each MRP out.
    const noHistory = await publish({ product: DETERGENT, categories: [PACKED] });
    expect(code(noHistory)).toBe('mrp_on_record_not_kept');
    expect(await mrps()).toEqual(ON_RECORD);

    // Adding an MRP with a NEW date (a normal price move) still passes, by one person.
    const added = await publish(body([...ON_RECORD, { value: inr(160_00), effectiveFrom: later }]));
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    const WITH_LATER = [...ON_RECORD, { value: inr(160_00), effectiveFrom: later }];
    expect(await mrps()).toEqual(WITH_LATER);

    // The approved replacement of an MRP not yet in force works exactly as before — and drops nothing else.
    const reason = 'Supplier reprinted the pack at ₹140 before it reached us';
    const NEW = [{ value: inr(120_00), effectiveFrom: past }, { value: inr(140_00), effectiveFrom: future }, { value: inr(160_00), effectiveFrom: later }];
    const replace = body(NEW, { mrpReplacement: { effectiveFrom: future, reason } });
    expect(code(await publish(replace))).toBe('mrp_replacement_needs_approval');
    const asked = await req('POST', '/v1/approvals/requests', { kind: 'mrp_replacement', subjectRef: `product:p-det:mrp:${future}`, details: actionDetails(replace, { productId: 'p-det' }), valueMinor: null, summary: 'replace the MRP', reason }, 'u-owner');
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    const requestId = (asked.body as { requestId: string }).requestId;
    expect((await req('POST', `/v1/approvals/requests/${requestId}/decide`, { decision: 'approved', reason: 'checked the reprint' }, 'u-acct')).status).toBe(201);
    // A replacement that ALSO drops another MRP on record is refused — the approval covers one date, not the rest.
    const replaceAndDrop = body([{ value: inr(120_00), effectiveFrom: past }, { value: inr(140_00), effectiveFrom: future }], { mrpReplacement: { effectiveFrom: future, reason } });
    expect((await publish({ ...replaceAndDrop, approvalId: requestId })).status).toBeGreaterThanOrEqual(400);
    const done = await publish({ ...replace, approvalId: requestId });
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    expect(done.body).toMatchObject({ mrpReplacement: { effectiveFrom: future, replaced: inr(150_00), replacedBy: inr(140_00), approvedBy: 'u-acct' } });

    h = restart(h); // ── COLD RESTART ────────────────────────────────────────────────────────────────────────────────────────

    expect(await mrps()).toEqual(NEW);
    // After the replacement the held history is the new truth: sending the OLD figure back is refused too.
    expect((await publish(body(WITH_LATER))).status).toBeGreaterThanOrEqual(400);
    expect((await publish(body(NEW))).status).toBe(201);
  }, 120_000);

  it('OB-503: an age-restricted new product needs another person\'s approval of exactly that record; the maker cannot approve it; an ordinary product is published by one person', async () => {
    let h: ApiHarness = harness();
    const A = randomUUID();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-acct', 'accountant'); // approves catalogue changes (catalogue.tax.approve)
    await h.provisionRole(A, 'u-cash', 'cashier');
    const { req, code } = tenantClient(() => h, A);
    const drink = { product: ENERGY, categories: [RESTRICTED] };
    const publishDrink = (b: Record<string, unknown>, userId = 'u-owner') => req('POST', '/v1/catalogue/products/p-energy/publish', b, userId);

    // An ordinary new product: one person, as before.
    const ordinary = await req('POST', '/v1/catalogue/products/p-det/publish', { product: { ...DETERGENT, mrpHistory: [{ value: inr(120_00), effectiveFrom: '2026-01-01' }] }, categories: [PACKED] });
    expect(ordinary.status, JSON.stringify(ordinary.body)).toBe(201);
    expect(ordinary.body).not.toHaveProperty('regulatedApproval');
    // The owner narrowed OB-503 (28 Oct 2026) to an age limit and tobacco: a new perishable (milk) still keeps its till check
    // but is published by one person, with no second-person approval asked.
    const milk = await req('POST', '/v1/catalogue/products/p-milk/publish', {
      product: { sku: 'MILK-500-G2', name: 'Milk 500ml', baseUom: 'ea', primaryCategoryId: 'dairy', taxClass: '0401', lifecycle: 'active', safety: { perishable: true } },
      categories: [{ categoryId: 'dairy', name: 'Dairy', parentId: null }],
    });
    expect(milk.status, JSON.stringify(milk.body)).toBe(201);
    expect(milk.body).not.toHaveProperty('regulatedApproval');

    // The risky one without an approval: refused by name, in plain words, nothing saved.
    const alone = await publishDrink(drink);
    expect(alone.status).toBe(422);
    expect(code(alone)).toBe('regulated_product_needs_second_person');
    expect(JSON.stringify(alone.body)).toContain('a minimum age to buy it');
    expect(JSON.stringify(alone.body)).toContain('second person');
    expect((await req('GET', '/v1/catalogue/products/p-energy')).status).toBe(404);
    // A name typed in is never an approval.
    expect((await publishDrink({ ...drink, approvedBy: 'u-acct' })).status).toBeGreaterThanOrEqual(400);

    // The maker asks for exactly this record — and cannot approve it themselves; a cashier cannot approve at all.
    const asked = await req('POST', '/v1/approvals/requests', { kind: 'regulated_product_publish', subjectRef: 'product:p-energy', details: actionDetails(drink, { productId: 'p-energy' }), valueMinor: null, summary: 'new energy drink, 18+', reason: 'new line from the distributor' }, 'u-owner');
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    const requestId = (asked.body as { requestId: string }).requestId;
    const self = await req('POST', `/v1/approvals/requests/${requestId}/decide`, { decision: 'approved', reason: 'I checked it myself' }, 'u-owner');
    expect(self.status).toBeGreaterThanOrEqual(400);
    expect((await req('POST', `/v1/approvals/requests/${requestId}/decide`, { decision: 'approved', reason: 'checked' }, 'u-cash')).status).toBeGreaterThanOrEqual(400);
    // Still not approved by anyone else: naming the request publishes nothing.
    expect((await publishDrink({ ...drink, approvalId: requestId })).status).toBeGreaterThanOrEqual(400);
    expect((await req('GET', '/v1/catalogue/products/p-energy')).status).toBe(404);

    h = restart(h); // ── COLD RESTART ────────────────────────────────────────────────────────────────────────────────────────

    expect((await req('POST', `/v1/approvals/requests/${requestId}/decide`, { decision: 'approved', reason: 'licence and age label checked' }, 'u-acct')).status).toBe(201);
    // A DIFFERENT record than the one approved (a lower age) is refused — the approval is for exactly this record.
    expect((await publishDrink({ product: { ...ENERGY, safety: { minimumAge: 16 } }, categories: [RESTRICTED], approvalId: requestId })).status).toBeGreaterThanOrEqual(400);
    const done = await publishDrink({ ...drink, approvalId: requestId });
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    expect(done.body).toMatchObject({ regulatedApproval: { regulated: ['minimumAge'], approvedBy: 'u-acct', approvalId: requestId } });
    // Its age limit is now on the tills: a later publish carrying the SAME limit puts nothing new there, so it is not asked again.
    expect((await publishDrink(drink)).body).not.toHaveProperty('regulatedApproval');

    h = restart(h); // ── COLD RESTART ────────────────────────────────────────────────────────────────────────────────────────

    // Already on the tills with its age limit: an unrelated re-publish (a new MRP date) is one person again.
    const again = await publishDrink({ product: { ...ENERGY, mrpHistory: [{ value: inr(40_00), effectiveFrom: '2026-01-01' }] }, categories: [RESTRICTED] });
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect(again.body).not.toHaveProperty('regulatedApproval');

    // An ordinary product on sale NEWLY made age-restricted needs the second person too.
    const madeRisky = await req('POST', '/v1/catalogue/products/p-det/publish', {
      product: { ...DETERGENT, lifecycle: 'active', mrpHistory: [{ value: inr(120_00), effectiveFrom: '2026-01-01' }], safety: { ...DETERGENT.safety, minimumAge: 18 } }, categories: [PACKED],
    });
    expect(code(madeRisky)).toBe('regulated_product_needs_second_person');
  }, 120_000);
});
