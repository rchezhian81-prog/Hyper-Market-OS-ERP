// D-9 (R3, OB-142 "A") — labour-demand forecasting: staff needed per role per hour of the coming Monday–Sunday week,
// from the store's own HOURLY sales history. Pure and deterministic.
//
// Signed sentence (part): "from hourly sales history, a forecast of staff hours needed per role per hour-slot for the
// next week." OB-142 "A": enough staff for each hour (a service level), within the Shops Act limits; labour cost is
// reported, not capped.
//
// The rule, in full:
//   • HISTORY: the bills of the `historyWeeks` whole weeks before the week planned, counted per store-local hour;
//   • FORECAST for an hour-slot (weekday × hour) = the average number of bills in that same weekday and hour over those
//     weeks (a week with no bill in the slot counts as zero), rounded to the nearest whole bill;
//   • STAFF NEEDED for a role in a slot = forecast ÷ the role's SERVICE STANDARD (how many bills one person of that role
//     serves in an hour), rounded UP — enough staff for the hour, never fewer;
//   • the service standard is the OWNER'S setting, per role. A role with no standard set is NOT forecast — it is listed
//     as `standard_not_set` (P-08: said, never a made-up figure);
//   • an hour with no bill in the whole history needs nobody (the shop's own pattern; opening hours are not assumed).

export interface HourlyBill { readonly at: string }

export interface ServiceStandard {
  readonly role: string;
  /** Bills one person of this role serves in an hour (whole, ≥ 1). */
  readonly billsPerStaffHour: number;
  readonly setBy: string;
  readonly setAt: string;
}

export interface DemandSlot {
  readonly date: string;
  /** Store-local hour of day, 0–23: the slot runs [hour:00, hour+1:00). */
  readonly hour: number;
  readonly role: string;
  readonly forecastBills: number;
  readonly staffNeeded: number;
}

export interface LabourDemand {
  readonly weekStart: string;
  readonly weekEnd: string;
  readonly historyFrom: string;
  readonly historyTo: string;
  readonly historyWeeks: number;
  readonly slots: readonly DemandSlot[];
  /** Σ staff needed × 1 hour, per role — the staff hours the week needs. */
  readonly staffHoursByRole: Readonly<Record<string, number>>;
  readonly rolesNotForecast: readonly { readonly role: string; readonly reason: 'standard_not_set' }[];
}

export class InvalidLabourDemandInputError extends Error {
  constructor(message: string) { super(message); this.name = 'InvalidLabourDemandInputError'; }
}

const DAY_MS = 86_400_000;
const addDays = (d: string, n: number): string => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const isMonday = (d: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(d) && new Date(Date.parse(`${d}T00:00:00Z`)).getUTCDay() === 1;

/** OB-181: the week is Monday–Sunday, fixed. */
export function forecastLabourDemand(input: {
  readonly weekStart: string;
  readonly historyWeeks: number;
  readonly utcOffsetMinutes: number;
  /** The bills of the store, any time — only those in the history window count. */
  readonly bills: readonly HourlyBill[];
  /** The roles to plan, and the owner's service standard for each (undefined = not set). */
  readonly roles: readonly string[];
  readonly standards: readonly ServiceStandard[];
}): LabourDemand {
  if (!isMonday(input.weekStart)) throw new InvalidLabourDemandInputError(`The roster week starts on a Monday (OB-181); ${input.weekStart} is not one.`);
  if (!Number.isSafeInteger(input.historyWeeks) || input.historyWeeks < 1 || input.historyWeeks > 52) throw new InvalidLabourDemandInputError('historyWeeks must be a whole number from 1 to 52.');
  const historyFrom = addDays(input.weekStart, -7 * input.historyWeeks);
  const historyTo = addDays(input.weekStart, -1);
  // Bills per (weekday 0=Mon…6=Sun, hour) over the history window, in store-local time.
  const counts = new Map<string, number>();
  for (const b of input.bills) {
    const ms = Date.parse(b.at);
    if (Number.isNaN(ms)) continue;
    const local = new Date(ms + input.utcOffsetMinutes * 60_000);
    const day = local.toISOString().slice(0, 10);
    if (day < historyFrom || day > historyTo) continue;
    const key = `${(local.getUTCDay() + 6) % 7}|${local.getUTCHours()}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const standards = new Map(input.standards.map((s) => [s.role, s] as const));
  const planned = input.roles.filter((r) => { const s = standards.get(r); return s !== undefined && Number.isSafeInteger(s.billsPerStaffHour) && s.billsPerStaffHour >= 1; });
  const rolesNotForecast = input.roles.filter((r) => !planned.includes(r)).map((role) => ({ role, reason: 'standard_not_set' as const }));
  const slots: DemandSlot[] = [];
  const hoursByRole: Record<string, number> = Object.fromEntries(planned.map((r) => [r, 0]));
  for (let d = 0; d < 7; d++) {
    const date = addDays(input.weekStart, d);
    for (let hour = 0; hour < 24; hour++) {
      const total = counts.get(`${d}|${hour}`) ?? 0;
      if (total === 0) continue;
      const forecastBills = Math.round(total / input.historyWeeks);
      for (const role of planned) {
        const staffNeeded = forecastBills === 0 ? 0 : Math.ceil(forecastBills / standards.get(role)!.billsPerStaffHour);
        if (staffNeeded === 0) continue;
        slots.push({ date, hour, role, forecastBills, staffNeeded });
        hoursByRole[role] = (hoursByRole[role] ?? 0) + staffNeeded;
      }
    }
  }
  return { weekStart: input.weekStart, weekEnd: addDays(input.weekStart, 6), historyFrom, historyTo, historyWeeks: input.historyWeeks, slots, staffHoursByRole: hoursByRole, rolesNotForecast };
}
