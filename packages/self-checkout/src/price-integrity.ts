// Price integrity across shelf, POS, app and ESL (D06 / D14 / M05 / M34 / P-02).
//
// One commerce truth (P-02) is a principle until somebody checks. This module is the check.
//
// A hypermarket displays the same price in four places — the shelf edge label, the till, the
// customer app, and (where fitted) an electronic shelf label — and they drift apart constantly:
// a price change applies at the till overnight and the paper labels are reprinted on Thursday;
// an ESL loses its radio link and holds last week's promotion for a fortnight; the app caches.
//
// The consequences are not symmetric, and that asymmetry drives the whole module:
//
//   • **THE SHELF SHOWING LESS THAN THE TILL CHARGES IS A LEGAL PROBLEM**, not a margin one.
//     Under the Legal Metrology (Packaged Commodities) Rules the displayed price is what the
//     customer was offered. The shop should honour it and fix the label — and this is reported
//     as `overcharge_risk` at the top of the list regardless of value.
//   • **THE SHELF SHOWING MORE THAN THE TILL CHARGES IS A MARGIN LEAK.** Real money, no legal
//     exposure, and it is ranked by value because that is how you decide what to fix first.
//   • **AN ESL THAT HAS NOT REPORTED IS ASSUMED WRONG.** A label whose last contact was nine
//     days ago is showing whatever it was last told, and treating silence as agreement is how a
//     promotion runs for a fortnight after it ended.
//
// Pure and deterministic: the clock is injected, no I/O.

export type PriceSurface = 'pos' | 'shelf_label' | 'esl' | 'app' | 'kiosk' | 'website';

export interface DisplayedPrice {
  readonly surface: PriceSurface;
  readonly productId: string;
  readonly branchId: string;
  readonly priceMinor: number;
  /** When this surface last confirmed its price. Silence is not agreement. */
  readonly lastConfirmedAt: string;
  /** ESL only: the label's own identifier, so somebody can walk to it. */
  readonly deviceId?: string;
  readonly shelfAddress?: string;
}

export type IntegrityKind =
  | 'overcharge_risk'
  | 'undercharge'
  | 'stale_surface'
  | 'surface_missing'
  | 'esl_unreachable';

export interface IntegrityFinding {
  readonly productId: string;
  readonly name: string;
  readonly surface: PriceSurface;
  readonly kind: IntegrityKind;
  readonly posPriceMinor: number;
  readonly displayedMinor?: number;
  readonly differenceMinor: number;
  /** Estimated exposure over the period, from units sold. */
  readonly exposureMinor: number;
  readonly shelfAddress?: string;
  readonly deviceId?: string;
  readonly detail: string;
}

export interface IntegrityReport {
  readonly branchId: string;
  readonly asAt: string;
  readonly productsChecked: number;
  /** Legal exposure first. Value does not reorder these. */
  readonly overchargeRisks: readonly IntegrityFinding[];
  readonly other: readonly IntegrityFinding[];
  readonly undercharedExposureMinor: number;
  readonly detail: string;
}

const MINUTE_MS = 60_000;

/**
 * Audit every displayed price against what the till actually charges.
 *
 * **The till is the reference.** Not because it is more likely to be right, but because it is
 * what the customer is charged, and every other surface is a claim about it. A shelf label that
 * disagrees is either a promise the shop must honour or margin walking out of the door, and
 * those are different problems needing different people.
 *
 * A surface that has not confirmed within its freshness window is reported as **stale rather
 * than as agreeing** — an ESL that lost its radio nine days ago is showing whatever it was last
 * told, and it will keep showing it.
 */
