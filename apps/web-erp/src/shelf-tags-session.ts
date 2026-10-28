// The Shelf tags page (OB-505 · roadmap addendum B3 · Legal Metrology · P-02 · P-08). A tested, DOM-free session over head
// office's own catalogue reads:
//   • the SIGNED PRICE PACK the tills charge from (`GET /v1/catalogue/pack`) — the selling price, the MRP, the unit and the
//     barcode, so a tag never shows a price the till would not charge (P-02);
//   • each chosen product's master record (`GET /v1/catalogue/products/:id`) — its declared net quantity (for the price per
//     kg / litre / piece) and its Tamil name.
// The tested `buildShelfTag` (packages/product/src/shelf-tag.ts) makes each tag lawful or refuses it by name: above the MRP,
// no MRP on a packaged item, a net quantity the price cannot be divided by, characters smaller than Rule 9 allows for the
// tag stock. The page then prints the tags on the person's own printer (the browser's print, no driver here — the printer
// is outside this system). Nothing is written anywhere: printing a tag changes no price. With head office out of reach
// nothing is printed — never a stale price on a shelf (P-08).
//
// Printing (OB-505: "printed from an office screen on a LABEL PRINTER"). The default is the label printer: the printed page is
// the tag stock's own size with no margin, one tag per label (`shelfTagPrintCss`); an ordinary printer gets the old sheet to
// cut. A tag's box is the stock's fixed size, so content that does not fit would be cut off unseen — before printing the
// page measures every tag and `tagsThatOverflow` refuses the print, naming each product, so the price, the MRP and the
// price per kg / litre / piece are never hidden (P-08).

import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';
import { buildShelfTag, SHELF_TAG_TEMPLATES, type ShelfTag, type ShelfTagRefusal, type ShelfTagTemplate, type TagLanguage } from '../../../packages/product/src/shelf-tag';
import { rupees } from './blanket-orders-session';

export { rupees, SHELF_TAG_TEMPLATES };
export type Lang = 'en' | 'ta';
export const TAG_LANGUAGES = ['both', 'en', 'ta'] as const;
/** How the tags are printed: on the label printer (the owner's decision, OB-505 — the default) or as a sheet to cut. */
export const PRINT_MODES = ['label', 'sheet'] as const;
export type PrintMode = (typeof PRINT_MODES)[number];

