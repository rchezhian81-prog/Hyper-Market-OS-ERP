// Control totals, sign-off and opening state — MG-06, MG-08 (§34, QG-07, hard rule #2).
//
// The gate. **No cutover without signed control totals**, and the word doing the work is
// *signed*: a total that balances is a fact, and a total somebody put their name to is a
// decision. QG-07 requires the second.
//
// One failure mode is worth more than all the others here, because it is invisible and it is
// common:
//
//   • **A TOTAL THAT RECONCILES BECAUSE BOTH SIDES WERE COMPUTED THE SAME WAY RECONCILES
//     NOTHING.** If the "legacy" stock value is read out of the loaded table and the "new" stock
//     value is read out of the same loaded table, the report is green, the CA signs it, and it
//     proves only that addition is commutative. Each total here names **where each side came
//     from**, and `recordControlTotal` refuses when the two derivations are identical. It is the
//     only check in this file that catches a mistake nobody would ever notice.
//
// The rest follows from that:
//
//   • **A DIFFERENCE IS EXPLAINED AND VALUED, OR IT IS OPEN.** *"Small variance"* is not an
//     explanation. Approved exclusions (MG-07) are the legitimate reason a total differs, and
//     they arrive as a figure that must account for the difference exactly.
//   • **THE PERSON WHO RAN THE LOAD DOES NOT SIGN THE TOTALS** (§28, separation of duties). Not
//     because they would lie — because they already believe it worked, which is the whole
//     reason a second pair of eyes exists.
//   • **FINANCE AND TAX ARE SIGNED BY THE CA** (M23 / C-01). A store manager cannot sign a tax
//     total, however senior, and the system says so rather than relying on everybody remembering.
//   • **OPENING BALANCES ARE EVENTS** (hard rule #2). MG-08 emits opening events into the
//     append-only ledger; it never writes a balance. A migration that sets balances directly
//     creates the one class of number in the system with no history behind it.
//
// Pure and deterministic: the clock is injected, no I/O.

export type TotalKind = 'migration' | 'stock' | 'financial' | 'tax' | 'loyalty';

/** What the figure is: a count of rows, a quantity of goods, or money in minor units. */
export type TotalUnit = 'rows' | 'quantity' | 'minor_currency' | 'points';

export interface ControlTotal {
  readonly totalId: string;
  readonly tenantId: string;
  readonly kind: TotalKind;
  readonly name: string;
  readonly unit: TotalUnit;
  readonly legacyValue: number;
  readonly loadedValue: number;
  /** How the legacy side was derived. Compared against the other, in words. */
  readonly legacyDerivation: string;
  readonly loadedDerivation: string;
  /** Difference the approved exclusions account for (MG-07). */
  readonly approvedExclusionValue?: number;
  readonly explanation?: string;
  readonly signature?: TotalSignature;
}

export interface TotalSignature {
  readonly signedBy: string;
  readonly signerRole: string;
  readonly signedAt: string;
  readonly statement: string;
}

export type TotalRefusal =
  | 'same_derivation_both_sides'
  | 'no_derivation'
  | 'duplicate_total';

export interface RecordTotalResult {
  readonly ok: boolean;
  readonly totals: readonly ControlTotal[];
  readonly refusedBecause?: TotalRefusal;
  readonly detail: string;
}

/** Normalised comparison, so "SUM(qty) from legacy stock" and "sum(QTY) FROM legacy stock" match. */
const derivationKey = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Record a control total, refusing the one that would pass while proving nothing.
 *
 * The independence check is the reason this function exists at all. Everything else it does
 * could be a plain object literal.
 */
export function recordControlTotal(input: {
  readonly totals: readonly ControlTotal[];
  readonly total: ControlTotal;
}): RecordTotalResult {
  const t = input.total;
  const unchanged = { ok: false as const, totals: input.totals };

  if (t.legacyDerivation.trim() === '' || t.loadedDerivation.trim() === '') {
    return {
      ...unchanged, refusedBecause: 'no_derivation',
      detail: 'both sides of a control total must say where they came from — otherwise nobody can tell an independent check from a self-comparison',
    };
  }
  if (derivationKey(t.legacyDerivation) === derivationKey(t.loadedDerivation)) {
    return {
      ...unchanged, refusedBecause: 'same_derivation_both_sides',
      detail: `both sides derive from "${t.legacyDerivation}" — a total computed the same way twice reconciles nothing, and it is the one mistake in a migration that nobody notices because the report is green`,
    };
  }
  if (input.totals.some((x) => x.totalId === t.totalId)) {
    return { ...unchanged, refusedBecause: 'duplicate_total', detail: `${t.totalId} already recorded — a re-run supersedes with a new id, so the earlier figure stays readable` };
  }

  return { ok: true, totals: [...input.totals, t], detail: `${t.name} recorded: legacy ${t.legacyValue} against loaded ${t.loadedValue}` };
}

export type TotalStatus = 'reconciled' | 'explained' | 'open';