export function auditPriceIntegrity(input: {
  readonly branchId: string;
  readonly products: readonly { readonly productId: string; readonly name: string; readonly posPriceMinor: number }[];
  readonly displayed: readonly DisplayedPrice[];
  /** Units sold in the period, for sizing the exposure. */
  readonly unitsSold?: Readonly<Record<string, number>>;
  /** Surfaces that must be present for each product. */
  readonly requiredSurfaces?: readonly PriceSurface[];
  /** Minutes before a surface's price is treated as unconfirmed. Default 1,440 (a day). */
  readonly staleAfterMinutes?: number;
  readonly asAt: string;
}): IntegrityReport {
  const stale = input.staleAfterMinutes ?? 1_440;
  const required = input.requiredSurfaces ?? ['shelf_label'];
  const sold = input.unitsSold ?? {};
  const findings: IntegrityFinding[] = [];

  for (const product of input.products) {
    const units = sold[product.productId] ?? 0;
    const surfaces = input.displayed.filter(
      (d) => d.productId === product.productId && d.branchId === input.branchId,
    );

    for (const surface of required) {
      if (!surfaces.some((s) => s.surface === surface)) {
        findings.push({
          productId: product.productId,
          name: product.name,
          surface,
          kind: 'surface_missing',
          posPriceMinor: product.posPriceMinor,
          differenceMinor: 0,
          exposureMinor: 0,
          detail: `${product.name} has no ${surface.replace(/_/g, ' ')} on file — a product on sale with no price on the shelf is its own compliance problem`,
        });
      }
    }

    for (const shown of surfaces) {
      const minutesSince = Math.max(
        0,
        Math.round((Date.parse(input.asAt) - Date.parse(shown.lastConfirmedAt)) / MINUTE_MS),
      );
      const common = {
        productId: product.productId,
        name: product.name,
        surface: shown.surface,
        posPriceMinor: product.posPriceMinor,
        displayedMinor: shown.priceMinor,
        shelfAddress: shown.shelfAddress,
        deviceId: shown.deviceId,
      };

      if (minutesSince > stale) {
        findings.push({
          ...common,
          kind: shown.surface === 'esl' ? 'esl_unreachable' : 'stale_surface',
          differenceMinor: shown.priceMinor - product.posPriceMinor,
          exposureMinor: 0,
          detail:
            shown.surface === 'esl'
              ? `label ${shown.deviceId ?? '(unknown)'} at ${shown.shelfAddress ?? 'an unrecorded shelf'} last reported ${Math.floor(minutesSince / 1_440)} day(s) ago — it is showing whatever it was last told, and it will keep showing it`
              : `the ${shown.surface.replace(/_/g, ' ')} price for ${product.name} has not been confirmed for ${Math.floor(minutesSince / 60)} hour(s) — treated as unconfirmed, not as agreeing`,
        });
        continue;
      }

      const difference = shown.priceMinor - product.posPriceMinor;
      if (difference === 0) continue;

      if (difference < 0) {
        // The shelf says LESS than the till charges. Legal exposure — value is irrelevant.
        findings.push({
          ...common,
          kind: 'overcharge_risk',
          differenceMinor: difference,
          exposureMinor: Math.abs(difference) * units,
          detail: `${product.name} shows ${shown.priceMinor} on the ${shown.surface.replace(/_/g, ' ')}${shown.shelfAddress === undefined ? '' : ` at ${shown.shelfAddress}`} and the till charges ${product.posPriceMinor}. **The displayed price is what the customer was offered** — honour it and fix the label today`,
        });
      } else {
        findings.push({
          ...common,
          kind: 'undercharge',
          differenceMinor: difference,
          exposureMinor: difference * units,
          detail: `${product.name} shows ${shown.priceMinor} and the till charges ${product.posPriceMinor} — ${difference * units} of margin over ${units} unit(s) sold. Money, not a legal problem`,
        });
      }
    }
  }

  // Legal exposure first, and value does NOT reorder it. A ₹4 label error is still the
  // one that gets a shop a Legal Metrology notice.
  const overchargeRisks = findings
    .filter((f) => f.kind === 'overcharge_risk')
    .sort((a, b) => b.exposureMinor - a.exposureMinor || a.productId.localeCompare(b.productId));

  const other = findings
    .filter((f) => f.kind !== 'overcharge_risk')
    .sort((a, b) => b.exposureMinor - a.exposureMinor || a.productId.localeCompare(b.productId));

  const undercharedExposureMinor = findings
    .filter((f) => f.kind === 'undercharge')
    .reduce((s, f) => s + f.exposureMinor, 0);

  return {
    branchId: input.branchId,
    asAt: input.asAt,
    productsChecked: input.products.length,
    overchargeRisks,
    other,
    undercharedExposureMinor,
    detail:
      overchargeRisks.length === 0 && other.length === 0
        ? `all ${input.products.length} price(s) agree across every surface`
        : overchargeRisks.length > 0
          ? `${overchargeRisks.length} product(s) show LESS on the shelf than the till charges — fix these first whatever they are worth, because the displayed price is what the customer was offered — and ${other.length} other finding(s) behind them`
          : `${other.length} finding(s), ${undercharedExposureMinor} of margin walking out of the door`,
  };
}

