// API-04 Goods receipt RELAYED from a store screen (M07-FR-01/02 · §28 · §31 — SP-2b, audit finding F11).
//
// The manager books a delivery in on the manager screen — offline, at the back door. Until SP-2b that receipt raised
// stock on the screen's own in-memory ledger and queued a `GoodsReceived` with nothing but a line COUNT; nothing ever
// carried it anywhere (F11). Now the whole receipt travels the shared path — device queue → box → here under the
// store's sync credential — and this route makes it a trusted cloud GRN the same way the handheld's direct capture is:
//
//   • it trusts the FACT: who booked what in, where, when (the relayed `receivedBy` is the receiver; the relay — the
//     box — is recorded beside them, never as the receiver, hard rule #4);
//   • it OWNS every judgement the screen must not make: the product's batch-tracking rule comes from the product
//     master, the unit cost from the cloud's own valuation, the ordered quantities from the purchase order, the
//     tolerance policy from the tenant — never from the body (F03/F07). Where the cloud does not hold a fact it says so
//     as a FLAG on the record and falls back safely (untracked, cost unknown → unvalued, ordered = counted), rather
//     than refusing a delivery that is physically in the building;
//   • it re-runs the tested `captureReceipt` (batch/expiry mandatory for tracked items — a line that cannot be
//     identified is 422, which the box dead-letters visibly for a person; disposition sellable/quarantine/rejected;
//     discrepancies valued) and commits the GRN and its `received` movements as ONE atomic append, exactly as the
//     direct route does;
//   • it re-verifies the receiver's authority from their grants (flag, never silent).
// Idempotent per grnId: the same receipt again is 200 `alreadyReceived` — a re-sync never double-counts stock (§31.1).

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  captureReceipt, availableFromReceipt, IncompleteCaptureError,
  type CapturedLine, type ProductReceiptRules, type ReceiptPolicy, type CapturedReceipt,
} from '../../../packages/receiving/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import type { Movement } from './index';
import type { GoodsReceiptDeps, GrnRecord } from './goods-receipt';

/** The tolerance policy applied when the tenant has set none — and the record says so (`default_policy`). */
export const DEFAULT_RECEIPT_POLICY: ReceiptPolicy = Object.freeze({ excessToleranceBp: 0, shortageToleranceBp: 0, nearExpiryDays: 30 });

export const RECEIPT_FLAGS = Object.freeze([
  'receiver_unknown', 'receiver_lacks_authority', 'product_rules_unverified', 'cost_unknown',
  'no_purchase_order', 'order_unknown', 'default_policy',
] as const);
export type ReceiptFlag = (typeof RECEIPT_FLAGS)[number];

