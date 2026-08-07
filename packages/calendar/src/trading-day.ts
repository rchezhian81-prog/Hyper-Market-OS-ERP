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
