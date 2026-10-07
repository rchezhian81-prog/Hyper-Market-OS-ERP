import { describe, it, expect, afterEach } from 'vitest';
import {
  createAdminSession, SUPPORT_ACCESS_COPY, SUPPORT_COPY_KEYS, SUPPORT_DECIDE_OUTCOME_KINDS, SUPPORT_END_OUTCOME_KINDS,
  type AdminConfig, type AdminPorts, type SupportAccessPort, type SupportAccessState, type SupportDecideOutcome,
  type SupportDecisionResult, type SupportEndOutcome, type SupportEndResult, type SupportRead,
} from '../../apps/web-erp/src/admin-session';
import { adminPortsFromData, bootAdmin, HEAD_OFFICE_SUPPORT_ACCESS } from '../../apps/web-erp/src/browser-entry';
import { bilingualGaps } from '../../packages/ui/src/index';
import type { SupportAccessRequest, SupportSession, Device, VersionPolicy } from '../../packages/platform-admin/src/index';
import type { UserAccount } from '../../packages/identity/src/index';
import type { AuditRecord, LegalHold, RetentionPolicy } from '../../packages/audit/src/index';

/**
 * **Admin and security (M01 · M02 · M33 · M33-FR-03 · M34 · D12 · §28 · audit PA-03).**
 *
 * The design bar is three lines: least privilege by default, no shared logins, and support access
 * that is time-bound and audited — *never standing god-mode*.
 *
 * The controls under test:
 *
 *   • **an expired grant is not access**, decided from the clock every time it is read;
 *   • **outside access is decided on head office's own lifecycle, in the owner's own session** — the screen reads
 *     what waits for a decision and who has been let in (`GET /v1/platform/support-access/sessions`), and the owner
 *     approves (for fewer minutes if they wish, never more), rejects or ends one. The page NEVER names a decider —
 *     there is no typed approver anywhere — and it refuses the cheap things before any POST: nobody named, no
 *     authority, not connected, a stale list, the person's own request, minutes longer than asked;
 *   • head office's own refusals (403 / 404 / 409 / 422, a lost link) are said in plain words, in English and Tamil;
 *   • a fleet with no version policy is reported as **unenforced**, not as compliant;
 *   • a shop with no retention policy is reported as **undecided**, not as nothing-to-delete;
 *   • a legal hold outranks a retention date, and nothing here deletes anything.
 */

const NOW = '2026-08-06T14:00:00.000Z';
/** Head office's clock when it answered — 5 minutes after the box served the page. */
const HO_AT = '2026-08-06T14:05:00.000Z';

const session = (over: Partial<SupportSession> = {}): SupportSession => ({
  sessionId: 'S-1', requesterId: 'u-eng', requesterName: 'Engineer', approvedBy: 'u-owner',
  reason: 'investigating the duplicate settlement raised in ticket 4471',
  scopes: ['read:settlements'], tenantId: 't1',
  startedAt: '2026-08-06T13:00:00.000Z', expiresAt: '2026-08-06T15:00:00.000Z',
  actions: [],
  ...over,
});

const request = (over: Partial<SupportAccessRequest> = {}): SupportAccessRequest => ({
  requestId: 'R-1', requesterId: 'u-eng', requesterName: 'Ravi (vendor support)',
  reason: 'investigating the duplicate settlement raised in ticket 4471',
  scopes: ['read:settlements'], tenantId: 't1', minutes: 60, at: '2026-08-06T13:55:00.000Z',
  ...over,
});

const account = (over: Partial<UserAccount> = {}): UserAccount => ({
  userId: 'u-1', tenantId: 't1', username: 'meena',
  person: { fullName: 'Meena R', email: 'meena@example.com' },
  status: 'active', privileged: false, mfaEnrolled: true,
  lastLoginAt: '2026-08-06T09:00:00.000Z',
  ...over,
} as UserAccount);

const device = (over: Partial<Device> = {}): Device => ({
  deviceId: 'D-1', tenantId: 't1', branchId: 'b1', kind: 'pos', label: 'Lane 1',
  status: 'active', appVersion: '2.0.0', lastSeenAt: NOW,
  ...over,
} as Device);

const POLICY: VersionPolicy = { currentVersion: '2.0.0', minimumSupportedVersion: '1.0.0' };

/** The owner is at the screen. */
const CONFIG: AdminConfig = { tenantId: 't1', userId: 'u-owner', now: NOW, dormantAfterDays: 60 };

function ports(over: Partial<AdminPorts> = {}): AdminPorts {
  return {
    accounts: () => [account()],
    roles: () => [],
    assignments: () => [],
    supportSessions: () => [session()],
    mayDecideSupport: () => true,
    devices: () => [device()],
    versionPolicy: () => POLICY,
    auditRecords: () => [],
    retentionPolicies: () => [],
    legalHolds: () => [],
    ...over,
  };
}

const admin = (over: Partial<AdminPorts> = {}, config: Partial<AdminConfig> = {}) =>
  createAdminSession({ ...CONFIG, ...config }, ports(over));

/** A head office in memory: what it answers, and every call the page made to it. */
interface FakeHeadOffice {
  state: SupportAccessState;
  /** When set, the next read answers this instead of the state. */
  readAnswer?: SupportRead;
  /** When set, the next decision answers this. */
  decideAnswer?: SupportDecisionResult;
  endAnswer?: SupportEndResult;
  readonly reads: number[];
  readonly decisions: Record<string, unknown>[];
  readonly ends: Record<string, unknown>[];
  readonly port: SupportAccessPort;
}

