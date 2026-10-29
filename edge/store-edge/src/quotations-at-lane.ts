// A RETAIL QUOTATION RUNG UP AT A TILL LANE — the store computer asks head office to convert it (OB-506 · M12-FR-02 ·
// hard rules #1, #4, P-08).
//
// The till keys the quotation's number and asks THIS box (`POST /lane/quotations/convert`); the box asks head office under
// its own store credential (`POST /v1/pos/quotations/:id/convert` — the existing convert flow, `pos.quotation.convert`) for
// the bill the cashier is ringing. Head office converts the quotation ONCE: an expired or withdrawn one is refused, a
// second bill is told which bill already has it, and the same bill asking again (its first answer lost) gets the lines
// back. The answer is the quoted lines, each price exactly as head office holds it; the till rings them through its own
// pack at the quoted price — lowered or raised (owner, 28 Oct 2026) — and refuses a line quoted above the MRP its pack
// carries (Legal Metrology). This box judges no price: it relays.
//
// The quotation and its convert rule are head office's alone — this box holds no copy of any promise, so with head office
// out of reach the box says so in the cashier's words and NOTHING is rung (never a guessed price, never a faked success).
// The ordinary sale never needs this (hard rule #1). Nothing here is kept on the box's disk.

import { randomUUID } from 'node:crypto';

export interface QuotedLineForTill {
  readonly lineId: string;
  readonly productId: string;
  readonly description: string;
  readonly unitPriceMinor: number;
  readonly quantityMinor: number;
  readonly uom: string;
}

export type QuotationConvertAnswer =
  | { readonly converted: true; readonly quotationId: string; readonly lines: readonly QuotedLineForTill[]; readonly laneMessage: string }
  | { readonly converted: false; readonly refusedBecause: string; readonly laneMessage: string; readonly laneMessageTa: string };

export interface QuotationsAtLanePort {
  convert(input: { readonly quotationNumber: unknown; readonly billRef: unknown; readonly laneId: string; readonly cashierId: string }): Promise<QuotationConvertAnswer>;
}

const NUMBER = /^[A-Za-z0-9][A-Za-z0-9-]{0,39}$/;
const BILL_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The quoted lines as head office sent them, read strictly — a line the till could not ring is not passed on as if it could. */
function linesOf(v: unknown): QuotedLineForTill[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: QuotedLineForTill[] = [];
  for (const l of v) {
    if (!isObj(l) || typeof l['lineId'] !== 'string' || typeof l['productId'] !== 'string' || typeof l['description'] !== 'string' || typeof l['uom'] !== 'string'
      || !Number.isInteger(l['unitPriceMinor']) || (l['unitPriceMinor'] as number) < 0 || !Number.isInteger(l['quantityMinor']) || (l['quantityMinor'] as number) < 1) return undefined;
    out.push({ lineId: l['lineId'], productId: l['productId'], description: l['description'], unitPriceMinor: l['unitPriceMinor'] as number, quantityMinor: l['quantityMinor'] as number, uom: l['uom'] });
  }
  return out;
}

const no = (refusedBecause: string, laneMessage: string, laneMessageTa: string): QuotationConvertAnswer => ({ converted: false, refusedBecause, laneMessage, laneMessageTa });

/** Head office cannot be reached — said plainly; nothing rung. */
export const QUOTATION_NEEDS_HEAD_OFFICE = no(
  'head_office_unreachable',
  'A quotation is rung up through head office, and head office cannot be reached now. Nothing was rung. Try again when the line is back — the customer\'s quoted price is still held there.',
  'விலைப்புள்ளி தலைமை அலுவலகம் வழியாகவே சேர்க்கப்படும்; இப்போது தலைமை அலுவலகத்தை அடைய முடியவில்லை. எதுவும் சேர்க்கப்படவில்லை. இணைப்பு திரும்பியதும் மீண்டும் முயலவும் — வாடிக்கையாளரின் விலை அங்கே பாதுகாப்பாக உள்ளது.',
);

