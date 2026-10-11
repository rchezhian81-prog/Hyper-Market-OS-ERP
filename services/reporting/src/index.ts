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

import type { Route, BranchScope } from '../../kernel/src/router';
import { apiError } from '../../kernel/src/errors';
import { narrowScope } from '../../kernel/src/scope';
import {
  REPORTS,
  availability,
  reportCatalogue,
  whatWouldUnlockMost,
  type Producer,
  type CatalogueEntry,
} from '../../../packages/reporting/src/index';
import type { SourceTransaction } from '../../../packages/owner-control/src/index';

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
  /**
   * Round 4 (P-08): when the source's store computer has since said it holds NOTHING unsent (its report to head office,
   * at this time, later than `asAt`), an old figure is old because nothing new happened — not because the sync is broken.
   * The figure still says how old it is; it no longer tells the owner to wait for a sync that has nothing to bring.
   */
  readonly nothingUnsentAt?: string;
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
        : input.nothingUnsentAt !== undefined && Date.parse(input.nothingUnsentAt) >= Date.parse(input.asAt)
          ? `${input.name}: ${input.valueMinor} as at ${input.asAt} — ${Math.round(ageMinutes / 60)} hour(s) old because nothing newer happened: the store computer said at ${input.nothingUnsentAt} it had nothing waiting to send`
          : `${input.name}: ${input.valueMinor} as at ${input.asAt} — ${Math.round(ageMinutes / 60)} hour(s) old. Do not make a decision on this figure until the sync recovers`,
  };
}

/**
 * How current one source is — a store box, a till lane — judged from the newest record that reached here from it
 * (audit EA-01, M29-FR-01 "freshness per branch/domain", §31). Never the time somebody read it.
 *
 * When the store's own computer has reported its sync watermark (`reported`, EA-01 round 4), that is the better
 * answer: "everything this store committed before T has reached head office" — true even through a quiet hour with no
 * sales, and it stops (and ages) the moment the store's line goes down. The source's time is then the LATER of the two
 * (each is a true lower bound: the box drains in order), and `basis` says which one it is.
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
  /** The store's last COMPLETE sync of this domain — the time its figures are as at. Present when known. */
  readonly lastCompleteSyncAt?: string | null;
  /** Where `lastCompleteSyncAt` comes from: the store computer's own watermark report, or the newest record held. */
  readonly basis?: 'store_computer_watermark' | 'newest_record' | 'never_heard';
  /** From the store computer's last report: how many items were still waiting, and how many head office refused. */
  readonly unsent?: number;
  readonly deadLettered?: number;
  /** When head office last received the store computer's report. */
  readonly lastReportAt?: string;
}

/** What a store computer last reported for one domain (EA-01): its watermark and what still waited. */
export interface StoreSyncReport {
  /** Everything committed on the box before this instant has reached head office (null: no pass had run). */
  readonly completeThrough: string | null;
  readonly unsent: number;
  readonly deadLettered: number;
  /** When head office received the report. */
  readonly reportedAt: string;
}

/** The time a source's figures are as at: its last complete sync when known, else its newest record. */
export const syncedThrough = (s: SourceFreshness): string | null => (s.lastCompleteSyncAt !== undefined ? s.lastCompleteSyncAt : s.lastEventAt);