export const SHELF_TAGS_COPY = {
  en: {
    title: 'Shelf tags', lead: 'Print the price tickets for the shelf edge: the name, the till\'s price, the MRP and the price per kg, litre or piece — at the letter sizes the law asks for. The prices are the ones the tills charge today.',
    chooseH: 'Choose the products', codes: 'Barcodes, item codes or product ids — one per line', find: 'Find by name', findButton: 'Find', add: 'Add', language: 'Tag language', size: 'Tag size', make: 'Make the tags', print: 'Print the tags',
    l_both: 'English and Tamil', l_en: 'English', l_ta: 'Tamil', 'shelf-70x38': 'Shelf edge 70 × 38 mm', 'shelf-100x60': 'Large 100 × 60 mm',
    refusedH: 'Not printed — fix each one first', notesH: 'Printed — but note', none: 'No product matches.', made: 'tag(s) ready to print.', packFrom: 'Prices from price pack',
    r_not_in_pack: 'it is not in the price pack the tills charge from — publish it first', r_not_on_sale: 'the till does not sell it now (delisted, not yet on sale, or under a recall stop)', fromHeadOffice: 'head office says',
    r_no_name: 'it has no name on record', r_no_price: 'the price pack has no selling price for it', r_above_mrp: 'its selling price is above its MRP — an illegal overcharge; correct the price first', r_no_mrp: 'no MRP is on record for this packaged item',
    r_no_net_quantity: 'its net quantity is missing or cannot be read, so the price per kg / litre / piece cannot be worked out', r_unknown_unit: 'it is sold by a unit a tag cannot work a unit price from', r_too_small: 'the tag size prints letters smaller than the law allows', r_template_invalid: 'the tag size is not a valid size',
    note_no_ta: 'no Tamil name on the product — the English name is printed; add it on App content',
    t_price: 'Our price', t_mrp: 'MRP', t_save: 'You save', t_net: 'Net', t_per_kg: 'per kg', t_per_l: 'per litre', t_per_unit: 'per piece', t_loose: 'Sold by weight', t_tax: 'incl. of all taxes',
    needCodes: 'Write at least one barcode, item code or product id.', nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot read the price pack.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — no tag was made. Tags are printed only from the prices the tills charge now.',
    printer: 'Printer', mm: 'mm', m_label: 'Label printer (one tag per label)', m_sheet: 'Ordinary printer (sheet to cut)',
    labelHint: 'Load {size} labels in the label printer. In the print window choose the label printer and 100% scale.', sheetHint: 'Prints on ordinary paper; cut along the dashed lines.',
    overflowH: 'Not printed — these tags do not fit their label, so the price, MRP or price per kg would be cut off:', overflowFix: 'Shorten the product name, or choose the larger tag size, then make the tags again.',
  },
  ta: {
    title: 'அலமாரி விலைச் சீட்டுகள்', lead: 'அலமாரி ஓரத்துக்கான விலைச் சீட்டுகளை அச்சிடுங்கள்: பெயர், பில்லிங் விலை, அதிகபட்ச சில்லறை விலை, ஒரு கிலோ / லிட்டர் / துண்டுக்கான விலை — சட்டம் கேட்கும் எழுத்து அளவில். விலைகள் இன்று பில்லிங்கில் வசூலிக்கப்படுபவை.',
    chooseH: 'பொருட்களைத் தேர்ந்தெடுங்கள்', codes: 'பார்கோடுகள், பொருள் குறியீடுகள் அல்லது பொருள் அடையாளங்கள் — வரிக்கு ஒன்று', find: 'பெயரால் தேடு', findButton: 'தேடு', add: 'சேர்', language: 'சீட்டின் மொழி', size: 'சீட்டின் அளவு', make: 'சீட்டுகளை உருவாக்கு', print: 'சீட்டுகளை அச்சிடு',
    l_both: 'ஆங்கிலமும் தமிழும்', l_en: 'ஆங்கிலம்', l_ta: 'தமிழ்', 'shelf-70x38': 'அலமாரி ஓரம் 70 × 38 மி.மீ', 'shelf-100x60': 'பெரியது 100 × 60 மி.மீ',
    refusedH: 'அச்சிடப்படவில்லை — முதலில் ஒவ்வொன்றையும் சரிசெய்யுங்கள்', notesH: 'அச்சிடப்பட்டது — ஆனால் கவனிக்கவும்', none: 'எந்தப் பொருளும் பொருந்தவில்லை.', made: 'சீட்டு(கள்) அச்சிடத் தயார்.', packFrom: 'விலைகள் இந்த விலைத் தொகுப்பிலிருந்து',
    r_not_in_pack: 'இது பில்லிங் வசூலிக்கும் விலைத் தொகுப்பில் இல்லை — முதலில் வெளியிடுங்கள்', r_not_on_sale: 'பில்லிங் இப்போது இதை விற்பதில்லை (நீக்கப்பட்டது, இன்னும் விற்பனைக்கு வரவில்லை, அல்லது திரும்பப்பெறுதல் தடை)', fromHeadOffice: 'தலைமை அலுவலகம் சொல்வது',
    r_no_name: 'இதற்குப் பெயர் பதிவில் இல்லை', r_no_price: 'விலைத் தொகுப்பில் இதற்கு விற்பனை விலை இல்லை', r_above_mrp: 'இதன் விற்பனை விலை அதிகபட்ச சில்லறை விலையை விட அதிகம் — சட்டவிரோதம்; முதலில் விலையைத் திருத்துங்கள்', r_no_mrp: 'இந்தப் பொதி செய்த பொருளுக்கு அதிகபட்ச சில்லறை விலை பதிவில் இல்லை',
    r_no_net_quantity: 'இதன் நிகர அளவு இல்லை அல்லது படிக்க முடியவில்லை, எனவே ஒரு கிலோ / லிட்டர் / துண்டு விலையைக் கணக்கிட முடியாது', r_unknown_unit: 'அலகு விலை கணக்கிட முடியாத அலகில் இது விற்கப்படுகிறது', r_too_small: 'இந்தச் சீட்டு அளவில் எழுத்துகள் சட்டம் அனுமதிப்பதை விடச் சிறியவை', r_template_invalid: 'இந்தச் சீட்டு அளவு சரியானது அல்ல',
    note_no_ta: 'இந்தப் பொருளுக்குத் தமிழ்ப் பெயர் இல்லை — ஆங்கிலப் பெயர் அச்சிடப்படும்; செயலி உள்ளடக்கத்தில் சேர்க்கவும்',
    t_price: 'எங்கள் விலை', t_mrp: 'அ.சி.வி (MRP)', t_save: 'சேமிப்பு', t_net: 'நிகர அளவு', t_per_kg: 'ஒரு கிலோ', t_per_l: 'ஒரு லிட்டர்', t_per_unit: 'ஒரு துண்டு', t_loose: 'எடைக்கு விற்பனை', t_tax: 'அனைத்து வரிகளும் உட்பட',
    needCodes: 'குறைந்தது ஒரு பார்கோடு, பொருள் குறியீடு அல்லது பொருள் அடையாளத்தை எழுதுங்கள்.', nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பணி விலைத் தொகுப்பைப் படிக்க முடியாது.',
    printer: 'அச்சுப்பொறி', mm: 'மி.மீ', m_label: 'லேபிள் அச்சுப்பொறி (ஒரு லேபிளுக்கு ஒரு சீட்டு)', m_sheet: 'சாதாரண அச்சுப்பொறி (வெட்டி எடுக்கும் தாள்)',
    labelHint: 'லேபிள் அச்சுப்பொறியில் {size} லேபிள்களை வையுங்கள். அச்சு சாளரத்தில் லேபிள் அச்சுப்பொறியையும் 100% அளவையும் தேர்ந்தெடுங்கள்.', sheetHint: 'சாதாரண தாளில் அச்சிடப்படும்; கோடிட்ட கோடுகளில் வெட்டுங்கள்.',
    overflowH: 'அச்சிடப்படவில்லை — இந்தச் சீட்டுகள் லேபிளில் அடங்கவில்லை, எனவே விலை, அ.சி.வி அல்லது ஒரு கிலோ விலை வெட்டுப்படும்:', overflowFix: 'பொருளின் பெயரைச் சுருக்குங்கள், அல்லது பெரிய சீட்டு அளவைத் தேர்ந்தெடுத்து, மீண்டும் சீட்டுகளை உருவாக்குங்கள்.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எந்தச் சீட்டும் உருவாக்கப்படவில்லை. பில்லிங் இப்போது வசூலிக்கும் விலைகளிலிருந்து மட்டுமே சீட்டுகள் அச்சிடப்படும்.',
  },
} as const;

