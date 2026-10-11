// GT-05 · MG-08 "Load and sign off … open orders" (§17.1 "open POs") — purchase orders still OPEN on the old system at cutover.
//
// A supplier who was sent an order last week will deliver against it next week, so the order has to be in the new system
// as an ISSUED order the receiving staff can book against, with what already came carried as received — otherwise the
// next delivery is judged against the full original quantity and the part already on the shelf is counted twice.
//
// It goes in through the SAME purchase-order routes a buyer uses, with every rule they carry:
//
//   • the supplier must be in the master AND approved by finance (OB-32) — so this runs AFTER the master-data load and the
//     supplier approvals, never before; an unapproved supplier is a visible refused step, not a skipped order;
//   • the order names the store it is delivered to (OB-37), a place in head office's hierarchy;
//   • it is PROPOSED by the named operator and ISSUED by a DIFFERENT person who holds the purchase-order approval (§28) —
//     the old system's approval does not carry over as anybody's signature here;
//   • what the old system already received is posted as a receipt against the order under one fixed receipt id per load
//     (`POST /v1/purchase/orders/:poId/receipts`) — it does NOT move stock: that stock is already in the opening count;
//   • every call is idempotent on the order's own (legacy) id, so an interrupted load resumed, or run again, doubles nothing.

import { assertNonProduction } from './trial';
import type { ExtractBundle, LoadClient, LoadRequest } from './load';

export interface ExtractOpenOrderLine {
  readonly productId: string;
  /** In the product's smallest steps, as ordered. */
  readonly orderedQty: number;
  /** What the OLD system already received against this line (0 when nothing came yet). */
  readonly receivedQty: number;
  /** Paise per whole unit, as on the order. */
  readonly unitCostMinor: number;
}

export interface ExtractOpenOrder {
  /** The old system's order id — the order's id here too. */
  readonly poId: string;
  /** The order number the supplier knows it by. */
  readonly number: string;
  readonly supplierId: string;
  /** OB-37: the store it is delivered to. */
  readonly deliverToLocationId: string;
  readonly lines: readonly ExtractOpenOrderLine[];
}

export type OpenOrderActor = 'operator' | 'approver';

export interface OpenOrderStep {
  readonly poId: string;
  readonly stage: 'propose' | 'issue' | 'carry_received';
  readonly actor: OpenOrderActor;
  readonly path: string;
  readonly body: unknown;
  readonly idempotencyKey: string;
}

export type OpenOrderRequest = Pick<LoadRequest, 'target' | 'tenantId' | 'demoTenantIds' | 'operator' | 'extractSealed' | 'loadId' | 'currency'> & {
  /** The SECOND person who issues the orders (holds `purchase.order.approve`, is not the operator). */
  readonly approver: string;
};

export type OpenOrderPlan =
  | { readonly ok: true; readonly loadId: string; readonly tenantId: string; readonly operator: string; readonly approver: string; readonly steps: readonly OpenOrderStep[] }
  | { readonly ok: false; readonly refusedBecause: 'production_target' | 'demo_tenant' | 'tenant_mismatch' | 'no_operator' | 'approver_is_operator' | 'extract_not_sealed' | 'malformed_rows'; readonly detail: string; readonly problems: readonly string[] };

const isId = (s: unknown): s is string => typeof s === 'string' && s.trim() !== '';
const isWhole = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

/** The receipt id the carried-over quantity is posted under — one per order per load, so a re-run lands on the same one. */
export const carriedReceiptId = (loadId: string): string => `legacy-received-${loadId}`;

/** Per product: what was ordered and what the old system received (an order may list a product on two lines). */
function byProduct(o: ExtractOpenOrder): Map<string, { ordered: number; received: number }> {
  const m = new Map<string, { ordered: number; received: number }>();
  for (const l of o.lines) {
    const cur = m.get(l.productId) ?? { ordered: 0, received: 0 };
    m.set(l.productId, { ordered: cur.ordered + l.orderedQty, received: cur.received + l.receivedQty });
  }
  return m;
}

