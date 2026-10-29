// The Quotations page (OB-506 · M12-FR-02). A tested, DOM-free session over head office's own retail-quotation routes
// (services/pos/src/quotations.ts), which until now no screen reached:
//   • MAKE a quotation — a price promised to a customer for the counted items they ask about, held until a date. Each line is
//     a product from the SIGNED PRICE PACK (so the till can ring it), its quantity and the price promised (the till's price
//     when left blank). Head office moves NO stock for it, and refuses a below-floor price without a second person's approval
//     (the approval id is sent when one was given — ADR-0024). Its number is eight digits, so the cashier keys it at the till.
//   • LIST them (all, or by state) and the FOLLOW-UP list (expiring soon first, lapsed ones said — a quote is a sale the shop
//     already worked for);
//   • VOID (withdraw) one with a reason — kept on record, never deleted (hard rule #6).
// The cashier rings a quotation up at the till by its number (apps/pos — the existing convert flow, through the store
// computer). Head office re-checks every permission; `may` only shapes what is offered. Nothing is read on open.
//
// Round 8 · OB-525 (owner, 28 Oct 2026): the page sends NO floor and NO cost — head office reads each product's floor itself.
// When it refuses a line below its floor, the page keeps that quotation's number and lines, and offers to ASK a second person
// (the maker-checker engine, kind `quotation_below_floor`, for exactly this quotation); once approved, the approval id is
// written in and the same quotation made again. A product whose floor head office cannot read is said on the answer.
// Round 9 · OB-532 (owner, 28 Oct 2026): a quotation on a product whose floor head office cannot read (never received at a
// cost) needs the OWNER's approval — head office refuses it (`quotation_floor_not_known_unapproved`), and the page offers to
// ask the OWNER (kind `quotation_floor_not_known`) for exactly that quotation; the person quoting can never approve it.
// Round 10 · OB-542 (owner, 28 Oct 2026): when the person quoting is the OWNER himself, head office refuses it as
// `quotation_floor_not_known_owner_quoted_unapproved`, and the page offers to ask the ACCOUNTANT (kind
// `quotation_floor_not_known_owner_quoted`) for exactly that quotation instead.
// Round 11 · OB-602 (owner, 28 Oct 2026): the same for the owner's own quotation BELOW the floor — head office refuses it as
// `quotation_below_floor_owner_quoted_unapproved`, and the page asks the ACCOUNTANT (kind `quotation_below_floor_owner_quoted`).

import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';
import { paiseOf, rupees } from './blanket-orders-session';
import { packRowsOf, rowFor, type PackView } from './shelf-tags-session';
import { shopDateIn } from '../../../packages/calendar/src/shop-clock';
import { shiftDate } from '../../../packages/calendar/src/trading-day';

export { rupees };
export type Lang = 'en' | 'ta';
export const QUOTATION_STATES = ['', 'issued', 'converted', 'withdrawn', 'expired'] as const;

