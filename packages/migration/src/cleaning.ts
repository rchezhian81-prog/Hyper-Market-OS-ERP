// Cleaning and exception capture — MG-04 (§34, hard rules #2, #6).
//
// The step that decides whether the new system inherits fifteen years of mess or fifteen years
// of history. They are not the same thing, and telling them apart is a judgement, not a rule.
//
// So the controlling decision here is what this module is **not** allowed to do:
//
//   • **CLEANING PROPOSES. IT NEVER DECIDES.** Every finding is a candidate with its evidence
//     attached. Nothing merges, nothing is corrected, nothing is dropped. Two products that look
//     identical are sometimes two products — a 1kg pack the shop buys from two suppliers at two
//     costs — and an auto-merge loses one of them silently at 3am with nobody watching.
//   • **A MERGE IS NOT A DELETE.** The losing record is retained, marked, and points at the
//     winner. Six months later somebody asks why a barcode scans to a different product than it
//     used to, and the answer has to exist.
//   • **EVERY FINDING IS KEPT, RESOLVED OR NOT** (hard rule #6). There is no `discardException`
//     and no `clearExceptions` in this file, asserted by test rather than promised here. An
//     exception nobody wants to deal with is exactly the one that must survive to cutover, where
//     the owner either approves carrying it or it blocks the gate.
//   • **SEVERITY IS ABOUT MONEY AND LAW, NOT TIDINESS.** A duplicate product name is untidy. A
//     negative stock quantity is a valuation error, and a tax code nobody can map is an
//     assessment. They do not belong on the same list in the same order.
//
// Pure and deterministic: no clock beyond what is passed, no I/O.

import type {
  LegacyCustomer, LegacyDataset, LegacyDocument, LegacyDocumentLine,
  LegacyProduct, LegacyStockRow, LegacySupplier,
} from './synthetic';
import type { MappingTable } from './mapping';
import { mapValue } from './mapping';

export type ExceptionKind =
  | 'duplicate_product'
  | 'shared_barcode'
  | 'negative_stock'
  | 'batch_without_expiry'
  | 'duplicate_customer'
  | 'duplicate_supplier_gstin'
  | 'document_total_mismatch'
  | 'orphan_line'
  | 'unmapped_tax_code'
  | 'pre_revision_tax_document';

/**
 * How sure the detector is — and it is a real distinction, not a hedge.
 *
 * `certain` means the records are identical on a key that cannot legitimately collide (a GSTIN,
 * a normalised phone). `probable` means they look alike on evidence a person must weigh. Mixing
 * the two produces a list nobody trusts and therefore nobody works through.
 */
export type Confidence = 'certain' | 'probable';

/** Money and law first. This ordering is the working queue, so it has to be right. */
export type Severity = 'blocking' | 'high' | 'medium' | 'low';

export interface MigrationException {
  readonly exceptionId: string;
  readonly tenantId: string;
  readonly kind: ExceptionKind;
  readonly severity: Severity;
  readonly confidence: Confidence;
  /** The legacy records involved — the losing candidate first where there is one. */
  readonly legacyIds: readonly string[];
  /** What was observed, in words a person can check against the old system. */
  readonly evidence: string;
  /** The money at stake, where there is any. Absent is different from zero. */
  readonly valueMinor?: number;
  readonly resolution?: ExceptionResolution;
}

export type ResolutionAction = 'merge' | 'correct' | 'exclude' | 'migrate_as_is';

export interface ExceptionResolution {
  readonly action: ResolutionAction;
  readonly decidedBy: string;
  readonly decidedAt: string;
  readonly reason: string;
  /** For a merge: the record that survives. The other is retained, pointing here. */
  readonly survivingLegacyId?: string;
}

export interface CleaningReport {
  readonly tenantId: string;
  readonly exceptions: readonly MigrationException[];
  readonly byKind: Readonly<Record<string, number>>;
  readonly bySeverity: Readonly<Record<Severity, number>>;
  /** Nothing here has been changed. Stated as a value so a caller cannot assume otherwise. */
  readonly nothingWasModified: true;
  readonly detail: string;
}

