// ORDERS WAITING FOR THE SECOND PERSON TO ISSUE THEM — fix batch 4a · D-010 · D-042 · M06-FR-02 · M02-FR-03 · §28 · P-03 · P-08.
//
// The walkthrough found an order raised by one person (status `proposed`) waiting for its second person, yet Today said
// "Approvals waiting 0", the owner's page said "Waiting for you (0)", and the order could be issued only from the Buying
// page's Budget tab, where its row named a code, a supplier code and a total — never what was being bought.
//
// This is the one reading of head office's `GET /v1/purchase/orders` body every screen uses: which orders wait to be
// issued, which of those THIS person may issue (never one they raised themselves — §28; only with
// `purchase.order.approve`), and each order's lines in plain words (item names, quantities in the item's own unit, the
// agreed price and the line's value). It decides nothing: whether an order issues — the person's money limit, the
// budget, a supplier hold — stays head office's judgement on `POST /v1/purchase/orders/:poId/approval`. Pure.

import { quantityLabel, valueAtCost } from '../../contracts/src/quantity';

/** The permission head office checks before anyone issues a waiting order. */
export const ISSUE_ORDER_PERMISSION = 'purchase.order.approve';

export interface WaitingOrderLine {
  readonly productId: string;
  /** The item's name where it is known, else its code (never a guess). */
  readonly name: string;
  /** The quantity in the item's own unit ("12", "2.500 kg"). */
  readonly quantity: string;
  /** P2 (batch 18c): the ordered quantity as head office holds it (in the item's smallest steps — grams for kg). */
  readonly orderedQty: number;
  /** The agreed price in paise per whole unit (or per `per` units). */
  readonly unitCostMinor: number;
  readonly per: number;
  /** The unit the price is per ("ea", "kg", …). */
  readonly uom: string;
  /** This line's value in paise (quantity × price, rounded once). */
  readonly valueMinor: number;
}

export interface OrderWaitingToIssue {
  readonly poId: string;
  readonly number: string;
  readonly supplierId: string;
  /** The supplier's name where it is known, else its code. */
  readonly supplierName: string;
  readonly raisedBy: string;
  readonly raisedAt: string;
  readonly totalMinor: number;
  readonly lines: readonly WaitingOrderLine[];
  /** True when head office found it over the month's budget when it was raised (it then escalates to the owner). */
  readonly overBudget: boolean;
  /** True when the person looking raised it — they may not issue it themselves (§28). */
  readonly raisedByViewer: boolean;
  /** P2 (batch 18c): the last step taken on it before now (sent back, resubmitted), with who, when and why. */
  readonly lastStep?: OrderStep;
}

/** P2 (batch 18c): one step on an order before it was issued — as head office's `proposalSteps` holds it. */
export interface OrderStep {
  readonly step: 'rejected' | 'sent_back' | 'withdrawn' | 'resubmitted';
  readonly by: string;
  readonly at: string;
  readonly reason: string;
}

export interface WaitingOrderViewer {
  readonly userId: string | null;
  readonly permissions?: readonly string[] | null;
}

export interface WaitingOrderNames {
  readonly products?: ReadonlyMap<string, string>;
  readonly suppliers?: ReadonlyMap<string, string>;
}

const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const int = (v: unknown): number => (typeof v === 'number' && Number.isSafeInteger(v) ? v : 0);

/** Whether this person may issue an order: they hold the permission. Unknown permissions → false (never assumed). */
export function mayIssueOrders(viewer: WaitingOrderViewer): boolean {
  return Array.isArray(viewer.permissions) && viewer.permissions.includes(ISSUE_ORDER_PERMISSION);
}

function lineOf(raw: unknown, names: WaitingOrderNames): WaitingOrderLine | null {
  if (!isRec(raw)) return null;
  const productId = str(raw['productId']);
  const qty = int(raw['orderedQty']);
  const cost = isRec(raw['unitCost']) ? raw['unitCost'] : {};
  const unitCostMinor = int(cost['minor']);
  const per = int(cost['per']) > 0 ? int(cost['per']) : 1;
  const uom = str(raw['uom']).trim() === '' ? 'ea' : str(raw['uom']).trim();
  if (productId === '' || qty <= 0) return null;
  const name = names.products?.get(productId);
  return {
    productId, name: name !== undefined && name.trim() !== '' ? name : productId, quantity: quantityLabel(qty, uom), orderedQty: qty,
    unitCostMinor, per, uom, valueMinor: valueAtCost(qty, uom, { minor: unitCostMinor, per }),
  };
}

