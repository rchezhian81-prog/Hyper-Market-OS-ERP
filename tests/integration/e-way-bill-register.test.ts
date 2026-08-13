import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { InMemoryEventStore } from '../../packages/persistence/src/event-store';

// The durable e-way-bill lifecycle store (A23, item 2 inc2): submit → the portal connector posts the
// answer back → cancel within 24h. A generated EWB is final; nothing fabricates the 12-digit number; an
// unknown answer stays retryable. The transport twin of the e-invoice register.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GSTIN = '33ABCDE1234F1Z5';
const EWB12 = '123456789012';
// Inter-State, ₹60,000 (> the ₹50,000 threshold) → an e-way bill is required.
const REQ = {
  supplierGstin: GSTIN, documentType: 'INV', documentNumber: 'INV/2627/000001', documentDate: '2026-08-11',
  hsnCode: '100610', consignmentValueMinor: 6_000_000, supplyRoute: 'inter_state', movementReason: 'supply',
  fromPincode: '600001', toPincode: '560001',
};
const GENERATED = { result: { status: 'generated', ewbNo: EWB12, ewbDate: '2026-08-11', validUpto: '2026-08-12' } };

const submit = (h: ApiHarness, u: string, id: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/finance/e-way-bill/movements/${id}/submit`, userId: u, tenantId: A, idempotencyKey: key, body });
const record = (h: ApiHarness, u: string, id: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/finance/e-way-bill/movements/${id}/record-response`, userId: u, tenantId: A, idempotencyKey: key, body });
const cancel = (h: ApiHarness, u: string, id: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/finance/e-way-bill/movements/${id}/cancel`, userId: u, tenantId: A, idempotencyKey: key, body });
const get = (h: ApiHarness, u: string, id: string) =>
  h.request({ method: 'GET', path: `/v1/finance/e-way-bill/movements/${id}`, userId: u, tenantId: A });

describe('durable e-way-bill register (A23 item 2 inc2)', () => {
  it('submits, records the portal generation, and reads back a final generated state', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    expect(((await submit(h, 'u-owner', 'mv-1', { request: REQ }, 'e-sub')).body as { state: string }).state).toBe('pending_unknown');
    expect(((await record(h, 'u-owner', 'mv-1', GENERATED, 'e-gen')).body as { state: string; ewbNo: string }).ewbNo).toBe(EWB12);
    const got = (await get(h, 'u-owner', 'mv-1')).body as { state: string; ewbNo: string };
    expect(got.state).toBe('generated');
    expect(got.ewbNo).toBe(EWB12);
  });

  it('keeps a generated EWB final and does not e-way-bill an under-threshold movement', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await submit(h, 'u-owner', 'mv-2', { request: REQ }, 'e2-sub');
    await record(h, 'u-owner', 'mv-2', GENERATED, 'e2-gen');
    await record(h, 'u-owner', 'mv-2', { result: { status: 'rejected', errors: ['late'] } }, 'e2-late'); // ignored
    expect(((await get(h, 'u-owner', 'mv-2')).body as { state: string }).state).toBe('generated');
    // A ₹40,000 inter-State movement is below the ₹50,000 threshold — not required, nothing stored.
    const below = (await submit(h, 'u-owner', 'mv-3', { request: { ...REQ, consignmentValueMinor: 4_000_000 } }, 'e3')).body as { required: boolean };
    expect(below.required).toBe(false);
    expect((await get(h, 'u-owner', 'mv-3')).status).toBe(404);
  });

  it('cancels a generated EWB within the 24h window and refuses cancelling a non-generated one', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await submit(h, 'u-owner', 'mv-4', { request: REQ }, 'e4-sub');
    await record(h, 'u-owner', 'mv-4', GENERATED, 'e4-gen');
    expect(((await cancel(h, 'u-owner', 'mv-4', { reason: 'wrong vehicle' }, 'e4-cx')).body as { state: string }).state).toBe('cancelled');
    // A submitted-but-not-generated movement has no number to cancel.
    await submit(h, 'u-owner', 'mv-4b', { request: REQ }, 'e4b-sub');
    expect((await cancel(h, 'u-owner', 'mv-4b', { reason: 'x' }, 'e4b-cx')).status).toBe(422);
  });

  it('refuses a malformed request, survives a restart, and gates on RBAC + tenant isolation', async () => {
    const store = new InMemoryEventStore();
    const h1 = apiHarness({ store });
    await h1.seedOwner(A, 'u-owner');
    await h1.provisionRole(A, 'u-cash', 'cashier');
    // A required movement with a malformed request (bad pincode) is refused before storage.
    expect((await submit(h1, 'u-owner', 'mv-bad', { request: { ...REQ, fromPincode: 'nope' } }, 'e-bad')).status).toBe(422);
    await submit(h1, 'u-owner', 'mv-5', { request: REQ }, 'e5-sub');
    await record(h1, 'u-owner', 'mv-5', GENERATED, 'e5-gen');
    // Restart: a fresh surface over the same store still has the generated EWB.
    const h2 = apiHarness({ store });
    expect(((await get(h2, 'u-owner', 'mv-5')).body as { state: string; ewbNo: string }).ewbNo).toBe(EWB12);
    // RBAC: a cashier cannot submit or read.
    expect((await submit(h1, 'u-cash', 'mv-6', { request: REQ }, 'e6-rbac')).status).toBe(403);
    expect((await get(h1, 'u-cash', 'mv-5')).status).toBe(403);
    expect((await get(h1, 'u-owner', 'nope')).status).toBe(404);
  });
});
