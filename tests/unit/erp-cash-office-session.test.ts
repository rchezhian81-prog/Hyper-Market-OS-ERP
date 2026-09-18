import { describe, it, expect } from 'vitest';
import {
  CASH_OFFICE_COPY, COPY_KEYS, OVER_SHORT_DISPOSITIONS, createCashOfficeSession,
  type CashOfficePorts, type CashOverShortData, type OverShortView, type SignOffResult,
} from '../../apps/web-erp/src/cash-office-session';
import { bilingualGaps } from '../../packages/ui/src/index';

// The cash-office over/short sign-off screen (M14-FR-02 · API-05 · P-03 · §28). It shows every OPEN
// over/short, biggest first, each reading as attention (never a bare colour), with the net exposure; the
// one action from here is to SIGN OFF a variance with a coded finding (a human write in the reviewer's
// name). It refuses locally before any POST without permission, a finding, or when the reviewer counted the
// drawer themselves (§28 separation of duties) — and the server still enforces §28, which the screen never
// bypasses.

const row = (over: Partial<OverShortView> & Pick<OverShortView, 'shiftId'>): OverShortView => ({
  tillId: 'till-3',
  cashierId: 'u-cashier',
  tradingDay: '2026-09-17',
  varianceMinor: -120000, // ₹1,200 short
  reasonCode: 'gave_wrong_change',
  ...over,
});

const worklist = (open: readonly OverShortView[]): CashOverShortData => ({
  openCount: open.length,
  totalVarianceMinor: open.reduce((s, r) => s + r.varianceMinor, 0),
  open,
});

const session = (
  w: CashOverShortData,
  ports: Partial<CashOfficePorts> = {},
  userId: string | null = 'u-cashoffice',
) =>
  createCashOfficeSession({ userId }, {
    worklist: () => w,
    mayRead: () => true,
    mayReview: () => true,
    signOffPort: () => ({ post: async () => 'signed' as SignOffResult }),
    ...ports,
  });

describe('the cash-office copy is complete in both languages', () => {
  it('has no gap in either language across the whole vocabulary', () => {
    const gaps = bilingualGaps(CASH_OFFICE_COPY, COPY_KEYS);
    expect(gaps.en, `English missing: ${gaps.en.join(', ')}`).toEqual([]);
    expect(gaps.ta, `Tamil missing: ${gaps.ta.join(', ')}`).toEqual([]);
  });

  it('tripwire — the detector fires on a key genuinely absent', () => {
    const holey = { en: { ...CASH_OFFICE_COPY.en }, ta: { ...CASH_OFFICE_COPY.ta, scrReady: '' } };
    expect(bilingualGaps(holey, COPY_KEYS).ta).toContain('scrReady');
  });
});

describe('the view lists open over/shorts, biggest first, with direction and net exposure', () => {
  it('presents each open row as attention (degraded, icon+word), orders by |variance|, formats amounts', () => {
    const view = session(worklist([
      row({ shiftId: 'S-1', varianceMinor: -50000 }),   // ₹500 short
      row({ shiftId: 'S-2', varianceMinor: 240000, tillId: 'till-1' }), // ₹2,400 over — biggest
    ])).view('en');

    expect(view.openCount).toBe(2);
    // net = -50000 + 240000 = +190000 → signed ₹ with a leading +
    expect(view.totalVariance).toBe('+₹1,900.00');
    expect(view.screenState.tone).not.toBe('error');

    const first = view.open[0]!;
    expect(first.shiftId).toBe('S-2');                    // biggest |variance| first
    expect(first.direction).toBe('Over');                 // varianceMinor > 0
    expect(first.amount).toBe('₹2,400.00');               // magnitude, no sign (direction carries it)
    expect(first.needsAttention).toBe(true);
    expect(first.status.tone).toBe('degraded');
    expect(first.status.icon.trim()).not.toBe('');        // a shape survives greyscale
    expect(first.status.label.trim()).not.toBe('');       // colour is never the only signal

    const second = view.open[1]!;
    expect(second.direction).toBe('Short');               // varianceMinor < 0
    expect(second.amount).toBe('₹500.00');
  });

  it('an empty worklist is a calm "all signed off", not an error', () => {
    const view = session(worklist([])).view('en');
    expect(view.openCount).toBe(0);
    expect(view.open).toEqual([]);
    expect(view.totalVariance).toBe('₹0.00');
    expect(view.screenState.tone).not.toBe('error');
  });
});

describe('permission and identity gate what the screen offers', () => {
  it('a reader without till.shift.read sees nothing and a not-permitted state', () => {
    const view = session(worklist([row({ shiftId: 'S-1' })]), { mayRead: () => false }).view('en');
    expect(view.open).toEqual([]);
    expect(view.openCount).toBe(0);
    expect(view.screenState.tone).toBe('error');
  });

  it('may-review drives whether the sign-off action is offered', () => {
    expect(session(worklist([row({ shiftId: 'S-1' })]), { mayReview: () => false }).view('en').mayReview).toBe(false);
    expect(session(worklist([row({ shiftId: 'S-1' })]), { mayReview: () => true }).view('en').mayReview).toBe(true);
  });

  it('flags a drawer the logged-in reviewer counted themselves (§28 — someone else must sign it off)', () => {
    const own = session(worklist([row({ shiftId: 'S-1', cashierId: 'u-me' })]), {}, 'u-me').view('en');
    expect(own.open[0]!.isOwnDrawer).toBe(true);
    const other = session(worklist([row({ shiftId: 'S-1', cashierId: 'u-someone-else' })]), {}, 'u-me').view('en');
    expect(other.open[0]!.isOwnDrawer).toBe(false);
  });

  it('nobody named at the desk is surfaced (a sign-off carries a name)', () => {
    expect(session(worklist([]), {}, null).view('en').nobodyNamed).toBe(true);
    expect(session(worklist([]), {}, 'u-cashoffice').view('en').nobodyNamed).toBe(false);
  });
});

