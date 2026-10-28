// A RETAIL QUOTATION RUNG UP AT THE TILL BY ITS NUMBER (OB-506 · M12-FR-02 · hard rules #1, #5, P-08).
//
// The office made the quotation (apps/web-erp quotations page → head office's `/v1/pos/quotations/:id`): a price promised to
// a customer, held until its date. The customer comes to the till and says the number. The cashier keys it; the till asks
// ITS store computer (`POST /lane/quotations/convert`), and the box asks head office to CONVERT it — the existing convert
// flow, which refuses an expired or withdrawn quotation, and turns one quotation into ONE bill (a second bill is told which
// bill has it). Head office answers the quoted lines; the till rings each one through its OWN signed pack (so a recalled
// item, an age to ask, an item this pack does not sell are refused exactly as at a scan) and then honours the quoted price:
//   • quoted price BELOW the till's price → the line is lowered to it, the quotation named as the evidence on the line
//     (the same record a manager's price change leaves — `priceOverride`), so head office's sale check sees why;
//   • quoted price AT or ABOVE the till's price → the till's price stands: a customer is never charged more at the till
//     than the shelf asks for (and never above the MRP the pack carries) because of an old promise. Said on the screen.
// A line the till cannot ring is listed for the cashier, never dropped.
//
// OFFLINE (said plainly, never faked): the quotation and its convert rule live at head office — the till and its store
// computer hold no copy of the promise. With head office (or the store computer) out of reach NOTHING is rung, the screen
// says why in the cashier's words, and the ordinary sale is untouched (hard rule #1 — this is never on the sale path).
//
// Kept in its own file so the till's model (session.ts) and screen (app.js) carry only a few lines for it.

import type { CatalogueSnapshot } from '../../../packages/catalogue/src/catalogue';

/** The quoted line as head office answers it (the convert's `saleLines`). */
export interface QuotedLine {
  readonly lineId: string;
  readonly productId: string;
  readonly description: string;
  readonly unitPriceMinor: number;
  readonly quantityMinor: number;
  readonly uom: string;
}

/** What the box answered for a quotation number. */
export type QuotationLaneAnswer =
  | { readonly converted: true; readonly quotationId: string; readonly lines: readonly QuotedLine[]; readonly laneMessage: string }
  | { readonly converted: false; readonly refusedBecause: string; readonly laneMessage: string; readonly laneMessageTa?: string };

/** The till's call to its own store computer. */
export interface QuotationsLanePort {
  convert(input: { readonly quotationNumber: string; readonly billRef: string }): Promise<QuotationLaneAnswer>;
}

/** What the till did with a quotation, for the screen. */
export interface QuotationAtTill {
  readonly ok: boolean;
  readonly refusedBecause?: string;
  readonly laneMessage: string;
  readonly laneMessageTa?: string;
  readonly quotationId?: string;
  /** Rung at the quoted price (lowered from the till's price) or at the till's lower price. */
  readonly added?: readonly { readonly lineId: string; readonly description: string; readonly qty: number; readonly unitPriceMinor: number; readonly at: 'quoted' | 'till_lower' | 'same' }[];
  /** Not rung — the cashier deals with each. */
  readonly notAdded?: readonly { readonly productId: string; readonly name: string; readonly qty: number; readonly laneMessage: string }[];
}

/** The few till operations this needs (the view and the session, as browser-entry holds them). */
export interface QuotationTillOps {
  readonly signedIn: () => boolean;
  /** True when a bill in progress has lines a customer is waiting on (a just-paid bill does not count). */
  readonly basketInProgress: () => boolean;
  readonly committed: () => boolean;
  readonly hasCatalogue: () => boolean;
  readonly newSale: () => void;
  readonly billRef: () => string;
  readonly scanBarcode: (code: string) => { readonly lineId: string; readonly description: string; readonly qty: number };
  readonly setQuantity: (lineId: string, qty: number) => void;
  /** The line's unit price now on the bill (minor units). */
  readonly unitPriceOf: (lineId: string) => number | undefined;
  /** Lower a line's price, naming the evidence — the session's `overridePrice`. Throws when the till's rules refuse it. */
  readonly lowerPrice: (lineId: string, toUnitMinor: number, evidence: { readonly approvedBy: string; readonly activityId: string }) => void;
}

/** A quotation number as the office page prints it (eight digits), or any id head office issued (letters, digits, dashes). */
const NUMBER = /^[A-Za-z0-9][A-Za-z0-9-]{0,39}$/;