function headOffice(state: Partial<SupportAccessState> = {}): FakeHeadOffice {
  const ho: FakeHeadOffice = {
    state: { sessions: [], pending: [request()], asAt: HO_AT, ...state },
    reads: [], decisions: [], ends: [],
    port: {
      read: async () => {
        ho.reads.push(ho.reads.length + 1);
        const answer = ho.readAnswer;
        ho.readAnswer = undefined;
        return answer ?? { result: 'read', state: ho.state };
      },
      decide: async (input) => {
        ho.decisions.push({ ...input });
        const answer = ho.decideAnswer;
        ho.decideAnswer = undefined;
        if (answer !== undefined) return answer;
        const asked = ho.state.pending.find((r) => r.requestId === input.requestId)!;
        ho.state = { ...ho.state, pending: ho.state.pending.filter((r) => r.requestId !== input.requestId) };
        if (input.decision === 'rejected') return { result: 'rejected' };
        const minutes = input.grantedMinutes ?? asked.minutes;
        const granted: SupportSession = {
          sessionId: asked.requestId, requesterId: asked.requesterId, requesterName: asked.requesterName, approvedBy: 'u-owner',
          reason: asked.reason, scopes: asked.scopes, tenantId: asked.tenantId,
          startedAt: HO_AT, expiresAt: new Date(Date.parse(HO_AT) + minutes * 60_000).toISOString(), actions: [],
        };
        ho.state = { ...ho.state, sessions: [...ho.state.sessions, granted] };
        return { result: 'approved', session: granted };
      },
      end: async (input) => {
        ho.ends.push({ ...input });
        const answer = ho.endAnswer;
        ho.endAnswer = undefined;
        if (answer !== undefined) return answer;
        ho.state = { ...ho.state, sessions: ho.state.sessions.map((s) => (s.sessionId === input.sessionId ? { ...s, endedAt: HO_AT } : s)) };
        return { result: 'ended', endedAt: HO_AT };
      },
    },
  };
  return ho;
}

/** The owner's screen, wired to a head office and having read it once. */
async function connected(ho: FakeHeadOffice, over: Partial<AdminPorts> = {}, config: Partial<AdminConfig> = {}) {
  const s = admin({ supportAccess: ho.port, ...over }, config);
  await s.refreshSupport();
  return s;
}

const TAMIL = /[\u0B80-\u0BFF]/;

// ── The expiry nothing ever checked ─────────────────────────────────────────

describe('a grant that has expired is not access', () => {
  it('reports a live session as live, with the time it has left', () => {
    const view = admin().support()[0]!;
    expect(view.active).toBe(true);
    expect(view.minutesLeft).toBe(60);
    expect(view.from).toBe('06-08-2026 18:30');
    expect(view.until).toBe('06-08-2026 20:30');
  });

  it('reports an EXPIRED session as not access at all', () => {
    // Nothing in this system ever asked. A session was granted with an `expiresAt` in a response
    // body and no code anywhere read it again — standing access wearing a time limit's clothes.
    const view = admin({
      supportSessions: () => [session({ expiresAt: '2026-08-06T13:30:00.000Z' })],
    }).support()[0]!;
    expect(view.active, 'an expired grant still reads as access').toBe(false);
    expect(view.minutesLeft).toBe(0);
  });

  it('decides it from the CLOCK each time, not from a stored flag', () => {
    // A flag has to be turned off by something, and that something is exactly what did not exist.
    const grant = session({ expiresAt: '2026-08-06T14:30:00.000Z' });
    expect(admin({ supportSessions: () => [grant] }).support()[0]?.active).toBe(true);
    expect(admin({ supportSessions: () => [grant] }, { now: '2026-08-06T15:00:00.000Z' })
      .support()[0]?.active).toBe(false);
  });

  it('treats an ended session as ended even before its expiry', () => {
    const view = admin({
      supportSessions: () => [session({ endedAt: '2026-08-06T13:30:00.000Z' })],
    }).support()[0]!;
    expect(view.active).toBe(false);
    expect(view.endedAt).toBe('06-08-2026 19:00');
  });

  it('puts live sessions at the top — a live one is the most urgent thing here', () => {
    const list = admin({
      supportSessions: () => [
        session({ sessionId: 'S-OLD', expiresAt: '2026-08-06T13:00:00.000Z' }),
        session({ sessionId: 'S-LIVE' }),
      ],
    }).support();
    expect(list[0]?.session.sessionId).toBe('S-LIVE');
    expect(list[0]?.active).toBe(true);
  });

  it('judges head office’s sessions against head office’s own clock — and ignores any stored “active” flag', async () => {
    // Head office answered at 14:05; this grant ran out at 14:02. A stored `active: true` riding on the row is not
    // believed: liveness is computed, every time.
    const stale = { ...session({ sessionId: 'S-HO', expiresAt: '2026-08-06T14:02:00.000Z' }), active: true } as SupportSession;
    const s = await connected(headOffice({ sessions: [stale], pending: [] }));
    expect(s.support().map((v) => [v.session.sessionId, v.active])).toEqual([['S-HO', false]]);
    // Head office's list replaces what the store computer last knew.
    expect(s.support().some((v) => v.session.sessionId === 'S-1')).toBe(false);
  });
});

// ── Outside access is head office's lifecycle, decided in the owner's own session ─────

