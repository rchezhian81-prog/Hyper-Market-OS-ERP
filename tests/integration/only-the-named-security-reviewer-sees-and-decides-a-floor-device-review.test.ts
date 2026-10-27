import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';
import { askForApproval, decide } from '../support/approval-request';
import { nameSecurityReviewer, switchFloorDeviceOn } from '../support/floor-device-switch';
import { actionDetails } from '../../services/identity/src/approval-requests';

/**
 * OB-420 (owner, 27 Oct 2026, in writing — option B), through the real API on the in-memory store AND (with DATABASE_URL)
 * real PostgreSQL, head office restarted cold: a `floor_device_review` request (the security reviewer's signature on
 * switching on cameras, shelf labels, RFID or sensors, OB-407) is seen and decided ONLY by the security reviewer named NOW
 * (OB-330). A store manager or the owner — who may read the risk register — does not see it and is refused by name if they
 * try it by id, nothing recorded. When the owner names someone else, the new reviewer decides and the old one is refused;
 * a signature the old one gave before the change still does not count at switch-on. With nobody named the asker is told
 * nobody can decide it (P-08). The full camera switch-on still works end to end. Synthetic data only.
 */

const backings = useRestartableBackings();
type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
interface Row { requestId: string; kind: string; status: string; decider?: { role: string; named: boolean; userId?: string; displayName?: string; whatToDo?: string } }
interface Inbox { waitingForMe: Row[]; mine: Row[] }

