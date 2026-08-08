// Web ERP warehouse supervisor session (M09 / OA-9) — the model behind the supervisor's oversight
// screen. It is the SUPERVISORY half of the dual-interface warehouse: where the handheld executes
// (receive, put away), this one oversees — bin configuration, stock visibility, bin occupancy and the
// exception queue — reading the SAME authoritative warehouse data the box carries and reusing the SAME
// engines (`packages/warehouse`), so the two interfaces can never disagree (no duplicated logic).
//
// ── The one rule it inherits from every screen on this box ───────────────────
//
// **A section the box was never told is NOT KNOWN, never empty.** The supervisor may have the bin
// configuration but not the current contents (the cloud sent one and not the other). "No bins are
// over capacity" and "I have not been told what is in the bins" are different sentences, and a
// supervisor deciding whether the warehouse is healthy must be able to tell them apart (P-08). So the
// contents-dependent views — occupancy, stock, exceptions — answer `known: false` with a reason when
// contents were not sent, exactly as the manager's day close refuses on a register it cannot see.

import { binOccupancy, type Bin, type BinContents } from '../../../packages/warehouse/src/movements';
import { buildQueue, submitDecision, type QueueRow } from './approvals-workbench';
import type { ApprovalRequest, Approver, Decision, DecidedRequest, RefusalReason } from '../../../packages/approvals/src/approvals';
import { isValidReasonFor } from '../../../packages/approvals/src/reasons';
import { makeEvent } from '../../../packages/contracts/src/event';
import { money, isCurrencyCode, type CurrencyCode } from '../../../packages/contracts/src/money';
import type { Transfer, TransferLine } from '../../../packages/warehouse/src/transfers';
import type { SyncOutbox } from '../../../packages/sync/src/outbox';

export type Known<T> =
  | ({ readonly known: true } & T)
  | { readonly known: false; readonly why: string };

/** What the box served the supervisor's screen — the same `warehouse` section the handheld reads. */
export interface SupervisorData {
  readonly bins: readonly Bin[];
  /** Current bin contents, per `binId|productId|batchId`. Absent means the box was not told. */
  readonly contents?: BinContents;
  readonly recalledProductIds?: readonly string[];
  readonly recalledBatchIds?: readonly string[];
  /** Pending §28 approvals the supervisor may decide, already in the approval-engine shape. */
  readonly approvals?: readonly ApprovalRequest[];
  /** Who the supervisor is, for the maker-checker check (§28). */
  readonly supervisor?: Approver;
  readonly asAt: string;
}

/** The outcome of a supervisor decision — the engine's outcome, plus the reasons this layer adds. */
export type DecideOutcome =
  | { readonly ok: true; readonly request: DecidedRequest }
  | { readonly ok: false; readonly refusal: RefusalReason | 'request_not_found' | 'unknown_reason_code' | 'not_configured' };

/** A line the supervisor proposes to transfer. Value is per-UOM-unit, so a shortfall can be priced. */
export interface ProposeTransferLine {
  readonly productId: string;
  readonly batchId?: string | null;
  readonly quantityMinor: number;
  readonly uom: string;
  readonly unitCostMinor: number;
  readonly currency?: string;
}

export interface ProposeTransferInput {
  readonly transferId: string;
  readonly fromLocationId: string;
  readonly toLocationId: string;
  readonly lines: readonly ProposeTransferLine[];
}

export type ProposeTransferOutcome =
  | { readonly ok: true; readonly transfer: Transfer }
  | { readonly ok: false; readonly refusal: 'not_configured' | 'no_lines' | 'same_location' | 'invalid_line' };

/** The kinds of task a supervisor may assign to a warehouse worker. */
export const WAREHOUSE_TASK_KINDS = Object.freeze(['put_away', 'count', 'bin_to_bin', 'replenish'] as const);
export type WarehouseTaskKind = (typeof WAREHOUSE_TASK_KINDS)[number];

export interface AssignTaskInput {
  readonly taskId: string;
  readonly kind: WarehouseTaskKind;
  readonly assignedTo: string;
  readonly productId?: string;
  readonly binId?: string;
  readonly note?: string;
  readonly at: string;
}

