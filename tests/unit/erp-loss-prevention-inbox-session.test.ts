import { describe, it, expect } from 'vitest';
import {
  LP_INBOX_COPY, COPY_KEYS, LP_OUTCOMES, createLpInboxSession,
  type LpInboxPorts, type LpWorklistData, type LpCaseView, type CloseResult,
} from '../../apps/web-erp/src/loss-prevention-inbox-session';
import { bilingualGaps } from '../../packages/ui/src/index';

// The loss-prevention investigations inbox (M15-FR-04 · P-03 · §28). It shows every OPEN investigation,
// biggest exposure first, each reading as attention (never a bare colour), with the store's total open
// exposure; the one action from here is to CLOSE a case with an outcome + note (a human write in the
// manager's name). It refuses locally before any POST without permission, a valid outcome, or a note —
// and the server still enforces §28/evidence for a "proven" outcome, which the screen never fakes.

const caseView = (over: Partial<LpCaseView> & Pick<LpCaseView, 'caseId'>): LpCaseView => ({
  subjectRef: 'SUBJ-till-3',
  assignedTo: 'u-manager',
  summary: 'Till 3 came up ₹1,200 short at close',
  valueMinor: 120000,
  raisedFromRef: 'shift-close:2026-09-16:till-3',
  openedBy: 'system',
  openedAt: '2026-09-16T21:00:00Z',
  evidenceCount: 0,
  ...over,
});

const worklist = (cases: readonly LpCaseView[]): LpWorklistData => ({
  openCount: cases.length,
  totalValueMinor: cases.reduce((s, c) => s + c.valueMinor, 0),
  cases,
});

const session = (
  w: LpWorklistData,
  ports: Partial<LpInboxPorts> = {},
  userId: string | null = 'u-manager',
) =>
  createLpInboxSession({ userId }, {
    worklist: () => w,
    mayRead: () => true,
    mayManage: () => true,
    closePort: () => ({ post: async () => 'closed' as CloseResult }),
    ...ports,
  });

describe('the loss-prevention inbox copy is complete in both languages', () => {
  it('has no gap in either language across the whole vocabulary', () => {
    const gaps = bilingualGaps(LP_INBOX_COPY, COPY_KEYS);
    expect(gaps.en, `English missing: ${gaps.en.join(', ')}`).toEqual([]);
    expect(gaps.ta, `Tamil missing: ${gaps.ta.join(', ')}`).toEqual([]);
  });

  it('tripwire — the detector fires on a key genuinely absent', () => {
    const holey = { en: { ...LP_INBOX_COPY.en }, ta: { ...LP_INBOX_COPY.ta, scrReady: '' } };
    expect(bilingualGaps(holey, COPY_KEYS).ta).toContain('scrReady');
  });
});

describe('the view lists open investigations, attention-first, with exposure', () => {
  it('presents each open case as attention (degraded, icon+word, never colour alone), formats value and total', () => {
    const view = session(worklist([
      caseView({ caseId: 'C-2', valueMinor: 250000, summary: 'Refund spike on lane 2' }),
      caseView({ caseId: 'C-1', valueMinor: 120000 }),
    ])).view('en');

    expect(view.openCount).toBe(2);
    expect(view.totalValue).toBe('₹3,700.00');            // 250000 + 120000 minor = ₹3,700.00
    expect(view.screenState.tone).not.toBe('error');       // 'ready', not a fault

    const first = view.open[0]!;
    expect(first.caseId).toBe('C-2');                       // order is the worklist's (value-first), preserved
    expect(first.needsAttention).toBe(true);
    expect(first.status.tone).toBe('degraded');
    expect(first.status.icon.trim()).not.toBe('');          // a shape survives greyscale
    expect(first.status.label.trim()).not.toBe('');         // colour is never the only signal
    expect(first.value).toBe('₹2,500.00');
    expect(first.subjectRef).toBe('SUBJ-till-3');           // opaque reference, never a name (P-04)
  });

  it('an empty worklist is a calm "nothing outstanding", not an error', () => {
    const view = session(worklist([])).view('en');
    expect(view.openCount).toBe(0);
    expect(view.open).toEqual([]);
    expect(view.totalValue).toBe('₹0.00');
    expect(view.screenState.tone).not.toBe('error');
  });
});

