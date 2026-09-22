import { describe, it, expect } from 'vitest';
import {
  STORED_VALUE_COPY, COPY_KEYS, createStoredValueOversightSession,
  type StoredValueOversightPorts, type StoredValueOversightData,
  type DoubleSpendView, type VelocityFlagView, type LiabilityReconciliationView,
} from '../../apps/web-erp/src/stored-value-session';
import { bilingualGaps } from '../../packages/ui/src/index';

// The stored-value oversight desk (M17-FR-03/04 · P-03 control-by-exception · hard rule #10 · P-04). It
// folds three loss/books feeds — cards spent twice across channels (settled loss), the cards' liability
// vs what the books posted (a signed gap = unrecorded debt), and cards draining unusually fast (a watch)
// — into one worst-first read view. Every row reads by icon+word, never colour alone; nothing is written.

const doubleSpend = (over: Partial<DoubleSpendView> & Pick<DoubleSpendView, 'instrumentId'>): DoubleSpendView => ({
  ownerRef: 'CUST-9001',
  overspentMinor: 50000,
  channels: ['store', 'app'],
  detail: 'Spent in store and app while out of sync',
  ...over,
});

const velocity = (over: Partial<VelocityFlagView> & Pick<VelocityFlagView, 'instrumentId'>): VelocityFlagView => ({
  count: 7,
  valueMinor: 30000,
  windowMinutes: 60,
  detail: 'Redeemed 7 times in 60 minutes',
  ...over,
});

const liability = (over: Partial<LiabilityReconciliationView> = {}): LiabilityReconciliationView => ({
  outstandingMinor: 500000, issuedMinor: 800000, redeemedMinor: 280000, expiredMinor: 20000,
  postedLiabilityMinor: 500000, differenceMinor: 0, reconciles: true,
  detail: 'Reconciled', ...over,
});

const data = (over: Partial<StoredValueOversightData> = {}): StoredValueOversightData => ({
  liability: null, doubleSpends: [], velocity: [], asAt: '2026-09-22T10:00:00Z', ...over,
});

const session = (
  d: StoredValueOversightData,
  ports: Partial<StoredValueOversightPorts> = {},
  userId: string | null = 'u-manager',
) =>
  createStoredValueOversightSession({ userId }, {
    oversight: () => d,
    mayRead: () => true,
    ...ports,
  });

describe('the stored-value oversight copy is complete in both languages', () => {
  it('has no gap in either language across the whole vocabulary', () => {
    const gaps = bilingualGaps(STORED_VALUE_COPY, COPY_KEYS);
    expect(gaps.en, `English missing: ${gaps.en.join(', ')}`).toEqual([]);
    expect(gaps.ta, `Tamil missing: ${gaps.ta.join(', ')}`).toEqual([]);
  });

  it('tripwire — the detector fires on a key genuinely absent', () => {
    const holey = { en: { ...STORED_VALUE_COPY.en }, ta: { ...STORED_VALUE_COPY.ta, scrReady: '' } };
    expect(bilingualGaps(holey, COPY_KEYS).ta).toContain('scrReady');
  });
});

describe('double-spends read as settled loss, worst-first, never colour alone', () => {
  it('sorts by overspend, presents each as an error with icon+word, and totals the exposure', () => {
    const view = session(data({
      doubleSpends: [
        doubleSpend({ instrumentId: 'GC-small', overspentMinor: 20000 }),
        doubleSpend({ instrumentId: 'GC-big', overspentMinor: 90000 }),
      ],
    })).view('en');

    expect(view.doubleSpendCount).toBe(2);
    expect(view.totalOverspent).toBe('₹1,100.00');          // 90000 + 20000 minor = ₹1,100.00
    expect(view.anyException).toBe(true);
    expect(view.screenState.tone).not.toBe('error');         // 'ready' — a fault would be a not-permitted state

    const first = view.doubleSpends[0]!;
    expect(first.instrumentId).toBe('GC-big');               // biggest settled loss on top
    expect(first.overspent).toBe('₹900.00');
    expect(first.status.tone).toBe('error');
    expect(first.status.icon.trim()).not.toBe('');           // a shape survives greyscale
    expect(first.status.label.trim()).not.toBe('');          // colour is never the only signal
    expect(first.channels).toEqual(['store', 'app']);        // both channels named (hard rule #10)
  });
});

describe('the liability reconciliation carries its sign and status', () => {
  it('a reconciled liability reads OK', () => {
    const view = session(data({ liability: liability({ reconciles: true, differenceMinor: 0 }) })).view('en');
    expect(view.liability!.reconciles).toBe(true);
    expect(view.liability!.status.tone).toBe('ok');
    expect(view.anyException).toBe(false);                    // reconciled is not an exception
  });

  it('a gap reads as unrecorded debt (error) and formats the signed difference', () => {
    const view = session(data({
      liability: liability({ outstandingMinor: 500000, postedLiabilityMinor: 460000, differenceMinor: -40000, reconciles: false }),
    })).view('en');
    expect(view.liability!.reconciles).toBe(false);
    expect(view.liability!.status.tone).toBe('error');
    expect(view.liability!.difference).toBe('-₹400.00');      // signed: the books are short ₹400 vs the cards
    expect(view.anyException).toBe(true);
  });

  it('is simply absent (never guessed) until a posted figure is supplied', () => {
    const view = session(data({ liability: null })).view('en');
    expect(view.liability).toBeNull();
  });
});

describe('velocity is a watch, ranked below settled loss', () => {
  it('sorts by value, presents each as a degraded watch, and is NOT an exception on its own', () => {
    const view = session(data({
      velocity: [velocity({ instrumentId: 'V-small', valueMinor: 10000 }), velocity({ instrumentId: 'V-big', valueMinor: 80000 })],
    })).view('en');

    expect(view.velocityCount).toBe(2);
    expect(view.velocity[0]!.instrumentId).toBe('V-big');    // fastest/biggest drain first
    expect(view.velocity[0]!.status.tone).toBe('degraded');
    expect(view.velocity[0]!.value).toBe('₹800.00');
    expect(view.anyException).toBe(false);                    // detect-only — a look, not a settled loss
    expect(view.screenState.tone).not.toBe('error');
  });
});

describe('permission and identity gate the screen; all-clear is calm', () => {
  it('a reader without lp.case.read sees nothing and a not-permitted state', () => {
    const view = session(data({ doubleSpends: [doubleSpend({ instrumentId: 'GC-1' })] }), { mayRead: () => false }).view('en');
    expect(view.doubleSpends).toEqual([]);
    expect(view.velocity).toEqual([]);
    expect(view.liability).toBeNull();
    expect(view.screenState.tone).toBe('error');
  });

  it('all-clear is a calm empty state, not an error', () => {
    const view = session(data({})).view('en');
    expect(view.doubleSpendCount).toBe(0);
    expect(view.velocityCount).toBe(0);
    expect(view.anyException).toBe(false);
    expect(view.screenState.tone).not.toBe('error');
  });

  it('nobody named at the desk is surfaced', () => {
    expect(session(data({}), {}, null).view('en').nobodyNamed).toBe(true);
    expect(session(data({}), {}, 'u-manager').view('en').nobodyNamed).toBe(false);
  });
});
