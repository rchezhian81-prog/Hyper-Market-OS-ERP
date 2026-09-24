import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// API-04 M10-FR-02 — the cloud quality hold/release register. M10-FR-02's flow ends "… → hold/release",
// its §28 permission is "quality release by authorized QC", and its acceptance is "quality-held stock is
// not sellable until released". This wires the tested `releaseFromQualityHold` engine over a durable,
// append-only hold register: a hold is a fact, a release is another, and release is REFUSED for a failed
// or outstanding sample, a cold-chain breach, an expired batch or an unnamed releaser. Nothing is ever
// overwritten (hard rule #2/#6); the current state folds from the stream and survives a restart.
//
// Scope: the cloud governance register. The at-till, offline sale-block half of the acceptance clause is
// carried on the signed pack like the recall block (M10-FR-04) and is a separate slice — not claimed here.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

const placeHold = (h: ApiHarness, user: string, batchId: string, body: unknown, key?: string) =>
  h.request({ method: 'POST', path: `/v1/quality/holds/${batchId}`, userId: user, tenantId: A, idempotencyKey: key ?? `hold-${batchId}`, body });
const release = (h: ApiHarness, user: string, batchId: string, body: unknown) =>
  h.request({ method: 'POST', path: `/v1/quality/holds/${batchId}/release`, userId: user, tenantId: A, idempotencyKey: `rel-${batchId}-${Math.random()}`, body });
const listHolds = (h: ApiHarness, user: string) =>
  h.request({ method: 'GET', path: '/v1/quality/holds', userId: user, tenantId: A });
const getHold = (h: ApiHarness, user: string, batchId: string) =>
  h.request({ method: 'GET', path: `/v1/quality/holds/${batchId}`, userId: user, tenantId: A });

const sample = (batchId: string, result: 'pass' | 'fail' | 'pending') => ({
  sampleId: `s-${batchId}-${result}`, batchId, takenBy: 'u-qc', takenAt: '2026-08-07T09:00:00.000Z', test: 'listeria', result,
});

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager');
  await h.provisionRole(A, 'u-cash', 'cashier');
  return h;
}