const SEVERITY: Readonly<Record<ExceptionKind, Severity>> = {
  // An unmapped tax code becomes a zero rating the moment anybody defaults it.
  unmapped_tax_code: 'blocking',
  // Negative stock is a valuation error that carries straight into opening balances.
  negative_stock: 'blocking',
  // Two products behind one barcode means the till rings up the wrong one.
  shared_barcode: 'high',
  document_total_mismatch: 'high',
  pre_revision_tax_document: 'high',
  duplicate_supplier_gstin: 'high',
  orphan_line: 'medium',
  duplicate_customer: 'medium',
  batch_without_expiry: 'medium',
  duplicate_product: 'low',
};

/** Trim, collapse whitespace, lowercase. Enough to catch a trailing space and a shouted name. */
const normaliseName = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase();

/** Last ten digits. "+91 90000 00001", "09000000001" and "9000000001" are one person. */
const normalisePhone = (s: string): string => s.replace(/\D/g, '').slice(-10);

const tokens = (s: string): readonly string[] => normaliseName(s).split(' ').filter((t) => t !== '');

/** Is `b` `a` plus extra words? "Rice 1kg New" over "Rice 1kg" — a rename, not a new product. */
function isTokenSuperset(a: string, b: string): boolean {
  const ta = tokens(a);
  const tb = tokens(b);
  if (tb.length <= ta.length) return false;
  return ta.every((t) => tb.includes(t));
}

/**
 * Find everything wrong with the legacy data, and change none of it.
 *
 * Runs every detector over the whole dataset in one pass so the report is a single consistent
 * picture. A cleaning tool that is run detector-by-detector produces findings from four
 * different afternoons and a total nobody can reconcile.
 */
