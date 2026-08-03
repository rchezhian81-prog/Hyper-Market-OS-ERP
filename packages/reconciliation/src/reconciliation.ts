// Payment reconciliation (M23-FR-03) — match provider settlement/statement lines
// against POS electronic tenders and refunds, so every tender is independently
// reconcilable (§6.2) and any mismatch becomes an OWNED, VALUED exception rather
// than a silent loss (P-08). Matching is on the provider reference/token and the
// amount — NEVER a card PAN (hard rule #3): a reference that looks like a raw card
// number is refused outright. Pure and deterministic — the caller supplies the
// already-synced POS tenders and the imported statement lines. Cash is reconciled
// at the till close (packages/till); this is the electronic-settlement counterpart.

export interface PosTender {
  /** POS tender id. */
  readonly id: string;
  /** Provider reference / token — the reconciliation key (never a card PAN). */
  readonly ref: string;
  readonly amountMinor: number;
}

export interface SettlementLine {
  /** Statement/settlement line id. */
  readonly id: string;
  readonly ref: string;
  readonly amountMinor: number;
}

export interface ReconMatch {
  readonly tenderId: string;
  readonly settlementId: string;
  readonly ref: string;
  readonly amountMinor: number;
}

export type ReconExceptionKind =
  | 'unsettled_tender' // in POS, no matching settlement — money not received
  | 'unknown_settlement' // settled, but no POS tender — unexpected credit
  | 'amount_mismatch' // same ref, different amount — short/over settlement
  | 'duplicate_ref'; // the same ref appears twice on one side — ambiguous

export interface ReconException {
  readonly kind: ReconExceptionKind;
  readonly ref: string;
  readonly tenderId?: string;
  readonly settlementId?: string;
  /** POS amount (for mismatch). */
  readonly expectedMinor?: number;
  /** Settled amount (for mismatch). */
  readonly actualMinor?: number;
  /** actual − expected (for mismatch); the value of the exception. */
  readonly varianceMinor?: number;
}

export interface ReconResult {
  readonly matched: readonly ReconMatch[];
  readonly exceptions: readonly ReconException[];
  readonly matchedCount: number;
  readonly exceptionCount: number;
}

export class CardDataError extends Error {
  constructor() {
    super('A reconciliation reference must be a provider token/reference, never a card number (hard rule #3).');
    this.name = 'CardDataError';
  }
}

// A bare 13–19 digit string is treated as a possible card PAN and refused.
const PAN_LIKE = /^\d{13,19}$/;

function assertNotPan(ref: string): void {
  if (PAN_LIKE.test(ref.replace(/[\s-]/g, ''))) {
    throw new CardDataError();
  }
}

/** Index a side by ref, recording duplicates as ambiguous. */
function indexByRef<T extends { ref: string }>(
  rows: readonly T[],
): { byRef: Map<string, T>; duplicates: Set<string> } {
  const byRef = new Map<string, T>();
  const duplicates = new Set<string>();
  for (const row of rows) {
    assertNotPan(row.ref);
    if (byRef.has(row.ref)) {
      duplicates.add(row.ref);
    } else {
      byRef.set(row.ref, row);
    }
  }
  return { byRef, duplicates };
}

/**
 * Reconcile POS tenders against settlement lines. Returns the matched pairs and a
 * list of valued exceptions: unsettled tenders, unknown settlements, amount
 * mismatches (with the variance) and ambiguous duplicate references. Deterministic:
 * exceptions are ordered tenders-first (by tender id), then settlement-only (by
 * settlement id). Refuses any reference that looks like a raw card number.
 */
export function reconcile(
  tenders: readonly PosTender[],
  settlements: readonly SettlementLine[],
): ReconResult {
  const t = indexByRef(tenders);
  const s = indexByRef(settlements);

  const matched: ReconMatch[] = [];
  const exceptions: ReconException[] = [];
  const seenDuplicateRefs = new Set<string>();

  const flagDuplicate = (ref: string): void => {
    if (!seenDuplicateRefs.has(ref)) {
      seenDuplicateRefs.add(ref);
      exceptions.push({ kind: 'duplicate_ref', ref });
    }
  };

  // Walk tenders in id order for deterministic output.
  const tenderRows = [...tenders].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const tender of tenderRows) {
    if (t.duplicates.has(tender.ref) || s.duplicates.has(tender.ref)) {
      flagDuplicate(tender.ref);
      continue;
    }
    const settlement = s.byRef.get(tender.ref);
    if (settlement === undefined) {
      exceptions.push({ kind: 'unsettled_tender', ref: tender.ref, tenderId: tender.id });
      continue;
    }
    if (settlement.amountMinor === tender.amountMinor) {
      matched.push({
        tenderId: tender.id,
        settlementId: settlement.id,
        ref: tender.ref,
        amountMinor: tender.amountMinor,
      });
    } else {
      exceptions.push({
        kind: 'amount_mismatch',
        ref: tender.ref,
        tenderId: tender.id,
        settlementId: settlement.id,
        expectedMinor: tender.amountMinor,
        actualMinor: settlement.amountMinor,
        varianceMinor: settlement.amountMinor - tender.amountMinor,
      });
    }
  }

  // Settlements with no POS tender — unexpected credits.
  const settlementRows = [...settlements].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const settlement of settlementRows) {
    if (s.duplicates.has(settlement.ref) || t.duplicates.has(settlement.ref)) {
      flagDuplicate(settlement.ref);
      continue;
    }
    if (!t.byRef.has(settlement.ref)) {
      exceptions.push({
        kind: 'unknown_settlement',
        ref: settlement.ref,
        settlementId: settlement.id,
      });
    }
  }

  return {
    matched,
    exceptions,
    matchedCount: matched.length,
    exceptionCount: exceptions.length,
  };
}
