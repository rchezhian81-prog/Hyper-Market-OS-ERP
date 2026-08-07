// Self-extraction from the incumbent system — MG-01, MG-02, MG-06 (§34, OD-05, hard rule #7).
//
// **The incumbent vendor is not going to help.** That is the owner's decision of 7 August 2026,
// and it is the correct reading of the situation rather than a pessimistic one: a vendor asked
// to export a customer's data in an open format is being asked to help that customer leave. The
// request may be answered slowly, partially, in a format nobody can use, or not at all — and a
// migration plan whose first step is *"wait for them"* has handed its schedule to somebody whose
// interests run the other way.
//
// So we extract it ourselves. That is lawful and ordinary: it is **our business data, on our
// hardware, in software we licensed**. What we do not do is touch their source code, defeat a
// technical protection measure, or use anything but the access we already have. (A licence
// agreement may still say something about this. That is a question for the owner's CA or
// solicitor — a real question, and not one that blocks reading a stock report.)
//
// The consequence that actually shapes this module is not access. It is **verification.**
//
//   • With a vendor export you would have their word for what the data means. Without one, every
//     figure comes from the same place — and MG-06 already refuses a control total whose two
//     sides were computed the same way. Reading the stock value off the ERP's stock report and
//     then "verifying" it against the ERP's valuation report is that mistake wearing two hats.
//   • **The independent evidence therefore has to come from OUTSIDE the ERP entirely** — the bank
//     statement, the filed GST returns, the supplier's own statement of account, and the stock on
//     our own shelves. Every one of those is a record somebody else keeps, with their own reasons
//     for it being right.
//   • That is **better evidence than a vendor export**, not a poorer substitute for one. A
//     vendor-supplied file is one system's account of itself. A bank statement is an adversary's.
//
// Pure and deterministic: no I/O, no clock beyond what is passed.

/** How a body of data was actually got out. Ordered by fidelity, best first. */
export type ExtractionMethod =
  /** Read the incumbent's own database directly. Complete, including history. */
  | 'direct_database_read'
  /** The product's own "export to Excel/CSV" on a screen or report. */
  | 'built_in_export'
  /** A report printed to PDF or text, then parsed. */
  | 'printed_report'
  /** Read off a screen and typed in. Last resort, and only for small tables. */
  | 'manual_rekey';

export type DataDomain =
  | 'products' | 'barcodes' | 'prices' | 'stock' | 'batches'
  | 'suppliers' | 'purchases' | 'customers' | 'loyalty'
  | 'sales' | 'tax' | 'ledgers';

export interface ExtractionRoute {
  readonly domain: DataDomain;
  readonly method: ExtractionMethod;
  /** What it is: "Stock Valuation Report → Export to Excel", "SQL Server: dbo.ItemMaster". */
  readonly description: string;
  /** Rows obtained. Counted, never estimated — an estimate cannot be a control total (MG-01). */
  readonly rowCount?: number;
  /** Fields the route CANNOT yield, however carefully it is run. Stated, not discovered later. */
  readonly cannotYield: readonly string[];
  /** Whether the route can be re-run to produce the same file — MG-05 needs repeatability. */
  readonly repeatable: boolean;
}

/**
 * What each method can and cannot be trusted to do.
 *
 * Written from what these systems actually are: a Windows box in a back office running a local
 * database, with grids that export to Excel and reports that print. The fidelity ranking is not
 * a preference — it is about what is *structurally* lost. A printed report has already made
 * decisions about grouping, rounding and what to leave off, and no amount of careful parsing
 * gets those back.
 */