export function detectExceptions(input: {
  readonly tenantId: string;
  readonly dataset: LegacyDataset;
  /** Approved mappings (MG-03). Without it, tax codes cannot be judged and are not guessed. */
  readonly mappingTable?: MappingTable;
  /** Documents before this date carry tax struck under a superseded rate table. */
  readonly rateRevisionDate?: string;
  readonly idPrefix?: string;
}): CleaningReport {
  const d = input.dataset;
  const prefix = input.idPrefix ?? 'EXC';
  const exceptions: MigrationException[] = [];
  let n = 0;

  const add = (
    kind: ExceptionKind,
    confidence: Confidence,
    legacyIds: readonly string[],
    evidence: string,
    valueMinor?: number,
  ): void => {
    n += 1;
    exceptions.push({
      exceptionId: `${prefix}-${String(n).padStart(5, '0')}`,
      tenantId: input.tenantId,
      kind,
      severity: SEVERITY[kind],
      confidence,
      legacyIds,
      evidence,
      ...(valueMinor === undefined ? {} : { valueMinor }),
    });
  };

  // ── products: duplicates, shared barcodes, unmappable tax ───────────────────
  // Name AND department. An identical name alone is not certainty in a hypermarket with a
  // cafe: the same line can legitimately exist as a grocery product and as a kitchen
  // ingredient, on different costs and different tax treatment. Same name in the same
  // department is as close to an identity match as legacy data offers; same name across
  // departments is a question for a person.
  const byNameAndDept = new Map<string, LegacyProduct[]>();
  const byNameOnly = new Map<string, LegacyProduct[]>();
  for (const p of d.products) {
    const n = normaliseName(p.name);
    byNameAndDept.set(`${n}|${p.departmentCode}`, [...(byNameAndDept.get(`${n}|${p.departmentCode}`) ?? []), p]);
    byNameOnly.set(n, [...(byNameOnly.get(n) ?? []), p]);
  }
  const alreadyPaired = new Set<string>();

  for (const [, group] of byNameAndDept) {
    if (group.length < 2) continue;
    const [keep, ...rest] = group;
    for (const dup of rest) {
      alreadyPaired.add(dup!.legacyId);
      add('duplicate_product', 'certain', [dup!.legacyId, keep!.legacyId],
        `"${dup!.name}" and "${keep!.name}" are the same name in department ${keep!.departmentCode} once case and spacing are normalised`);
    }
  }

  for (const [, group] of byNameOnly) {
    if (group.length < 2) continue;
    const departments = new Set(group.map((p) => p.departmentCode));
    if (departments.size < 2) continue;
    const sorted = [...group].sort((x, y) => (x.legacyId < y.legacyId ? -1 : 1));
    for (const p of sorted.slice(1)) {
      if (alreadyPaired.has(p.legacyId)) continue;
      alreadyPaired.add(p.legacyId);
      add('duplicate_product', 'probable', [p.legacyId, sorted[0]!.legacyId],
        `"${p.name}" appears in ${[...departments].sort().join(' and ')} — the same line can legitimately be a grocery product and a kitchen ingredient, so a person must decide`);
    }
  }

  // The rename case: a name that is the old name plus words, on identical cost, price and
  // department. Reported as PROBABLE, because sometimes it really is a different pack.
  for (const a of d.products) {
    for (const b of d.products) {
      if (a.legacyId === b.legacyId) continue;
      if (alreadyPaired.has(b.legacyId)) continue;
      if (!isTokenSuperset(a.name, b.name)) continue;
      if (a.costMinor !== b.costMinor || a.priceMinor !== b.priceMinor) continue;
      if (a.departmentCode !== b.departmentCode) continue;
      alreadyPaired.add(b.legacyId);
      add('duplicate_product', 'probable', [b.legacyId, a.legacyId],
        `"${b.name}" reads as "${a.name}" renamed — identical cost, price and department, but a person must confirm it is not a different pack`);
    }
  }

  const byBarcode = new Map<string, LegacyProduct[]>();
  for (const p of d.products) {
    if (p.barcode === undefined) continue;
    byBarcode.set(p.barcode, [...(byBarcode.get(p.barcode) ?? []), p]);
  }
  for (const [barcode, group] of byBarcode) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((x, y) => (x.legacyId < y.legacyId ? -1 : 1));
    // Every product beyond the first holder is a collision to resolve.
    for (const p of sorted.slice(1)) {
      add('shared_barcode', 'certain', [p.legacyId, sorted[0]!.legacyId],
        `barcode ${barcode} is on ${group.length} products — the till would ring up whichever the system finds first`);
    }
  }

  if (input.mappingTable !== undefined) {
    const table = input.mappingTable;
    for (const p of d.products) {
      if (!mapValue({ table, domain: 'tax_code', legacyValue: p.taxCode }).mapped) {
        add('unmapped_tax_code', 'certain', [p.legacyId],
          `tax code "${p.taxCode}" on "${p.name}" has no approved mapping — defaulting it would zero-rate the product`);
      }
    }
  }

  // ── stock: negative quantities, batches without expiry ──────────────────────
  for (const s of d.stock) {
    const key = `${s.legacyProductId}@${s.locationCode}`;
    if (s.qty < 0) {
      add('negative_stock', 'certain', [key],
        `${s.qty} units at ${s.locationCode} — goods were sold whose receipt was never entered; carrying it forward carries the valuation error too`,
        s.valueMinor);
    }
    if (s.batchCode !== undefined && s.expiryDate === undefined) {
      add('batch_without_expiry', 'certain', [key],
        `batch ${s.batchCode} has no expiry date — FEFO cannot order a batch it cannot date`);
    }
  }

  // ── customers: the same person, twice ───────────────────────────────────────
  const byPhone = new Map<string, LegacyCustomer[]>();
  for (const c of d.customers) {
    const k = normalisePhone(c.phone);
    if (k.length < 10) continue;
    byPhone.set(k, [...(byPhone.get(k) ?? []), c]);
  }
  for (const [phone, group] of byPhone) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((x, y) => (x.legacyId < y.legacyId ? -1 : 1));
    const points = group.reduce((t, c) => t + c.loyaltyPoints, 0);
    for (const c of sorted.slice(1)) {
      add('duplicate_customer', 'certain', [c.legacyId, sorted[0]!.legacyId],
        `phone ${phone} is on ${group.length} customer records holding ${points} points between them — merging is the only way the customer sees their own balance`);
    }
  }

  // ── suppliers: one firm, three names ────────────────────────────────────────
  const byGstin = new Map<string, LegacySupplier[]>();
  for (const s of d.suppliers) {
    if (s.gstin === undefined) continue;
    byGstin.set(s.gstin, [...(byGstin.get(s.gstin) ?? []), s]);
  }
  for (const [gstin, group] of byGstin) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((x, y) => (x.legacyId < y.legacyId ? -1 : 1));
    const owed = group.reduce((t, s) => t + s.outstandingMinor, 0);
    for (const s of sorted.slice(1)) {
      add('duplicate_supplier_gstin', 'certain', [s.legacyId, sorted[0]!.legacyId],
        `GSTIN ${gstin} appears under ${group.length} supplier names owing ${owed} in total — one firm, and the payable is understated on each record`,
        s.outstandingMinor);
    }
  }

  // ── documents: totals that do not add up, orphans, superseded tax ───────────
  const lineSums = new Map<string, { net: number; tax: number }>();
  for (const l of d.lines) {
    const acc = lineSums.get(l.legacyDocumentId) ?? { net: 0, tax: 0 };
    lineSums.set(l.legacyDocumentId, { net: acc.net + l.lineTotalMinor, tax: acc.tax + l.taxMinor });
  }

  for (const doc of d.documents) {
    const sum = lineSums.get(doc.legacyId);
    if (sum !== undefined) {
      const expected = sum.net + sum.tax;
      if (expected !== doc.totalMinor) {
        add('document_total_mismatch', 'certain', [doc.legacyId],
          `header total ${doc.totalMinor} against lines summing to ${expected} — a difference of ${doc.totalMinor - expected}; whichever is loaded, one of the two figures in the old system was wrong`,
          Math.abs(doc.totalMinor - expected));
      }
    }
    if (input.rateRevisionDate !== undefined && doc.documentDate < input.rateRevisionDate) {
      add('pre_revision_tax_document', 'certain', [doc.legacyId],
        `dated ${doc.documentDate}, before the rate revision on ${input.rateRevisionDate} — its tax was correct when struck and does not match today's rate table; restating it rewrites a filed return`,
        doc.taxMinor);
    }
  }

  const documentIds = new Set(d.documents.map((x) => x.legacyId));
  for (const l of d.lines) {
    if (!documentIds.has(l.legacyDocumentId)) {
      add('orphan_line', 'certain', [l.legacyLineId],
        `line ${l.legacyLineId} refers to document ${l.legacyDocumentId}, which does not exist — the header was deleted and the line was not`,
        l.lineTotalMinor + l.taxMinor);
    }
  }

  return summariseCleaning({ tenantId: input.tenantId, exceptions });
}

