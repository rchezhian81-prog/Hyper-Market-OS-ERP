import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { InMemoryEventStore } from '../../packages/persistence/src/event-store';

// E-invoice reconciliation (owner directive item 2): poll a stuck invoice to recover a lost
// acknowledgement, and an exception queue that surfaces the invoices needing attention. Sandbox only —
// the IRN is still only ever what the (simulated) IRP returned; live GSP verification is externally blocked.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OVER = 6_000_000_000;
const GSTIN = '33ABCDE1234F1Z5';
const INVOICE = {
  documentType: 'Tax Invoice', supplierGstin: GSTIN, invoiceNumber: 'INV/2627/000001', invoiceDate: '2026-08-11',
  hsnCode: '100610', taxableMinor: 100000, rateBps: 500, placeOfSupply: 'intra_state', taxComponents: ['CGST', 'SGST'],
};
const b2b = (n: string) => ({ invoice: { ...INVOICE, invoiceNumber: `INV/2627/${n}` }, annualTurnoverMinor: OVER, supplyType: 'b2b', recipientGstin: GSTIN, documentType: 'INV' });

const submit = (h: ApiHarness, u: string, id: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/finance/e-invoice/invoices/${id}/submit`, userId: u, tenantId: A, idempotencyKey: key, body });
const record = (h: ApiHarness, u: string, id: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/finance/e-invoice/invoices/${id}/record-response`, userId: u, tenantId: A, idempotencyKey: key, body });
const poll = (h: ApiHarness, u: string, id: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/finance/e-invoice/invoices/${id}/poll`, userId: u, tenantId: A, idempotencyKey: key, body });
const get = (h: ApiHarness, u: string, id: string) =>
  h.request({ method: 'GET', path: `/v1/finance/e-invoice/invoices/${id}`, userId: u, tenantId: A });
const queue = (h: ApiHarness, u: string, state?: string) =>
  h.request({ method: 'GET', path: '/v1/finance/e-invoice/register', userId: u, tenantId: A, ...(state !== undefined ? { query: { state } } : {}) });
const verify = (h: ApiHarness, u: string, id: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/finance/e-invoice/invoices/${id}/verify`, userId: u, tenantId: A, idempotencyKey: key, body });
const ids = (b: unknown) => ((b as { invoices: { invoiceId: string }[] }).invoices).map((i) => i.invoiceId).sort();

describe('e-invoice poll — acknowledgement recovery', () => {
  it('recovers a pending_unknown invoice by re-querying the sandbox', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await submit(h, 'u-owner', 'inv-u', b2b('000001'), 'u-sub');
    // A timeout answer leaves it pending_unknown (the IRN status is unknown, not e-invoiced yet).
    await record(h, 'u-owner', 'inv-u', { result: { status: 'unknown', reason: 'gateway timeout' } }, 'u-unk');
    expect(((await get(h, 'u-owner', 'inv-u')).body as { state: string }).state).toBe('pending_unknown');
    // Polling re-queries and resolves it to registered (the portal did have it).
    const polled = (await poll(h, 'u-owner', 'inv-u', {}, 'u-poll')).body as { polled: boolean; current: { state: string; irn: string } };
    expect(polled.polled).toBe(true);
    expect(polled.current.state).toBe('registered');
    expect(polled.current.irn).toMatch(/^[0-9a-f]{64}$/);
  });

  it('resolves a never-answered submission, and simulates timeout/outage staying unresolved', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await submit(h, 'u-owner', 'inv-s', b2b('000002'), 's-sub');
    // Forced timeout keeps it unknown; forced rejection classifies it; a natural poll then registers.
    expect(((await poll(h, 'u-owner', 'inv-s', { sandbox: { forceOutcome: 'unknown' } }, 's-t')).body as { current: { state: string } }).current.state).toBe('pending_unknown');
    expect(((await poll(h, 'u-owner', 'inv-s', { sandbox: { forceOutcome: 'rejected', rejectReasons: ['portal outage'] } }, 's-o')).body as { current: { state: string } }).current.state).toBe('rejected');
  });

  it('is a safe no-op on a terminal invoice (no duplicate registration)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await submit(h, 'u-owner', 'inv-t', b2b('000003'), 't-sub');
    const first = (await poll(h, 'u-owner', 'inv-t', {}, 't-p1')).body as { current: { state: string; irn: string } };
    expect(first.current.state).toBe('registered');
    const irn = first.current.irn;
    const again = (await poll(h, 'u-owner', 'inv-t', {}, 't-p2')).body as { polled: boolean; current: { irn: string } };
    expect(again.polled).toBe(false); // terminal — nothing re-queried
    expect(again.current.irn).toBe(irn); // the IRN is unchanged (no second registration)
  });
});

