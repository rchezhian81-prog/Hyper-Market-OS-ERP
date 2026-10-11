// API-05 / API-04 — a PERSON'S DECISION on a returned unit held off the shelf (WF-11 "… → disposition → reconcile" ·
// M13-FR-02 "set disposition → stock event to the right state (M08)" · M28-FR-01 · M10 · §28 · hard rules #2, #6, #10).
//
// PF-14 made every quarantined, damaged or scrap line of a return HELD where it came back, with its lot and the return it
// came from (`GET /v1/returns/held-stock`) — never on the shelf, never lost. What it did not have is the step after: a
// person deciding what happens to the unit. Here, one decision per held unit, by a named person, recorded append-only:
//
//   • restock            — QC releases it back to sale: ONE `returned` movement puts it on the shelf where it came back,
//                          under its own batch. Needs the quality-release authority (`quality.hold.release`, M10). A batch
//                          under an open recall or quality hold is refused by name — it does not go back on sale.
//   • write_off          — a loss: valued at head office's own average cost (never typed — SF-05), on the write-off
//                          register (M28) with its reason; a MATERIAL loss (at/above the tenant's threshold, or a cost head
//                          office does not hold) needs evidence AND a second person's approval, given in their own session
//                          (kind `stock_write_off`, ADR-0024 — the maker can never approve it). On the ledger the unit
//                          comes in (`returned`) and goes out as waste (`wasted`) — on-hand is unchanged, the loss is valued.
//   • return_to_supplier — goes back to the supplier (named, with their reference): `returned` in, `returned_to_supplier` out.
//   • repair             — sent for repair: no stock moves; the unit stays on the list as "at repair" until a later decision
//                          (restock / write-off / return to supplier) closes it.
//
// Every decision is atomic with its movements (one batch); the movement ids are keyed on the held unit, so stock moves
// ONCE however often a decision is re-sent. A decision id is used once; a held unit is closed once. Each is sealed in the
// audit trail. Nothing is deleted — the held record and every decision on it stay (hard rule #6).

import type { Route } from '../../kernel/src/index';
import { apiError, concurrentChange } from '../../kernel/src/index';
import { ConcurrencyConflictError } from '../../../packages/persistence/src/event-store';
import type { HeldReturnedStock } from './sale-stock';
import type { Movement } from '../../inventory/src/index';
import type { StoredWriteOff } from '../../inventory/src/write-off';
import { lossValueOf } from '../../inventory/src/write-off';
import { DEFAULT_WRITE_OFF_THRESHOLD_MINOR, type LossType } from '../../../packages/waste/src/waste';
import { actionDetails, approvalNamedIn, type ApprovalPort } from '../../identity/src/approval-requests';
import { assertLocationInScope, type LocationBranches } from '../../inventory/src/location-scope';
import type { AuditEntry } from '../../../packages/audit/src/index';

export const HELD_DECISIONS = ['restock', 'write_off', 'return_to_supplier', 'repair'] as const;
export type HeldDecisionKind = (typeof HELD_DECISIONS)[number];
const LOSS_TYPES: readonly LossType[] = ['wastage', 'damage', 'expiry', 'donation', 'destruction'];

/** One person's decision on one held unit, as stored on the append-only decisions stream and read back. */
export interface HeldStockDecision {
  readonly decisionId: string;
  readonly heldId: string;
  readonly returnId: string;
  readonly productId: string;
  readonly uom: string;
  readonly quantityMinor: number;
  readonly batchId: string | null;
  readonly locationId: string | null;
  readonly decision: HeldDecisionKind;
  readonly reasonCode: string;
  readonly note: string | null;
  readonly decidedBy: string;
  readonly decidedAt: string;
  /** The stock movements this decision appended (keyed on the held unit — once). Empty for `repair`. */
  readonly movementIds: readonly string[];
  /** `write_off`: the loss's value and where it came from, and the second person for a material loss. */
  readonly valueMinor?: number;
  readonly valueSource?: 'stock_cost' | 'cost_unknown';
  readonly approvedBy?: string | null;
  readonly evidenceRef?: string | null;
  readonly writeOffId?: string;
  /** `return_to_supplier`: who it went back to, and their reference. */
  readonly supplierId?: string;
  readonly supplierRef?: string | null;
}

