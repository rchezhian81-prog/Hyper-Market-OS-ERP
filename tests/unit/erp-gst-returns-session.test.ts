import { describe, it, expect } from 'vitest';
import {
  createGstReturnsSession, recommendedAction, GST_RETURNS_COPY, COPY_KEYS,
  commandActionsFor, returnCommandKey, buildReturnCommand, GST_RETURN_ACTION_EVENT,
  type GstReturnsPorts, type ReturnRow, type GstReturnActionPayload,
} from '../../apps/web-erp/src/gst-returns-session';
import { bilingualGaps } from '../../packages/ui/src/index';
import { SyncOutbox } from '../../packages/sync/src/outbox';

/**
 * **GST returns — the filing-status operator view (item 3, the 4th UI domain).**
 *
 * The screen shows every GSTR-1 filing period with the ones needing attention first — a portal rejection
 * (failed) or an unresolved outcome (unknown) — each with a status that is never a bare colour and, in plain
 * language, the next step. It is read-gated the same way the server is, and it files nothing (a stuck return
 * is surfaced for a person, never resolved silently — hard rule #10).
 */

const ROWS: ReturnRow[] = [
  { period: '042026', state: 'filed', arn: 'ARN-042026' },
  { period: '052026', state: 'approved', previewedBy: 'u-maker', approvedBy: 'u-checker' },
  { period: '062026', state: 'failed', detail: 'rejected (validation)' },
  { period: '072026', state: 'unknown', detail: 'no clear answer from the portal' },
  { period: '032026', state: 'previewed', previewedBy: 'u-maker' },
];

const ports = (over: Partial<GstReturnsPorts> = {}): GstReturnsPorts => {
  const box = new SyncOutbox();
  return {
    rows: () => ROWS,
    mayRead: () => true,
    mayApprove: () => true,
    maySubmit: () => true,
    outbox: () => box,
    ...over,
  };
};

const session = (over: Partial<GstReturnsPorts> = {}, userId: string | null = 'u-fin') =>
  createGstReturnsSession({ userId }, ports(over));

describe('recommendedAction', () => {
  it('maps each lifecycle state to the operator’s next step', () => {
    expect(recommendedAction('previewed')).toBe('approve');   // a second person must approve (maker ≠ checker)
    expect(recommendedAction('approved')).toBe('file');
    expect(recommendedAction('submitting')).toBe('wait');
    expect(recommendedAction('failed')).toBe('refile');
    expect(recommendedAction('unknown')).toBe('reconcile');   // never assumed filed (rule #10)
    expect(recommendedAction('filed')).toBe('none');
    expect(recommendedAction('cancelled')).toBe('none');
  });
});

describe('view', () => {
  it('puts the exceptions first (failed + unknown), then the rest by most-recent period', () => {
    const v = session().view('en');
    expect(v.total).toBe(5);
    expect(v.attentionCount).toBe(2); // failed + unknown
    // The two exceptions lead; within them, the most recent period (07) before (06).
    expect(v.rows.slice(0, 2).map((r) => r.period)).toEqual(['072026', '062026']);
    // The settled/in-progress ones follow, most-recent-period first (05 approved, 04 filed, 03 previewed).
    expect(v.rows.slice(2).map((r) => r.period)).toEqual(['052026', '042026', '032026']);
    // Every status carries a non-empty word + icon (never a bare colour) and a known tone.
    for (const r of v.rows) {
      expect(r.status.label.length).toBeGreaterThan(0);
      expect(r.status.icon.trim().length).toBeGreaterThan(0);
      expect(['ok', 'degraded', 'error', 'idle']).toContain(r.status.tone);
    }
  });

  it('a filed return reads as done (ok, no attention) and carries its portal reference', () => {
    const filed = session().view('en').rows.find((r) => r.period === '042026');
    expect(filed?.status.tone).toBe('ok');
    expect(filed?.needsAttention).toBe(false);
    expect(filed?.action).toBe('none');
    expect(filed?.arn).toBe('ARN-042026');
  });

  it('a rejected return reads as an exception that must be corrected and re-filed', () => {
    const failed = session().view('en').rows.find((r) => r.period === '062026');
    expect(failed?.status.tone).toBe('error');
    expect(failed?.needsAttention).toBe(true);
    expect(failed?.action).toBe('refile');
  });

  it('an unknown outcome reads as attention and says reconcile — never “filed” by assumption (rule #10)', () => {
    const unknown = session().view('en').rows.find((r) => r.period === '072026');
    expect(unknown?.needsAttention).toBe(true);
    expect(unknown?.action).toBe('reconcile');
  });

  it('surfaces who prepared and who approved a return, when the box knows', () => {
    const approved = session().view('en').rows.find((r) => r.period === '052026');
    expect(approved?.preparedBy).toBe('u-maker');
    expect(approved?.approvedByName).toBe('u-checker');
  });

  it('refuses the whole queue when the user may not read it — no periods leak', () => {
    const v = session({ mayRead: () => false }).view('en');
    expect(v.rows).toEqual([]);
    expect(v.total).toBe(0);
    expect(v.screenState.tone).toBe('error');
  });

  it('shows an empty state (not an error) when no filing period has been started', () => {
    const v = session({ rows: () => [] }).view('en');
    expect(v.total).toBe(0);
    expect(v.attentionCount).toBe(0);
    expect(v.screenState.tone).toBe('idle'); // empty is idle, not error
  });

  it('flags nobody-named when the box was not told who is looking', () => {
    expect(session({}, null).view('en').nobodyNamed).toBe(true);
    expect(session({}, 'u-fin').view('en').nobodyNamed).toBe(false);
  });

  it('renders in Tamil too — the status label changes with the language', () => {
    const en = session().view('en').rows.find((r) => r.period === '062026')?.status.label;
    const ta = session().view('ta').rows.find((r) => r.period === '062026')?.status.label;
    expect(en).toBeTruthy();
    expect(ta).toBeTruthy();
    expect(ta).not.toBe(en);
  });
});

