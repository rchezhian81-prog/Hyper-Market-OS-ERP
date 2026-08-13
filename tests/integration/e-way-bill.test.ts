import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// A23 — the e-way-bill routes: threshold eligibility (inter-State ₹50k / intra-TN ₹1L), validity by
// distance, and the deterministic sandbox portal (build → generate → apply) with no live credentials.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REQUEST = {
  supplierGstin: '33ABCDE1234F1Z5', recipientGstin: '29ZZZZZ9999Z1Z5', documentType: 'INV',
  documentNumber: 'INV/2627/000001', documentDate: '2026-08-12', hsnCode: '100610',
  consignmentValueMinor: 6_000_000, supplyRoute: 'inter_state', movementReason: 'supply',
  fromPincode: '600001', toPincode: '560001',
};
const EWB12 = /^\d{12}$/;

const post = (h: ApiHarness, u: string, path: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path, userId: u, tenantId: A, idempotencyKey: key, body });

describe('e-way-bill routes (A23)', () => {
  it('decides eligibility by route — ₹60,000 needs a bill inter-State but not intra-State', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const inter = (await post(h, 'u-owner', '/v1/finance/e-way-bill/eligibility', { consignmentValueMinor: 6_000_000, supplyRoute: 'inter_state' }, 'e1')).body as { required: boolean };
    const intra = (await post(h, 'u-owner', '/v1/finance/e-way-bill/eligibility', { consignmentValueMinor: 6_000_000, supplyRoute: 'intra_state' }, 'e2')).body as { required: boolean };
    expect(inter.required).toBe(true);
    expect(intra.required).toBe(false);
  });

  it('computes validity by distance', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const v = (await post(h, 'u-owner', '/v1/finance/e-way-bill/validity', { distanceKm: 300, generatedOn: '2026-08-12' }, 'v1')).body as { validityDays: number; validUpto: string };
    expect(v.validityDays).toBe(2);
    expect(v.validUpto).toBe('2026-08-13');
  });

  it('runs the sandbox generate loop end to end (SANDBOX-derived number, never fileable)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const body = (await post(h, 'u-owner', '/v1/finance/e-way-bill/sandbox/generate', { movementId: 'mv-1', request: REQUEST, distanceKm: 300 }, 'g1')).body as {
      sandbox: boolean; eligibility: { required: boolean }; record: { state: string; ewbNo: string }; validity: { validityDays: number };
    };
    expect(body.sandbox).toBe(true);
    expect(body.eligibility.required).toBe(true);
    expect(body.record.state).toBe('generated');
    expect(body.record.ewbNo).toMatch(EWB12);
    expect(body.validity.validityDays).toBe(2);
  });

  it('returns not-required for a below-threshold movement and 422s a malformed request', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const notReq = (await post(h, 'u-owner', '/v1/finance/e-way-bill/sandbox/generate', { movementId: 'mv-2', request: { ...REQUEST, consignmentValueMinor: 1_000_000 } }, 'g2')).body as { required: boolean };
    expect(notReq.required).toBe(false);
    // Eligible but malformed (bad GSTIN) → 422.
    expect((await post(h, 'u-owner', '/v1/finance/e-way-bill/sandbox/generate', { movementId: 'mv-3', request: { ...REQUEST, supplierGstin: 'nope' } }, 'g3')).status).toBe(422);
  });

  it('exercises the unknown path and gates on the GST-portal permission', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier'); // no finance.einvoice.generate
    const unknown = (await post(h, 'u-owner', '/v1/finance/e-way-bill/sandbox/generate', { movementId: 'mv-4', request: REQUEST, force: 'unknown' }, 'g4')).body as { record: { state: string } };
    expect(unknown.record.state).toBe('pending_unknown');
    expect((await post(h, 'u-cash', '/v1/finance/e-way-bill/sandbox/generate', { movementId: 'mv-5', request: REQUEST }, 'g5')).status).toBe(403);
  });
});
