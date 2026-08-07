// Supervisor overrides, age/restricted prompts and lane health (M12-FR-04).
//
// Three things stand between a cashier and a mistake that costs real money or a
// real prosecution, and all three fail the same way — by being advisory.
//
//   1. AN AGE PROMPT THAT DOES NOT BLOCK is a note nobody reads. Selling alcohol
//      to a minor is a personal prosecution for the cashier and a licence risk for
//      the shop, so a flagged item does not go into the basket until someone has
//      answered the question. "Warned and sold" is the outcome to prevent.
//
//   2. AN OVERRIDE THE CASHIER CAN GIVE THEMSELVES is not a control. The whole
//      point of a supervisor override is that a second person, with authority,
//      looked. So a cashier can never override their own basket, an override
//      beyond a supervisor's authority ESCALATES rather than failing silently,
//      and every override carries a reason and an approver into the audit trail
//      (M15 reads these).
//
//   3. A LANE THAT LOOKS FINE WHILE IT IS OFFLINE loses sales. The lane always
//      shows its true state — online, degraded, offline — and the number of sales
//      that have not yet reached the cloud, so nobody closes the shop over a till
//      that is still holding the day (§27.1, P-08). The lane keeps trading either
//      way; it just never lies about it (hard rule #1).
//
// Pure and deterministic: no clock, no I/O. Decisions are returned, never applied.

import type { ConnectionState } from '../../../packages/contracts/src/enums';
import type { Money } from '../../../packages/contracts/src/money';

// --- age and restricted items -------------------------------------------------

export type RestrictionKind = 'age' | 'licence_hours' | 'quantity_limit' | 'prescription';

export interface RestrictedItem {
  readonly productId: string;
  readonly name: string;
  readonly kind: RestrictionKind;
  /** For an age restriction: the minimum age in years. */
  readonly minimumAge?: number;
  /** For a quantity limit: the most that may be sold in one basket. */
  readonly maxPerBasket?: number;
  /** For licence hours: the window the item may be sold in, local time HH:MM. */
  readonly sellableFrom?: string;
  readonly sellableUntil?: string;
}

export type PromptOutcome = 'blocked' | 'prompt_required' | 'allowed';

export interface RestrictionPrompt {
  readonly productId: string;
  readonly kind: RestrictionKind;
  readonly outcome: PromptOutcome;
  /** True when only a supervisor can let this through. */
  readonly needsSupervisor: boolean;
  /** Exactly what the cashier is asked, in words they can say out loud. */
  readonly question: string;
}

/** What the cashier answered, and what the supervisor decided if asked. */
export interface PromptAnswer {
  readonly productId: string;
  /** The cashier confirmed they checked identification and it passed. */
  readonly ageVerified?: boolean;
  readonly override?: SupervisorOverride;
}

/**
 * Decide what the lane must ask before this item joins the basket. An unflagged
 * item is simply allowed — the prompt only exists where the law or the tenant's
 * policy puts one.
 *
 * `localTime` is HH:MM, passed in — the lane has no clock here.
 */
export function checkRestriction(
  item: RestrictedItem,
  context: { readonly localTime?: string; readonly alreadyInBasket?: number },
): RestrictionPrompt {
  switch (item.kind) {
    case 'age':
      return {
        productId: item.productId,
        kind: 'age',
        // Not a warning. Nothing proceeds until the question is answered.
        outcome: 'prompt_required',
        needsSupervisor: false,
        question: `${item.name} is age restricted — check identification. Is the customer ${item.minimumAge ?? 18} or over?`,
      };

    case 'licence_hours': {
      const now = context.localTime;
      const from = item.sellableFrom;
      const until = item.sellableUntil;
      const outsideHours =
        now !== undefined &&
        ((from !== undefined && now < from) || (until !== undefined && now >= until));
      return {
        productId: item.productId,
        kind: 'licence_hours',
        outcome: outsideHours ? 'blocked' : 'allowed',
        needsSupervisor: false,
        question: outsideHours
          ? `${item.name} cannot be sold at ${now} — the licence allows ${from ?? '00:00'} to ${until ?? '24:00'}`
          : '',
      };
    }

    case 'quantity_limit': {
      const already = context.alreadyInBasket ?? 0;
      const limit = item.maxPerBasket ?? Number.POSITIVE_INFINITY;
      const over = already + 1 > limit;
      return {
        productId: item.productId,
        kind: 'quantity_limit',
        outcome: over ? 'prompt_required' : 'allowed',
        needsSupervisor: over,
        question: over
          ? `${item.name} is limited to ${limit} per customer — a supervisor must approve going beyond it`
          : '',
      };
    }

    case 'prescription':
      return {
        productId: item.productId,
        kind: 'prescription',
        outcome: 'prompt_required',
        needsSupervisor: true,
        question: `${item.name} needs a prescription — a supervisor must confirm they have seen it`,
      };
  }
}