describe('the waiting list and the sessions are read from head office (M33-FR-03)', () => {
  it('says it is asking before head office answers, and shows nothing as waiting', () => {
    const s = admin({ supportAccess: headOffice().port });
    const view = s.outside('en');
    expect(view.connected).toBe(true);
    expect(view.source.label).toBe('Asking head office…');
    expect(view.waiting).toEqual([]);
    // Until head office answers, the list the store computer last knew is what shows.
    expect(view.sessions.map((v) => v.session.sessionId)).toEqual(['S-1']);
    expect(view.mayDecide, 'nothing is decided against a list head office has not given').toBe(false);
    expect(view.cannotDecide).toBe('Head office has not answered, so nothing can be decided until it does. Press “Check again”.');
  });

  it('shows each waiting request with who, why, what and for how long — and when head office said so', async () => {
    const ho = headOffice({
      pending: [request({ requestId: 'R-2', at: '2026-08-06T14:01:00.000Z', minutes: 30 }), request()],
      sessions: [session({ sessionId: 'S-HO', startedAt: '2026-08-06T13:30:00.000Z', expiresAt: '2026-08-06T14:45:00.000Z' })],
    });
    const s = await connected(ho);
    const view = s.outside('en');
    expect(ho.reads).toHaveLength(1);
    expect(view.source).toMatchObject({ tone: 'ok', label: 'From head office, as at 06-08-2026 19:35.' });
    expect(view.mayDecide).toBe(true);
    expect(view.cannotDecide).toBeNull();
    // Oldest first: the one who has waited longest is at the top.
    expect(view.waiting.map((w) => w.requestId)).toEqual(['R-1', 'R-2']);
    expect(view.waiting[0]).toEqual({
      requestId: 'R-1', requesterId: 'u-eng', requesterName: 'Ravi (vendor support)',
      reason: 'investigating the duplicate settlement raised in ticket 4471', scopes: ['read:settlements'],
      askedMinutes: 60, askedAt: '06-08-2026 19:25', ownRequest: false,
    });
    // The session head office holds: live at head office's 14:05, 40 minutes left.
    expect(view.sessions[0]).toMatchObject({ active: true, minutesLeft: 40, from: '06-08-2026 19:00', until: '06-08-2026 20:15' });
    expect(view.liveCount).toBe(1);
  });

  it('a request THIS person filed is shown, never offered to decide (§28)', async () => {
    const s = await connected(headOffice({ pending: [request({ requesterId: 'u-owner', requesterName: 'The owner' })] }));
    expect(s.outside('en').waiting[0]?.ownRequest).toBe(true);
  });

  it('says plainly when head office cannot be reached — what it last said, and that nothing can be decided', async () => {
    const ho = headOffice();
    const s = await connected(ho);
    ho.readAnswer = { result: 'lost_link' };
    expect(await s.refreshSupport()).toEqual({ kind: 'lost_link' });
    const view = s.outside('en');
    expect(view.source).toMatchObject({ tone: 'degraded', needsAttention: true });
    expect(view.source.label).toBe('No connection to head office. What is shown is what head office said at 06-08-2026 19:35 — nothing can be decided until it answers again. Press “Check again”.');
    expect(view.waiting.map((w) => w.requestId), 'what head office last said is still shown').toEqual(['R-1']);
    expect(view.mayDecide).toBe(false);
    // And with no answer ever, it says what the store computer last knew.
    const never = admin({ supportAccess: { ...ho.port, read: async () => ({ result: 'lost_link' as const }) } });
    await never.refreshSupport();
    expect(never.outside('en').source.label).toBe('No connection to head office. What is shown is what the store computer last knew — nothing can be decided until head office answers. Press “Check again”.');
  });

  it('a read head office refuses is said in its words; a 403 says the person may not see it', async () => {
    const ho = headOffice();
    const s = admin({ supportAccess: ho.port });
    ho.readAnswer = { result: 'refused', code: 'forbidden', whatHappened: 'This account does not hold "platform.support.read".' };
    expect((await s.refreshSupport()).kind).toBe('not_permitted_at_head_office');
    expect(s.outside('en').source.label).toBe('Head office says you may not see outside access.');
    ho.readAnswer = { result: 'refused', code: 'feature_not_entitled', whatHappened: 'This shop\'s plan does not include it.' };
    await s.refreshSupport();
    expect(s.outside('en').source.label).toBe('Head office did not give the list: This shop\'s plan does not include it.');
  });

  it('with no head office behind the page it says so, and decides nothing', async () => {
    const s = admin();
    expect(s.connected).toBe(false);
    expect(await s.refreshSupport()).toEqual({ kind: 'not_connected' });
    const view = s.outside('en');
    expect(view.source.label).toBe('This page is not connected to head office, so nothing can be decided here. What is shown is what the store computer last knew.');
    expect(view.mayDecide).toBe(false);
    expect(await s.decideSupport('R-1', 'approved')).toEqual({ kind: 'not_connected' });
    expect(await s.endSupport('S-1')).toEqual({ kind: 'not_connected' });
  });
});

