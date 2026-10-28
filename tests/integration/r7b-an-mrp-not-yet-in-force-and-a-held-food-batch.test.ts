import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { r3OpsBackings, tenantClient } from '../support/r3-ops-backings';
import type { ApiHarness } from '../support/api-harness';
import { actionDetails } from '../../services/identity/src/approval-requests';
import { dayFromToday } from '../support/p3-backings';

/**
 * **Round 7 · R7-B — two owner decisions of 28 Oct 2026, through the real routes.**
 *
 *   OB-512  an MRP head office holds that is NOT YET IN FORCE may be replaced with a reason and a second person's approval
 *           through the maker-checker engine (kind `mrp_replacement`, another person who may publish the catalogue); both
 *           versions stay on record (`mrpReplacements` beside the history, and the earlier version on the product's stream).
 *           Without the approval, for an MRP already in force, or approved by the maker — refused by name; the R6 dual-MRP
 *           refusal still applies to anything not approved this way.
 *   OB-513  a held FOOD batch (its department regulated `food`) needs at least one recorded sample before release; a held
 *           non-food batch may be released without one; the store computer's relayed release follows the same rule, and the
 *           held-batch list says, per hold, whether a sample is needed and why.
 * On the in-memory store and — with DATABASE_URL — on real PostgreSQL, with a cold restart. Synthetic data only.
 */

const backings = r3OpsBackings();
const inr = (minor: number) => ({ minor, currency: 'INR' });
const PACKED = { categoryId: 'packed', name: 'Packed household', parentId: null, regulated: ['packed'] };
const FOOD = { categoryId: 'dairy', name: 'Dairy', parentId: null, regulated: ['food'] };
const DETERGENT = {
  sku: 'SKU-DET-512', name: 'Synthetic detergent 1kg', baseUom: 'each', primaryCategoryId: 'packed', taxClass: '34022010', lifecycle: 'draft',
  safety: { netQuantity: '1 kg', packerDetails: 'Synthetic Packers, Chennai', countryOfOrigin: 'India', consumerCareContact: 'Synthetic Care, 1800-000-0000' },
};
const CURD = {
  sku: 'SKU-CURD', name: 'Synthetic curd 400g', baseUom: 'each', primaryCategoryId: 'dairy', taxClass: '04039090', lifecycle: 'draft',
  safety: { allergens: ['milk'], countryOfOrigin: 'India', storageConditions: 'Keep refrigerated at 2-5°C' },
};

