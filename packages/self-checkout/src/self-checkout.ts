// Self-checkout, scan-and-go and price kiosk (D04 / M12 / M15 / P-01 / hard rule #1).
//
// Self-checkout is the one place in a shop where the **customer operates the till**, and every
// design decision follows from that. Two failure modes, pulling in opposite directions:
//
//   Too suspicious, and it is unusable. A machine that halts on every unexpected weight, that
//   summons an attendant four times in a small shop, that accuses somebody of theft over a
//   reusable bag — that lane sits empty while the staffed one has a queue, and the shop has
//   bought furniture.
//
//   Too trusting, and it is a shrinkage hole. The banana trick (scanning an expensive item as
//   a cheap loose one) is not exotic; it is the single commonest self-checkout loss in the
//   world, and it is invisible unless somebody is looking for the *pattern* rather than the
//   incident.
//
// So the design is: **intervene rarely, watch always, and never accuse anybody at the lane.**
//
//   • **AN INTERVENTION IS ASSISTANCE, NOT AN ACCUSATION.** The reason shown to the customer
//     is neutral; the reason shown to the attendant is specific. A machine that says "unexpected
//     item — theft check" to a pensioner buying bread is a machine the shop will switch off.
//   • **RISK IS SCORED ACROSS A BASKET, NOT PER SCAN.** One mis-weigh is a mis-weigh. Four
//     substitutions of loose produce in one basket is a pattern, and only the basket-level view
//     sees it.
//   • **THE LANE WORKS OFFLINE** (hard rule #1). Age checks, price lookups and the sale itself
//     run off the local pack; the internet is not in the path of a customer paying.
//   • **AGE VERIFICATION IS ALWAYS A HUMAN.** No self-checkout anywhere may clear an
//     age-restricted line on its own, whatever the camera claims.
//   • **A PRICE KIOSK IS READ-ONLY AND SAYS WHEN IT LAST SYNCED.** A kiosk quoting yesterday's
//     promotion is worse than no kiosk, because the customer takes it to the till as a promise.
//
// Pure and deterministic: the clock is injected, no I/O.

export type LaneMode = 'self_checkout' | 'scan_and_go' | 'assisted';

export interface ScannedLine {
  readonly lineId: string;
  readonly productId: string;
  readonly name: string;
  readonly qty: number;
  readonly unitPriceMinor: number;
  /** Grams recorded by the security scale, if the lane has one. */
  readonly observedGrams?: number;
  /** Grams this product is expected to weigh at this quantity, from the product master. */
  readonly expectedGrams?: number;
  /** True for loose produce priced by weight — the substitution target. */
  readonly looseProduce?: boolean;
  readonly ageRestricted?: boolean;
  readonly scannedAt: string;
}

export type InterventionKind =
  | 'age_check'
  | 'weight_mismatch'
  | 'unscanned_item'
  | 'high_value_produce_pattern'
  | 'void_pattern'
  | 'random_audit'
  | 'restricted_product';

export interface Intervention {
  readonly kind: InterventionKind;
  /** What the CUSTOMER sees. Neutral, never an accusation. */
  readonly customerMessage: string;
  /** What the ATTENDANT sees. Specific, because they have to act on it. */
  readonly attendantDetail: string;
  /** True when the basket cannot complete until an attendant clears it. */
  readonly blocking: boolean;
  readonly lineId?: string;
}

export interface SelfCheckoutAssessment {
  readonly basketId: string;
  readonly laneId: string;
  readonly mode: LaneMode;
  readonly lines: number;
  readonly totalMinor: number;
  readonly interventions: readonly Intervention[];
  /** True when the customer can pay without anybody coming over. */
  readonly canCompleteUnattended: boolean;
  /** Basket-level risk in basis points, for the loss-prevention review — NOT shown at the lane. */
  readonly riskBps: number;
  readonly detail: string;
}

export interface SelfCheckoutPolicy {
  /** Weight tolerance in basis points of expected. Default 1,500 (15%) — bags and hands. */
  readonly weightToleranceBps?: number;
  /** Loose-produce lines in one basket before it is a pattern worth a look. Default 4. */
  readonly looseProducePatternCount?: number;
  /** Voids in one basket before it is a pattern. Default 3. */
  readonly voidPatternCount?: number;
  /** Basket value above which a random audit may fire. Default ₹2,000. */
  readonly auditAboveMinor?: number;
  /** Share of eligible baskets audited, in basis points. Default 300 (3%). */
  readonly auditRateBps?: number;
  /** Minimum age for restricted lines. Per-tenant; SRE answered 18 (OB-03). */
  readonly minimumAge?: number;
}

/**
 * Assess a self-checkout basket.
 *
 * The whole judgement is: **which of these needs a person, and what do we say about it?** The
 * customer-facing message is deliberately bland in every case — *"a colleague will be with
 * you"* — because the lane is in public and a machine that publicly implies theft over a
 * reusable bag costs more in goodwill than the item was worth.
 *
 * `riskBps` is computed for the loss-prevention review and is **never displayed at the lane**.
 * Patterns are for the office; the lane's job is to sell somebody their shopping.
 */
