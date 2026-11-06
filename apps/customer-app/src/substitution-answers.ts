// OB-687 (owner, 4 Nov 2026) · FUL-14 · M19-FR-02 — the customer answers a swap the picker put to them, in the app.
//
// The shop's picker could not supply something the customer ordered, and the customer had asked to be asked first. Head
// office holds the proposal; the app reads it from the customer's OWN orders (`GET /v1/storefront/orders`), shows the product
// offered, its price and why, and the customer taps yes or no. The answer goes to the shop's own route
// (`POST /v1/storefront/orders/:orderId/substitutions/:lineId`) under one key per order line and answer — a lost reply that is
// tapped again is the SAME answer, never a second one. Nothing here decides anything: the shop checks the answer is for the
// swap it offered, still open and in time, and refuses it by name otherwise. Pure and DOM-free; the page lays out what it is
// told, in English or Tamil.

export type SwapState = 'waiting' | 'yes' | 'no' | 'refused' | 'too_late' | 'closed';
const STATES: readonly string[] = ['waiting', 'yes', 'no', 'refused', 'too_late', 'closed'];

/** One swap the shop put to me, as the shop holds it. */
export interface MySwap {
  readonly orderId: string;
  readonly lineId: string;
  readonly orderedName: string;
  readonly substituteProductId: string;
  readonly substituteName: string;
  /** The price per unit the shop would charge for the substitute — null when it has none published (then it cannot be offered). */
  readonly substituteUnitPriceMinor: number | null;
  readonly quantityMinor: number;
  /** Why, in the shop's words, both languages. */
  readonly whySay: { readonly en: string; readonly ta: string };
  readonly state: SwapState;
  /** Until when the shop waits for my answer (the owner's time). */
  readonly answerBy: string | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);

/** Every swap on my orders, read strictly from the shop's answer — anything it did not say is left out, never filled in. */
export function swapsFromOrders(body: unknown): readonly MySwap[] {
  if (!isObj(body) || !Array.isArray(body['orders'])) return [];
  const out: MySwap[] = [];
  for (const o of body['orders'] as unknown[]) {
    if (!isObj(o) || !Array.isArray(o['substitutions'])) continue;
    for (const s of o['substitutions'] as unknown[]) {
      if (!isObj(s)) continue;
      const orderId = str(s['orderId']) ?? str(o['orderId']);
      const lineId = str(s['lineId']);
      const sub = str(s['substituteProductId']);
      const why = isObj(s['whySay']) ? s['whySay'] : {};
      const state = typeof s['state'] === 'string' && STATES.includes(s['state']) ? (s['state'] as SwapState) : undefined;
      const qty = s['quantityMinor'];
      if (orderId === undefined || lineId === undefined || sub === undefined || state === undefined || typeof qty !== 'number') continue;
      const price = s['substituteUnitPriceMinor'];
      out.push({
        orderId, lineId, orderedName: str(s['orderedName']) ?? str(s['orderedProductId']) ?? '', substituteProductId: sub,
        substituteName: str(s['substituteName']) ?? sub, substituteUnitPriceMinor: typeof price === 'number' && Number.isInteger(price) && price >= 0 ? price : null,
        quantityMinor: qty, whySay: { en: str(why['en']) ?? '', ta: str(why['ta']) ?? str(why['en']) ?? '' }, state,
        answerBy: str(s['answerBy']) ?? null,
      });
    }
  }
  return out;
}

/** The swaps still waiting for my answer, first the one whose time runs out soonest. */
export function waitingSwaps(swaps: readonly MySwap[]): readonly MySwap[] {
  return swaps.filter((s) => s.state === 'waiting' && s.substituteUnitPriceMinor !== null)
    .slice().sort((a, b) => (a.answerBy ?? '').localeCompare(b.answerBy ?? ''));
}

/** The one key an answer is sent under: the same order line and answer is the same request, however often it is tapped. */
export const answerKey = (s: Pick<MySwap, 'orderId' | 'lineId' | 'substituteProductId'>, yes: boolean): string =>
  `swap-answer-${s.orderId}-${s.lineId}-${s.substituteProductId}-${yes ? 'yes' : 'no'}`.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 200);

/** The body the shop's answer route reads. */
export const answerBody = (s: Pick<MySwap, 'substituteProductId'>, yes: boolean): Record<string, unknown> =>
  ({ substituteProductId: s.substituteProductId, decision: yes ? 'confirmed' : 'declined' });
