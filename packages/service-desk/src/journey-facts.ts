// Journey triggers worked out from the shop's own facts (M21-FR-02 "abandoned-cart, occasion and win-back journeys").
//
// The journey engine (`findJourneyCandidates`) judged triggers somebody typed in. Now each trigger is worked out from what
// the shop actually holds:
//   • ABANDONED CART — a signed-in customer's basket, kept on the shop when they filled it, with no order placed since;
//   • OCCASION — a birthday or anniversary the customer gave the shop themselves, with their yes, the week before it;
//   • WIN-BACK — the customer's last purchase (the till's banked bills and their online orders), older than the shop's
//     own "lapsing" line in its segment policy.
// Each trigger carries a ref that names exactly what fired it, so it is acted on once. Pure and deterministic.

import type { JourneyKind, JourneyTrigger } from './campaigns';

export interface HeldCart { readonly customerRef: string; readonly lineCount: number; readonly valueMinor: number; readonly updatedAt: string }
export interface Occasion { readonly occasionId: string; readonly customerRef: string; readonly kind: 'birthday' | 'anniversary'; readonly monthDay: string; readonly removed?: boolean }
export interface Purchase { readonly customerRef: string; readonly at: string; readonly valueMinor: number }

/** How each journey is judged by the engine: when it is too soon, and when too late. */
export const JOURNEY_WINDOWS: Readonly<Record<JourneyKind, { readonly quietMinutes: number; readonly staleAfterMinutes: number }>> = {
  abandoned_cart: { quietMinutes: 60, staleAfterMinutes: 2 * 24 * 60 },
  occasion: { quietMinutes: 0, staleAfterMinutes: 7 * 24 * 60 },
  win_back: { quietMinutes: 0, staleAfterMinutes: 30 * 24 * 60 },
};

const dayMs = 86_400_000;
const startOf = (day: string): number => Date.parse(`${day}T00:00:00.000Z`);

/** The next date (on or after `today`) a month-day falls on; 29 Feb in a common year falls on 28 Feb. */
export function nextOccasionDate(monthDay: string, today: string): string {
  const [m, d] = monthDay.split('-').map(Number) as [number, number];
  const at = (year: number): string => {
    const last = new Date(Date.UTC(year, m, 0)).getUTCDate();
    return new Date(Date.UTC(year, m - 1, Math.min(d, last))).toISOString().slice(0, 10);
  };
  const year = Number(today.slice(0, 4));
  return at(year) >= today ? at(year) : at(year + 1);
}

export function journeyTriggers(input: {
  readonly kind: JourneyKind;
  readonly carts: readonly HeldCart[];
  readonly occasions: readonly Occasion[];
  readonly purchases: readonly Purchase[];
  /** The shop's own calendar day today. */
  readonly today: string;
  /** Days without a purchase before a customer is lapsing (the segment policy's own line). */
  readonly lapsingAfterDays: number;
}): { readonly triggers: readonly JourneyTrigger[]; readonly completedRefs: readonly string[] } {
  const lastOf = new Map<string, Purchase>();
  for (const p of input.purchases) if ((lastOf.get(p.customerRef)?.at ?? '') < p.at) lastOf.set(p.customerRef, p);
  if (input.kind === 'abandoned_cart') {
    const triggers: JourneyTrigger[] = [];
    const completed: string[] = [];
    for (const c of input.carts) {
      if (c.lineCount === 0) continue;
      if ((lastOf.get(c.customerRef)?.at ?? '') >= c.updatedAt) { completed.push(c.customerRef); continue; }
      triggers.push({ customerRef: c.customerRef, kind: 'abandoned_cart', triggeredAt: c.updatedAt, valueMinor: c.valueMinor, ref: `cart:${c.customerRef}:${c.updatedAt}` });
    }
    return { triggers, completedRefs: completed };
  }
  if (input.kind === 'occasion') {
    const triggers: JourneyTrigger[] = [];
    for (const o of input.occasions) {
      if (o.removed === true) continue;
      const date = nextOccasionDate(o.monthDay, input.today);
      // Fires a week before; the engine treats it as live for that week.
      const firesAt = startOf(date) - 7 * dayMs;
      if (firesAt > startOf(input.today) + dayMs) continue;
      triggers.push({ customerRef: o.customerRef, kind: 'occasion', triggeredAt: new Date(Math.max(firesAt, 0)).toISOString(), valueMinor: lastOf.get(o.customerRef)?.valueMinor ?? 0, ref: `occasion:${o.occasionId}:${date}` });
    }
    return { triggers, completedRefs: [] };
  }
  const triggers: JourneyTrigger[] = [];
  for (const p of lastOf.values()) {
    const lapsesAt = Date.parse(p.at) + input.lapsingAfterDays * dayMs;
    if (lapsesAt > startOf(input.today) + dayMs) continue;
    triggers.push({ customerRef: p.customerRef, kind: 'win_back', triggeredAt: new Date(lapsesAt).toISOString(), valueMinor: p.valueMinor, ref: `winback:${p.customerRef}:${p.at}` });
  }
  return { triggers, completedRefs: [] };
}