describe.each(backings)('R7-B — an MRP not yet in force, and a held food batch — on $name', ({ harness, restart }) => {
  it('OB-512: an MRP not yet in force is replaced only with a reason and a second person\'s approval; both stay on record', async () => {
    let h: ApiHarness = harness();
    const A = randomUUID();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-acct', 'accountant'); // approves catalogue changes (catalogue.tax.approve) — never publishes
    await h.provisionRole(A, 'u-cash', 'cashier');
    const { req, code } = tenantClient(() => h, A);
    const future = dayFromToday(30);
    const past = dayFromToday(-30);
    const body = (mrpHistory: unknown[], extra: Record<string, unknown> = {}) => ({ product: { ...DETERGENT, mrpHistory }, categories: [PACKED], ...extra });
    const publish = (b: Record<string, unknown>, userId = 'u-owner') => req('POST', '/v1/catalogue/products/p-det/publish', b, userId);
    expect((await publish(body([{ value: inr(120_00), effectiveFrom: past }, { value: inr(150_00), effectiveFrom: future }]))).status).toBe(201);

    h = restart(h); // ── COLD RESTART ────────────────────────────────────────────────────────────────────────────────────────

    // B2 still stands: a different MRP for the future date with no replacement asked is refused — and says it MAY be replaced.
    const plain = await publish(body([{ value: inr(120_00), effectiveFrom: past }, { value: inr(140_00), effectiveFrom: future }]));
    expect(plain.status).toBe(422);
    expect(code(plain)).toBe('dual_mrp_rejected');
    expect(JSON.stringify(plain.body)).toContain('not yet in force');

    const reason = 'Supplier reprinted the pack at ₹140 before it reached us';
    const replace = body([{ value: inr(120_00), effectiveFrom: past }, { value: inr(140_00), effectiveFrom: future }], { mrpReplacement: { effectiveFrom: future, reason } });
    // Asked to replace, but nobody approved it: refused by name.
    const unapproved = await publish(replace);
    expect(code(unapproved)).toBe('mrp_replacement_needs_approval');
    // A name typed in is never an approval.
    expect((await publish({ ...replace, approvedBy: 'u-owner' })).status).toBeGreaterThanOrEqual(400);
    // The MRP already in force cannot be replaced at all.
    const inForce = await publish(body([{ value: inr(125_00), effectiveFrom: past }, { value: inr(150_00), effectiveFrom: future }], { mrpReplacement: { effectiveFrom: past, reason } }));
    expect(code(inForce)).toBe('mrp_already_in_force');
    // A short reason is not a reason.
    expect(code(await publish(body([], { mrpReplacement: { effectiveFrom: future, reason: 'typo' } })))).toBe('not_readable_as_an_mrp_replacement');

    // The maker asks; the maker cannot approve their own request; a second person who may publish does.
    const subjectRef = `product:p-det:mrp:${future}`;
    const asked = await req('POST', '/v1/approvals/requests', { kind: 'mrp_replacement', subjectRef, details: actionDetails(replace, { productId: 'p-det' }), valueMinor: null, summary: 'replace the November MRP', reason }, 'u-owner');
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    const requestId = (asked.body as { requestId: string }).requestId;
    // The maker may not approve their own request; a cashier may not approve at all; the accountant does.
    expect((await req('POST', `/v1/approvals/requests/${requestId}/decide`, { decision: 'approved', reason: 'checked the reprint' }, 'u-owner')).status).toBeGreaterThanOrEqual(400);
    expect((await req('POST', `/v1/approvals/requests/${requestId}/decide`, { decision: 'approved', reason: 'checked the reprint' }, 'u-cash')).status).toBeGreaterThanOrEqual(400);
    expect((await req('POST', `/v1/approvals/requests/${requestId}/decide`, { decision: 'approved', reason: 'checked the reprint' }, 'u-acct')).status).toBe(201);
    // A DIFFERENT figure than the one approved is refused (the approval is for exactly this record).
    const changed = await publish({ ...body([{ value: inr(120_00), effectiveFrom: past }, { value: inr(145_00), effectiveFrom: future }], { mrpReplacement: { effectiveFrom: future, reason } }), approvalId: requestId });
    expect(changed.status).toBeGreaterThanOrEqual(400);
    // Exactly what was approved: replaced.
    const done = await publish({ ...replace, approvalId: requestId });
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    expect(done.body).toMatchObject({ mrpReplacement: { effectiveFrom: future, replaced: inr(150_00), replacedBy: inr(140_00), reason, requestedBy: 'u-owner', approvedBy: 'u-acct', approvalId: requestId } });
    // The approval is used once.
    expect((await publish({ ...replace, approvalId: requestId })).status).toBeGreaterThanOrEqual(400);

    h = restart(h); // ── COLD RESTART ────────────────────────────────────────────────────────────────────────────────────────

    // Both versions on record: the new MRP in the history, the replaced one beside it with its reason and both people.
    const read = (await req('GET', '/v1/catalogue/products/p-det')).body as { product: { mrpHistory: { value: { minor: number }; effectiveFrom: string }[]; mrpReplacements: unknown[] } };
    expect(read.product.mrpHistory).toEqual([{ value: inr(120_00), effectiveFrom: past }, { value: inr(140_00), effectiveFrom: future }]);
    expect(read.product.mrpReplacements).toEqual([expect.objectContaining({ effectiveFrom: future, replaced: inr(150_00), replacedBy: inr(140_00), approvedBy: 'u-acct' })]);
    // The record keeps the replacement on every later publish (never taken from the body).
    expect((await publish(body([{ value: inr(120_00), effectiveFrom: past }, { value: inr(140_00), effectiveFrom: future }], { product: { ...DETERGENT, mrpHistory: [{ value: inr(120_00), effectiveFrom: past }, { value: inr(140_00), effectiveFrom: future }], mrpReplacements: [] } }))).status).toBe(201);
    const again = (await req('GET', '/v1/catalogue/products/p-det')).body as { product: { mrpReplacements: unknown[] } };
    expect(again.product.mrpReplacements).toHaveLength(1);
  }, 120_000);

  it('OB-513: a held food batch needs a recorded sample before release; a non-food batch does not; the relayed release and the list say the same', async () => {
    let h: ApiHarness = harness();
    const A = randomUUID();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-qc', 'store_manager');
    await h.provisionRole(A, 'u-box', 'store_computer', ['S1']);
    const { req, code } = tenantClient(() => h, A);
    expect((await req('POST', '/v1/catalogue/products/p-curd/publish', { product: CURD, categories: [FOOD] })).status).toBe(201);
    expect((await req('POST', '/v1/catalogue/products/p-det/publish', { product: { ...DETERGENT, mrpHistory: [{ value: inr(120_00), effectiveFrom: '2026-01-01' }] }, categories: [PACKED] })).status).toBe(201);
    for (const [b, p] of [['B-CURD', 'p-curd'], ['B-DET', 'p-det'], ['B-CURD-2', 'p-curd'], ['B-GHOST', 'p-not-on-master']] as const) {
      expect((await req('POST', `/v1/quality/holds/${b}`, { productId: p, reason: 'chiller ran warm overnight' })).status).toBe(201);
    }

    // The held list says, per hold, whether a sample is needed and why.
    const list = (await req('GET', '/v1/quality/holds-for-release', undefined, 'u-box')).body as { holds: { batchId: string; sampleRule: { required: boolean; because: string } }[] };
    const rule = (b: string) => list.holds.find((x) => x.batchId === b)?.sampleRule;
    expect(rule('B-CURD')).toMatchObject({ required: true, because: 'food' });
    expect(rule('B-DET')).toMatchObject({ required: false, because: 'not_food' });
    expect(rule('B-GHOST')).toMatchObject({ required: true, because: 'food_not_known' });

    // Food, no sample: refused by name; nothing released.
    const noSample = await req('POST', '/v1/quality/holds/B-CURD/release', {}, 'u-qc');
    expect(noSample.status).toBe(422);
    expect(code(noSample)).toBe('sample_required');
    // Non-food: released without a sample.
    expect((await req('POST', '/v1/quality/holds/B-DET/release', {}, 'u-qc')).status).toBe(200);
    // A pending sample still waits; a pass releases it.
    expect((await req('POST', '/v1/quality/holds/B-CURD/samples/s-1', { test: 'smell and texture', result: 'pending' })).status).toBe(201);
    expect(code(await req('POST', '/v1/quality/holds/B-CURD/release', {}, 'u-qc'))).toBe('sample_pending');
    expect((await req('POST', '/v1/quality/holds/B-CURD/samples/s-1', { result: 'pass' })).status).toBe(200);

    // The store computer's relayed release follows the same rule: food with no sample is refused (kept as an exception).
    const relayed = await req('POST', '/v1/quality/holds/B-CURD-2/release/synced', { batchId: 'B-CURD-2', storeId: 'S1', releasedBy: 'u-qc', at: new Date().toISOString(), source: 'facilities-screen' }, 'u-box');
    expect(relayed.status, JSON.stringify(relayed.body)).toBe(422);
    expect(code(relayed)).toBe('sample_required');

    h = restart(h); // ── COLD RESTART ────────────────────────────────────────────────────────────────────────────────────────

    expect((await req('POST', '/v1/quality/holds/B-CURD/release', {}, 'u-qc')).status).toBe(200);
    const one = (await req('GET', '/v1/quality/holds/B-CURD-2')).body as { hold: { status: string }; sampleRule: { required: boolean } };
    expect(one).toMatchObject({ hold: { status: 'held' }, sampleRule: { required: true } });
  }, 120_000);
});