export interface WarehouseTask {
  readonly taskId: string;
  readonly kind: WarehouseTaskKind;
  readonly assignedTo: string;
  readonly assignedBy: string;
  readonly productId: string | null;
  readonly binId: string | null;
  readonly note: string | null;
  readonly at: string;
}

export type AssignTaskOutcome =
  | { readonly ok: true; readonly task: WarehouseTask }
  | { readonly ok: false; readonly refusal: 'not_configured' | 'invalid_task' | 'unknown_kind' };

/** A bin's configuration and, where contents are known, how full it is. */
export interface BinOverviewRow {
  readonly binId: string;
  readonly zone: string | null;
  readonly pickable: boolean;
  readonly capacityMinor: number;
  /** Units in the bin, or null when the box has not sent contents. */
  readonly usedMinor: number | null;
  readonly freeMinor: number | null;
  /** Percent full (0–100+), or null when contents are not known. */
  readonly pctFull: number | null;
}

export interface StockRow {
  readonly binId: string;
  readonly productId: string;
  readonly batchId: string | null;
  readonly quantityMinor: number;
}

/**
 * Every exception kind the supervisor's queue can raise — the authoritative list the screen must have
 * a word for, in English AND Tamil (OA-9). A completeness tripwire binds the view's vocabulary to this.
 */
export const WAREHOUSE_EXCEPTION_KINDS = Object.freeze([
  'negative_stock', 'over_capacity', 'recalled_in_pickable_bin',
] as const);
export type WarehouseExceptionKind = (typeof WAREHOUSE_EXCEPTION_KINDS)[number];

export interface WarehouseException {
  readonly kind: WarehouseExceptionKind;
  readonly binId: string;
  readonly productId?: string;
  readonly batchId?: string | null;
  readonly detail: string;
}

/** Split a `binId|productId|batchId` contents key back into its parts (batchId '' → null). */
function parseKey(key: string): { binId: string; productId: string; batchId: string | null } {
  const [binId = '', productId = '', batchId = ''] = key.split('|');
  return { binId, productId, batchId: batchId === '' ? null : batchId };
}

export class WarehouseSupervisorSession {
  private readonly recalledProducts: ReadonlySet<string>;
  private readonly recalledBatches: ReadonlySet<string>;

  constructor(private readonly data: SupervisorData) {
    this.recalledProducts = new Set(data.recalledProductIds ?? []);
    this.recalledBatches = new Set(data.recalledBatchIds ?? []);
  }

  get asAt(): string {
    return this.data.asAt;
  }

  /** The bin configuration — always answerable from the bins the box sent, occupancy filled where known. */
  bins(): readonly BinOverviewRow[] {
    const contents = this.data.contents;
    return this.data.bins.map((b) => {
      if (contents === undefined) {
        return { binId: b.binId, zone: b.zone ?? null, pickable: b.pickable, capacityMinor: b.capacityMinor, usedMinor: null, freeMinor: null, pctFull: null };
      }
      const used = binOccupancy(b.binId, contents);
      return {
        binId: b.binId, zone: b.zone ?? null, pickable: b.pickable, capacityMinor: b.capacityMinor,
        usedMinor: used, freeMinor: b.capacityMinor - used,
        pctFull: b.capacityMinor > 0 ? Math.round((used / b.capacityMinor) * 100) : 0,
      };
    });
  }

  /** Stock visibility: what is in each bin. `known: false` when the box has not sent contents. */
  stock(): Known<{ readonly rows: readonly StockRow[] }> {
    const contents = this.data.contents;
    if (contents === undefined) {
      return { known: false, why: 'the store box has not been sent the current bin contents' };
    }
    const rows: StockRow[] = Object.entries(contents)
      .filter(([, qty]) => qty !== 0)
      .map(([key, qty]) => ({ ...parseKey(key), quantityMinor: qty }));
    return { known: true, rows };
  }

