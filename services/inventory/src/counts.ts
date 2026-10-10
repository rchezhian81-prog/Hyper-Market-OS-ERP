// API-04 cycle / blind physical count reconciliation (M09-FR-04). The counter enters a BLIND physical
// count — they never see the system-expected quantity; this surface derives the expected on-hand
// SERVER-SIDE (the authoritative M08 position plus any prior count corrections), computes and VALUES the
// variance, and — when there is one — commits a reason-coded COMPENSATING adjustment through the real
// engine, with a SEPARATE approver required when the value is material (§28: the counter can never
// approve their own variance). Blind-count integrity is structural: the expected figure is computed here
// and is never an input. Append-only (hard rule #2); idempotent on the count id.
//
// The rules are the pure `reconcileCount` (→ `commitAdjustment`) engines in `packages/counts` /
// `packages/adjustment`, run over an in-memory `Ledger` hydrated with the expected position.
//
// SP-5b (audit finding F06): until this slice a count correction lived ONLY on this module's own count-correction
// register, LAYERED on M08 — the count view showed the corrected figure while ordinary availability, valuation, ageing
// and reorder all still read the old one. Now an applied correction is ONE compensating M08 movement (`adjusted` for
// stock found, `wasted` for stock missing — the kind carries the sign, the quantity is positive), appended ATOMICALLY
// with the count record under the movement id `count:<countId>`, so every reader of stock reads it and a retry cannot
// post it twice. A BIN-level count (SP-3b) posts the same M08 movement at the store location AND one bin movement on the
// warehouse projection, so the bin's occupancy corrects too. A correction that posted to M08 is never layered again
// (`movementId` set on the record); records from before this slice, which carry no movement id, still layer — nothing
// already recorded is re-read differently (hard rule #2).
//
// SP-4 (audit finding F07): until this slice the DIRECT route took the unit value, the approval threshold and the
// approver's name FROM THE BODY — a counter could price a variance at nothing, set the threshold to one, or name
// anyone as approver. Now every judgement is head office's own, on the direct and the relayed route alike
// (`reconcileBlindCount`): the value is the cloud's weighted-average cost, the threshold the tenant's count policy,
// and a MATERIAL (or unvalued) variance is RECORDED and HELD — never applied on the counter's say-so, never refused
// into the void (hard rule #10) — until a separate person with approval authority decides it (`decideCount`), by the
// direct decide route or by the manager's relayed decision. A body that still carries a claim is refused by name.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { reconcileCount, InvalidCountError, type CountReconciliation } from '../../../packages/counts/src/counts';
import { Ledger, InMemoryLedgerStore } from '../../../packages/ledger/src/ledger';
import { SyncOutbox } from '../../../packages/sync/src/outbox';
import { makeEvent } from '../../../packages/contracts/src/event';
import type { AuditEntry } from '../../../packages/audit/src/index';
import type { CurrencyCode } from '../../../packages/contracts/src/money';
import type { StockMovement } from '../../../packages/stock/src/position';
import type { Movement } from './index';
import { valueAtUnitCost } from '../../../packages/contracts/src/quantity';
import { assertLocationInScope, type LocationBranches } from './location-scope';

/** The count-approval threshold applied when the tenant has set none — and the record says so (`default_threshold`). */
export const DEFAULT_COUNT_APPROVAL_THRESHOLD_MINOR = 100_000;

export const COUNT_FLAGS = Object.freeze([
  'counter_unknown', 'counter_lacks_authority', 'value_unknown', 'default_threshold', 'bin_unknown',
] as const);
export type CountFlag = (typeof COUNT_FLAGS)[number];

export interface CountPolicy {
  /** Variance value at/above which a separate person must approve the correction (§28), in minor units. */
  readonly approvalThresholdMinor: number;
  readonly setBy: string;
  readonly setAt: string;
}