export interface SyncedGoodsReceiptDeps extends GoodsReceiptDeps {
  /** The permissions the named user holds through their grants; `undefined` when they hold none (an unknown name). */
  readonly permissionsOfUser: (tenantId: string, userId: string) => Promise<readonly string[] | undefined> | readonly string[] | undefined;
  /** The product's receiving rules from the product master; `undefined` when the product is not on the master. */
  readonly productRule: (tenantId: string, productId: string) => Promise<ProductReceiptRules | undefined> | ProductReceiptRules | undefined;
  /** The cloud's own unit cost for the product (weighted average of what it cost to buy); `undefined` when never costed. */
  readonly unitCostMinor: (tenantId: string, productId: string) => Promise<number | undefined> | number | undefined;
  /** Ordered quantity per product on a purchase order; `undefined` when the PO is unknown to head office. */
  readonly orderedByProduct: (tenantId: string, poId: string) => Promise<Readonly<Record<string, number>> | undefined> | Readonly<Record<string, number>> | undefined;
  /** The tenant's receiving tolerance policy, or `undefined` when none has been set (the default applies, flagged). */
  readonly receiptPolicy: (tenantId: string) => Promise<ReceiptPolicy | undefined> | ReceiptPolicy | undefined;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPosInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;
const isIso = (v: unknown): v is string => isStr(v) && !Number.isNaN(Date.parse(v));

/** The receipt as the manager's screen queued it (`packages/receiving` `GoodsReceived`, SP-2b shape). */
interface RelayedReceipt {
  readonly grnId: string;
  readonly number: string;
  readonly poId: string | null;
  readonly warehouseId: string;
  readonly receivedBy: string;
  readonly receivedAt: string;
  readonly lines: readonly { readonly productId: string; readonly quantityMinor: number; readonly uom: string; readonly batchId: string | null }[];
  readonly storeId: string | null;
  readonly source: string;
}

function readRelayedReceipt(body: unknown): RelayedReceipt | undefined {
  if (!isObj(body)) return undefined;
  if (!isStr(body['grnId']) || !isStr(body['warehouseId']) || !isStr(body['receivedBy']) || !isIso(body['receivedAt'])) return undefined;
  const poId = body['poId'];
  if (!(poId === null || poId === undefined || isStr(poId))) return undefined;
  const rawLines = body['lines'];
  if (!Array.isArray(rawLines) || rawLines.length === 0) return undefined;
  const lines: RelayedReceipt['lines'][number][] = [];
  for (const l of rawLines as unknown[]) {
    if (!isObj(l) || !isStr(l['productId']) || !isPosInt(l['quantityMinor']) || !isStr(l['uom'])) return undefined;
    const batchId = l['batchId'];
    if (!(batchId === null || batchId === undefined || isStr(batchId))) return undefined;
    lines.push({ productId: l['productId'], quantityMinor: l['quantityMinor'], uom: l['uom'], batchId: isStr(batchId) ? batchId : null });
  }
  return {
    grnId: body['grnId'], number: isStr(body['number']) ? body['number'] : body['grnId'],
    poId: isStr(poId) ? poId : null, warehouseId: body['warehouseId'], receivedBy: body['receivedBy'],
    receivedAt: body['receivedAt'], lines,
    storeId: isStr(body['storeId']) ? body['storeId'] : null,
    source: isStr(body['source']) ? body['source'] : 'unknown',
  };
}

export function syncedGoodsReceiptRoutes(deps: SyncedGoodsReceiptDeps): readonly Route[] {
  return [
    {
      api: 'API-04', method: 'POST', path: '/v1/inventory/goods-receipt/:grnId/synced',
      permission: 'inventory.receipt.sync', idempotent: true,
      handler: async (ctx) => {
        const grnId = (ctx.params['grnId'] ?? '').trim();
        const r = readRelayedReceipt(ctx.body);
        if (grnId === '' || r === undefined || r.grnId !== grnId) {
          throw apiError(400, {
            code: 'not_readable_as_a_relayed_receipt',
            whatHappened: 'This payload could not be read as a delivery booked in at the store — it needs the grnId matching the path, warehouseId, receivedBy, receivedAt and at least one line {productId, quantityMinor, uom, batchId|null}.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Do not discard it at the store. Keep it in the queue and raise it — goods that were booked in are in the building.',
          });
        }
        // Never double-count: a GRN already recorded is returned unchanged (a retry after a lost reply, §31.1).
        const existing = await deps.grn(ctx.tenantId, grnId);
        if (existing !== undefined) {
          return { status: 200, body: { grn: existing, alreadyReceived: true, flags: existing.governanceFlags ?? [] } };
        }

        const flags: ReceiptFlag[] = [];
        // Who booked it in — re-verified from THEIR grants, never taken on the relay's word (§28, hard rule #4).
        const permissions = await deps.permissionsOfUser(ctx.tenantId, r.receivedBy);
        if (permissions === undefined) flags.push('receiver_unknown');
        else if (!permissions.includes('inventory.movement.append')) flags.push('receiver_lacks_authority');

        // What was ORDERED — from the purchase order head office holds, never the body. No order → the delivery is
        // received as-is (ordered = counted) and the record says there is no order behind it (the buyer chases it).
        let ordered: Readonly<Record<string, number>> | undefined;
        if (r.poId === null) flags.push('no_purchase_order');
        else {
          ordered = await deps.orderedByProduct(ctx.tenantId, r.poId);
          if (ordered === undefined) flags.push('order_unknown');
        }

        // The product master's rules and the cloud's own cost — never the body (F03/F07). Unknown is SAID, then the
        // safe fallback: untracked, unvalued (the valuation reports the units as unvalued rather than folding at ₹0).
        const rules: ProductReceiptRules[] = [];
        const costByProduct = new Map<string, number>();
        let rulesUnverified = false;
        let costUnknown = false;
        for (const productId of new Set(r.lines.map((l) => l.productId))) {
          const rule = await deps.productRule(ctx.tenantId, productId);
          if (rule === undefined) { rulesUnverified = true; rules.push({ productId, batchTracked: false }); } else rules.push(rule);
          const cost = await deps.unitCostMinor(ctx.tenantId, productId);
          if (cost === undefined) costUnknown = true; else costByProduct.set(productId, cost);
        }
        if (rulesUnverified) flags.push('product_rules_unverified');
        if (costUnknown) flags.push('cost_unknown');
        const policy = (await deps.receiptPolicy(ctx.tenantId)) ?? ((): ReceiptPolicy => { flags.push('default_policy'); return DEFAULT_RECEIPT_POLICY; })();

        const captureLines: CapturedLine[] = r.lines.map((l, i) => ({
          lineId: `${grnId}:${i + 1}`,
          productId: l.productId,
          orderedMinor: ordered?.[l.productId] ?? l.quantityMinor,
          countedMinor: l.quantityMinor,
          uom: l.uom,
          batchId: l.batchId,
          unitCost: { minor: costByProduct.get(l.productId) ?? 0, currency: 'INR' },
          // The manager's screen books goods in as delivered; damage and QC are the dock's capture (handheld / SP-6).
          condition: 'good',
        }));

        // The FR-02/03 gate — the SAME tested rule the handheld and the direct route run. A tracked item with no batch
        // cannot be received (you cannot recall what you cannot identify, M10): 422 → the box dead-letters it for a
        // person, and the manager screen shows "refused" with this reason.
        let captured: CapturedReceipt;
        try {
          captured = captureReceipt({
            receiptId: grnId, lines: captureLines, rules, policy,
            receivedOnDate: r.receivedAt.slice(0, 10), currency: 'INR',
          });
        } catch (err) {
          if (err instanceof IncompleteCaptureError) {
            throw apiError(422, {
              code: 'receipt_line_incomplete',
              whatHappened: `${err.message}. A line that cannot be identified cannot be received (M10 / M07-FR-02).`,
              wasItSaved: 'not_saved',
              nextSafeAction: 'Book the delivery in again with the batch and expiry on that line. This one stays on the store computer for a person to see.',
            });
          }
          throw err;
        }

        const record: GrnRecord = {
          grnId, number: r.number, poId: r.poId, warehouseId: r.warehouseId,
          receivedBy: r.receivedBy, // the RELAYED receiver — the person who booked it in at the store
          receivedAt: r.receivedAt,
          captured, availableMinor: availableFromReceipt(captured),
          governanceFlags: flags, relayedBy: ctx.userId, source: r.source, storeId: r.storeId,
        };
        // Only the SELLABLE quantity becomes availability; quarantine/rejected are on the GRN but not on-hand.
        const movements: Movement[] = captured.lines
          .filter((l) => l.sellableMinor > 0)
          .map((l) => ({
            movementId: `${grnId}:${l.lineId}`,
            productId: l.productId,
            locationId: record.warehouseId,
            kind: 'received' as const,
            quantityMinor: l.sellableMinor,
            uom: l.uom,
            occurredAt: r.receivedAt,
            enteredBy: r.receivedBy,
            ...(l.batchId !== null ? { batchId: l.batchId } : {}),
            ...(l.expiry !== null && l.expiry !== undefined ? { expiry: l.expiry } : {}),
            ...(costByProduct.has(l.productId) ? { unitCostMinor: costByProduct.get(l.productId) } : {}),
          }));
        await deps.commit(ctx.tenantId, record, movements, ctx.idempotencyKey ?? grnId);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: r.receivedBy, action: 'receipt.record', objectType: 'goods_receipt', objectId: grnId,
          at: deps.now(), origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: null,
          after: {
            number: r.number, poId: r.poId ?? '', warehouseId: r.warehouseId, lines: String(r.lines.length),
            availableMinor: String(record.availableMinor), relayedBy: ctx.userId, source: r.source, storeId: r.storeId ?? '',
            flags: flags.join(','),
          },
          correlationId: grnId,
        });
        // 202, not 201: the goods were booked in at the store and this records that it happened.
        return { status: 202, body: { grn: record, flags } };
      },
    },
  ];
}
