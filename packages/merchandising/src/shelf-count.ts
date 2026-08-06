// Counting a shelf facing (M04-FR-02/03, D05) — the producer that never existed.
//
// `planogramCompliance` has been written and tested since the module was created, and it needs one
// thing nothing in this system has ever produced: **how many of an item are on the shelf right
// now.** Without it the compliance report had nothing real to read, and its `?? 0` turned every
// uncounted facing into an empty one — the loudest alarm the function has, fired on every product
// in the shop.
//
// ── A shelf quantity is an observation, not a fact ──────────────────────────
//
// It was true when somebody looked and it decays from that moment: the shop keeps selling. So every
// count carries **when it was taken and who took it**, and the compliance run judges it against a
// freshness window the tenant sets. A count from Tuesday shown on Friday as *the shelf is empty*
// sends staff to a full shelf; a Tuesday reading of *the shelf is full* hides today's gap. Both are
// worse than saying nothing.
//
// ── Counted blind, like every other count in this product ───────────────────
//
// The person counting is never shown what the shelf is supposed to hold. It is the same discipline
// as the till drawer, the stock count and the driver's cash handover, and for the same reason: a
// number on the screen is an answer, and a tired person at the end of a shift will agree with it.
// **There is deliberately no function here that returns the expected quantity**, so a view cannot
// render one early even by accident — and a test asserts that absence.
//
// Pure and deterministic: the clock is injected, there is no I/O.

/** What somebody counted at one facing, at one moment. */
export interface ShelfCount {
  readonly storeId: string;
  readonly locationId: string;
  readonly productId: string;
  /** What was actually on the shelf, in the product's smallest unit. */
  readonly countedMinor: number;
  readonly countedBy: string;
  /** ISO-8601 UTC instant. Injected by the caller — this module has no clock. */
  readonly at: string;
}

export type CountRefusal =
  | 'a_negative_count_is_not_a_count'
  | 'a_count_needs_a_whole_number'
  | 'nobody_signed_this_count'
  | 'this_shop_has_no_such_shelf';

export type ShelfCountOutcome =
  | { readonly ok: true; readonly count: ShelfCount }
  | { readonly ok: false; readonly refusal: CountRefusal; readonly detail: string };

const REFUSALS: Readonly<Record<CountRefusal, CountRefusal>> = Object.freeze({
  a_negative_count_is_not_a_count: 'a_negative_count_is_not_a_count',
  a_count_needs_a_whole_number: 'a_count_needs_a_whole_number',
  nobody_signed_this_count: 'nobody_signed_this_count',
  this_shop_has_no_such_shelf: 'this_shop_has_no_such_shelf',
});

export const SHELF_COUNT_REFUSALS: readonly CountRefusal[] = Object.freeze(Object.values(REFUSALS));

/**
 * Record what somebody counted.
 *
 * Takes the figure and nothing else — **no expected quantity is accepted, so none can be compared
 * against and none can leak back to the screen**. What the facing is supposed to hold is the
 * planogram's business, and it is applied afterwards by `planogramCompliance`.
 */
export function recordShelfCount(input: {
  readonly storeId: string;
  readonly locationId: string;
  readonly productId: string;
  readonly countedMinor: number;
  readonly countedBy: string;
  readonly at: string;
  /** The shelves this shop actually has, so a typo does not become a phantom facing. */
  readonly knownLocationIds: readonly string[];
}): ShelfCountOutcome {
  if (!Number.isInteger(input.countedMinor)) {
    return {
      ok: false,
      refusal: 'a_count_needs_a_whole_number',
      detail: 'count in whole units. Half a tin on a shelf is a damaged tin, which is a different job.',
    };
  }
  if (input.countedMinor < 0) {
    return {
      ok: false,
      refusal: 'a_negative_count_is_not_a_count',
      detail: 'a shelf cannot hold less than nothing. If the facing is empty the answer is zero.',
    };
  }
  if (input.countedBy.trim() === '') {
    return {
      ok: false,
      refusal: 'nobody_signed_this_count',
      detail: 'a count nobody put their name to cannot be asked about later, and it will be asked about.',
    };
  }
  if (!input.knownLocationIds.includes(input.locationId)) {
    return {
      ok: false,
      refusal: 'this_shop_has_no_such_shelf',
      detail: `this shop has no shelf "${input.locationId}" — a count against a shelf that does not exist is a count nobody can act on.`,
    };
  }

  return {
    ok: true,
    count: {
      storeId: input.storeId,
      locationId: input.locationId,
      productId: input.productId,
      countedMinor: input.countedMinor,
      countedBy: input.countedBy.trim(),
      at: input.at,
    },
  };
}

