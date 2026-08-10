// API-10 Reporting — read models and KPIs, read-only, with freshness.
//
// **No figure leaves this service without the time it is true as of**, and the type system makes
// that impossible to forget: a `Figure` cannot be constructed without an `asAt`. A dashboard
// number with no timestamp is the number somebody quotes in a meeting three hours after the sync
// stopped, and nothing about it looks wrong (P-08, NFR-09).
//
// The second rule follows from the first: **a figure computed from stale inputs says so, in the
// figure**, not in a banner somebody has learned to ignore. And a figure that cannot be computed
// at all returns `not_available` with the reason — never a zero. A zero is a number people act on.

import type { Route } from '../../kernel/src/index';
import {
  reportCatalogue,
  whatWouldUnlockMost,
  type Producer,
  type CatalogueEntry,
} from '../../../packages/reporting/src/index';

export type Staleness = 'live' | 'lagging' | 'stale';

export interface Figure {
  readonly name: string;
  /** `undefined` means it could not be computed. Never substituted with zero. */
  readonly valueMinor?: number;
  readonly unit: 'minor_currency' | 'count' | 'basis_points';
  /** When the underlying data was last synchronised. Mandatory — there is no way to omit it. */
  readonly asAt: string;
  readonly staleness: Staleness;
  /** Present when the figure could not be produced. */
  readonly notAvailableBecause?: string;
  readonly detail: string;
}

/**
 * Build a figure with its freshness attached.
 *
 * `lagging` and `stale` are separated because they mean different things to the reader: lagging is
 * "this will catch up", stale is "stop using this number".
 */
export function figure(input: {
  readonly name: string;
  readonly valueMinor?: number;
  readonly unit: Figure['unit'];
  readonly asAt: string;
  readonly now: string;
  /** Minutes after which a figure is lagging. Per-tenant. Default 5 (§32). */
  readonly laggingAfterMinutes?: number;
  /** Minutes after which it should not be relied on. Default 60. */
  readonly staleAfterMinutes?: number;
  readonly notAvailableBecause?: string;
}): Figure {
  const ageMinutes = Math.max(0, (Date.parse(input.now) - Date.parse(input.asAt)) / 60_000);
  const lagging = input.laggingAfterMinutes ?? 5;
  const stale = input.staleAfterMinutes ?? 60;
  const staleness: Staleness = ageMinutes > stale ? 'stale' : ageMinutes > lagging ? 'lagging' : 'live';

  if (input.notAvailableBecause !== undefined || input.valueMinor === undefined) {
    return {
      name: input.name, unit: input.unit, asAt: input.asAt, staleness,
      notAvailableBecause: input.notAvailableBecause ?? 'the underlying data did not arrive',
      // A zero here is a number somebody acts on. Absence is the honest answer and it is visible.
      detail: `${input.name}: not available — ${input.notAvailableBecause ?? 'the underlying data did not arrive'}`,
    };
  }

  return {
    name: input.name, valueMinor: input.valueMinor, unit: input.unit, asAt: input.asAt, staleness,
    detail: staleness === 'live'
      ? `${input.name}: ${input.valueMinor} as at ${input.asAt}`
      : staleness === 'lagging'
        ? `${input.name}: ${input.valueMinor} as at ${input.asAt} — ${Math.round(ageMinutes)} minutes behind, catching up`
        : `${input.name}: ${input.valueMinor} as at ${input.asAt} — ${Math.round(ageMinutes / 60)} hour(s) old. Do not make a decision on this figure until the sync recovers`,
  };
}

export interface Dashboard {
  readonly figures: readonly Figure[];
  readonly worstStaleness: Staleness;
  readonly asAt: string;
  readonly detail: string;
}

