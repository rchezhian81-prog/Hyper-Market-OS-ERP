// The Stock ledger page's session model (U6 of the UI/UX gap audit, 7 Nov 2026 · §27 Inventory "Ledger" · M08-FR-01 ·
// hard rule #2 · P-08). DOM-free and tested.
//
// The movement ledger is the one true record of stock; this page is the first screen that shows it to a person — one
// product at a time (head office reads it no other way), optionally at one place and inside a window, every line with its
// effect and the balance after it. Nothing is written here. Every word has a Tamil twin; the ids a line carries are shown as
// names by the page through the chrome's directory where it knows them.

import type { HeadOfficeHttp, HttpAnswer } from './head-office-http';
import { refusalWords } from './refusal-words';
import { quantityLabel } from '../../../packages/contracts/src/quantity';
import { shopDateIn } from '../../../packages/calendar/src/shop-clock';
import { servedShopZone } from '../../../packages/calendar/src/shop-day';

export type Lang = 'en' | 'ta';
export interface StockLedgerViewer { readonly userId?: string; readonly permissions: readonly string[] }

/** One ledger line as head office hands it (`GET /v1/inventory/ledger`). */
export interface LedgerLineRow {
  readonly movementId: string; readonly productId: string; readonly locationId: string; readonly kind: string;
  readonly effect: 1 | -1; readonly quantityMinor: number; readonly uom: string; readonly occurredAt: string;
  readonly batchId: string | null; readonly expiry: string | null; readonly reason: string | null;
  readonly enteredBy: string; readonly approvedBy: string | null; readonly balanceAfterMinor: number;
}
export interface LedgerRead {
  readonly productId: string; readonly locationId: string | null; readonly from: string | null; readonly to: string | null;
  readonly lines: readonly LedgerLineRow[]; readonly count: number; readonly inMinor: number; readonly outMinor: number;
  readonly places: readonly { readonly locationId: string; readonly onHandMinor: number }[]; readonly movementsEver: number; readonly asAt: string;
}

export type Refused = { readonly result: 'refused'; readonly status: number; readonly code: string; readonly whatHappened: string };
export type Outcome<T> = ({ readonly result: 'ok' } & T) | Refused | { readonly result: 'lost_link' } | { readonly result: 'invalid'; readonly key: string };