/** Whether the item may now join the basket, given what was answered. */
export function resolveRestriction(
  prompt: RestrictionPrompt,
  answer: PromptAnswer | undefined,
): { readonly allowed: boolean; readonly reason: string } {
  if (prompt.outcome === 'allowed') {
    return { allowed: true, reason: '' };
  }
  if (prompt.outcome === 'blocked') {
    return { allowed: false, reason: prompt.question };
  }
  if (answer === undefined) {
    // The acceptance test: an age-restricted item blocks without an answer.
    return { allowed: false, reason: 'the prompt has not been answered' };
  }
  if (prompt.needsSupervisor) {
    const override = answer.override;
    if (override === undefined || override.decision !== 'approved') {
      return { allowed: false, reason: 'a supervisor has not approved it' };
    }
    return { allowed: true, reason: `approved by ${override.supervisorId}` };
  }
  if (prompt.kind === 'age' && answer.ageVerified !== true) {
    return { allowed: false, reason: 'age was not verified — the sale must be refused' };
  }
  return { allowed: true, reason: 'checked at the till' };
}

// --- supervisor overrides ------------------------------------------------------

export type OverrideKind =
  | 'price_change'
  | 'line_void'
  | 'basket_void'
  | 'discount'
  | 'no_sale'
  | 'restricted_item'
  | 'refund';

export interface OverrideRequest {
  readonly overrideId: string;
  readonly kind: OverrideKind;
  readonly cashierId: string;
  readonly laneId: string;
  /** What it is worth, where the override has a value (discount, refund, void). */
  readonly value?: Money;
  readonly reason: string;
  readonly at: string;
}

/** A supervisor's authority — per tenant, per role, chosen not hard-coded. */
export interface SupervisorAuthority {
  readonly supervisorId: string;
  readonly allows: readonly OverrideKind[];
  /** The most they may approve in one override, in minor units. */
  readonly limitMinor?: number;
  /** Who it goes to when it exceeds their limit — never a dead end. */
  readonly escalatesTo?: string;
}

export type OverrideDecision = 'approved' | 'refused' | 'escalated';

export interface SupervisorOverride {
  readonly overrideId: string;
  readonly kind: OverrideKind;
  readonly cashierId: string;
  readonly supervisorId: string;
  readonly decision: OverrideDecision;
  readonly reason: string;
  readonly at: string;
  /** Set when it went beyond this supervisor's authority. */
  readonly escalatedTo?: string;
  readonly detail: string;
}

export class SelfOverrideError extends Error {
  constructor(public readonly overrideId: string) {
    super(
      `Override "${overrideId}" cannot be approved by the cashier who asked for it — an override you can give yourself is not a control (§28)`,
    );
    this.name = 'SelfOverrideError';
  }
}

export class MissingOverrideReasonError extends Error {
  constructor(public readonly overrideId: string) {
    super(`Override "${overrideId}" needs a reason — "manager approved" explains nothing later`);
    this.name = 'MissingOverrideReasonError';
  }
}

/**
 * Apply a supervisor's authority to an override request. Beyond their limit it
 * ESCALATES to a named person rather than failing — a button that just says "no"
 * teaches the lane to work around it.
 */
export function decideOverride(
  request: OverrideRequest,
  authority: SupervisorAuthority,
): SupervisorOverride {
  if (authority.supervisorId === request.cashierId) {
    throw new SelfOverrideError(request.overrideId);
  }
  if (request.reason.trim() === '') {
    throw new MissingOverrideReasonError(request.overrideId);
  }

  const base = {
    overrideId: request.overrideId,
    kind: request.kind,
    cashierId: request.cashierId,
    supervisorId: authority.supervisorId,
    reason: request.reason,
    at: request.at,
  };

  if (!authority.allows.includes(request.kind)) {
    return {
      ...base,
      decision: 'refused',
      detail: `a ${authority.supervisorId} may not approve a ${request.kind.replace('_', ' ')}`,
    };
  }

  const value = Math.abs(request.value?.minor ?? 0);
  if (authority.limitMinor !== undefined && value > authority.limitMinor) {
    return {
      ...base,
      decision: 'escalated',
      ...(authority.escalatesTo !== undefined ? { escalatedTo: authority.escalatesTo } : {}),
      detail:
        authority.escalatesTo === undefined
          ? 'it exceeds this supervisor’s limit and there is nobody above them configured'
          : `it exceeds this supervisor’s limit — sent to ${authority.escalatesTo}`,
    };
  }

  return { ...base, decision: 'approved', detail: 'approved at the lane' };
}

/** The audit entry every override produces — M15 reads these for patterns. */
export interface OverrideAuditEntry {
  readonly overrideId: string;
  readonly kind: OverrideKind;
  readonly laneId: string;
  readonly cashierId: string;
  readonly supervisorId: string;
  readonly decision: OverrideDecision;
  readonly reason: string;
  readonly valueMinor: number;
  readonly at: string;
}