describe('the OWNER decides a waiting request in their own session — never a typed name (PA-03)', () => {
  it('approves what was asked: one POST carrying only the decision — no decider of any kind', async () => {
    const ho = headOffice();
    const s = await connected(ho);
    const outcome = await s.decideSupport('R-1', 'approved', '');
    expect(ho.decisions).toEqual([{ requestId: 'R-1', decision: 'approved' }]);
    for (const typed of ['decidedBy', 'approvedBy', 'approver', 'requesterId']) expect(ho.decisions[0]).not.toHaveProperty(typed);
    expect(outcome).toEqual({ kind: 'approved', who: 'Ravi (vendor support)', minutes: 60, until: '2026-08-06T15:05:00.000Z', scopes: ['read:settlements'] });
    expect(s.presentDecideOutcome('en', outcome)).toMatchObject({
      tone: 'ok', label: 'Approved. Ravi (vendor support) may see read:settlements for 60 minutes, until 06-08-2026 20:35. It ends by itself.',
    });
    // Head office answered, so its list is read again: the request has left "waiting", the session is live.
    expect(ho.reads).toHaveLength(2);
    expect(s.outside('en').waiting).toEqual([]);
    expect(s.outside('en').sessions[0]).toMatchObject({ active: true, minutesLeft: 60 });
  });

  it('approves for FEWER minutes than asked — the shorter window is what head office grants', async () => {
    const ho = headOffice();
    const s = await connected(ho);
    const outcome = await s.decideSupport('R-1', 'approved', ' 30 ');
    expect(ho.decisions).toEqual([{ requestId: 'R-1', decision: 'approved', grantedMinutes: 30 }]);
    expect(outcome).toMatchObject({ kind: 'approved', minutes: 30 });
    expect(s.presentDecideOutcome('en', outcome).label).toContain('for 30 minutes, until 06-08-2026 20:05');
    // Exactly what was asked is allowed too.
    const again = await connected(headOffice());
    expect((await again.decideSupport('R-1', 'approved', '60')).kind).toBe('approved');
  });

  it('refuses LONGER than asked on the page, in plain words — and sends NOTHING', async () => {
    const ho = headOffice();
    const s = await connected(ho);
    const outcome = await s.decideSupport('R-1', 'approved', '90');
    expect(outcome).toEqual({ kind: 'longer_than_asked', asked: 60, typed: 90 });
    expect(ho.decisions, 'an approval that lengthens the window was sent').toEqual([]);
    expect(s.presentDecideOutcome('en', outcome)).toMatchObject({
      tone: 'error', label: 'You can only shorten the time, never lengthen it. They asked for 60 minutes; 90 is longer. Nothing was sent.',
    });
  });

  it('refuses minutes it cannot read as a whole number — and sends nothing', async () => {
    const ho = headOffice();
    const s = await connected(ho);
    for (const typed of ['abc', '0', '1.5', '-5', '30 mins']) {
      expect(await s.decideSupport('R-1', 'approved', typed), typed).toEqual({ kind: 'minutes_unreadable', asked: 60 });
    }
    expect(ho.decisions).toEqual([]);
    expect(s.presentDecideOutcome('en', { kind: 'minutes_unreadable', asked: 60 }).label)
      .toBe('Write the minutes as a whole number from 1 to 60 — or leave the box empty to allow what was asked. Nothing was sent.');
  });

  it('rejects: one POST with the decision only (the minutes box is not read)', async () => {
    const ho = headOffice();
    const s = await connected(ho);
    const outcome = await s.decideSupport('R-1', 'rejected', '999');
    expect(ho.decisions).toEqual([{ requestId: 'R-1', decision: 'rejected' }]);
    expect(outcome).toEqual({ kind: 'rejected', who: 'Ravi (vendor support)' });
    expect(s.presentDecideOutcome('en', outcome)).toMatchObject({ tone: 'ok', label: 'Rejected. Ravi (vendor support) was not let in.' });
    expect(s.outside('en').waiting).toEqual([]);
  });

  it('a person without the owner’s authority sees the list read-only, says why, and sends nothing', async () => {
    const ho = headOffice({ sessions: [session({ sessionId: 'S-HO' })] });
    const s = await connected(ho, { mayDecideSupport: () => false });
    const view = s.outside('en');
    expect(view.waiting.map((w) => w.requestId), 'the waiting list is still shown').toEqual(['R-1']);
    expect(view.mayDecide).toBe(false);
    expect(view.cannotDecide).toBe('You can see these requests, but only the owner decides who is let in, and you do not hold that permission.');
    expect(await s.decideSupport('R-1', 'approved')).toEqual({ kind: 'not_permitted' });
    expect(await s.endSupport('S-HO')).toEqual({ kind: 'not_permitted' });
    expect(ho.decisions).toEqual([]);
    expect(ho.ends).toEqual([]);
  });

  it('decides nothing when the store computer was not told who is at the screen', async () => {
    const ho = headOffice();
    const s = await connected(ho, {}, { userId: null });
    expect(s.outside('en').cannotDecide).toBe('This store computer has not been told who is using this screen, so nothing can be decided here.');
    const outcome = await s.decideSupport('R-1', 'approved');
    expect(outcome).toEqual({ kind: 'nobody_named' });
    expect(s.presentDecideOutcome('en', outcome).label).toBe('This store computer has not been told who is using this screen, so nothing can be decided here. Nothing was sent.');
    expect(ho.decisions).toEqual([]);
  });

  it('never decides against a list head office has not just given', async () => {
    const ho = headOffice();
    const s = await connected(ho);
    ho.readAnswer = { result: 'lost_link' };
    await s.refreshSupport();
    expect(await s.decideSupport('R-1', 'approved')).toEqual({ kind: 'not_read' });
    expect(ho.decisions).toEqual([]);
  });

  it('a request no longer waiting is said so — and the list is read again; nothing is sent', async () => {
    const ho = headOffice();
    const s = await connected(ho);
    expect(await s.decideSupport('R-GONE', 'approved')).toEqual({ kind: 'not_waiting' });
    expect(ho.decisions).toEqual([]);
    expect(ho.reads).toHaveLength(2);
  });

  it('the person’s OWN request is never sent to be decided (§28)', async () => {
    const ho = headOffice({ pending: [request({ requesterId: 'u-owner' })] });
    const s = await connected(ho);
    const outcome = await s.decideSupport('R-1', 'approved');
    expect(outcome).toEqual({ kind: 'own_request' });
    expect(s.presentDecideOutcome('en', outcome).label).toBe('You asked for this yourself, so someone else must decide it (§28). Nothing was sent.');
    expect(ho.decisions).toEqual([]);
  });
});

