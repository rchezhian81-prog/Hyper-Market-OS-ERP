import { describe, it, expect } from 'vitest';
import {
  WORKFORCE_INBOX_COPY, COPY_KEYS, createWorkforceInboxSession,
  type WorkforceInboxPorts, type WorkforceWorklistData, type WorkforceWorklistEntry, type WorkforceFindingView,
} from '../../apps/web-erp/src/workforce-inbox-session';
import { bilingualGaps } from '../../packages/ui/src/index';

// The Workforce guidance inbox screen (A10 · API-13 · M25-FR-02 · P-05). It shows the OPEN guidance to act on
// and the SET-ASIDE ones a manager set aside; open ones read as attention (an escalated task graver than a
// plain overdue one), set-aside ones do not; it is bilingual and never a bare colour; and it honours
// governance — when the agent is off there is a plain-English note, never an empty screen a person reads as
// "all on track". Read-only.

const finding = (over: Partial<WorkforceFindingView> & Pick<WorkforceFindingView, 'findingId'>): WorkforceFindingView => ({
  taskId: 'T-chiller',
  kind: 'overdue',
  forRole: 'cashier',
  headline: '"Sweep the aisles" is 30 minute(s) overdue',
  detail: '30 minute(s) overdue',
  guidance: 'Assign someone to complete this task.',
  overdueByMinutes: 30,
  ...over,
});
const openEntry = (id: string, over: Partial<WorkforceFindingView> = {}): WorkforceWorklistEntry =>
  ({ finding: finding({ findingId: id, ...over }), status: 'open' });
const dismissedEntry = (id: string): WorkforceWorklistEntry => ({
  finding: finding({ findingId: id, taskId: 'T-float', kind: 'escalated', headline: '"Float count" is critical and 20 minute(s) overdue' }),
  status: 'dismissed',
  dismissal: { by: 'u-mgr', at: '2026-09-15T00:00:00Z', reason: 'already assigned to the closing shift lead' },
});

const worklist = (over: Partial<WorkforceWorklistData> = {}): WorkforceWorklistData =>
  ({ agentActive: true, open: [], dismissed: [], ...over });
const session = (w: WorkforceWorklistData, ports: Partial<WorkforceInboxPorts> = {}, userId: string | null = 'u-owner') =>
  createWorkforceInboxSession({ userId }, {
    worklist: () => w, mayRead: () => true, mayDismiss: () => true, dismissPort: () => ({ post: async () => 'recorded' }), ...ports,
  });

describe('the workforce inbox copy is complete in both languages', () => {
  it('has no gap in either language across the whole vocabulary', () => {
    const gaps = bilingualGaps(WORKFORCE_INBOX_COPY, COPY_KEYS);
    expect(gaps.en, `English missing: ${gaps.en.join(', ')}`).toEqual([]);
    expect(gaps.ta, `Tamil missing: ${gaps.ta.join(', ')}`).toEqual([]);
  });

  it('tripwire — the detector fires on a key genuinely absent', () => {
    const holey = { en: { ...WORKFORCE_INBOX_COPY.en }, ta: { ...WORKFORCE_INBOX_COPY.ta, scrReady: '' } };
    expect(bilingualGaps(holey, COPY_KEYS).ta).toContain('scrReady');
  });
});