export interface StoredReconciliation {
  readonly countId: string;
  readonly productId: string;
  readonly locationId: string;
  readonly expectedMinor: number;
  readonly countedMinor: number;
  readonly varianceMinor: number;
  readonly valueMinor: number;
  readonly currency: CurrencyCode;
  readonly reasonCode: string;
  readonly reconciled: boolean;
  readonly adjusted: boolean;
  readonly requiredApproval: boolean;
  readonly counterId: string;
  readonly approvedBy: string | null;
  readonly at: string;
  /**
   * A count whose material (or unvalued) variance has NO approver yet: recorded, valued and visible, the correction
   * NOT applied until a separate person approves (§28). Since SP-4 on the direct route as well as the relayed one.
   */
  readonly pendingApproval?: boolean;
  /** What head office's own judgement found about the count (empty = nothing to flag). */
  readonly governanceFlags?: readonly string[];
  /** SP-2b — the identity that relayed it (the store box), the surface, and the store, when relayed. */
  readonly relayedBy?: string;
  readonly source?: string;
  readonly storeId?: string | null;
  /**
   * SP-3b (W2) — the BIN the warehouse handheld counted, when the count was bin-level: the expected figure was head
   * office's bin contents for that bin, and the correction layers on that bin only. Absent/null on a store-level count.
   */
  readonly binId?: string | null;
  /** SP-4 — how a HELD variance was decided, by whom and when; absent while it waits. */
  readonly decision?: 'approved' | 'rejected';
  readonly decidedAt?: string;
  readonly decisionReason?: string;
  /** SP-5b — the unit the count was made in; the correction movement carries it. Absent on records from before SP-5b. */
  readonly uom?: string;
  /**
   * SP-5b (F06) — the M08 movement the correction POSTED (`count:<countId>`), set when the correction was applied. A
   * record with it is on the ledger every reader folds and is never layered again; one without it (pre-SP-5b, or a
   * count that matched / was held / was rejected) posted nothing.
   */
  readonly movementId?: string | null;
}

/** The M08 movement id a count's correction posts under — one per count, so a retry is the same movement (§31.1). */
export const countMovementId = (countId: string): string => `count:${countId}`;

/** What an applied count correction writes beside its record (SP-5b): the M08 movement, and the bin movement for a bin count. */
export interface CountCorrection {
  readonly movement: Movement;
  /** For a BIN-level count: the movement on the warehouse projection that corrects the bin's occupancy. */
  readonly bin?: { readonly commandId: string; readonly movement: StockMovement };
}

/**
 * The compensating correction a reconciliation posts to the ledgers (SP-5b · F06 · M08-FR-03), or `undefined` when it
 * posted nothing (matched, held, rejected, or a pre-SP-5b record with no unit). Found stock is `adjusted` (+), missing
 * stock is `wasted` (−) — the same kinds the adjustment-request path posts — entered by the counter, approved by the
 * separate person who decided it, or by nobody when the tenant's own threshold made it immaterial (the reason says so).
 */
export function countCorrection(rec: StoredReconciliation): CountCorrection | undefined {
  if (!rec.adjusted || rec.varianceMinor === 0 || rec.uom === undefined || (rec.movementId ?? null) === null) return undefined;
  const at = rec.decidedAt ?? rec.at;
  const approved = rec.approvedBy === null ? 'immaterial under the tenant\'s count-approval threshold — no second approver required' : `approved by ${rec.approvedBy}`;
  const movement: Movement = {
    movementId: rec.movementId as string, productId: rec.productId, locationId: rec.locationId,
    kind: rec.varianceMinor > 0 ? 'adjusted' : 'wasted', quantityMinor: Math.abs(rec.varianceMinor), uom: rec.uom,
    occurredAt: at, enteredBy: rec.counterId,
    reason: `count ${rec.countId} (${rec.reasonCode})${rec.binId === null || rec.binId === undefined ? '' : ` bin ${rec.binId}`}: counted ${rec.countedMinor}, expected ${rec.expectedMinor}; ${approved}`,
    ...(rec.approvedBy === null ? {} : { approvedBy: rec.approvedBy }),
  };
  const binId = rec.binId ?? null;
  if (binId === null) return { movement };
  // The bin's occupancy corrects by the same quantity: into the bin for stock found, out of it for stock missing.
  const bin: StockMovement = {
    movementId: movement.movementId, productId: rec.productId, locationId: binId, batchId: null,
    from: rec.varianceMinor > 0 ? null : 'on_hand', to: rec.varianceMinor > 0 ? 'on_hand' : null,
    quantityMinor: Math.abs(rec.varianceMinor), uom: rec.uom, at, reason: movement.reason,
  };
  return { movement, bin: { commandId: movement.movementId, movement: bin } };
}

