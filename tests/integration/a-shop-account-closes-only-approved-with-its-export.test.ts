import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';
import { askForApproval, decide } from '../support/approval-request';
import { actionDetails } from '../../services/identity/src/approval-requests';
import { STREAM, streamName } from '../../services/api/src/adapters';
import { seedGenesisOwner } from '../../services/api/src/access';
import { OWNER_ROLE_ID } from '../../services/api/src/roles';

// M36-FR-03 · D12-FR-05 · R8-2: "on closure, access revoked, legally-required records retained"; "closure is
// governed/approved"; "never delete audit evidence" (#6). The export a person takes is recorded; closure needs a complete
// one, is asked by IT and approved by the owner; it revokes every grant in the same write and deletes nothing. Through the
// real API, in memory and — with DATABASE_URL — on real PostgreSQL, with cold restarts. Synthetic data only.

const backings = useRestartableBackings();
type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;

describe.each(backings)('a shop\'s account closes only approved, with its export, and keeps the law\'s records — on $name', ({ harness }) => {
  it('readiness; export recorded; IT asks, the owner approves; access ends for everyone; nothing deleted; no re-genesis', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-it', 'platform_admin');
    await h.provisionRole(T, 'u-cash', 'cashier');
    await h.provisionRole(T, 'u-box', 'store_computer', ['B1']);
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Record<string, unknown>> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r.body as Record<string, unknown>; };
    // A legal hold the closure must keep.
    await ok(call('POST', '/v1/audit/legal-holds', 'u-owner', { holdId: 'HOLD-1', reason: 'consumer forum case 12/2026' }), 'hold');

    // Readiness before any export: the blocker named; what would be kept, and until when.
    const ready = await ok(call('GET', '/v1/platform/tenant/closure', 'u-it'), 'readiness') as { state: string; exportReady: boolean; blockers: string[]; wouldRetain: { what: string; untilDate: string }[] };
    expect([ready.state, ready.exportReady]).toEqual(['active', false]);
    expect(ready.blockers[0]).toContain('no export has been taken');
    const until = new Date(); until.setUTCMonth(until.getUTCMonth() + 96);
    expect(ready.wouldRetain.map((r) => r.what)).toEqual(['records under legal hold HOLD-1 (consumer forum case 12/2026)', 'books of account, tax invoices and GST records', 'audit evidence']);
    expect(ready.wouldRetain[1]!.untilDate.slice(0, 7)).toBe(until.toISOString().slice(0, 7)); // 8 years: the Companies Act, the longest statute
    expect(ready.wouldRetain[2]!.untilDate).toBe('indefinitely');
    expect((await call('GET', '/v1/platform/tenant/closure', 'u-cash')).status).toBe(403);

    const reason = { reason: 'the shop has stopped trading and moved to another system' };
    expect(codeOf(await call('POST', '/v1/platform/tenant/closure', 'u-it', { reason: 'no' }))).toBe('reason_required');
    expect(codeOf(await call('POST', '/v1/platform/tenant/closure', 'u-it', reason))).toBe('export_not_taken');
    expect((await call('POST', '/v1/platform/tenant/closure', 'u-owner', reason)).status).toBe(403); // the owner approves; IT asks
    expect((await call('POST', '/v1/platform/tenant/closure', 'u-cash', reason)).status).toBe(403);

    // The shop takes its complete export; the export is recorded (manifest only).
    const exp = await ok(call('GET', '/v1/platform/export', 'u-it'), 'export') as { export: { complete: boolean; exportId: string } };
    expect(exp.export.complete).toBe(true);
    h = harness(h); // ── COLD RESTART ──
    expect(await ok(call('GET', '/v1/platform/tenant/closure', 'u-it'), 'readiness')).toMatchObject({ exportReady: true, blockers: [], latestExport: { exportId: exp.export.exportId, complete: true, requestedBy: 'u-it' } });

    // No approval: refused, nothing spent. IT asks; IT cannot approve its own; a cashier cannot; the owner approves.
    expect(codeOf(await call('POST', '/v1/platform/tenant/closure', 'u-it', reason))).toBe('closure_needs_owner_approval');
    const ask = await askForApproval(h, T, 'u-it', { kind: 'tenant_closure', subjectRef: `tenant:${T}`, details: actionDetails(reason) });
    expect(ask.status, JSON.stringify(ask.body)).toBe(201);
    const requestId = (ask.body as { requestId: string }).requestId;
    expect((await decide(h, T, 'u-it', requestId)).status).toBeGreaterThanOrEqual(400);
    expect((await decide(h, T, 'u-cash', requestId)).status).toBe(403);
    expect((await decide(h, T, 'u-owner', requestId)).status).toBe(201);
    // The approval is of exactly this reason: another reason is refused.
    expect((await call('POST', '/v1/platform/tenant/closure', 'u-it', { reason: 'a different reason entirely', approvalId: requestId })).status).toBeGreaterThanOrEqual(400);

    const trail = streamName(STREAM.audit, 'domain-trail');
    const before = { audit: (await h.store.readStream(T, trail)).length, all: (await h.store.exportTenant(T)).length };
    const closed = await ok(call('POST', '/v1/platform/tenant/closure', 'u-it', { ...reason, approvalId: requestId }), 'close') as { closed: boolean; accessRevoked: boolean; closure: { approvedBy: string; askedBy: string; grantsRevoked: number; retained: { what: string }[] } };
    expect([closed.closed, closed.accessRevoked, closed.closure.approvedBy, closed.closure.askedBy, closed.closure.grantsRevoked]).toEqual([true, true, 'u-owner', 'u-it', 4]);
    expect(closed.closure.retained.map((r) => r.what)).toContain('audit evidence');

    h = harness(h); // ── COLD RESTART ──
    // Access has ended for every person and the store computer — on every route.
    for (const who of ['u-owner', 'u-it', 'u-cash']) expect((await call('GET', '/v1/platform/tenant/closure', who)).status, who).toBe(403);
    expect((await call('GET', '/v1/platform/export', 'u-owner')).status).toBe(403);
    expect((await h.request({ method: 'GET', path: '/v1/store-packs/B1', userId: 'u-box', tenantId: T, branchId: 'B1' })).status).toBe(403);
    // Nothing was deleted: every record is still there, the audit trail grew (the closure itself is in it).
    const after = { audit: (await h.store.readStream(T, trail)).length, all: (await h.store.exportTenant(T)).length };
    expect(after.all).toBeGreaterThan(before.all);
    expect(after.audit).toBeGreaterThanOrEqual(before.audit);
    expect((await h.store.readStream(T, streamName(STREAM.platform, 'tenant-lifecycle'), { type: 'TenantClosed' }))).toHaveLength(1);
    // A closed shop cannot be re-opened through the genesis path.
    expect(await seedGenesisOwner(h.store, OWNER_ROLE_ID, T, 'u-intruder', new Date().toISOString())).toBe('already_bootstrapped');
    expect((await call('GET', '/v1/platform/tenant/closure', 'u-intruder')).status).toBe(403);
  }, 120_000);
});