export interface TotalAssessment {
  readonly totalId: string;
  readonly kind: TotalKind;
  readonly name: string;
  readonly unit: TotalUnit;
  readonly difference: number;
  readonly status: TotalStatus;
  readonly signed: boolean;
  readonly detail: string;
}

export interface ReconciliationReport {
  readonly tenantId: string;
  readonly assessments: readonly TotalAssessment[];
  readonly open: readonly TotalAssessment[];
  readonly unsigned: readonly TotalAssessment[];
  /** QG-07: the cutover gate. Every total reconciled or explained, AND every one signed. */
  readonly qg07Passed: boolean;
  readonly detail: string;
}

/**
 * Assess every total, and decide QG-07.
 *
 * `explained` is a genuine third state, not a softer `reconciled`. A stock value that differs by
 * exactly the approved exclusions is correct; one that differs by *roughly* that is open. The
 * arithmetic has to close to the rupee, because an unexplained remainder is where a real error
 * hides behind an approved one.
 */
export function assessReconciliation(input: {
  readonly tenantId: string;
  readonly totals: readonly ControlTotal[];
}): ReconciliationReport {
  const assessments: TotalAssessment[] = input.totals.map((t) => {
    const difference = t.loadedValue - t.legacyValue;
    const excluded = t.approvedExclusionValue ?? 0;
    const remainder = difference + excluded;
    const signed = t.signature !== undefined;

    const status: TotalStatus =
      difference === 0 ? 'reconciled'
        : remainder === 0 && (t.explanation ?? '').trim() !== '' ? 'explained'
          : 'open';

    const detail =
      status === 'reconciled' ? `${t.name} matches exactly (${t.legacyValue})`
        : status === 'explained' ? `${t.name} differs by ${difference}, accounted for exactly by approved exclusions of ${excluded}: ${t.explanation}`
          : excluded !== 0 || (t.explanation ?? '').trim() !== ''
            ? `${t.name} differs by ${difference}; the explanation accounts for ${-excluded}, leaving ${remainder} unaccounted — an unexplained remainder is where a real error hides behind an approved one`
            : `${t.name} differs by ${difference} with no explanation — "small variance" is not an explanation`;

    return { totalId: t.totalId, kind: t.kind, name: t.name, unit: t.unit, difference, status, signed, detail };
  });

  const open = assessments.filter((a) => a.status === 'open');
  const unsigned = assessments.filter((a) => !a.signed);
  const qg07Passed = input.totals.length > 0 && open.length === 0 && unsigned.length === 0;

  return {
    tenantId: input.tenantId,
    assessments,
    open,
    unsigned,
    qg07Passed,
    detail: input.totals.length === 0
      ? 'no control totals recorded — QG-07 cannot pass on an empty report, and an empty report is the easiest one to produce'
      : qg07Passed
        ? `all ${assessments.length} control totals reconciled or explained, and every one signed — QG-07 passed`
        : `${open.length} totals open and ${unsigned.length} unsigned — the cutover is blocked until both are zero`,
  };
}

export type SignRefusal =
  | 'unknown_total'
  | 'already_signed'
  | 'signer_ran_the_load'
  | 'finance_or_tax_needs_ca'
  | 'total_is_open';

export interface SignResult {
  readonly ok: boolean;
  readonly totals: readonly ControlTotal[];
  readonly refusedBecause?: SignRefusal;
  readonly detail: string;
}

/** Finance and tax totals are the CA's to sign (M23 / C-01). Nobody else, however senior. */
const CA_ONLY: readonly TotalKind[] = ['financial', 'tax'];

/**
 * Sign a control total.
 *
 * Refuses an **open** total outright. That is the point most likely to be argued about on the
 * night — the difference is small, the evening is late, and signing it "provisionally" is the
 * obvious compromise. There is no provisional signature here, because QG-07 is the last place a
 * wrong opening balance can still be stopped.
 */
export function signControlTotal(input: {
  readonly totals: readonly ControlTotal[];
  readonly totalId: string;
  readonly signedBy: string;
  readonly signerRole: string;
  /** Who ran the load. A signer who is also the loader is checking their own work. */
  readonly loadOperator: string;
  readonly statement: string;
  readonly now: string;
}): SignResult {
  const target = input.totals.find((t) => t.totalId === input.totalId);
  const unchanged = { ok: false as const, totals: input.totals };

  if (target === undefined) return { ...unchanged, refusedBecause: 'unknown_total', detail: `no control total ${input.totalId}` };
  if (target.signature !== undefined) {
    return { ...unchanged, refusedBecause: 'already_signed', detail: `${input.totalId} was signed by ${target.signature.signedBy} — a second signature would replace the first, and the first is the evidence` };
  }
  if (input.signedBy === input.loadOperator) {
    return {
      ...unchanged, refusedBecause: 'signer_ran_the_load',
      detail: `${input.signedBy} ran the load and cannot sign its totals (§28) — not because they would lie, but because they already believe it worked, which is the whole reason a second pair of eyes exists`,
    };
  }
  if (CA_ONLY.includes(target.kind) && input.signerRole !== 'chartered_accountant') {
    return {
      ...unchanged, refusedBecause: 'finance_or_tax_needs_ca',
      detail: `${target.kind} totals are signed by the chartered accountant (M23 / C-01) — ${input.signerRole} cannot sign one, however senior`,
    };
  }

  const assessment = assessReconciliation({ tenantId: target.tenantId, totals: [target] }).assessments[0]!;
  if (assessment.status === 'open') {
    return {
      ...unchanged, refusedBecause: 'total_is_open',
      detail: `${target.name} is open: ${assessment.detail}. There is no provisional signature — this is the last place a wrong opening balance can still be stopped`,
    };
  }

  const signature: TotalSignature = {
    signedBy: input.signedBy, signerRole: input.signerRole, signedAt: input.now, statement: input.statement,
  };
  return {
    ok: true,
    totals: input.totals.map((t) => (t.totalId === input.totalId ? { ...t, signature } : t)),
    detail: `${target.name} signed by ${input.signedBy} (${input.signerRole})`,
  };
}