describe('quality hold/release register (M10-FR-02)', () => {
  it('places a hold, lists it, and reads it back', async () => {
    const h = await cast();
    const placed = await placeHold(h, 'u-owner', 'b-1', { productId: 'p-milk', reason: 'awaiting listeria result' });
    expect(placed.status).toBe(201);
    expect(placed.body).toMatchObject({ hold: { batchId: 'b-1', productId: 'p-milk', status: 'held', heldBy: 'u-owner', reason: 'awaiting listeria result' } });

    const list = await listHolds(h, 'u-owner');
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ count: 1, heldCount: 1 });

    const one = await getHold(h, 'u-mgr', 'b-1');
    expect(one.status).toBe(200);
    expect((one.body as { hold: { status: string } }).hold.status).toBe('held');
  });

  it('releases a clean batch for sale — the release names the QC and the time (§28)', async () => {
    const h = await cast();
    await placeHold(h, 'u-owner', 'b-2', { productId: 'p-cheese', reason: 'routine sampling' });
    const res = await release(h, 'u-mgr', 'b-2', { samples: [sample('b-2', 'pass')] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ release: { released: true, outcome: 'released', hold: { status: 'released', releasedBy: 'u-mgr' } } });
    expect((res.body as { release: { hold: { releasedAt?: string } } }).release.hold.releasedAt).toBeTruthy();

    expect((await getHold(h, 'u-owner', 'b-2')).body).toMatchObject({ hold: { status: 'released' } });
    expect((await listHolds(h, 'u-owner')).body).toMatchObject({ heldCount: 0 });
  });

  it('refuses release on a FAILED sample and the hold stands', async () => {
    const h = await cast();
    await placeHold(h, 'u-owner', 'b-3', { productId: 'p-chicken', reason: 'sampling' });
    const res = await release(h, 'u-mgr', 'b-3', { samples: [sample('b-3', 'fail')] });
    expect(res.status).toBe(422);
    expect(codeOf(res)).toBe('sample_failed');
    // Refused → nothing appended: the batch is still held.
    expect((await getHold(h, 'u-owner', 'b-3')).body).toMatchObject({ hold: { status: 'held' } });
  });

  it('refuses release on an OUTSTANDING sample', async () => {
    const h = await cast();
    await placeHold(h, 'u-owner', 'b-4', { productId: 'p-fish', reason: 'sampling' });
    const res = await release(h, 'u-mgr', 'b-4', { samples: [sample('b-4', 'pending')] });
    expect(res.status).toBe(422);
    expect(codeOf(res)).toBe('sample_pending');
  });

  it('refuses release on a cold-chain breach — the evidence stands', async () => {
    const h = await cast();
    await placeHold(h, 'u-owner', 'b-5', { productId: 'p-icecream', reason: 'freezer alarm' });
    const res = await release(h, 'u-mgr', 'b-5', {
      samples: [sample('b-5', 'pass')],
      coldChain: { batchId: 'b-5', productId: 'p-icecream', severity: 'breach', peakTenthsC: 90, minutesOutOfRange: 240, quarantine: true, detail: 'freezer at 9°C for four hours — beyond grace', evidence: [] },
    });
    expect(res.status).toBe(422);
    expect(codeOf(res)).toBe('cold_chain_breach');
  });

  it('refuses release of an expired batch', async () => {
    const h = await cast();
    await placeHold(h, 'u-owner', 'b-6', { productId: 'p-yoghurt', reason: 'sampling' });
    const res = await release(h, 'u-mgr', 'b-6', { samples: [sample('b-6', 'pass')], expiresOn: '2020-01-01' });
    expect(res.status).toBe(422);
    expect(codeOf(res)).toBe('expired');
  });

  it('404s a release for a batch that was never held, and 404s an unknown hold read', async () => {
    const h = await cast();
    expect((await release(h, 'u-mgr', 'ghost', { samples: [] })).status).toBe(404);
    expect((await getHold(h, 'u-owner', 'ghost')).status).toBe(404);
  });

  it('gates placing on quality.hold.manage and releasing on quality.hold.release', async () => {
    const h = await cast();
    expect((await placeHold(h, 'u-cash', 'b-7', { productId: 'p-x', reason: 'r' })).status).toBe(403);
    await placeHold(h, 'u-owner', 'b-7', { productId: 'p-x', reason: 'r' });
    expect((await release(h, 'u-cash', 'b-7', { samples: [sample('b-7', 'pass')] })).status).toBe(403);
    // And a cashier cannot even read the register.
    expect((await listHolds(h, 'u-cash')).status).toBe(403);
  });

  it('does not double-hold — a second hold on an already-held batch is one effect', async () => {
    const h = await cast();
    expect((await placeHold(h, 'u-owner', 'b-8', { productId: 'p-x', reason: 'first' })).status).toBe(201);
    const again = await placeHold(h, 'u-owner', 'b-8', { productId: 'p-x', reason: 'second' }, 'hold-b-8-again');
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ alreadyHeld: true, hold: { reason: 'first' } });
  });

  it('refuses to release a batch that is already released', async () => {
    const h = await cast();
    await placeHold(h, 'u-owner', 'b-9', { productId: 'p-x', reason: 'r' });
    expect((await release(h, 'u-mgr', 'b-9', { samples: [sample('b-9', 'pass')] })).status).toBe(200);
    const again = await release(h, 'u-mgr', 'b-9', { samples: [sample('b-9', 'pass')] });
    expect(again.status).toBe(409);
    expect(codeOf(again)).toBe('not_held');
  });

  it('is durable and restart-safe — the register folds from the append-only stream after a restart', async () => {
    const h = await cast();
    await placeHold(h, 'u-owner', 'b-10', { productId: 'p-x', reason: 'r' });
    await release(h, 'u-mgr', 'b-10', { samples: [sample('b-10', 'pass')] });

    // A fresh surface over the SAME event store — a process restart. State is not in memory; it folds.
    const restarted = apiHarness({ store: h.store });
    const one = await restarted.request({ method: 'GET', path: '/v1/quality/holds/b-10', userId: 'u-owner', tenantId: A });
    expect(one.status).toBe(200);
    expect((one.body as { hold: { status: string; releasedBy?: string } }).hold).toMatchObject({ status: 'released', releasedBy: 'u-mgr' });
  });
});