export function assessSelfCheckout(input: {
  readonly basketId: string;
  readonly laneId: string;
  readonly mode: LaneMode;
  readonly lines: readonly ScannedLine[];
  readonly voidedLineIds?: readonly string[];
  /** Weight on the bagging scale the lane cannot account for, in grams. */
  readonly unaccountedGrams?: number;
  /** Whether this basket was selected for a random audit (drawn upstream, deterministic here). */
  readonly selectedForAudit?: boolean;
  readonly policy?: SelfCheckoutPolicy;
  readonly at: string;
}): SelfCheckoutAssessment {
  const p = input.policy ?? {};
  const tolerance = p.weightToleranceBps ?? 1_500;
  const producePattern = p.looseProducePatternCount ?? 4;
  const voidPattern = p.voidPatternCount ?? 3;
  const auditAbove = p.auditAboveMinor ?? 200_000;

  const interventions: Intervention[] = [];
  const totalMinor = input.lines.reduce((s, l) => s + l.unitPriceMinor * l.qty, 0);
  let riskBps = 0;

  // --- age: always a person, no exceptions anywhere ---------------------------
  for (const line of input.lines.filter((l) => l.ageRestricted === true)) {
    interventions.push({
      kind: 'age_check',
      lineId: line.lineId,
      blocking: true,
      customerMessage: 'A colleague will be with you to check one item.',
      attendantDetail: `${line.name} is age-restricted (minimum ${p.minimumAge ?? 18}) — you must see the customer and the identification. The lane cannot clear this and never will`,
    });
  }

  // --- weight: a real signal, and a noisy one ---------------------------------
  for (const line of input.lines) {
    if (line.observedGrams === undefined || line.expectedGrams === undefined || line.expectedGrams === 0) continue;
    const driftBps = Number(
      (BigInt(Math.abs(line.observedGrams - line.expectedGrams)) * 10_000n) / BigInt(line.expectedGrams),
    );
    if (driftBps > tolerance) {
      riskBps += Math.min(2_000, driftBps - tolerance);
      interventions.push({
        kind: 'weight_mismatch',
        lineId: line.lineId,
        blocking: true,
        customerMessage: 'Please wait — a colleague will be with you.',
        attendantDetail: `${line.name}: scale read ${line.observedGrams}g against ${line.expectedGrams}g expected (${(driftBps / 100).toFixed(0)}% out). Usually a bag or a hand on the platform — check, do not accuse`,
      });
    }
  }

  if ((input.unaccountedGrams ?? 0) > 0) {
    riskBps += 500;
    interventions.push({
      kind: 'unscanned_item',
      blocking: true,
      customerMessage: 'Please wait — a colleague will be with you.',
      attendantDetail: `${input.unaccountedGrams}g on the bagging area that the lane cannot account for. Most often a reusable bag or a handbag put down`,
    });
  }

  // --- patterns: the office's business, not the lane's -------------------------
  const loose = input.lines.filter((l) => l.looseProduce === true);
  if (loose.length >= producePattern) {
    riskBps += 1_200;
    interventions.push({
      kind: 'high_value_produce_pattern',
      blocking: false,
      customerMessage: 'A colleague will be with you shortly.',
      attendantDetail: `${loose.length} loose-produce lines in one basket. Scanning an expensive item as a cheap loose one is the commonest self-checkout loss there is — glance at the produce, and say nothing about it`,
    });
  }

  const voids = (input.voidedLineIds ?? []).length;
  if (voids >= voidPattern) {
    riskBps += 800;
    interventions.push({
      kind: 'void_pattern',
      blocking: false,
      customerMessage: 'A colleague will be with you shortly.',
      attendantDetail: `${voids} lines removed from this basket. Sometimes genuine, sometimes scan-then-remove — worth watching, not worth a confrontation`,
    });
  }

  if (input.selectedForAudit === true && totalMinor >= auditAbove) {
    interventions.push({
      kind: 'random_audit',
      blocking: true,
      customerMessage: 'A colleague will do a quick check — it will only take a moment.',
      attendantDetail: 'Random audit. Nothing is wrong with this basket; check a few items and thank them',
    });
  }

  const blocking = interventions.filter((i) => i.blocking);

  return {
    basketId: input.basketId,
    laneId: input.laneId,
    mode: input.mode,
    lines: input.lines.length,
    totalMinor,
    interventions,
    canCompleteUnattended: blocking.length === 0,
    riskBps: Math.min(10_000, riskBps),
    detail:
      interventions.length === 0
        ? `${input.lines.length} line(s), ${totalMinor} — the customer pays and leaves`
        : blocking.length === 0
          ? `${interventions.length} thing(s) for the attendant to notice; the customer is NOT held up`
          : `${blocking.length} intervention(s) need a colleague before this basket can pay`,
  };
}