describe('signing off refuses locally before any POST, then delegates to the port', () => {
  it('refuses without permission, without a known finding, or for an unknown shift — and never POSTs', async () => {
    let posted = 0;
    const s = session(worklist([row({ shiftId: 'S-1' })]), {
      mayReview: () => true,
      signOffPort: () => ({ post: async () => { posted += 1; return 'signed'; } }),
    });
    expect(await s.signOff('S-1', 'not-a-finding', 'a note')).toBe('refused'); // unknown disposition
    expect(await s.signOff('S-2', 'miscount', 'a note')).toBe('refused');       // unknown shift
    expect(posted).toBe(0);

    const noPerm = session(worklist([row({ shiftId: 'S-1' })]), {
      mayReview: () => false,
      signOffPort: () => ({ post: async () => { posted += 1; return 'signed'; } }),
    });
    expect(await noPerm.signOff('S-1', 'miscount', 'looked into it')).toBe('refused');
    expect(posted).toBe(0);
  });

  it('refuses the reviewer’s OWN drawer locally (§28) and never POSTs', async () => {
    let posted = 0;
    const s = session(worklist([row({ shiftId: 'S-1', cashierId: 'u-me' })]), {
      mayReview: () => true,
      signOffPort: () => ({ post: async () => { posted += 1; return 'signed'; } }),
    }, 'u-me');
    expect(await s.signOff('S-1', 'miscount', 'I counted it myself')).toBe('refused');
    expect(posted).toBe(0);
  });

  it('a valid sign-off (permission + known finding + not own drawer) POSTs the trimmed input and returns the result', async () => {
    const seen: { shiftId: string; disposition: string; note: string }[] = [];
    const s = session(worklist([row({ shiftId: 'S-1', cashierId: 'u-cashier' })]), {
      mayReview: () => true,
      signOffPort: () => ({ post: async (i) => { seen.push(i); return 'signed'; } }),
    }, 'u-cashoffice');
    expect(await s.signOff('S-1', 'change_error', '  gave a ₹500 note as change  ')).toBe('signed');
    expect(seen).toEqual([{ shiftId: 'S-1', disposition: 'change_error', note: 'gave a ₹500 note as change' }]);
  });

  it('an empty note is allowed (the finding is the record; the note is optional) and POSTs', async () => {
    const seen: { shiftId: string; disposition: string; note: string }[] = [];
    const s = session(worklist([row({ shiftId: 'S-1' })]), {
      signOffPort: () => ({ post: async (i) => { seen.push(i); return 'signed'; } }),
    });
    expect(await s.signOff('S-1', 'unexplained', '   ')).toBe('signed');
    expect(seen[0]!.note).toBe('');
  });

  it('surfaces a server refusal and a lost link, unchanged', async () => {
    const refused = session(worklist([row({ shiftId: 'S-1' })]), {
      signOffPort: () => ({ post: async () => 'refused' as SignOffResult }),
    });
    expect(await refused.signOff('S-1', 'miscount', 'x')).toBe('refused');

    const lost = session(worklist([row({ shiftId: 'S-1' })]), {
      signOffPort: () => ({ post: async () => 'lost_link' as SignOffResult }),
    });
    expect(await lost.signOff('S-1', 'banking_variance', 'x')).toBe('lost_link');
  });
});

describe('dispositions and result presentation are bilingual and glanceable', () => {
  it('offers every disposition with a human label in each language', () => {
    const en = session(worklist([])).dispositionOptions('en');
    expect(en.map((o) => o.value)).toEqual([...OVER_SHORT_DISPOSITIONS]);
    expect(en.find((o) => o.value === 'theft_suspected')!.label).toBe('Suspected theft');
    const ta = session(worklist([])).dispositionOptions('ta');
    expect(ta.map((o) => o.value)).toEqual([...OVER_SHORT_DISPOSITIONS]);
    expect(ta.every((o) => o.label.trim() !== '')).toBe(true);
  });

  it('presents each sign-off result as a distinct tone with an icon and words', () => {
    const s = session(worklist([]));
    expect(s.presentSignOffResult('en', 'signed').tone).toBe('ok');
    expect(s.presentSignOffResult('en', 'lost_link').tone).toBe('degraded');
    expect(s.presentSignOffResult('en', 'refused').tone).toBe('error');
    for (const r of ['signed', 'lost_link', 'refused'] as const) {
      expect(s.presentSignOffResult('en', r).icon.trim()).not.toBe('');
      expect(s.presentSignOffResult('en', r).label.trim()).not.toBe('');
    }
  });
});