const WORDS: Readonly<Record<Lang, Readonly<Record<string, string>>>> = Object.freeze({
  en: {
    title: 'Stock ledger',
    lede: 'Every movement of one product, in the order head office recorded it, with the stock left after each. The ledger is never edited: a correction is a new line with a reason and a person.',
    product: 'Product', place: 'Place', allPlaces: 'Every place', from: 'From', to: 'To', show: 'Show the ledger',
    whichProduct: 'Which product?', whichPlace: 'Which place?', choose: 'Choose…',
    onHandH: 'On hand now', onHandAt: 'at', linesH: 'Movements', movementsShown: 'Movements shown', cameIn: 'Came in', wentOut: 'Went out', everH: 'Movements ever recorded',
    colWhen: 'When', colKind: 'What happened', colQty: 'Quantity', colPlace: 'Place', colBatch: 'Batch', colReason: 'Reason', colBy: 'Entered by', colApproved: 'Approved by', colBalance: 'Stock after',
    received: 'Delivery received', sold: 'Sold at the till', returned: 'Returned by a customer', transferred_in: 'Transferred in', transferred_out: 'Transferred out',
    adjusted: 'Corrected upwards', wasted: 'Written off', counted: 'Counted', returned_to_supplier: 'Returned to the supplier',
    consumed_in_production: 'Used in production', produced: 'Produced', opening_reversed: 'Opening stock reversed',
    noReason: '—', noApprover: '—', noBatch: '—',
    reading: 'Reading from head office…', unreachable: 'Head office cannot be reached — nothing was read.', refused: 'Head office refused:',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot read the stock ledger.',
    needProduct: 'Choose the product first.', badWindow: 'The "from" day is after the "to" day.',
    empty: 'No movement of this product here in this window.', emptyDetail: 'Widen the window or choose every place. The on-hand figure above still counts every movement ever recorded.',
    neverMoved: 'Head office holds no movement of this product.', neverMovedDetail: 'Nothing has been received, sold, counted or corrected for it at any place you may see.',
    asAt: 'Read from head office at', covers: 'This ledger covers the places your role may see.',
  },
  ta: {
    title: 'சரக்குப் பேரேடு',
    lede: 'ஒரு பொருளின் ஒவ்வொரு நகர்வும், தலைமை அலுவலகம் பதிவு செய்த வரிசையில், ஒவ்வொன்றுக்குப் பின் மீதமுள்ள சரக்குடன். பேரேடு ஒருபோதும் திருத்தப்படாது: ஒரு திருத்தம் என்பது காரணமும் நபரும் கொண்ட புதிய வரி.',
    product: 'பொருள்', place: 'இடம்', allPlaces: 'எல்லா இடங்களும்', from: 'முதல்', to: 'வரை', show: 'பேரேட்டைக் காட்டு',
    whichProduct: 'எந்தப் பொருள்?', whichPlace: 'எந்த இடம்?', choose: 'தேர்வு…',
    onHandH: 'இப்போது கையிருப்பு', onHandAt: 'இடத்தில்', linesH: 'நகர்வுகள்', movementsShown: 'காட்டப்பட்ட நகர்வுகள்', cameIn: 'உள்ளே வந்தது', wentOut: 'வெளியே சென்றது', everH: 'இதுவரை பதிவான நகர்வுகள்',
    colWhen: 'எப்போது', colKind: 'என்ன நடந்தது', colQty: 'அளவு', colPlace: 'இடம்', colBatch: 'தொகுதி', colReason: 'காரணம்', colBy: 'பதிவு செய்தவர்', colApproved: 'ஒப்புதல் அளித்தவர்', colBalance: 'பின் சரக்கு',
    received: 'விநியோகம் பெறப்பட்டது', sold: 'கல்லாவில் விற்கப்பட்டது', returned: 'வாடிக்கையாளர் திருப்பினார்', transferred_in: 'உள்ளே மாற்றப்பட்டது', transferred_out: 'வெளியே மாற்றப்பட்டது',
    adjusted: 'மேல்நோக்கித் திருத்தப்பட்டது', wasted: 'தள்ளுபடி செய்யப்பட்டது', counted: 'எண்ணப்பட்டது', returned_to_supplier: 'சப்ளையருக்குத் திருப்பப்பட்டது',
    consumed_in_production: 'உற்பத்தியில் பயன்பட்டது', produced: 'உற்பத்தி செய்யப்பட்டது', opening_reversed: 'தொடக்கச் சரக்கு திரும்பப் பெறப்பட்டது',
    noReason: '—', noApprover: '—', noBatch: '—',
    reading: 'தலைமை அலுவலகத்திலிருந்து படிக்கிறது…', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை.', refused: 'தலைமை அலுவலகம் மறுத்தது:',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பங்கு சரக்குப் பேரேட்டைப் படிக்க முடியாது.',
    needProduct: 'முதலில் பொருளைத் தேர்ந்தெடுக்கவும்.', badWindow: '"முதல்" நாள் "வரை" நாளுக்குப் பின் உள்ளது.',
    empty: 'இந்தக் காலத்தில் இங்கே இந்தப் பொருளின் நகர்வு இல்லை.', emptyDetail: 'காலத்தை விரிவாக்கவும் அல்லது எல்லா இடங்களையும் தேர்வு செய்யவும். மேலே உள்ள கையிருப்பு எண்ணிக்கை இதுவரை பதிவான ஒவ்வொரு நகர்வையும் கணக்கிடுகிறது.',
    neverMoved: 'தலைமை அலுவலகத்தில் இந்தப் பொருளின் நகர்வு எதுவும் இல்லை.', neverMovedDetail: 'நீங்கள் பார்க்கக்கூடிய எந்த இடத்திலும் இதற்கு எதுவும் பெறப்படவோ, விற்கப்படவோ, எண்ணப்படவோ, திருத்தப்படவோ இல்லை.',
    asAt: 'தலைமை அலுவலகத்திலிருந்து படித்த நேரம்', covers: 'இந்தப் பேரேடு உங்கள் பங்கு பார்க்கக்கூடிய இடங்களை உள்ளடக்கியது.',
  },
});
export const STOCK_LEDGER_WORD_KEYS: readonly string[] = Object.freeze(Object.keys(WORDS.en));
export const text = (lang: Lang, key: string): string => WORDS[lang][key] ?? WORDS.en[key] ?? key;

/** A moment as the shop reads it — its own date and 24-hour time in the shop's zone (OB-606 · OB-607), never the device's. */
export function shopMomentOf(iso: string, timeZone: string = servedShopZone()): string {
  if (Number.isNaN(Date.parse(iso))) return iso;
  const time = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
  return `${shopDateIn(iso, timeZone)} ${time}`;
}