export const shelfTagsWords = (lang: Lang, key: string): string =>
  (SHELF_TAGS_COPY[lang] as Record<string, string>)[key] ?? (SHELF_TAGS_COPY.en as Record<string, string>)[key] ?? key;

/** One product as the price pack carries it (what the till charges). */
export interface PackRow {
  readonly productId: string; readonly sku: string; readonly name: string; readonly priceMinor: number; readonly mrpMinor?: number;
  readonly uom: string; readonly taxBps: number; readonly barcode?: string; readonly status: string;
  /** The till sells it (status active or clearance) and no whole-product recall stop is on it. */
  readonly onSale: boolean;
}
export interface PackView { readonly version: number; readonly builtAt: string; readonly rows: readonly PackRow[] }

/** Read the signed pack's products strictly — a row that does not read is left out, never guessed. */
export function packRowsOf(body: unknown): PackView | undefined {
  const snap = (body as { snapshot?: unknown } | null)?.snapshot as Record<string, unknown> | undefined;
  if (snap === undefined || snap === null || !Array.isArray(snap['products'])) return undefined;
  const firstCode = new Map<string, string>();
  for (const b of Array.isArray(snap['barcodes']) ? snap['barcodes'] as { code?: unknown; productId?: unknown; kind?: unknown }[] : []) {
    if (typeof b.code === 'string' && typeof b.productId === 'string' && b.kind !== 'weight_embedded' && b.kind !== 'price_embedded' && !firstCode.has(b.productId)) firstCode.set(b.productId, b.code);
  }
  const rows: PackRow[] = [];
  for (const p of snap['products'] as Record<string, unknown>[]) {
    if (typeof p['productId'] !== 'string' || typeof p['name'] !== 'string' || !Number.isInteger(p['unitPriceMinor'])) continue;
    const code = firstCode.get(p['productId']);
    rows.push({
      productId: p['productId'], sku: typeof p['sku'] === 'string' ? p['sku'] : '', name: p['name'], priceMinor: p['unitPriceMinor'] as number,
      ...(Number.isInteger(p['mrpMinor']) ? { mrpMinor: p['mrpMinor'] as number } : {}),
      uom: typeof p['baseUom'] === 'string' ? p['baseUom'] : 'ea', taxBps: Number.isInteger(p['taxBps']) ? p['taxBps'] as number : 0,
      ...(code === undefined ? {} : { barcode: code }), status: typeof p['status'] === 'string' ? p['status'] : '',
      onSale: (p['status'] === 'active' || p['status'] === 'clearance') && !(p['recallBlock'] === true && !Array.isArray(p['blockedBatches'])),
    });
  }
  return { version: Number(snap['version'] ?? 0), builtAt: typeof snap['builtAt'] === 'string' ? snap['builtAt'] : '', rows };
}