export const QUOTATIONS_COPY = {
  en: {
    title: 'Quotations', lead: 'A price promised to a customer, held until a date. No stock is set aside. The customer brings the number to a till and the cashier rings it up at the quoted prices.',
    makeH: 'Make a quotation', store: 'Store code', customer: 'Customer (account, name or firm)', validUntil: 'Price held until', approval: 'Approval id (only for a price below the margin floor)',
    lineCode: 'Barcode or item code', lineQty: 'How many', linePrice: 'Promised price each (₹ — blank: the till\'s price)', addLine: 'Add the line', removeLine: 'Remove', make: 'Make the quotation',
    linesH: 'Lines', noLines: 'No line yet.', each: 'each', total: 'Total',
    listH: 'Quotations at head office', state: 'Show', s_: 'All', s_issued: 'Open', s_converted: 'Rung up', s_withdrawn: 'Voided', s_expired: 'Expired', show: 'Show the list', followUp: 'Follow up (expiring soon)',
    number: 'Number', until: 'held until', by: 'by', rungOn: 'rung up on bill', voidedBecause: 'voided:', daysLeft: 'day(s) left', lapsed: 'lapsed', none: 'No quotation.',
    voidReason: 'Why it is voided', void: 'Void it', made: 'Quotation made at head office. Its number — give it to the customer:', voided: 'Voided at head office. It stays on record.',
    needMake: 'Write the store code, the customer, a date from today on, and at least one line.', needLine: 'Write a barcode or item code from the price pack, a whole number more than 0, and a price in rupees if given.',
    notCounted: 'is sold by weight — a quotation is for counted items (weigh weighed goods at the till).', notInPack: 'is not in the price pack the tills charge from.', needReason: 'Write why the quotation is voided.',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot read quotations.', cannotWrite: 'Your role cannot make or void quotations.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or saved.',
    askApproval: 'Ask a second person to approve this price', askedApproval: 'Approval asked. When the owner (or another person who approves prices) approves it in Approvals, write its id here and press "Make the quotation" again — without changing the lines. Its id:',
    needBelowFloor: 'Make the quotation first; ask for approval only when head office says a price is below its floor.', belowFloorReason: 'a quoted price below the product\'s floor price',
    floorNotKnown: 'Head office does not know the floor price of (never received at a cost):',
    freedFrom: 'freed again from cancelled bill',
    askOwner: 'Ask the owner to approve this price', askedOwner: 'Owner\'s approval asked. Head office does not know the lowest price of an item here (it was never received at a cost), so only the owner may approve it. When the owner approves it in Approvals, write its id here and press "Make the quotation" again — without changing the lines. Its id:',
    floorNotKnownReason: 'a quoted price on a product whose lowest price is not known (never received at a cost) — only the owner may approve it',
    // R10-A · OB-542
    askAccountant: 'Ask the accountant to approve this price', askedAccountant: 'Accountant\'s approval asked. Head office does not know the lowest price of an item here (it was never received at a cost), and you are the owner, so the accountant approves it. When the accountant approves it in Approvals, write its id here and press "Make the quotation" again — without changing the lines. Its id:',
    floorNotKnownOwnerReason: 'the owner quotes a price on a product whose lowest price is not known (never received at a cost) — the accountant approves it',
    // R11-A · OB-602
    askedAccountantBelow: 'Accountant\'s approval asked. A price here is below its product\'s floor price, and you are the owner, so the accountant approves it. When the accountant approves it in Approvals, write its id here and press "Make the quotation" again — without changing the lines. Its id:',
    belowFloorOwnerReason: 'the owner quotes a price below the product\'s floor price — the accountant approves it',
  },
  ta: {
    title: 'விலைப்புள்ளிகள்', lead: 'ஒரு வாடிக்கையாளருக்குச் சொன்ன விலை, ஒரு தேதி வரை நிலைக்கும். சரக்கு ஒதுக்கப்படாது. வாடிக்கையாளர் எண்ணை பில்லிங்குக்குக் கொண்டு வருவார்; காசாளர் சொன்ன விலையில் சேர்ப்பார்.',
    makeH: 'விலைப்புள்ளி உருவாக்கு', store: 'கடைக் குறியீடு', customer: 'வாடிக்கையாளர் (கணக்கு, பெயர் அல்லது நிறுவனம்)', validUntil: 'விலை நிலைக்கும் தேதி', approval: 'அனுமதி அடையாளம் (லாப வரம்புக்குக் கீழான விலைக்கு மட்டும்)',
    lineCode: 'பார்கோடு அல்லது பொருள் குறியீடு', lineQty: 'எத்தனை', linePrice: 'ஒன்றுக்குச் சொன்ன விலை (₹ — காலியாக: பில்லிங் விலை)', addLine: 'வரியைச் சேர்', removeLine: 'நீக்கு', make: 'விலைப்புள்ளியை உருவாக்கு',
    linesH: 'வரிகள்', noLines: 'இன்னும் வரி இல்லை.', each: 'ஒன்றுக்கு', total: 'மொத்தம்',
    listH: 'தலைமை அலுவலகத்தில் உள்ள விலைப்புள்ளிகள்', state: 'காட்டு', s_: 'அனைத்தும்', s_issued: 'திறந்தவை', s_converted: 'பில்லில் சேர்ந்தவை', s_withdrawn: 'ரத்து செய்தவை', s_expired: 'காலாவதியானவை', show: 'பட்டியலைக் காட்டு', followUp: 'தொடர்ந்து கவனி (விரைவில் காலாவதி)',
    number: 'எண்', until: 'நிலைக்கும் தேதி', by: 'செய்தவர்', rungOn: 'சேர்ந்த பில்', voidedBecause: 'ரத்து:', daysLeft: 'நாள்(கள்) மீதம்', lapsed: 'காலாவதி', none: 'விலைப்புள்ளி இல்லை.',
    voidReason: 'ரத்து செய்யும் காரணம்', void: 'ரத்து செய்', made: 'தலைமை அலுவலகத்தில் விலைப்புள்ளி உருவானது. அதன் எண் — வாடிக்கையாளரிடம் கொடுங்கள்:', voided: 'தலைமை அலுவலகத்தில் ரத்தானது. பதிவில் இருக்கும்.',
    needMake: 'கடைக் குறியீடு, வாடிக்கையாளர், இன்று அல்லது அதற்குப் பிந்தைய தேதி, குறைந்தது ஒரு வரி ஆகியவற்றை எழுதுங்கள்.', needLine: 'விலைத் தொகுப்பில் உள்ள பார்கோடு அல்லது பொருள் குறியீடு, 0-ஐ விட அதிகமான முழு எண், கொடுத்தால் ரூபாயில் விலை ஆகியவற்றை எழுதுங்கள்.',
    notCounted: 'எடைக்கு விற்கப்படுகிறது — விலைப்புள்ளி எண்ணிக்கைப் பொருட்களுக்கு மட்டும் (எடைப் பொருட்களை பில்லிங்கில் எடை போடுங்கள்).', notInPack: 'பில்லிங் வசூலிக்கும் விலைத் தொகுப்பில் இல்லை.', needReason: 'விலைப்புள்ளியை ரத்து செய்யும் காரணத்தை எழுதுங்கள்.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பணி விலைப்புள்ளிகளைப் படிக்க முடியாது.', cannotWrite: 'உங்கள் பணி விலைப்புள்ளிகளை உருவாக்கவோ ரத்து செய்யவோ முடியாது.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கவோ சேமிக்கவோ இல்லை.',
    askApproval: 'இந்த விலைக்கு இரண்டாவது நபரின் அனுமதி கேள்', askedApproval: 'அனுமதி கேட்கப்பட்டது. உரிமையாளர் (அல்லது விலைகளை அனுமதிக்கும் மற்றொருவர்) அனுமதிகள் பக்கத்தில் அனுமதித்ததும், அதன் அடையாளத்தை இங்கே எழுதி, வரிகளை மாற்றாமல் "விலைப்புள்ளியை உருவாக்கு" மீண்டும் அழுத்தவும். அடையாளம்:',
    needBelowFloor: 'முதலில் விலைப்புள்ளியை உருவாக்கவும்; ஒரு விலை குறைந்தபட்ச விலைக்குக் கீழ் என்று தலைமை அலுவலகம் சொன்னால் மட்டும் அனுமதி கேளுங்கள்.', belowFloorReason: 'பொருளின் குறைந்தபட்ச விலைக்குக் கீழான சொன்ன விலை',
    floorNotKnown: 'இவற்றின் குறைந்தபட்ச விலை தலைமை அலுவலகத்துக்குத் தெரியாது (விலையுடன் ஒருபோதும் வரவில்லை):',
    freedFrom: 'ரத்தான பில்லிலிருந்து மீண்டும் விடுவிக்கப்பட்டது',
    askOwner: 'இந்த விலைக்கு உரிமையாளரின் அனுமதி கேள்', askedOwner: 'உரிமையாளரின் அனுமதி கேட்கப்பட்டது. இங்குள்ள ஒரு பொருளின் குறைந்தபட்ச விலை தலைமை அலுவலகத்துக்குத் தெரியாது (விலையுடன் ஒருபோதும் வரவில்லை), எனவே உரிமையாளர் மட்டுமே அனுமதிக்க முடியும். உரிமையாளர் அனுமதிகள் பக்கத்தில் அனுமதித்ததும், அதன் அடையாளத்தை இங்கே எழுதி, வரிகளை மாற்றாமல் "விலைப்புள்ளியை உருவாக்கு" மீண்டும் அழுத்தவும். அடையாளம்:',
    floorNotKnownReason: 'குறைந்தபட்ச விலை தெரியாத பொருளுக்குச் சொன்ன விலை (விலையுடன் ஒருபோதும் வரவில்லை) — உரிமையாளர் மட்டுமே அனுமதிக்க முடியும்',
    // R10-A · OB-542
    askAccountant: 'இந்த விலைக்குக் கணக்காளரின் அனுமதி கேள்', askedAccountant: 'கணக்காளரின் அனுமதி கேட்கப்பட்டது. இங்குள்ள ஒரு பொருளின் குறைந்தபட்ச விலை தலைமை அலுவலகத்துக்குத் தெரியாது (விலையுடன் ஒருபோதும் வரவில்லை), நீங்களே உரிமையாளர் என்பதால் கணக்காளர் அனுமதிப்பார். கணக்காளர் அனுமதிகள் பக்கத்தில் அனுமதித்ததும், அதன் அடையாளத்தை இங்கே எழுதி, வரிகளை மாற்றாமல் "விலைப்புள்ளியை உருவாக்கு" மீண்டும் அழுத்தவும். அடையாளம்:',
    floorNotKnownOwnerReason: 'குறைந்தபட்ச விலை தெரியாத பொருளுக்கு உரிமையாளரே சொன்ன விலை (விலையுடன் ஒருபோதும் வரவில்லை) — கணக்காளர் அனுமதிப்பார்',
    // R11-A · OB-602
    askedAccountantBelow: 'கணக்காளரின் அனுமதி கேட்கப்பட்டது. இங்குள்ள ஒரு விலை அந்தப் பொருளின் குறைந்தபட்ச விலைக்குக் கீழே உள்ளது, நீங்களே உரிமையாளர் என்பதால் கணக்காளர் அனுமதிப்பார். கணக்காளர் அனுமதிகள் பக்கத்தில் அனுமதித்ததும், அதன் அடையாளத்தை இங்கே எழுதி, வரிகளை மாற்றாமல் "விலைப்புள்ளியை உருவாக்கு" மீண்டும் அழுத்தவும். அடையாளம்:',
    belowFloorOwnerReason: 'உரிமையாளரே பொருளின் குறைந்தபட்ச விலைக்குக் கீழே சொன்ன விலை — கணக்காளர் அனுமதிப்பார்',
  },
} as const;