describe('permission and identity gate what the screen offers', () => {
  it('a reader without lp.case.read sees nothing and a not-permitted state', () => {
    const view = session(worklist([caseView({ caseId: 'C-1' })]), { mayRead: () => false }).view('en');
    expect(view.open).toEqual([]);
    expect(view.openCount).toBe(0);
    expect(view.screenState.tone).toBe('error');
  });

  it('may-manage drives whether the close action is offered', () => {
    expect(session(worklist([caseView({ caseId: 'C-1' })]), { mayManage: () => false }).view('en').mayManage).toBe(false);
    expect(session(worklist([caseView({ caseId: 'C-1' })]), { mayManage: () => true }).view('en').mayManage).toBe(true);
  });

  it('nobody named at the desk is surfaced (a close carries a name)', () => {
    expect(session(worklist([]), {}, null).view('en').nobodyNamed).toBe(true);
    expect(session(worklist([]), {}, 'u-manager').view('en').nobodyNamed).toBe(false);
  });
});

describe('closing a case refuses locally before any POST, then delegates to the port', () => {
  it('refuses without permission, without a valid outcome, or without a note — and never POSTs', async () => {
    let posted = 0;
    const s = session(worklist([caseView({ caseId: 'C-1' })]), {
      mayManage: () => true,
      closePort: () => ({ post: async () => { posted += 1; return 'closed'; } }),
    });
    expect(await s.close('C-1', 'not-an-outcome', 'a note')).toBe('refused');
    expect(await s.close('C-1', 'unfounded', '   ')).toBe('refused');
    expect(posted).toBe(0);

    const noPerm = session(worklist([caseView({ caseId: 'C-1' })]), {
      mayManage: () => false,
      closePort: () => ({ post: async () => { posted += 1; return 'closed'; } }),
    });
    expect(await noPerm.close('C-1', 'unfounded', 'reviewed the CCTV — nothing to it')).toBe('refused');
    expect(posted).toBe(0);
  });

  it('a valid close (permission + known outcome + note) POSTs the trimmed decision and returns the result', async () => {
    const seen: { caseId: string; outcome: string; note: string }[] = [];
    const s = session(worklist([caseView({ caseId: 'C-1' })]), {
      mayManage: () => true,
      closePort: () => ({ post: async (i) => { seen.push(i); return 'closed'; } }),
    });
    expect(await s.close('C-1', 'unfounded', '  reviewed the CCTV — nothing to it  ')).toBe('closed');
    expect(seen).toEqual([{ caseId: 'C-1', outcome: 'unfounded', note: 'reviewed the CCTV — nothing to it' }]);
  });

  it('surfaces the server refusal (a "proven" close the engine rejects) and a lost link, unchanged', async () => {
    const refused = session(worklist([caseView({ caseId: 'C-1' })]), {
      closePort: () => ({ post: async () => 'refused' as CloseResult }),
    });
    expect(await refused.close('C-1', 'proven', 'the second signature is missing')).toBe('refused');

    const lost = session(worklist([caseView({ caseId: 'C-1' })]), {
      closePort: () => ({ post: async () => 'lost_link' as CloseResult }),
    });
    expect(await lost.close('C-1', 'inconclusive', 'no more can be established')).toBe('lost_link');
  });
});

describe('outcomes and result presentation are bilingual and glanceable', () => {
  it('offers all five first-class outcomes with human labels in each language', () => {
    const en = session(worklist([])).outcomeOptions('en');
    expect(en.map((o) => o.value)).toEqual([...LP_OUTCOMES]);
    expect(en.find((o) => o.value === 'unfounded')!.label).toBe('Unfounded');
    const ta = session(worklist([])).outcomeOptions('ta');
    expect(ta.map((o) => o.value)).toEqual([...LP_OUTCOMES]);
    expect(ta.every((o) => o.label.trim() !== '')).toBe(true);
  });

  it('presents each close result as a distinct tone with an icon and words', () => {
    const s = session(worklist([]));
    expect(s.presentCloseResult('en', 'closed').tone).toBe('ok');
    expect(s.presentCloseResult('en', 'lost_link').tone).toBe('degraded');
    expect(s.presentCloseResult('en', 'refused').tone).toBe('error');
    for (const r of ['closed', 'lost_link', 'refused'] as const) {
      expect(s.presentCloseResult('en', r).icon.trim()).not.toBe('');
      expect(s.presentCloseResult('en', r).label.trim()).not.toBe('');
    }
  });
});
