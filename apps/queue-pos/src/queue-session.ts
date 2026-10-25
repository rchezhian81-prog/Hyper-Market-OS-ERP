// THE QUEUE TILL's model — a staff handheld that scans a customer's basket in the queue (D04-FR-05 mobile POS and
// queue-busting · OB-288 Pkg 6b · P-01 · P-02 · P-07 · hard rules #1, #3).
//
// It is NOT a second till. The handheld runs the till's own tested session (`apps/pos` — `bootPos`), fed the store
// computer's SIGNED pack, so a basket is priced, offered, bundled and gated (tobacco, liquor, BIS, expiry, age) exactly as
// a fixed till would. This file adds only what the queue needs on top:
//
//   • the code each line was scanned with, so the basket can be HANDED OVER to a till that re-rings it through its own
//     pack (a scale label's code carries its weight, so such a line goes over as one label, never a made-up count);
//   • the hand-over itself — the store computer keeps the basket on its disk and answers a four-digit code — and the
//     baskets this handheld handed over that no till has brought up yet, each one given up with a reason, never deleted;
//   • whether this handheld may take the money itself: only where the shop switched `payments.mobile_pos` on, never in
//     the mirror pilot (the old system takes the money there), and only by card or UPI. Cash is not offered: the
//     owner decided a handheld takes no cash (OB-372, 25 Oct 2026).
//
// Nothing here waits on head office: the hand-over and the payment go to the store computer over the shop's wifi.

import { lineIsWeighed } from '../../../packages/restricted-sales/src/till-gate';
import { QUEUE_CODE, type QueueBasketLine } from '../../../packages/suspended-sales/src/queue-basket';

/** The parts of the till's session (`bootPos`) the queue till uses. */
export interface QueueTill {
  scanBarcode(code: string): { readonly lineId: string; readonly description: string; readonly qty: number; readonly amountMinor: number };
  basket(): readonly { readonly lineId: string; readonly productId: string; readonly description: string; readonly qty: number; readonly uom: string; readonly voided: boolean; readonly amountMinor: number }[];
  payableMinor(): number;
  newSale(): void;
  currentBillRef(): string;
  mirrorPilot(): boolean;
}

/** The store computer's queue-basket door (`/queue-pos/handoff`), injectable for tests. */
export interface QueueBasketPorts {
  handOver(body: { readonly basketId: string; readonly lines: readonly QueueBasketLine[]; readonly handheldTotalMinor: number }): Promise<Record<string, unknown>>;
  waiting(): Promise<Record<string, unknown>>;
  giveUp(body: { readonly code: string; readonly reason: string }): Promise<Record<string, unknown>>;
}

export type HandOverResult =
  | { readonly ok: true; readonly code: string; readonly lineCount: number; readonly laneMessage: string; readonly laneMessageTa?: string }
  | { readonly ok: false; readonly refusedBecause: string; readonly laneMessage: string; readonly laneMessageTa?: string; readonly lines?: readonly string[] };

export interface WaitingBasket { readonly code: string; readonly basketId: string; readonly handedOverAt: string; readonly lineCount: number; readonly handheldTotalMinor: number }

const UNREACHABLE = { en: 'This handheld cannot reach the store computer, so the basket was not handed over. It is still here — do not clear it.', ta: 'இந்தக் கருவி கடை கணினியை அணுக முடியவில்லை; கூடை ஒப்படைக்கப்படவில்லை. அது இங்கேயே உள்ளது — அழிக்க வேண்டாம்.' };

/** The store computer's queue-basket door over the device socket — same origin, the device's cookie goes with each call. */
export function httpQueueBaskets(base = '/queue-pos', fetchImpl: typeof globalThis.fetch = (...a) => globalThis.fetch(...a)): QueueBasketPorts {
  const post = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
    const res = await fetchImpl(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' });
    return await res.json() as Record<string, unknown>;
  };
  return {
    handOver: (body) => post('/handoff', body),
    giveUp: (body) => post('/handoff/give-up', body),
    waiting: async () => {
      const res = await fetchImpl(`${base}/handoff`, { headers: { accept: 'application/json' }, credentials: 'same-origin' });
      return await res.json() as Record<string, unknown>;
    },
  };
}

export interface QueueSession<T extends QueueTill = QueueTill> {
  /** The till's own session, whole — the screen pays and shows the bill through it. */
  readonly till: T;
  /** May this handheld take the money itself? The shop's switch, never in the mirror pilot. */
  paymentsHere(): boolean;
  /** Scan a code onto the basket through the till's own pack — and remember the code, for the hand-over. */
  scan(code: string): ReturnType<QueueTill['scanBarcode']>;
  /** The lines as a till will re-ring them, or the lines that could not be handed over (never dropped silently). */
  handOverLines(): { readonly ok: true; readonly lines: readonly QueueBasketLine[] } | { readonly ok: false; readonly missing: readonly string[] };
  /** Hand the basket to the store computer for a till; on its code the basket clears here, ready for the next customer. */
  handOver(): Promise<HandOverResult>;
  waiting(): Promise<{ readonly ok: boolean; readonly baskets: readonly WaitingBasket[]; readonly laneMessage?: string }>;
  giveUp(code: string, reason: string): Promise<{ readonly ok: boolean; readonly laneMessage: string; readonly laneMessageTa?: string }>;
  /** Start the next customer: the basket clears and so do the remembered codes. */
  newCustomer(): void;
}

