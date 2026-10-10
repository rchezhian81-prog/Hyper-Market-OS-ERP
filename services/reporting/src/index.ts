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
  /**
   * When the underlying data was last true — the SOURCE's time (the newest record that reached here from the source the
   * figure is built from), never the moment somebody read it (audit EA-01). Mandatory — there is no way to omit it.
   * `null` means the source has never sent anything: the figure is then not available and `stale`, never "fresh".
   */
  readonly asAt: string | null;
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
  /** The source's own last time (see `Figure.asAt`); `null` when the source has never been heard from. */
  readonly asAt: string | null;
  readonly now: string;
  /** Minutes after which a figure is lagging. Per-tenant. Default 5 (§32). */
  readonly laggingAfterMinutes?: number;
  /** Minutes after which it should not be relied on. Default 60. */
  readonly staleAfterMinutes?: number;
  readonly notAvailableBecause?: string;
}): Figure {
  const lagging = input.laggingAfterMinutes ?? 5;
  const stale = input.staleAfterMinutes ?? 60;
  if (input.asAt === null) {
    // Never heard from the source. Not "0 minutes ago" — the freshest possible answer — and never a number.
    const because = input.notAvailableBecause ?? 'nothing has arrived from the source yet';
    return {
      name: input.name, unit: input.unit, asAt: null, staleness: 'stale',
      notAvailableBecause: because,
      detail: `${input.name}: not available — ${because}`,
    };
  }
  const ageMinutes = Math.max(0, (Date.parse(input.now) - Date.parse(input.asAt)) / 60_000);
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

/**
 * How current one source is — a store box, a till lane — judged from the newest record that reached here from it
 * (audit EA-01, M29-FR-01 "freshness per branch/domain", §31). Never the time somebody read it.
 */
export interface SourceFreshness {
  /** What the source is, e.g. `store:S1` or `lane:lane-1`. */
  readonly source: string;
  /** The domain the records are from, e.g. `sales`. */
  readonly domain: string;
  /** When the newest record from this source happened at the source; `null` when nothing has ever arrived. */
  readonly lastEventAt: string | null;
  readonly staleness: Staleness;
  readonly detail: string;
}

/** Judge one source's freshness against `now`, with the same thresholds a figure uses. */
export function sourceFreshness(input: {
  readonly source: string;
  readonly domain: string;
  readonly lastEventAt: string | null;
  readonly now: string;
  readonly laggingAfterMinutes?: number;
  readonly staleAfterMinutes?: number;
}): SourceFreshness {
  if (input.lastEventAt === null) {
    return {
      source: input.source, domain: input.domain, lastEventAt: null, staleness: 'stale',
      detail: `${input.source}: nothing has ever arrived for ${input.domain}`,
    };
  }
  const ageMinutes = Math.max(0, (Date.parse(input.now) - Date.parse(input.lastEventAt)) / 60_000);
  const staleness: Staleness = ageMinutes > (input.staleAfterMinutes ?? 60) ? 'stale'
    : ageMinutes > (input.laggingAfterMinutes ?? 5) ? 'lagging' : 'live';
  return {
    source: input.source, domain: input.domain, lastEventAt: input.lastEventAt, staleness,
    detail: `${input.source}: newest ${input.domain} record from ${input.lastEventAt} (${Math.round(ageMinutes)} minutes before this read)`,
  };
}

export interface Dashboard {
  readonly figures: readonly Figure[];
  readonly worstStaleness: Staleness;
  /**
   * The time the dashboard is true as of: its STALEST figure's source time (audit EA-01) — `null` when any figure's
   * source has never been heard from, or there are no figures. Never the read time; that is `readAt`.
   */
  readonly asAt: string | null;
  /** When this read was made. Reported separately, and never offered as the data's freshness. */
  readonly readAt: string;
  /** Each source behind the figures and how current it is, when the producer knows them. */
  readonly sources?: readonly SourceFreshness[];
  readonly detail: string;
}

/** A dashboard is as fresh as its stalest figure (and source), never as fresh as its freshest. */
export function dashboard(figures: readonly Figure[], now: string, sources?: readonly SourceFreshness[]): Dashboard {
  const rank: Readonly<Record<Staleness, number>> = { live: 0, lagging: 1, stale: 2 };
  const worst = [...figures.map((f) => f.staleness), ...(sources ?? []).map((s) => s.staleness)].reduce<Staleness>(
    (w, st) => (rank[st] > rank[w] ? st : w), 'live',
  );
  const missing = figures.filter((f) => f.valueMinor === undefined);
  const times = figures.map((f) => f.asAt);
  const asAt = times.length === 0 || times.some((t) => t === null)
    ? null
    : (times as string[]).reduce((oldest, t) => (Date.parse(t) < Date.parse(oldest) ? t : oldest));
  return {
    figures, worstStaleness: worst, asAt, readAt: now,
    ...(sources === undefined ? {} : { sources }),
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
  /**
   * The sources behind the figures and how current each is, judged from the newest record that reached here from each
   * (audit EA-01). Optional so a bare wiring still serves; when present the dashboard carries them and is never
   * fresher than its stalest source.
   */
  readonly sources?: (tenantId: string) => Promise<readonly SourceFreshness[]> | readonly SourceFreshness[];
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
        body: dashboard(await deps.figures(ctx.tenantId, 'dashboard'), deps.now(), await deps.sources?.(ctx.tenantId)),
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
        body: dashboard(await deps.figures(ctx.tenantId, ctx.params['name'] ?? ''), deps.now(), await deps.sources?.(ctx.tenantId)),
      }),
    },
  ];
}