/** A typed code against the pack: the exact barcode, then the item code (SKU), then the product id. */
export function rowFor(pack: PackView, code: string): PackRow | undefined {
  const c = code.trim();
  if (c === '') return undefined;
  return pack.rows.find((r) => r.barcode === c) ?? pack.rows.find((r) => r.sku === c) ?? pack.rows.find((r) => r.productId === c);
}

export interface Refused { readonly code: string; readonly name?: string; readonly refusal: ShelfTagRefusal | 'not_in_pack' | 'not_on_sale'; readonly detail: string }
export interface TagSheet { readonly tags: readonly ShelfTag[]; readonly refused: readonly Refused[]; readonly packVersion: number; readonly builtAt: string }
export interface TagForm { readonly codes: string; readonly language: string; readonly templateId: string }

type Why = 'nobody' | 'cannotRead' | 'needCodes';
type Done<T> = Promise<Outcome<T, Why>>;

export interface ShelfTagsSession {
  readonly may: { readonly named: boolean; readonly read: boolean };
  /** Products in the pack whose name, code or barcode contains the text (at most 20). */
  find(text: string): Done<readonly PackRow[]>;
  /** Make the tags for the typed codes — each lawful, or refused by name. */
  prepare(form: TagForm): Done<TagSheet>;
}

export const shelfTagsOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => {
  if (out.result !== 'ok') return outcomeIn((k) => shelfTagsWords(lang, k), out);
  const v = (out.value ?? {}) as { tags?: unknown[] };
  return Array.isArray(v.tags) ? `${v.tags.length} ${shelfTagsWords(lang, 'made')}` : '';
};

/** The words printed on a tag, in a language (the tag itself, not the screen). */
export function tagWords(lang: Lang): { readonly price: string; readonly mrp: string; readonly save: string; readonly net: string; readonly per: Readonly<Record<'kg' | 'l' | 'unit', string>>; readonly loose: string; readonly tax: string } {
  const w = (k: string) => shelfTagsWords(lang, k);
  return { price: w('t_price'), mrp: w('t_mrp'), save: w('t_save'), net: w('t_net'), per: { kg: w('t_per_kg'), l: w('t_per_l'), unit: w('t_per_unit') }, loose: w('t_loose'), tax: w('t_tax') };
}