export const METHOD_FIDELITY: Readonly<Record<ExtractionMethod, {
  readonly rank: number;
  readonly yieldsHistory: boolean;
  readonly yieldsRowLevel: boolean;
  readonly repeatableByNature: boolean;
  readonly note: string;
}>> = {
  direct_database_read: {
    rank: 1, yieldsHistory: true, yieldsRowLevel: true, repeatableByNature: true,
    note: 'complete and re-runnable; the only route that yields history and the fields no report prints',
  },
  built_in_export: {
    rank: 2, yieldsHistory: false, yieldsRowLevel: true, repeatableByNature: true,
    note: 'row-level and repeatable, but limited to what the screen shows — filters, paging and hidden columns silently truncate it',
  },
  printed_report: {
    rank: 3, yieldsHistory: false, yieldsRowLevel: false, repeatableByNature: true,
    note: 'a report has already grouped, rounded and omitted; parsing recovers the figures it printed, never the ones it did not',
  },
  manual_rekey: {
    rank: 4, yieldsHistory: false, yieldsRowLevel: true, repeatableByNature: false,
    note: 'not repeatable and not reconcilable — two people re-keying the same page produce two datasets. Small tables only, and every one double-entered',
  },
};

export type RouteRisk =
  | 'not_repeatable'
  | 'no_history'
  | 'aggregated_only'
  | 'volume_unknown'
  | 'known_gaps';

export interface RouteAssessment {
  readonly domain: DataDomain;
  readonly method: ExtractionMethod;
  readonly risks: readonly RouteRisk[];
  readonly usable: boolean;
  readonly detail: string;
}

/**
 * Judge one route, naming every risk at once rather than the first.
 *
 * `usable` is deliberately generous: almost any route is usable *given a matching verification*.
 * What is not permitted is using one without knowing what it costs — and the cost is the risk
 * list, which flows into the verification plan below.
 */
export function assessRoute(route: ExtractionRoute): RouteAssessment {
  const fidelity = METHOD_FIDELITY[route.method];
  const risks: RouteRisk[] = [];

  if (!route.repeatable || !fidelity.repeatableByNature) risks.push('not_repeatable');
  if (!fidelity.yieldsHistory) risks.push('no_history');
  if (!fidelity.yieldsRowLevel) risks.push('aggregated_only');
  if (route.rowCount === undefined) risks.push('volume_unknown');
  if (route.cannotYield.length > 0) risks.push('known_gaps');

  // Only one risk is disqualifying on its own. A route nobody can re-run cannot be trialled
  // (MG-05), cannot be delta'd (MG-09), and cannot be redone if the first load is wrong.
  const usable = route.repeatable && fidelity.repeatableByNature;

  const REASON: Readonly<Record<RouteRisk, string>> = {
    not_repeatable: 'cannot be re-run to produce the same file, so it cannot be trialled, delta\'d or redone',
    no_history: 'yields current state only — historical documents are not in it',
    aggregated_only: 'yields totals rather than rows; batch, expiry and line detail are not recoverable',
    volume_unknown: 'row count not counted, so it cannot be a control total (MG-01)',
    known_gaps: `does not yield: ${route.cannotYield.join(', ')}`,
  };

  return {
    domain: route.domain,
    method: route.method,
    risks,
    usable,
    detail: usable
      ? `${route.domain} via ${route.method}: ${fidelity.note}${risks.length > 0 ? `. Risks — ${risks.map((r) => REASON[r]).join('; ')}` : ''}`
      : `${route.domain} via ${route.method} is NOT usable as a migration source: ${REASON['not_repeatable']}`,
  };
}

// ── Independent verification (MG-06, and the heart of this file) ──────────────

/**
 * Evidence that does **not** come from the incumbent system.
 *
 * This is the list that makes self-extraction sound. Each of these is a record kept by somebody
 * else, for their own reasons, with no interest in agreeing with our old ERP — which is precisely
 * what makes it evidence rather than a second opinion from the same witness.
 */
export type ExternalSource =
  /** The bank's own record of money in and out. */
  | 'bank_statement'
  /** GST returns already filed with the portal — signed, dated, and not ours to revise casually. */
  | 'filed_gst_return'
  /** The supplier's own statement of what we owe them. They will confirm it; they want paying. */
  | 'supplier_statement'
  /** What is actually on the shelf, counted by us. The only truth about stock that exists. */
  | 'physical_count'
  /** The card/UPI provider's settlement file. */
  | 'payment_settlement'
  /** Books the CA already prepared and signed from the same period. */
  | 'ca_prepared_accounts'
  /** A customer's own record — a loyalty card balance they can see and dispute. */
  | 'customer_confirmation';

