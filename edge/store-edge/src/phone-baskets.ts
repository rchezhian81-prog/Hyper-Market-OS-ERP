// SCAN-AND-GO AT THE LANE — the store computer brings a customer's phone basket up for the cashier (OB-350 · R8-3 · D04-FR-06
// · hard rules #1, #5).
//
// The customer's phone built the basket and handed it to head office, which answered a six-digit code. At the till the
// cashier keys that code; the till asks THIS box (`POST /lane/phone-baskets/recall`), and the box asks head office under its
// own store credential (`POST /v1/store/scan-and-go/:code/recall`) for the cashier it verified. Head office gives the
// lines — product, count and the barcode to scan — ONCE (a second till is refused, naming the first). No price comes back:
// the till rings every line through its own signed pack, so the price is the till's.
//
// This is a convenience, never a dependency of a sale (hard rule #1). With the line down the box says so in the cashier's
// words and the cashier scans the items as for any customer. Nothing here is kept on the box's disk: the record of the
// recall is head office's, and the sale the till rings is the box's as always.

export interface PhoneBasketLineForTill {
  readonly productId: string;
  readonly name: string;
  readonly quantityMinor: number;
  readonly barcode: string;
}

export type PhoneBasketAnswer =
  | { readonly recalled: true; readonly code: string; readonly lines: readonly PhoneBasketLineForTill[]; readonly laneMessage: string }
  | { readonly recalled: false; readonly refusedBecause: string; readonly laneMessage: string };

export interface PhoneBasketsPort {
  recall(input: { readonly code: unknown; readonly laneId: string; readonly cashierId: string }): Promise<PhoneBasketAnswer>;
}

import { randomUUID } from 'node:crypto';

const CODE = /^\d{6}$/;
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The lines as head office sent them, read strictly — a line the till could not ring is not passed on as if it could. */
function linesOf(v: unknown): PhoneBasketLineForTill[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: PhoneBasketLineForTill[] = [];
  for (const l of v) {
    if (!isObj(l) || typeof l['productId'] !== 'string' || typeof l['barcode'] !== 'string' || l['barcode'] === '' || typeof l['name'] !== 'string'
      || !Number.isInteger(l['quantityMinor']) || (l['quantityMinor'] as number) < 1) return undefined;
    out.push({ productId: l['productId'], name: l['name'], quantityMinor: l['quantityMinor'] as number, barcode: l['barcode'] });
  }
  return out;
}

const UNREACHABLE = 'Head office cannot be reached, so the phone basket cannot be brought up. Scan the items as usual — the sale does not need it.';

/** Ask head office for a phone basket, under this box's own credential. Never throws: every answer is in the cashier's words. */
export function httpPhoneBaskets(options: {
  readonly baseUrl: string;
  /** Bearer token for this store. Read from configuration; never logged (hard rule #4). */
  readonly token: string;
  readonly fetch: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}): PhoneBasketsPort {
  const timeoutMs = options.timeoutMs ?? 8_000;
  const base = options.baseUrl.replace(/\/+$/, '');
  return {
    recall: async ({ code, laneId, cashierId }) => {
      if (typeof code !== 'string' || !CODE.test(code.trim())) {
        return { recalled: false, refusedBecause: 'not_a_basket_code', laneMessage: 'A phone basket code is six digits, as the customer\'s phone shows it.' };
      }
      const c = code.trim();
      const controller = new AbortController();
      const timer = setTimeout(() => { controller.abort(); }, timeoutMs);
      try {
        // A fresh key per ask: head office's answer is "once", so a second ask must reach the rule, never a replayed first reply.
        const response = await options.fetch(`${base}/v1/store/scan-and-go/${c}/recall`, {
          method: 'POST',
          headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json', 'idempotency-key': `sg-recall-${c}-${laneId}-${randomUUID()}` },
          body: JSON.stringify({ laneId, cashierId }), signal: controller.signal,
        });
        const body = await response.json().catch(() => undefined) as Record<string, unknown> | undefined;
        const said = isObj(body?.['error']) && typeof body!['error']['whatHappened'] === 'string' ? body!['error']['whatHappened'] as string : undefined;
        if (response.status === 404) return { recalled: false, refusedBecause: 'no_such_phone_basket', laneMessage: said ?? `No phone basket is held under ${c}. Check the code on the customer's phone, or scan the items.` };
        if (response.status === 409) return { recalled: false, refusedBecause: 'already_recalled', laneMessage: said ?? 'This basket was already brought up at another till.' };
        if (response.status === 401 || response.status === 403) return { recalled: false, refusedBecause: 'head_office_refused', laneMessage: 'Head office did not let this store computer bring the basket up. Scan the items, and tell the manager.' };
        if (response.status < 200 || response.status >= 300) return { recalled: false, refusedBecause: 'head_office_unreachable', laneMessage: UNREACHABLE };
        const lines = linesOf(body?.['lines']);
        if (body?.['recalled'] !== true || lines === undefined || lines.length === 0) {
          return { recalled: false, refusedBecause: 'not_readable', laneMessage: 'Head office\'s answer could not be read. Scan the items as usual.' };
        }
        return { recalled: true, code: c, lines, laneMessage: `Phone basket ${c}: ${lines.length} line(s). The till prices them now.` };
      } catch {
        return { recalled: false, refusedBecause: 'head_office_unreachable', laneMessage: UNREACHABLE };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