/**
 * The print rules for a sheet of tags, injected into the page for each print (the browser's own print — no driver here).
 * Either way only the tags are laid out — the screen around them is taken out, not just made invisible — so the printer
 * feeds no blank label or blank sheet for it.
 *   • 'label' — the label printer: the printed page IS the tag stock (its own width × height), no margin, one tag per page,
 *     no cut lines;
 *   • 'sheet' — an ordinary printer: the tags in a grid on the paper with an 8 mm margin and dashed cut lines.
 */
export function shelfTagPrintCss(template: Pick<ShelfTagTemplate, 'widthMm' | 'heightMm'>, mode: PrintMode): string {
  const tagsAlone = [
    '  html, body { margin: 0 !important; padding: 0 !important; min-height: 0 !important; }',
    '  body *:not(:has(#sheet)):not(#sheet):not(#sheet *) { display: none !important; }',
    '  body *:has(#sheet) { display: block !important; position: static !important; margin: 0 !important; padding: 0 !important; border: 0 !important; gap: 0 !important; min-height: 0 !important; width: auto !important; }',
    '  #sheet { position: static !important; }',
  ];
  const paper = mode === 'sheet'
    ? ['  @page { margin: 8mm; }']
    : [
      `  @page { size: ${template.widthMm}mm ${template.heightMm}mm; margin: 0; }`,
      '  #sheet { display: block !important; gap: 0 !important; }',
      '  #sheet .tag { border: 0 !important; margin: 0 !important; break-after: page; page-break-after: always; }',
      '  #sheet .tag:last-child { break-after: auto; page-break-after: auto; }',
    ];
  return ['@media print {', ...paper, ...tagsAlone, '}'].join('\n');
}

/** One drawn tag as the page measured it (CSS pixels): its box, everything inside it, and any part drawn outside the box. */
export interface TagMeasure {
  readonly productId: string;
  readonly name: string;
  readonly boxWidth: number; readonly boxHeight: number;
  readonly contentWidth: number; readonly contentHeight: number;
  /** The parts (price, mrp, unit, name…) whose drawn edge falls outside the tag's inner box. */
  readonly partsOutside: readonly string[];
}
/** Half a pixel either way is the browser rounding a millimetre box, not content cut off. */
const ROUNDING_PX = 1;
/** The tags whose content does not fit their label — any one of them refuses the print, named. */
export function tagsThatOverflow(measures: readonly TagMeasure[]): readonly { readonly productId: string; readonly name: string; readonly partsOutside: readonly string[] }[] {
  return measures
    .filter((m) => m.contentHeight > m.boxHeight + ROUNDING_PX || m.contentWidth > m.boxWidth + ROUNDING_PX || m.partsOutside.length > 0)
    .map((m) => ({ productId: m.productId, name: m.name, partsOutside: m.partsOutside }));
}
/** The refusal the page shows when tags overflow: what is wrong, each product by name, and how to fix it. */
export function overflowWords(lang: Lang, names: readonly string[]): string {
  return `${shelfTagsWords(lang, 'overflowH')} ${names.join(', ')}. ${shelfTagsWords(lang, 'overflowFix')}`;
}
/** The line telling the person what to load and choose, for the chosen printer and tag size. */
export function printHint(lang: Lang, mode: PrintMode, template: Pick<ShelfTagTemplate, 'widthMm' | 'heightMm'>): string {
  return mode === 'sheet' ? shelfTagsWords(lang, 'sheetHint') : shelfTagsWords(lang, 'labelHint').replace('{size}', `${template.widthMm} × ${template.heightMm} ${shelfTagsWords(lang, 'mm')}`);
}