/**
 * Every order waiting to be issued, as head office's order list hands them over — the person's own last (they cannot
 * issue those), over-budget first among the rest (P-03), then oldest first. An unreadable row is left out, never half-shown.
 */
export function ordersWaitingToIssue(body: unknown, viewer: WaitingOrderViewer, names: WaitingOrderNames = {}): readonly OrderWaitingToIssue[] {
  return ordersIn(body, viewer, names, 'proposed').sort((a, b) => Number(a.raisedByViewer) - Number(b.raisedByViewer)
    || Number(b.overBudget) - Number(a.overBudget)
    || (a.raisedAt < b.raisedAt ? -1 : a.raisedAt > b.raisedAt ? 1 : 0));
}

/**
 * P2 (batch 18c · M06-FR-02): the orders a second person SENT BACK to the person looking — each with the note it came back
 * with — for them to change and resubmit, or withdraw. Oldest first. Nobody named → none.
 */
export function ordersSentBackTo(body: unknown, viewer: WaitingOrderViewer, names: WaitingOrderNames = {}): readonly OrderWaitingToIssue[] {
  if (viewer.userId === null) return [];
  return ordersIn(body, viewer, names, 'sent_back').filter((o) => o.raisedByViewer)
    .sort((a, b) => (a.raisedAt < b.raisedAt ? -1 : a.raisedAt > b.raisedAt ? 1 : 0));
}

const STEPS = new Set(['rejected', 'sent_back', 'withdrawn', 'resubmitted']);
function lastStepOf(raw: unknown): OrderStep | undefined {
  const steps = Array.isArray(raw) ? raw as unknown[] : [];
  const last = steps[steps.length - 1];
  if (!isRec(last) || !STEPS.has(str(last['step'])) || str(last['by']) === '') return undefined;
  return { step: str(last['step']) as OrderStep['step'], by: str(last['by']), at: str(last['at']), reason: str(last['reason']) };
}

function ordersIn(body: unknown, viewer: WaitingOrderViewer, names: WaitingOrderNames, status: string): OrderWaitingToIssue[] {
  const orders = isRec(body) && Array.isArray(body['orders']) ? body['orders'] as unknown[] : [];
  const out: OrderWaitingToIssue[] = [];
  for (const raw of orders) {
    if (!isRec(raw) || raw['status'] !== status) continue;
    const poId = str(raw['poId']);
    const raisedBy = str(raw['requisitionedBy']);
    if (poId === '' || raisedBy === '') continue;
    const supplierId = str(raw['supplierId']);
    const supplierName = names.suppliers?.get(supplierId);
    const check = isRec(raw['budgetCheck']) ? raw['budgetCheck'] : undefined;
    out.push({
      poId, number: str(raw['number']) || poId, supplierId,
      supplierName: supplierName !== undefined && supplierName.trim() !== '' ? supplierName : supplierId,
      raisedBy, raisedAt: str(raw['at']), totalMinor: int(raw['totalMinor']),
      lines: (Array.isArray(raw['lines']) ? raw['lines'] as unknown[] : []).map((l) => lineOf(l, names)).filter((l): l is WaitingOrderLine => l !== null),
      overBudget: check?.['overBudget'] === true,
      raisedByViewer: viewer.userId !== null && viewer.userId === raisedBy,
      ...((): { lastStep?: OrderStep } => { const l = lastStepOf(raw['proposalSteps']); return l === undefined ? {} : { lastStep: l }; })(),
    });
  }
  return out;
}

/**
 * D-010: how many orders wait to be issued, and how many of them THIS person may issue — those they did not raise,
 * when they hold the permission. Whether one is above their money limit is head office's call when they press Issue.
 */
export function waitingOrderCounts(body: unknown, viewer: WaitingOrderViewer): { readonly waiting: number; readonly forViewer: number } {
  const all = ordersWaitingToIssue(body, viewer);
  const may = mayIssueOrders(viewer);
  return { waiting: all.length, forViewer: may ? all.filter((o) => !o.raisedByViewer).length : 0 };
}
