// OB-66 "A" (owner, 11 Oct 2026, in writing, "Receive good, hold damaged") — a transfer arriving with DAMAGED units at a
// place under an open count (WF-08 · OB-59 · D05-FR-05 · M08 · M28-FR-01 · P-08 · hard rules #2 #6 #10).
//
// Round 10 refused the WHOLE floor receipt while an open count at the floor froze write-offs of the product: the good units
// waited on the trolley with the damaged ones. Now:
//
//   • The GOOD units are received at once — `transferred_in` at the floor, on the shelf, sellable, in the count's expected
//     figure like any delivery (deliveries keep flowing under OB-59).
//   • The DAMAGED units' write-off is HELD on the count plan that froze it: one `CountWriteOffHeld` record, written in the
//     SAME atomic batch as the receipt, named on the indent's issue (`heldForCount`) and on the plan's view
//     (`heldWriteOffs`, beside its freeze breaches). Until then the damaged units are NOT on the floor's on-hand: they stay
//     off the ledger at the floor exactly as they were in transit — so the counter, who counts the shelf (good units only),
//     is judged against an expected figure that holds no damaged units. Holding them ON hand while their write-off waits
//     would show a shortage of exactly the damaged units; the approval would post it as a count loss, and the held
//     write-off would then take them off a second time.
//   • When the count CLOSES (approved or cancelled) each held write-off is applied ONCE, atomically: the damaged units come
//     in (`transferred_in`, at the cost they left with) and go out as a write-off on the write-off register (M28 —
//     `WriteOffCommitted` + its `wasted` movement), so the books take it through the ONE stock-adjustment posting path
//     (`/v1/finance/stock-adjustments/post`, `stock_write_off`) — on-hand at the floor unchanged, the loss valued once. The
//     ids are keyed on the held record, so a re-sent approval, a retried apply or a replay applies nothing twice.
//   • Never lost: a held write-off not yet applied stays on the plan's view (`awaiting_close` / `awaiting_application`), and
//     the month-end stock adjustment waits for it like any unposted write-off (the books are never closed around it).

import type { Transfer } from '../../../packages/warehouse/src/transfers';
import type { DamagedLine } from '../../../packages/warehouse/src/indents';
import type { Movement } from './index';
import type { CountFreezeCheck } from './count-freeze';
import type { StoredWriteOff } from './write-off';

/** A damaged-on-arrival write-off held on a count plan until the count closes. */
export interface HeldWriteOff {
  /** The id the immediate write-off would have carried (`<transferId>-damaged-<n>`) — one held record per damaged line. */
  readonly heldId: string;
  readonly planId: string;
  readonly productId: string;
  readonly locationId: string;
  readonly batchId: string | null;
  readonly quantityMinor: number;
  readonly uom: string;
  /** Valued at the cost the stock left the back store with (the transfer line's cost). */
  readonly valueMinor: number;
  readonly unitCostMinor: number | null;
  readonly source: { readonly kind: 'floor_indent'; readonly indentId: string; readonly issueId: string; readonly transferId: string };
  readonly recordedBy: string;
  readonly recordedAt: string;
  /** True when the receipt was relayed by the store computer (counted on the floor while the line was down). */
  readonly relayed: boolean;
}

/** The held write-off applied at the count's close — once. */
export interface HeldWriteOffApplied {
  readonly heldId: string;
  readonly planId: string;
  readonly outcome: 'approved' | 'cancelled';
  readonly appliedBy: string;
  readonly appliedAt: string;
  readonly writeOffId: string;
  readonly movementIds: readonly string[];
}

/** How the plan's view shows a held write-off. */
export interface HeldWriteOffView extends HeldWriteOff {
  readonly state: 'awaiting_close' | 'awaiting_application' | 'applied';
  readonly applied: HeldWriteOffApplied | null;
}

export const heldWriteOffId = (heldId: string): string => `held-${heldId}`;
export const heldInMovementId = (heldId: string): string => `${heldId}-held-in`;

/**
 * Which damaged lines an open count freezes. Each damaged line keeps its own posting (and id); a line whose product an
 * open plan at the floor freezes `wasted` for is HELD on that plan, the rest are written off at once as before (SP-8c).
 */