// ── MG-08 opening state ───────────────────────────────────────────────────────

export type OpeningKind = 'stock' | 'customer_outstanding' | 'supplier_outstanding' | 'loyalty_points' | 'open_order';

export interface OpeningEvent {
  readonly eventId: string;
  readonly tenantId: string;
  readonly kind: OpeningKind;
  readonly subjectId: string;
  readonly quantity?: number;
  readonly valueMinor?: number;
  readonly points?: number;
  /** Which signed control total this event's figure came out of. Traceable both ways. */
  readonly fromTotalId: string;
  readonly occurredAt: string;
  /** Named as an event, never as a balance — hard rule #2. */
  readonly appendOnly: true;
}

export type OpeningRefusal = 'qg07_not_passed' | 'no_events' | 'unsigned_source_total';

export interface OpeningResult {
  readonly ok: boolean;
  readonly events: readonly OpeningEvent[];
  readonly refusedBecause?: OpeningRefusal;
  readonly detail: string;
}

/**
 * Turn signed control totals into opening events.
 *
 * **Never a balance.** The migration is the only moment in the system's life when writing a
 * balance directly would be defensible — the figures are known, the ledger is empty, and one
 * `UPDATE` would do it. Which is exactly why it must not: an opening quantity with no event
 * behind it is the one number in the shop that can never be explained, and it sits underneath
 * every count and every valuation from then on.
 *
 * Refused unless QG-07 has passed, because an opening event cannot be withdrawn once it is
 * banked (hard rule #2) — the correction is a compensating event, and a compensating event on
 * day one is a permanent scar on the ledger.
 */
export function buildOpeningEvents(input: {
  readonly tenantId: string;
  readonly totals: readonly ControlTotal[];
  readonly positions: readonly {
    readonly kind: OpeningKind;
    readonly subjectId: string;
    readonly quantity?: number;
    readonly valueMinor?: number;
    readonly points?: number;
    readonly fromTotalId: string;
  }[];
  readonly now: string;
  readonly idPrefix?: string;
}): OpeningResult {
  const report = assessReconciliation({ tenantId: input.tenantId, totals: input.totals });
  if (!report.qg07Passed) {
    return {
      ok: false, events: [], refusedBecause: 'qg07_not_passed',
      detail: `QG-07 has not passed — ${report.detail}. An opening event cannot be withdrawn once banked, and a compensating event on day one is a permanent scar on the ledger`,
    };
  }
  if (input.positions.length === 0) {
    return { ok: false, events: [], refusedBecause: 'no_events', detail: 'no opening positions supplied — an empty opening state is a silent one' };
  }

  const signedIds = new Set(input.totals.filter((t) => t.signature !== undefined).map((t) => t.totalId));
  const orphan = input.positions.filter((p) => !signedIds.has(p.fromTotalId));
  if (orphan.length > 0) {
    return {
      ok: false, events: [], refusedBecause: 'unsigned_source_total',
      detail: `${orphan.length} opening positions cite a total that is not signed (${[...new Set(orphan.map((p) => p.fromTotalId))].sort().join(', ')}) — every opening figure traces to a signature or it does not go in`,
    };
  }

  const prefix = input.idPrefix ?? 'OPEN';
  const events: OpeningEvent[] = input.positions.map((p, i) => ({
    eventId: `${prefix}-${String(i + 1).padStart(6, '0')}`,
    tenantId: input.tenantId,
    kind: p.kind,
    subjectId: p.subjectId,
    ...(p.quantity === undefined ? {} : { quantity: p.quantity }),
    ...(p.valueMinor === undefined ? {} : { valueMinor: p.valueMinor }),
    ...(p.points === undefined ? {} : { points: p.points }),
    fromTotalId: p.fromTotalId,
    occurredAt: input.now,
    appendOnly: true,
  }));

  return {
    ok: true,
    events,
    detail: `${events.length} opening events built from signed totals — every one an event with a signature behind it, and not a single balance written directly`,
  };
}
