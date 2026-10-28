// OB-507 follow-up · P-03 — whether a person's attendance marks pair up (an "in", then an "out"), judged from EVERY mark
// head office holds at the moment it is asked, never frozen when one mark happened to arrive.
//
// A mark's out-of-order exception is a DERIVED view: the marks themselves are append-only facts (hard rule #2) and are never
// rewritten; this fold is re-run on each read, so
//   • an "out" that reached head office before its "in" (two screens, relayed in a different order) is an exception only
//     until the "in" arrives — then the pair is whole and the exception is gone;
//   • an "out" pairs with the person's open "in" from the SAME shop day, or from the PREVIOUS shop day when that person is
//     rostered (head office's committed roster) on a shift that starts on that day and ends on the next — a night shift.
//     With no such shift on the roster the same-day rule stands.
// Real exceptions stay visible: an "out" with no "in" (`out_without_in`); a second mark of the same kind with nothing
// between (`repeats_the_last_mark`); an "in" never followed by an "out" once its day — or its rostered night shift — is
// over (`in_without_out`). Pure: no clock (now / today are passed), no I/O.

import { shopDateIn } from '../../../packages/calendar/src/shop-clock';
import type { AttendanceMark, AttendanceMarkException } from './biometric-consent';

/** One rostered shift of one person, from head office's committed roster. */
export interface RosteredShift { readonly employeeId: string; readonly startsAt: string; readonly endsAt: string }

/** A rostered shift that crosses the shop's midnight: it starts on `fromDate` and ends on `toDate` (shop dates). */
export interface NightShiftSpan { readonly employeeId: string; readonly fromDate: string; readonly toDate: string; readonly endsAt: string }

/** The person's marks need only these facts. */
export type PairableMark = Pick<AttendanceMark, 'markId' | 'employeeId' | 'kind' | 'at' | 'date'>;

/** The rostered shifts that cross midnight in the shop's time zone (a shift inside one day is not one). */
export function nightShiftSpansOf(shifts: readonly RosteredShift[], timeZone?: string): NightShiftSpan[] {
  const out: NightShiftSpan[] = [];
  for (const s of shifts) {
    if (Number.isNaN(Date.parse(s.startsAt)) || Number.isNaN(Date.parse(s.endsAt)) || Date.parse(s.endsAt) <= Date.parse(s.startsAt)) continue;
    const fromDate = shopDateIn(s.startsAt, timeZone);
    const toDate = shopDateIn(s.endsAt, timeZone);
    if (fromDate !== toDate) out.push({ employeeId: s.employeeId, fromDate, toDate, endsAt: s.endsAt });
  }
  return out;
}

/**
 * Each mark's exceptions (only marks with one are in the map), judged over `marks` — give it the day being read with the
 * day before and the day after, so a night shift's "in" and "out" are both in view.
 */
export function attendancePairing(input: {
  readonly marks: readonly PairableMark[];
  readonly nightShifts: readonly NightShiftSpan[];
  /** Head office's clock, and the shop's date at that moment: an "in" is only "never closed" once its day / shift is over. */
  readonly now: string;
  readonly today: string;
}): ReadonlyMap<string, readonly AttendanceMarkException[]> {
  const found = new Map<string, AttendanceMarkException[]>();
  const flag = (m: PairableMark, e: AttendanceMarkException): void => {
    const list = found.get(m.markId) ?? [];
    if (!list.includes(e)) list.push(e);
    found.set(m.markId, list);
  };
  const byPerson = new Map<string, PairableMark[]>();
  for (const m of input.marks) byPerson.set(m.employeeId, [...(byPerson.get(m.employeeId) ?? []), m]);

  for (const [employeeId, list] of byPerson) {
    const nights = input.nightShifts.filter((s) => s.employeeId === employeeId);
    /** The rostered night shift that carries an "in" of `fromDate` over to `toDate`, if any. */
    const carries = (fromDate: string, toDate: string): boolean => nights.some((s) => s.fromDate === fromDate && s.toDate === toDate);
    /** An "in" never closed: an exception once its day is over — or, on a rostered night shift, once that shift ended. */
    const unclosed = (open: PairableMark, dayMoved: boolean): void => {
      if (found.has(open.markId)) return; // already an exception (a repeated "in") — one reason is enough, no extra noise
      const night = nights.filter((s) => s.fromDate === open.date).map((s) => Date.parse(s.endsAt));
      const over = dayMoved || (night.length > 0 ? Math.max(...night) < Date.parse(input.now) : open.date < input.today);
      if (over) flag(open, 'in_without_out');
    };
    const sorted = [...list].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.markId.localeCompare(b.markId));
    let open: PairableMark | undefined;
    let last: PairableMark | undefined;
    for (const m of sorted) {
      if (open !== undefined && open.date !== m.date && !carries(open.date, m.date)) { unclosed(open, true); open = undefined; }
      if (m.kind === 'in') {
        if (open !== undefined) flag(m, 'repeats_the_last_mark'); // a second "in" with no "out" between
        open = m;
      } else if (open !== undefined) {
        open = undefined; // the pair is whole
      } else {
        flag(m, last !== undefined && last.date === m.date && last.kind === 'out' ? 'repeats_the_last_mark' : 'out_without_in');
      }
      last = m;
    }
    if (open !== undefined) unclosed(open, false);
  }
  return found;
}
