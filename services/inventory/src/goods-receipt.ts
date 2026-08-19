// API-04 Goods receipt / GRN capture (M07-FR-01/02/03 · D03-FR-02) — the back door of the shop, where most
// of the money is actually lost, made a durable cloud record. Receiving is captured on the handheld offline
// (§31); on sync a GRN reaches here, and this is the central boundary that turns a delivery into trusted
// stock and a visible, valued, owned discrepancy for everything that did not arrive as ordered:
//
//   • it trusts no client verdict — it re-runs the tested `captureReceipt` (the FR-02/03 gate): a
//     batch-tracked item with no batch or no expiry is REFUSED (you cannot recall what you cannot identify,
//     M10); already-expired stock is rejected, never received as sellable; damaged / QC-failed / cold-chain-
//     broken stock goes to QUARANTINE (deliberately not available to sell, M07-FR-03); a short/excess/
//     MRP-mismatch/near-expiry line raises a valued discrepancy, and an over-tolerance excess needs a second
//     person (§28);
//   • only the SELLABLE quantity of each line becomes availability — one inbound `received` movement per
//     sellable line (quarantine/rejected excluded, M08 status), the delivered unit cost carried so the stock
//     re-averages at what it cost (M08-FR-04). The GRN record and its movements are one ATOMIC append (FND-01);
//   • it is idempotent on the GRN id — a re-scan or a re-sync collapses to one effect (§31.1), so a delivery
//     is never double-counted.
//
// The rule is the tested `captureReceipt`/`availableFromReceipt` in `@sre/receiving` (the
// `services-run-on-their-tested-engine` guardrail); this file is the persistence + HTTP skin. Receiving is
// gated `inventory.movement.append` (Receiver/QC; the route never touches the PO price); reads are
// `inventory.availability.read`. The three-way PO-GRN-invoice match (FR-04) reads these GRNs.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import {
  captureReceipt, availableFromReceipt, IncompleteCaptureError,
  type CapturedLine, type ProductReceiptRules, type ReceiptPolicy, type CapturedReceipt,
} from '../../../packages/receiving/src/index';
import type { Movement } from './index';

/** A committed goods receipt — the durable GRN record, carrying the checked outcome. */
export interface GrnRecord {
  readonly grnId: string;
  readonly number: string;
  readonly poId: string | null;
  readonly warehouseId: string;
  readonly receivedBy: string;
  readonly receivedAt: string;
  readonly captured: CapturedReceipt;
  /** Total quantity that became available to sell (quarantine/rejected excluded). */
  readonly availableMinor: number;
}

