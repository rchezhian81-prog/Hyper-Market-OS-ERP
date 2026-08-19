import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// M10-FR-04: the durable cloud recall record. Initiating a recall is idempotent (a batch already under
// recall is one effect); a recall closes ONLY with an evidence reference (a recall closed with nothing is a
// recall nobody did, P-04); and closing RETAINS the full record, never deletes it (hard rule #6). The
// lifecycle is event-sourced (RecallInitiated / RecallClosed), so it survives a restart and the whole
// history is on the append-only record. Initiating/closing is gated quality.recall.initiate (Compliance/
// Owner, §28); reads are quality.recall.read. The recall BLOCK at the till is carried on the signed pack.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const recallOf = (res: { body: unknown }): { status?: string; evidenceRef?: string | null; initiatedBy?: string; closedBy?: string | null } =>
  (res.body as { recall?: Record<string, unknown> }).recall ?? {};

const initiate = (h: ApiHarness, u: string, batchId: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/quality/recalls/${batchId}`, userId: u, tenantId: A, idempotencyKey: key, body });
const close = (h: ApiHarness, u: string, batchId: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/quality/recalls/${batchId}/closure`, userId: u, tenantId: A, idempotencyKey: key, body });
const list = (h: ApiHarness, u: string) =>
  h.request({ method: 'GET', path: '/v1/quality/recalls', userId: u, tenantId: A });
const read = (h: ApiHarness, u: string, batchId: string) =>
  h.request({ method: 'GET', path: `/v1/quality/recalls/${batchId}`, userId: u, tenantId: A });

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager'); // compliance-capable: may initiate + read
  await h.provisionRole(A, 'u-cash', 'cashier');      // neither
  return h;
}

describe('recall lifecycle (M10-FR-04)', () => {
  it('initiates a recall, names who started it, and reads it back as open', async () => {
    const h = await cast();
    const res = await initiate(h, 'u-owner', 'b-listeria', { reason: 'supplier listeria alert' }, 'k1');
    expect(res.status).toBe(201);
    expect(recallOf(res)).toMatchObject({ status: 'open', initiatedBy: 'u-owner' });
    expect(recallOf(await read(h, 'u-mgr', 'b-listeria'))).toMatchObject({ status: 'open' });
  });

  it('is idempotent: re-initiating an already-open recall is one effect', async () => {
    const h = await cast();
    await initiate(h, 'u-owner', 'b1', { reason: 'x' }, 'k1');
    const again = await initiate(h, 'u-owner', 'b1', { reason: 'x' }, 'k2');
    expect(again.status).toBe(200);
    expect((again.body as { alreadyOpen?: boolean }).alreadyOpen).toBe(true);
    // Still exactly one recall on the list.
    expect((await list(h, 'u-owner')).body).toMatchObject({ count: 1, openCount: 1 });
  });

  it('closes ONLY with evidence, and the closed record is retained (never deleted)', async () => {
    const h = await cast();
    await initiate(h, 'u-owner', 'b2', { reason: 'x' }, 'k1');
    // No evidence → refused.
    const noEv = await close(h, 'u-owner', 'b2', {}, 'k2');
    expect(noEv.status).toBe(422);
    expect(codeOf(noEv)).toBe('recall_needs_evidence');
    // With evidence → closed, and the record still exists with the evidence retained.
    const closed = await close(h, 'u-owner', 'b2', { evidenceRef: 'RUNBOOK-2026-08/collected+notified' }, 'k3');
    expect(closed.status).toBe(200);
    expect(recallOf(closed)).toMatchObject({ status: 'closed', closedBy: 'u-owner', evidenceRef: 'RUNBOOK-2026-08/collected+notified' });
    expect(recallOf(await read(h, 'u-owner', 'b2'))).toMatchObject({ status: 'closed' }); // retained
  });

  it('refuses to close a batch with no open recall (never recalled, or already closed)', async () => {
    const h = await cast();
    // Never recalled → nothing open to close.
    expect((await close(h, 'u-owner', 'never', { evidenceRef: 'e' }, 'k1')).status).toBe(409);
    await initiate(h, 'u-owner', 'b3', { reason: 'x' }, 'k2');
    await close(h, 'u-owner', 'b3', { evidenceRef: 'e1' }, 'k3');
    // Already closed → 409, and the record is not edited.
    const twice = await close(h, 'u-owner', 'b3', { evidenceRef: 'e2' }, 'k4');
    expect(twice.status).toBe(409);
    expect(codeOf(twice)).toBe('no_open_recall_to_close');
    expect(recallOf(await read(h, 'u-owner', 'b3'))).toMatchObject({ evidenceRef: 'e1' }); // unchanged
  });

  it('allows a NEW recall on a batch whose earlier one is closed; the list puts open first', async () => {
    const h = await cast();
    await initiate(h, 'u-owner', 'b4', { reason: 'first' }, 'k1');
    await close(h, 'u-owner', 'b4', { evidenceRef: 'e1' }, 'k2');
    // A fresh recall re-opens the block.
    const reopened = await initiate(h, 'u-owner', 'b4', { reason: 'second, different lot code' }, 'k3');
    expect(reopened.status).toBe(201);
    expect(recallOf(reopened)).toMatchObject({ status: 'open', reason: 'second, different lot code' } as Record<string, unknown>);
    // Another closed recall + this open one: the list shows the open one first.
    await initiate(h, 'u-owner', 'b5', { reason: 'y' }, 'k4');
    await close(h, 'u-owner', 'b5', { evidenceRef: 'e2' }, 'k5');
    const l = await list(h, 'u-owner');
    const recalls = (l.body as { recalls: { batchId: string; status: string }[] }).recalls;
    expect(recalls[0]).toMatchObject({ status: 'open' }); // nothing is more urgent than an open recall
    expect((l.body as { openCount: number }).openCount).toBe(1);
  });

  it('gates initiation on quality.recall.initiate: a cashier cannot start or close a recall', async () => {
    const h = await cast();
    await initiate(h, 'u-owner', 'b6', { reason: 'x' }, 'k1');
    // A store manager (compliance-capable) may initiate.
    expect((await initiate(h, 'u-mgr', 'b7', { reason: 'x' }, 'k2')).status).toBe(201);
    // A cashier may do neither.
    expect((await initiate(h, 'u-cash', 'b8', { reason: 'x' }, 'k3')).status).toBe(403);
    expect((await close(h, 'u-cash', 'b6', { evidenceRef: 'e' }, 'k4')).status).toBe(403);
    // Malformed: no reason.
    expect(codeOf(await initiate(h, 'u-owner', 'b9', {}, 'k5'))).toBe('not_readable_as_a_recall');
    // An unknown recall reads 404.
    expect((await read(h, 'u-owner', 'nope')).status).toBe(404);
  });

  it('survives a restart: the recall record is rebuilt from the event store', async () => {
    const h = await cast();
    await initiate(h, 'u-owner', 'b10', { reason: 'x' }, 'k1');
    await close(h, 'u-owner', 'b10', { evidenceRef: 'e' }, 'k2');
    // A fresh harness over the SAME store is a cold start — the register folds from events.
    const restarted = apiHarness({ store: h.store });
    expect(recallOf(await read(restarted, 'u-owner', 'b10'))).toMatchObject({ status: 'closed', evidenceRef: 'e' });
    // And a still-open recall stays blocking after the restart.
    await initiate(restarted, 'u-owner', 'b11', { reason: 'y' }, 'k3');
    const restartedAgain = apiHarness({ store: h.store });
    expect(recallOf(await read(restartedAgain, 'u-owner', 'b11'))).toMatchObject({ status: 'open' });
  });
});
