import { describe, it, expect } from 'vitest';
import { projectRemoteSessions, type RemoteSessionEvent } from '../../services/platform/src/remote-sessions';

// M33-FR-02 — the fold behind "control remote sessions".

const AT = (n: number): string => `2026-09-02T1${n}:00:00Z`;
const opened = (id: string, at: string): RemoteSessionEvent => ({ sessionId: id, change: 'opened', by: 'u-eng', at, deviceId: 'till-3', userId: 'u-eng', kind: 'support' });
const seen = (id: string, at: string): RemoteSessionEvent => ({ sessionId: id, change: 'seen', by: 'u-eng', at });
const terminated = (id: string, at: string, reason: string): RemoteSessionEvent => ({ sessionId: id, change: 'terminated', by: 'u-owner', at, reason });

describe('projectRemoteSessions — the session fold', () => {
  it('an empty log is no sessions', () => {
    expect(projectRemoteSessions([])).toEqual([]);
  });

  it('an opened session is active, on its device, for its user', () => {
    const [s] = projectRemoteSessions([opened('rs1', AT(0))]);
    expect(s).toMatchObject({ sessionId: 'rs1', deviceId: 'till-3', userId: 'u-eng', kind: 'support', status: 'active', active: true });
    expect(s?.openedAt).toBe(AT(0));
    expect(s?.lastSeenAt).toBe(AT(0));
  });

  it('a heartbeat advances last-seen without changing status', () => {
    const [s] = projectRemoteSessions([opened('rs1', AT(0)), seen('rs1', AT(2))]);
    expect(s).toMatchObject({ status: 'active', lastSeenAt: AT(2) });
  });

  it('a termination ends it, records who and why, and it is no longer active', () => {
    const [s] = projectRemoteSessions([opened('rs1', AT(0)), terminated('rs1', AT(3), 'work finished, cutting the session')]);
    expect(s).toMatchObject({ status: 'terminated', terminatedBy: 'u-owner', terminatedReason: 'work finished, cutting the session', active: false });
    expect(s?.terminatedAt).toBe(AT(3));
  });

  it('a heartbeat or termination for a session nobody opened is ignored — no phantom session', () => {
    expect(projectRemoteSessions([seen('ghost', AT(1)), terminated('ghost', AT(2), 'x')])).toEqual([]);
  });

  it('folds many sessions independently', () => {
    const ss = projectRemoteSessions([opened('a', AT(0)), terminated('a', AT(1), 'done'), opened('b', AT(0))]);
    expect(ss.find((s) => s.sessionId === 'a')?.active).toBe(false);
    expect(ss.find((s) => s.sessionId === 'b')?.active).toBe(true);
  });
});
