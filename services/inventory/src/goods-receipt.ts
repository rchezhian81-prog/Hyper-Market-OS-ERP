// API-04 Goods receipt / GRN capture (M07-FR-01/02/03 · D03-FR-02) — the back door of the shop, where most
// of the money is actually lost, made a durable cloud record. Receiving is captured on the handheld offline
// (§31); on sync a GRN reaches here, and this is the central boundary that turns a delivery into trusted
// stock and a visible, valued, owned discrepancy for everything that did not arrive as ordered:
//
//   • it trusts no client verdict — it re-runs the tested `captureReceipt` (the FR-02/03 gate): a
//     batch-tracked item with no batch or no expiry is REFUSED (you cannot recall what you cannot identify,
//     M10); already-expired stock is rejected, never received as sellable; damaged / QC-failed / cold-chain-
//     broken stock goes to QUARANTINE (deliberately not available to sell, M07-FR-03); a short/excess/
//     MRP-mismatch/near-expiry line raises a valued discrepancy;
//   • it trusts no client RULE either (SP-4 (ii), audit finding F03): the product's batch-tracking rule comes
//     from head office's product master and the tolerance policy from the tenant's own receipt policy — a body
//     that names either is refused outright (`receipt_carries_caller_claims`). Where head office does not hold
//     a fact it says so as a FLAG on the record and falls back safely (untracked; the default policy), rather
//     than refusing a delivery that is physically in the building;
//   • an over-tolerance EXCESS is HELD (F03): the ordered quantity becomes stock, the excess is counted and on
//     the GRN but not sellable until a SECOND person — never the receiver (§28) — approves accepting it, when it
//     is released as its own inbound movement, once; a rejection leaves it for the supplier claim (SP-6);
//   • only the SELLABLE quantity of each line becomes availability — one inbound `received` movement per
//     sellable line (quarantine/rejected/held excluded, M08 status), the delivered unit cost carried so the
//     stock re-averages at what it cost (M08-FR-04). The GRN record and its movements are one ATOMIC append
//     (FND-01);
//   • it is idempotent on the GRN id — a re-scan or a re-sync collapses to one effect (§31.1), so a delivery
//     is never double-counted.
//
// The rule is the tested `captureReceipt`/`availableFromReceipt`/`heldFromReceipt` in `@sre/receiving` (the
// `services-run-on-their-tested-engine` guardrail); this file is the persistence + HTTP skin. Receiving is
// gated `inventory.movement.append` (Receiver/QC; the route never touches the PO price); deciding a held excess
// is `inventory.adjustment.approve` (the supervisor's authority); the tolerance policy is the owner's
// (`inventory.receipt.policy.set/read`); reads are `inventory.availability.read`. The three-way PO-GRN-invoice
// match (FR-04) reads these GRNs.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import {
  captureReceipt, availableFromReceipt, heldFromReceipt, IncompleteCaptureError,
  type CapturedLine, type CheckedLine, type ProductReceiptRules, type ReceiptPolicy, type CapturedReceipt,
} from '../../../packages/receiving/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import type { Movement } from './index';

/** The tolerance policy applied when the tenant has set none — and the record says so (`default_policy`). */
export const DEFAULT_RECEIPT_POLICY: ReceiptPolicy = Object.freeze({ excessToleranceBp: 0, shortageToleranceBp: 0, nearExpiryDays: 30 });

/** What head office could not verify about a receipt — said on the record, never silent (P-08). */
export const RECEIPT_FLAGS = Object.freeze([
  'receiver_unknown', 'receiver_lacks_authority', 'product_rules_unverified', 'cost_unknown',
  'no_purchase_order', 'order_unknown', 'default_policy',
] as const);
export type ReceiptFlag = (typeof RECEIPT_FLAGS)[number];

/** The tenant's receiving tolerances as SET — who chose them and when, beside the numbers (F03). */
export interface StoredReceiptPolicy extends ReceiptPolicy {
  readonly setBy: string;
  readonly setAt: string;
}

/** The decided state of a HELD over-tolerance excess (F03 · §28) — a second person's call, recorded once. */
export interface ExcessDecision {
  readonly decision: 'approved' | 'rejected';
  readonly decidedBy: string;
  readonly decidedAt: string;
  readonly reason: string;
  /** Released to stock on approval; 0 on a rejection (the goods go back to the supplier — the SP-6 claim). */
  readonly releasedMinor: number;
  readonly movementIds: readonly string[];
  /** How the decision arrived: on the decide route, or relayed from the manager's screen through the box. */
  readonly via: 'direct' | 'relayed';
}

