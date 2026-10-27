import { describe, it, expect } from 'vitest';
import { rolloutRoutes, rolloutSubject, type RolloutDeps } from '../../services/platform/src/rollout';
import {
  FLOOR_DEVICE_ROLLOUT_KEYS, isFloorDeviceSwitch, isHighImpactFlag, isHighImpactRolloutKey,
} from '../../services/platform/src/governed-config';
import { APPROVAL_KINDS, actionDetails, fingerprintOf, type ApprovalState, type ApprovalPort } from '../../services/identity/src/approval-requests';
import { FLOOR_DEVICE_SWITCH } from '../../packages/integration/src/floor-devices';
import type { RolloutChange } from '../../packages/platform/src/rollout';
import type { RequestContext, Route } from '../../services/kernel/src/index';

// OB-407 (owner, 27 Oct 2026, in writing — option B · D14-FR-05 · R8-7 · §8.2): the four floor-device rollout switches
// (shelf labels, RFID, sensors, cameras) are high-impact. Switching one ON needs the owner's approval AND the named
// security reviewer's signature (OB-330 / OB-405), each the decision of a different person in their own session, never
// the person switching; with no reviewer named it is refused by name. Switching OFF is one person with a reason. The rule
// on the route itself, over a stand-in approvals engine and switch ledger — every refusal spends nothing and records
// nothing.

const T = 't-1';
const AT = '2026-10-27T10:00:00.000Z';
const LATER = '2026-10-28T10:00:00.000Z';
const OWNER = 'u-owner'; const IT = 'u-it'; const REV = 'u-rev'; const MGR = 'u-mgr'; const OTHER = 'u-other';

const PERMS: Readonly<Record<string, readonly string[]>> = {
  [OWNER]: ['platform.flag.write', 'platform.config.approve', 'compliance.risk.read'],
  [IT]: ['platform.flag.write', 'platform.flag.read'],
  [REV]: ['identity.self.read', 'compliance.risk.read'],
  [MGR]: ['compliance.risk.read'],
  // Holds the owner's approval permission without the owner's role (a stand-in: no catalogue role is like this today).
  [OTHER]: ['platform.config.approve', 'compliance.risk.read', 'platform.flag.write'],
};

function world(opts: { reviewer?: { userId: string; displayName: string } | null; wired?: boolean } = {}) {
  const changes: (RolloutChange & { version: number })[] = [];
  const approvals = new Map<string, ApprovalState>();
  const spent: string[] = [];
  const audit: unknown[] = [];
  const port: ApprovalPort = {
    approvalState: (_t, id) => approvals.get(id),
    approvalVersion: () => 1,
    spendApproval: (_t, id, usedBy) => { const s = approvals.get(id)!; approvals.set(id, { ...s, usedBy }); spent.push(id); return true; },
    permissionsOfUser: (_t, u) => PERMS[u],
  };
  const reviewer = opts.reviewer === undefined ? { userId: REV, displayName: 'Mr Sivakumar' } : opts.reviewer;
  const deps: RolloutDeps = {
    changes: async () => changes,
    recordChange: async (_t, c) => { changes.push(c); },
    branches: async () => [{ branchId: 'B1', status: 'active' }],
    lanes: async () => [{ branchId: 'B1', laneId: 'lane-1' }],
    approvals: port,
    ...(opts.wired === false ? {} : {
      securityReviewer: async () => reviewer ?? undefined,
      isOwner: async (_t, u) => u === OWNER,
    }),
    recordAudit: (_t, e) => { audit.push(e); },
    now: () => AT,
  };
  const routes = rolloutRoutes(deps);
  const route = (method: string, path: string): Route => routes.find((r) => r.method === method && r.path === path)!;
  const ctx = (userId: string, key: string, body: unknown): RequestContext => ({ tenantId: T, userId, branchId: null, scope: 'all', params: { key }, query: {}, body, traceId: 'trace', idempotencyKey: `k-${Math.random()}` });
  const put = async (userId: string, key: string, body: Record<string, unknown>) => {
    try { return { status: (await route('PUT', '/v1/platform/rollout/:key').handler(ctx(userId, key, body))).status, body: undefined as unknown, code: undefined as string | undefined }; } catch (e) {
      const err = e as { status?: number; body?: { code?: string } };
      return { status: err.status ?? 500, body: err.body, code: err.body?.code };
    }
  };
  const preview = async (userId: string, key: string, body: Record<string, unknown>) => (await route('POST', '/v1/platform/rollout/:key/preview').handler(ctx(userId, key, body))).body as Record<string, unknown>;
  const rollback = async (userId: string, key: string, body: Record<string, unknown>) => {
    try { return { status: (await route('POST', '/v1/platform/rollout/:key/rollback').handler(ctx(userId, key, body))).status, code: undefined as string | undefined }; } catch (e) {
      const err = e as { status?: number; body?: { code?: string } };
      return { status: err.status ?? 500, code: err.body?.code };
    }
  };
  /** An approval as the engine would hold it: asked by `maker` for exactly `details`, decided by `checker`. */
  const approve = (id: string, kind: string, key: string, place: { branchId: string; laneId?: string }, details: unknown, maker: string, checker: string, decision: 'approved' | 'rejected' = 'approved'): string => {
    approvals.set(id, {
      request: { requestId: id, kind, subjectRef: rolloutSubject(key, place), valueMinor: null, fingerprint: fingerprintOf(details), details: details as Record<string, unknown>, summary: 's', reason: 'r', requestedBy: maker, requestedAt: AT },
      decision: { requestId: id, decision, decidedBy: checker, reason: 'ok', decidedAt: AT, expiresAt: LATER },
    });
    return id;
  };
  return { changes, approvals, spent, audit, put, preview, rollback, approve };
}