/** OB-31: a quantity as a person reads it, signed by the movement's effect — "+100 kg", "−2.500 kg". */
export const signedQuantity = (line: Pick<LedgerLineRow, 'effect' | 'quantityMinor' | 'uom'>): string => `${line.effect === 1 ? '+' : '−'}${quantityLabel(line.quantityMinor, line.uom)}`;

/** One line as the register shows it. */
export function lineView(lang: Lang, line: LedgerLineRow) {
  return {
    ...line,
    when: shopMomentOf(line.occurredAt),
    kindWord: text(lang, line.kind),
    quantity: signedQuantity(line),
    balance: quantityLabel(line.balanceAfterMinor, line.uom),
    reasonWord: line.reason === null || line.reason === '' ? text(lang, 'noReason') : line.reason,
    approvedWord: line.approvedBy === null ? text(lang, 'noApprover') : line.approvedBy,
    batchWord: line.batchId === null ? text(lang, 'noBatch') : line.batchId,
    /** The chip's tone: stock that came in is `ok`, stock that went out is `idle` — the kind's words carry the meaning. */
    tone: line.effect === 1 ? 'ok' : 'idle',
  };
}

const enc = encodeURIComponent;
const refusedOrLost = (a: HttpAnswer): Refused | { readonly result: 'lost_link' } => (a.result === 'lost_link' ? a : { result: 'refused', status: a.status, code: a.result === 'refused' ? a.code : 'unreadable_answer', whatHappened: a.result === 'refused' ? a.whatHappened : '' });
const isRead = (b: unknown): b is LedgerRead => b !== null && typeof b === 'object' && Array.isArray((b as { lines?: unknown }).lines) && Array.isArray((b as { places?: unknown }).places);

export interface LedgerAsk { readonly productId: string; readonly locationId: string; readonly fromIso: string; readonly toIso: string }

/** The query head office is asked, or what is missing: a product is required; a window must be the right way round. */
export function ledgerQuery(ask: LedgerAsk): { readonly query: string } | { readonly key: string } {
  const productId = ask.productId.trim();
  if (productId === '') return { key: 'needProduct' };
  const from = ask.fromIso.trim(); const to = ask.toIso.trim();
  if (from !== '' && to !== '' && from > to) return { key: 'badWindow' };
  const parts = [`productId=${enc(productId)}`];
  if (ask.locationId.trim() !== '') parts.push(`locationId=${enc(ask.locationId.trim())}`);
  // A window typed as shop days: the whole first day to the whole last day (the shop's own zone is the API's reading).
  if (from !== '') parts.push(`from=${enc(`${from}T00:00:00.000Z`)}`);
  if (to !== '') parts.push(`to=${enc(`${to}T23:59:59.999Z`)}`);
  return { query: parts.join('&') };
}

export function createStockLedgerSession(viewer: StockLedgerViewer | undefined, http: HeadOfficeHttp) {
  const perms = new Set(viewer?.permissions ?? []);
  const nobody = viewer === undefined;
  const may = { read: perms.has('inventory.availability.read') };
  return {
    nobody, userId: viewer?.userId ?? null, may, text, lineView, shopMomentOf, signedQuantity,
    async read(ask: LedgerAsk): Promise<Outcome<{ readonly ledger: LedgerRead }>> {
      if (nobody) return { result: 'invalid', key: 'nobody' };
      if (!may.read) return { result: 'invalid', key: 'cannotRead' };
      const q = ledgerQuery(ask);
      if ('key' in q) return { result: 'invalid', key: q.key };
      const a = await http.get(`/v1/inventory/ledger?${q.query}`);
      if (a.result !== 'ok') return refusedOrLost(a);
      if (!isRead(a.body)) return { result: 'refused', status: a.status, code: 'unreadable_answer', whatHappened: '' };
      return { result: 'ok', ledger: a.body };
    },
    /** The status line for an outcome, in the reader's language — head office's own words when it refused. */
    say(lang: Lang, out: Outcome<unknown>, good = ''): { readonly tone: 'good' | 'err'; readonly words: string } {
      if (out.result === 'ok') return { tone: 'good', words: good === '' ? '' : text(lang, good) };
      if (out.result === 'lost_link') return { tone: 'err', words: text(lang, 'unreachable') };
      if (out.result === 'invalid') return { tone: 'err', words: text(lang, out.key) };
      return { tone: 'err', words: refusalWords(lang, out) };
    },
  };
}
export type StockLedgerSession = ReturnType<typeof createStockLedgerSession>;