describe('e-invoice exception queue', () => {
  async function seedMix(h: ApiHarness): Promise<void> {
    await h.seedOwner(A, 'u-owner');
    // registered
    await submit(h, 'u-owner', 'inv-reg', b2b('000010'), 'm1'); await poll(h, 'u-owner', 'inv-reg', {}, 'm1p');
    // pending_unknown
    await submit(h, 'u-owner', 'inv-unk', b2b('000011'), 'm2'); await record(h, 'u-owner', 'inv-unk', { result: { status: 'unknown', reason: 't/o' } }, 'm2u');
    // rejected
    await submit(h, 'u-owner', 'inv-rej', b2b('000012'), 'm3'); await record(h, 'u-owner', 'inv-rej', { result: { status: 'rejected', errors: ['bad GSTIN'] } }, 'm3r');
    // submitted (in-flight, not an exception)
    await submit(h, 'u-owner', 'inv-sub', b2b('000013'), 'm4');
  }

  it('lists exceptions (unknown + rejected + error) and separates registered / in-flight', async () => {
    const h = apiHarness();
    await seedMix(h);
    expect(((await queue(h, 'u-owner')).body as { count: number }).count).toBe(4);
    const exc = (await queue(h, 'u-owner', 'exceptions')).body as { invoices: { invoiceId: string }[] };
    expect(exc.invoices.map((i) => i.invoiceId).sort()).toEqual(['inv-rej', 'inv-unk']);
    expect(((await queue(h, 'u-owner', 'registered')).body as { invoices: { invoiceId: string }[] }).invoices.map((i) => i.invoiceId)).toEqual(['inv-reg']);
    expect(((await queue(h, 'u-owner', 'processing')).body as { invoices: { invoiceId: string }[] }).invoices.map((i) => i.invoiceId)).toEqual(['inv-sub']);
  });

  it('survives a restart, and gates on RBAC + tenant isolation', async () => {
    const store = new InMemoryEventStore();
    const h1 = apiHarness({ store });
    await seedMix(h1);
    await h1.provisionRole(A, 'u-cash', 'cashier');
    // Restart: a fresh surface over the same store still folds the queue.
    const h2 = apiHarness({ store });
    expect(((await queue(h2, 'u-owner')).body as { count: number }).count).toBe(4);
    // RBAC: a cashier cannot read the queue or poll.
    expect((await queue(h1, 'u-cash')).status).toBe(403);
    expect((await poll(h1, 'u-cash', 'inv-unk', {}, 'rbac-poll')).status).toBe(403);
    // Tenant isolation: another tenant's queue is empty.
    const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    await h1.seedOwner(B, 'u-b');
    expect(((await h1.request({ method: 'GET', path: '/v1/finance/e-invoice/register', userId: 'u-b', tenantId: B })).body as { count: number }).count).toBe(0);
  });
});

// --- verify + mismatch detection (item 2 inc4) --------------------------------------------------------

const DIFF_IRN = 'a'.repeat(64); // a well-formed but DIFFERENT IRN than the sandbox would issue

describe('e-invoice verify — mismatch detection (rule #10: never a silent overwrite)', () => {
  it('agrees when the portal re-query returns the same IRN, and flags nothing', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await submit(h, 'u-owner', 'v-ok', b2b('000020'), 'v1');
    const irn = ((await poll(h, 'u-owner', 'v-ok', {}, 'v1p')).body as { current: { irn: string } }).current.irn;
    const res = (await verify(h, 'u-owner', 'v-ok', {}, 'v1v')).body as { agrees: boolean; current: { irn: string; mismatch?: unknown } };
    expect(res.agrees).toBe(true);
    expect(res.current.irn).toBe(irn);        // unchanged
    expect(res.current.mismatch).toBeUndefined();
  });

  it('flags a portal rejection of a registered invoice WITHOUT overwriting the stored IRN', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await submit(h, 'u-owner', 'v-rej', b2b('000021'), 'v2');
    const irn = ((await poll(h, 'u-owner', 'v-rej', {}, 'v2p')).body as { current: { irn: string } }).current.irn;
    const res = (await verify(h, 'u-owner', 'v-rej', { sandbox: { forceOutcome: 'rejected' } }, 'v2v')).body as { agrees: boolean; mismatch: { observedState: string }; current: { state: string; irn: string; mismatch?: unknown } };
    expect(res.agrees).toBe(false);
    expect(res.mismatch.observedState).toBe('rejected');
    expect(res.current.state).toBe('registered');   // state unchanged — still terminal
    expect(res.current.irn).toBe(irn);              // stored IRN unchanged
    expect(res.current.mismatch).toBeDefined();     // flagged for a human
    // It now sits in the mismatch queue (and exceptions), and NOT in the clean registered list.
    expect(ids((await queue(h, 'u-owner', 'mismatch')).body)).toEqual(['v-rej']);
    expect(ids((await queue(h, 'u-owner', 'exceptions')).body)).toEqual(['v-rej']);
    expect(ids((await queue(h, 'u-owner', 'registered')).body)).toEqual([]);
  });

  it('flags a DIFFERENT IRN via a connector observation, refuses verifying an in-flight invoice, and gates RBAC', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');
    await submit(h, 'u-owner', 'v-diff', b2b('000022'), 'v3');
    const irn = ((await poll(h, 'u-owner', 'v-diff', {}, 'v3p')).body as { current: { irn: string } }).current.irn;
    const res = (await verify(h, 'u-owner', 'v-diff', { observed: { status: 'registered', irn: DIFF_IRN, signedQr: 'QR', ackNo: 'ACK', ackDate: '2026-08-11' } }, 'v3v')).body as { agrees: boolean; mismatch: { observedIrn: string }; current: { irn: string } };
    expect(res.agrees).toBe(false);
    expect(res.mismatch.observedIrn).toBe(DIFF_IRN);
    expect(res.current.irn).toBe(irn);              // the differing IRN is NOT written — the original stands
    // Verify only applies to a terminal invoice — an in-flight one points you at poll.
    await submit(h, 'u-owner', 'v-inflight', b2b('000023'), 'v4');
    await record(h, 'u-owner', 'v-inflight', { result: { status: 'unknown', reason: 't/o' } }, 'v4u');
    expect((await verify(h, 'u-owner', 'v-inflight', {}, 'v4v')).status).toBe(422);
    // RBAC: a cashier cannot verify (it re-queries the portal).
    expect((await verify(h, 'u-cash', 'v-diff', {}, 'v-rbac')).status).toBe(403);
  });
});
