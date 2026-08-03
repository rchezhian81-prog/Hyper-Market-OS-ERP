// Finance posting — ledger mapping to double-entry journals (M23-FR-01), with GST
// posted as just another mapped component (M23-FR-02). The rule: posting is
// DETERMINISTIC from a configurable mapping (the chart of accounts — "choose-able"
// per tenant), an UNMAPPED event raises an exception and is never silently unposted
// (P-08), and finance only READS operational data and posts — it never edits the
// immutable operational ledger (§28); corrections are new journals. Every journal
// must balance (debits == credits) or it is refused. Pure and deterministic — no
// storage, no I/O. Composes only the Money primitive.

import { add, zero, equals, money, type Money, type CurrencyCode } from '../../contracts/src/money';

export type Side = 'debit' | 'credit';

/** One leg of a posting rule: which account, which side, and which amount component. */
export interface PostingLegRule {
  /** Account code/role from the chart of accounts (e.g. 'cash', 'sales_revenue'). */
  readonly account: string;
  readonly side: Side;
  /** Name of the amount component this leg posts (e.g. 'total', 'net', 'tax'). */
  readonly component: string;
}

/** The posting rule for one transaction kind. */
export interface PostingRule {
  readonly kind: string;
  readonly legs: readonly PostingLegRule[];
}

/** The chart-of-accounts mapping — one rule per transaction kind (configurable). */
export interface PostingMap {
  readonly rules: readonly PostingRule[];
}

/** A normalized financial transaction to post. */
export interface PostingInput {
  /** Source document id (sale/return/…). */
  readonly id: string;
  readonly kind: string;
  readonly at: string; // ISO-8601 UTC
  readonly currency: CurrencyCode;
  /** Amount components in minor units, keyed by name (e.g. { total, net, tax }). */
  readonly components: Readonly<Record<string, number>>;
}

export interface JournalLine {
  readonly account: string;
  readonly side: Side;
  readonly amount: Money;
}

export interface JournalEntry {
  readonly sourceId: string;
  readonly kind: string;
  readonly at: string;
  readonly lines: readonly JournalLine[];
  readonly totalDebit: Money;
  readonly totalCredit: Money;
  /** Always true for a returned entry (an unbalanced entry is refused). */
  readonly balanced: true;
}

export class UnmappedKindError extends Error {
  constructor(kind: string) {
    super(`No posting rule for kind "${kind}" — event is unmapped and must not be silently unposted (M23-FR-01).`);
    this.name = 'UnmappedKindError';
  }
}

export class MissingComponentError extends Error {
  constructor(kind: string, component: string) {
    super(`Posting "${kind}" needs amount component "${component}" but it was not supplied.`);
    this.name = 'MissingComponentError';
  }
}

export class UnbalancedJournalError extends Error {
  constructor(id: string) {
    super(`Journal for "${id}" does not balance (debits != credits) — refused.`);
    this.name = 'UnbalancedJournalError';
  }
}

/**
 * Post one operational transaction to a balanced double-entry journal using the
 * mapping. Throws `UnmappedKindError` for an unmapped kind (a visible exception,
 * never silent), `MissingComponentError` if a leg's amount was not supplied, and
 * `UnbalancedJournalError` if the mapped legs do not balance. Zero-amount legs are
 * omitted (e.g. tax on an exempt sale). Deterministic — legs post in rule order.
 */
export function postJournal(input: PostingInput, map: PostingMap): JournalEntry {
  const rule = map.rules.find((r) => r.kind === input.kind);
  if (rule === undefined) {
    throw new UnmappedKindError(input.kind);
  }

  const lines: JournalLine[] = [];
  let totalDebit = zero(input.currency);
  let totalCredit = zero(input.currency);

  for (const leg of rule.legs) {
    const value = input.components[leg.component];
    if (value === undefined) {
      throw new MissingComponentError(input.kind, leg.component);
    }
    if (value === 0) continue; // omit zero lines (e.g. exempt tax) — balance unaffected
    const amount = money(value, input.currency);
    lines.push({ account: leg.account, side: leg.side, amount });
    if (leg.side === 'debit') {
      totalDebit = add(totalDebit, amount);
    } else {
      totalCredit = add(totalCredit, amount);
    }
  }

  if (!equals(totalDebit, totalCredit)) {
    throw new UnbalancedJournalError(input.id);
  }

  return {
    sourceId: input.id,
    kind: input.kind,
    at: input.at,
    lines,
    totalDebit,
    totalCredit,
    balanced: true,
  };
}

export type PostOutcome =
  | { readonly ok: true; readonly entry: JournalEntry }
  | { readonly ok: false; readonly sourceId: string; readonly error: string };

/**
 * Post many transactions; returns the posted entries and, separately, the ones that
 * could not be posted as VISIBLE exceptions (unmapped / missing component /
 * unbalanced) — never a silent drop (P-08). The caller routes exceptions to review.
 */
export function postBatch(
  inputs: readonly PostingInput[],
  map: PostingMap,
): { readonly entries: JournalEntry[]; readonly exceptions: PostOutcome[] } {
  const entries: JournalEntry[] = [];
  const exceptions: PostOutcome[] = [];
  for (const input of inputs) {
    try {
      entries.push(postJournal(input, map));
    } catch (err) {
      exceptions.push({
        ok: false,
        sourceId: input.id,
        error: err instanceof Error ? err.name : 'UnknownError',
      });
    }
  }
  return { entries, exceptions };
}