/** Ask head office to convert a quotation, under this box's own credential. Never throws: every answer is in the cashier's words. */
export function httpQuotations(options: {
  readonly baseUrl: string;
  /** Bearer token for this store. Read from configuration; never logged (hard rule #4). */
  readonly token: string;
  readonly fetch: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}): QuotationsAtLanePort {
  const timeoutMs = options.timeoutMs ?? 8_000;
  const base = options.baseUrl.replace(/\/+$/, '');
  return {
    convert: async ({ quotationNumber, billRef, laneId, cashierId }) => {
      if (typeof quotationNumber !== 'string' || !NUMBER.test(quotationNumber.trim())) {
        return no('not_a_quotation_number', 'Key the number printed on the customer\'s quotation.', 'வாடிக்கையாளரின் விலைப்புள்ளியில் அச்சிட்ட எண்ணை உள்ளிடவும்.');
      }
      if (typeof billRef !== 'string' || !BILL_REF.test(billRef)) {
        return no('no_bill', 'The till did not say which bill this is. Nothing was rung — start a new bill and try again.', 'இது எந்த பில் என்று பில்லிங் சொல்லவில்லை. எதுவும் சேர்க்கப்படவில்லை — புதிய பில்லைத் தொடங்கி மீண்டும் முயலவும்.');
      }
      const id = quotationNumber.trim();
      const controller = new AbortController();
      const timer = setTimeout(() => { controller.abort(); }, timeoutMs);
      try {
        const response = await options.fetch(`${base}/v1/pos/quotations/${encodeURIComponent(id)}/convert`, {
          method: 'POST',
          // A fresh key per ask: the convert's own rule (one quotation, one bill) answers a repeat — never a replayed reply.
          headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json', 'idempotency-key': `quote-convert-${id}-${laneId}-${randomUUID()}` },
          body: JSON.stringify({ saleId: billRef, laneId, cashierId }), signal: controller.signal,
        });
        const body = await response.json().catch(() => undefined) as Record<string, unknown> | undefined;
        const said = isObj(body?.['error']) && typeof body!['error']['whatHappened'] === 'string' ? body!['error']['whatHappened'] as string : undefined;
        const code = isObj(body?.['error']) && typeof body!['error']['code'] === 'string' ? body!['error']['code'] as string : undefined;
        if (response.status === 404) return no('no_such_quotation', `There is no quotation ${id}. Check the number on the customer's quotation.`, `${id} என்ற விலைப்புள்ளி இல்லை. வாடிக்கையாளரின் விலைப்புள்ளியில் உள்ள எண்ணைச் சரிபார்க்கவும்.`);
        if (response.status === 422 && code === 'quotation_expired') return no('quotation_expired', `${said ?? 'This quotation has expired.'} Nothing was rung — the office can quote again.`, 'இந்த விலைப்புள்ளியின் காலம் முடிந்துவிட்டது. எதுவும் சேர்க்கப்படவில்லை — அலுவலகம் மீண்டும் விலைப்புள்ளி தரலாம்.');
        if (response.status === 422 && code === 'quotation_withdrawn') return no('quotation_withdrawn', `This quotation was withdrawn${said === undefined ? '' : ` (head office says: ${said})`}. Nothing was rung.`, 'இந்த விலைப்புள்ளி திரும்பப் பெறப்பட்டது. எதுவும் சேர்க்கப்படவில்லை.');
        // A quotation is rung up only at the store it was made for — said as such, never as a vague refusal.
        if (response.status === 403 && code === 'quotation_for_another_store') return no('quotation_for_another_store', `Quotation ${id} was made for another store, so it cannot be rung up at this store. Nothing was rung — ring it up at that store, or ask the office to quote again for this store.`, `விலைப்புள்ளி ${id} வேறு கடைக்காகத் தயாரிக்கப்பட்டது, எனவே இந்தக் கடையில் சேர்க்க முடியாது. எதுவும் சேர்க்கப்படவில்லை — அந்தக் கடையில் சேர்க்கவும், அல்லது இந்தக் கடைக்கு மீண்டும் விலைப்புள்ளி தர அலுவலகத்திடம் கேளுங்கள்.`);
        if (response.status === 401 || response.status === 403) return no('head_office_refused', 'Head office did not let this store computer ring the quotation up. Nothing was rung — tell the manager.', 'இந்தக் கடைக் கணினி விலைப்புள்ளியைச் சேர்க்க தலைமை அலுவலகம் அனுமதிக்கவில்லை. எதுவும் சேர்க்கப்படவில்லை — மேலாளரிடம் சொல்லவும்.');
        if (response.status >= 400 && response.status < 500) return no('head_office_refused', `Head office refused: ${said ?? `status ${response.status}`}. Nothing was rung.`, 'தலைமை அலுவலகம் மறுத்தது. எதுவும் சேர்க்கப்படவில்லை.');
        if (response.status < 200 || response.status >= 300) return QUOTATION_NEEDS_HEAD_OFFICE;
        if (body?.['alreadyConverted'] === true && body['sameSale'] !== true) {
          const bill = typeof body['saleId'] === 'string' ? body['saleId'] : 'another bill';
          return no('already_converted', `Quotation ${id} was already rung up on bill ${bill}. A quotation becomes one bill — nothing was rung.`, `விலைப்புள்ளி ${id} ஏற்கனவே ${bill} பில்லில் சேர்க்கப்பட்டது. ஒரு விலைப்புள்ளி ஒரே பில் — எதுவும் சேர்க்கப்படவில்லை.`);
        }
        const lines = linesOf(body?.['saleLines']);
        if ((body?.['converted'] !== true && body?.['sameSale'] !== true) || lines === undefined || lines.length === 0) {
          return no('not_readable', 'Head office\'s answer could not be read. Nothing was rung — tell the manager.', 'தலைமை அலுவலகத்தின் பதிலைப் படிக்க முடியவில்லை. எதுவும் சேர்க்கப்படவில்லை — மேலாளரிடம் சொல்லவும்.');
        }
        return { converted: true, quotationId: id, lines, laneMessage: `Quotation ${id}: ${lines.length} line(s). The till rings them now.` };
      } catch {
        return QUOTATION_NEEDS_HEAD_OFFICE;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