export async function holdDamagedUnderCount(input: {
  readonly check: CountFreezeCheck | undefined;
  readonly tenantId: string;
  readonly transfer: Transfer;
  readonly damaged: readonly DamagedLine[];
  /** `damagePostings(transfer, damaged, …)` — index-aligned with `damaged`. */
  readonly postings: readonly Movement[];
  readonly indentId: string;
  readonly issueId: string;
  readonly by: string;
  readonly at: string;
  readonly relayed: boolean;
}): Promise<{ readonly damaged: readonly DamagedLine[]; readonly immediate: readonly Movement[]; readonly held: readonly HeldWriteOff[]; readonly writeOffs: readonly StoredWriteOff[] }> {
  const damaged: DamagedLine[] = [];
  const immediate: Movement[] = [];
  const held: HeldWriteOff[] = [];
  const writeOffs: StoredWriteOff[] = [];
  for (let i = 0; i < input.damaged.length; i += 1) {
    const d = input.damaged[i]!;
    const m = input.postings[i]!;
    const line = input.transfer.lines.findIndex((l) => l.productId === d.productId && l.batchId === d.batchId);
    const unitCostMinor = line >= 0 ? input.transfer.lineCostsMinor?.[line] ?? input.transfer.lines[line]!.unitCost.minor : null;
    const planId = input.check === undefined ? undefined : await input.check(input.tenantId, m.locationId, m.productId, m.kind);
    if (planId === undefined) {
      // OB-71 "A": no count holds it — written off NOW, on the write-off register as its own line (same write as the receipt).
      const writeOff = arrivedDamagedWriteOff(m, d, unitCostMinor, input.by, input.at);
      damaged.push(d); immediate.push({ ...m, reason: `${m.reason} — on the write-off register as ${writeOff.id}` }); writeOffs.push(writeOff); continue;
    }
    damaged.push({ ...d, heldForCount: planId });
    held.push({
      heldId: m.movementId, planId, productId: d.productId, locationId: m.locationId, batchId: d.batchId, quantityMinor: d.quantityMinor, uom: m.uom,
      valueMinor: d.valueMinor, unitCostMinor, source: { kind: 'floor_indent', indentId: input.indentId, issueId: input.issueId, transferId: input.transfer.transferId },
      recordedBy: input.by, recordedAt: input.at, relayed: input.relayed,
    });
  }
  return { damaged, immediate, held, writeOffs };
}

/** OB-71: the register id of a damaged-on-arrival write-off taken at once (no count holding it) — keyed on its `wasted` movement. */
export const arrivedDamagedWriteOffId = (movementId: string): string => `arrived-${movementId}`;

/**
 * OB-71 "A" (owner, 12 Oct 2026, in writing, "Own write-off line") — a damaged arrival when NO count holds it is written off
 * at once AND recorded on the write-off register (M28-FR-01) as its own line, so the books post it ONCE through the one
 * stock-adjustment path (`stock_write_off` → inventory_write_off) instead of the loss hiding inside month-end cost of goods
 * sold. Same shape as OB-66's applied held write-off: loss type `damage`, reason `arrived_damaged`, valued at the cost the
 * stock left the back store with (the transfer line's cost — never a caller's figure). Its stock effect is the receipt's own
 * `wasted` posting (`<transferId>-damaged-<n>`, same write), so on-hand falls once; the id is keyed on that posting, so a
 * replayed receipt (direct or relayed) records and posts nothing twice. Pure.
 */
export function arrivedDamagedWriteOff(wasted: Movement, d: DamagedLine, unitCostMinor: number | null, by: string, at: string): StoredWriteOff {
  return {
    id: arrivedDamagedWriteOffId(wasted.movementId), productId: d.productId, locationId: wasted.locationId, lossType: 'damage', qtyRemoved: d.quantityMinor, uom: wasted.uom,
    valueMinor: d.valueMinor, currency: 'INR', reasonCode: 'arrived_damaged', requiredApproval: false, evidenceRef: null,
    raisedBy: by, approvedBy: null, at, valueSource: 'stock_cost', ...(unitCostMinor === null ? {} : { unitCostMinor }),
    ...(d.batchId === null ? {} : { batchId: d.batchId }),
  };
}