/**
 * The guards, every bad row by name (checked against the master-data extract the orders refer to), then the calls in order.
 */
export function planOpenOrders(orders: readonly ExtractOpenOrder[], bundle: Pick<ExtractBundle, 'products' | 'suppliers'>, req: OpenOrderRequest): OpenOrderPlan {
  const assertion = assertNonProduction(req.target);
  if (!assertion.permitted) return { ok: false, refusedBecause: 'production_target', detail: assertion.detail, problems: [] };
  if (req.demoTenantIds.includes(req.tenantId)) return { ok: false, refusedBecause: 'demo_tenant', detail: `tenant "${req.tenantId}" is a demo tenant (G4)`, problems: [] };
  if (req.tenantId !== req.target.tenantId) return { ok: false, refusedBecause: 'tenant_mismatch', detail: `the load names tenant "${req.tenantId}" but the target is for "${req.target.tenantId}"`, problems: [] };
  if (req.operator.trim() === '' || req.approver.trim() === '') return { ok: false, refusedBecause: 'no_operator', detail: 'open orders need a named operator who raises them and a named second person who issues them', problems: [] };
  if (req.approver === req.operator) return { ok: false, refusedBecause: 'approver_is_operator', detail: `${req.operator} cannot both raise and issue the carried-over orders — a purchase order is a spend commitment and needs a second person (§28)`, problems: [] };
  if (!req.extractSealed) return { ok: false, refusedBecause: 'extract_not_sealed', detail: 'the extract has not been sealed and verified (MG-02)', problems: [] };

  const products = new Set(bundle.products.map((p) => p.productId));
  const suppliers = new Set(bundle.suppliers.map((s) => s.partnerId));
  const problems: string[] = [];
  const ids = new Set<string>();
  orders.forEach((o, i) => {
    const at = `open order row ${i + 1} (${String(o.poId)})`;
    if (!isId(o.poId)) { problems.push(`open order row ${i + 1}: the old system's order id is required`); return; }
    if (ids.has(o.poId)) problems.push(`${at}: listed twice`);
    ids.add(o.poId);
    if (!isId(o.number)) problems.push(`${at}: the order number is required`);
    if (!suppliers.has(o.supplierId)) problems.push(`${at}: supplier "${o.supplierId}" is not in the extract — an order is only raised to a supplier the master holds (OB-32)`);
    if (!isId(o.deliverToLocationId)) problems.push(`${at}: the store it is delivered to is required (OB-37)`);
    if (!Array.isArray(o.lines) || o.lines.length === 0) { problems.push(`${at}: an order with no lines is not an open order`); return; }
    o.lines.forEach((l, j) => {
      const ln = `${at} line ${j + 1} (${String(l.productId)})`;
      if (!products.has(l.productId)) problems.push(`${ln}: product is not in the extract`);
      if (!isWhole(l.orderedQty) || l.orderedQty === 0) problems.push(`${ln}: ordered quantity must be a whole number above 0`);
      if (!isWhole(l.receivedQty)) problems.push(`${ln}: received quantity must be a whole number, 0 or more`);
      if (!isWhole(l.unitCostMinor)) problems.push(`${ln}: unit cost must be whole non-negative paise`);
    });
    const totals = byProduct(o);
    for (const [productId, t] of totals) {
      if (isWhole(t.received) && isWhole(t.ordered) && t.received > t.ordered) problems.push(`${at}: ${productId} received ${t.received}, more than the ${t.ordered} ordered — an over-receipt is decided in the old system before cutover, never carried as an open order`);
    }
    if ([...totals.values()].every((t) => isWhole(t.received) && t.received >= t.ordered)) problems.push(`${at}: everything ordered was already received — it is history, not an open order`);
  });
  if (problems.length > 0) return { ok: false, refusedBecause: 'malformed_rows', detail: `${problems.length} open-order row(s) cannot load — fix the file once, then plan again`, problems };

  const steps: OpenOrderStep[] = [];
  for (const o of orders) {
    const po = encodeURIComponent(o.poId);
    steps.push({
      poId: o.poId, stage: 'propose', actor: 'operator', path: `/v1/purchase/orders/${po}`,
      body: { number: o.number, supplierId: o.supplierId, deliverToLocationId: o.deliverToLocationId,
        lines: o.lines.map((l) => ({ productId: l.productId, orderedQty: l.orderedQty, unitCost: { minor: l.unitCostMinor, currency: req.currency } })) },
      idempotencyKey: `${req.loadId}-po-${o.poId}`,
    });
    steps.push({
      poId: o.poId, stage: 'issue', actor: 'approver', path: `/v1/purchase/orders/${po}/approval`,
      body: { reason: `open order ${o.number} on the old system at cutover, carried over under load ${req.loadId}` },
      idempotencyKey: `${req.loadId}-po-${o.poId}-issue`,
    });
    const received = Object.fromEntries([...byProduct(o)].filter(([, t]) => t.received > 0).map(([p, t]) => [p, t.received]));
    if (Object.keys(received).length > 0) {
      steps.push({
        poId: o.poId, stage: 'carry_received', actor: 'operator', path: `/v1/purchase/orders/${po}/receipts`,
        body: { receiptId: carriedReceiptId(req.loadId), receivedByProduct: received },
        idempotencyKey: `${req.loadId}-po-${o.poId}-received`,
      });
    }
  }
  return { ok: true, loadId: req.loadId, tenantId: req.tenantId, operator: req.operator, approver: req.approver, steps };
}