export const EXTERNAL_SOURCE_NOTE: Readonly<Record<ExternalSource, string>> = {
  bank_statement: 'the bank has no interest in agreeing with our old system',
  filed_gst_return: 'already filed, dated and signed — it cannot be adjusted to make a total agree',
  supplier_statement: 'the supplier keeps their own ledger and will confirm it, because they want paying',
  physical_count: 'the only truth about stock that exists anywhere; everything else is a record of it',
  payment_settlement: 'the provider settled real money and their file says how much',
  ca_prepared_accounts: 'prepared independently and signed, by somebody with a licence at stake',
  customer_confirmation: 'the customer can see their own points balance and will say if it is wrong',
};

/** Which external evidence can verify which domain. Nothing else is accepted as verification. */
export const VERIFIES: Readonly<Record<DataDomain, readonly ExternalSource[]>> = {
  products: ['physical_count'],
  barcodes: ['physical_count'],
  prices: ['physical_count'],
  stock: ['physical_count'],
  batches: ['physical_count'],
  suppliers: ['supplier_statement'],
  purchases: ['supplier_statement', 'bank_statement'],
  customers: ['customer_confirmation'],
  loyalty: ['customer_confirmation'],
  sales: ['bank_statement', 'payment_settlement', 'filed_gst_return'],
  tax: ['filed_gst_return', 'ca_prepared_accounts'],
  ledgers: ['bank_statement', 'ca_prepared_accounts', 'filed_gst_return'],
};

export interface VerificationPlan {
  readonly domain: DataDomain;
  readonly extractedVia: ExtractionMethod;
  readonly verifiedBy: readonly ExternalSource[];
  /** True when nothing outside the incumbent system checks this domain. */
  readonly unverifiable: boolean;
  readonly detail: string;
}

export type PlanRefusal = 'verified_by_the_same_system' | 'no_external_source';

export interface VerificationResult {
  readonly plans: readonly VerificationPlan[];
  readonly unverifiable: readonly DataDomain[];
  readonly refusals: readonly { readonly domain: DataDomain; readonly refusal: PlanRefusal; readonly detail: string }[];
  readonly sound: boolean;
  readonly detail: string;
}

/**
 * Build the verification plan, refusing any domain checked only against the system it came from.
 *
 * **This is the control the whole approach stands on.** Without a vendor export there is nothing
 * to cross-check the incumbent against except the incumbent — and a stock figure read off the
 * stock report, "verified" against the valuation report, reconciles perfectly and proves only
 * that one system is internally consistent. It would be internally consistent about a wrong
 * number too.
 */
export function planVerification(input: {
  readonly routes: readonly ExtractionRoute[];
  /** The external evidence actually obtainable. Absent means we have not got it, not that it does not exist. */
  readonly available: readonly ExternalSource[];
}): VerificationResult {
  const have = new Set(input.available);
  const plans: VerificationPlan[] = [];
  const refusals: { domain: DataDomain; refusal: PlanRefusal; detail: string }[] = [];

  for (const route of input.routes) {
    const candidates = VERIFIES[route.domain];
    const verifiedBy = candidates.filter((s) => have.has(s));

    if (candidates.length === 0) {
      refusals.push({
        domain: route.domain, refusal: 'no_external_source',
        detail: `nothing outside the incumbent system can check ${route.domain} — it can be migrated, but it is migrated on the old system's word alone, and that has to be stated to the owner rather than discovered`,
      });
    } else if (verifiedBy.length === 0) {
      refusals.push({
        domain: route.domain, refusal: 'verified_by_the_same_system',
        detail: `${route.domain} would be checked only against the system it came from. A total read off one report and agreed against another from the same product reconciles perfectly and proves nothing except internal consistency — it would be just as consistent about a wrong number. Obtain one of: ${candidates.join(', ')}`,
      });
    }

    plans.push({
      domain: route.domain,
      extractedVia: route.method,
      verifiedBy,
      unverifiable: verifiedBy.length === 0,
      detail: verifiedBy.length > 0
        ? `${route.domain} checked against ${verifiedBy.map((s) => `${s} (${EXTERNAL_SOURCE_NOTE[s]})`).join(' and ')}`
        : `${route.domain} has no independent check`,
    });
  }

  const unverifiable = plans.filter((p) => p.unverifiable).map((p) => p.domain);
  const sound = refusals.length === 0;

  return {
    plans,
    unverifiable,
    refusals,
    sound,
    detail: sound
      ? `all ${plans.length} domains verified against evidence from outside the incumbent system — which is stronger than a vendor export, because a vendor file is one system's account of itself`
      : `${refusals.length} domains have no independent check: ${unverifiable.join(', ')}. Migration can still proceed, but those figures rest on the old system's word and the owner must be told so in writing`,
  };
}

