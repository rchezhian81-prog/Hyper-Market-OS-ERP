// Trading-day calculator (M01-FR-02) — the business/trading day is an explicit
// rule: it runs from a configured cut-off to the next cut-off, applied
// consistently to day-close, shift reports and GST periods (closes audit finding
// A-13). A moment BEFORE the cut-off belongs to the previous calendar day's
// trading day. Pure and deterministic: the caller passes the local wall-clock
// moment (already converted to the store's time zone) and the rule — no reliance
// on "now". The actual cut-off time is the store fact (questionnaire A1); this
// engine is ready for it.

/** The trading-day rule: where one trading day ends and the next begins. */
export interface TradingDayRule {
  /** Minutes after local midnight (0–1439). 0 = midnight; 120 = 2 am. */
  readonly cutoffMinutes: number;
}

/** Build a rule from a "HH:MM" local time (e.g. "02:00" → 120 minutes). */
export function makeTradingDayRule(cutoff: string): TradingDayRule {
  const m = /^(\d{2}):(\d{2})$/.exec(cutoff);
  if (!m) {
    throw new RangeError(`Cut-off must be "HH:MM", got "${cutoff}".`);
  }
  const hours = Number(m[1] ?? '');
  const mins = Number(m[2] ?? '');
  if (hours > 23 || mins > 59) {
    throw new RangeError(`Cut-off "${cutoff}" is not a valid time.`);
  }
  return { cutoffMinutes: hours * 60 + mins };
}

function assertValidRule(rule: TradingDayRule): void {
  if (!Number.isInteger(rule.cutoffMinutes) || rule.cutoffMinutes < 0 || rule.cutoffMinutes > 1439) {
    throw new RangeError(`cutoffMinutes must be an integer 0–1439, got ${rule.cutoffMinutes}.`);
  }
}

function previousDate(dateStr: string): string {
  const dt = new Date(`${dateStr}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}

/**
 * The local wall-clock moment ("YYYY-MM-DDTHH:MM") an ISO-8601 instant falls on, in a time zone — the store's when
 * named, otherwise this machine's (the till PC and the store box stand in the shop). `tradingDate` wants the LOCAL
 * moment: fed an ISO-UTC string, a shop in Tamil Nadu is dated to the wrong day for the five and a half hours after
 * midnight UTC (SP-4b · F09 · M01-FR-02).
 */
export function wallClockIn(isoInstant: string, timeZone?: string): string {
  const ms = Date.parse(isoInstant);
  if (Number.isNaN(ms)) {
    throw new RangeError(`isoInstant must be an ISO-8601 instant, got "${isoInstant}".`);
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    ...(timeZone === undefined ? {} : { timeZone }),
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
}

/** The trading date an instant belongs to, per the rule, in the store's zone (or this machine's when none is named). */
export function tradingDateOf(isoInstant: string, rule: TradingDayRule, timeZone?: string): string {
  return tradingDate(wallClockIn(isoInstant, timeZone), rule);
}

/**
 * The trading date (YYYY-MM-DD) that a local wall-clock moment belongs to, per the
 * rule. `localDateTime` is "YYYY-MM-DDTHH:MM" (or with seconds), already in the
 * store's time zone. A moment before the cut-off is dated to the previous day.
 */
export function tradingDate(localDateTime: string, rule: TradingDayRule): string {
  assertValidRule(rule);
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::\d{2})?$/.exec(localDateTime.trim());
  if (!m) {
    throw new RangeError(`localDateTime must be "YYYY-MM-DDTHH:MM", got "${localDateTime}".`);
  }
  const dateStr = m[1] ?? '';
  const hours = Number(m[2] ?? '');
  const mins = Number(m[3] ?? '');
  if (hours > 23 || mins > 59) {
    throw new RangeError(`"${localDateTime}" is not a valid time.`);
  }
  const minutesAfterMidnight = hours * 60 + mins;
  return minutesAfterMidnight >= rule.cutoffMinutes ? dateStr : previousDate(dateStr);
}