export interface GoodsReceiptDeps {
  /** The GRN with this id, or undefined — for the idempotency (never-double-count) check. */
  readonly grn: (tenantId: string, grnId: string) => Promise<GrnRecord | undefined> | GrnRecord | undefined;
  /** Every GRN — the receiving / discrepancy review surface. */
  readonly all: (tenantId: string) => Promise<readonly GrnRecord[]> | readonly GrnRecord[];
  /** Record the GRN and its inbound movements as ONE atomic append (FND-01). */
  readonly commit: (tenantId: string, record: GrnRecord, movements: readonly Movement[], key: string) => Promise<void> | void;
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isMoney = (v: unknown): v is { minor: number; currency: string } => isObj(v) && isNum(v['minor']) && isStr(v['currency']);

const isCapturedLine = (v: unknown): v is CapturedLine =>
  isObj(v) && isStr(v['lineId']) && isStr(v['productId']) && isNum(v['orderedMinor']) && isNum(v['countedMinor'])
  && isStr(v['uom']) && isMoney(v['unitCost']) && isStr(v['condition']);

const isRule = (v: unknown): v is ProductReceiptRules =>
  isObj(v) && isStr(v['productId']) && typeof v['batchTracked'] === 'boolean';

const isPolicy = (v: unknown): v is ReceiptPolicy =>
  isObj(v) && isNum(v['excessToleranceBp']) && isNum(v['shortageToleranceBp']) && isNum(v['nearExpiryDays']);

export function goodsReceiptRoutes(deps: GoodsReceiptDeps): readonly Route[] {
  return [
    {
      // Capture a goods receipt. Body: { number?, poId, warehouseId, receivedOnDate, currency, lines[],
      // rules[], policy }. Idempotent on the GRN id in the path.
      api: 'API-04', method: 'POST', path: '/v1/inventory/goods-receipt/:grnId',
      permission: 'inventory.movement.append', idempotent: true,
      handler: async (ctx) => {
        const grnId = (ctx.params['grnId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const lines = b['lines'];
        const rules = b['rules'];
        if (grnId === '' || !isStr(b['warehouseId']) || !isStr(b['receivedOnDate']) || !isStr(b['currency'])
          || !Array.isArray(lines) || lines.length === 0 || !lines.every(isCapturedLine)
          || !Array.isArray(rules) || !rules.every(isRule) || !isPolicy(b['policy'])) {
          throw apiError(400, {
            code: 'not_readable_as_a_goods_receipt',
            whatHappened: 'A goods receipt needs a grnId in the path, and { warehouseId, receivedOnDate, currency, lines[] (each with lineId/productId/orderedMinor/countedMinor/uom/unitCost/condition), rules[], policy } in the body.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the counted lines with the product-master rules and the tenant tolerances.',
          });
        }
        // Never double-count: a GRN already recorded is returned unchanged (a re-scan / re-sync, §31.1).
        const existing = await deps.grn(ctx.tenantId, grnId);
        if (existing !== undefined) {
          return { status: 200, body: { grn: existing, alreadyReceived: true } };
        }
        // The FR-02/03 gate — the SAME tested rule the handheld ran, re-run here (a boundary trusts no client
        // verdict): batch/expiry mandatory, discrepancies valued, disposition sellable/quarantine/rejected.
        let captured: CapturedReceipt;
        try {
          captured = captureReceipt({
            receiptId: grnId,
            lines: lines as CapturedLine[],
            rules: rules as ProductReceiptRules[],
            policy: b['policy'] as ReceiptPolicy,
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
        };
        // Only the SELLABLE quantity becomes availability; quarantine/rejected are on the GRN but not on-hand.
        const costByLine = new Map((lines as CapturedLine[]).map((l) => [l.lineId, l.unitCost.minor]));
        const movements: Movement[] = captured.lines
          .filter((l) => l.sellableMinor > 0)
          .map((l) => ({
            movementId: `${grnId}:${l.lineId}`,
            productId: l.productId,
            locationId: record.warehouseId,
            kind: 'received' as const,
            quantityMinor: l.sellableMinor,
            uom: l.uom,
            occurredAt: receivedAt,
            enteredBy: ctx.userId,
            ...(l.batchId !== null ? { batchId: l.batchId } : {}),
            ...(costByLine.get(l.lineId) !== undefined ? { unitCostMinor: costByLine.get(l.lineId) } : {}),
          }));
        await deps.commit(ctx.tenantId, record, movements, ctx.idempotencyKey ?? grnId);
        return { status: 201, body: { grn: record } };
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
        return { status: 200, body: { grn: record } };
      },
    },
    {
      // Every GRN — the ones needing a second person's approval first (control by exception, P-03).
      api: 'API-04', method: 'GET', path: '/v1/inventory/goods-receipt',
      permission: 'inventory.availability.read',
      handler: async (ctx) => {
        const all = [...(await deps.all(ctx.tenantId))];
        const needsApproval = all.filter((g) => g.captured.requiresApproval);
        const ordered = [...needsApproval, ...all.filter((g) => !g.captured.requiresApproval)];
        return { status: 200, body: { receipts: ordered, count: ordered.length, needingApprovalCount: needsApproval.length } };
      },
    },
  ];
}
