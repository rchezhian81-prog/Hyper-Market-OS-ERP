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
    productId, name: name !== undefined && name.trim() !== '' ? name : productId, quantity: quantityLabel(qty, uom),
    unitCostMinor, per, uom, valueMinor: valueAtCost(qty, uom, { minor: unitCostMinor, per }),
  };
}

/**
 * Every order waiting to be issued, as head office's order list hands them over — the person's own last (they cannot
 * issue those), over-budget first among the rest (P-03), then oldest first. An unreadable row is left out, never half-shown.
 */
export function ordersWaitingToIssue(body: unknown, viewer: WaitingOrderViewer, names: WaitingOrderNames = {}): readonly OrderWaitingToIssue[] {
  const orders = isRec(body) && Array.isArray(body['orders']) ? body['orders'] as unknown[] : [];
  const out: OrderWaitingToIssue[] = [];
  for (const raw of orders) {
    if (!isRec(raw) || raw['status'] !== 'proposed') continue;
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
    });
  }
  return out.sort((a, b) => Number(a.raisedByViewer) - Number(b.raisedByViewer)
    || Number(b.overBudget) - Number(a.overBudget)
    || (a.raisedAt < b.raisedAt ? -1 : a.raisedAt > b.raisedAt ? 1 : 0));
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
