// Goods receiving (M07) — the inbound counterpart to the sale. Received stock is
// committed to the local append-only ledger (positive movements) and a
// GoodsReceived event is queued for sync. Queue-capable offline (§31); idempotent
// on the GRN id, so a retried receipt collapses to one effect (§31.1). Pure
// orchestration — the ledger and outbox are injected.

import { makeEvent } from '../../contracts/src/event';
import type { Ledger } from '../../ledger/src/ledger';
import type { SyncOutbox } from '../../sync/src/outbox';
import type { CarriedReceivingChecklist } from '../../facilities/src/food-safety';

export interface ReceiptLineInput {
  readonly productId: string;
  /** Quantity received, in the UOM's smallest unit (stock increases by this). */
  readonly quantityMinor: number;
  readonly uom: string;
  readonly batchId?: string | null;
  /**
   * Wave 3 · SF-07 part 2 — the arrival temperature the manager probed, °C, for chilled or frozen goods. Absent when not
   * taken: head office then holds a cold-chain line for a second person's check (owner decision 9 Oct 2026).
   */
  readonly temperatureC?: number;
  /** B4 · OB-504: the batch's month and year (or date) of manufacture as printed on the pack — required for a packed product. */
  readonly manufacturedOn?: string;
  /**
   * Fix batch 4b · D-029 (M07-FR-02 · M10): the batch's expiry (best-before) date as printed on the pack, YYYY-MM-DD. It travels
   * to head office on the line and onto the `received` movement, so the batch appears on the expiry list.
   */
  readonly expiry?: string;
  /**
   * Fix batch 4b · D-029 (M07-FR-03): how many of `quantityMinor` arrived DAMAGED. Head office books them as a separate
   * damaged line (quarantined, never sellable); this screen's own ledger raises only the good ones. 0 / absent = none.
   * A SHORT delivery needs no box: it is what arrived against what the order still had due, worked out by head office.
   */
  readonly damagedMinor?: number;
}

/** YYYY-MM-DD that is a real calendar date. */
export function isCalendarDate(text: string): boolean {
  if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(text)) return false;
  const d = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === text;
}

/**
 * Fix batch 4b · D-029: a line with an expiry date but no batch number printed is kept as its own batch, named by that date
 * ("EXP-2026-12-31"), so two deliveries of one item with different dates never fold into one batch with one date.
 */
export function datedBatchId(batchId: string | null | undefined, expiry: string | undefined): string | null {
  const typed = typeof batchId === 'string' ? batchId.trim() : '';
  if (typed !== '') return typed;
  return expiry === undefined || expiry.trim() === '' ? null : `EXP-${expiry.trim()}`;
}

export type ReceiptLineProblem =
  | { readonly kind: 'expiry_not_a_date'; readonly productId: string }
  | { readonly kind: 'damaged_not_whole'; readonly productId: string }
  | { readonly kind: 'damaged_more_than_arrived'; readonly productId: string }
  | { readonly kind: 'batch_and_expiry_needed'; readonly productId: string };

/**
 * Fix batch 4b · D-029: what is wrong with a delivery's lines before anything is saved — offline, the same everywhere: an
 * expiry that is not a real date, a damaged count that is not a whole number or is more than arrived, and a BATCH-TRACKED
 * product (head office's catalogue, as the store computer holds it) with no batch or no expiry (head office refuses it too).
 */
export function receiptLineProblems(
  lines: readonly Pick<ReceiptLineInput, 'productId' | 'quantityMinor' | 'batchId' | 'expiry' | 'damagedMinor'>[],
  batchTrackedProductIds?: readonly string[],
): readonly ReceiptLineProblem[] {
  const tracked = new Set(batchTrackedProductIds ?? []);
  const out: ReceiptLineProblem[] = [];
  for (const l of lines) {
    const expiry = l.expiry?.trim() ?? '';
    if (expiry !== '' && !isCalendarDate(expiry)) out.push({ kind: 'expiry_not_a_date', productId: l.productId });
    if (l.damagedMinor !== undefined) {
      if (!Number.isInteger(l.damagedMinor) || l.damagedMinor < 0) out.push({ kind: 'damaged_not_whole', productId: l.productId });
      else if (l.damagedMinor > l.quantityMinor) out.push({ kind: 'damaged_more_than_arrived', productId: l.productId });
    }
    if (tracked.has(l.productId) && ((l.batchId ?? '').trim() === '' || expiry === '')) out.push({ kind: 'batch_and_expiry_needed', productId: l.productId });
  }
  return out;
}

/** B4 · OB-504: the lines of PACKED products (by the store pack's list) with no readable manufacture date — refused offline. */
export function linesMissingManufactureDate(packedProductIds: readonly string[] | undefined, lines: readonly Pick<ReceiptLineInput, 'productId' | 'manufacturedOn'>[]): readonly string[] {
  if (packedProductIds === undefined) return [];
  const packed = new Set(packedProductIds);
  return [...new Set(lines.filter((l) => packed.has(l.productId) && !/^\d{4}-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?$/.test((l.manufacturedOn ?? '').trim())).map((l) => l.productId))];
}