export const quotationsWords = (lang: Lang, key: string): string =>
  (QUOTATIONS_COPY[lang] as Record<string, string>)[key] ?? (QUOTATIONS_COPY.en as Record<string, string>)[key] ?? key;

/** A line as the person is building it, already read against the pack. */
export interface DraftLine { readonly productId: string; readonly description: string; readonly quantity: number; readonly unitPriceMinor: number; readonly uom: string; readonly taxBps: number }
export interface QuotationRow {
  readonly quotationId: string; readonly storeId: string; readonly customerRef: string; readonly state: string; readonly totalMinor: number; readonly validUntil: string;
  readonly issuedBy: string; readonly issuedAt: string; readonly convertedSaleId?: string; readonly withdrawReason?: string;
  /** OB-523: each cancelled bill that freed it again — who, why, which bill (kept, never removed). */
  readonly releases?: readonly { readonly saleId: string; readonly freedBy: string; readonly reason: string; readonly at: string }[];
  readonly lines: readonly { readonly description: string; readonly quantityMinor: number; readonly unitPriceMinor: number }[];
}
export interface MakeForm { readonly storeId: string; readonly customerRef: string; readonly validUntil: string; readonly approvalId: string; readonly lines: readonly DraftLine[] }

type Why = 'nobody' | 'cannotRead' | 'cannotWrite' | 'needMake' | 'needLine' | 'notCounted' | 'notInPack' | 'needReason' | 'needBelowFloor';
type Done<T> = Promise<Outcome<T, Why>>;

