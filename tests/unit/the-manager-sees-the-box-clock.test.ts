import { describe, it, expect } from 'vitest';
import { boxClockView, type BoxClockCheck } from '../../apps/web-erp/src/box-clock-view';

// OB-288 lane 2 · P2 · OB-327 (owner, in writing, 23 Oct 2026) · P-03 · P-08 — the manager's view of the store computer's
// clock: nothing while it agrees (control by exception); a warning at 2 minutes; at 5 minutes bills still commit but are
// listed by number for checking; English and Tamil, the box's own words.

const check = (verdict: BoxClockCheck['verdict'], over: Partial<BoxClockCheck> = {}): BoxClockCheck => ({
  verdict, offsetSeconds: verdict === 'flag_bills' ? 360 : verdict === 'warning' ? 150 : 3, lastCheckedAt: '2026-10-23T09:00:00.000Z',
  thresholds: { warnSeconds: 120, flagSeconds: 300 }, needsAttention: verdict === 'warning' || verdict === 'flag_bills',
  staffMessage: `en:${verdict}`, staffMessageTa: `ta:${verdict}`, ...over,
});
const BILL = { saleId: 's-9', number: 'L1-0009', laneId: 'L1', committedAt: '2026-10-23T09:05:00.000Z', offsetSeconds: 360 };

describe('the manager sees the store computer\'s clock (OB-327)', () => {
  it('shows nothing while the clock agrees, or before a first check with nothing marked', () => {
    expect(boxClockView('en', check('in_step'), []).show).toBe(false);
    expect(boxClockView('en', check('not_checked', { needsAttention: false, offsetSeconds: null }), undefined).show).toBe(false);
    expect(boxClockView('en', undefined, undefined).show).toBe(false);
  });

  it('warns at 2 minutes in the box\'s own words, beside a clock', () => {
    expect(boxClockView('en', check('warning'), [])).toMatchObject({ show: true, tone: 'warn', icon: 'clock', words: 'en:warning', bills: [] });
    expect(boxClockView('ta', check('warning'), []).words).toBe('ta:warning');
  });

  it('at 5 minutes, says bills are being marked and lists each by number, lane, time and how far out', () => {
    const v = boxClockView('en', check('flag_bills'), [BILL]);
    expect(v).toMatchObject({ show: true, tone: 'error', icon: 'circle-alert', words: 'en:flag_bills' });
    expect(v.billsHeading).toContain('5 minutes or more out');
    expect(v.bills).toEqual([{ saleId: 's-9', label: 'L1-0009 · lane L1 · 2026-10-23T09:05:00.000Z · out by 6 min 0 s' }]);
    expect(boxClockView('ta', check('flag_bills'), [BILL]).billsHeading).toMatch(/[஀-௿]/);
  });

  it('keeps the marked bills on show after the clock is put right, until a person has checked them (never hidden by a later "fine")', () => {
    const v = boxClockView('en', check('in_step'), [BILL]);
    expect(v.show).toBe(true);
    expect(v.tone).toBe('warn');
    expect(v.bills).toHaveLength(1);
  });

  it('a box whose own setting moved the number says that number', () => {
    expect(boxClockView('en', check('flag_bills', { thresholds: { warnSeconds: 60, flagSeconds: 600 } }), [BILL]).billsHeading).toContain('10 minutes');
  });
});