describe('head office’s own answers to a decision are said in plain words', () => {
  const answered = async (answer: SupportDecisionResult): Promise<{ outcome: SupportDecideOutcome; label: string; ho: FakeHeadOffice }> => {
    const ho = headOffice();
    const s = await connected(ho);
    ho.decideAnswer = answer;
    const outcome = await s.decideSupport('R-1', 'approved', '30');
    return { outcome, label: s.presentDecideOutcome('en', outcome).label, ho };
  };

  it('409 — someone already decided it', async () => {
    const { outcome, label, ho } = await answered({ result: 'refused', code: 'support_request_already_decided', whatHappened: 'Request \'R-1\' is already approved.' });
    expect(outcome.kind).toBe('already_decided');
    expect(label).toBe('Someone already decided this request: Request \'R-1\' is already approved.');
    expect(ho.reads, 'the list is read again').toHaveLength(2);
  });

  it('404 — head office has no such request', async () => {
    const { outcome, label } = await answered({ result: 'refused', code: 'unknown_support_request', whatHappened: 'There is no support-access request \'R-1\'.' });
    expect(outcome.kind).toBe('unknown_request');
    expect(label).toBe('Head office has no such request — it may have been withdrawn. The list has been read again.');
  });

  it('422 — head office’s rules refused it, in head office’s own words', async () => {
    const why = 'support may never hold payment.commit — the people who fix the system do not approve its money';
    const { outcome, label } = await answered({ result: 'refused', code: 'support_access_refused', whatHappened: why });
    expect(outcome).toEqual({ kind: 'refused_by_policy', whatHappened: why });
    expect(label).toBe(`Head office’s rules refused this, and nobody was let in: ${why}`);
  });

  it('403 — not permitted at head office', async () => {
    const { outcome, label } = await answered({ result: 'refused', code: 'forbidden', whatHappened: 'This account does not hold "platform.support.grant".' });
    expect(outcome.kind).toBe('not_permitted_at_head_office');
    expect(label).toBe('Head office says you are not permitted to decide outside access. Nothing was decided.');
    // A 403 with no readable code reads the same way.
    expect((await answered({ result: 'refused', code: 'http_403', whatHappened: '' })).outcome.kind).toBe('not_permitted_at_head_office');
  });

  it('a lost link — nothing was decided, and nothing is assumed', async () => {
    const { outcome, label, ho } = await answered({ result: 'lost_link' });
    expect(outcome).toEqual({ kind: 'lost_link' });
    expect(label).toBe('No connection to head office — nothing was decided. Try again.');
    expect(ho.reads, 'no re-read is pretended after a lost link').toHaveLength(1);
  });

  it('any other refusal — head office’s words, or a plain sentence when it gave none', async () => {
    expect((await answered({ result: 'refused', code: 'idempotency_key_missing', whatHappened: 'A write arrived without an Idempotency-Key.' })).label)
      .toBe('Not decided: A write arrived without an Idempotency-Key.');
    expect((await answered({ result: 'refused', code: 'http_500', whatHappened: '' })).label).toBe('Not decided — head office refused it.');
    expect((await answered({ result: 'refused', code: 'support_access_refused', whatHappened: '' })).label)
      .toBe('Head office’s rules refused this, and nobody was let in.');
  });
});

describe('a live session can be ended early, in the owner’s own session', () => {
  const live = session({ sessionId: 'S-LIVE', startedAt: '2026-08-06T13:30:00.000Z', expiresAt: '2026-08-06T14:45:00.000Z' });

  it('ends it: one POST naming only the session; the list is read again and it shows as ended early', async () => {
    const ho = headOffice({ pending: [], sessions: [live] });
    const s = await connected(ho);
    const outcome = await s.endSupport('S-LIVE');
    expect(ho.ends).toEqual([{ sessionId: 'S-LIVE' }]);
    expect(outcome).toEqual({ kind: 'ended', who: 'Engineer', endedAt: HO_AT });
    expect(s.presentEndOutcome('en', outcome)).toMatchObject({ tone: 'ok', label: 'Ended. Engineer can no longer see your data — from 06-08-2026 19:35.' });
    expect(s.support()[0]).toMatchObject({ active: false, endedAt: '06-08-2026 19:35' });
  });

  it('a session that is not live is not sent to be ended', async () => {
    const ho = headOffice({ pending: [], sessions: [{ ...live, expiresAt: '2026-08-06T14:01:00.000Z' }] });
    const s = await connected(ho);
    expect(await s.endSupport('S-LIVE')).toEqual({ kind: 'not_live' });
    expect(await s.endSupport('S-NOBODY')).toEqual({ kind: 'not_live' });
    expect(ho.ends).toEqual([]);
  });

  it('head office’s refusals and a lost link, in plain words', async () => {
    const cases: [SupportEndResult, SupportEndOutcome['kind'], string][] = [
      [{ result: 'refused', code: 'unknown_support_session', whatHappened: 'There is no granted support session.' }, 'unknown_session', 'Head office has no such session. The list has been read again.'],
      [{ result: 'refused', code: 'forbidden', whatHappened: '' }, 'not_permitted_at_head_office', 'Head office says you are not permitted to end outside access. The session was NOT ended.'],
      [{ result: 'refused', code: 'http_500', whatHappened: 'Database unavailable.' }, 'refused', 'Not ended: Database unavailable.'],
      [{ result: 'lost_link' }, 'lost_link', 'No connection to head office — the session was NOT ended. Try again.'],
    ];
    for (const [answer, kind, words] of cases) {
      const ho = headOffice({ pending: [], sessions: [live] });
      const s = await connected(ho);
      ho.endAnswer = answer;
      const outcome = await s.endSupport('S-LIVE');
      expect(outcome.kind).toBe(kind);
      expect(s.presentEndOutcome('en', outcome).label).toBe(words);
    }
  });
});

