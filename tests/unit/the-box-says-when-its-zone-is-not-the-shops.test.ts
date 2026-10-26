import { describe, it, expect } from 'vitest';
import { zoneCheck, packTimeZone, packTradingDay, packCalendarDate, packWallClock, isKnownTimeZone } from '../../edge/store-edge/src/shop-zone';
import { boxClockView, type BoxClockCheck } from '../../apps/web-erp/src/box-clock-view';

// Re-audit lane 1 R1a (M01-FR-02 · P-08): the store computer reads every date in the shop's zone from its pack, and says in
// words (English and Tamil) when the machine it runs on keeps another zone.

const pack = (timeZone?: string, cutoff = '00:00') => ({ policies: { known: true, value: { tradingDayCutoff: cutoff, ...(timeZone === undefined ? {} : { timeZone }) } } });
const UNKNOWN = { policies: { known: false } };
const AT_0040_IST_26_OCT = '2026-10-25T19:10:00.000Z';

describe('the box reads the shop zone from its pack', () => {
  it('uses the pack zone; falls back to the shop default (never the machine) when none or a bad one is named', () => {
    expect(packTimeZone(pack('Asia/Dubai'))).toBe('Asia/Dubai');
    expect(packTimeZone(pack())).toBe('Asia/Kolkata');
    expect(packTimeZone(pack('Not/AZone'))).toBe('Asia/Kolkata');
    expect(packTimeZone(UNKNOWN)).toBe('Asia/Kolkata');
    expect(isKnownTimeZone('')).toBe(false);
  });

  it('dates 00:40 IST on the 26th as the 26th, with the cut-off applied to the trading day only', () => {
    expect(packWallClock(pack('Asia/Kolkata'), AT_0040_IST_26_OCT)).toBe('2026-10-26T00:40');
    expect(packTradingDay(pack('Asia/Kolkata'), AT_0040_IST_26_OCT)).toBe('2026-10-26');
    expect(packTradingDay(pack('Asia/Kolkata', '02:00'), AT_0040_IST_26_OCT)).toBe('2026-10-25');
    expect(packCalendarDate(pack('Asia/Kolkata', '02:00'), AT_0040_IST_26_OCT)).toBe('2026-10-26');
    expect(packTradingDay(UNKNOWN, AT_0040_IST_26_OCT)).toBe('2026-10-26');
  });
});

describe('the zone check (P-08)', () => {
  it('a machine on UTC under an IST shop is an incident, said in English and Tamil', () => {
    const z = zoneCheck(pack('Asia/Kolkata'), 'UTC');
    expect(z).toMatchObject({ verdict: 'differs', shopTimeZone: 'Asia/Kolkata', shopTimeZoneFrom: 'store_pack', machineTimeZone: 'UTC', needsAttention: true });
    expect(z.staffMessage).toMatch(/UTC.*Asia\/Kolkata/);
    expect(z.staffMessageTa).toMatch(/[஀-௿]/);
  });

  it('the same clock under another name is in step; an unknown machine zone is not', () => {
    expect(zoneCheck(pack('Asia/Kolkata'), 'Asia/Kolkata')).toMatchObject({ verdict: 'in_step', needsAttention: false });
    expect(zoneCheck(pack('Asia/Kolkata'), 'Asia/Calcutta')).toMatchObject({ verdict: 'in_step' });
    expect(zoneCheck(pack(), 'Asia/Kolkata')).toMatchObject({ verdict: 'in_step', shopTimeZoneFrom: 'shop_default' });
    expect(zoneCheck(pack('Europe/London'), 'UTC')).toMatchObject({ verdict: 'differs' }); // summer time makes them differ
    expect(zoneCheck(pack('Asia/Kolkata'), 'Nowhere/Land')).toMatchObject({ verdict: 'differs' });
  });
});

describe('the manager sees the zone warning beside the clock strip', () => {
  const inStep: BoxClockCheck = { verdict: 'in_step', offsetSeconds: 1, lastCheckedAt: null, needsAttention: false, staffMessage: 'en:in_step', staffMessageTa: 'ta:in_step' };
  it('shows the strip, as a warning, with the zone words, when only the zone is out', () => {
    const v = boxClockView('en', inStep, [], zoneCheck(pack('Asia/Kolkata'), 'UTC'));
    expect(v).toMatchObject({ show: true, tone: 'warn' });
    expect(v.zoneWords).toContain('UTC');
    expect(boxClockView('ta', inStep, [], zoneCheck(pack('Asia/Kolkata'), 'UTC')).zoneWords).toMatch(/[஀-௿]/);
  });
  it('shows nothing about the zone when it agrees (control by exception)', () => {
    const v = boxClockView('en', inStep, [], zoneCheck(pack('Asia/Kolkata'), 'Asia/Kolkata'));
    expect(v).toMatchObject({ show: false, zoneWords: '' });
    expect(boxClockView('en', inStep, []).zoneWords).toBe('');
  });
});