const ON = { branchId: 'B1', enabled: true, reason: 'camera events trial in B1' };
const detailsOf = (key: string, body: Record<string, unknown>) => actionDetails(body, { key });

describe('the floor-device switches are high-impact (OB-407)', () => {
  it('names exactly the four floor-device switches; the shop\'s feature flags and other rollout keys are unchanged', () => {
    expect(FLOOR_DEVICE_ROLLOUT_KEYS).toEqual(['cctv', 'esl', 'iot', 'rfid']);
    expect([...FLOOR_DEVICE_ROLLOUT_KEYS].sort()).toEqual(Object.values(FLOOR_DEVICE_SWITCH).sort());
    for (const k of FLOOR_DEVICE_ROLLOUT_KEYS) { expect(isFloorDeviceSwitch(k)).toBe(true); expect(isHighImpactRolloutKey(k)).toBe(true); expect(isHighImpactFlag(k)).toBe(false); }
    expect(isHighImpactRolloutKey('self_checkout')).toBe(false);
    expect(isHighImpactRolloutKey('offline.card_limit_trial')).toBe(true);
    expect(isFloorDeviceSwitch('cctv.extra')).toBe(false);
  });

  it('the reviewer\'s signature is its own approval kind, asked by the person switching, decided by one who may read the risk register', () => {
    expect(APPROVAL_KINDS['floor_device_review']).toMatchObject({ kind: 'floor_device_review', makerPermission: 'platform.flag.write', checkerPermission: 'compliance.risk.read', validForMinutes: 24 * 60 });
    // The reviewer's approval number is a control field like the owner's: it is never part of the change being approved.
    expect(actionDetails({ ...ON, approvalId: 'a', reviewApprovalId: 'r' }, { key: 'cctv' })).toEqual({ ...ON, key: 'cctv' });
  });
});