/** The till's words for this step — English and Tamil, so the screen needs no new word table. */
export const QUOTATION_TILL_WORDS = {
  en: { option: 'Quotation number', title: 'The quotation number', hint: 'The number on the customer\'s quotation. The till rings each line and keeps the quoted price.', notAdded: 'Not rung — deal with each:' },
  ta: { option: 'விலைப்புள்ளி எண்', title: 'விலைப்புள்ளி எண்', hint: 'வாடிக்கையாளரின் விலைப்புள்ளியில் உள்ள எண். ஒவ்வொரு வரியையும் பில்லிங் சேர்த்து, சொன்ன விலையை வைத்திருக்கும்.', notAdded: 'சேர்க்கப்படவில்லை — ஒவ்வொன்றையும் பாருங்கள்:' },
} as const;

/** The plain barcode for each product in the till's own pack (the first that carries no weight or price), so a quoted line
 *  is rung as a scan. */
export function barcodesByProduct(snapshot: CatalogueSnapshot | undefined): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const b of snapshot?.barcodes ?? []) {
    if (b.kind === 'weight_embedded' || b.kind === 'price_embedded' || out.has(b.productId)) continue;
    out.set(b.productId, b.code);
  }
  return out;
}

const rupees = (minor: number): string => `₹${(minor / 100).toFixed(2)}`;

/** Ring a quotation up at this till by its number (OB-506). Never throws: every answer is in the cashier's words. */
export function quotationAtTill(input: {
  readonly port: QuotationsLanePort;
  readonly ops: QuotationTillOps;
  readonly barcodeOf: (productId: string) => string | undefined;
}): (quotationNumber: string) => Promise<QuotationAtTill> {
  const { port, ops } = input;
  return async (raw) => {
    const number = raw.trim();
    if (!ops.signedIn()) return { ok: false, refusedBecause: 'operator_not_signed_in', laneMessage: 'Sign in at the till first, then key the quotation number.', laneMessageTa: 'முதலில் பில்லிங்கில் உள்நுழையவும், பிறகு விலைப்புள்ளி எண்ணை உள்ளிடவும்.' };
    if (!NUMBER.test(number)) return { ok: false, refusedBecause: 'not_a_quotation_number', laneMessage: 'Key the number printed on the customer\'s quotation.', laneMessageTa: 'வாடிக்கையாளரின் விலைப்புள்ளியில் அச்சிட்ட எண்ணை உள்ளிடவும்.' };
    if (ops.basketInProgress()) return { ok: false, refusedBecause: 'basket_not_empty', laneMessage: 'Finish or hold the basket on the till first — a quotation is rung up on its own bill.', laneMessageTa: 'முதலில் பில்லிங்கில் உள்ள கூடையை முடிக்கவும் அல்லது நிறுத்தி வைக்கவும் — விலைப்புள்ளி தனி பில்லில் சேர்க்கப்படும்.' };
    if (!ops.hasCatalogue()) return { ok: false, refusedBecause: 'no_catalogue', laneMessage: 'This till has no price pack, so it cannot ring the quotation. Nothing was rung.', laneMessageTa: 'இந்த பில்லிங்கில் விலைத் தொகுப்பு இல்லை, எனவே விலைப்புள்ளியைச் சேர்க்க முடியாது. எதுவும் சேர்க்கப்படவில்லை.' };
    // A fresh bill for the quotation: its reference is the bill the quotation becomes at head office.
    if (ops.committed()) ops.newSale();
    const answer = await port.convert({ quotationNumber: number, billRef: ops.billRef() });
    if (!answer.converted) {
      return { ok: false, refusedBecause: answer.refusedBecause, laneMessage: answer.laneMessage, ...(answer.laneMessageTa === undefined ? {} : { laneMessageTa: answer.laneMessageTa }) };
    }
    const evidence = { approvedBy: `quotation ${answer.quotationId}`, activityId: `quotation:${answer.quotationId}` };
    const added: NonNullable<QuotationAtTill['added']>[number][] = [];
    const notAdded: NonNullable<QuotationAtTill['notAdded']>[number][] = [];
    for (const l of answer.lines) {
      const name = l.description || l.productId;
      if (l.uom !== 'ea') {
        // A weighed line is weighed at the scale and its label scanned; the quoted price per kg is for the manager to apply.
        notAdded.push({ productId: l.productId, name, qty: l.quantityMinor, laneMessage: `weigh it on the scale and scan its label — the quoted price is ${rupees(l.unitPriceMinor)} per ${l.uom}; ask the manager to change the line's price` });
        continue;
      }
      const code = input.barcodeOf(l.productId);
      if (code === undefined) {
        notAdded.push({ productId: l.productId, name, qty: l.quantityMinor, laneMessage: 'this till\'s price pack has no barcode for it — scan the item' });
        continue;
      }
      try {
        // The till's OWN pack rings it (and refuses what it does not sell, a recalled item, an age not yet asked).
        const out = ops.scanBarcode(code);
        if (l.quantityMinor > 1 && out.qty === 1) ops.setQuantity(out.lineId, l.quantityMinor);
        const tillPrice = ops.unitPriceOf(out.lineId) ?? l.unitPriceMinor;
        let at: 'quoted' | 'till_lower' | 'same' = 'same';
        if (l.unitPriceMinor < tillPrice) {
          try { ops.lowerPrice(out.lineId, l.unitPriceMinor, evidence); at = 'quoted'; } catch (e) {
            const said = (e as { laneMessage?: unknown }).laneMessage;
            notAdded.push({ productId: l.productId, name, qty: l.quantityMinor, laneMessage: `rung at the till's price ${rupees(tillPrice)}, NOT the quoted ${rupees(l.unitPriceMinor)} — ${typeof said === 'string' ? said : 'the till refused the quoted price'}; ask the manager` });
            continue;
          }
        } else if (l.unitPriceMinor > tillPrice) {
          at = 'till_lower';
        }
        added.push({ lineId: out.lineId, description: out.description, qty: l.quantityMinor, unitPriceMinor: at === 'quoted' ? l.unitPriceMinor : tillPrice, at });
      } catch (e) {
        const said = (e as { laneMessage?: unknown }).laneMessage;
        notAdded.push({ productId: l.productId, name, qty: l.quantityMinor, laneMessage: typeof said === 'string' ? said : e instanceof Error ? e.message : String(e) });
      }
    }
    const lower = added.filter((a) => a.at === 'till_lower').length;
    const tail = lower === 0 ? '' : ` ${lower} line(s) are cheaper on the till today than quoted — the till's lower price is charged.`;
    return {
      ok: true, quotationId: answer.quotationId, added, notAdded,
      laneMessage: notAdded.length === 0
        ? `Quotation ${answer.quotationId}: ${added.length} line(s) rung at the quoted prices.${tail} Check the goods, then take the payment.`
        : `Quotation ${answer.quotationId}: ${added.length} line(s) rung; ${notAdded.length} need the cashier — deal with each one.${tail}`,
      laneMessageTa: notAdded.length === 0
        ? `விலைப்புள்ளி ${answer.quotationId}: ${added.length} வரி(கள்) சொன்ன விலையில் சேர்க்கப்பட்டன.${lower === 0 ? '' : ` ${lower} வரி(கள்) இன்று பில்லிங்கில் குறைந்த விலையில் உள்ளன — அந்தக் குறைந்த விலையே வசூலிக்கப்படும்.`} பொருட்களைச் சரிபார்த்து, பிறகு கட்டணத்தைப் பெறுங்கள்.`
        : `விலைப்புள்ளி ${answer.quotationId}: ${added.length} வரி(கள்) சேர்க்கப்பட்டன; ${notAdded.length} வரி(களை) காசாளர் பார்க்க வேண்டும்.`,
    };
  };
}