export interface QuotationsSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly write: boolean };
  /** A line for the quotation, read against the signed price pack (the till must be able to ring it). */
  line(form: { readonly code: string; readonly qty: string; readonly priceRupees: string }): Done<DraftLine>;
  make(form: MakeForm): Done<{ readonly quotationId: string; readonly totalMinor: number; readonly validUntil: string; readonly floorNotKnown?: readonly string[] }>;
  /** OB-525: the quotation head office last refused as below its floor (its number), while it waits for an approval. */
  belowFloor(): string | undefined;
  /** OB-532: that refused quotation needs the OWNER's approval (a product with no known floor), not any second person's. */
  needsOwner(): boolean;
  /** OB-542: that refused quotation is the OWNER's own on a product with no known floor — the ACCOUNTANT approves it. */
  needsAccountant(): boolean;
  /** OB-525: ask a second person to approve exactly that quotation (maker-checker, kind `quotation_below_floor`); OB-532: ask
   *  the owner (kind `quotation_floor_not_known`) when head office said a product's floor is not known. */
  askApproval(): Done<{ readonly requestId: string }>;
  list(state: string): Done<{ readonly quotations: readonly QuotationRow[] }>;
  followUp(): Done<{ readonly quotations: readonly { readonly quotationId: string; readonly customerRef: string; readonly valueMinor: number; readonly daysLeft: number; readonly detail: string }[] }>;
  void(quotationId: string, reason: string): Done<{ readonly quotationId: string; readonly state: string }>;
}