describe('switching a floor device on needs the owner and the named security reviewer (OB-407)', () => {
  it('with no reviewer named: refused by name, even with both approvals; nothing spent, nothing recorded', async () => {
    const w = world({ reviewer: null });
    const d = detailsOf('cctv', ON);
    const a = w.approve('a1', 'flag_change', 'cctv', ON, d, IT, OWNER); const r = w.approve('r1', 'floor_device_review', 'cctv', ON, d, IT, MGR);
    expect(await w.put(IT, 'cctv', { ...ON, approvalId: a, reviewApprovalId: r })).toMatchObject({ status: 422, code: 'name_the_security_reviewer_first' });
    expect(await w.preview(IT, 'cctv', { branchId: 'B1', enabled: true })).toMatchObject({ needsSecurityReviewer: true, securityReviewer: null, refusedBecause: 'name_the_security_reviewer_first', needsSecondPerson: true });
    // A bare stub without the reviewer register fails closed the same way.
    expect((await world({ wired: false }).put(IT, 'esl', ON)).code).toBe('name_the_security_reviewer_first');
    expect([w.spent, w.changes, w.audit]).toEqual([[], [], []]);
  });

  it('refused without the owner\'s approval, without the reviewer\'s, with a non-owner approver, with the wrong reviewer, or one person twice', async () => {
    const w = world();
    const d = detailsOf('cctv', ON);
    expect((await w.put(IT, 'cctv', ON)).code).toBe('high_impact_change_needs_owner_approval');
    const a = w.approve('a1', 'flag_change', 'cctv', ON, d, IT, OWNER);
    expect((await w.put(IT, 'cctv', { ...ON, approvalId: a })).code).toBe('floor_device_switch_needs_security_reviewer');
    // The owner's approval must be the OWNER's: someone else holding the approval permission does not count.
    const notOwner = w.approve('a2', 'flag_change', 'cctv', ON, d, IT, OTHER);
    const rev = w.approve('r1', 'floor_device_review', 'cctv', ON, d, IT, REV);
    expect((await w.put(IT, 'cctv', { ...ON, approvalId: notOwner, reviewApprovalId: rev })).code).toBe('approver_is_not_the_owner');
    // Only the NAMED reviewer's signature counts — a store manager who may read the risk register is not them.
    const byMgr = w.approve('r2', 'floor_device_review', 'cctv', ON, d, IT, MGR);
    expect((await w.put(IT, 'cctv', { ...ON, approvalId: a, reviewApprovalId: byMgr })).code).toBe('not_the_named_security_reviewer');
    // The owner's approval cannot stand in for the reviewer's (a different kind), nor be used twice.
    expect((await w.put(IT, 'cctv', { ...ON, approvalId: a, reviewApprovalId: a })).code).toBe('approval_does_not_match');
    // A rejected signature is no signature.
    const rejected = w.approve('r3', 'floor_device_review', 'cctv', ON, d, IT, REV, 'rejected');
    expect((await w.put(IT, 'cctv', { ...ON, approvalId: a, reviewApprovalId: rejected })).code).toBe('approval_rejected');
    // A signature for a different change (another reason) does not match this one.
    const other = w.approve('r4', 'floor_device_review', 'cctv', ON, detailsOf('cctv', { ...ON, reason: 'something else' }), IT, REV);
    expect((await w.put(IT, 'cctv', { ...ON, approvalId: a, reviewApprovalId: other })).code).toBe('approval_does_not_match');
    expect([w.spent, w.changes, w.audit]).toEqual([[], [], []]);
  });

  it('the person switching is never the reviewer, and the owner is never also the reviewer', async () => {
    // The named reviewer asks to switch it on themselves: their own signature does not count (each signature is another person's).
    const self = world({ reviewer: { userId: OTHER, displayName: 'Other' } });
    const d = detailsOf('esl', { ...ON, reason: 'labels' });
    const a = self.approve('a1', 'flag_change', 'esl', ON, d, OTHER, OWNER);
    const r = self.approve('r1', 'floor_device_review', 'esl', ON, d, OTHER, OTHER);
    expect((await self.put(OTHER, 'esl', { ...ON, reason: 'labels', approvalId: a, reviewApprovalId: r })).code).toBe('switcher_cannot_review');
    // An owner named as reviewer (a role given later) cannot give both signatures.
    const both = world({ reviewer: { userId: OWNER, displayName: 'Owner' } });
    const a2 = both.approve('a1', 'flag_change', 'esl', ON, d, IT, OWNER);
    const r2 = both.approve('r1', 'floor_device_review', 'esl', ON, d, IT, OWNER);
    expect((await both.put(IT, 'esl', { ...ON, reason: 'labels', approvalId: a2, reviewApprovalId: r2 })).code).toBe('one_person_cannot_sign_twice');
    expect([self.spent, self.changes, both.spent, both.changes]).toEqual([[], [], [], []]);
  });

  it('with both: switched on, both approvals spent once, both people on the version and the audit; a rollback to ON needs them again', async () => {
    const w = world();
    const d = detailsOf('cctv', ON);
    const a = w.approve('a1', 'flag_change', 'cctv', ON, d, IT, OWNER);
    const r = w.approve('r1', 'floor_device_review', 'cctv', ON, d, IT, REV);
    expect((await w.put(IT, 'cctv', { ...ON, approvalId: a, reviewApprovalId: r })).status).toBe(200);
    expect(w.changes).toEqual([expect.objectContaining({ key: 'cctv', enabled: true, version: 1, changedBy: IT, approvedBy: OWNER, approvalId: 'a1', reviewedBy: REV, reviewApprovalId: 'r1' })]);
    expect(w.spent).toEqual(['a1', 'r1']);
    expect(w.audit).toEqual([expect.objectContaining({ action: 'platform.rollout.change', actorId: IT, approvalId: 'a1', after: expect.objectContaining({ enabled: 'true', approvedBy: OWNER, reviewedBy: REV, reviewApprovalId: 'r1' }) })]);
    // One approval allows one action.
    expect((await w.put(IT, 'cctv', { ...ON, approvalId: a, reviewApprovalId: r })).code).toBe('approval_already_used');

    // OFF: one person and a reason, no approval asked — turning a camera off is never harder than turning it on.
    expect((await w.put(IT, 'cctv', { branchId: 'B1', enabled: false, reason: 'privacy notice not up yet' })).status).toBe(200);
    expect((await w.put(IT, 'cctv', { branchId: 'B1', laneId: 'lane-1', enabled: false, reason: 'lane 1 camera faulty' })).status).toBe(200);
    expect(w.changes.slice(1)).toEqual([
      expect.not.objectContaining({ approvedBy: expect.anything() }), expect.not.objectContaining({ reviewedBy: expect.anything() }),
    ]);
    expect(await w.preview(IT, 'cctv', { branchId: 'B1', enabled: false })).toMatchObject({ highImpact: true, needsSecondPerson: false, needsSecurityReviewer: false, approvedBy: null });
    // Going back to version 1 (ON) is a switch-on: approved the same way.
    expect((await w.rollback(IT, 'cctv', { branchId: 'B1', toVersion: 1, reason: 'notice is up' })).code).toBe('high_impact_change_needs_owner_approval');
    const rb = { branchId: 'B1', toVersion: 1, reason: 'notice is up' };
    const rd = actionDetails(rb, { key: 'cctv', action: 'rollback' });
    const ra = w.approve('a3', 'flag_change', 'cctv', ON, rd, IT, OWNER);
    expect((await w.rollback(IT, 'cctv', { ...rb, approvalId: ra })).code).toBe('floor_device_switch_needs_security_reviewer');
    const rr = w.approve('r3', 'floor_device_review', 'cctv', ON, rd, IT, REV);
    expect((await w.rollback(IT, 'cctv', { ...rb, approvalId: ra, reviewApprovalId: rr })).status).toBe(200);
    expect(w.changes.at(-1)).toMatchObject({ enabled: true, rolledBackFrom: 1, approvedBy: OWNER, reviewedBy: REV, version: 3 });
  });

  it('the preview says who must sign, and hands the page exactly the two asks once the reason is written', async () => {
    const w = world();
    const p = await w.preview(IT, 'rfid', { branchId: 'B1', enabled: true, reason: 'reader trial' });
    const details = { branchId: 'B1', enabled: true, reason: 'reader trial', key: 'rfid' };
    expect(p).toMatchObject({ highImpact: true, floorDevice: true, needsSecondPerson: true, needsSecurityReviewer: true, approvedBy: 'the owner', securityReviewer: { userId: REV, displayName: 'Mr Sivakumar' } });
    expect(p['asks']).toEqual([
      expect.objectContaining({ kind: 'flag_change', subjectRef: 'rollout:rfid:B1', details, valueMinor: null, reason: 'reader trial' }),
      expect.objectContaining({ kind: 'floor_device_review', subjectRef: 'rollout:rfid:B1', details, valueMinor: null, reason: 'reader trial' }),
    ]);
    // The asks carry exactly what the change's details will be.
    expect(fingerprintOf(details)).toBe(fingerprintOf(actionDetails({ branchId: 'B1', enabled: true, reason: 'reader trial', approvalId: 'x', reviewApprovalId: 'y' }, { key: 'rfid' })));
    // A switch that is not a floor device asks nobody, as before.
    expect(await w.preview(IT, 'self_checkout', { branchId: 'B1', enabled: true, reason: 'x' })).toMatchObject({ highImpact: false, needsSecondPerson: false, needsSecurityReviewer: false });
    expect(w.changes).toEqual([]);
  });
});
