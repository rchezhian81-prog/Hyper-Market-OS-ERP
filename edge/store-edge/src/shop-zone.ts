// The store computer dates by the SHOP's zone, not the machine's (re-audit lane 1 R1a · M01-FR-02 · P-08).
//
// The box runs in a container. A container keeps world time (UTC) unless it is told otherwise, and the Windows PC it sits
// on does not pass its zone in. Dated by the machine's zone, the box was on the previous day for the five and a half hours
// after the shop's midnight: a day close run at 00:30 IST on the 26th closed the 24th and refused the 25th until 05:30,
// while the till (a browser on Windows, in IST) had already moved on. So the box takes the shop's zone from its signed
// store pack (`policies.timeZone`, head office's `locale.time_zone`) and passes it to every wall-clock reading. The
// container's `TZ` is only a backstop. When the zone this machine resolves is not the shop's, the box SAYS so on every
// screen and in its log (P-08) — it still dates correctly, because it never asks the machine.

import { makeTradingDayRule, tradingDate, wallClockIn, type TradingCalendar, type TradingDayRule } from '../../../packages/calendar/src/trading-day';
import { DEFAULT_SHOP_CALENDAR, machineTimeZone } from '../../../packages/calendar/src/shop-clock';

/** The part of a store pack the shop's calendar is read from. */
export interface PackCalendarSource {
  readonly policies: { readonly known: boolean; readonly value?: { readonly tradingDayCutoff: string; readonly timeZone?: string } };
}

/** True when the runtime knows this IANA zone name. */
export function isKnownTimeZone(zone: unknown): zone is string {
  if (typeof zone !== 'string' || zone.trim() === '') return false;
  try { new Intl.DateTimeFormat('en-CA', { timeZone: zone }); return true; } catch { return false; }
}

/** The shop's zone as the pack names it — else the shop default (Asia/Kolkata), never the machine's. */
export function packTimeZone(pack: PackCalendarSource): string {
  const named = pack.policies.known ? pack.policies.value?.timeZone : undefined;
  return isKnownTimeZone(named) ? named : DEFAULT_SHOP_CALENDAR.timeZone;
}

/** The shop's trading-day rule (its cut-off) as the pack names it, else midnight. */
export function packRule(pack: PackCalendarSource): TradingDayRule {
  return makeTradingDayRule(pack.policies.known ? pack.policies.value!.tradingDayCutoff : DEFAULT_SHOP_CALENDAR.tradingDayCutoff);
}

/** The shop's calendar as the pack names it. */
export function packCalendar(pack: PackCalendarSource): TradingCalendar {
  return { timeZone: packTimeZone(pack), tradingDayCutoff: pack.policies.known ? pack.policies.value!.tradingDayCutoff : DEFAULT_SHOP_CALENDAR.tradingDayCutoff };
}

/** The shop's wall clock ("YYYY-MM-DDTHH:MM") at an instant. */
export function packWallClock(pack: PackCalendarSource, isoInstant: string): string {
  return wallClockIn(isoInstant, packTimeZone(pack));
}

/** The shop's trading day (cut-off applied) an instant belongs to. */
export function packTradingDay(pack: PackCalendarSource, isoInstant: string, rule: TradingDayRule = packRule(pack)): string {
  return tradingDate(packWallClock(pack, isoInstant), rule);
}

/** The shop's calendar date (no cut-off) at an instant. */
export function packCalendarDate(pack: PackCalendarSource, isoInstant: string): string {
  return packWallClock(pack, isoInstant).slice(0, 10);
}

/** What the screens and the log say about this machine's zone against the shop's. */
export interface ZoneCheck {
  /** `in_step`: the machine keeps the shop's zone. `differs`: it does not (the box still dates by the shop's). */
  readonly verdict: 'in_step' | 'differs';
  readonly shopTimeZone: string;
  /** Where the shop's zone came from: the signed pack, or the shop default because the pack does not name one. */
  readonly shopTimeZoneFrom: 'store_pack' | 'shop_default';
  readonly machineTimeZone: string;
  readonly needsAttention: boolean;
  readonly staffMessage: string;
  readonly staffMessageTa: string;
}

/** Compare the zone this machine resolves with the shop's (P-08: a difference is an incident, said in words). */
export function zoneCheck(pack: PackCalendarSource, machineZone: string = machineTimeZone()): ZoneCheck {
  const shopZone = packTimeZone(pack);
  const from = pack.policies.known && isKnownTimeZone(pack.policies.value?.timeZone) ? 'store_pack' as const : 'shop_default' as const;
  // Two names for the same clock (Asia/Calcutta and Asia/Kolkata) are the same zone: compare what each reads now and at
  // the two solstices, so a zone with summer time is not taken for one without.
  const probes = ['2026-01-15T12:00:00Z', '2026-07-15T12:00:00Z', new Date().toISOString()];
  const same = isKnownTimeZone(machineZone) && probes.every((p) => wallClockIn(p, machineZone) === wallClockIn(p, shopZone));
  if (same) {
    return {
      verdict: 'in_step', shopTimeZone: shopZone, shopTimeZoneFrom: from, machineTimeZone: machineZone, needsAttention: false,
      staffMessage: `This store computer keeps the shop's time zone (${shopZone}).`,
      staffMessageTa: `இந்தக் கடைக் கணினி கடையின் நேர மண்டலத்தை (${shopZone}) பின்பற்றுகிறது.`,
    };
  }
  return {
    verdict: 'differs', shopTimeZone: shopZone, shopTimeZoneFrom: from, machineTimeZone: machineZone, needsAttention: true,
    staffMessage: `This store computer's own time zone is ${machineZone}, not the shop's (${shopZone}). Bills, shifts and the day close are still dated by the shop's zone. Tell IT to set the store computer to ${shopZone}.`,
    staffMessageTa: `இந்தக் கடைக் கணினியின் நேர மண்டலம் ${machineZone}; கடையின் மண்டலம் ${shopZone}. பில்கள், ஷிப்ட் மற்றும் நாள் முடிவு கடையின் மண்டலப்படியே தேதியிடப்படுகின்றன. கணினியை ${shopZone}-க்கு அமைக்க IT-யிடம் சொல்லுங்கள்.`,
  };
}
