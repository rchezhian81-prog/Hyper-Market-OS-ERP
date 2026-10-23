// The wave builder — confirmed orders turned into a picker's wave (M19-FR-01 · WF-14 · D09-FR-03 · OB-300).
//
// Until this existed a wave could only be handed to a picker as lines somebody wrote out by hand — the bin, the quantity
// and the price typed per line. This takes the CONFIRMED orders a dispatcher chose for a store and makes the lines from
// head office's own facts: the bin from the store's bin register (the pickable bin that holds the product), the name, unit
// and price from the catalogue pack the store sells from. A single-order pick is a wave of one.
//
// Two rules a wave builder can break without anybody noticing until a customer rings:
//
//   • AN ORDER IS NEVER SPLIT (OB-300, owner, 23 Oct 2026 — "never split"). If any line of an order has no bin or no
//     price, the WHOLE order stays out of the wave, named with the reason; it is not half-picked with the rest to follow.
//   • EVERY ORDER IS ACCOUNTED FOR. Each order the dispatcher chose is either on the wave or on the refused list with a
//     reason — never neither. `accountedFor` is checked against the input by a test.
//
// Pure and deterministic: bins, contents and products are supplied; ties break on ids.

import type { Bin } from '../../warehouse/src/movements';

export interface WaveOrderLine {
  readonly productId: string;
  readonly quantityMinor: number;
}

export interface WaveOrder {
  readonly orderId: string;
  /** Where the order was placed — a wave is one store's, and an order is picked where it is held. */
  readonly locationId: string;
  readonly lines: readonly WaveOrderLine[];
}

/** A product as the catalogue pack sells it. */
export interface WaveProduct {
  readonly productId: string;
  readonly name: string;
  readonly baseUom: string;
  readonly unitPriceMinor: number;
}

/** One line of a wave — the shape head office hands to the picker's phone. */
export interface WaveLine {
  readonly lineId: string;
  readonly orderRef: string;
  readonly productId: string;
  readonly description: string;
  readonly bin: string;
  readonly requiredQty: number;
  readonly uom: string;
  readonly unitPriceMinor: number;
}

export type WaveRefusal =
  /** The order is held at a different store from the wave's. */
  | 'other_store'
  /** The order has nothing to pick. */
  | 'no_lines'
  /** A product on the order is in no pickable bin at this store. Somebody must put it away first; a bin is never invented. */
  | 'no_bin'
  /** A product on the order is not in the store's catalogue pack, so it has no price or name to pick it by. */
  | 'not_in_pack'
  /** The same order was chosen twice. */
  | 'chosen_twice';

export interface RefusedOrder {
  readonly orderId: string;
  readonly reason: WaveRefusal;
  readonly productIds: readonly string[];
  readonly detail: string;
}

export interface WavePlan {
  readonly waveId: string;
  readonly storeId: string;
  readonly lines: readonly WaveLine[];
  readonly orderIds: readonly string[];
  readonly refused: readonly RefusedOrder[];
  /** Orders on the wave plus orders refused — always the number chosen. */
  readonly accountedFor: number;
}

/** Bin contents keyed `${binId}|${productId}|${batchId}` → units, as the warehouse register projects them. */
export type BinContents = Readonly<Record<string, number>>;

/**
 * The bin a picker should go to for a product at a store: the PICKABLE bin of that store holding the most of it (ties on
 * the bin id). A bin that holds none, a holding bin and a quarantine bin are never offered. Undefined: no such bin.
 */
export function pickBinFor(productId: string, storeId: string, bins: readonly Bin[], contents: BinContents): string | undefined {
  const held = new Map<string, number>();
  for (const [key, qty] of Object.entries(contents)) {
    const [binId, pid] = key.split('|');
    if (pid !== productId || binId === undefined) continue;
    held.set(binId, (held.get(binId) ?? 0) + qty);
  }
  let best: { binId: string; qty: number } | undefined;
  for (const bin of bins) {
    if (bin.storeId !== storeId || !bin.pickable || bin.zone === 'quarantine') continue;
    const qty = held.get(bin.binId) ?? 0;
    if (qty <= 0) continue;
    if (best === undefined || qty > best.qty || (qty === best.qty && bin.binId < best.binId)) best = { binId: bin.binId, qty };
  }
  return best?.binId;
}

/**
 * Build a wave from the orders a dispatcher chose. Each order is either wholly on the wave or refused by name (OB-300).
 * Line ids are `order:product`, so the same order built twice gives the same lines and the assignment is the same record.
 */
export function planWave(input: {
  readonly waveId: string;
  readonly storeId: string;
  readonly orders: readonly WaveOrder[];
  readonly binOf: (productId: string) => string | undefined;
  readonly productOf: (productId: string) => WaveProduct | undefined;
}): WavePlan {
  const lines: WaveLine[] = [];
  const orderIds: string[] = [];
  const refused: RefusedOrder[] = [];
  const seen = new Set<string>();

  for (const order of input.orders) {
    if (seen.has(order.orderId)) {
      refused.push({ orderId: order.orderId, reason: 'chosen_twice', productIds: [], detail: `${order.orderId} was chosen twice; it is on the wave once.` });
      continue;
    }
    seen.add(order.orderId);
    if (order.locationId !== input.storeId) {
      refused.push({ orderId: order.orderId, reason: 'other_store', productIds: [], detail: `${order.orderId} is held at ${order.locationId}, not ${input.storeId}. It is picked where its stock is held — never split across stores (OB-300).` });
      continue;
    }
    // One line per product: an order's lines are kept one per product, and a repeat is summed rather than picked twice.
    const byProduct = new Map<string, number>();
    for (const l of order.lines) if (l.quantityMinor > 0) byProduct.set(l.productId, (byProduct.get(l.productId) ?? 0) + l.quantityMinor);
    if (byProduct.size === 0) {
      refused.push({ orderId: order.orderId, reason: 'no_lines', productIds: [], detail: `${order.orderId} has nothing left to pick.` });
      continue;
    }
    const products = [...byProduct.keys()].sort();
    const notInPack = products.filter((p) => input.productOf(p) === undefined);
    if (notInPack.length > 0) {
      refused.push({ orderId: order.orderId, reason: 'not_in_pack', productIds: notInPack, detail: `${notInPack.join(', ')} on ${order.orderId} is not in the store's catalogue pack, so it has no name or price to pick by. The whole order waits — it is never picked in part (OB-300).` });
      continue;
    }
    const noBin = products.filter((p) => input.binOf(p) === undefined);
    if (noBin.length > 0) {
      refused.push({ orderId: order.orderId, reason: 'no_bin', productIds: noBin, detail: `${noBin.join(', ')} on ${order.orderId} is in no pickable bin at ${input.storeId}. Put it away to a pickable bin first; a bin is never guessed. The whole order waits (OB-300).` });
      continue;
    }
    for (const productId of products) {
      const p = input.productOf(productId)!;
      lines.push({
        lineId: `${order.orderId}:${productId}`, orderRef: order.orderId, productId, description: p.name,
        bin: input.binOf(productId)!, requiredQty: byProduct.get(productId)!, uom: p.baseUom, unitPriceMinor: p.unitPriceMinor,
      });
    }
    orderIds.push(order.orderId);
  }

  // The picker walks bin by bin; the same bin order every time the same wave is built.
  lines.sort((a, b) => (a.bin === b.bin ? a.lineId.localeCompare(b.lineId) : a.bin.localeCompare(b.bin)));
  return { waveId: input.waveId, storeId: input.storeId, lines, orderIds, refused, accountedFor: orderIds.length + refused.length };
}