export type EslPushOutcome = 'pushed' | 'unreachable' | 'not_confirmed' | 'stale_battery' | 'no_devices';

export interface EslPushResult {
  readonly productId: string;
  readonly branchId: string;
  readonly outcome: EslPushOutcome;
  readonly confirmed: readonly string[];
  readonly unconfirmed: readonly string[];
  /** True only when EVERY label confirmed the new price back. */
  readonly safeToChangeAtTill: boolean;
  readonly detail: string;
}

/**
 * Push a price to electronic shelf labels — and **wait for them to confirm it back**.
 *
 * The dangerous version of this is fire-and-forget: the system changes the price at the till,
 * sends it to the labels, and marks the job done. A label that did not receive it now shows the
 * old price while the till charges the new one, which is precisely the `overcharge_risk` above —
 * created by the system that was supposed to prevent it.
 *
 * So `safeToChangeAtTill` is true **only when every label has confirmed**. A price rise waits
 * for the shelf; that is the right way round, because the alternative is charging more than the
 * shelf says.
 */
export function pushEslPrice(input: {
  readonly productId: string;
  readonly branchId: string;
  readonly priceMinor: number;
  readonly devices: readonly { readonly deviceId: string; readonly shelfAddress?: string; readonly batteryPercent?: number }[];
  /** Device ids that echoed the new price back. */
  readonly confirmedBy: readonly string[];
  /** Battery below which a label is replaced before it goes dark mid-promotion. Default 15. */
  readonly lowBatteryPercent?: number;
}): EslPushResult {
  const low = input.lowBatteryPercent ?? 15;
  const base = { productId: input.productId, branchId: input.branchId };

  if (input.devices.length === 0) {
    return {
      ...base,
      outcome: 'no_devices',
      confirmed: [],
      unconfirmed: [],
      // No labels at all means no ESL to contradict the till — paper labels are a
      // separate control, audited above.
      safeToChangeAtTill: true,
      detail: 'no electronic labels are fitted for this product, so the shelf-edge control is the paper label',
    };
  }

  const confirmed = input.devices
    .filter((d) => input.confirmedBy.includes(d.deviceId))
    .map((d) => d.deviceId)
    .sort();
  const unconfirmed = input.devices
    .filter((d) => !input.confirmedBy.includes(d.deviceId))
    .map((d) => d.deviceId)
    .sort();

  if (unconfirmed.length > 0) {
    return {
      ...base,
      outcome: 'unreachable',
      confirmed,
      unconfirmed,
      safeToChangeAtTill: false,
      detail: `${unconfirmed.length} of ${input.devices.length} label(s) did not confirm: ${unconfirmed.join(', ')}. **Do not change the till price yet** — a label showing the old price while the till charges the new one is exactly the problem this system exists to prevent`,
    };
  }

  const flat = input.devices.filter((d) => d.batteryPercent !== undefined && d.batteryPercent < low);
  if (flat.length > 0) {
    return {
      ...base,
      outcome: 'stale_battery',
      confirmed,
      unconfirmed: [],
      // It confirmed, so the price IS right on the shelf. The battery is a separate job.
      safeToChangeAtTill: true,
      detail: `every label confirmed, but ${flat.length} of them (${flat.map((d) => d.deviceId).join(', ')}) are below ${low}% battery — replace them before one goes dark in the middle of a promotion`,
    };
  }

  return {
    ...base,
    outcome: 'pushed',
    confirmed,
    unconfirmed: [],
    safeToChangeAtTill: true,
    detail: `all ${confirmed.length} label(s) confirmed ${input.priceMinor} — the till may change now`,
  };
}