// ── Readiness ─────────────────────────────────────────────────────────────────

export type ReadinessBlocker =
  | 'domain_not_covered'
  | 'unusable_route'
  | 'no_independent_verification'
  | 'no_preservation_copy';

export interface ExtractionReadiness {
  readonly coveredDomains: readonly DataDomain[];
  readonly missingDomains: readonly DataDomain[];
  readonly blockers: readonly ReadinessBlocker[];
  readonly ready: boolean;
  /** Whichever way this goes, the shop is still trading on the old system. P-01. */
  readonly shopKeepsTrading: true;
  readonly detail: string;
  readonly ownerAction: string;
}

const ALL_DOMAINS: readonly DataDomain[] = [
  'products', 'barcodes', 'prices', 'stock', 'batches',
  'suppliers', 'purchases', 'customers', 'loyalty', 'sales', 'tax', 'ledgers',
];

/**
 * Are we ready to extract without the vendor?
 *
 * Every blocker at once. A readiness report that surfaces one problem per attempt produces four
 * separate evenings, and by the third the report is being argued with rather than worked through.
 */
export function assessExtractionReadiness(input: {
  readonly routes: readonly ExtractionRoute[];
  readonly available: readonly ExternalSource[];
  /** MG-02: an untouched copy of whatever we pulled, taken before anything reads it. */
  readonly preservationCopyTaken: boolean;
}): ExtractionReadiness {
  const covered = [...new Set(input.routes.map((r) => r.domain))];
  const missing = ALL_DOMAINS.filter((d) => !covered.includes(d));
  const verification = planVerification({ routes: input.routes, available: input.available });
  const unusable = input.routes.map(assessRoute).filter((a) => !a.usable);

  const blockers: ReadinessBlocker[] = [];
  if (missing.length > 0) blockers.push('domain_not_covered');
  if (unusable.length > 0) blockers.push('unusable_route');
  if (!verification.sound) blockers.push('no_independent_verification');
  if (!input.preservationCopyTaken) blockers.push('no_preservation_copy');

  const REASON: Readonly<Record<ReadinessBlocker, string>> = {
    domain_not_covered: `no route yet for: ${missing.join(', ')}`,
    unusable_route: `${unusable.length} routes cannot be re-run, so they cannot be trialled or redone: ${unusable.map((u) => u.domain).join(', ')}`,
    no_independent_verification: verification.detail,
    no_preservation_copy: 'no untouched copy of the extract has been taken (MG-02) — the first thing that reads it must not also be the only thing that has it',
  };

  const ready = blockers.length === 0;
  return {
    coveredDomains: covered,
    missingDomains: missing,
    blockers,
    ready,
    shopKeepsTrading: true,
    detail: ready
      ? `all ${covered.length} domains have a repeatable route and independent verification — no vendor cooperation required`
      : `not ready: ${blockers.map((b) => REASON[b]).join('; ')}`,
    ownerAction: ready
      ? 'nothing — extraction can proceed, and the old system keeps running throughout'
      : blockers.length === 1 && blockers[0] === 'no_independent_verification'
        ? 'we need the outside evidence listed above — bank statements, filed returns, supplier statements. Those are yours to obtain; none of them involves the old vendor'
        : 'nothing yet — the gaps above are ours to close first',
  };
}