/** Re-summarise a set of exceptions — used after resolutions are recorded. */
export function summariseCleaning(input: {
  readonly tenantId: string;
  readonly exceptions: readonly MigrationException[];
}): CleaningReport {
  const byKind: Record<string, number> = {};
  const bySeverity: Record<Severity, number> = { blocking: 0, high: 0, medium: 0, low: 0 };
  for (const e of input.exceptions) {
    byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
    bySeverity[e.severity] += 1;
  }

  const unresolvedBlocking = input.exceptions.filter(
    (e) => e.severity === 'blocking' && e.resolution === undefined,
  ).length;

  return {
    tenantId: input.tenantId,
    exceptions: input.exceptions,
    byKind,
    bySeverity,
    nothingWasModified: true,
    detail: input.exceptions.length === 0
      ? 'no exceptions found — every record maps, balances and stands on its own'
      : `${input.exceptions.length} exceptions found and kept, ${unresolvedBlocking} blocking and unresolved; none of the legacy data was changed`,
  };
}

export type ResolveRefusal =
  | 'unknown_exception'
  | 'already_resolved'
  | 'no_decider'
  | 'no_reason'
  | 'merge_without_survivor'
  | 'survivor_not_involved';

export interface ResolveResult {
  readonly ok: boolean;
  readonly exceptions: readonly MigrationException[];
  readonly refusedBecause?: ResolveRefusal;
  readonly detail: string;
}

/**
 * Record a human decision against an exception.
 *
 * The exception is **updated, never removed** (hard rule #6) — the list only ever grows, and a
 * resolved exception is the evidence that somebody looked at it. `exclude` in particular has to
 * remain visible: it is the decision most likely to be questioned, and the one whose reason is
 * hardest to reconstruct a year later.
 */