/** The till's quotation call over its own lane socket (`base` from browser-entry's `laneBase`). Never throws. */
export function laneQuotations(input: {
  readonly base: () => string;
  readonly headers: () => Record<string, string>;
  readonly frontRefused: Readonly<Record<number, { readonly refusedBecause: string; readonly laneMessage: string }>>;
  readonly fetch?: typeof globalThis.fetch;
}): QuotationsLanePort {
  const http = input.fetch ?? ((...a: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...a));
  return {
    convert: async ({ quotationNumber, billRef }) => {
      try {
        const response = await http(`${input.base()}/lane/quotations/convert`, { method: 'POST', headers: { 'content-type': 'application/json', ...input.headers() }, body: JSON.stringify({ quotationNumber, billRef }) });
        const front = input.frontRefused[response.status];
        if (front !== undefined) return { converted: false, ...front };
        const body = await response.json() as Record<string, unknown>;
        if (body['converted'] === true && typeof body['quotationId'] === 'string' && Array.isArray(body['lines'])) {
          return { converted: true, quotationId: body['quotationId'], lines: body['lines'] as QuotedLine[], laneMessage: typeof body['laneMessage'] === 'string' ? body['laneMessage'] : '' };
        }
        return {
          converted: false, refusedBecause: typeof body['refusedBecause'] === 'string' ? body['refusedBecause'] : 'not_readable',
          laneMessage: typeof body['laneMessage'] === 'string' ? body['laneMessage'] : 'The store computer\'s answer could not be read. Nothing was rung.',
          ...(typeof body['laneMessageTa'] === 'string' ? { laneMessageTa: body['laneMessageTa'] } : {}),
        };
      } catch {
        return { converted: false, refusedBecause: 'lane_unreachable', laneMessage: 'This till cannot reach its store computer, so the quotation cannot be rung up. Nothing was rung.', laneMessageTa: 'இந்த பில்லிங் கடைக் கணினியை அடைய முடியவில்லை, எனவே விலைப்புள்ளியைச் சேர்க்க முடியாது. எதுவும் சேர்க்கப்படவில்லை.' };
      }
    },
  };
}
