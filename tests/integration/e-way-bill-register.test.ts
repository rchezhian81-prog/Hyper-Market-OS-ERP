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

// --- reconciliation: poll + exception queue (item 2 inc3) --------------------------------------------

const poll = (h: ApiHarness, u: string, id: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/finance/e-way-bill/movements/${id}/poll`, userId: u, tenantId: A, idempotencyKey: key, body });
const verify = (h: ApiHarness, u: string, id: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/finance/e-way-bill/movements/${id}/verify`, userId: u, tenantId: A, idempotencyKey: key, body });
const queue = (h: ApiHarness, u: string, state?: string) =>
  h.request({ method: 'GET', path: '/v1/finance/e-way-bill/register', userId: u, tenantId: A, ...(state !== undefined ? { query: { state } } : {}) });
const stateOf = async (h: ApiHarness, id: string) => ((await get(h, 'u-owner', id)).body as { state: string }).state;
const mvIds = (b: unknown) => ((b as { movements: { movementId: string }[] }).movements).map((m) => m.movementId).sort();

describe('e-way-bill reconciliation — poll + exception queue', () => {
  it('polls a stuck (pending_unknown) movement to a generated e-way bill', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await submit(h, 'u-owner', 'pv-1', { request: REQ }, 'pv1-sub'); // lands pending_unknown
    expect(await stateOf(h, 'pv-1')).toBe('pending_unknown');
    const polled = (await poll(h, 'u-owner', 'pv-1', {}, 'pv1-poll')).body as { polled: boolean; current: { state: string; ewbNo: string } };
    expect(polled.polled).toBe(true);
    expect(polled.current.state).toBe('generated');
    expect(polled.current.ewbNo).toMatch(/^\d{12}$/);
    // A poll on the now-terminal movement is a safe no-op (no second number).
    expect(((await poll(h, 'u-owner', 'pv-1', {}, 'pv1-poll2')).body as { polled: boolean }).polled).toBe(false);
  });

  it('simulates a timeout staying unknown and an outage classifying rejected', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await submit(h, 'u-owner', 'pv-2', { request: REQ }, 'pv2-sub');
    expect(((await poll(h, 'u-owner', 'pv-2', { sandbox: { forceOutcome: 'unknown' } }, 'pv2-t')).body as { current: { state: string } }).current.state).toBe('pending_unknown');
    expect(((await poll(h, 'u-owner', 'pv-2', { sandbox: { forceOutcome: 'rejected', rejectReasons: ['portal outage'] } }, 'pv2-o')).body as { current: { state: string } }).current.state).toBe('rejected');
  });

  it('lists the exception queue — unknown + rejected need attention, generated is separate', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');
    await submit(h, 'u-owner', 'q-gen', { request: { ...REQ, documentNumber: 'INV/2627/000010' } }, 'qg'); await poll(h, 'u-owner', 'q-gen', {}, 'qgp');
    await submit(h, 'u-owner', 'q-unk', { request: { ...REQ, documentNumber: 'INV/2627/000011' } }, 'qu'); // pending_unknown, not polled
    await submit(h, 'u-owner', 'q-rej', { request: { ...REQ, documentNumber: 'INV/2627/000012' } }, 'qr'); await poll(h, 'u-owner', 'q-rej', { sandbox: { forceOutcome: 'rejected' } }, 'qrp');
    expect(((await queue(h, 'u-owner')).body as { count: number }).count).toBe(3);
    const exc = (await queue(h, 'u-owner', 'exceptions')).body as { movements: { movementId: string }[] };
    expect(exc.movements.map((m) => m.movementId).sort()).toEqual(['q-rej', 'q-unk']);
    expect(((await queue(h, 'u-owner', 'generated')).body as { movements: { movementId: string }[] }).movements.map((m) => m.movementId)).toEqual(['q-gen']);
    // Read-gated + tenant-isolated.
    expect((await queue(h, 'u-cash')).status).toBe(403);
    const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    await h.seedOwner(B, 'u-b');
    expect(((await h.request({ method: 'GET', path: '/v1/finance/e-way-bill/register', userId: 'u-b', tenantId: B })).body as { count: number }).count).toBe(0);
  });
});

