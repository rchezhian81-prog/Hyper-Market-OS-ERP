// Batch 18b · O1 — Reports for a past day, week or month (M29-FR-02 "comparisons" · roadmap §8.3 · P-01 · P-08).
//
// The store computer's sales log is append-only and never rotated (read-model.ts), so the days it holds can be reported
// on with no network. The Reports page asks for a period in its own address (`/reporting/?from=2026-11-01&to=2026-11-15`);
// this module reads that, and says EXACTLY which days the figures cover:
//
//   • a day after today has no sales yet — the period stops at today, and says so;
//   • a day before the first day this store computer holds is NOT KNOWN here — the figures cover only the days it holds,
//     and the page says "Not known before <day>" (never a nought for days it never saw);
//   • a period wholly before the first day it holds (or a box that holds no sale at all, for a past day) covers nothing:
//     every figure says "Not known for this period" with that reason.
//
// Pure and tested (tests/unit/batch18b-report-period.test.ts).

import type { LoggedSale } from './read-model';

export interface ReportPeriod { readonly from: string; readonly to: string }

/** The longest period one report covers — a year and a day (a leap year's whole year fits). */
export const MAX_PERIOD_DAYS = 366;

const DAY_MS = 86_400_000;
const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
  && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const daysBetween = (a: string, b: string): number => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);

export type PeriodAsk = { readonly ok: true; readonly period: ReportPeriod } | { readonly ok: false; readonly why: string } | null;

/** The period a page address asks for: `null` when it asks for none (today); refused, with why, when it cannot be read. */
export function periodFromUrl(url: string | undefined): PeriodAsk {
  if (url === undefined) return null;
  const q = url.indexOf('?');
  if (q < 0) return null;
  const params = new URLSearchParams(url.slice(q + 1));
  const from = params.get('from');
  const to = params.get('to');
  if (from === null && to === null) return null;
  if (!isDay(from) || !isDay(to)) return { ok: false, why: 'the period was not two dates (from and to)' };
  if (to < from) return { ok: false, why: 'the period ends before it starts' };
  if (daysBetween(from, to) + 1 > MAX_PERIOD_DAYS) return { ok: false, why: `a period is at most ${MAX_PERIOD_DAYS} days` };
  return { ok: true, period: { from, to } };
}

/** What a report covers, exactly. */
export interface PeriodCover {
  /** What the person asked for (today, when they asked for nothing). */
  readonly asked: ReportPeriod;
  /** The days the figures actually cover, or `null` when this store computer holds none of them. */
  readonly covered: ReportPeriod | null;
  /** True only when the period is today alone — the one period whose costs and limits are today's own. */
  readonly todayOnly: boolean;
  /** The first day this store computer holds a sale for (`null`: none at all). */
  readonly heldFrom: string | null;
  /** Days before this are not known here (set when the asked period starts before `heldFrom`). */
  readonly notKnownBefore?: string;
  /** Set when the asked period ran past today: the figures stop at today. */
  readonly stopsAtToday?: true;
  /** When `covered` is null: why, in plain words. */
  readonly notKnownWhy?: string;
}

export function coverPeriod(asked: ReportPeriod | null, today: string, sales: readonly LoggedSale[]): PeriodCover {
  const want = asked ?? { from: today, to: today };
  let heldFrom: string | null = null;
  for (const s of sales) if (s.tradingDay !== undefined && (heldFrom === null || s.tradingDay < heldFrom)) heldFrom = s.tradingDay;
  const todayOnly = want.from === today && want.to === today;
  if (todayOnly) return { asked: want, covered: want, todayOnly, heldFrom };
  if (want.from > today) return { asked: want, covered: null, todayOnly, heldFrom, notKnownWhy: 'the period has not started yet' };
  const to = want.to > today ? today : want.to;
  const cut = want.to > today ? { stopsAtToday: true as const } : {};
  if (heldFrom === null) return { asked: want, covered: null, todayOnly, heldFrom, ...cut, notKnownWhy: 'this store computer holds no sales at all yet' };
  if (to < heldFrom) return { asked: want, covered: null, todayOnly, heldFrom, ...cut, notKnownWhy: `this store computer holds sales only from ${heldFrom}` };
  if (want.from < heldFrom) return { asked: want, covered: { from: heldFrom, to }, todayOnly, heldFrom, notKnownBefore: heldFrom, ...cut };
  return { asked: want, covered: { from: want.from, to }, todayOnly, heldFrom, ...cut };
}

/** The sales whose trading day falls in the period (inclusive); a record with no trading day is counted, never placed. */
export function salesIn(sales: readonly LoggedSale[], period: ReportPeriod | null): { readonly sales: readonly LoggedSale[]; readonly undated: number } {
  const out: LoggedSale[] = [];
  let undated = 0;
  for (const s of sales) {
    if (s.tradingDay === undefined) { undated += 1; continue; }
    if (period !== null && s.tradingDay >= period.from && s.tradingDay <= period.to) out.push(s);
  }
  return { sales: out, undated };
}

/** Why a figure that rests on TODAY's buying cost or TODAY's limits is not known for any other period. */
export const COST_NOT_KNOWN_FOR_PERIOD = 'Not known for this period — the store computer keeps only today\'s average buying cost, not the cost on each earlier day';
export const LIMITS_NOT_KNOWN_FOR_PERIOD = 'Not known for this period — the store computer judges these against today\'s limits only, not the limits on each earlier day';