/**
 * The receipt's `transferred_in` postings less the held damaged units: they do not reach the floor's on-hand until the
 * count closes (they stay off the ledger as they were in transit). A posting brought to zero is dropped.
 */
export function withoutHeldUnits(received: readonly Movement[], held: readonly HeldWriteOff[]): Movement[] {
  const owed = new Map<string, number>();
  for (const h of held) { const k = `${h.productId}\u001f${h.batchId ?? ''}`; owed.set(k, (owed.get(k) ?? 0) + h.quantityMinor); }
  const out: Movement[] = [];
  for (const m of received) {
    const k = `${m.productId}\u001f${m.batchId ?? ''}`;
    const take = Math.min(owed.get(k) ?? 0, m.quantityMinor);
    if (take > 0) owed.set(k, (owed.get(k) ?? 0) - take);
    if (m.quantityMinor - take > 0) out.push({ ...m, quantityMinor: m.quantityMinor - take });
  }
  return out;
}

/**
 * What applying one held write-off writes (pure): the damaged units in at the floor, the write-off on the register and its
 * `wasted` movement — on-hand at the floor unchanged; the loss valued once, on the register the books post from.
 */
export function heldApplication(h: HeldWriteOff, outcome: 'approved' | 'cancelled', by: string, at: string): {
  readonly inMovement: Movement; readonly writeOff: StoredWriteOff; readonly wasted: Movement; readonly applied: HeldWriteOffApplied;
} {
  const batch = h.batchId === null ? {} : { batchId: h.batchId };
  const inMovement: Movement = {
    movementId: heldInMovementId(h.heldId), productId: h.productId, locationId: h.locationId, kind: 'transferred_in', quantityMinor: h.quantityMinor, uom: h.uom,
    occurredAt: at, enteredBy: h.recordedBy, ...batch, ...(h.unitCostMinor === null ? {} : { unitCostMinor: h.unitCostMinor }),
    reason: `transfer ${h.source.transferId} arrived damaged at ${h.locationId} — held for count plan ${h.planId}, taken off transit at the count's close (${outcome})`,
  };
  const writeOff: StoredWriteOff = {
    id: heldWriteOffId(h.heldId), productId: h.productId, locationId: h.locationId, lossType: 'damage', qtyRemoved: h.quantityMinor, uom: h.uom,
    valueMinor: h.valueMinor, currency: 'INR', reasonCode: 'arrived_damaged', requiredApproval: false, evidenceRef: null,
    raisedBy: h.recordedBy, approvedBy: null, at, valueSource: 'stock_cost', ...(h.unitCostMinor === null ? {} : { unitCostMinor: h.unitCostMinor }),
    ...(h.batchId === null ? {} : { batchId: h.batchId }),
  };
  const wasted: Movement = {
    movementId: `writeoff-${writeOff.id}`, productId: h.productId, locationId: h.locationId, kind: 'wasted', quantityMinor: h.quantityMinor, uom: h.uom,
    occurredAt: at, enteredBy: h.recordedBy, ...batch,
    reason: `arrived_damaged: transfer ${h.source.transferId} (indent ${h.source.indentId}, issue ${h.source.issueId}) — write-off held for count plan ${h.planId}, applied at its close (${outcome})`,
  };
  return { inMovement, writeOff, wasted, applied: { heldId: h.heldId, planId: h.planId, outcome, appliedBy: by, appliedAt: at, writeOffId: writeOff.id, movementIds: [inMovement.movementId, wasted.movementId] } };
}

/** The plan's view of its held write-offs (pure). */
export function heldWriteOffViews(planState: string, held: readonly HeldWriteOff[], applied: readonly HeldWriteOffApplied[]): readonly HeldWriteOffView[] {
  const done = new Map(applied.map((a) => [a.heldId, a] as const));
  return held.map((h) => {
    const a = done.get(h.heldId) ?? null;
    return { ...h, applied: a, state: a !== null ? 'applied' : planState === 'approved' || planState === 'cancelled' ? 'awaiting_application' : 'awaiting_close' };
  });
}