  /**
   * The exception queue (control by exception, P-03): negative bins, bins over their capacity, and
   * recalled stock sitting in a pickable bin. `known: false` when contents were not sent — a warehouse
   * whose contents are unknown is not a warehouse with no exceptions.
   */
  exceptions(): Known<{ readonly rows: readonly WarehouseException[] }> {
    const contents = this.data.contents;
    if (contents === undefined) {
      return { known: false, why: 'the store box has not been sent the current bin contents' };
    }
    const rows: WarehouseException[] = [];
    const byId = new Map(this.data.bins.map((b) => [b.binId, b] as const));

    for (const [key, qty] of Object.entries(contents)) {
      const { binId, productId, batchId } = parseKey(key);
      if (qty < 0) {
        rows.push({ kind: 'negative_stock', binId, productId, batchId, detail: `${binId} projects to ${qty} of ${productId} — a bin cannot hold less than nothing` });
      }
      if (qty > 0) {
        const bin = byId.get(binId);
        const recalled = this.recalledProducts.has(productId) || (batchId !== null && this.recalledBatches.has(batchId));
        if (bin?.pickable === true && recalled) {
          rows.push({ kind: 'recalled_in_pickable_bin', binId, productId, batchId, detail: `${productId} is under recall but sits in pickable bin ${binId} — move it to a holding bin` });
        }
      }
    }
    for (const b of this.data.bins) {
      const used = binOccupancy(b.binId, contents);
      if (used > b.capacityMinor) {
        rows.push({ kind: 'over_capacity', binId: b.binId, detail: `${b.binId} holds ${used} but its capacity is ${b.capacityMinor}` });
      }
    }
    return { known: true, rows };
  }

  /**
   * The maker-checker queue for the warehouse (§28): every pending approval the floor raised, marked
   * actionable-or-not for THIS supervisor with the reason (their own request, out of scope, above
   * their limit → escalate). `known: false` when the box has not sent the approvals or who the
   * supervisor is — a supervisor who cannot be identified must not be shown an empty, all-clear queue.
   * Delegates entirely to the authoritative `buildQueue` — no rule is re-implemented here.
   */
  approvalQueue(): Known<{ readonly rows: readonly QueueRow[] }> {
    if (this.data.approvals === undefined || this.data.supervisor === undefined) {
      return { known: false, why: 'the store box has not sent the pending approvals or who the supervisor is' };
    }
    return { known: true, rows: buildQueue(this.data.approvals, this.data.supervisor) };
  }

  /**
   * Decide a pending warehouse approval and queue the decision for sync. The decision goes through the
   * authoritative engine (`submitDecision` → `decide`), which enforces §28 (the supervisor can never
   * decide their own request), a mandatory reason, branch scope and value authority — this layer adds
   * no softening. The reason is a CODE from the shared vocabulary (reportable a year later), validated
   * before the engine. On success a `WarehouseApprovalDecided` event carrying the decided request is
   * enqueued; a refusal queues nothing.
   */
  decide(
    input: { readonly requestId: string; readonly decision: Decision; readonly reasonCode: string; readonly decidedAt: string },
    outbox: SyncOutbox,
  ): DecideOutcome {
    if (this.data.approvals === undefined || this.data.supervisor === undefined) {
      return { ok: false, refusal: 'not_configured' };
    }
    const request = this.data.approvals.find((r) => r.id === input.requestId);
    if (request === undefined) return { ok: false, refusal: 'request_not_found' };
    // The catalogue is checked before the engine, so an invented reason never reaches the audit trail
    // — and approving "against_policy" is refused rather than recorded.
    if (!isValidReasonFor(input.decision, input.reasonCode)) {
      return { ok: false, refusal: 'unknown_reason_code' };
    }
    const outcome = submitDecision(request, this.data.supervisor, input.decision, input.reasonCode, input.decidedAt);
    if (!outcome.ok) return outcome;
    outbox.enqueue(makeEvent({
      id: `wh-appr-${request.id}-${outcome.request.status}`,
      type: 'WarehouseApprovalDecided',
      occurredAt: input.decidedAt,
      // Keyed on the request id and the outcome — re-sending the same decision collapses, a genuine
      // change of outcome is a new fact (append-only, hard rule #2).
      idempotencyKey: `wh-appr:${request.id}:${outcome.request.status}`,
      source: 'web-erp/warehouse-supervisor',
      payload: outcome.request,
    }));
    return outcome;
  }

