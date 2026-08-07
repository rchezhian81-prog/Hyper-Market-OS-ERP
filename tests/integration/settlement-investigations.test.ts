import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Settlement investigations, end to end through the real API (M14-FR-03, API-09). An exception the
// review surfaces becomes a case that is OWNED by a named person with a due date, gathers evidence
// (append-only, never edited — hard rule #6), and closes ONLY with an outcome and a note — writing
// money off needs a second person (§28). This proves the wired investigation lifecycle — a mutable
// aggregate reconstructed from its events — against the real pipeline and real per-tenant RBAC.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FUTURE = '2027-12-31';

const ex = (over: Record<string, unknown> = {}) => ({ finding: 'overdue_settlement', ref: 'PAY-LATE', valueMinor: 30_000, needsInvestigation: true, detail: 'late', ...over });

const open = (h: ApiHarness, tenantId: string, userId: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: '/v1/settlement/investigations', userId, tenantId, idempotencyKey: `open-${body['investigationId']}`, body });

const attach = (h: ApiHarness, tenantId: string, userId: string, id: string, ref: string, key: string) =>
  h.request({ method: 'POST', path: `/v1/settlement/investigations/${id}/evidence`, userId, tenantId, idempotencyKey: key, body: { ref } });

const resolve = (h: ApiHarness, tenantId: string, userId: string, id: string, body: Record<string, unknown>, key: string) =>
  h.request({ method: 'POST', path: `/v1/settlement/investigations/${id}/resolve`, userId, tenantId, idempotencyKey: key, body });

const list = (h: ApiHarness, tenantId: string, userId: string, date: string) =>
  h.request({ method: 'GET', path: '/v1/settlement/investigations', userId, tenantId, query: { date } });

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const openCase = (h: ApiHarness, tenantId: string, userId: string, id: string, over: Record<string, unknown> = {}) =>
  open(h, tenantId, userId, { investigationId: id, exception: ex(), ownerId: 'u-owner', dueBy: FUTURE, ...over });

interface Ev { evidenceRefs: string[] }
interface ListBody { open: { investigationId: string }[]; ageing: { count: number }[] }

describe('a settlement exception becomes an owned, evidenced, outcome-closed case (M14-FR-03)', () => {
  it('opens on a real problem, and refuses a not-a-problem', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    expect((await openCase(h, A, 'u-owner', 'INV-1')).status).toBe(201);
    // An awaiting-settlement tender is not late — opening a case on it trains people to close cases
    // without reading them.
    const notAProblem = await open(h, A, 'u-owner', { investigationId: 'INV-2', exception: ex({ needsInvestigation: false }), ownerId: 'u-owner', dueBy: FUTURE });
    expect(codeOf(notAProblem)).toBe('not_a_problem');
  });

  it('needs a named owner and a due date that is not already past', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    expect(codeOf(await openCase(h, A, 'u-owner', 'INV-1', { ownerId: '   ' }))).toBe('needs_a_named_owner');
    expect(codeOf(await openCase(h, A, 'u-owner', 'INV-2', { dueBy: '2020-01-01' }))).toBe('due_date_in_the_past');
  });

  it('gathers evidence append-only — a document is never added twice, never removed', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await openCase(h, A, 'u-owner', 'INV-1');

    expect(((await attach(h, A, 'u-owner', 'INV-1', 'provider-reply.pdf', 'e1')).body as Ev).evidenceRefs).toEqual(['provider-reply.pdf']);
    expect(((await attach(h, A, 'u-owner', 'INV-1', 'bank-statement.pdf', 'e2')).body as Ev).evidenceRefs).toEqual(['provider-reply.pdf', 'bank-statement.pdf']);
    // Re-attaching the same document (a new request, distinct transport key) collapses.
    expect(((await attach(h, A, 'u-owner', 'INV-1', 'provider-reply.pdf', 'e3')).body as Ev).evidenceRefs).toEqual(['provider-reply.pdf', 'bank-statement.pdf']);
  });

  it('closes only with an outcome and a note, and cannot be closed twice', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await openCase(h, A, 'u-owner', 'INV-1');

    expect(codeOf(await resolve(h, A, 'u-owner', 'INV-1', { outcome: 'timing_only', note: '' }, 'r0'))).toBe('needs_a_note');
    const done = await resolve(h, A, 'u-owner', 'INV-1', { outcome: 'timing_only', note: 'provider settles at T+3, our cycle was set to T+2' }, 'r1');
    expect(done.status).toBe(200);
    expect((done.body as { state: string; feedback?: string }).state).toBe('resolved');
    // A second close is refused — a resolved case is not reopened by another resolve.
    expect(codeOf(await resolve(h, A, 'u-owner', 'INV-1', { outcome: 'till_error', note: 'changed my mind' }, 'r2'))).toBe('already_resolved');
  });

  it('writing money off needs a second person (§28)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-acct', 'accountant');
    await openCase(h, A, 'u-owner', 'INV-1'); // opened by u-owner

    // The person who raised it cannot also write it off.
    expect(codeOf(await resolve(h, A, 'u-owner', 'INV-1', { outcome: 'written_off', note: 'unrecoverable' }, 'r1'))).toBe('write_off_needs_a_second_person');
    // A different person can.
    expect((await resolve(h, A, 'u-acct', 'INV-1', { outcome: 'written_off', note: 'unrecoverable, approved' }, 'r2')).status).toBe(200);
  });

  it('lists open cases with ageing, and a resolved case drops off the open list', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await openCase(h, A, 'u-owner', 'INV-1');
    await openCase(h, A, 'u-owner', 'INV-2', { exception: ex({ ref: 'PAY-SHORT', finding: 'short_settled', valueMinor: 1_000 }) });
    await resolve(h, A, 'u-owner', 'INV-1', { outcome: 'provider_error_recovered', note: 'provider re-ran the batch' }, 'r1');

    const body = (await list(h, A, 'u-owner', FUTURE)).body as ListBody;
    expect(body.open.map((i) => i.investigationId)).toEqual(['INV-2']); // INV-1 resolved
    expect(body.ageing).toHaveLength(4);
    expect(body.ageing.reduce((s, b) => s + b.count, 0)).toBe(1); // one open case across the buckets
  });

  it('is authorized and per-tenant', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');
    await openCase(h, A, 'u-owner', 'INV-1');

    expect((await openCase(h, A, 'u-cash', 'INV-X')).status).toBe(403); // no manage permission
    expect((await list(h, A, 'u-cash', FUTURE)).status).toBe(403);       // no review.read permission

    await h.seedOwner(B, 'u-owner-b');
    expect(((await list(h, B, 'u-owner-b', FUTURE)).body as ListBody).open).toEqual([]); // A's case did not leak
  });
});