// ── action-wiring: approve / submit → offline outbox command ────────────────────────────────────────────

/** A session sharing one outbox with the test, so an enqueue is observable. */
const acting = (over: Partial<GstReturnsPorts> = {}, userId: string | null = 'u-fin') => {
  const box = new SyncOutbox();
  const s = createGstReturnsSession({ userId }, ports({ outbox: () => box, ...over }));
  return { s, box };
};
const AT = '2026-08-14T11:00:00.000Z';

describe('commandActionsFor — only the two one-click governance steps, in the right states', () => {
  it('offers approve on a prepared return, submit on an approved one, and NOTHING elsewhere', () => {
    expect(commandActionsFor('previewed')).toEqual(['approve']);
    expect(commandActionsFor('approved')).toEqual(['submit']);
    // A stuck return (failed/unknown) is corrected or reconciled by a person — never a one-click button (rule #10).
    expect(commandActionsFor('failed')).toEqual([]);
    expect(commandActionsFor('unknown')).toEqual([]);
    // In-flight and terminal states offer nothing.
    expect(commandActionsFor('submitting')).toEqual([]);
    expect(commandActionsFor('filed')).toEqual([]);
    expect(commandActionsFor('cancelled')).toEqual([]);
  });
});

describe('view — the governance buttons each row offers', () => {
  it('a prepared return offers approve to a DIFFERENT person; an approved one offers submit', () => {
    const v = session().view('en'); // config userId = u-fin, which is not the maker u-maker
    const prepared = v.rows.find((r) => r.period === '032026');
    expect(prepared?.actions.map((a) => a.action)).toEqual(['approve']);
    expect(prepared?.actions[0]?.enabled).toBe(true);
    const approved = v.rows.find((r) => r.period === '052026');
    expect(approved?.actions.map((a) => a.action)).toEqual(['submit']);
    expect(approved?.actions[0]?.enabled).toBe(true);
  });

  it('the MAKER cannot approve their own return — the button is disabled and says so (maker ≠ checker, §28)', () => {
    const asMaker = session({}, 'u-maker').view('en');
    const prepared = asMaker.rows.find((r) => r.period === '032026');
    expect(prepared?.actions[0]?.enabled).toBe(false);
    expect(prepared?.actions[0]?.note).toBeTruthy();
  });

  it('a failed and an unknown return offer NO button — a person corrects/reconciles them (rule #10)', () => {
    const v = session().view('en');
    expect(v.rows.find((r) => r.period === '062026')?.actions).toEqual([]); // failed
    expect(v.rows.find((r) => r.period === '072026')?.actions).toEqual([]); // unknown
    expect(v.rows.find((r) => r.period === '042026')?.actions).toEqual([]); // filed
  });

  it('a user without the approve role sees approve disabled and told why; likewise submit', () => {
    const noApprove = session({ mayApprove: () => false }).view('en').rows.find((r) => r.period === '032026');
    expect(noApprove?.actions[0]?.enabled).toBe(false);
    expect(noApprove?.actions[0]?.note).toBeTruthy();
    const noSubmit = session({ maySubmit: () => false }).view('en').rows.find((r) => r.period === '052026');
    expect(noSubmit?.actions[0]?.enabled).toBe(false);
    expect(noSubmit?.actions[0]?.note).toBeTruthy();
  });
});

