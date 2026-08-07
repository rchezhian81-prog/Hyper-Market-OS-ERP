// Building the control totals (M23-FR-04 / QG-07) — **the producer that was never written.**
//
// `validateControlTotals` compares two sides and `closePeriod` refuses to close unless they agree
// exactly. Both have been written and tested since the module was created. Neither was ever given a
// control total to check, because **nothing in this system built one** — the gap analysis has said
// so in as many words for weeks: *"No control totals can be built — deliberate, and it means no
// month can close yet."*
//
// So the month could not close, which at least failed in the safe direction. This is the piece that
// lets it close honestly.
//
// ── The one decision this file turns on ─────────────────────────────────────
//
// **Only a posting the accounts have actually ACCEPTED counts as received.**
//
// A posting sitting in the queue is money Tally has never seen. A dead-lettered one is money Tally
// has refused. Counting either as received would make both sides of every total agree — the two
// sides would be the same number computed twice — and the period would close, reconciled, signed,
// with the accounts missing the lot. That is the "vacuously satisfied" failure this codebase keeps
// finding, in the one place where a chartered accountant puts their name to the result.
//
// The queue is therefore reported **beside** the totals, never inside them.
//
// ── Why the ledger side is not derived from the postings ────────────────────
//
// If both sides came from the same place they would always agree and the check would be theatre.
// The ledger side is what the shop's own append-only record says happened; the posted side is what
// the accounting system confirms it holds. They are independent by construction, and `method` on
// each total says how each was derived so a CA can re-derive it without asking anybody.
//
// Pure and deterministic: no clock, no I/O.

import type { ControlTotal } from './period';
import type { QueuedPosting } from './tally-connector';

/** What the shop's own append-only record says happened in the period. */
export interface LedgerSide {
  /** Everything taken at the tills, gross, in minor units. */
  readonly takingsMinor: number;
  /** Tax collected within those takings. */
  readonly taxMinor: number;
  /** Refunds given, as a positive magnitude. */
  readonly refundsMinor: number;
  /** How many bills the figure is over — not a total, but it makes the total re-derivable. */
  readonly billCount: number;
}

/** Which postings the accounts have actually accepted, and what is still outstanding. */
export interface PostedSide {
  readonly acceptedMinor: number;
  readonly acceptedCount: number;
  /** Queued but not yet accepted — money the accounts have NOT seen. */
  readonly pendingMinor: number;
  readonly pendingCount: number;
  /** Refused outright. Never dropped, never counted as received (hard rule #6). */
  readonly deadLetteredMinor: number;
  readonly deadLetteredCount: number;
}

/**
 * Split the queue into what the accounts hold and what they do not.
 *
 * `posted` is the only state that means *Tally has it*. Everything else — queued, failed, dead —
 * is outstanding, and the difference between those two categories is the whole point of the check.
 */
export function postedSide(postings: readonly QueuedPosting[]): PostedSide {
  let acceptedMinor = 0;
  let acceptedCount = 0;
  let pendingMinor = 0;
  let pendingCount = 0;
  let deadLetteredMinor = 0;
  let deadLetteredCount = 0;

  for (const posting of postings) {
    // The debit side is the one control totals are stated in. A journal whose legs do not balance
    // is a different fault and is caught where journals are posted, not smuggled in here.
    const value = posting.debitMinor;
    if (posting.state === 'posted') {
      acceptedMinor += value;
      acceptedCount += 1;
    } else if (posting.state === 'dead_lettered') {
      deadLetteredMinor += value;
      deadLetteredCount += 1;
    } else {
      pendingMinor += value;
      pendingCount += 1;
    }
  }
  return {
    acceptedMinor, acceptedCount,
    pendingMinor, pendingCount,
    deadLetteredMinor, deadLetteredCount,
  };
}

/**
 * Build the control totals a period close is judged on.
 *
 * One total per figure a CA would ask about, each stating both sides and how each was derived.
 * The postings are attributed to a figure by `journalRef` prefix, which is how the posting side is
 * labelled at source — an unattributable posting is **counted into a total of its own** rather than
 * quietly left out, because a posting nobody can classify is exactly the one worth looking at.
 */
export function buildControlTotals(input: {
  readonly period: string;
  readonly ledger: LedgerSide;
  readonly postings: readonly QueuedPosting[];
  /**
   * Which journal references belong to which figure, per-tenant.
   *
   * Never a constant: one shop's chart of accounts is not another's, and a mapping guessed here
   * would put a shop's takings under a heading its accountant does not use.
   */
  readonly journalPrefixes: Readonly<Record<'takings' | 'tax' | 'refunds', string>>;
}): readonly ControlTotal[] {
  const accepted = input.postings.filter((p) => p.state === 'posted');
  const sumFor = (prefix: string): number =>
    accepted.filter((p) => p.journalRef.startsWith(prefix)).reduce((t, p) => t + p.debitMinor, 0);

  const { takings, tax, refunds } = input.journalPrefixes;

  const totals: ControlTotal[] = [
    {
      name: 'Takings',
      ledgerMinor: input.ledger.takingsMinor,
      postedMinor: sumFor(takings),
      method: `the shop's own sales log for ${input.period}, ${input.ledger.billCount} bill(s), against postings accepted by the accounts under "${takings}"`,
    },
    {
      name: 'Tax collected',
      ledgerMinor: input.ledger.taxMinor,
      postedMinor: sumFor(tax),
      method: `tax on those same bills, against postings accepted under "${tax}"`,
    },
    {
      name: 'Refunds',
      ledgerMinor: input.ledger.refundsMinor,
      postedMinor: sumFor(refunds),
      method: `refunds recorded at the service desk and the tills, against postings accepted under "${refunds}"`,
    },
  ];

  // A posting the mapping does not recognise. It has a value and it is in the accounts, so leaving
  // it out would make the other totals agree while the accounts held more than the shop can
  // explain. Its ledger side is nought **because the shop's record has nothing matching it** —
  // which is the finding, not a defect in the arithmetic.
  const known = [takings, tax, refunds];
  const unattributed = accepted.filter((p) => !known.some((prefix) => p.journalRef.startsWith(prefix)));
  if (unattributed.length > 0) {
    totals.push({
      name: 'Postings nobody can classify',
      ledgerMinor: 0,
      postedMinor: unattributed.reduce((t, p) => t + p.debitMinor, 0),
      method: `${unattributed.length} posting(s) accepted by the accounts whose reference matches none of this shop's headings: ${unattributed.map((p) => p.journalRef).join(', ')}`,
    });
  }

  return totals;
}