/** Where a held unit stands: still held, out for repair, or closed by a decision. */
export type HeldState = 'held' | 'at_repair' | 'restocked' | 'written_off' | 'returned_to_supplier';

export interface HeldWorkItem extends HeldReturnedStock {
  readonly state: HeldState;
  readonly decisions: readonly HeldStockDecision[];
}

export interface HeldStockDecisionDeps {
  readonly held: (tenantId: string) => Promise<readonly HeldReturnedStock[]>;
  readonly decisions: (tenantId: string) => Promise<readonly HeldStockDecision[]>;
  /** The held unit's write-guard version — read BEFORE the decision's authoritative read (two people at once: one lands). */
  readonly guardVersion: (tenantId: string, heldId: string) => Promise<number>;
  /** Append the decision AND its movements (and the write-off record) in ONE batch — all or nothing, idempotent on ids —
   *  only while the held unit's guard is still at `expectedVersion` (else `ConcurrencyConflictError`). */
  readonly commit: (tenantId: string, d: HeldStockDecision, movements: readonly Movement[], writeOff: StoredWriteOff | undefined, expectedVersion: number) => Promise<void>;
  /** The caller's own permissions (a restock needs the quality-release authority). */
  readonly permissionsOf: (tenantId: string, userId: string) => Promise<readonly string[]>;
  /** Open recalls / quality holds on a product's batch — a held unit of a blocked batch is never restocked. */
  readonly batchBlocks: (tenantId: string) => Promise<readonly { readonly productId: string | null; readonly batchId: string; readonly kind: string; readonly reason: string }[]>;
  readonly unitCostAt?: (tenantId: string, locationId: string, productId: string) => Promise<number | undefined> | number | undefined;
  readonly writeOffThreshold: (tenantId: string) => Promise<number | undefined> | number | undefined;
  readonly approvals?: ApprovalPort;
  readonly locationBranches?: LocationBranches;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isNonNegInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

/** Fold the decisions on one unit into where it stands. The last closing decision wins; there is only ever one. */
export function heldStateOf(decisions: readonly HeldStockDecision[]): HeldState {
  let state: HeldState = 'held';
  for (const d of decisions) {
    if (d.decision === 'repair') state = 'at_repair';
    else state = d.decision === 'restock' ? 'restocked' : d.decision === 'write_off' ? 'written_off' : 'returned_to_supplier';
  }
  return state;
}

const OPEN: readonly HeldState[] = ['held', 'at_repair'];

export function heldStockDecisionRoutes(deps: HeldStockDecisionDeps): readonly Route[] {
  const worklist = async (tenantId: string): Promise<readonly HeldWorkItem[]> => {
    const [held, decisions] = await Promise.all([deps.held(tenantId), deps.decisions(tenantId)]);
    return held.map((h) => {
      const mine = decisions.filter((d) => d.heldId === h.heldId);
      return { ...h, state: heldStateOf(mine), decisions: mine };
    });
  };
  const refuse = (status: number, code: string, whatHappened: string, nextSafeAction: string): never => {
    throw apiError(status, { code, whatHappened, wasItSaved: 'not_saved', nextSafeAction });
  };

  return [
    {
      // The work list: every held unit with where it stands and every decision on it; the ones still waiting first.
      // ?state=open narrows it to what a person still has to decide.
      api: 'API-05', method: 'GET', path: '/v1/returns/held-stock/worklist',
      permission: 'quality.hold.manage',
      handler: async (ctx) => {
        const all = await worklist(ctx.tenantId);
        const wantOpen = ctx.query['state'] === 'open';
        const items = [...all.filter((i) => OPEN.includes(i.state)), ...(wantOpen ? [] : all.filter((i) => !OPEN.includes(i.state)))];
        return { status: 200, body: { count: items.length, open: all.filter((i) => OPEN.includes(i.state)).length, items, asAt: deps.now() } };
      },
    },
    {
      // A person decides one held unit: restock / write_off / return_to_supplier / repair. Refused → 4xx, nothing written.
      api: 'API-05', method: 'POST', path: '/v1/returns/held-stock/:heldId/decisions/:decisionId',
      permission: 'quality.hold.manage', idempotent: true,
      handler: async (ctx) => {
        const heldId = (ctx.params['heldId'] ?? '').trim();
        const decisionId = (ctx.params['decisionId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const decision = b['decision'] as HeldDecisionKind;
        if (decisionId === '' || !HELD_DECISIONS.includes(decision) || !isStr(b['reasonCode'])
          || (b['note'] !== undefined && typeof b['note'] !== 'string')
          || (b['locationId'] !== undefined && !isStr(b['locationId']))
          || (b['evidenceRef'] !== undefined && !isStr(b['evidenceRef']))
          || (b['valueMinor'] !== undefined && !isNonNegInt(b['valueMinor']))
          || (b['lossType'] !== undefined && !LOSS_TYPES.includes(b['lossType'] as LossType))
          || (decision === 'return_to_supplier' && !isStr(b['supplierId']))) {
          refuse(400, 'not_readable_as_a_held_stock_decision',
            'A decision on a held returned unit needs a decision (restock, write_off, return_to_supplier or repair) and a reasonCode; a return to supplier also names the supplierId.',
            'Send the decision with its reason. Nothing was recorded and no stock moved.');
        }
        // Read the unit's guard FIRST: a second person deciding the same unit at the same moment is refused by name.
        const version = await deps.guardVersion(ctx.tenantId, heldId);
        const items = await worklist(ctx.tenantId);
        const item = items.find((i) => i.heldId === heldId);
        if (item === undefined) refuse(404, 'held_unit_not_found', `No returned unit ${heldId} is held.`, 'Check the held-stock list. Nothing was recorded.');
        const unit = item!;

        // The same decision re-sent (a lost reply): the same answer, nothing appended again. A decision id reused for
        // something else is refused by name.
        const prior = items.flatMap((i) => i.decisions).find((d) => d.decisionId === decisionId);
        if (prior !== undefined) {
          if (prior.heldId === heldId && prior.decision === decision) return { status: 200, body: { decision: prior, state: unit.state, alreadyRecorded: true } };
          refuse(409, 'decision_id_reused', `Decision ${decisionId} is already recorded for ${prior.heldId} (${prior.decision}).`, 'Use a new decision id. Nothing was changed.');
        }
        if (!OPEN.includes(unit.state)) {
          const closing = unit.decisions[unit.decisions.length - 1]!;
          refuse(409, 'held_unit_already_decided', `This unit was already decided: ${closing.decision.replace(/_/g, ' ')} by ${closing.decidedBy} at ${closing.decidedAt}. That decision stands.`,
            'A correction is a new compensating stock movement through its own governed route. Nothing was changed.');
        }
        if (decision === 'repair' && unit.state === 'at_repair') {
          refuse(409, 'held_unit_already_at_repair', 'This unit is already out for repair.', 'Record what came back: restock, write off or return to supplier. Nothing was changed.');
        }

        // Where the unit is. The return named its place; where it did not, the person deciding says it.
        const locationId = unit.locationId ?? (isStr(b['locationId']) ? (b['locationId'] as string).trim() : null);
        if (decision !== 'repair' && locationId === null) {
          refuse(422, 'held_unit_location_needed', 'The return did not say where this unit came back, so the stock cannot be moved without knowing the place.', 'Send locationId — where the unit is now. Nothing was recorded.');
        }
        if (locationId !== null) await assertLocationInScope(ctx, locationId, deps.locationBranches);

        const at = deps.now();
        const base = {
          decisionId, heldId, returnId: unit.returnId, productId: unit.productId, uom: unit.uom, quantityMinor: unit.quantityMinor,
          batchId: unit.batchId, locationId, decision, reasonCode: (b['reasonCode'] as string).trim(),
          note: typeof b['note'] === 'string' && b['note'].trim() !== '' ? b['note'].trim() : null, decidedBy: ctx.userId, decidedAt: at,
        };
        const batch = unit.batchId === null ? {} : { batchId: unit.batchId };
        const inbound = (): Movement => ({
          movementId: `held-${heldId}-in`, productId: unit.productId, locationId: locationId!, kind: 'returned', quantityMinor: unit.quantityMinor,
          uom: unit.uom, occurredAt: at, enteredBy: ctx.userId, ...batch,
          reason: `returned unit ${heldId} (return ${unit.returnId}) — ${decision.replace(/_/g, ' ')}: ${base.reasonCode}`,
        });

        let record: HeldStockDecision;
        let movements: Movement[] = [];
        let writeOff: StoredWriteOff | undefined;
        let opened: Awaited<ReturnType<typeof approvalNamedIn>>;

        if (decision === 'restock') {
          // QC's release back to sale (M10 · §28): only a person holding the quality-release authority.
          if (!(await deps.permissionsOf(ctx.tenantId, ctx.userId)).includes('quality.hold.release')) {
            refuse(403, 'restock_needs_quality_release', 'Putting a returned unit back on sale is a quality release, and you do not hold that authority.', 'Ask a person who may release stock from quality hold. Nothing was recorded.');
          }
          if (unit.batchId !== null) {
            const blocked = (await deps.batchBlocks(ctx.tenantId)).find((x) => x.batchId === unit.batchId && (x.productId === null || x.productId === unit.productId));
            if (blocked !== undefined) {
              refuse(422, 'batch_blocked_from_sale', `Batch ${unit.batchId} of ${unit.productId} is under ${blocked.kind === 'recall' ? 'an open recall' : 'a quality hold'} (${blocked.reason}). It cannot go back on sale.`,
                'Write it off or return it to the supplier, or wait until the recall/hold is closed. Nothing was recorded.');
            }
          }
          movements = [{ ...inbound(), movementId: `held-${heldId}-restock` }];
          record = { ...base, movementIds: movements.map((m) => m.movementId) };
        } else if (decision === 'write_off') {
          const perms = await deps.permissionsOf(ctx.tenantId, ctx.userId);
          if (!perms.includes('inventory.movement.append')) {
            refuse(403, 'write_off_needs_stock_authority', 'Writing off stock needs the stock authority, and you do not hold it.', 'Ask a manager. Nothing was recorded.');
          }
          const priced = await lossValueOf(deps, ctx.tenantId, unit.productId, locationId!, unit.quantityMinor, unit.uom);
          if (priced.known && b['valueMinor'] !== undefined && b['valueMinor'] !== priced.valueMinor) {
            refuse(422, 'write_off_value_is_the_stock_cost', `This unit is worth ${priced.valueMinor} paise at head office's own cost; the request said ${b['valueMinor'] as number}. A loss is valued from the stock's cost, never typed.`, 'Send it without a value. Nothing was recorded.');
          }
          if (!priced.known && b['valueMinor'] === undefined) {
            refuse(422, 'write_off_cost_unknown', `Head office holds no cost for ${unit.productId} at ${locationId!}, so it cannot value this loss itself.`, 'State the value you believe it has; the loss then needs a photo or witness and a second person\'s approval. Nothing was recorded.');
          }
          const valueMinor = priced.known ? priced.valueMinor : (b['valueMinor'] as number);
          const thresholdMinor = priced.known ? ((await deps.writeOffThreshold(ctx.tenantId)) ?? DEFAULT_WRITE_OFF_THRESHOLD_MINOR) : 0;
          const material = valueMinor >= thresholdMinor;
          if (material && !isStr(b['evidenceRef'])) {
            refuse(422, 'write_off_needs_evidence', `This loss is worth ${valueMinor} paise${priced.known ? '' : ' (cost unknown)'} — at or above the ${thresholdMinor} paise line — so it needs a photo or witness reference.`, 'Capture the evidence and send it with evidenceRef. Nothing was recorded.');
          }
          opened = await approvalNamedIn(deps.approvals, {
            tenantId: ctx.tenantId, approvalId: b['approvalId'], typedField: 'approvedBy', typedValue: b['approvedBy'],
            kind: 'stock_write_off', subjectRef: `held-${heldId}`, details: actionDetails(ctx.body, { heldId, decisionId }), valueMinor,
            maker: ctx.userId, usedBy: `held-stock-decision:${decisionId}`, now: at,
          });
          if (material && opened === undefined) {
            refuse(422, 'write_off_needs_approval', `This loss is worth ${valueMinor} paise — a material loss needs a second person's approval; the person who raised it cannot approve it (§28).`,
              `Ask for approval (POST /v1/approvals/requests, kind stock_write_off, subject held-${heldId}, with exactly this decision); once another person who handles stock approves it, re-send with the approvalId. Nothing was recorded.`);
          }
          const writeOffId = `held-${heldId}`;
          const lossType = (b['lossType'] as LossType | undefined) ?? (unit.disposition === 'damaged' ? 'damage' : 'destruction');
          const evidenceRef = isStr(b['evidenceRef']) ? (b['evidenceRef'] as string) : null;
          const approvedBy = opened === undefined ? null : opened.decision.decidedBy;
          movements = [inbound(), {
            movementId: `writeoff-${writeOffId}`, productId: unit.productId, locationId: locationId!, kind: 'wasted', quantityMinor: unit.quantityMinor,
            uom: unit.uom, occurredAt: at, enteredBy: ctx.userId, ...batch, reason: base.reasonCode, ...(approvedBy === null ? {} : { approvedBy }),
          }];
          writeOff = {
            id: writeOffId, productId: unit.productId, locationId: locationId!, lossType, qtyRemoved: unit.quantityMinor, uom: unit.uom,
            valueMinor, currency: 'INR', reasonCode: base.reasonCode, requiredApproval: material, evidenceRef, raisedBy: ctx.userId, approvedBy, at,
            valueSource: priced.known ? 'stock_cost' : 'cost_unknown', ...(priced.known ? { unitCostMinor: priced.unitCostMinor } : {}),
          };
          record = {
            ...base, movementIds: movements.map((m) => m.movementId), valueMinor, valueSource: writeOff.valueSource!, approvedBy, evidenceRef, writeOffId,
          };
        } else if (decision === 'return_to_supplier') {
          const supplierId = (b['supplierId'] as string).trim();
          const supplierRef = isStr(b['supplierRef']) ? (b['supplierRef'] as string).trim() : null;
          movements = [inbound(), {
            movementId: `held-${heldId}-to-supplier`, productId: unit.productId, locationId: locationId!, kind: 'returned_to_supplier', quantityMinor: unit.quantityMinor,
            uom: unit.uom, occurredAt: at, enteredBy: ctx.userId, ...batch, reason: `returned to supplier ${supplierId}${supplierRef === null ? '' : ` (${supplierRef})`}: ${base.reasonCode}`,
          }];
          record = { ...base, movementIds: movements.map((m) => m.movementId), supplierId, supplierRef };
        } else {
          record = { ...base, movementIds: [] };
        }

        // Every rule passed: a material loss's approval is spent — once — then the decision lands under the unit's guard
        // (a second person deciding the same unit at the same moment is refused by name; nothing of theirs is written).
        await opened?.spend();
        try {
          await deps.commit(ctx.tenantId, record, movements, writeOff, version);
        } catch (e) {
          if (e instanceof ConcurrencyConflictError) throw concurrentChange(`held returned unit ${heldId}`);
          throw e;
        }
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'returns.held_stock.decided', objectType: 'held_returned_unit', objectId: heldId,
          at, origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: { state: unit.state },
          after: {
            decision, reasonCode: record.reasonCode, quantityMinor: String(unit.quantityMinor), productId: unit.productId,
            ...(record.valueMinor === undefined ? {} : { valueMinor: String(record.valueMinor) }),
            ...(record.approvedBy === undefined || record.approvedBy === null ? {} : { approvedBy: record.approvedBy }),
            ...(record.supplierId === undefined ? {} : { supplierId: record.supplierId }),
          },
          correlationId: decisionId,
        });
        return { status: 201, body: { decision: record, state: heldStateOf([...unit.decisions, record]) } };
      },
    },
  ];
}