describe('requestAction — commits an offline command, never a network call', () => {
  it('enqueues a well-formed, PII-free approve command and marks the row requested', () => {
    const { s, box } = acting();
    const res = s.requestAction({ period: '032026', action: 'approve', at: AT });
    expect(res.ok).toBe(true);
    expect(box.unsentCount()).toBe(1);
    const item = box.pending()[0]!;
    expect(item.event.type).toBe(GST_RETURN_ACTION_EVENT);
    expect(item.event.source).toBe('web-erp/gst-returns');
    const payload = item.event.payload as GstReturnActionPayload;
    expect(payload).toEqual({ period: '032026', action: 'approve', requestedBy: 'u-fin', observedState: 'previewed' });
    expect(item.event.idempotencyKey).toBe(returnCommandKey('032026', 'approve', 'previewed'));
    const action = s.view('en').rows.find((r) => r.period === '032026')?.actions[0];
    expect(action?.queued).toBe('pending');
    expect(action?.enabled).toBe(false);
  });

  it('is idempotent — a double click collapses to ONE command', () => {
    const { s, box } = acting();
    const a = s.requestAction({ period: '052026', action: 'submit', at: AT });
    const b = s.requestAction({ period: '052026', action: 'submit', at: AT });
    expect(a.ok).toBe(true);
    expect(b).toEqual({ ok: false, reason: 'already_queued' });
    expect(box.unsentCount()).toBe(1);
  });

  it('refuses a MAKER approving their own return, and queues nothing (§28)', () => {
    const asMaker = acting({}, 'u-maker');
    expect(asMaker.s.requestAction({ period: '032026', action: 'approve', at: AT })).toEqual({ ok: false, reason: 'self_approval' });
    expect(asMaker.box.unsentCount()).toBe(0);
  });

  it('refuses an action a state does not offer — a filed or failed return is never advanced by a button (rule #10)', () => {
    const { s, box } = acting();
    expect(s.requestAction({ period: '042026', action: 'approve', at: AT })).toEqual({ ok: false, reason: 'not_actionable' }); // filed
    expect(s.requestAction({ period: '062026', action: 'submit', at: AT })).toEqual({ ok: false, reason: 'not_actionable' }); // failed
    expect(s.requestAction({ period: '052026', action: 'approve', at: AT })).toEqual({ ok: false, reason: 'not_actionable' }); // approved offers submit, not approve
    expect(box.unsentCount()).toBe(0);
  });

  it('refuses without the role, without a named operator, and for an unknown period', () => {
    const noApprove = acting({ mayApprove: () => false });
    expect(noApprove.s.requestAction({ period: '032026', action: 'approve', at: AT })).toEqual({ ok: false, reason: 'not_permitted' });
    const noSubmit = acting({ maySubmit: () => false });
    expect(noSubmit.s.requestAction({ period: '052026', action: 'submit', at: AT })).toEqual({ ok: false, reason: 'not_permitted' });
    const nobody = acting({}, null);
    expect(nobody.s.requestAction({ period: '052026', action: 'submit', at: AT })).toEqual({ ok: false, reason: 'not_permitted' });
    const { s } = acting();
    expect(s.requestAction({ period: '999999', action: 'submit', at: AT })).toEqual({ ok: false, reason: 'unknown_period' });
  });

  it('a re-request after the return has moved to a new state is a DISTINCT command', () => {
    expect(returnCommandKey('052026', 'submit', 'approved'))
      .not.toBe(returnCommandKey('052026', 'submit', 'submitting'));
  });

  it('buildReturnCommand uses its idempotency key as the event id, so a duplicate can only collapse', () => {
    const cmd = buildReturnCommand({ period: '052026', action: 'submit', observedState: 'approved', requestedBy: 'u-fin', at: AT });
    expect(cmd.id).toBe(cmd.idempotencyKey);
    expect(cmd.occurredAt).toBe(AT);
  });
});

describe('the copy is complete in both languages', () => {
  it('has an English AND a Tamil word for every key the screen uses (packages/ui bilingualGaps)', () => {
    const gaps = bilingualGaps(GST_RETURNS_COPY, COPY_KEYS);
    expect(gaps.en, `English missing: ${gaps.en.join(', ')}`).toEqual([]);
    expect(gaps.ta, `Tamil missing: ${gaps.ta.join(', ')}`).toEqual([]);
  });
});