export interface OpenOrderReport {
  readonly loadId: string;
  readonly steps: readonly { readonly poId: string; readonly stage: OpenOrderStep['stage']; readonly ok: boolean; readonly status: number; readonly detail?: string }[];
  readonly ok: boolean;
}

/**
 * Run the plan: each step as its actor. A refused step is a visible line; the order's later steps are skipped and said so
 * (an order that did not propose cannot be issued), and a re-run picks up exactly where it stopped.
 */
export async function executeOpenOrders(client: LoadClient, plan: Extract<OpenOrderPlan, { ok: true }>): Promise<OpenOrderReport> {
  const out: { poId: string; stage: OpenOrderStep['stage']; ok: boolean; status: number; detail?: string }[] = [];
  const failedOrders = new Set<string>();
  for (const s of plan.steps) {
    if (failedOrders.has(s.poId)) { out.push({ poId: s.poId, stage: s.stage, ok: false, status: 0, detail: 'not attempted: an earlier step of this order was refused' }); continue; }
    const res = await client.request({ method: 'POST', path: s.path, userId: s.actor === 'operator' ? plan.operator : plan.approver, tenantId: plan.tenantId, body: s.body, idempotencyKey: s.idempotencyKey });
    const ok = res.status === 200 || res.status === 201;
    const err = (res.body as { error?: { code?: string; whatHappened?: string } } | undefined)?.error;
    if (!ok) failedOrders.add(s.poId);
    out.push({ poId: s.poId, stage: s.stage, ok, status: res.status, ...(ok || err === undefined ? {} : { detail: `${err.code ?? ''}: ${err.whatHappened ?? ''}` }) });
  }
  return { loadId: plan.loadId, steps: out, ok: out.length === plan.steps.length && out.every((s) => s.ok) };
}

export interface OpenOrderCheckLine {
  readonly check: 'issued' | 'ordered' | 'received' | 'open' | 'delivery';
  readonly key: string;
  readonly expected: number | string;
  readonly actual: number | string | null;
  readonly agrees: boolean;
  readonly note?: string;
}

/**
 * Read every carried-over order back through the purchase routes: issued, to the same supplier, number and store, approved
 * by somebody other than who raised it; per product the ordered, received and REMAINING quantity; and the store's open
 * deliveries list showing exactly that remainder (the screen the receiving staff work from).
 */
