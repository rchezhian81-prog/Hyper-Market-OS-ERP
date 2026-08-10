// Dual-MRP guard (roadmap v2.1 B2 — M03 / Legal Metrology). A pre-packed commodity carries ONE printed
// maximum retail price; a pack showing two different MRPs is an offence and leaves the till unable to
// say which price is the legal ceiling. MRP is historised (effective-dated, never overwritten), so a
// price CHANGE over time is legitimate — ₹100 until June, ₹120 from June is one active price at any
// moment. What is not legitimate is two DIFFERENT MRPs that both take effect on the SAME date: then no
// rule can say which is active, and `mrpOn` would tie-break arbitrarily. This rejects that second MRP
// at master-data commit, before a pack can carry a contradictory price. Pure and deterministic.

/** One effective-dated MRP: the amount in minor units, and the date it takes effect. */
export interface MrpEntry {
  readonly effectiveFrom: string; // YYYY-MM-DD
  readonly valueMinor: number;
}

export interface DualMrpCheck {
  /** True when the proposed MRP does not create two different active MRPs for the same date. */
  readonly ok: boolean;
  /** The clash, when rejected: the date on which two different MRPs would both be active. */
  readonly conflict?: { readonly effectiveFrom: string; readonly existingMinor: number; readonly proposedMinor: number };
  readonly detail: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class InvalidMrpEntry extends Error {
  constructor(detail: string) {
    super(`Invalid MRP entry: ${detail}`);
    this.name = 'InvalidMrpEntry';
  }
}

function assertEntry(e: MrpEntry, label: string): void {
  if (!DATE.test(e.effectiveFrom) || Number.isNaN(Date.parse(`${e.effectiveFrom}T00:00:00.000Z`))) {
    throw new InvalidMrpEntry(`${label} effectiveFrom "${e.effectiveFrom}" is not a valid YYYY-MM-DD date`);
  }
  if (!Number.isInteger(e.valueMinor) || e.valueMinor <= 0) {
    throw new InvalidMrpEntry(`${label} valueMinor must be a positive whole amount`);
  }
}

/**
 * Check whether adding `proposed` to a pack's existing effective-dated MRP history would make the pack
 * carry two DIFFERENT active MRPs on the same date (B2). Rejected only on a same-date, different-value
 * clash; a later-dated change (a normal price move) or an exact-duplicate re-entry is allowed.
 *
 * @throws InvalidMrpEntry if any entry has a bad date or a non-positive amount.
 */
export function checkDualMrp(existing: readonly MrpEntry[], proposed: MrpEntry): DualMrpCheck {
  assertEntry(proposed, 'proposed');
  for (const e of existing) assertEntry(e, 'existing');

  const clash = existing.find((e) => e.effectiveFrom === proposed.effectiveFrom && e.valueMinor !== proposed.valueMinor);
  if (clash !== undefined) {
    return {
      ok: false,
      conflict: { effectiveFrom: proposed.effectiveFrom, existingMinor: clash.valueMinor, proposedMinor: proposed.valueMinor },
      detail: `rejected — the pack already has a different MRP (${clash.valueMinor}) taking effect on ${proposed.effectiveFrom}; a pack may carry only one active MRP`,
    };
  }
  return { ok: true, detail: 'accepted — no two different MRPs would be active on the same date' };
}