/** The default "held until": a week from the shop's today (the person may change it). */
export const defaultValidUntil = (nowIso: string = new Date().toISOString()): string => shiftDate(shopDateIn(nowIso), 7);
/** An eight-digit quotation number — what the cashier keys on the till's number pad. */
export const newQuotationNumber = (): string => {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => String(b % 10)).join('').replace(/^0/, '1');
};

export const quotationsOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => {
  if (out.result !== 'ok') return outcomeIn((k) => quotationsWords(lang, k), out);
  const v = (out.value ?? {}) as Record<string, unknown>;
  if (v['state'] === 'withdrawn') return quotationsWords(lang, 'voided');
  if (typeof v['quotationId'] === 'string' && typeof v['totalMinor'] === 'number') {
    const notKnown = Array.isArray(v['floorNotKnown']) && v['floorNotKnown'].length > 0 ? ` ${quotationsWords(lang, 'floorNotKnown')} ${(v['floorNotKnown'] as unknown[]).join(', ')}.` : '';
    return `${quotationsWords(lang, 'made')} ${v['quotationId']}${notKnown}`;
  }
  if (typeof v['requestId'] === 'string') return `${quotationsWords(lang, v['kind'] === 'quotation_floor_not_known' ? 'askedOwner' : v['kind'] === 'quotation_floor_not_known_owner_quoted' ? 'askedAccountant' : v['kind'] === 'quotation_below_floor_owner_quoted' ? 'askedAccountantBelow' : 'askedApproval')} ${v['requestId']}`;
  return '';
};