describe('open guidance reads as attention; set-aside ones do not', () => {
  it('an overdue task is attention (degraded tone), an escalated one is graver (error tone), a set-aside one is idle with its reason', () => {
    const view = session(worklist({
      open: [openEntry('wf-guidance:overdue:T-sweep'), openEntry('wf-guidance:escalated:T-chiller', { kind: 'escalated', taskId: 'T-chiller', headline: '"Chiller check" is critical and 40 minute(s) overdue', guidance: 'Escalate to the manager on duty and get it done now.' })],
      dismissed: [dismissedEntry('wf-guidance:escalated:T-float')],
    })).view('en');
    expect(view.openCount).toBe(2);
    expect(view.dismissedCount).toBe(1);

    const overdue = view.open.find((r) => r.findingId === 'wf-guidance:overdue:T-sweep')!;
    expect(overdue.needsAttention).toBe(true);
    expect(overdue.status.tone).toBe('degraded');
    expect(overdue.guidance).toContain('Assign');
    expect(overdue.forRole).toBe('cashier');

    const escalated = view.open.find((r) => r.findingId === 'wf-guidance:escalated:T-chiller')!;
    expect(escalated.status.tone).toBe('error'); // an escalated task is graver than a plain overdue one
    expect(escalated.taskId).toBe('T-chiller');

    const set = view.dismissed[0]!;
    expect(set.needsAttention).toBe(false);
    expect(set.status.tone).toBe('idle');
    expect(set.dismissedBy).toBe('u-mgr');
    expect(set.dismissedReason).toContain('closing shift');
  });

  it('every rendered status carries a word and an icon — never colour alone', () => {
    const view = session(worklist({ open: [openEntry('a')], dismissed: [dismissedEntry('b')] })).view('en');
    for (const row of [...view.open, ...view.dismissed]) {
      expect(row.status.label.length).toBeGreaterThan(0);
      expect(row.status.icon.trim().length).toBeGreaterThan(0);
    }
  });

  it('a clean worklist reads as empty (not an error)', () => {
    const view = session(worklist()).view('en');
    expect(view.openCount).toBe(0);
    expect(view.dismissed).toEqual([]);
    expect(view.screenState.tone).not.toBe('error');
  });
});

describe('governance and permission', () => {
  it('when the agent is not active, shows a plain-English note and no rows — never a bare "all on track"', () => {
    const view = session(worklist({ agentActive: false, note: 'The kill switch is on.' })).view('en');
    expect(view.agentActive).toBe(false);
    expect(view.open).toEqual([]);
    expect(view.screenState.label).toBe('The kill switch is on.');
    expect(view.screenState.tone).not.toBe('error'); // off is not a fault
  });

  it('refuses to show anything without read permission', () => {
    const view = session(worklist({ open: [openEntry('a')] }), { mayRead: () => false }).view('en');
    expect(view.screenState.tone).toBe('error');
    expect(view.open).toEqual([]);
  });

  it('flags nobody-named when the box was not told who is looking', () => {
    expect(session(worklist(), {}, null).view('en').nobodyNamed).toBe(true);
  });
});

describe('the set-aside / bring-back action — a human write, refused before it ever POSTs when it should be', () => {
  it('offers the action only to a manager who holds the permission (mayDismiss)', () => {
    expect(session(worklist(), { mayDismiss: () => true }).view('en').mayDismiss).toBe(true);
    expect(session(worklist(), { mayDismiss: () => false }).view('en').mayDismiss).toBe(false);
  });

  it('records a set-aside with a trimmed reason through the port, and reopens through it', async () => {
    const posted: unknown[] = [];
    const s = session(worklist(), { dismissPort: () => ({ post: async (i) => { posted.push(i); return 'recorded'; } }) });
    expect(await s.dismiss('wf-guidance:overdue:T-sweep', '  already assigned  ')).toBe('recorded');
    expect(await s.reopen('wf-guidance:escalated:T-chiller')).toBe('recorded');
    expect(posted).toEqual([
      { findingId: 'wf-guidance:overdue:T-sweep', dismissed: true, reason: 'already assigned' },
      { findingId: 'wf-guidance:escalated:T-chiller', dismissed: false, reason: '' },
    ]);
  });

  it('refuses locally — no permission, or an empty reason — WITHOUT calling the port', async () => {
    let called = false;
    const port = () => ({ post: async () => { called = true; return 'recorded' as const; } });
    expect(await session(worklist(), { mayDismiss: () => false, dismissPort: port }).dismiss('f', 'r')).toBe('refused');
    expect(await session(worklist(), { dismissPort: port }).dismiss('f', '   ')).toBe('refused');
    expect(called).toBe(false);
  });

  it('presents each outcome distinctly — recorded is calm, refused/lost-link ask for attention', () => {
    const s = session(worklist());
    expect(s.presentDismissResult('en', 'recorded').tone).toBe('ok');
    expect(s.presentDismissResult('en', 'lost_link').needsAttention).toBe(true);
    expect(s.presentDismissResult('en', 'refused').tone).toBe('error');
  });
});