describe.each(backings)('only the named security reviewer sees and decides a floor-device review (OB-420) — on $name', ({ harness }) => {
  it('nobody named → asker told; manager and owner never see it and are refused; reviewer decides; re-named → new decides, old refused; switch-on end to end', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-it', 'platform_admin');
    await h.provisionRole(T, 'u-siva', 'security_reviewer');
    await h.provisionRole(T, 'u-kala', 'security_reviewer');
    let n = 0;
    const call = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: `k-${n++}-${randomUUID()}` }), ...(body === undefined ? {} : { body }) });
    const inbox = async (who: string): Promise<Inbox> => { const r = await call('GET', '/v1/approvals/requests', who); expect(r.status).toBe(200); return r.body as Inbox; };
    const waitingIds = async (who: string): Promise<string[]> => (await inbox(who)).waitingForMe.map((r) => r.requestId);
    expect((await call('POST', '/v1/org/nodes/C1', 'u-it', { kind: 'company', name: 'SRE Retail' })).status).toBeLessThan(300);
    expect((await call('POST', '/v1/org/nodes/B1', 'u-it', { kind: 'branch', name: 'Main store', parentId: 'C1', companyId: 'C1' })).status).toBeLessThan(300);

    const on = { branchId: 'B1', enabled: true, reason: 'camera events trial in B1' };
    const subjectRef = 'rollout:cctv:B1';
    const details = actionDetails(on, { key: 'cctv' });
    const ask = async (): Promise<{ requestId: string; decider?: Row['decider'] }> => {
      const r = await askForApproval(h, T, 'u-it', { kind: 'floor_device_review', subjectRef, details });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return r.body as { requestId: string; decider?: Row['decider'] };
    };

    // ── No reviewer named: the asker is told nobody can decide it, and nobody may ──
    const early = await ask();
    expect(early.decider).toMatchObject({ role: 'security_reviewer', named: false });
    expect(early.decider?.whatToDo).toContain('No security reviewer is named');
    expect((await inbox('u-it')).mine.find((r) => r.requestId === early.requestId)).toMatchObject({ status: 'waiting', decider: { role: 'security_reviewer', named: false } });
    for (const who of ['u-owner', 'u-mgr', 'u-siva', 'u-kala']) {
      expect(await waitingIds(who), who).not.toContain(early.requestId);
      expect(codeOf(await decide(h, T, who, early.requestId)), who).toBe('name_the_security_reviewer_first');
    }

    // ── The owner names u-siva: the waiting request is now theirs alone ──
    await nameSecurityReviewer(h, T, 'u-owner', 'u-siva', 'Mr Sivakumar');
    h = harness(h); // ── cold restart ──
    expect((await inbox('u-it')).mine.find((r) => r.requestId === early.requestId)?.decider).toMatchObject({ named: true, userId: 'u-siva', displayName: 'Mr Sivakumar' });
    expect(await waitingIds('u-siva')).toContain(early.requestId);
    for (const who of ['u-owner', 'u-mgr', 'u-kala']) expect(await waitingIds(who), who).not.toContain(early.requestId);
    // The store manager tries it by id: refused by name, nothing recorded.
    const mgrTry = await decide(h, T, 'u-mgr', early.requestId);
    expect(mgrTry.status).toBe(403);
    expect(codeOf(mgrTry)).toBe('only_the_named_security_reviewer_decides');
    expect(codeOf(await decide(h, T, 'u-owner', early.requestId, 'rejected'))).toBe('only_the_named_security_reviewer_decides');
    expect((await inbox('u-it')).mine.find((r) => r.requestId === early.requestId)?.status).toBe('waiting');
    // The named reviewer decides it; the asker sees it approved.
    expect((await decide(h, T, 'u-siva', early.requestId)).status).toBe(201);
    expect((await inbox('u-it')).mine.find((r) => r.requestId === early.requestId)).toMatchObject({ status: 'approved', decidedBy: 'u-siva' });

    // ── The owner names u-kala instead: the new reviewer decides, the old one is refused ──
    const pending = await ask();
    expect(pending.decider).toMatchObject({ named: true, userId: 'u-siva' });
    await nameSecurityReviewer(h, T, 'u-owner', 'u-kala', 'Mrs Kala');
    h = harness(h); // ── cold restart ──
    expect(await waitingIds('u-siva')).not.toContain(pending.requestId);
    expect(await waitingIds('u-kala')).toContain(pending.requestId);
    expect(codeOf(await decide(h, T, 'u-siva', pending.requestId))).toBe('only_the_named_security_reviewer_decides');
    expect((await decide(h, T, 'u-kala', pending.requestId)).status).toBe(201);

    // The rollout still judges at switch-on: u-siva's earlier signature no longer counts once u-kala is named.
    const ownerAsk = await askForApproval(h, T, 'u-it', { kind: 'flag_change', subjectRef, details });
    const ownerId = (ownerAsk.body as { requestId: string }).requestId;
    expect((await decide(h, T, 'u-owner', ownerId)).status).toBe(201);
    expect(codeOf(await call('PUT', '/v1/platform/rollout/cctv', 'u-it', { ...on, approvalId: ownerId, reviewApprovalId: early.requestId }))).toBe('not_the_named_security_reviewer');
    // …while u-kala's signature does: the full camera switch-on, end to end.
    const switched = await call('PUT', '/v1/platform/rollout/cctv', 'u-it', { ...on, approvalId: ownerId, reviewApprovalId: pending.requestId });
    expect(switched.status, JSON.stringify(switched.body)).toBe(200);
    expect(switched.body).toMatchObject({ change: { enabled: true, approvedBy: 'u-owner', reviewedBy: 'u-kala' }, now: { on: true } });

    // And the helper the other suites use (ask both, owner + named reviewer approve, switch) still goes through.
    expect((await call('PUT', '/v1/platform/rollout/cctv', 'u-it', { branchId: 'B1', enabled: false, reason: 'notice not up yet' })).status).toBe(200);
    const again = await switchFloorDeviceOn(h, T, { switcher: 'u-it', owner: 'u-owner', reviewer: 'u-kala' }, 'cctv', { branchId: 'B1', reason: 'notice is up' });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body).toMatchObject({ change: { enabled: true, reviewedBy: 'u-kala' } });
  }, 120_000);
});