export function createQuotationsSession(input: {
  readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined;
  readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string; readonly newNumber?: () => string; readonly now?: () => string;
}): QuotationsSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = { named, read: named && held.has('pos.quotation.read'), write: named && held.has('pos.quotation.write') };
  const call = makeCaller({ keyPrefix: 'quotation', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  const numberOf = input.newNumber ?? newQuotationNumber;
  const now = input.now ?? (() => new Date().toISOString());
  const gate = (need: 'read' | 'write'): { result: 'invalid'; why: Why } | undefined =>
    !named ? { result: 'invalid', why: 'nobody' } : !may[need] ? { result: 'invalid', why: need === 'read' ? 'cannotRead' : 'cannotWrite' } : undefined;
  let pack: PackView | undefined; // read once per page — a line is checked against the pack the tills charge from
  // OB-525: the quotation head office refused as below its floor — kept (number and exact body) so the approval asked for
  // it, and the same quotation made again with that approval, are for exactly this quotation.
  // Who approves it: a second person (below floor), the owner (OB-532) or — the owner's own — the accountant (OB-542).
  let draft: { readonly quotationId: string; readonly key: string; readonly body: Record<string, unknown>; readonly approver: 'second' | 'owner' | 'accountant' | 'accountant_below' } | undefined;
  return {
    may,
    line: async (f) => {
      const no = gate('write'); if (no !== undefined) return no;
      const qty = /^\d+$/.test(f.qty.trim()) ? Number(f.qty.trim()) : 0;
      const typed = f.priceRupees.trim() === '' ? undefined : paiseOf(f.priceRupees);
      if (f.code.trim() === '' || qty <= 0 || typed === null) return { result: 'invalid', why: 'needLine' };
      if (pack === undefined) {
        const out = await call<unknown>('GET', '/v1/catalogue/pack');
        if (out.result !== 'ok') return out;
        const read = packRowsOf(out.value);
        if (read === undefined) return { result: 'refused', status: 502, code: 'pack_not_readable', whatHappened: 'the price pack head office sent could not be read' };
        pack = read;
      }
      const row = rowFor(pack, f.code);
      if (row === undefined) return { result: 'invalid', why: 'notInPack' };
      // A quotation's line value is price × quantity — right only for a COUNTED item (a weighed one is weighed at the till).
      if (row.uom !== 'ea') return { result: 'invalid', why: 'notCounted' };
      return { result: 'ok', value: { productId: row.productId, description: row.name, quantity: qty, unitPriceMinor: typed ?? row.priceMinor, uom: row.uom, taxBps: row.taxBps } };
    },
    make: async (f) => {
      const no = gate('write'); if (no !== undefined) return no;
      const today = shopDateIn(now());
      if (f.storeId.trim() === '' || f.customerRef.trim() === '' || !/^\d{4}-\d{2}-\d{2}$/.test(f.validUntil) || f.validUntil < today || f.lines.length === 0) return { result: 'invalid', why: 'needMake' };
      const body: Record<string, unknown> = {
        storeId: f.storeId.trim(), customerRef: f.customerRef.trim(), currency: 'INR', validUntil: f.validUntil,
        lines: f.lines.map((l, i) => ({ lineId: `l${i + 1}`, productId: l.productId, description: l.description, unitPriceMinor: l.unitPriceMinor, quantityMinor: l.quantity, uom: l.uom, taxBps: l.taxBps })),
      };
      const key = JSON.stringify(body);
      // The same quotation asked again (after a below-floor refusal) keeps its number — a changed one is a new quotation.
      const quotationId = draft !== undefined && draft.key === key ? draft.quotationId : numberOf();
      const out = await call<{ quotationId: string; totalMinor: number; validUntil: string; floorNotKnown?: string[] }>('POST', `/v1/pos/quotations/${encodeURIComponent(quotationId)}`, {
        ...body, ...(f.approvalId.trim() === '' ? {} : { approvalId: f.approvalId.trim() }),
      });
      if (out.result === 'ok') draft = undefined;
      else if (out.result === 'refused' && (out.code === 'quotation_below_floor_unapproved' || out.code === 'quotation_floor_not_known_unapproved' || out.code === 'quotation_floor_not_known_owner_quoted_unapproved' || out.code === 'quotation_below_floor_owner_quoted_unapproved')) {
        // OB-532: the owner's; OB-542: the owner's own quotation — the accountant's.
        draft = { quotationId, key, body, approver: out.code === 'quotation_floor_not_known_unapproved' ? 'owner' : out.code === 'quotation_floor_not_known_owner_quoted_unapproved' ? 'accountant'
          : out.code === 'quotation_below_floor_owner_quoted_unapproved' ? 'accountant_below' : 'second' }; // OB-602: the owner's own below-floor price
      }
      else if (draft !== undefined && draft.key !== key) draft = undefined;
      return out;
    },
    belowFloor: () => draft?.quotationId,
    needsOwner: () => draft?.approver === 'owner',
    needsAccountant: () => draft?.approver === 'accountant' || draft?.approver === 'accountant_below',
    askApproval: async () => {
      const no = gate('write'); if (no !== undefined) return no;
      if (draft === undefined) return { result: 'invalid', why: 'needBelowFloor' };
      // Exactly the body the quotation is made with, plus its path id (the engine fingerprints these).
      if (draft.approver === 'accountant_below') { // R11-A · OB-602
        return call('POST', '/v1/approvals/requests', {
          kind: 'quotation_below_floor_owner_quoted', subjectRef: draft.quotationId, details: { ...draft.body, quotationId: draft.quotationId }, valueMinor: null,
          summary: `Quotation ${draft.quotationId} for ${String(draft.body['customerRef'])}, made by the owner, quotes a price below the product's floor price — accountant's approval`,
          reason: quotationsWords('en', 'belowFloorOwnerReason'),
        });
      }
      if (draft.approver === 'accountant') {
        return call('POST', '/v1/approvals/requests', {
          kind: 'quotation_floor_not_known_owner_quoted', subjectRef: draft.quotationId, details: { ...draft.body, quotationId: draft.quotationId }, valueMinor: null,
          summary: `Quotation ${draft.quotationId} for ${String(draft.body['customerRef'])}, made by the owner, quotes a product whose lowest price is not known — accountant's approval`,
          reason: quotationsWords('en', 'floorNotKnownOwnerReason'),
        });
      }
      return call('POST', '/v1/approvals/requests', draft.approver === 'owner'
        ? {
          kind: 'quotation_floor_not_known', subjectRef: draft.quotationId, details: { ...draft.body, quotationId: draft.quotationId }, valueMinor: null,
          summary: `Quotation ${draft.quotationId} for ${String(draft.body['customerRef'])} quotes a product whose lowest price is not known — owner's approval`,
          reason: quotationsWords('en', 'floorNotKnownReason'),
        }
        : {
          kind: 'quotation_below_floor', subjectRef: draft.quotationId, details: { ...draft.body, quotationId: draft.quotationId }, valueMinor: null,
          summary: `Quotation ${draft.quotationId} for ${String(draft.body['customerRef'])} quotes a price below the product's floor price`,
          reason: quotationsWords('en', 'belowFloorReason'),
        });
    },
    list: async (state) => {
      const no = gate('read'); if (no !== undefined) return no;
      const s = (QUOTATION_STATES as readonly string[]).includes(state) ? state : '';
      return call('GET', `/v1/pos/quotations${s === '' ? '' : `?state=${s}`}`);
    },
    followUp: async () => {
      const no = gate('read'); if (no !== undefined) return no;
      return call('GET', '/v1/pos/quotations/follow-up');
    },
    void: async (quotationId, reason) => {
      const no = gate('write'); if (no !== undefined) return no;
      if (reason.trim() === '') return { result: 'invalid', why: 'needReason' };
      return call('POST', `/v1/pos/quotations/${encodeURIComponent(quotationId)}/withdraw`, { reason: reason.trim() });
    },
  };
}