export async function readBackOpenOrders(client: { request(input: { readonly method: 'GET'; readonly path: string; readonly userId: string; readonly tenantId: string; readonly query?: Readonly<Record<string, string>> }): Promise<{ readonly status: number; readonly body: unknown }> },
  orders: readonly ExtractOpenOrder[], req: Pick<LoadRequest, 'tenantId' | 'operator' | 'loadId'>): Promise<{ readonly lines: readonly OpenOrderCheckLine[]; readonly differences: readonly OpenOrderCheckLine[]; readonly agrees: boolean }> {
  const lines: OpenOrderCheckLine[] = [];
  const deliveriesByStore = new Map<string, { poId: string; lines: { productId: string; openQty: number }[] }[]>();
  for (const o of orders) {
    const res = await client.request({ method: 'GET', path: `/v1/purchase/orders/${encodeURIComponent(o.poId)}`, userId: req.operator, tenantId: req.tenantId });
    const body = (res.body ?? {}) as { order?: Record<string, unknown>; openCommitment?: { lines?: { productId: string; openQty: number }[] } | null };
    const po = body.order;
    if (res.status !== 200 || po === undefined) { lines.push({ check: 'issued', key: o.poId, expected: 'issued', actual: null, agrees: false, note: `not readable (${res.status})` }); continue; }
    const wrong: string[] = [];
    if (po['supplierId'] !== o.supplierId) wrong.push(`supplier ${String(po['supplierId'])}`);
    if (po['number'] !== o.number) wrong.push(`number ${String(po['number'])}`);
    if (po['deliverToLocationId'] !== o.deliverToLocationId) wrong.push(`delivered to ${String(po['deliverToLocationId'])}`);
    if (po['approvedBy'] === po['requisitionedBy']) wrong.push('approved by the person who raised it');
    lines.push({ check: 'issued', key: o.poId, expected: 'issued', actual: String(po['status']), agrees: po['status'] === 'issued' && wrong.length === 0, ...(wrong.length === 0 ? {} : { note: wrong.join('; ') }) });
    const orderedNow = new Map<string, number>();
    for (const l of (po['lines'] ?? []) as { productId: string; orderedQty: number }[]) orderedNow.set(l.productId, (orderedNow.get(l.productId) ?? 0) + l.orderedQty);
    const receivedNow = (po['receivedByProduct'] ?? {}) as Record<string, number>;
    const openNow = new Map<string, number>();
    for (const l of body.openCommitment?.lines ?? []) openNow.set(l.productId, (openNow.get(l.productId) ?? 0) + l.openQty);
    for (const [productId, t] of byProduct(o)) {
      const key = `${o.poId}/${productId}`;
      lines.push({ check: 'ordered', key, expected: t.ordered, actual: orderedNow.get(productId) ?? null, agrees: orderedNow.get(productId) === t.ordered });
      lines.push({ check: 'received', key, expected: t.received, actual: receivedNow[productId] ?? 0, agrees: (receivedNow[productId] ?? 0) === t.received });
      lines.push({ check: 'open', key, expected: t.ordered - t.received, actual: openNow.get(productId) ?? null, agrees: openNow.get(productId) === t.ordered - t.received });
    }
  }
  for (const store of new Set(orders.map((o) => o.deliverToLocationId))) {
    const res = await client.request({ method: 'GET', path: '/v1/purchase/deliveries/open', userId: req.operator, tenantId: req.tenantId, query: { storeId: store } });
    deliveriesByStore.set(store, ((res.body ?? {}) as { deliveries?: { poId: string; lines: { productId: string; openQty: number }[] }[] }).deliveries ?? []);
  }
  for (const o of orders) {
    const d = deliveriesByStore.get(o.deliverToLocationId)?.find((x) => x.poId === o.poId);
    const expected = [...byProduct(o).values()].reduce((s, t) => s + t.ordered - t.received, 0);
    const actual = d === undefined ? null : d.lines.reduce((s, l) => s + l.openQty, 0);
    lines.push({ check: 'delivery', key: `${o.deliverToLocationId}/${o.poId}`, expected, actual, agrees: actual === expected, ...(d === undefined ? { note: 'not on the store\'s open deliveries' } : {}) });
  }
  const differences = lines.filter((l) => !l.agrees);
  return { lines, differences, agrees: differences.length === 0 };
}
