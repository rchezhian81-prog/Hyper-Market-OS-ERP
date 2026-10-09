// API-04 — the warehouse handheld's receiving SCANS assembled into ONE goods receipt against the order (SP-6b · W06
// remainder · M07-FR-01 · M06-FR-04 · §28 · §31 · hard rules #2 #5 #10).
//
// Since SP-3a every scan at the back door is its own record at head office: a `received` movement at the store (good
// stock rises at once, M08-FR-01) and a row on the delivery's scan register. That left the delivery a PILE OF SCANS — no
// GRN, nothing folded into the purchase order, no line a second person could dispose of. This module closes that:
//
//   • the worker taps "Delivery complete" on the handheld → ONE `ReceivingCompleted` (keyed on the GRN id) rides the same
//     device queue → box → sync path as the scans, behind them in order, to `…/goods-receipt/:grnId/assembled`; the same
//     assembly is available to a person at head office on `…/goods-receipt/:grnId/assemble`;
//   • head office gathers the delivery's scans from ITS register (never the body), builds one line per product + batch +
//     posture (good · damaged · expired · held), measures them against the ISSUED order with the order's own figures
//     (SP-6), runs the SAME `captureReceipt` the direct and relayed receipts run (rules from the master, tolerances from
//     the tenant, cost from the cloud — F03/F07), and records the GRN;
//   • it appends NO `received` movement: the scans already posted every on-hand unit (`recv:<grnId>:<commandId>`), and a
//     second posting would count the delivery twice (hard rule #2). Held-out scans (damaged / expired / quarantine) posted
//     nothing, so a later ACCEPT disposition releases them exactly as on any GRN; an over-tolerance EXCESS is already on
//     the shelf position — the GRN holds it and SAYS so (`excess_already_on_hand`); a second person's approval accepts it
//     where it is (no movement), a rejection leaves it flagged for the supplier return (SP-7) rather than inventing a
//     movement kind; a line whose checked outcome differs from what the scans posted is a visible exception
//     (`scan_posting_disagrees`), never a silent correction (P-08);
//   • the receipt folds into the order in the SAME append as the GRN (SP-6), exactly like any other.
// Idempotent per grnId: the same completion again is 200 `alreadyReceived`; a scan that arrives AFTER assembly is still
// recorded and posted by its own route (the goods are in the building) and flagged `after_assembly` for the review.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  captureReceipt, availableFromReceipt, heldFromReceipt, IncompleteCaptureError,
  type CapturedLine, type CapturedReceipt,
} from '../../../packages/receiving/src/index';
import {
  rulesFromMaster, sayHandling, policyInForce, orderForReceipt, alignToOrder, poPostingFor, commitAgainstOrder, awaitsDecision, linesAwaitingDisposition,
  type GrnRecord, type ReceiptFlag, type AssembledFromScans,
} from './goods-receipt';
import type { SyncedGoodsReceiptDeps } from './goods-receipt-synced';
import type { ReceivingScanDeps, ReceivingScanRecord } from './warehouse-synced';

