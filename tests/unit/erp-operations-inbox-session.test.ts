import { describe, it, expect } from 'vitest';
import {
  OPERATIONS_INBOX_COPY, COPY_KEYS, createOperationsInboxSession,
  type OperationsInboxPorts, type OperationsWorklistData, type OperationsWorklistEntry, type OperationsFindingView,
} from '../../apps/web-erp/src/operations-inbox-session';
import { bilingualGaps } from '../../packages/ui/src/index';

// The Operations inbox screen (A06 · API-13 · P-05). It shows the OPEN recommendations to act on and the
// SET-ASIDE ones an operator set aside; open ones read as attention (a 'down' incident graver than a degraded
// one), set-aside ones do not; it is bilingual and never a bare colour; and it honours governance — when the
// agent is off there is a plain-English note, never an empty screen a person reads as "all clear". Read-only.

const finding = (over: Partial<OperationsFindingView> & Pick<OperationsFindingView, 'findingId'>): OperationsFindingView => ({
  alertId: 'dl-1',
  component: 'dead_letter',
  status: 'degraded',
  headline: 'The dead-letter queue is growing',
  detail: 'Messages are parking and not draining.',
  runbook: 'Open the dead-letter queue, park the poison item, let the rest drain.',
  ...over,
});
const openEntry = (id: string, over: Partial<OperationsFindingView> = {}): OperationsWorklistEntry =>
  ({ finding: finding({ findingId: id, ...over }), status: 'open' });
const dismissedEntry = (id: string): OperationsWorklistEntry => ({
  finding: finding({ findingId: id, component: 'sync', headline: 'Sync is behind' }),
  status: 'dismissed',
  dismissal: { by: 'u-op', at: '2026-09-15T00:00:00Z', reason: 'already being handled by the on-call operator' },
});

const worklist = (over: Partial<OperationsWorklistData> = {}): OperationsWorklistData =>
  ({ agentActive: true, open: [], dismissed: [], ...over });
const session = (w: OperationsWorklistData, ports: Partial<OperationsInboxPorts> = {}, userId: string | null = 'u-owner') =>
  createOperationsInboxSession({ userId }, {
    worklist: () => w, mayRead: () => true, mayDismiss: () => true, dismissPort: () => ({ post: async () => 'recorded' }), ...ports,
  });

describe('the operations inbox copy is complete in both languages', () => {
  it('has no gap in either language across the whole vocabulary', () => {
    const gaps = bilingualGaps(OPERATIONS_INBOX_COPY, COPY_KEYS);
    expect(gaps.en, `English missing: ${gaps.en.join(', ')}`).toEqual([]);
    expect(gaps.ta, `Tamil missing: ${gaps.ta.join(', ')}`).toEqual([]);
  });

  it('tripwire — the detector fires on a key genuinely absent', () => {
    const holey = { en: { ...OPERATIONS_INBOX_COPY.en }, ta: { ...OPERATIONS_INBOX_COPY.ta, scrReady: '' } };
    expect(bilingualGaps(holey, COPY_KEYS).ta).toContain('scrReady');
  });
});

describe('open recommendations read as attention; set-aside ones do not', () => {
  it('a degraded incident is attention (degraded tone), a down incident is graver (error tone), a set-aside one is idle with its reason', () => {
    const view = session(worklist({
      open: [openEntry('ops-runbook:dl-1'), openEntry('ops-runbook:db-1', { status: 'down', component: 'database', headline: 'Database is down' })],
      dismissed: [dismissedEntry('ops-runbook:sync-1')],
    })).view('en');
    expect(view.openCount).toBe(2);
    expect(view.dismissedCount).toBe(1);

    const degraded = view.open.find((r) => r.findingId === 'ops-runbook:dl-1')!;
    expect(degraded.needsAttention).toBe(true);
    expect(degraded.status.tone).toBe('degraded');
    expect(degraded.runbook).toContain('dead-letter');
    expect(degraded.component).toBe('dead_letter');

    const down = view.open.find((r) => r.findingId === 'ops-runbook:db-1')!;
    expect(down.status.tone).toBe('error'); // a down incident is graver than a degraded one

    const set = view.dismissed[0]!;
    expect(set.needsAttention).toBe(false);
    expect(set.status.tone).toBe('idle');
    expect(set.dismissedBy).toBe('u-op');
    expect(set.dismissedReason).toContain('on-call');
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
  it('when the agent is not active, shows a plain-English note and no rows — never a bare "all clear"', () => {
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
  it('offers the action only to an operator who holds the permission (mayDismiss)', () => {
    expect(session(worklist(), { mayDismiss: () => true }).view('en').mayDismiss).toBe(true);
    expect(session(worklist(), { mayDismiss: () => false }).view('en').mayDismiss).toBe(false);
  });

  it('records a set-aside with a trimmed reason through the port, and reopens through it', async () => {
    const posted: unknown[] = [];
    const s = session(worklist(), { dismissPort: () => ({ post: async (i) => { posted.push(i); return 'recorded'; } }) });
    expect(await s.dismiss('ops-runbook:dl-1', '  already handling  ')).toBe('recorded');
    expect(await s.reopen('ops-runbook:sync-1')).toBe('recorded');
    expect(posted).toEqual([
      { findingId: 'ops-runbook:dl-1', dismissed: true, reason: 'already handling' },
      { findingId: 'ops-runbook:sync-1', dismissed: false, reason: '' },
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