export interface CountsDeps {
  /** Authoritative M08 on-hand for (product, location) — the base the count is reconciled against. */
  readonly onHand: (tenantId: string, productId: string, locationId: string) => Promise<number> | number;
  /** Prior count reconciliations for (product, location) — their corrections layer on M08. */
  readonly reconciliations: (tenantId: string, productId: string, locationId: string) => Promise<readonly StoredReconciliation[]> | readonly StoredReconciliation[];
  /** Whether a count id has already been reconciled (idempotency — a count id is used once). */
  readonly countExists: (tenantId: string, countId: string) => Promise<boolean> | boolean;
  /**
   * Record the reconciliation — and, when `rec.movementId` is set (SP-5b), append `countCorrection(rec)` to the M08
   * ledger (and the bin's projection for a bin count) in the SAME atomic write, idempotent on the movement id.
   */
  readonly recordReconciliation: (tenantId: string, rec: StoredReconciliation) => Promise<void> | void;
  /** SP-4: the count by id, whatever position it is for — the decide step needs it (latest state). */
  readonly reconciliation: (tenantId: string, countId: string) => Promise<StoredReconciliation | undefined> | StoredReconciliation | undefined;
  /**
   * SP-4: append the decided state of a held count (a second event, never an edit — hard rule #2) — with its
   * `countCorrection(rec)` in the same atomic write when the approval set `rec.movementId` (SP-5b).
   */
  readonly recordDecision: (tenantId: string, rec: StoredReconciliation) => Promise<void> | void;
  /** SP-4 (F07): the cloud's own unit value for the product (weighted-average cost); `undefined` when never costed. */
  readonly unitValueMinor: (tenantId: string, productId: string) => Promise<number | undefined> | number | undefined;
  /** SP-4 (F07): the tenant's count policy, or `undefined` when never set (the default applies, flagged). */
  readonly countPolicy: (tenantId: string) => Promise<CountPolicy | undefined> | CountPolicy | undefined;
  /** PA-01-r1: which branch a location belongs to (the org hierarchy); absent → a location is its own branch key. */
  readonly locationBranches?: LocationBranches;
  /**
   * SP-3b (W2): head office's bin contents for (bin, product) across every batch — the base a BIN-level count is
   * reconciled against; `undefined` when the bin is not one head office has. Optional so a bare deps stub may omit it.
   */
  readonly binExpected?: (tenantId: string, binId: string, productId: string) => Promise<number | undefined> | number | undefined;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isNonNegInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

/**
 * The corrections still LAYERED on M08 for a position: counts that were ADJUSTED but posted no M08 movement (records
 * from before SP-5b). A correction that posted (`movementId` set) is already in the M08 figure and is never added twice.
 */
export const priorCorrections = (recs: readonly StoredReconciliation[]): number =>
  recs.filter((r) => r.adjusted && (r.movementId ?? null) === null).reduce((s, r) => s + r.varianceMinor, 0);
/** SP-5b: the corrections that POSTED to the ledger for a position — stated on the count view so a reader can see them. */
export const postedCorrections = (recs: readonly StoredReconciliation[]): number =>
  recs.filter((r) => r.adjusted && (r.movementId ?? null) !== null).reduce((s, r) => s + r.varianceMinor, 0);
/** The STORE-level reconciliations only: a bin count's correction (SP-3b) layers on that bin, never on the store position. */
export const storeLevel = (recs: readonly StoredReconciliation[]): readonly StoredReconciliation[] =>
  recs.filter((r) => (r.binId ?? null) === null);
/** Prior reconciliations of the SAME position: the same bin for a bin count, no bin for a store-level count. */
const samePosition = (binId: string | null) => (r: StoredReconciliation): boolean => (r.binId ?? null) === binId;

/** What a blind count is, wherever it was entered: only what the counter saw, and who saw it. */
export interface BlindCountInput {
  readonly countId: string;
  readonly productId: string;
  readonly locationId: string;
  readonly binId: string | null;
  readonly uom: string;
  readonly countedMinor: number;
  readonly reasonCode: string;
  readonly counterId: string;
  /** Flags the caller already established about the counter (a relayed count re-verifies them; a direct one has none). */
  readonly counterFlags: readonly CountFlag[];
  /** Who carried it and from where, when relayed; absent on the direct route. */
  readonly relayed?: { readonly relayedBy: string; readonly source: string; readonly storeId: string | null };
}

/**
 * Reconcile a blind count on head office's own figures — the ONE path both the direct and the relayed route take
 * (SP-4). Expected: the M08 position (or the bin's contents, SP-3b) plus prior corrections of the same position.
 * Value: the cloud's cost. Threshold: the tenant's policy. Immaterial → corrected at once through the tested engine.
 * Material, unvalued or unknown-bin → recorded and HELD for a separate person. Throws `InvalidCountError` for a
 * count that is not a non-negative whole quantity. Idempotency is the caller's (a count id is used once).
 */
export async function reconcileBlindCount(deps: CountsDeps, tenantId: string, c: BlindCountInput): Promise<StoredReconciliation> {
  const flags: CountFlag[] = [...c.counterFlags];
  const priorRecs = (await deps.reconciliations(tenantId, c.productId, c.locationId)).filter(samePosition(c.binId));
  let base: number;
  let binUnknown = false;
  if (c.binId === null) {
    base = await deps.onHand(tenantId, c.productId, c.locationId);
  } else {
    const held = deps.binExpected === undefined ? undefined : await deps.binExpected(tenantId, c.binId, c.productId);
    if (held === undefined) { binUnknown = true; flags.push('bin_unknown'); base = 0; } else base = held;
  }
  const expected = base + priorCorrections(priorRecs);

  // The VALUE and the THRESHOLD — the cloud's, never the body's (F07). Unknown is said, never silently zero:
  // an unvalued variance cannot be judged immaterial, so it waits for a person like a material one would.
  const unitValue = await deps.unitValueMinor(tenantId, c.productId);
  if (unitValue === undefined) flags.push('value_unknown');
  const policy = await deps.countPolicy(tenantId);
  if (policy === undefined) flags.push('default_threshold');
  const thresholdMinor = policy?.approvalThresholdMinor ?? DEFAULT_COUNT_APPROVAL_THRESHOLD_MINOR;

  const varianceMinor = c.countedMinor - expected;
  const valueMinor = valueAtUnitCost(Math.abs(varianceMinor), c.uom, unitValue ?? 0); // OB-31
  // A count of a bin head office does not have cannot be judged at all — it waits for a person like a material one.
  const material = binUnknown || (varianceMinor !== 0 && (unitValue === undefined || valueMinor >= thresholdMinor));
  const at = deps.now();
  const relayed = c.relayed === undefined ? {} : { relayedBy: c.relayed.relayedBy, source: c.relayed.source, storeId: c.relayed.storeId };
  const common = {
    countId: c.countId, productId: c.productId, locationId: c.locationId, binId: c.binId, uom: c.uom,
    countedMinor: c.countedMinor, currency: 'INR' as const, reasonCode: c.reasonCode,
    counterId: c.counterId, approvedBy: null, at, governanceFlags: flags, ...relayed,
  };
  if (material) {
    // Recorded, valued, visible — and NOT applied. The correction waits for a separate person (§28); the review
    // screen lists it first. The count happened; this records it honestly, never refuses it into the void (#10).
    if (!Number.isInteger(c.countedMinor) || c.countedMinor < 0) throw new InvalidCountError(c.countId);
    return { ...common, expectedMinor: expected, varianceMinor, valueMinor, reconciled: false, adjusted: false, requiredApproval: true, pendingApproval: true, movementId: null };
  }
  // Immaterial (or no variance): the same tested engine as ever, over a ledger hydrated with the expected position,
  // corrects at once. Threshold above the value by construction, so it never throws for approval.
  const store = new InMemoryLedgerStore();
  const ledger = new Ledger(store);
  ledger.append(makeEvent({
    id: `count-open-${c.countId}`, type: 'CountOpeningPosition', occurredAt: at,
    idempotencyKey: `count-open-${tenantId}-${c.countId}`, source: 'api/inventory',
    payload: { productId: c.productId, deltaMinor: expected },
  }));
  const result: CountReconciliation = reconcileCount({
    id: c.countId, productId: c.productId, locationId: c.locationId, uom: c.uom,
    countedMinor: c.countedMinor, counterId: c.counterId, at, reasonCode: c.reasonCode,
    valuePerUnit: { minor: unitValue ?? 0, currency: 'INR' }, thresholdMinor: valueMinor + 1,
  }, ledger, new SyncOutbox());
  // SP-5b (F06): an applied correction is an M08 movement — `recordReconciliation` appends it with the record.
  return { ...common, expectedMinor: result.expectedMinor, varianceMinor: result.varianceMinor, valueMinor: result.varianceValue.minor, reconciled: result.reconciled, adjusted: result.adjusted, requiredApproval: false, pendingApproval: false, movementId: result.adjusted ? countMovementId(c.countId) : null };
}

/** What deciding a held count came to — for the direct route and for the manager's relayed decision alike. */
export type CountDecisionOutcome =
  | { readonly ok: true; readonly record: StoredReconciliation; readonly alreadyDecided: boolean }
  | { readonly ok: false; readonly refusedBecause: 'count_unknown' | 'count_not_pending' | 'self_approval' | 'count_already_decided'; readonly detail: string; readonly record?: StoredReconciliation };

/**
 * Decide a HELD count (SP-4 · §28): a person who is NOT the counter approves — the correction then layers on the
 * position (`adjusted`) — or rejects it (the variance stands recorded, nothing applied). One decision per count: the
 * same again is a no-op with `alreadyDecided`, a different one is refused. Appends the decided state; never edits.
 */
export async function decideCount(deps: CountsDeps, input: {
  readonly tenantId: string; readonly countId: string; readonly decidedBy: string;
  readonly decision: 'approved' | 'rejected'; readonly reason: string; readonly branchId: string | null;
  /** How the decision arrived — for the audit line. */
  readonly via: 'direct' | 'relayed';
  /** PA-01-r1: refuse (throws, by name) when the count's location is outside the decider's branches. */
  readonly assertInScope?: (locationId: string) => Promise<void>;
}): Promise<CountDecisionOutcome> {
  const rec = await deps.reconciliation(input.tenantId, input.countId);
  if (rec === undefined) return { ok: false, refusedBecause: 'count_unknown', detail: `No count ${input.countId} is on file here.` };
  await input.assertInScope?.(rec.locationId);
  if (rec.decision !== undefined) {
    if (rec.decision === input.decision) return { ok: true, record: rec, alreadyDecided: true };
    return { ok: false, refusedBecause: 'count_already_decided', detail: `Count ${input.countId} was already ${rec.decision} by ${rec.approvedBy ?? 'someone'} at ${rec.decidedAt ?? '?'}; a different decision now would be a second truth.`, record: rec };
  }
  if (rec.pendingApproval !== true) return { ok: false, refusedBecause: 'count_not_pending', detail: `Count ${input.countId} is not waiting for a decision (it ${rec.adjusted ? 'was corrected at once' : 'matched'}).`, record: rec };
  if (rec.counterId === input.decidedBy) return { ok: false, refusedBecause: 'self_approval', detail: `${input.decidedBy} counted this and cannot decide it (§28 separation of duties).`, record: rec };

  const decidedAt = deps.now();
  // SP-5b (F06): an APPROVED correction posts to the M08 ledger (and the bin, for a bin count) with the decided record —
  // one movement, keyed on the count, appended by `recordDecision` in the same write. A pre-SP-5b record with no unit
  // cannot be turned into a movement and stays layered, as it always was.
  const posts = input.decision === 'approved' && rec.varianceMinor !== 0 && rec.uom !== undefined;
  const decided: StoredReconciliation = {
    ...rec,
    adjusted: input.decision === 'approved', pendingApproval: false,
    approvedBy: input.decision === 'approved' ? input.decidedBy : null,
    decision: input.decision, decidedAt, decisionReason: input.reason,
    movementId: posts ? countMovementId(rec.countId) : null,
  };
  await deps.recordDecision(input.tenantId, decided);
  await deps.recordAudit?.(input.tenantId, {
    actorId: input.decidedBy, action: input.decision === 'approved' ? 'count.approve' : 'count.reject', objectType: 'stock_count', objectId: input.countId,
    at: decidedAt, origin: { tenantId: input.tenantId, branchId: input.branchId },
    before: { status: 'pending_approval' },
    after: { status: input.decision, counterId: rec.counterId, varianceMinor: String(rec.varianceMinor), valueMinor: String(rec.valueMinor), binId: rec.binId ?? '', movementId: decided.movementId ?? '', via: input.via },
    reason: input.reason, correlationId: input.countId,
  });
  return { ok: true, record: decided, alreadyDecided: false };
}

const refusalStatus: Record<Exclude<CountDecisionOutcome, { ok: true }>['refusedBecause'], number> = {
  count_unknown: 404, count_not_pending: 409, self_approval: 422, count_already_decided: 409,
};

export function countsRoutes(deps: CountsDeps): readonly Route[] {
  return [
    {
      // Reconcile a blind count. The expected quantity is computed here, never supplied — and since SP-4 so are the
      // value and the threshold; a material variance is HELD for a separate person, never applied on a body claim.
      api: 'API-04', method: 'POST', path: '/v1/inventory/counts/:countId',
      permission: 'inventory.movement.append', idempotent: true,
      handler: async (ctx) => {
        const countId = ctx.params['countId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (b['valuePerUnitMinor'] !== undefined || b['thresholdMinor'] !== undefined || b['approvedBy'] !== undefined) {
          throw apiError(400, {
            code: 'count_carries_caller_claims',
            whatHappened: 'A count carries no value, no threshold and no approver: the value is head office\'s own cost, the threshold is the tenant\'s count policy, and a material variance waits for a separate person to decide it.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send only the blind count (productId, locationId, uom, countedMinor, reasonCode). Nothing was recorded.',
          });
        }
        if (!isStr(b['productId']) || !isStr(b['locationId']) || !isStr(b['uom']) || !isNonNegInt(b['countedMinor']) || !isStr(b['reasonCode'])) {
          throw apiError(400, {
            code: 'not_readable_as_a_count',
            whatHappened: 'A count needs a productId, locationId, uom, whole countedMinor and a reasonCode.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the blind count. Nothing was recorded. The expected quantity is computed by the system, never sent.',
          });
        }
        await assertLocationInScope(ctx, b['locationId'], deps.locationBranches); // PA-01-r1: only the caller's branches
        if (await deps.countExists(ctx.tenantId, countId)) {
          throw apiError(409, {
            code: 'count_already_reconciled',
            whatHappened: `Count ${countId} has already been reconciled — a count id is used once; a re-count is a new count.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Use a new count id. Nothing was changed.',
          });
        }
        let rec: StoredReconciliation;
        try {
          rec = await reconcileBlindCount(deps, ctx.tenantId, {
            countId, productId: b['productId'], locationId: b['locationId'], binId: null, uom: b['uom'],
            countedMinor: b['countedMinor'], reasonCode: b['reasonCode'], counterId: ctx.userId, counterFlags: [],
          });
        } catch (e) {
          if (e instanceof InvalidCountError) {
            throw apiError(400, { code: 'invalid_count', whatHappened: e.message, wasItSaved: 'not_saved', nextSafeAction: 'Correct the count and re-send. Nothing was recorded.' });
          }
          throw e;
        }
        await deps.recordReconciliation(ctx.tenantId, rec);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'count.record', objectType: 'stock_count', objectId: countId,
          at: rec.at, origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: null,
          after: { productId: rec.productId, locationId: rec.locationId, countedMinor: String(rec.countedMinor), varianceMinor: String(rec.varianceMinor), valueMinor: String(rec.valueMinor), adjusted: String(rec.adjusted), pendingApproval: String(rec.pendingApproval ?? false), flags: (rec.governanceFlags ?? []).join(',') },
          reason: rec.reasonCode, correlationId: countId,
        });
        return {
          status: 201,
          body: { countId, expectedMinor: rec.expectedMinor, countedMinor: rec.countedMinor, varianceMinor: rec.varianceMinor, valueMinor: rec.valueMinor, reconciled: rec.reconciled, adjusted: rec.adjusted, requiredApproval: rec.requiredApproval, pendingApproval: rec.pendingApproval ?? false, movementId: rec.movementId ?? null, flags: rec.governanceFlags ?? [] },
        };
      },
    },
    {
      // SP-4: decide a HELD count — approve (the correction layers on the position) or reject — by a separate person.
      api: 'API-04', method: 'POST', path: '/v1/inventory/counts/:countId/decide',
      permission: 'inventory.adjustment.approve', idempotent: true,
      handler: async (ctx) => {
        const countId = (ctx.params['countId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const decision = b['decision'];
        if ((decision !== 'approved' && decision !== 'rejected') || !isStr(b['reason'])) {
          throw apiError(400, {
            code: 'not_readable_as_a_count_decision',
            whatHappened: 'A decision needs { decision: "approved" | "rejected", reason } — the reason is the audit line a person reads later.',
            wasItSaved: 'not_saved', nextSafeAction: 'Send the decision with a reason. Nothing was changed.',
          });
        }
        const out = await decideCount(deps, { tenantId: ctx.tenantId, countId, decidedBy: ctx.userId, decision, reason: b['reason'].trim(), branchId: ctx.branchId ?? null, via: 'direct',
          assertInScope: (locationId) => assertLocationInScope(ctx, locationId, deps.locationBranches) });
        if (!out.ok) {
          throw apiError(refusalStatus[out.refusedBecause], { code: out.refusedBecause, whatHappened: out.detail, wasItSaved: 'not_saved', nextSafeAction: out.refusedBecause === 'self_approval' ? 'A different person with approval authority must decide it. Nothing was changed.' : 'Nothing was changed.' });
        }
        return { status: 200, body: { countId, decision: out.record.decision, adjusted: out.record.adjusted, approvedBy: out.record.approvedBy, decidedAt: out.record.decidedAt, movementId: out.record.movementId ?? null, alreadyDecided: out.alreadyDecided } };
      },
    },
    {
      // The corrected position and count history for a product at a location. Since SP-5b (F06) an applied correction
      // is IN the M08 figure (`postedCorrectionMinor` states how much of it came from counts); only pre-SP-5b
      // corrections, which posted no movement, are still layered on top (`countCorrectionMinor`).
      api: 'API-04', method: 'GET', path: '/v1/inventory/counts',
      permission: 'inventory.availability.read',
      handler: async (ctx) => {
        const productId = ctx.query['productId'];
        const locationId = ctx.query['locationId'];
        if (!isStr(productId) || !isStr(locationId)) {
          throw apiError(400, {
            code: 'not_readable_as_a_count_query',
            whatHappened: 'Reading a count position needs a productId and a locationId.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send ?productId=…&locationId=…. Nothing was changed.',
          });
        }
        await assertLocationInScope(ctx, locationId, deps.locationBranches); // PA-01-r1: a named location outside is refused
        const recs = await deps.reconciliations(ctx.tenantId, productId, locationId);
        const systemOnHandMinor = await deps.onHand(ctx.tenantId, productId, locationId);
        // Bin counts (SP-3b) are LISTED here with their bin; a bin count's posted correction is at the location on M08 like any
        // other (the bin sits inside the location), while a pre-SP-5b bin correction layered only on the bin, never here.
        const countCorrectionMinor = priorCorrections(storeLevel(recs));
        const postedCorrectionMinor = postedCorrections(recs);
        return {
          status: 200,
          body: { productId, locationId, systemOnHandMinor, countCorrectionMinor, postedCorrectionMinor, correctedOnHandMinor: systemOnHandMinor + countCorrectionMinor, counts: recs, pending: recs.filter((r) => r.pendingApproval === true).length, asAt: deps.now() },
        };
      },
    },
  ];
}