export function createShelfTagsSession(input: {
  readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined;
  readonly fetch?: typeof globalThis.fetch;
}): ShelfTagsSession {
  const named = input.viewer?.userId !== undefined;
  const may = { named, read: named && (input.viewer?.permissions ?? []).includes('catalogue.pack.read') };
  const call = makeCaller({ keyPrefix: 'shelf-tags', ...(input.fetch === undefined ? {} : { fetch: input.fetch }) });
  const gate = (): { result: 'invalid'; why: Why } | undefined => (!named ? { result: 'invalid', why: 'nobody' } : !may.read ? { result: 'invalid', why: 'cannotRead' } : undefined);
  // The pack is read afresh for every sheet: a tag is printed from the prices the tills charge NOW, never a copy (P-08).
  const readPack = async (): Promise<Outcome<PackView, never>> => {
    const out = await call<unknown>('GET', '/v1/catalogue/pack');
    if (out.result !== 'ok') return out;
    const pack = packRowsOf(out.value);
    return pack === undefined ? { result: 'refused', status: 502, code: 'pack_not_readable', whatHappened: 'the price pack head office sent could not be read' } : { result: 'ok', value: pack };
  };
  return {
    may,
    find: async (text) => {
      const no = gate(); if (no !== undefined) return no;
      const pack = await readPack();
      if (pack.result !== 'ok') return pack;
      const t = text.trim().toLowerCase();
      if (t === '') return { result: 'ok', value: [] };
      return { result: 'ok', value: pack.value.rows.filter((r) => r.name.toLowerCase().includes(t) || r.sku.toLowerCase() === t || r.barcode === text.trim()).slice(0, 20) };
    },
    prepare: async (form) => {
      const no = gate(); if (no !== undefined) return no;
      const codes = [...new Set(form.codes.split(/[\n,]+/).map((c) => c.trim()).filter((c) => c !== ''))];
      if (codes.length === 0) return { result: 'invalid', why: 'needCodes' };
      const language: TagLanguage = (TAG_LANGUAGES as readonly string[]).includes(form.language) ? form.language as TagLanguage : 'both';
      const template = SHELF_TAG_TEMPLATES.find((t) => t.templateId === form.templateId) ?? SHELF_TAG_TEMPLATES[0]!;
      const pack = await readPack();
      if (pack.result !== 'ok') return pack;
      const tags: ShelfTag[] = [];
      const refused: Refused[] = [];
      for (const code of codes) {
        const row = rowFor(pack.value, code);
        if (row === undefined) { refused.push({ code, refusal: 'not_in_pack', detail: 'not in the price pack the tills charge from' }); continue; }
        // A tag for something the till will not sell (delisted, a draft, a recall stop) would invite a sale the lane refuses.
        if (!row.onSale) { refused.push({ code, name: row.name, refusal: 'not_on_sale', detail: `the till does not sell it now (${row.status === '' ? 'no status' : row.status}${row.status === 'active' || row.status === 'clearance' ? ', under a recall stop' : ''})` }); continue; }
        // The master record: its net quantity and Tamil name. A product never published there simply has neither (said by
        // the tag rules), but a lost line or a refusal stops the whole sheet — never half a sheet presented as whole.
        const master = await call<{ product?: { appContent?: { nameTa?: unknown }; safety?: { netQuantity?: unknown } } }>('GET', `/v1/catalogue/products/${encodeURIComponent(row.productId)}`);
        if (master.result === 'lost_link') return master;
        if (master.result === 'refused' && master.status !== 404) return master;
        const product = master.result === 'ok' ? master.value.product : undefined;
        const nameTa = typeof product?.appContent?.nameTa === 'string' ? product.appContent.nameTa : undefined;
        const netQuantity = typeof product?.safety?.netQuantity === 'string' ? product.safety.netQuantity : undefined;
        const built = buildShelfTag({
          productId: row.productId, ...(row.sku === '' ? {} : { sku: row.sku }), ...(row.barcode === undefined ? {} : { barcode: row.barcode }),
          name: row.name, ...(nameTa === undefined ? {} : { nameTa }), sellingPriceMinor: row.priceMinor,
          ...(row.mrpMinor === undefined ? {} : { mrpMinor: row.mrpMinor }), baseUom: row.uom, ...(netQuantity === undefined ? {} : { netQuantity }),
        }, template, language);
        if (built.ok) tags.push(built.tag); else refused.push({ code, name: row.name, refusal: built.refusal, detail: built.detail });
      }
      return { result: 'ok', value: { tags, refused, packVersion: pack.value.version, builtAt: pack.value.builtAt } };
    },
  };
}