export interface CommitReceiptInput {
  readonly id: string; // GRN id
  readonly number: string;
  readonly poId: string | null;
  readonly warehouseId: string;
  readonly receivedBy: string;
  readonly receivedAt: string; // ISO-8601 UTC
  readonly lines: readonly ReceiptLineInput[];
  /** Which store's screen booked it in (SP-2b) — carried to head office; absent means not stated. */
  readonly storeId?: string;
  /** Which surface booked it in, e.g. `manager-screen` (SP-2b). */
  readonly source?: string;
  /**
   * OB-172: the D-6 receiving checklist done at the dock for this delivery (chilled, frozen, raw meat), by the person who
   * booked it in. It travels INSIDE the receipt — one record the store computer seals — never as a separate message.
   */
  readonly receivingChecklist?: CarriedReceivingChecklist;
}

export interface CommittedReceipt {
  readonly id: string;
  readonly number: string;
  readonly poId: string | null;
  readonly warehouseId: string;
  readonly receivedBy: string;
  readonly receivedAt: string;
  readonly lineCount: number;
}

export class EmptyReceiptError extends Error {
  constructor(id: string) {
    super(`Receipt "${id}" has no lines.`);
    this.name = 'EmptyReceiptError';
  }
}

/**
 * Commit a goods receipt locally: append one inbound stock movement per line to
 * the stock ledger and queue a GoodsReceived event for sync — no network call.
 * Idempotent on the GRN id.
 */
export function commitReceipt(
  input: CommitReceiptInput,
  stockLedger: Ledger,
  outbox: SyncOutbox,
): CommittedReceipt {
  if (input.lines.length === 0) {
    throw new EmptyReceiptError(input.id);
  }

  for (const line of input.lines) {
    // Fix batch 4b · D-029: a line that arrived wholly damaged raises no stock here (head office quarantines it).
    if (Math.abs(line.quantityMinor) - Math.max(0, line.damagedMinor ?? 0) <= 0) continue;
    stockLedger.append(
      makeEvent({
        id: `${input.id}:move:${line.productId}`,
        type: 'InventoryMoved',
        occurredAt: input.receivedAt,
        idempotencyKey: `grn-move:${input.id}:${line.productId}`,
        source: input.warehouseId,
        payload: {
          productId: line.productId,
          // inbound: stock increases — by the GOOD ones only; damaged units are quarantined at head office (D-029)
          deltaMinor: Math.max(0, Math.abs(line.quantityMinor) - Math.max(0, line.damagedMinor ?? 0)),
          uom: line.uom,
          batchId: line.batchId ?? null,
        },
      }),
    );
  }

  outbox.enqueue(
    makeEvent({
      id: `${input.id}:received`,
      type: 'GoodsReceived',
      occurredAt: input.receivedAt,
      idempotencyKey: `grn:${input.id}`,
      source: input.warehouseId,
      // The WHOLE receipt travels (SP-2b): head office re-runs the receiving rules over these lines and re-verifies the
      // receiver — a thin `lineCount` gave it nothing to receive. Superset of the old shape, so nothing reading
      // `grnId` / `number` / `poId` / `lineCount` changes.
      payload: {
        grnId: input.id,
        number: input.number,
        poId: input.poId,
        lineCount: input.lines.length,
        warehouseId: input.warehouseId,
        receivedBy: input.receivedBy,
        receivedAt: input.receivedAt,
        lines: input.lines.map((l) => ({
          productId: l.productId, quantityMinor: l.quantityMinor, uom: l.uom, batchId: l.batchId ?? null,
          // Wave 3 · SF-07 part 2: the reading travels with the line; head office judges it against the product's limits.
          ...(l.temperatureC === undefined ? {} : { temperatureC: l.temperatureC }),
          // B4 · OB-504: the batch's month and year of manufacture travels with the line; head office refuses a packed one without.
          ...(l.manufacturedOn === undefined || l.manufacturedOn.trim() === '' ? {} : { manufacturedOn: l.manufacturedOn.trim() }),
          // Fix batch 4b · D-029: the batch's expiry date and how many arrived damaged travel with the line.
          ...(l.expiry === undefined || l.expiry.trim() === '' ? {} : { expiry: l.expiry.trim() }),
          ...(l.damagedMinor === undefined || l.damagedMinor <= 0 ? {} : { damagedMinor: l.damagedMinor }),
        })),
        storeId: input.storeId ?? null,
        source: input.source ?? 'receiving',
        ...(input.receivingChecklist === undefined ? {} : { receivingChecklist: input.receivingChecklist }),
      },
    }),
  );

  return Object.freeze({
    id: input.id,
    number: input.number,
    poId: input.poId,
    warehouseId: input.warehouseId,
    receivedBy: input.receivedBy,
    receivedAt: input.receivedAt,
    lineCount: input.lines.length,
  });
}