describe('every word of the outside-access tab is in English AND Tamil', () => {
  it('has no gap in either language', () => {
    const gaps = bilingualGaps(SUPPORT_ACCESS_COPY, SUPPORT_COPY_KEYS);
    expect(gaps.en).toEqual([]);
    expect(gaps.ta).toEqual([]);
  });

  it('the Tamil is Tamil — every entry carries Tamil script and none is the English copied over', () => {
    for (const key of SUPPORT_COPY_KEYS) {
      expect(SUPPORT_ACCESS_COPY.ta[key], key).toMatch(TAMIL);
      expect(SUPPORT_ACCESS_COPY.ta[key], key).not.toBe(SUPPORT_ACCESS_COPY.en[key]);
    }
  });

  it('every outcome, decide and end, has a presentation with words and an icon — in both languages', async () => {
    const s = await connected(headOffice());
    const decide: Record<SupportDecideOutcome['kind'], SupportDecideOutcome> = {
      approved: { kind: 'approved', who: 'Ravi', minutes: 30, until: HO_AT, scopes: ['read:settlements'] },
      rejected: { kind: 'rejected', who: 'Ravi' },
      nobody_named: { kind: 'nobody_named' }, not_permitted: { kind: 'not_permitted' }, not_connected: { kind: 'not_connected' },
      not_read: { kind: 'not_read' }, not_waiting: { kind: 'not_waiting' }, own_request: { kind: 'own_request' },
      minutes_unreadable: { kind: 'minutes_unreadable', asked: 60 }, longer_than_asked: { kind: 'longer_than_asked', asked: 60, typed: 90 },
      already_decided: { kind: 'already_decided', whatHappened: 'already approved' },
      unknown_request: { kind: 'unknown_request', whatHappened: '' },
      refused_by_policy: { kind: 'refused_by_policy', whatHappened: 'no money scopes' },
      not_permitted_at_head_office: { kind: 'not_permitted_at_head_office', whatHappened: '' },
      refused: { kind: 'refused', code: 'x', whatHappened: '' }, lost_link: { kind: 'lost_link' },
    };
    expect(Object.keys(decide).sort()).toEqual([...SUPPORT_DECIDE_OUTCOME_KINDS].sort());
    for (const outcome of Object.values(decide)) {
      const en = s.presentDecideOutcome('en', outcome);
      const ta = s.presentDecideOutcome('ta', outcome);
      expect(en.label.trim().length, outcome.kind).toBeGreaterThan(0);
      expect(en.icon.trim().length, outcome.kind).toBeGreaterThan(0);
      expect(ta.label, outcome.kind).toMatch(TAMIL);
      expect(ta.tone, outcome.kind).toBe(en.tone);
    }
    const end: Record<SupportEndOutcome['kind'], SupportEndOutcome> = {
      ended: { kind: 'ended', who: 'Ravi', endedAt: HO_AT },
      nobody_named: { kind: 'nobody_named' }, not_permitted: { kind: 'not_permitted' }, not_connected: { kind: 'not_connected' },
      not_read: { kind: 'not_read' }, not_live: { kind: 'not_live' },
      unknown_session: { kind: 'unknown_session', whatHappened: '' },
      not_permitted_at_head_office: { kind: 'not_permitted_at_head_office', whatHappened: '' },
      refused: { kind: 'refused', code: 'x', whatHappened: '' }, lost_link: { kind: 'lost_link' },
    };
    expect(Object.keys(end).sort()).toEqual([...SUPPORT_END_OUTCOME_KINDS].sort());
    for (const outcome of Object.values(end)) {
      expect(s.presentEndOutcome('en', outcome).label.trim().length, outcome.kind).toBeGreaterThan(0);
      expect(s.presentEndOutcome('ta', outcome).label, outcome.kind).toMatch(TAMIL);
    }
  });

  it('says an approval and a refusal in Tamil', async () => {
    const s = await connected(headOffice());
    expect(s.presentDecideOutcome('ta', { kind: 'approved', who: 'Ravi', minutes: 30, until: '2026-08-06T14:35:00.000Z', scopes: ['read:settlements'] }).label)
      .toBe('அனுமதிக்கப்பட்டது. Ravi 30 நிமிடங்களுக்கு, 06-08-2026 20:05 வரை, read:settlements பார்க்கலாம். அது தானாகவே முடிந்துவிடும்.');
    expect(s.presentDecideOutcome('ta', { kind: 'longer_than_asked', asked: 60, typed: 90 }).label)
      .toBe('நேரத்தைக் குறைக்க மட்டுமே முடியும், ஒருபோதும் நீட்டிக்க முடியாது. அவர்கள் கேட்டது 60 நிமிடங்கள்; 90 அதைவிட அதிகம். எதுவும் அனுப்பப்படவில்லை.');
    expect(s.outside('ta').source.label).toBe('தலைமை அலுவலகத்திலிருந்து, 06-08-2026 19:35 நிலவரப்படி.');
  });
});

