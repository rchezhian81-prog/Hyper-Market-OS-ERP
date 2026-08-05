// The day, projected from the box's own disk — M29-FR-01, M15, §31.
//
// The edge wrote every sale at every lane, so it can answer questions about the day without asking
// anybody. That is the whole reason the six screens can work with the internet down.
//
// ── What it can answer, and what it honestly cannot ─────────────────────────
//
// From the log alone: how many bills, what was taken, on which lane, by which cashier, in what
// tender. Those are facts about events this box witnessed.
//
// **Margin is not one of them.** What the goods cost is a fact about the catalogue, not about the
// sale, so it can only come from the pack. A product the pack has no cost price for makes its
// sales **uncostable** — and an uncostable sale is left out of the margin figures and *counted*,
// rather than costed at zero. Costing at zero reports a 100% margin, which is a lie that reads as
// very good news and would be believed.
//
// ── Why exceptions are computed here rather than fetched ────────────────────
//
// A void spike is visible in the log the moment it happens. Waiting for the cloud to notice it and
// send it back would mean the manager's exception register — the thing that decides whether a
// trading day may be locked — went blank the moment the line went down, which is precisely when a
// shop is least supervised. The rules are data from the pack (M15-FR-01); the evaluation is local.

import { evaluateLossPrevention, type ActivityEvent, type LpException, type LpRule } from '../../../packages/loss-prevention/src/index';
import type { SaleFact } from '../../../packages/reporting/src/index';
import type { PackProduct } from './store-pack';

/** One sale as it was written to this box's disk by a lane (see `apps/pos/src/session.ts`). */
export interface LoggedSale {
  readonly id: string;
  readonly number?: string;
  readonly laneId?: string;
  readonly cashierId?: string;
  readonly tradingDay?: string;
  readonly committedAt?: string;
  readonly total?: number;
  readonly netMinor?: number;
  readonly taxMinor?: number;
  readonly currency?: string;
  readonly lines?: readonly { readonly productId: string; readonly quantityMinor: number; readonly uom?: string }[];
  readonly tenders?: readonly { readonly kind?: string; readonly amount?: { readonly minor?: number } }[];
}

/**
 * Read the records this box holds into sales.
 *
 * A record that will not parse, or that carries no id, is **dropped and counted** rather than
 * guessed at. A half-written record from a power cut is not a sale with some fields missing; it is
 * a thing nobody can vouch for, and turning it into a zero-value sale would put a fiction into the
 * day's figures.
 */
export function readSales(records: readonly string[]): { readonly sales: readonly LoggedSale[]; readonly unreadable: number } {
  const sales: LoggedSale[] = [];
  let unreadable = 0;
  for (const record of records) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(record) as unknown;
    } catch {
      unreadable += 1;
      continue;
    }
    if (parsed === null || typeof parsed !== 'object' || typeof (parsed as LoggedSale).id !== 'string') {
      unreadable += 1;
      continue;
    }
    sales.push(parsed as LoggedSale);
  }
  return { sales, unreadable };
}

export interface CostedDay {
  /** The sales that could be costed in full — the only ones margin is computed over. */
  readonly facts: readonly SaleFact[];
  /** How many sales were left out because a product had no cost price. Never hidden. */
  readonly uncostableSales: number;
  /** Which products caused it, so the person who can fix it knows what to fix. */
  readonly productsWithoutCost: readonly string[];
  /** Everything taken today, costed or not — the shop's money is a fact either way. */
  readonly takenMinor: number;
  readonly billCount: number;
}

/**
 * Turn the day's sales into the facts the owner's brief is built from.
 *
 * The split is the point. **Takings are known from the log** — the money came in whether or not
 * anybody recorded what the goods cost. **Margin is only known where every line can be costed**,
 * so a sale containing one uncosted product is excluded from `facts` and counted in
 * `uncostableSales`. Both numbers are then true, and the gap between them is named rather than
 * quietly absorbed into the margin.
 */
export function costTheDay(
  sales: readonly LoggedSale[],
  products: readonly PackProduct[],
): CostedDay {
  const costOf = new Map(products.filter((p) => p.unitCostMinor !== undefined).map((p) => [p.productId, p.unitCostMinor!]));
  const facts: SaleFact[] = [];
  const missing = new Set<string>();
  let uncostable = 0;
  let taken = 0;

  for (const sale of sales) {
    const total = sale.total ?? 0;
    taken += total;

    const lines = sale.lines ?? [];
    let cogs = 0;
    let costable = lines.length > 0;
    for (const line of lines) {
      const unitCost = costOf.get(line.productId);
      if (unitCost === undefined) {
        missing.add(line.productId);
        costable = false;
        continue;
      }
      // Weighed goods are held in the UOM's smallest unit, so the cost of 1.5kg is
      // `unitCost × 1500 / 1000`. Integer arithmetic throughout — never a float (§29.1).
      cogs += line.uom === 'kg' || line.uom === 'g'
        ? Math.round((unitCost * line.quantityMinor) / 1000)
        : unitCost * line.quantityMinor;
    }

    if (!costable) {
      uncostable += 1;
      continue;
    }

    const net = sale.netMinor ?? total;
    facts.push({
      saleId: sale.id,
      netMinor: net,
      taxMinor: sale.taxMinor ?? total - net,
      totalMinor: total,
      cogsMinor: cogs,
      units: lines.reduce((n, l) => n + (l.uom === 'ea' ? l.quantityMinor : 1), 0),
      // The first tender is the one the day is reported by. A split payment is rare and reporting
      // it under its first kind is a choice; reporting it under none would lose the sale entirely.
      tender: sale.tenders?.[0]?.kind ?? 'unknown',
      currency: 'INR',
    });
  }

  return {
    facts,
    uncostableSales: uncostable,
    productsWithoutCost: [...missing].sort(),
    takenMinor: taken,
    billCount: sales.length,
  };
}

/**
 * Turn the day's sales into the activity the loss-prevention rules watch.
 *
 * Only what the log actually witnessed. A void that happened on a lane and never reached the disk
 * is not in here, and pretending otherwise would make the exception register look clean for the
 * one reason it should look suspicious.
 */
export function activityFrom(sales: readonly LoggedSale[]): readonly ActivityEvent[] {
  const activity: ActivityEvent[] = [];
  for (const sale of sales) {
    const at = sale.committedAt ?? '';
    const cashierId = sale.cashierId ?? 'unknown';
    // A negative total is a refund at the lane, and a refund is the single most watched signal in
    // a shop (M15-FR-01). Recorded by its sign rather than by a flag nobody sets.
    if ((sale.total ?? 0) < 0) {
      activity.push({ txnId: sale.id, kind: 'refund', cashierId, valueMinor: Math.abs(sale.total ?? 0), at });
    }
  }
  return activity;
}

export interface DayExceptions {
  readonly exceptions: readonly LpException[];
  /** True when the pack carried no rules — so an empty list means "not checked", not "clean". */
  readonly rulesKnown: boolean;
}

/**
 * Evaluate the day against the store's own thresholds.
 *
 * **Zero exceptions with no rules is not a clean shop; it is a shop nobody is watching.** The two
 * are indistinguishable in a list of length zero, so the caller is told which it has and the
 * manager's day close treats the second as a reason to stop.
 */
export function exceptionsFor(
  activity: readonly ActivityEvent[],
  rules: readonly LpRule[] | undefined,
): DayExceptions {
  if (rules === undefined) return { exceptions: [], rulesKnown: false };
  return { exceptions: evaluateLossPrevention(activity, rules), rulesKnown: true };
}