export function resolveException(input: {
  readonly exceptions: readonly MigrationException[];
  readonly exceptionId: string;
  readonly resolution: ExceptionResolution;
}): ResolveResult {
  const target = input.exceptions.find((e) => e.exceptionId === input.exceptionId);
  const unchanged = { ok: false as const, exceptions: input.exceptions };

  if (target === undefined) {
    return { ...unchanged, refusedBecause: 'unknown_exception', detail: `no exception ${input.exceptionId}` };
  }
  if (target.resolution !== undefined) {
    return {
      ...unchanged, refusedBecause: 'already_resolved',
      detail: `${input.exceptionId} was resolved by ${target.resolution.decidedBy} — a second decision would overwrite the first, and the first is the evidence`,
    };
  }
  const r = input.resolution;
  if (r.decidedBy.trim() === '') {
    return { ...unchanged, refusedBecause: 'no_decider', detail: 'a resolution with nobody\'s name on it is not a decision' };
  }
  if (r.reason.trim() === '') {
    return { ...unchanged, refusedBecause: 'no_reason', detail: 'the reason is the only part of this record anybody reads a year later' };
  }
  if (r.action === 'merge') {
    if (r.survivingLegacyId === undefined) {
      return { ...unchanged, refusedBecause: 'merge_without_survivor', detail: 'a merge must name which record survives — otherwise the losing one is simply gone' };
    }
    if (!target.legacyIds.includes(r.survivingLegacyId)) {
      return {
        ...unchanged, refusedBecause: 'survivor_not_involved',
        detail: `${r.survivingLegacyId} is not one of the records in ${input.exceptionId} (${target.legacyIds.join(', ')})`,
      };
    }
  }

  return {
    ok: true,
    exceptions: input.exceptions.map((e) => (e.exceptionId === input.exceptionId ? { ...e, resolution: r } : e)),
    detail: `${input.exceptionId} resolved as ${r.action} by ${r.decidedBy}`,
  };
}

export interface MergeRecord {
  readonly survivingLegacyId: string;
  /** Retained, not deleted — a barcode that now scans elsewhere needs an answer. */
  readonly retiredLegacyId: string;
  readonly exceptionId: string;
  readonly decidedBy: string;
  readonly decidedAt: string;
  readonly reason: string;
}

/**
 * The merge map produced by resolved exceptions.
 *
 * Every retired record keeps a row pointing at its survivor. **This is not a delete list** — it
 * is a redirection table, and the load uses it to rewrite references while both ids stay
 * resolvable forever.
 */
export function buildMergeMap(exceptions: readonly MigrationException[]): readonly MergeRecord[] {
  const merges: MergeRecord[] = [];
  for (const e of exceptions) {
    const r = e.resolution;
    if (r === undefined || r.action !== 'merge' || r.survivingLegacyId === undefined) continue;
    for (const id of e.legacyIds) {
      if (id === r.survivingLegacyId) continue;
      merges.push({
        survivingLegacyId: r.survivingLegacyId,
        retiredLegacyId: id,
        exceptionId: e.exceptionId,
        decidedBy: r.decidedBy,
        decidedAt: r.decidedAt,
        reason: r.reason,
      });
    }
  }
  return merges;
}

export interface OutstandingExceptions {
  readonly total: number;
  readonly unresolved: readonly MigrationException[];
  /** Blocking severity with no decision. These stop the cutover gate, by design. */
  readonly blockingUnresolved: readonly MigrationException[];
  readonly valueAtStakeMinor: number;
  readonly clearForCutover: boolean;
  readonly detail: string;
}

/**
 * What still stands between the data and a cutover.
 *
 * A blocking exception is cleared by a **decision**, including a decision to migrate it as it
 * is — what is not permitted is for it to be unexamined. The owner may knowingly accept a
 * valuation error; nobody may accidentally inherit one.
 */
export function outstandingExceptions(exceptions: readonly MigrationException[]): OutstandingExceptions {
  const unresolved = exceptions.filter((e) => e.resolution === undefined);
  const blockingUnresolved = unresolved.filter((e) => e.severity === 'blocking');
  const valueAtStakeMinor = unresolved.reduce((t, e) => t + (e.valueMinor ?? 0), 0);
  const clearForCutover = blockingUnresolved.length === 0;

  return {
    total: exceptions.length,
    unresolved,
    blockingUnresolved,
    valueAtStakeMinor,
    clearForCutover,
    detail: clearForCutover
      ? `${unresolved.length} exceptions still open, none blocking — every valuation and tax exception has a named decision behind it`
      : `${blockingUnresolved.length} blocking exceptions have no decision — the owner may accept any of them knowingly, but none may be inherited by accident`,
  };
}

export type { LegacyDataset, LegacyProduct, LegacyStockRow, LegacyCustomer, LegacySupplier, LegacyDocument, LegacyDocumentLine };