// ── The browser's own calls to head office (browser-entry) ──────────────────

describe('the page calls head office in the signed-in person’s own session — and names nobody', () => {
  const originalFetch = (globalThis as { fetch?: typeof fetch }).fetch;
  afterEach(() => {
    if (originalFetch === undefined) delete (globalThis as { fetch?: typeof fetch }).fetch;
    else (globalThis as { fetch?: typeof fetch }).fetch = originalFetch;
  });

  type Call = { url: string; init: { method?: string; headers?: Record<string, string>; credentials?: string; body?: string } };
  const answering = (status: number, body: unknown): Call[] => {
    const calls: Call[] = [];
    (globalThis as { fetch?: typeof fetch }).fetch = (async (url: string, init: Record<string, unknown>) => {
      calls.push({ url, init: init as never });
      return { status, json: async () => body };
    }) as unknown as typeof fetch;
    return calls;
  };

  it('reads the state with a GET, and drops a row it cannot read rather than half-showing it', async () => {
    const calls = answering(200, {
      sessions: [{ ...session(), active: true }, { sessionId: 'S-BAD' }],
      pending: [request(), { requestId: 'R-BAD', requesterId: 'u-x', scopes: [], minutes: 10, at: NOW }],
      activeCount: 1, asAt: HO_AT,
    });
    const read = await HEAD_OFFICE_SUPPORT_ACCESS.read();
    expect(calls[0]).toMatchObject({ url: '/v1/platform/support-access/sessions', init: { method: 'GET', credentials: 'same-origin' } });
    expect(read.result).toBe('read');
    if (read.result !== 'read') return;
    expect(read.state.asAt).toBe(HO_AT);
    expect(read.state.pending.map((r) => r.requestId)).toEqual(['R-1']);
    expect(read.state.sessions.map((r) => r.sessionId)).toEqual(['S-1']);
    expect(read.state.sessions[0], 'head office’s stored flag is not carried').not.toHaveProperty('active');
  });

  it('POSTs a decision with an idempotency key and ONLY { decision, grantedMinutes? } — never a decider', async () => {
    const granted = session({ sessionId: 'R-1' });
    const calls = answering(200, { requestId: 'R-1', status: 'approved', session: granted });
    const approved = await HEAD_OFFICE_SUPPORT_ACCESS.decide({ requestId: 'R-1', decision: 'approved', grantedMinutes: 30 });
    expect(approved).toEqual({ result: 'approved', session: granted });
    expect(calls[0]!.url).toBe('/v1/platform/support-access/requests/R-1/decision');
    expect(calls[0]!.init).toMatchObject({ method: 'POST', credentials: 'same-origin' });
    expect(calls[0]!.init.headers?.['idempotency-key']).toBeTruthy();
    expect(JSON.parse(calls[0]!.init.body!)).toEqual({ decision: 'approved', grantedMinutes: 30 });

    const calls2 = answering(200, { requestId: 'R-1', status: 'rejected', decidedBy: 'u-owner', at: HO_AT });
    expect(await HEAD_OFFICE_SUPPORT_ACCESS.decide({ requestId: 'R-1', decision: 'rejected' })).toEqual({ result: 'rejected' });
    expect(JSON.parse(calls2[0]!.init.body!)).toEqual({ decision: 'rejected' });
  });

  it('reads head office’s refusal at body.error.code / whatHappened; a dropped link is a lost link, not a refusal', async () => {
    answering(422, { error: { code: 'support_access_refused', whatHappened: 'support may never hold payment.commit', wasItSaved: 'not_saved' } });
    expect(await HEAD_OFFICE_SUPPORT_ACCESS.decide({ requestId: 'R-1', decision: 'approved' }))
      .toEqual({ result: 'refused', code: 'support_access_refused', whatHappened: 'support may never hold payment.commit' });
    answering(409, {});
    expect(await HEAD_OFFICE_SUPPORT_ACCESS.decide({ requestId: 'R-1', decision: 'approved' })).toEqual({ result: 'refused', code: 'http_409', whatHappened: '' });
    (globalThis as { fetch?: typeof fetch }).fetch = (async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;
    expect(await HEAD_OFFICE_SUPPORT_ACCESS.decide({ requestId: 'R-1', decision: 'approved' })).toEqual({ result: 'lost_link' });
    expect(await HEAD_OFFICE_SUPPORT_ACCESS.read()).toEqual({ result: 'lost_link' });
    expect(await HEAD_OFFICE_SUPPORT_ACCESS.end({ sessionId: 'S-1' })).toEqual({ result: 'lost_link' });
  });

  it('POSTs an early end naming only the session, with an idempotency key', async () => {
    const calls = answering(200, { sessionId: 'S 1', endedAt: HO_AT });
    expect(await HEAD_OFFICE_SUPPORT_ACCESS.end({ sessionId: 'S 1' })).toEqual({ result: 'ended', endedAt: HO_AT });
    expect(calls[0]!.url).toBe('/v1/platform/support-access/sessions/S%201/end');
    expect(calls[0]!.init).toMatchObject({ method: 'POST', credentials: 'same-origin' });
    expect(calls[0]!.init.headers?.['idempotency-key']).toBeTruthy();
    expect(JSON.parse(calls[0]!.init.body!)).toEqual({});
  });

  it('only a holder of platform.support.grant may decide — never defaulted', () => {
    expect(adminPortsFromData({ permissions: ['platform.support.grant'] }).mayDecideSupport()).toBe(true);
    expect(adminPortsFromData({ permissions: ['platform.support.read'] }).mayDecideSupport()).toBe(false);
    expect(adminPortsFromData({}).mayDecideSupport()).toBe(false);
    expect(adminPortsFromData(undefined).mayDecideSupport()).toBe(false);
  });

  it('boots connected only when head office’s routes are handed in', () => {
    expect(bootAdmin({ userId: 'u-owner' })!.connected).toBe(false);
    expect(bootAdmin({ userId: 'u-owner' }, HEAD_OFFICE_SUPPORT_ACCESS)!.connected).toBe(true);
    expect(bootAdmin(undefined, HEAD_OFFICE_SUPPORT_ACCESS)).toBeNull();
  });
});

// ── Who has access to what ──────────────────────────────────────────────────

describe('who can get in, and who should not be able to', () => {
  it('flags a privileged account with no second factor', () => {
    const rows = admin({
      accounts: () => [account({ userId: 'u-boss', privileged: true, mfaEnrolled: false })],
    }).access();
    expect(rows[0]?.flags.join(' ')).toContain('second factor');
  });

  it('flags an account that has never logged in', () => {
    const rows = admin({ accounts: () => [account({ lastLoginAt: undefined })] }).access();
    expect(rows[0]?.flags.length).toBeGreaterThan(0);
  });

  it('uses the SHOP’s own dormancy window, not a constant', () => {
    const stale = account({ lastLoginAt: '2026-06-01T09:00:00.000Z' });
    expect(admin({ accounts: () => [stale] }, { dormantAfterDays: 30 }).access()[0]?.flags.length)
      .toBeGreaterThan(0);
    expect(admin({ accounts: () => [stale] }, { dormantAfterDays: 365 }).access()[0]?.flags)
      .toEqual([]);
  });
});

// ── The fleet ───────────────────────────────────────────────────────────────

describe('the tills and handhelds this shop runs on', () => {
  it('judges each device against the shop’s own version policy', () => {
    const fleet = admin().fleet();
    expect(fleet.policyKnown).toBe(true);
    expect(fleet.verdicts).toHaveLength(1);
    expect(fleet.summary?.total).toBe(1);
  });

  it('says nothing is being ENFORCED when the shop has set no policy', () => {
    // Judging every device against a minimum version nobody set would report a fleet as
    // compliant with a rule the shop never made.
    const fleet = admin({ versionPolicy: () => undefined }).fleet();
    expect(fleet.policyKnown).toBe(false);
    expect(fleet.summary).toBeUndefined();
    expect(fleet.verdicts).toEqual([]);
  });
});

// ── Retention and legal hold ────────────────────────────────────────────────

describe('what would be deleted, and what a hold stops', () => {
  const record = (over: Partial<AuditRecord> = {}): AuditRecord => ({
    sequence: 1, previousHash: '', hash: 'h1',
    objectType: 'sale', objectId: 'S-1', at: '2020-01-01T00:00:00.000Z',
    actorId: 'u-1', action: 'sale.committed',
    ...over,
  } as unknown as AuditRecord);

  it('reports NOTHING when the shop has set no retention policy at all', () => {
    // Different from nothing being due for deletion: the first is a shop that has never decided,
    // and "nothing to delete" would be reporting a decision nobody made.
    expect(admin({ auditRecords: () => [record()] }).retention()).toBeUndefined();
  });

  it('plans against the shop’s own policy once it has one', () => {
    const plan = admin({
      auditRecords: () => [record()],
      retentionPolicies: () => [{ objectType: 'sale', retainDays: 1, basis: 'ordinary trading record' } as RetentionPolicy],
    }).retention();
    expect(plan?.decisions).toHaveLength(1);
  });

  it('a legal hold outranks an expired retention date', () => {
    const plan = admin({
      auditRecords: () => [record()],
      retentionPolicies: () => [{ objectType: 'sale', retainDays: 1, basis: 'ordinary trading record' } as RetentionPolicy],
      legalHolds: () => [{ holdId: 'H-1', objectType: 'sale', reason: 'dispute' } as unknown as LegalHold],
    }).retention();
    expect(plan?.decisions[0]?.outcome).toBe('legal_hold');
    expect(plan?.decisions[0]?.explanation).toContain('survives the retention date');
  });

  it('keeps a record whose type has no policy, because silence never means discard', () => {
    const plan = admin({
      auditRecords: () => [record({ objectType: 'something_new' })],
      retentionPolicies: () => [{ objectType: 'sale', retainDays: 1, basis: 'ordinary trading record' } as RetentionPolicy],
    }).retention();
    expect(plan?.decisions[0]?.outcome).toBe('no_policy');
  });
});