  /**
   * Propose a warehouse/inter-store transfer (M09-FR-03). This produces a **proposed** transfer and
   * queues it for sync — it is ADVISORY: it moves no stock. Dispatch (which needs a SEPARATE approver
   * §28 and refuses recalled/quarantined/expired stock) happens on the authoritative cloud service,
   * unchanged — this screen proposes, it does not dispatch. Idempotent on the transfer id.
   */
  proposeTransfer(input: ProposeTransferInput, outbox: SyncOutbox): ProposeTransferOutcome {
    if (this.data.supervisor === undefined) return { ok: false, refusal: 'not_configured' };
    if (input.fromLocationId === input.toLocationId) return { ok: false, refusal: 'same_location' };
    if (input.lines.length === 0) return { ok: false, refusal: 'no_lines' };
    const lines: TransferLine[] = [];
    for (const l of input.lines) {
      const currency: string = l.currency ?? 'INR';
      if (typeof l.productId !== 'string' || l.productId.trim() === '' || !Number.isInteger(l.quantityMinor) || l.quantityMinor <= 0
        || !Number.isInteger(l.unitCostMinor) || l.unitCostMinor < 0 || !isCurrencyCode(currency)) {
        return { ok: false, refusal: 'invalid_line' };
      }
      lines.push({ productId: l.productId, batchId: l.batchId ?? null, quantityMinor: l.quantityMinor, uom: l.uom, unitCost: money(l.unitCostMinor, currency as CurrencyCode) });
    }
    const transfer: Transfer = {
      transferId: input.transferId, fromLocationId: input.fromLocationId, toLocationId: input.toLocationId,
      lines, state: 'proposed', requestedBy: this.data.supervisor.userId,
    };
    outbox.enqueue(makeEvent({
      id: `wh-transfer-${transfer.transferId}`,
      type: 'WarehouseTransferProposed',
      occurredAt: this.data.asAt,
      idempotencyKey: `wh-transfer:${transfer.transferId}`,
      source: 'web-erp/warehouse-supervisor',
      payload: transfer,
    }));
    return { ok: true, transfer };
  }

  /**
   * Assign a warehouse task (put-away, count, bin-to-bin, replenish) to a worker, queued for sync so
   * it reaches the handheld's assignment. The assigner is recorded. Idempotent on the task id.
   */
  assignTask(input: AssignTaskInput, outbox: SyncOutbox): AssignTaskOutcome {
    if (this.data.supervisor === undefined) return { ok: false, refusal: 'not_configured' };
    if (typeof input.taskId !== 'string' || input.taskId.trim() === '' || typeof input.assignedTo !== 'string' || input.assignedTo.trim() === '') {
      return { ok: false, refusal: 'invalid_task' };
    }
    if (!WAREHOUSE_TASK_KINDS.includes(input.kind)) return { ok: false, refusal: 'unknown_kind' };
    const task: WarehouseTask = {
      taskId: input.taskId, kind: input.kind, assignedTo: input.assignedTo, assignedBy: this.data.supervisor.userId,
      productId: input.productId ?? null, binId: input.binId ?? null, note: input.note ?? null, at: input.at,
    };
    outbox.enqueue(makeEvent({
      id: `wh-task-${task.taskId}`,
      type: 'WarehouseTaskAssigned',
      occurredAt: input.at,
      idempotencyKey: `wh-task:${task.taskId}`,
      source: 'web-erp/warehouse-supervisor',
      payload: task,
    }));
    return { ok: true, task };
  }
}

/**
 * Build the supervisor session from what the box served.
 *
 * Returns `null` when there is no warehouse data at all — a real state (a box never told about
 * warehouse work), which the screen says rather than showing empty bins that read as a healthy,
 * empty warehouse.
 */
export function bootWarehouseSupervisor(data: SupervisorData | undefined): WarehouseSupervisorSession | null {
  if (data?.bins === undefined) return null;
  return new WarehouseSupervisorSession(data);
}