/** Judge one source's freshness against `now`, with the same thresholds a figure uses. */
export function sourceFreshness(input: {
  readonly source: string;
  readonly domain: string;
  readonly lastEventAt: string | null;
  readonly now: string;
  readonly laggingAfterMinutes?: number;
  readonly staleAfterMinutes?: number;
  /** EA-01: the store computer's own last report for this domain, when it has made one. */
  readonly reported?: StoreSyncReport;
}): SourceFreshness {
  const r = input.reported;
  const later = (a: string | null, b: string | null): string | null =>
    (a === null ? b : b === null ? a : Date.parse(b) > Date.parse(a) ? b : a);
  const through = r === undefined ? input.lastEventAt : later(input.lastEventAt, r.completeThrough);
  if (through === null) {
    return {
      source: input.source, domain: input.domain, lastEventAt: input.lastEventAt, staleness: 'stale',
      detail: r === undefined
        ? `${input.source}: nothing has ever arrived for ${input.domain}`
        : `${input.source}: its store computer has reported, but has never completed a sync of ${input.domain}`,
      ...(r === undefined ? {} : { lastCompleteSyncAt: null, basis: 'never_heard' as const, unsent: r.unsent, deadLettered: r.deadLettered, lastReportAt: r.reportedAt }),
    };
  }
  const ageMinutes = Math.max(0, (Date.parse(input.now) - Date.parse(through)) / 60_000);
  const staleness: Staleness = ageMinutes > (input.staleAfterMinutes ?? 60) ? 'stale'
    : ageMinutes > (input.laggingAfterMinutes ?? 5) ? 'lagging' : 'live';
  if (r === undefined) {
    return {
      source: input.source, domain: input.domain, lastEventAt: input.lastEventAt, staleness,
      detail: `${input.source}: newest ${input.domain} record from ${input.lastEventAt} (${Math.round(ageMinutes)} minutes before this read)`,
    };
  }
  const byBox = r.completeThrough !== null && through === r.completeThrough;
  const refused = r.deadLettered > 0 ? ` ${r.deadLettered} item(s) head office refused are waiting for a person.` : '';
  const verdict = staleness === 'live' ? '' : staleness === 'lagging' ? ' — behind, catching up'
    : ` — STALE, ${Math.round(ageMinutes / 60)} hour(s) old. Do not decide on this store's figures until its store computer syncs`;
  return {
    source: input.source, domain: input.domain, lastEventAt: input.lastEventAt, staleness,
    lastCompleteSyncAt: through, basis: byBox ? 'store_computer_watermark' : 'newest_record',
    unsent: r.unsent, deadLettered: r.deadLettered, lastReportAt: r.reportedAt,
    detail: `${input.source}: ${input.domain} complete up to ${through}${byBox ? " (its store computer's own report)" : ' (newest record held)'}`
      + `; last heard from at ${r.reportedAt}, ${r.unsent} item(s) then still waiting${verdict}.${refused}`,
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

/** What a named-report producer hands back (audit EA-06): figures, the rows behind them, and their sources. */
export interface ProducedReportView {
  readonly figures: readonly Figure[];
  readonly rows: readonly Readonly<Record<string, string>>[];
  readonly sources: readonly SourceFreshness[];
  /** Figure name → the source transactions it is the exact sum of (the governed drill, EA-05). */
  readonly drill: Readonly<Record<string, readonly SourceTransaction[]>>;
  readonly tradingDay?: string;
}

export interface ReportingDeps {
  /** The owner's dashboard figures. Only ever asked for the dashboard — a named report goes to `produce`. */
  readonly figures: (tenantId: string, name: string) => Promise<readonly Figure[]> | readonly Figure[];
  /**
   * Produce one named report from governed source records (audit EA-06). Only reports the catalogue says are produced
   * are ever asked for; absent, every named report is refused as not produced by this version — never answered with
   * the dashboard's figures.
   */
  readonly produce?: (tenantId: string, reportId: string, options: { readonly tradingDay?: string; readonly scope: BranchScope }) => Promise<ProducedReportView>;
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
      // One named report (audit EA-06): dispatched by name to its own producer, over the governed source records, in
      // the reader's server-derived branch scope (§28). An unknown name is refused (404) and a report this shop or
      // this version cannot produce is refused by name with the reason (409) — never answered with unrelated figures.
      // ?day=YYYY-MM-DD picks the shop's trading day for a day report (default today); ?scope=br-1,br-2 narrows.
      api: 'API-10', method: 'GET', path: '/v1/reports/:name',
      permission: 'reporting.report.read',
      handler: async (ctx) => {
        const name = ctx.params['name'] ?? '';
        const report = REPORTS.find((r) => r.id === name);
        if (report === undefined) {
          throw apiError(404, {
            code: 'no_such_report',
            whatHappened: `There is no report called "${name}".`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Pick a report from GET /v1/reports/catalogue.',
          });
        }
        const { records, produced } = (await deps.catalogueInputs?.(ctx.tenantId)) ?? { records: [], produced: [] };
        const can = availability(report, records, deps.produce === undefined ? [] : produced);
        if (!can.available) {
          throw apiError(409, {
            code: can.blockedBy,
            whatHappened: `${report.name} cannot be produced: ${can.why}.`,
            wasItSaved: 'not_saved',
            nextSafeAction: can.blockedBy === 'the_shop_does_not_record_it'
              ? `Start recording ${can.missing.join(', ')} and the report begins working.`
              : 'This version cannot work it out yet; the catalogue lists what it can.',
          });
        }
        const day = ctx.query['day'];
        if (day !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
          throw apiError(400, {
            code: 'not_readable_as_a_day',
            whatHappened: `"${day}" is not a trading day (YYYY-MM-DD).`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send ?day=YYYY-MM-DD, or leave it off for today.',
          });
        }
        const scopeQ = ctx.query['scope'];
        const requested = typeof scopeQ === 'string' && scopeQ.trim() !== '' ? scopeQ.split(',').map((x) => x.trim()).filter((x) => x !== '') : undefined;
        const scope = narrowScope(ctx, requested);
        const out = await deps.produce!(ctx.tenantId, report.id, { ...(day === undefined ? {} : { tradingDay: day }), scope });
        return {
          status: 200,
          body: {
            report: { id: report.id, family: report.family, name: report.name, answers: report.answers },
            ...(out.tradingDay === undefined ? {} : { tradingDay: out.tradingDay }),
            scope,
            ...dashboard(out.figures, deps.now(), out.sources),
            rows: out.rows,
          },
        };
      },
    },
  ];
}