/** A dashboard is as fresh as its stalest figure, never as fresh as its freshest. */
export function dashboard(figures: readonly Figure[], now: string): Dashboard {
  const rank: Readonly<Record<Staleness, number>> = { live: 0, lagging: 1, stale: 2 };
  const worst = figures.reduce<Staleness>(
    (w, f) => (rank[f.staleness] > rank[w] ? f.staleness : w), 'live',
  );
  const missing = figures.filter((f) => f.valueMinor === undefined);
  return {
    figures, worstStaleness: worst, asAt: now,
    // An empty dashboard is not a clean one. `reduce` with a seed of `live` over no figures
    // returns `live`, so a dashboard with nothing on it reported "0 figures, all current" — which
    // is the sentence a person reads as "everything is fine".
    detail: figures.length === 0
      ? 'no figures at all. An empty dashboard is not a clean one — nothing here has been measured, which is a different thing from everything being in order'
      : worst === 'live' && missing.length === 0
        ? `${figures.length} figures, all current`
        : `${figures.length} figures — worst freshness ${worst}${missing.length > 0 ? `, ${missing.length} not available` : ''}. A dashboard is only as fresh as its stalest number`,
  };
}

/**
 * What the report catalogue needs to answer "which reports can I run, and what should I start
 * recording to unlock more" — the two facts that are *not* the reporting service's to invent:
 * `records` is what the shop actually records, `produced` is what this build can work out. Both
 * are supplied by the composition root (M29/M30). Absent them the catalogue is still honest — it
 * simply reports everything as not yet available, with the reason.
 */
export interface CatalogueInputs {
  readonly records: readonly Producer[];
  readonly produced: readonly string[];
}

export interface ReportingDeps {
  readonly figures: (tenantId: string, name: string) => Promise<readonly Figure[]> | readonly Figure[];
  readonly now: () => string;
  /**
   * Optional so a bare wiring (no store) still serves the route honestly. When present, its
   * `records`/`produced` drive the tested `reportCatalogue` engine — the same code the unit tests
   * pin — rather than a second copy of that logic living in this service.
   */
  readonly catalogueInputs?: (tenantId: string) => Promise<CatalogueInputs> | CatalogueInputs;
}

/** What the catalogue route returns: the whole catalogue, and what to record next to unlock more. */
export interface ReportCatalogueView {
  readonly reports: readonly CatalogueEntry[];
  readonly unlockNext: ReturnType<typeof whatWouldUnlockMost>;
}

/**
 * Read-only, by construction.
 *
 * Every route here is a GET. A reporting service that can write is a second path into the domains
 * it reports on, with none of their controls — and it is always added "just for this one job".
 */
export function reportingRoutes(deps: ReportingDeps): readonly Route[] {
  return [
    {
      api: 'API-10', method: 'GET', path: '/v1/reports/dashboard',
      permission: 'reporting.dashboard.read',
      handler: async (ctx) => ({
        status: 200,
        body: dashboard(await deps.figures(ctx.tenantId, 'dashboard'), deps.now()),
      }),
    },
    {
      // The report catalogue (D13 / M29 / M30): every report D13 names, each marked runnable or
      // not — and when not, WHY, split into "the shop does not record it yet" (the owner can act)
      // and "this version cannot produce it" (we can). Produced by the tested `reportCatalogue`
      // engine, so this running route and the unit tests exercise ONE implementation, not two.
      // Declared BEFORE the `:name` route so `catalogue` is not read as a report name.
      api: 'API-10', method: 'GET', path: '/v1/reports/catalogue',
      permission: 'reporting.report.read',
      handler: async (ctx) => {
        const { records, produced } = (await deps.catalogueInputs?.(ctx.tenantId))
          ?? { records: [], produced: [] };
        const body: ReportCatalogueView = {
          reports: reportCatalogue(records, produced),
          unlockNext: whatWouldUnlockMost(records, produced),
        };
        return { status: 200, body };
      },
    },
    {
      api: 'API-10', method: 'GET', path: '/v1/reports/:name',
      permission: 'reporting.report.read',
      handler: async (ctx) => ({
        status: 200,
        body: dashboard(await deps.figures(ctx.tenantId, ctx.params['name'] ?? ''), deps.now()),
      }),
    },
  ];
}