// --- verify + mismatch detection (item 2 inc4) --------------------------------------------------------

const DIFF_EWB = '999999999999'; // a well-formed but DIFFERENT 12-digit number than the sandbox would issue

describe('e-way-bill verify — mismatch detection (rule #10: never a silent overwrite)', () => {
  it('agrees when the portal re-query returns the same number, and flags nothing', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await submit(h, 'u-owner', 'mv-vok', { request: REQ }, 'vok');
    const ewbNo = ((await poll(h, 'u-owner', 'mv-vok', {}, 'vokp')).body as { current: { ewbNo: string } }).current.ewbNo;
    const res = (await verify(h, 'u-owner', 'mv-vok', {}, 'vokv')).body as { agrees: boolean; current: { ewbNo: string; mismatch?: unknown } };
    expect(res.agrees).toBe(true);
    expect(res.current.ewbNo).toBe(ewbNo);
    expect(res.current.mismatch).toBeUndefined();
  });

  it('flags a portal rejection of a generated movement WITHOUT overwriting the stored number', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await submit(h, 'u-owner', 'mv-vrej', { request: { ...REQ, documentNumber: 'INV/2627/000030' } }, 'vrej');
    const ewbNo = ((await poll(h, 'u-owner', 'mv-vrej', {}, 'vrejp')).body as { current: { ewbNo: string } }).current.ewbNo;
    const res = (await verify(h, 'u-owner', 'mv-vrej', { sandbox: { forceOutcome: 'rejected' } }, 'vrejv')).body as { agrees: boolean; mismatch: { observedState: string }; current: { state: string; ewbNo: string; mismatch?: unknown } };
    expect(res.agrees).toBe(false);
    expect(res.mismatch.observedState).toBe('rejected');
    expect(res.current.state).toBe('generated');   // state unchanged — still terminal
    expect(res.current.ewbNo).toBe(ewbNo);          // stored number unchanged
    expect(res.current.mismatch).toBeDefined();
    // It now sits in the mismatch queue (and exceptions), and NOT in the clean generated list.
    expect(mvIds((await queue(h, 'u-owner', 'mismatch')).body)).toEqual(['mv-vrej']);
    expect(mvIds((await queue(h, 'u-owner', 'exceptions')).body)).toEqual(['mv-vrej']);
    expect(mvIds((await queue(h, 'u-owner', 'generated')).body)).toEqual([]);
  });

  it('flags a DIFFERENT number via a connector observation, refuses verifying an in-flight movement, and gates RBAC', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');
    await submit(h, 'u-owner', 'mv-vdiff', { request: { ...REQ, documentNumber: 'INV/2627/000031' } }, 'vdiff');
    const ewbNo = ((await poll(h, 'u-owner', 'mv-vdiff', {}, 'vdiffp')).body as { current: { ewbNo: string } }).current.ewbNo;
    const res = (await verify(h, 'u-owner', 'mv-vdiff', { observed: { status: 'generated', ewbNo: DIFF_EWB, ewbDate: '2026-08-11', validUpto: '2026-08-12' } }, 'vdiffv')).body as { agrees: boolean; mismatch: { observedEwbNo: string }; current: { ewbNo: string } };
    expect(res.agrees).toBe(false);
    expect(res.mismatch.observedEwbNo).toBe(DIFF_EWB);
    expect(res.current.ewbNo).toBe(ewbNo);          // the differing number is NOT written
    // Verify only applies to a terminal movement — an in-flight one points you at poll.
    await submit(h, 'u-owner', 'mv-vinflight', { request: { ...REQ, documentNumber: 'INV/2627/000032' } }, 'vinf'); // pending_unknown
    expect((await verify(h, 'u-owner', 'mv-vinflight', {}, 'vinfv')).status).toBe(422);
    // RBAC: a cashier cannot verify (it re-queries the portal).
    expect((await verify(h, 'u-cash', 'mv-vdiff', {}, 'v-rbac')).status).toBe(403);
  });
});
