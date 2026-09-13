// Auto-open an investigation from a material cash shortage (M15-FR-04 / WF, P-03 control by exception).
//
// A till that closes SHORT beyond tolerance is the clearest signal the module has that money may have
// gone missing — and a signal that only ever sits on a list is one nobody acted on. So a material short
// opens an investigation case automatically, deterministically, with no human deciding whether to
// bother. This is the pure decision behind that: given the shift's facts and who the store's managers
// are, it produces the case to open — or a plain reason it cannot.
//
// Two rules make it trustworthy rather than noisy:
//   • only a material SHORT opens a case — an over is a discrepancy the cash-office sign-off handles,
//     not a loss to investigate, and a within-tolerance close is not an exception at all; and
//   • the investigator is a store manager who is NOT the cashier who counted the drawer — a subject
//     cannot investigate their own case.
//
// It is a deterministic rule, not an AI action, so it may commit (P-05): AI recommends, rules and
// authorised humans commit. Pure and deterministic — no clock, no I/O; the service records the case.

export interface ShiftShortageFacts {
  readonly shiftId: string;
  readonly tillId: string;
  /** The cashier who counted the drawer — becomes the subject of the case, never the investigator. */
  readonly cashierId: string;
  readonly tradingDay: string;
  /** counted − expected. Negative is a short (money missing); this rule only fires on a short. */
  readonly varianceMinor: number;
  /** Whether the close was material (over tolerance). Only a material short opens a case. */
  readonly exceptionRaised: boolean;
  readonly currency: string;
}

export type ShortageInvestigationRefusal = 'not_a_material_shortage' | 'no_eligible_investigator';

export interface ShortageInvestigationPlan {
  readonly open: boolean;
  readonly refusedBecause?: ShortageInvestigationRefusal;
  readonly detail: string;
  readonly caseId?: string;
  readonly raisedFromRef?: string;
  readonly subjectRef?: string;
  readonly assignedTo?: string;
  readonly summary?: string;
  readonly valueMinor?: number;
}

/**
 * Plan the investigation a material cash shortage opens. Returns `open: true` with the case fields when
 * the shift closed materially short AND there is a store manager other than the cashier to assign it to;
 * otherwise `open: false` with a typed reason — so a store with no eligible investigator is a visible
 * configuration gap (P-08), never a shortage that quietly opened no case.
 */
export function planInvestigationFromShortage(input: {
  readonly shift: ShiftShortageFacts;
  readonly storeManagers: readonly string[];
}): ShortageInvestigationPlan {
  const { shift, storeManagers } = input;

  if (!shift.exceptionRaised || shift.varianceMinor >= 0) {
    return {
      open: false,
      refusedBecause: 'not_a_material_shortage',
      detail: 'the drawer did not close materially short — an over is handled by the cash-office sign-off, and a within-tolerance close is not an exception',
    };
  }

  // A store manager who is not the cashier who counted the drawer. Deterministic pick by id, so the same
  // shift always plans the same investigator (idempotent).
  const assignedTo = [...storeManagers].filter((m) => m !== shift.cashierId).sort()[0];
  if (assignedTo === undefined) {
    return {
      open: false,
      refusedBecause: 'no_eligible_investigator',
      detail: 'there is no store manager (other than the cashier) to investigate this short — grant the store-manager role to someone so a material shortage is investigated, not left open',
    };
  }

  const shortMinor = Math.abs(shift.varianceMinor);
  return {
    open: true,
    detail: `investigation planned on ${shift.cashierId} for a ${shortMinor}-minor short at till ${shift.tillId}, assigned to ${assignedTo}`,
    // One case per shift shortage — a stable id makes the auto-open idempotent.
    caseId: `shortage-${shift.shiftId}`,
    // The `shift-shortage` prefix is the rule bucket ruleFeedback groups these under, so a run of
    // shortage cases that all close unfounded surfaces as a tolerance that is too tight.
    raisedFromRef: `shift-shortage:${shift.shiftId}`,
    subjectRef: shift.cashierId,
    assignedTo,
    summary: `Till ${shift.tillId} closed ${shortMinor} ${shift.currency} (minor units) short on ${shift.tradingDay}, over tolerance on the blind count. Auto-opened for investigation.`,
    valueMinor: shortMinor,
  };
}