export function overrideAudit(
  request: OverrideRequest,
  override: SupervisorOverride,
): OverrideAuditEntry {
  return {
    overrideId: override.overrideId,
    kind: override.kind,
    laneId: request.laneId,
    cashierId: override.cashierId,
    supervisorId: override.supervisorId,
    decision: override.decision,
    reason: override.reason,
    valueMinor: request.value?.minor ?? 0,
    at: override.at,
  };
}

// --- lane health ---------------------------------------------------------------

export type PeripheralKind = 'scanner' | 'printer' | 'scale' | 'cash_drawer' | 'card_terminal';
export type PeripheralState = 'ok' | 'degraded' | 'failed';

export interface Peripheral {
  readonly kind: PeripheralKind;
  readonly state: PeripheralState;
  readonly detail?: string;
}

export type LaneState = 'online' | 'degraded' | 'offline';

export interface LaneHealth {
  readonly laneId: string;
  readonly state: LaneState;
  readonly connection: ConnectionState;
  /** Sales taken here that have not yet reached the cloud (§27.1). */
  readonly unsentCount: number;
  /** Minutes since the catalogue snapshot was built — staleness, shown honestly. */
  readonly catalogueAgeMinutes?: number;
  readonly peripherals: readonly Peripheral[];
  /** True when the lane can still take a sale. Offline is NOT a stop (hard rule #1). */
  readonly canTrade: boolean;
  /** What the cashier sees, in one line. */
  readonly message: string;
  /** What the manager should do about it, where anything needs doing. */
  readonly actions: readonly string[];
}

/**
 * The lane's true state, always. A till that shows "online" while it is holding
 * forty unsent sales is how a day's takings go missing at close (P-08).
 */
export function laneHealth(input: {
  readonly laneId: string;
  readonly connection: ConnectionState;
  readonly unsentCount: number;
  readonly peripherals: readonly Peripheral[];
  readonly catalogueAgeMinutes?: number;
  /** Above this, the catalogue is called stale rather than merely old. */
  readonly staleCatalogueMinutes?: number;
}): LaneHealth {
  const failed = input.peripherals.filter((p) => p.state === 'failed');
  const degraded = input.peripherals.filter((p) => p.state === 'degraded');
  const offline = input.connection === 'offline';
  const staleCatalogue =
    input.catalogueAgeMinutes !== undefined &&
    input.staleCatalogueMinutes !== undefined &&
    input.catalogueAgeMinutes > input.staleCatalogueMinutes;

  // A scanner or a printer down does not stop the lane, but a cashier needs to know
  // before the queue does. Only losing the ability to record a sale stops trading.
  const scannerDown = failed.some((p) => p.kind === 'scanner');
  const state: LaneState = offline
    ? 'offline'
    : failed.length > 0 || degraded.length > 0 || staleCatalogue
      ? 'degraded'
      : 'online';

  const actions: string[] = [];
  for (const p of failed) {
    actions.push(`${p.kind.replace('_', ' ')} has failed${p.detail === undefined ? '' : ` — ${p.detail}`}`);
  }
  for (const p of degraded) {
    actions.push(`${p.kind.replace('_', ' ')} is not working properly${p.detail === undefined ? '' : ` — ${p.detail}`}`);
  }
  if (staleCatalogue) {
    actions.push(
      `prices are ${input.catalogueAgeMinutes} minutes old — a price changed today may not be here yet`,
    );
  }
  if (input.unsentCount > 0) {
    actions.push(`${input.unsentCount} sale(s) still to reach the cloud — do not close this lane yet`);
  }

  const message = offline
    ? `Offline — still selling. ${input.unsentCount} sale(s) waiting to send.`
    : state === 'degraded'
      ? `Working, with problems. ${input.unsentCount} sale(s) waiting to send.`
      : 'Online. Everything up to date.';

  return {
    laneId: input.laneId,
    state,
    connection: input.connection,
    unsentCount: input.unsentCount,
    ...(input.catalogueAgeMinutes !== undefined ? { catalogueAgeMinutes: input.catalogueAgeMinutes } : {}),
    peripherals: input.peripherals,
    // The lane trades offline by design. Only losing the scanner genuinely slows it,
    // and even then items can be keyed in — so it still trades.
    canTrade: true,
    message: scannerDown ? `${message} Scanner down — key items in by code.` : message,
    actions,
  };
}

/** Lanes a manager should look at now, worst first — the lane-health report. */
export function lanesNeedingAttention(lanes: readonly LaneHealth[]): readonly LaneHealth[] {
  const rank: Record<LaneState, number> = { offline: 0, degraded: 1, online: 2 };
  return lanes
    .filter((l) => l.state !== 'online' || l.unsentCount > 0)
    .sort((a, b) => rank[a.state] - rank[b.state] || b.unsentCount - a.unsentCount);
}
