import { describe, it, expect } from 'vitest';
import { projectSupportAccess } from '../../services/platform/src/support-access-lifecycle';
import type { SupportAccessRequest, SupportSession } from '../../packages/platform-admin/src/support-access';

// M33-FR-03 · SEC-11 — the fold behind "who has support access, and who had it". The projection decides a
// request's status and threads its session; a bug here loses the audit trail the whole control exists to keep.

const REQ = (requestId: string, requesterId = 'u-support'): SupportAccessRequest => ({
  requestId, requesterId, requesterName: 'Vendor Eng', reason: 'investigate the failing settings pack build',
  scopes: ['config.read'], tenantId: 't-sre', minutes: 60, at: '2026-08-31T10:00:00Z',
});
const SESSION = (id: string): SupportSession => ({
  sessionId: id, requesterId: 'u-support', requesterName: 'Vendor Eng', approvedBy: 'u-owner',
  reason: 'investigate the failing settings pack build', scopes: ['config.read'], tenantId: 't-sre',
  startedAt: '2026-08-31T11:00:00Z', expiresAt: '2026-08-31T12:00:00Z', actions: [],
});

describe('projectSupportAccess — the request→session fold', () => {
  it('an empty log is no records', () => {
    expect(projectSupportAccess([])).toEqual([]);
  });

  it('a filed request is pending, with no session yet', () => {
    const [rec] = projectSupportAccess([{ kind: 'requested', request: REQ('r1') }]);
    expect(rec).toMatchObject({ requestId: 'r1', status: 'pending' });
    expect(rec?.session).toBeUndefined();
  });

  it('an approval attaches the granted session; a rejection records who said no and grants nothing', () => {
    const approved = projectSupportAccess([
      { kind: 'requested', request: REQ('r1') },
      { kind: 'decided', requestId: 'r1', decision: 'approved', decidedBy: 'u-owner', at: '2026-08-31T11:00:00Z', session: SESSION('r1') },
    ]);
    expect(approved[0]).toMatchObject({ status: 'approved', decidedBy: 'u-owner' });
    expect(approved[0]?.session?.sessionId).toBe('r1');

    const rejected = projectSupportAccess([
      { kind: 'requested', request: REQ('r2') },
      { kind: 'decided', requestId: 'r2', decision: 'rejected', decidedBy: 'u-owner', at: '2026-08-31T11:00:00Z' },
    ]);
    expect(rejected[0]).toMatchObject({ status: 'rejected', decidedBy: 'u-owner' });
    expect(rejected[0]?.session).toBeUndefined();
  });

  it('actions accumulate on the session, and an early end stamps its end time', () => {
    const recs = projectSupportAccess([
      { kind: 'requested', request: REQ('r1') },
      { kind: 'decided', requestId: 'r1', decision: 'approved', decidedBy: 'u-owner', at: '2026-08-31T11:00:00Z', session: SESSION('r1') },
      { kind: 'action', sessionId: 'r1', action: { at: '2026-08-31T11:10:00Z', action: 'read config', target: 'settings-pack' } },
      { kind: 'ended', sessionId: 'r1', at: '2026-08-31T11:20:00Z' },
    ]);
    expect(recs[0]?.session?.actions).toHaveLength(1);
    expect(recs[0]?.session?.endedAt).toBe('2026-08-31T11:20:00Z');
  });

  it('a decision, action, or end for a request nobody filed is ignored — no phantom session', () => {
    expect(projectSupportAccess([
      { kind: 'decided', requestId: 'ghost', decision: 'approved', decidedBy: 'u-owner', at: '2026-08-31T11:00:00Z', session: SESSION('ghost') },
      { kind: 'action', sessionId: 'ghost', action: { at: '2026-08-31T11:10:00Z', action: 'x' } },
    ])).toEqual([]);
  });
});