export type ScanAndGoOutcome = 'released' | 'audit_required' | 'trust_withdrawn' | 'age_restricted_present';

export interface ScanAndGoDecision {
  readonly basketId: string;
  readonly customerId: string;
  readonly outcome: ScanAndGoOutcome;
  readonly released: boolean;
  readonly detail: string;
}

/**
 * Decide whether a scan-and-go customer walks straight out.
 *
 * Scan-and-go is **earned trust with a sampling rate**, and the sampling has to be honest:
 * a scheme that audits everybody is a queue with extra steps, and one that never audits is a
 * free-for-all within a month. Trust is withdrawn on a **found discrepancy**, not on a
 * suspicion, and the customer is told plainly rather than mysteriously failing checks.
 *
 * An age-restricted item ends scan-and-go for that trip, full stop.
 */
export function decideScanAndGo(input: {
  readonly basketId: string;
  readonly customerId: string;
  readonly lines: readonly ScannedLine[];
  /** Completed trips on this scheme. */
  readonly tripsCompleted: number;
  /** Audits where something was genuinely missing. */
  readonly discrepanciesFound: number;
  readonly selectedForAudit: boolean;
  /** Discrepancies before trust is withdrawn. Default 2. */
  readonly withdrawAfter?: number;
}): ScanAndGoDecision {
  const base = { basketId: input.basketId, customerId: input.customerId };

  if (input.lines.some((l) => l.ageRestricted === true)) {
    return {
      ...base,
      outcome: 'age_restricted_present',
      released: false,
      detail: 'this basket has an age-restricted item, so it finishes at a staffed till — no scan-and-go trip clears one, ever',
    };
  }
  if (input.discrepanciesFound >= (input.withdrawAfter ?? 2)) {
    return {
      ...base,
      outcome: 'trust_withdrawn',
      released: false,
      detail: `${input.discrepanciesFound} audits found something missing, so this customer finishes at a till and is TOLD so — a scheme that fails people mysteriously loses them for good`,
    };
  }
  if (input.selectedForAudit) {
    return {
      ...base,
      outcome: 'audit_required',
      released: false,
      detail: `a routine check after ${input.tripsCompleted} trip(s) — a scheme that never audits is a free-for-all within a month`,
    };
  }

  return {
    ...base,
    outcome: 'released',
    released: true,
    detail: `${input.lines.length} line(s), paid on the phone, walk out`,
  };
}

export type KioskOutcome = 'quoted' | 'not_found' | 'stale' | 'no_price';

export interface KioskQuote {
  readonly productId: string;
  readonly outcome: KioskOutcome;
  readonly priceMinor?: number;
  readonly name?: string;
  /** How old the price pack is. ALWAYS shown to the customer. */
  readonly minutesSincePack: number;
  readonly detail: string;
}

/**
 * A price kiosk lookup.
 *
 * **Read-only, offline-capable, and it always says how fresh it is.** A kiosk quoting
 * yesterday's promotion is worse than no kiosk: the customer takes the number to the till as a
 * promise, and the cashier either honours a price the shop is not charging or has an argument
 * in front of a queue. Beyond the staleness threshold the kiosk says *"check at the counter"*
 * rather than quoting a number it does not trust.
 */
export function quotePrice(input: {
  readonly productId: string;
  readonly pack: readonly { readonly productId: string; readonly name: string; readonly priceMinor?: number }[];
  readonly packBuiltAt: string;
  readonly at: string;
  /** Minutes after which the kiosk stops quoting. Per-tenant. Default 240. */
  readonly staleAfterMinutes?: number;
}): KioskQuote {
  const minutesSincePack = Math.max(
    0,
    Math.round((Date.parse(input.at) - Date.parse(input.packBuiltAt)) / 60_000),
  );
  const stale = minutesSincePack > (input.staleAfterMinutes ?? 240);
  const item = input.pack.find((p) => p.productId === input.productId);

  if (stale) {
    return {
      productId: input.productId,
      outcome: 'stale',
      minutesSincePack,
      detail: `this kiosk last updated ${minutesSincePack} minutes ago — please check the price at the counter rather than trust a number that may have moved`,
    };
  }
  if (item === undefined) {
    return {
      productId: input.productId,
      outcome: 'not_found',
      minutesSincePack,
      detail: 'that barcode is not in this shop\'s list — a colleague can check it',
    };
  }
  if (item.priceMinor === undefined) {
    return {
      productId: input.productId,
      outcome: 'no_price',
      name: item.name,
      minutesSincePack,
      detail: `${item.name} has no price set — please ask at the counter rather than be quoted nothing`,
    };
  }

  return {
    productId: input.productId,
    outcome: 'quoted',
    name: item.name,
    priceMinor: item.priceMinor,
    minutesSincePack,
    detail: `${item.name}: ${item.priceMinor}, from a list updated ${minutesSincePack} minute(s) ago`,
  };
}