/** One facing, and how long ago anybody looked at it. */
export interface CountAge {
  readonly locationId: string;
  readonly productId: string;
  /** Null when nobody has ever counted this facing — which is not "a long time ago". */
  readonly lastCountedAt: string | null;
  readonly minutesAgo: number | null;
  readonly stale: boolean;
}

/**
 * The latest count for each facing, and how old it is.
 *
 * Counts are **append-only**: a recount is a new observation, and the previous one stays. That is
 * not tidiness — "we counted it at nine and again at two" is the record that explains a variance,
 * and overwriting the nine o'clock reading destroys the only evidence of what changed in between.
 */
export function latestCounts(
  counts: readonly ShelfCount[],
  asOf: string,
  staleAfterMinutes: number,
): { readonly latest: readonly ShelfCount[]; readonly ages: readonly CountAge[] } {
  const now = Date.parse(asOf);
  const byFacing = new Map<string, ShelfCount>();
  for (const count of counts) {
    const key = `${count.productId}|${count.locationId}`;
    const held = byFacing.get(key);
    // Strictly later wins. On an identical timestamp the first stays, so replaying the same batch
    // twice cannot change the answer.
    if (held === undefined || Date.parse(count.at) > Date.parse(held.at)) byFacing.set(key, count);
  }

  const latest = [...byFacing.values()];
  return {
    latest,
    ages: latest.map((count) => {
      const parsed = Date.parse(count.at);
      const minutesAgo = Number.isFinite(parsed) ? Math.round((now - parsed) / 60_000) : null;
      return {
        locationId: count.locationId,
        productId: count.productId,
        lastCountedAt: count.at,
        minutesAgo,
        // An unreadable timestamp counts as stale. It is the safe direction: the worst outcome is
        // somebody being asked to count it again.
        stale: minutesAgo === null || minutesAgo > staleAfterMinutes,
      };
    }),
  };
}

/**
 * The facings that most need counting, worst first.
 *
 * **Never counted comes before long ago**, because those are the facings the compliance report can
 * say nothing at all about — and a report that covers most of the shop is one people trust for the
 * whole shop.
 */
export function countingWorklist(input: {
  readonly planned: readonly { readonly productId: string; readonly locationId: string }[];
  readonly counts: readonly ShelfCount[];
  readonly asOf: string;
  readonly staleAfterMinutes: number;
}): readonly CountAge[] {
  const { ages } = latestCounts(input.counts, input.asOf, input.staleAfterMinutes);
  const byFacing = new Map(ages.map((a) => [`${a.productId}|${a.locationId}`, a]));

  const rows: CountAge[] = input.planned.map((facing) => {
    const age = byFacing.get(`${facing.productId}|${facing.locationId}`);
    return age ?? {
      locationId: facing.locationId,
      productId: facing.productId,
      lastCountedAt: null,
      minutesAgo: null,
      stale: true,
    };
  });

  return rows
    .filter((row) => row.stale)
    .sort((a, b) => {
      if ((a.lastCountedAt === null) !== (b.lastCountedAt === null)) return a.lastCountedAt === null ? -1 : 1;
      return (b.minutesAgo ?? 0) - (a.minutesAgo ?? 0);
    });
}