export function createQueueSession<T extends QueueTill>(till: T, ports: QueueBasketPorts, options: { readonly payments: boolean }): QueueSession<T> {
  const scannedWith = new Map<string, string>();

  const handOverLines: QueueSession<T>['handOverLines'] = () => {
    const missing: string[] = [];
    const lines: QueueBasketLine[] = [];
    for (const l of till.basket()) {
      if (l.voided) continue;
      const barcode = scannedWith.get(l.lineId);
      if (barcode === undefined) { missing.push(l.description); continue; }
      // A scale label's code carries the weight: one label is the line. Anything else goes by its count.
      lines.push({ productId: l.productId, name: l.description, barcode, quantityMinor: lineIsWeighed({ uom: l.uom }) ? 1 : l.qty });
    }
    return missing.length > 0 ? { ok: false, missing } : { ok: true, lines };
  };

  const newCustomer = (): void => { till.newSale(); scannedWith.clear(); };

  return {
    till,
    paymentsHere: () => options.payments && !till.mirrorPilot(),
    scan: (code) => {
      const out = till.scanBarcode(code);
      scannedWith.set(out.lineId, code);
      return out;
    },
    handOverLines,
    newCustomer,
    handOver: async () => {
      const read = handOverLines();
      if (!read.ok) {
        return { ok: false, refusedBecause: 'line_without_code', lines: read.missing, laneMessage: 'These lines were not scanned on this handheld, so a till could not ring them. Void them and scan them again.', laneMessageTa: 'இந்த வரிகள் இந்தக் கருவியில் ஸ்கேன் செய்யப்படவில்லை. அவற்றை நீக்கி மீண்டும் ஸ்கேன் செய்யவும்.' };
      }
      if (read.lines.length === 0) return { ok: false, refusedBecause: 'empty_basket', laneMessage: 'There is nothing in the basket to hand over.', laneMessageTa: 'ஒப்படைக்க கூடையில் எதுவும் இல்லை.' };
      let r: Record<string, unknown>;
      try {
        r = await ports.handOver({ basketId: till.currentBillRef(), lines: read.lines, handheldTotalMinor: till.payableMinor() });
      } catch {
        return { ok: false, refusedBecause: 'box_unreachable', laneMessage: UNREACHABLE.en, laneMessageTa: UNREACHABLE.ta };
      }
      const ta = typeof r['laneMessageTa'] === 'string' ? { laneMessageTa: r['laneMessageTa'] } : {};
      if (r['handedOver'] !== true || typeof r['code'] !== 'string' || !QUEUE_CODE.test(r['code'])) {
        return { ok: false, refusedBecause: typeof r['refusedBecause'] === 'string' ? r['refusedBecause'] : 'not_handed_over', laneMessage: typeof r['laneMessage'] === 'string' ? r['laneMessage'] : UNREACHABLE.en, ...ta };
      }
      // Kept on the store computer's disk: the basket clears here for the next customer.
      newCustomer();
      return { ok: true, code: r['code'], lineCount: typeof r['lineCount'] === 'number' ? r['lineCount'] : read.lines.length, laneMessage: typeof r['laneMessage'] === 'string' ? r['laneMessage'] : '', ...ta };
    },
    waiting: async () => {
      try {
        const r = await ports.waiting();
        const list = Array.isArray(r['waiting']) ? r['waiting'] as WaitingBasket[] : null;
        return list === null ? { ok: false, baskets: [], laneMessage: typeof r['laneMessage'] === 'string' ? r['laneMessage'] : 'The store computer did not say.' } : { ok: true, baskets: list };
      } catch {
        return { ok: false, baskets: [], laneMessage: 'This handheld cannot reach the store computer.' };
      }
    },
    giveUp: async (code, reason) => {
      try {
        const r = await ports.giveUp({ code, reason });
        return { ok: r['givenUp'] === true, laneMessage: typeof r['laneMessage'] === 'string' ? r['laneMessage'] : '', ...(typeof r['laneMessageTa'] === 'string' ? { laneMessageTa: r['laneMessageTa'] } : {}) };
      } catch {
        return { ok: false, laneMessage: 'This handheld cannot reach the store computer, so nothing was changed.' };
      }
    },
  };
}