/** A committed goods receipt — the durable GRN record, carrying the checked outcome. */
export interface GrnRecord {
  readonly grnId: string;
  readonly number: string;
  readonly poId: string | null;
  readonly warehouseId: string;
  readonly receivedBy: string;
  readonly receivedAt: string;
  readonly captured: CapturedReceipt;
  /** Total quantity that became available to sell (quarantine / rejected / held excess excluded). */
  readonly availableMinor: number;
  /** F03 — the over-tolerance excess HELD on this receipt: counted, in the building, not sellable until decided. */
  readonly heldMinor: number;
  /** F03 — set once a second person has decided the held excess; absent while it waits (or when nothing is held). */
  readonly excessDecision?: ExcessDecision;
  /** What head office's own records could not confirm about this receipt (a `ReceiptFlag` each). */
  readonly governanceFlags?: readonly string[];
  /** SP-2b — the identity that relayed it (the store box), the surface, and the store, when relayed. */
  readonly relayedBy?: string;
  readonly source?: string;
  readonly storeId?: string | null;
}

export interface GoodsReceiptDeps {
  /** The GRN with this id, or undefined — for the idempotency (never-double-count) check. */
  readonly grn: (tenantId: string, grnId: string) => Promise<GrnRecord | undefined> | GrnRecord | undefined;
  /** Every GRN — the receiving / discrepancy review surface. */
  readonly all: (tenantId: string) => Promise<readonly GrnRecord[]> | readonly GrnRecord[];
  /** Record the GRN and its inbound movements as ONE atomic append (FND-01). */
  readonly commit: (tenantId: string, record: GrnRecord, movements: readonly Movement[], key: string) => Promise<void> | void;
  readonly now: () => string;
  /** F03 — the product's receiving rules from the PRODUCT MASTER; `undefined` when the product is not on it. */
  readonly productRule: (tenantId: string, productId: string) => Promise<ProductReceiptRules | undefined> | ProductReceiptRules | undefined;
  /** F03 — the tenant's receiving tolerance policy, or `undefined` when none has been set (the default applies, flagged). */
  readonly receiptPolicy: (tenantId: string) => Promise<StoredReceiptPolicy | undefined> | StoredReceiptPolicy | undefined;
  readonly recordReceiptPolicy: (tenantId: string, policy: StoredReceiptPolicy) => Promise<void> | void;
  /** F03 — record the excess decision and, on approval, the released movements as ONE atomic append (FND-01). */
  readonly commitExcessDecision: (tenantId: string, record: GrnRecord, movements: readonly Movement[], key: string) => Promise<void> | void;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isNonNegInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isMoney = (v: unknown): v is { minor: number; currency: string } => isObj(v) && isNum(v['minor']) && isStr(v['currency']);

const isCapturedLine = (v: unknown): v is CapturedLine =>
  isObj(v) && isStr(v['lineId']) && isStr(v['productId']) && isNum(v['orderedMinor']) && isNum(v['countedMinor'])
  && isStr(v['uom']) && isMoney(v['unitCost']) && isStr(v['condition']);

/**
 * The product master's rules for every product on a receipt — head office's, never the body's (F03). A product the
 * master does not know is SAID (`unverified`) and falls back to untracked rather than refusing goods in the building.
 */
export async function rulesFromMaster(
  deps: Pick<GoodsReceiptDeps, 'productRule'>, tenantId: string, productIds: Iterable<string>,
): Promise<{ readonly rules: readonly ProductReceiptRules[]; readonly unverified: boolean }> {
  const rules: ProductReceiptRules[] = [];
  let unverified = false;
  for (const productId of new Set(productIds)) {
    const rule = await deps.productRule(tenantId, productId);
    if (rule === undefined) { unverified = true; rules.push({ productId, batchTracked: false }); } else rules.push(rule);
  }
  return { rules, unverified };
}

/** The tenant's tolerance policy in force — theirs when set, otherwise the default and `defaulted` so the record says so. */
export async function policyInForce(
  deps: Pick<GoodsReceiptDeps, 'receiptPolicy'>, tenantId: string,
): Promise<{ readonly policy: ReceiptPolicy; readonly defaulted: boolean }> {
  const set = await deps.receiptPolicy(tenantId);
  return set === undefined ? { policy: DEFAULT_RECEIPT_POLICY, defaulted: true } : { policy: set, defaulted: false };
}

/**
 * Inbound `received` movements for the lines of a receipt — the ONE shape the direct capture, the relayed capture and the
 * release of a held excess all append, so the availability projection folds them exactly alike (mv-<grnId>:<lineId>[:excess]).
 */
export function inboundMovements(input: {
  readonly grnId: string;
  readonly locationId: string;
  readonly lines: readonly CheckedLine[];
  readonly quantityOf: (line: CheckedLine) => number;
  readonly suffix?: string;
  readonly occurredAt: string;
  readonly enteredBy: string;
  readonly approvedBy?: string;
  /** The unit cost to carry — `undefined` leaves the movement unvalued rather than folding at ₹0. */
  readonly unitCostMinorOf: (line: CheckedLine) => number | undefined;
}): Movement[] {
  return input.lines
    .filter((l) => input.quantityOf(l) > 0)
    .map((l) => {
      const unitCostMinor = input.unitCostMinorOf(l);
      return {
        movementId: `${input.grnId}:${l.lineId}${input.suffix ?? ''}`,
        productId: l.productId,
        locationId: input.locationId,
        kind: 'received' as const,
        quantityMinor: input.quantityOf(l),
        uom: l.uom,
        occurredAt: input.occurredAt,
        enteredBy: input.enteredBy,
        ...(input.approvedBy === undefined ? {} : { approvedBy: input.approvedBy }),
        ...(l.batchId !== null ? { batchId: l.batchId } : {}),
        // Carry the captured batch expiry onto the ledger (ADR-0015) — cloud-only, feeds near-expiry reads.
        ...(l.expiry !== null ? { expiry: l.expiry } : {}),
        ...(unitCostMinor === undefined ? {} : { unitCostMinor }),
      };
    });
}

/** Which receipts still wait for a person: a held excess with no decision, or a non-excess discrepancy needing approval (SP-6 disposition). */
export const awaitsDecision = (g: GrnRecord): boolean =>
  (g.heldMinor > 0 && g.excessDecision === undefined)
  || g.captured.discrepancies.some((d) => d.requiresApproval && d.kind !== 'excess');

export type ExcessDecisionOutcome =
  | { readonly ok: true; readonly record: GrnRecord; readonly alreadyDecided: boolean }
  | { readonly ok: false; readonly refusedBecause: string; readonly detail: string };

/**
 * Decide a HELD over-tolerance excess (F03 · §28) — the ONE code path for the direct decide route and a decision relayed
 * from the manager's screen. Approval releases the held quantity as its own inbound movement per line, once; a rejection
 * records the refusal and leaves the goods for the supplier claim. The receiver can never decide their own receipt.
 */
export async function decideReceiptExcess(deps: GoodsReceiptDeps, input: {
  readonly tenantId: string; readonly grnId: string; readonly decidedBy: string;
  readonly decision: 'approved' | 'rejected'; readonly reason: string; readonly branchId: string | null;
  readonly via: 'direct' | 'relayed';
}): Promise<ExcessDecisionOutcome> {
  const rec = await deps.grn(input.tenantId, input.grnId);
  if (rec === undefined) return { ok: false, refusedBecause: 'receipt_unknown', detail: `No goods receipt ${input.grnId} is on file here.` };
  if (rec.heldMinor <= 0) return { ok: false, refusedBecause: 'receipt_holds_no_excess', detail: `Receipt ${input.grnId} holds no over-tolerance excess — there is nothing to decide.` };
  if (rec.receivedBy === input.decidedBy) return { ok: false, refusedBecause: 'self_approval', detail: `${input.decidedBy} received this delivery and cannot decide its excess (§28 separation of duties).` };
  if (rec.excessDecision !== undefined) {
    if (rec.excessDecision.decision === input.decision) return { ok: true, record: rec, alreadyDecided: true };
    return { ok: false, refusedBecause: 'excess_already_decided', detail: `The excess on ${input.grnId} was already ${rec.excessDecision.decision} by ${rec.excessDecision.decidedBy} at ${rec.excessDecision.decidedAt}; a different decision now would be a second truth.` };
  }
  const decidedAt = deps.now();
  const movements: Movement[] = input.decision === 'approved'
    ? inboundMovements({
      grnId: rec.grnId, locationId: rec.warehouseId, lines: rec.captured.lines, quantityOf: (l) => l.heldMinor, suffix: ':excess',
      occurredAt: decidedAt, enteredBy: rec.receivedBy, approvedBy: input.decidedBy,
      // A relayed receipt whose cost head office never held was captured at ₹0 — release it unvalued too, not at ₹0.
      unitCostMinorOf: (l) => (l.unitCost.minor > 0 ? l.unitCost.minor : undefined),
    })
    : [];
  const releasedMinor = movements.reduce((s, m) => s + m.quantityMinor, 0);
  const decided: GrnRecord = {
    ...rec,
    availableMinor: rec.availableMinor + releasedMinor,
    excessDecision: {
      decision: input.decision, decidedBy: input.decidedBy, decidedAt, reason: input.reason,
      releasedMinor, movementIds: movements.map((m) => m.movementId), via: input.via,
    },
  };
  await deps.commitExcessDecision(input.tenantId, decided, movements, `${rec.grnId}:excess`);
  await deps.recordAudit?.(input.tenantId, {
    actorId: input.decidedBy, action: input.decision === 'approved' ? 'receipt.excess.approve' : 'receipt.excess.reject',
    objectType: 'goods_receipt', objectId: rec.grnId,
    at: decidedAt, origin: { tenantId: input.tenantId, branchId: input.branchId },
    before: { heldMinor: String(rec.heldMinor), availableMinor: String(rec.availableMinor) },
    after: {
      decision: input.decision, receivedBy: rec.receivedBy, releasedMinor: String(releasedMinor),
      availableMinor: String(decided.availableMinor), movementIds: movements.map((m) => m.movementId).join(','), via: input.via,
    },
    reason: input.reason, correlationId: rec.grnId,
  });
  return { ok: true, record: decided, alreadyDecided: false };
}

export function goodsReceiptRoutes(deps: GoodsReceiptDeps): readonly Route[] {
  return [
    {
      // Capture a goods receipt. Body: { number?, poId, warehouseId, receivedOnDate, currency, lines[] }. The product
      // rules and the tolerance policy are head office's own — a body naming them is refused (F03). Idempotent on the
      // GRN id in the path.
      api: 'API-04', method: 'POST', path: '/v1/inventory/goods-receipt/:grnId',
      permission: 'inventory.movement.append', idempotent: true,
      handler: async (ctx) => {
        const grnId = (ctx.params['grnId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        // SP-4 (ii) / F03: nothing in the body may decide what is tracked or what is tolerated.
        if (b['rules'] !== undefined || b['policy'] !== undefined) {
          throw apiError(400, {
            code: 'receipt_carries_caller_claims',
            whatHappened: 'This receipt names its own product rules and/or tolerance policy. Head office decides both — from the product master and the tenant\'s receipt policy — never the sender.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the counted lines only. Nothing was changed.',
          });
        }
        const lines = b['lines'];
        if (grnId === '' || !isStr(b['warehouseId']) || !isStr(b['receivedOnDate']) || !isStr(b['currency'])
          || !Array.isArray(lines) || lines.length === 0 || !lines.every(isCapturedLine)) {
          throw apiError(400, {
            code: 'not_readable_as_a_goods_receipt',
            whatHappened: 'A goods receipt needs a grnId in the path, and { warehouseId, receivedOnDate, currency, lines[] (each with lineId/productId/orderedMinor/countedMinor/uom/unitCost/condition) } in the body.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the counted lines. The product rules and tolerances are head office\'s own.',
          });
        }
        // Never double-count: a GRN already recorded is returned unchanged (a re-scan / re-sync, §31.1).
        const existing = await deps.grn(ctx.tenantId, grnId);
        if (existing !== undefined) {
          return { status: 200, body: { grn: existing, alreadyReceived: true, flags: existing.governanceFlags ?? [] } };
        }
        // The product master's rules and the tenant's policy — never the body (F03). Unknown is SAID, then the safe fallback.
        const flags: ReceiptFlag[] = [];
        const master = await rulesFromMaster(deps, ctx.tenantId, (lines as CapturedLine[]).map((l) => l.productId));
        if (master.unverified) flags.push('product_rules_unverified');
        const inForce = await policyInForce(deps, ctx.tenantId);
        if (inForce.defaulted) flags.push('default_policy');
        // The FR-02/03 gate — the SAME tested rule the handheld ran, re-run here (a boundary trusts no client
        // verdict): batch/expiry mandatory, discrepancies valued, disposition sellable/quarantine/rejected, excess held.
        let captured: CapturedReceipt;
        try {
          captured = captureReceipt({
            receiptId: grnId,
            lines: lines as CapturedLine[],
            rules: master.rules,
            policy: inForce.policy,
            receivedOnDate: b['receivedOnDate'] as string,
            // Validated as a non-empty string above; the engine treats an unknown code as its own currency.
            currency: b['currency'] as CapturedReceipt['discrepancyValue']['currency'],
          });
        } catch (err) {
          if (err instanceof IncompleteCaptureError) {
            throw apiError(422, {
              code: 'receipt_line_incomplete',
              whatHappened: `${err.message}. A line that cannot be identified cannot be received (M10 / M07-FR-02).`,
              wasItSaved: 'not_saved',
              nextSafeAction: 'Capture the missing detail (a batch-tracked item needs a batch AND an expiry; a cold-chain item needs a temperature) and receive again.',
            });
          }
          throw err;
        }
        const receivedAt = deps.now();
        const record: GrnRecord = {
          grnId,
          number: isStr(b['number']) ? b['number'] : grnId,
          poId: isStr(b['poId']) ? b['poId'] : null,
          warehouseId: b['warehouseId'],
          receivedBy: ctx.userId, // server-attributed — the receiver the kernel authenticated
          receivedAt,
          captured,
          availableMinor: availableFromReceipt(captured),
          heldMinor: heldFromReceipt(captured),
          governanceFlags: flags,
        };
        // Only the SELLABLE quantity becomes availability; quarantine / rejected / held are on the GRN but not on-hand.
        const movements = inboundMovements({
          grnId, locationId: record.warehouseId, lines: captured.lines, quantityOf: (l) => l.sellableMinor,
          occurredAt: receivedAt, enteredBy: ctx.userId, unitCostMinorOf: (l) => l.unitCost.minor,
        });
        await deps.commit(ctx.tenantId, record, movements, ctx.idempotencyKey ?? grnId);
        return { status: 201, body: { grn: record, flags } };
      },
    },
    {
      // Decide a HELD over-tolerance excess (F03 · §28): a second person accepts it (released to stock, once) or
      // refuses it (left for the supplier claim). Body: { decision: approved|rejected, reason }.
      api: 'API-04', method: 'POST', path: '/v1/inventory/goods-receipt/:grnId/excess/decide',
      permission: 'inventory.adjustment.approve', idempotent: true,
      handler: async (ctx) => {
        const grnId = (ctx.params['grnId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const decision = b['decision'];
        if (grnId === '' || (decision !== 'approved' && decision !== 'rejected') || !isStr(b['reason'])) {
          throw apiError(400, {
            code: 'not_readable_as_an_excess_decision',
            whatHappened: 'Deciding a held excess needs the grnId in the path, a decision of approved or rejected, and a reason.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send { decision, reason }. Nothing was changed.',
          });
        }
        const out = await decideReceiptExcess(deps, {
          tenantId: ctx.tenantId, grnId, decidedBy: ctx.userId, decision, reason: b['reason'].trim(), branchId: ctx.branchId ?? null, via: 'direct',
        });
        if (!out.ok) {
          const status = out.refusedBecause === 'receipt_unknown' ? 404
            : out.refusedBecause === 'excess_already_decided' || out.refusedBecause === 'receipt_holds_no_excess' ? 409 : 422;
          throw apiError(status, {
            code: out.refusedBecause, whatHappened: out.detail, wasItSaved: 'not_saved',
            nextSafeAction: out.refusedBecause === 'self_approval' ? 'A different person with approval authority must decide it. Nothing was changed.'
              : out.refusedBecause === 'receipt_unknown' ? 'Check the store has synchronised — the receipt may still be on the store computer.'
                : out.refusedBecause === 'excess_already_decided' ? 'The earlier decision stands. Raise an adjustment request if the position is wrong. Nothing was changed.'
                  : 'Nothing was changed.',
          });
        }
        const d = out.record.excessDecision;
        return {
          status: 200,
          body: {
            grnId, decision: d?.decision, releasedMinor: d?.releasedMinor ?? 0, movementIds: d?.movementIds ?? [],
            decidedBy: d?.decidedBy, decidedAt: d?.decidedAt, availableMinor: out.record.availableMinor, heldMinor: out.record.heldMinor,
            alreadyDecided: out.alreadyDecided,
          },
        };
      },
    },
    {
      // Read one GRN — the receipt and its checked outcome. 404 when the GRN id is unknown.
      api: 'API-04', method: 'GET', path: '/v1/inventory/goods-receipt/:grnId',
      permission: 'inventory.availability.read',
      handler: async (ctx) => {
        const grnId = (ctx.params['grnId'] ?? '').trim();
        const record = await deps.grn(ctx.tenantId, grnId);
        if (record === undefined) throw notFound(`goods receipt ${grnId}`);
        return { status: 200, body: { grn: record, awaitsDecision: awaitsDecision(record) } };
      },
    },
    {
      // Every GRN — the ones still waiting for a second person first (control by exception, P-03).
      api: 'API-04', method: 'GET', path: '/v1/inventory/goods-receipt',
      permission: 'inventory.availability.read',
      handler: async (ctx) => {
        const all = [...(await deps.all(ctx.tenantId))];
        const waiting = all.filter(awaitsDecision);
        const ordered = [...waiting, ...all.filter((g) => !awaitsDecision(g))];
        return {
          status: 200,
          body: {
            receipts: ordered, count: ordered.length, needingApprovalCount: waiting.length,
            heldExcessCount: all.filter((g) => g.heldMinor > 0 && g.excessDecision === undefined).length,
          },
        };
      },
    },
    {
      // The tenant's receiving tolerances (F03) — the owner's call, read by the capture routes, never the body's.
      // Body: { excessToleranceBp, shortageToleranceBp, nearExpiryDays, coldChainMaxC? }.
      api: 'API-04', method: 'POST', path: '/v1/inventory/receipt-policy',
      permission: 'inventory.receipt.policy.set', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const cold = b['coldChainMaxC'];
        if (!isNonNegInt(b['excessToleranceBp']) || !isNonNegInt(b['shortageToleranceBp']) || !isNonNegInt(b['nearExpiryDays'])
          || !(cold === undefined || isNum(cold))) {
          throw apiError(400, {
            code: 'not_readable_as_a_receipt_policy',
            whatHappened: 'A receipt policy needs whole, non-negative excessToleranceBp, shortageToleranceBp and nearExpiryDays (and an optional coldChainMaxC in °C).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send { excessToleranceBp, shortageToleranceBp, nearExpiryDays }. Nothing was changed.',
          });
        }
        const policy: StoredReceiptPolicy = {
          excessToleranceBp: b['excessToleranceBp'], shortageToleranceBp: b['shortageToleranceBp'], nearExpiryDays: b['nearExpiryDays'],
          ...(isNum(cold) ? { coldChainMaxC: cold } : {}),
          setBy: ctx.userId, setAt: deps.now(),
        };
        await deps.recordReceiptPolicy(ctx.tenantId, policy);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'receipt.policy.set', objectType: 'receipt_policy', objectId: ctx.tenantId,
          at: policy.setAt, origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: null,
          after: { excessToleranceBp: String(policy.excessToleranceBp), shortageToleranceBp: String(policy.shortageToleranceBp), nearExpiryDays: String(policy.nearExpiryDays) },
          correlationId: `receipt-policy-${ctx.tenantId}`,
        });
        return { status: 201, body: { policy } };
      },
    },
    {
      api: 'API-04', method: 'GET', path: '/v1/inventory/receipt-policy',
      permission: 'inventory.receipt.policy.read',
      handler: async (ctx) => {
        const policy = await deps.receiptPolicy(ctx.tenantId);
        return { status: 200, body: { policy: policy ?? null, defaultPolicy: DEFAULT_RECEIPT_POLICY, inForce: policy ?? DEFAULT_RECEIPT_POLICY } };
      },
    },
  ];
}
