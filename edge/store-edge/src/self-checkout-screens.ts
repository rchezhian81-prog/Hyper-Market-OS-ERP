// The self-checkout lane and the price kiosk, as the store computer serves them (R8-3 · D04-FR-06 · D14-FR-02 · OB-316 ·
// P-01 · P-08 · hard rule #1).
//
// Both are served by the store computer from its SIGNED catalogue, with no network:
//
//   • `/self-checkout/` — a till lane the customer operates. It gets exactly what the till gets (its catalogue, its lane,
//     its scales, its rollout switches, its receipt template, its refund policy) and, when the store pack carries them,
//     the owner's self-checkout watch numbers. The lane is OFF unless the `self_checkout` switch is on for it (OB-316).
//   • `/price-kiosk/` — a read-only price check. It gets the catalogue and its build time, and, when the store pack carries
//     it, the owner's "stop quoting after" minutes. It can sell nothing and post nothing.
//
// A number the owner has not set is not sent: the screens then say "not set" and never invent one (P-08).

import type { ScreenName } from './screen-data';

/** The screens that are served like the till: no office sign-in, the till's lane payload beside the catalogue. */
export const TILL_SHELL_SCREENS: ReadonlySet<ScreenName> = new Set<ScreenName>(['pos', 'self-checkout']);

/** The customer-facing screens that need no office sign-in (the person at the till or lane signs in there, if at all). */
export const CUSTOMER_FACING_SCREENS: readonly ScreenName[] = Object.freeze(['self-checkout', 'price-kiosk'] as ScreenName[]);

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const whole = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** The owner's self-checkout watch numbers, when the store pack's policies carry all four; otherwise not set (undefined). */
export function selfCheckoutWatchOf(policies: unknown): { readonly auditRateBps: number; readonly auditAboveMinor: number; readonly looseProducePatternCount: number; readonly voidPatternCount: number } | undefined {
  const w = isObj(policies) ? policies['selfCheckoutWatch'] : undefined;
  if (!isObj(w) || !whole(w['auditRateBps']) || (w['auditRateBps'] as number) > 10_000 || !whole(w['auditAboveMinor'])
    || !whole(w['looseProducePatternCount']) || (w['looseProducePatternCount'] as number) < 1 || !whole(w['voidPatternCount']) || (w['voidPatternCount'] as number) < 1) return undefined;
  return { auditRateBps: w['auditRateBps'] as number, auditAboveMinor: w['auditAboveMinor'] as number, looseProducePatternCount: w['looseProducePatternCount'] as number, voidPatternCount: w['voidPatternCount'] as number };
}

/** The kiosk's "stop quoting after" minutes, when the store pack's policies carry it; null = not set. */
export function kioskStaleAfterOf(policies: unknown): number | null {
  const v = isObj(policies) ? policies['kioskStaleAfterMinutes'] : undefined;
  return whole(v) && v > 0 ? v : null;
}

/** The extra globals one of these screens is served with, beside the catalogue. */
export function customerFacingGlobals(screen: ScreenName, policies: unknown): Record<string, unknown> {
  if (screen === 'self-checkout') {
    const watch = selfCheckoutWatchOf(policies);
    return watch === undefined ? {} : { selfCheckoutWatch: watch };
  }
  if (screen === 'price-kiosk') return { priceKiosk: { staleAfterMinutes: kioskStaleAfterOf(policies) } };
  return {};
}