export interface AssembledGoodsReceiptDeps extends SyncedGoodsReceiptDeps {
  /** The delivery's scans as head office keeps them (the SP-3a register) — the ONLY source of the assembled lines. */
  readonly scansOf: ReceivingScanDeps['scansOf'];
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isIso = (v: unknown): v is string => isStr(v) && !Number.isNaN(Date.parse(v));

/** How the scan said the goods arrived, collapsed to what the capture engine can express. */
export type ScanPosture = 'good' | 'damaged' | 'expired' | 'held';
export const postureOf = (state: string): ScanPosture =>
  state === 'on_hand' || state === 'good' ? 'good' : state === 'damaged' ? 'damaged' : state === 'expired' ? 'expired' : 'held';
const POSTURE_ORDER: Readonly<Record<ScanPosture, number>> = { good: 0, damaged: 1, expired: 2, held: 3 };

/** One assembled line and the scans behind it. */
export interface AssembledLine {
  readonly line: CapturedLine;
  readonly posture: ScanPosture;
  /** What the scans in this line had already posted on-hand (0 for damaged / expired / held scans). */
  readonly scannedOnHandMinor: number;
  readonly commandIds: readonly string[];
  readonly onHandMovementIds: readonly string[];
}

/**
 * The delivery's scans as receipt lines: one per product + batch + posture, in the order the scans first arrived, a
 * product's GOOD line first. The ORDERED figure is spread across a product's lines from the order's own quantity — each
 * line takes what it counted up to what is left of the order, the last line takes the remainder — so an excess or a
 * shortage shows on ONE line and the lines together claim exactly the order (`alignToOrder` then has nothing to dispute).
 * A product the order never named, or a delivery with no order, is received as-is (ordered = counted). Pure: no clock, no I/O.
 */
export function linesFromScans(input: {
  readonly grnId: string;
  readonly scans: readonly ReceivingScanRecord[];
  readonly ordered: Readonly<Record<string, number>> | undefined;
  /** The trading date the receipt is captured on (YYYY-MM-DD) — the expiry check's "today". */
  readonly receivedOnDate: string;
  readonly unitCostMinorOf: (productId: string) => number | undefined;
  readonly flags: ReceiptFlag[];
}): readonly AssembledLine[] {
  // Wave 3 · SF-07 part 3: a cold-chain scan head office HELD (no reading, or out of range) is its own line, so a good scan of the
  // same product that went on-hand is never judged by — or blamed for — the held one; each line carries its readings.
  interface Group { productId: string; batchId: string | null; posture: ScanPosture; coldHeld: boolean; uom: string; expiry: string | null; counted: number; onHand: number; commandIds: string[]; onHandMovementIds: string[]; temps: (number | undefined)[] }
  const groups = new Map<string, Group>();
  const productOrder: string[] = [];
  for (const s of input.scans) {
    const posture = postureOf(s.state);
    const coldHeld = s.coldChainHeld !== undefined;
    const key = `${s.productId}|${s.batchId ?? ''}|${posture}|${coldHeld ? 'cold-held' : ''}`;
    if (!productOrder.includes(s.productId)) productOrder.push(s.productId);
    const g = groups.get(key) ?? { productId: s.productId, batchId: s.batchId, posture, coldHeld, uom: s.uom, expiry: null, counted: 0, onHand: 0, commandIds: [], onHandMovementIds: [], temps: [] };
    g.counted += s.quantityMinor;
    g.temps.push(s.temperatureC);
    g.commandIds.push(s.commandId);
    if (s.expiry !== null && g.expiry === null) g.expiry = s.expiry;
    if (s.onHandMovementId !== null) { g.onHand += s.quantityMinor; g.onHandMovementIds.push(s.onHandMovementId); }
    groups.set(key, g);
  }
  const say = (flag: ReceiptFlag): void => { if (!input.flags.includes(flag)) input.flags.push(flag); };
  const out: AssembledLine[] = [];
  let n = 0;
  for (const productId of productOrder) {
    const mine = [...groups.values()].filter((g) => g.productId === productId)
      .sort((a, b) => POSTURE_ORDER[a.posture] - POSTURE_ORDER[b.posture] || Number(a.coldHeld) - Number(b.coldHeld));
    const onOrder = input.ordered?.[productId];
    let remaining = onOrder;
    mine.forEach((g, i) => {
      n += 1;
      const last = i === mine.length - 1;
      let orderedMinor = g.counted;
      if (remaining !== undefined) {
        orderedMinor = last ? remaining : Math.min(remaining, g.counted);
        remaining -= orderedMinor;
      }
      // An expired scan with no date captured is still expired: it is refused as of the receipt date, and the record says
      // the date was assumed rather than pretending the handheld knew it.
      let expiry = g.expiry;
      if (g.posture === 'expired' && expiry === null) { expiry = input.receivedOnDate; say('expiry_date_assumed'); }
      const line: CapturedLine = {
        lineId: `${input.grnId}:${n}`, productId, orderedMinor, countedMinor: g.counted, uom: g.uom, batchId: g.batchId, expiry,
        unitCost: { minor: input.unitCostMinorOf(productId) ?? 0, currency: 'INR' },
        condition: g.posture === 'damaged' ? 'damaged' : 'good',
        ...(g.posture === 'held' ? { qc: 'failed' as const } : {}),
        // Wave 3 · SF-07 part 3: the line's reading for the capture engine. A held line with ANY scan unread carries none (held:
        // not recorded); otherwise its first reading — out of range by construction, so the engine holds it for the same reason
        // head office held the scan. A line that went on-hand carries a reading that passed.
        ...lineTemperature(g.temps, g.coldHeld),
      };
      out.push({ line, posture: g.posture, scannedOnHandMinor: g.onHand, commandIds: g.commandIds, onHandMovementIds: g.onHandMovementIds });
    });
  }
  return out;
}

function lineTemperature(temps: readonly (number | undefined)[], coldHeld: boolean): { temperatureC?: number } {
  if (coldHeld && temps.some((t) => t === undefined)) return {};
  const first = temps.find((t): t is number => t !== undefined);
  return first === undefined ? {} : { temperatureC: first };
}

export type AssembleOutcome =
  | { readonly ok: true; readonly record: GrnRecord; readonly alreadyReceived: boolean }
  | { readonly ok: false; readonly refusedBecause: 'no_scans_for_receipt' | 'receipt_line_incomplete'; readonly detail: string };

/**
 * Assemble a delivery's scans into ONE goods receipt — the one code path for the relayed completion and a person's direct
 * call. Reads the scans from head office's register, measures them against the issued order, runs the tested capture,
 * records the GRN with NO stock movement of its own (the scans posted the stock), and folds it into the order atomically.
 */
export async function assembleReceipt(deps: AssembledGoodsReceiptDeps, input: {
  readonly tenantId: string; readonly grnId: string;
  /** The order the handheld or the caller named; `null` / `undefined` → the scans' own, else none. */
  readonly poId: string | null | undefined;
  readonly completedBy: string; readonly completedAt: string;
  readonly relayedBy?: string; readonly storeId?: string | null; readonly source: string;
  readonly via: 'direct' | 'relayed'; readonly branchId: string | null; readonly idempotencyKey: string;
}): Promise<AssembleOutcome> {
  const existing = await deps.grn(input.tenantId, input.grnId);
  if (existing !== undefined) return { ok: true, record: existing, alreadyReceived: true };

  const scans = await deps.scansOf(input.tenantId, input.grnId);
  if (scans.length === 0) {
    return { ok: false, refusedBecause: 'no_scans_for_receipt', detail: `Head office holds no receiving scans for delivery ${input.grnId} — there is nothing to assemble into a receipt.` };
  }
  const flags: ReceiptFlag[] = [];
  // Who declared the delivery complete — re-verified from THEIR grants, never the relay's word (§28, hard rule #4).
  const permissions = await deps.permissionsOfUser(input.tenantId, input.completedBy);
  if (permissions === undefined) flags.push('receiver_unknown');
  else if (!permissions.includes('inventory.movement.append')) flags.push('receiver_lacks_authority');

  // The ORDER — head office's own, never the body (SP-6 · F01/F07): named by the completion, else by the scans themselves.
  const poId = isStr(input.poId) ? input.poId : (scans.find((s) => s.poId !== null)?.poId ?? null);
  const order = await orderForReceipt(deps, input.tenantId, poId, flags);

  const productIds = [...new Set(scans.map((s) => s.productId))];
  const master = await rulesFromMaster(deps, input.tenantId, productIds);
  if (master.unverified) flags.push('product_rules_unverified'); sayHandling(flags, master);
  const costByProduct = new Map<string, number>();
  let costUnknown = false;
  for (const productId of productIds) {
    const cost = await deps.unitCostMinor(input.tenantId, productId);
    if (cost === undefined) costUnknown = true; else costByProduct.set(productId, cost);
  }
  if (costUnknown) flags.push('cost_unknown');
  const inForce = await policyInForce(deps, input.tenantId);
  if (inForce.defaulted) flags.push('default_policy');

  const receivedOnDate = input.completedAt.slice(0, 10);
  const assembled = linesFromScans({ grnId: input.grnId, scans, ordered: order.ordered, receivedOnDate, unitCostMinorOf: (p) => costByProduct.get(p), flags });
  const captureLines = alignToOrder(assembled.map((a) => a.line), order.ordered, flags);

  let captured: CapturedReceipt;
  try {
    captured = captureReceipt({ receiptId: input.grnId, lines: captureLines, rules: master.rules, policy: inForce.policy, receivedOnDate, currency: 'INR' });
  } catch (err) {
    if (err instanceof IncompleteCaptureError) {
      return { ok: false, refusedBecause: 'receipt_line_incomplete', detail: `${err.message}. A line that cannot be identified cannot be received (M10 / M07-FR-02) — the scans stay on the register for a person.` };
    }
    throw err;
  }

  // What the scans had already posted, line by line — the reason this GRN appends nothing, and the check that says so.
  const onHandByLine: Record<string, number> = {};
  const disagreements: AssembledFromScans['disagreements'][number][] = [];
  for (const a of assembled) {
    onHandByLine[a.line.lineId] = a.scannedOnHandMinor;
    const checked = captured.lines.find((l) => l.lineId === a.line.lineId);
    if (checked !== undefined && checked.sellableMinor + checked.heldMinor !== a.scannedOnHandMinor) {
      disagreements.push({ lineId: a.line.lineId, scannedOnHandMinor: a.scannedOnHandMinor, sellableMinor: checked.sellableMinor, heldMinor: checked.heldMinor });
    }
  }
  if (disagreements.length > 0) flags.push('scan_posting_disagrees');
  // Wave 3 · SF-07: a cold-chain line held for its temperature (none recorded, or out of range) whose units the scans had
  // ALREADY put on-hand — the handheld cannot record a temperature yet, so the hold is said here, never silent (P-08).
  const coldHeld = new Set(captured.discrepancies.filter((d) => d.kind === 'temperature_not_recorded' || d.kind === 'temperature_breach').map((d) => d.lineId));
  if (assembled.some((a) => coldHeld.has(a.line.lineId) && a.scannedOnHandMinor > 0)) flags.push('cold_chain_held_but_on_hand');
  const heldMinor = heldFromReceipt(captured);
  if (heldMinor > 0) flags.push('excess_already_on_hand');

  const poReceipt = poPostingFor(order, input.grnId, captured, input.completedBy, input.completedAt);
  const storeId = input.storeId ?? scans[0]!.storeId;
  const record: GrnRecord = {
    grnId: input.grnId, number: input.grnId, poId: order.poId,
    // The scans posted their stock at the store's location; the GRN lives there too, so a later release lands in the same place.
    warehouseId: scans[0]!.storeId,
    receivedBy: input.completedBy, receivedAt: input.completedAt,
    captured, availableMinor: availableFromReceipt(captured), heldMinor,
    governanceFlags: flags, source: input.source, storeId,
    ...(input.relayedBy === undefined ? {} : { relayedBy: input.relayedBy }),
    poReceipt: poReceipt === undefined ? null : { receiptId: poReceipt.receiptId, receivedByProduct: poReceipt.receivedByProduct },
    ...(order.position === undefined ? {} : { orderPosition: order.position }),
    assembledFrom: {
      scanCount: scans.length, commandIds: scans.map((s) => s.commandId), scannedBy: [...new Set(scans.map((s) => s.receivedBy))],
      completedBy: input.completedBy, completedAt: input.completedAt, onHandByLine,
      onHandMovementIds: assembled.flatMap((a) => a.onHandMovementIds), disagreements,
    },
  };
  // NO movements: the scans posted the stock (hard rule #2). The GRN and its posting against the order are one append.
  await commitAgainstOrder(deps, input.tenantId, record, [], input.idempotencyKey, poReceipt, order);
  await deps.recordAudit?.(input.tenantId, {
    actorId: input.completedBy, action: 'receipt.assemble', objectType: 'goods_receipt', objectId: input.grnId,
    at: deps.now(), origin: { tenantId: input.tenantId, branchId: input.branchId },
    before: null,
    after: {
      poId: order.poId ?? '', scanCount: String(scans.length), lines: String(captured.lines.length),
      availableMinor: String(record.availableMinor), heldMinor: String(heldMinor), onHandFromScans: String(Object.values(onHandByLine).reduce((s, n) => s + n, 0)),
      relayedBy: input.relayedBy ?? '', via: input.via, flags: flags.join(','),
    },
    correlationId: input.grnId,
  });
  return { ok: true, record, alreadyReceived: false };
}

/** The completion as the handheld queued it (`ReceivingCompleted`, SP-6b shape). */
interface RelayedCompletion {
  readonly grnId: string; readonly poId: string | null; readonly completedBy: string; readonly storeId: string | null; readonly at: string; readonly source: string;
}
function readRelayedCompletion(body: unknown, grnId: string): RelayedCompletion | undefined {
  if (!isObj(body) || !isStr(body['grnId']) || body['grnId'] !== grnId || !isStr(body['completedBy']) || !isIso(body['at'])) return undefined;
  const poId = body['poId'];
  if (!(poId === null || poId === undefined || isStr(poId))) return undefined;
  return {
    grnId, poId: isStr(poId) ? poId : null, completedBy: body['completedBy'], storeId: isStr(body['storeId']) ? body['storeId'] : null,
    at: body['at'], source: isStr(body['source']) ? body['source'] : 'warehouse-handheld',
  };
}

const refusal = (out: Extract<AssembleOutcome, { ok: false }>, relayed: boolean) => apiError(422, {
  code: out.refusedBecause, whatHappened: out.detail, wasItSaved: 'not_saved',
  nextSafeAction: out.refusedBecause === 'no_scans_for_receipt'
    ? (relayed ? 'Nothing was changed. Check the delivery\'s scans reached head office, then assemble the receipt from head office.' : 'Scan the delivery in first, or capture the receipt directly. Nothing was changed.')
    : 'Capture the missing detail on the scan register (a batch-tracked item needs a batch AND an expiry) or capture the receipt directly. Nothing was changed.',
});

const body = (record: GrnRecord, alreadyReceived: boolean) => ({
  grn: record, alreadyReceived, flags: record.governanceFlags ?? [], poReceipt: record.poReceipt ?? null, assembledFrom: record.assembledFrom ?? null,
  awaitsDecision: awaitsDecision(record), awaitingDisposition: linesAwaitingDisposition(record).map((l) => l.lineId),
});

export function assembledGoodsReceiptRoutes(deps: AssembledGoodsReceiptDeps): readonly Route[] {
  return [
    {
      // The handheld's "delivery complete", relayed by the box under the store's sync credential (SP-6b).
      api: 'API-04', method: 'POST', path: '/v1/inventory/goods-receipt/:grnId/assembled',
      permission: 'inventory.receipt.sync', idempotent: true,
      handler: async (ctx) => {
        const grnId = (ctx.params['grnId'] ?? '').trim();
        const c = grnId === '' ? undefined : readRelayedCompletion(ctx.body, grnId);
        if (c === undefined) {
          throw apiError(400, {
            code: 'not_readable_as_a_receiving_completion',
            whatHappened: 'This payload could not be read as a delivery declared complete on a handheld — it needs the grnId matching the path, completedBy and at (poId and storeId optional).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Do not discard it at the store. Keep it in the queue and raise it — the scans behind it are already at head office.',
          });
        }
        const out = await assembleReceipt(deps, {
          tenantId: ctx.tenantId, grnId, poId: c.poId, completedBy: c.completedBy, completedAt: c.at, relayedBy: ctx.userId, storeId: c.storeId,
          source: c.source, via: 'relayed', branchId: ctx.branchId ?? null, idempotencyKey: ctx.idempotencyKey ?? grnId,
        });
        if (!out.ok) throw refusal(out, true);
        // 202, not 201: the delivery was completed at the store and this records that it happened.
        return { status: out.alreadyReceived ? 200 : 202, body: body(out.record, out.alreadyReceived) };
      },
    },
    {
      // A person at head office assembles the delivery from its scans. Body: { poId? }.
      api: 'API-04', method: 'POST', path: '/v1/inventory/goods-receipt/:grnId/assemble',
      permission: 'inventory.movement.append', idempotent: true,
      handler: async (ctx) => {
        const grnId = (ctx.params['grnId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (grnId === '' || !(b['poId'] === undefined || b['poId'] === null || isStr(b['poId']))) {
          throw apiError(400, {
            code: 'not_readable_as_an_assembly',
            whatHappened: 'Assembling a receipt needs the grnId in the path and, optionally, the poId of the order it was delivered against.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send { poId? }. Nothing was changed.',
          });
        }
        const out = await assembleReceipt(deps, {
          tenantId: ctx.tenantId, grnId, poId: isStr(b['poId']) ? b['poId'] : undefined, completedBy: ctx.userId, completedAt: deps.now(),
          source: 'head-office', via: 'direct', branchId: ctx.branchId ?? null, idempotencyKey: ctx.idempotencyKey ?? grnId,
        });
        if (!out.ok) throw refusal(out, false);
        return { status: out.alreadyReceived ? 200 : 201, body: body(out.record, out.alreadyReceived) };
      },
    },
  ];
}
