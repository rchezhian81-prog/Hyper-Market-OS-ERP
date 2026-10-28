import { describe, it, expect } from 'vitest';
import { buildShelfTag, fontSizeMmFor, SHELF_TAG_TEMPLATES, CAP_HEIGHT_OF_FONT, type ShelfTagProduct, type ShelfTagTemplate } from '../../packages/product/src/shelf-tag';
import { minLabelHeightMm } from '../../packages/product/src/label-height';
import { createShelfTagsSession, shelfTagsOutcomeWords, packRowsOf, rowFor, tagWords, SHELF_TAGS_COPY, PRINT_MODES, shelfTagPrintCss, tagsThatOverflow, overflowWords, printHint, type TagMeasure } from '../../apps/web-erp/src/shelf-tags-session';
import { wireShelfTagsAndQuotations } from '../../apps/web-erp/src/shelf-quotes-browser-wiring';
import { ERP_NAVIGATION } from '../../apps/web-erp/src/navigation';
import { HEAD_OFFICE_PAGE_SCREENS, HEAD_OFFICE_PAGE_GLOBALS } from '../../edge/store-edge/src/head-office-pages';
import { buildSurface } from '../../services/api/src/main';
import { InMemoryEventStore } from '../../packages/persistence/src/event-store';

/**
 * **A shelf tag is lawful before it prints (OB-505 · roadmap addendum B3 · Legal Metrology Rule 9 · P-02 · P-08).**
 * The tag shows the till's price (from the signed pack), the MRP, and the price per kg / litre / piece worked out by the
 * tested `unitSalePrice`; every character is at least as tall as Rule 9 asks for the tag stock (`validateLabelHeight`, the
 * counter label's template approach), and the screen prints at a font size that keeps it so. Refused by name, never printed
 * wrong: above the MRP, no MRP on a packaged item, a net quantity the price cannot be divided by, characters too small. The
 * session calls only head office's own routes; with head office out of reach nothing is printed. Synthetic data only.
 */

const STD = SHELF_TAG_TEMPLATES[0]!;
const DAL: ShelfTagProduct = { productId: 'P-DAL', sku: 'DAL-500', barcode: '8901000000011', name: 'Toor dal 500 g', nameTa: 'துவரம் பருப்பு 500 கி', sellingPriceMinor: 72_00, mrpMinor: 80_00, baseUom: 'ea', netQuantity: '500 g' };

describe('buildShelfTag — the tag rules', () => {
  it('a packed item: the till\'s price, the MRP, the saving, ₹ per kg from its net quantity, and Rule 9 heights for its stock', () => {
    const r = buildShelfTag(DAL, STD, 'both');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tag).toMatchObject({ nameEn: 'Toor dal 500 g', nameTa: 'துவரம் பருப்பு 500 கி', sellingPriceMinor: 72_00, mrpMinor: 80_00, savingMinor: 8_00, loose: false, netQuantity: '500 g', unitPrice: { unitPriceMinor: 144_00, per: 'kg' } });
    // 70 × 38 mm = 26.6 cm² → Rule 9's smallest band (1 mm); every part judged against it.
    expect(r.tag.heights.letters).toMatchObject({ principalPanelAreaCm2: 26.6, minHeightMm: minLabelHeightMm(26.6), valid: true });
    expect(r.tag.heights.price.declaredHeightMm).toBe(8);
    // The screen's font size prints a character at least the judged height (cap height ≈ 0.7 em).
    for (const k of ['letters', 'numerals', 'price'] as const) expect(r.tag.fontMm[k] * CAP_HEIGHT_OF_FONT).toBeGreaterThanOrEqual(r.tag.heights[k].declaredHeightMm);
    expect(r.tag.notes).toEqual([]);
  });

  it('₹ per litre and per piece; an item sold by weight shows its price per kg and needs no MRP', () => {
    const oil = buildShelfTag({ ...DAL, productId: 'P-OIL', name: 'Groundnut oil 1 L', sellingPriceMinor: 189_00, mrpMinor: 210_00, netQuantity: '1 L' }, STD, 'en');
    expect(oil.ok && oil.tag.unitPrice).toEqual({ unitPriceMinor: 189_00, per: 'l', exempt: false });
    const soap = buildShelfTag({ ...DAL, productId: 'P-SOAP', name: 'Soap pack', sellingPriceMinor: 120_00, mrpMinor: 120_00, netQuantity: '4 pieces' }, STD, 'en');
    expect(soap.ok && soap.tag.unitPrice).toMatchObject({ unitPriceMinor: 30_00, per: 'unit' });
    expect(soap.ok && soap.tag.savingMinor).toBeUndefined();
    const onions = buildShelfTag({ productId: 'P-ONION', name: 'Onion', sellingPriceMinor: 42_00, baseUom: 'kg' }, STD, 'en');
    expect(onions.ok && onions.tag).toMatchObject({ loose: true, unitPrice: { unitPriceMinor: 42_00, per: 'kg' } });
    expect(onions.ok && onions.tag.mrpMinor).toBeUndefined();
    // A price per gram is shown per kg.
    const saffron = buildShelfTag({ productId: 'P-SAF', name: 'Saffron', sellingPriceMinor: 3_50, baseUom: 'g' }, STD, 'en');
    expect(saffron.ok && saffron.tag.unitPrice).toMatchObject({ unitPriceMinor: 3_500_00, per: 'kg' });
  });

  it('refuses by name: above the MRP, no MRP on a packed item, no or unreadable net quantity, no price, an unknown unit', () => {
    const refusal = (p: Partial<ShelfTagProduct>) => { const r = buildShelfTag({ ...DAL, ...p }, STD, 'en'); return r.ok ? 'printed' : r.refusal; };
    expect(refusal({ sellingPriceMinor: 81_00 })).toBe('above_mrp');
    expect(refusal({ mrpMinor: undefined })).toBe('no_mrp');
    expect(refusal({ netQuantity: undefined })).toBe('no_net_quantity');
    expect(refusal({ netQuantity: 'half a kilo' })).toBe('no_net_quantity');
    expect(refusal({ sellingPriceMinor: 0 })).toBe('no_price');
    expect(refusal({ name: '  ' })).toBe('no_name');
    expect(refusal({ baseUom: 'dozen' })).toBe('unknown_unit');
    const above = buildShelfTag({ ...DAL, sellingPriceMinor: 81_00 }, STD, 'en');
    expect(!above.ok && above.detail).toMatch(/above the MRP ₹80\.00 — that is an illegal overcharge/);
  });

  it('refuses a tag stock that prints below the Rule 9 minimum for its size — nothing prints', () => {
    const big: ShelfTagTemplate = { templateId: 'poster', widthMm: 300, heightMm: 200, letterHeightMm: 5, numeralHeightMm: 5, priceHeightMm: 30 }; // 600 cm² → 4 mm
    expect(buildShelfTag(DAL, big, 'en').ok).toBe(true);
    const tiny = buildShelfTag(DAL, { ...big, letterHeightMm: 3 }, 'en');
    expect(tiny.ok).toBe(false);
    expect(!tiny.ok && tiny.refusal).toBe('too_small');
    expect(!tiny.ok && tiny.detail).toMatch(/letters 3 mm is below the 4 mm minimum/);
    expect(buildShelfTag(DAL, { ...big, widthMm: 0 }, 'en').ok).toBe(false);
    // Every stock the screen offers passes.
    for (const t of SHELF_TAG_TEMPLATES) expect(buildShelfTag(DAL, t, 'both').ok, t.templateId).toBe(true);
    expect(fontSizeMmFor(2.5)).toBe(3.6);
  });

  it('a Tamil tag without a Tamil name prints the English one — and says so, never silently', () => {
    const r = buildShelfTag({ ...DAL, nameTa: undefined }, STD, 'ta');
    expect(r.ok && r.tag.notes).toEqual([expect.stringMatching(/no Tamil name/)]);
    expect(r.ok && r.tag.nameTa).toBeUndefined();
  });
});

interface Call { readonly url: string; readonly method: string }
function headOffice(answer: (url: string) => { status: number; body: unknown } | 'throw'): { fetch: typeof globalThis.fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET' });
    const a = answer(url);
    if (a === 'throw') throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}
const PACK = {
  snapshot: {
    tenantId: 't', version: 12, builtAt: '2026-10-28T03:00:00.000Z',
    products: [
      { productId: 'P-DAL', sku: 'DAL-500', name: 'Toor dal 500 g', baseUom: 'ea', unitPriceMinor: 72_00, mrpMinor: 80_00, taxBps: 500, status: 'active' },
      { productId: 'P-OIL', sku: 'OIL-1', name: 'Groundnut oil 1 L', baseUom: 'ea', unitPriceMinor: 215_00, mrpMinor: 210_00, taxBps: 500, status: 'active' },
      { productId: 'P-OLD', sku: 'OLD', name: 'Old biscuit', baseUom: 'ea', unitPriceMinor: 10_00, mrpMinor: 10_00, taxBps: 1800, status: 'discontinued' },
      { productId: 'P-RECALL', sku: 'RC', name: 'Recalled ghee', baseUom: 'ea', unitPriceMinor: 300_00, mrpMinor: 300_00, taxBps: 1200, status: 'active', recallBlock: true },
    ],
    barcodes: [{ code: '8901000000011', productId: 'P-DAL', kind: 'standard' }, { code: '8901000000028', productId: 'P-OIL', kind: 'standard' }],
  },
};
const MASTER: Record<string, unknown> = {
  'P-DAL': { product: { productId: 'P-DAL', appContent: { nameTa: 'துவரம் பருப்பு' }, safety: { netQuantity: '500 g' } } },
  'P-OIL': { product: { productId: 'P-OIL', safety: { netQuantity: '1 L' } } },
};
const answering = (url: string): { status: number; body: unknown } => {
  if (url === '/v1/catalogue/pack') return { status: 200, body: PACK };
  const m = /^\/v1\/catalogue\/products\/([^/]+)$/.exec(url);
  if (m !== null) return MASTER[decodeURIComponent(m[1]!)] === undefined ? { status: 404, body: { error: { code: 'not_found', whatHappened: 'no product' } } } : { status: 200, body: MASTER[decodeURIComponent(m[1]!)] };
  return { status: 500, body: {} };
};
const served = buildSurface({ signingKey: 'k'.repeat(48), migrationTargetKind: 'rehearsal', store: new InMemoryEventStore() });
const isServed = (method: string, url: string): boolean => served.some((r) => r.method === method && new RegExp(`^${r.path.replace(/:[A-Za-z0-9_]+/g, '[^/]+')}$`).test(url.split('?')[0]!));
const READER = { userId: 'u-mgr', permissions: ['catalogue.pack.read'] };

describe('the Shelf tags session', () => {
  it('reads the pack and each product\'s master record, prints the lawful tags and refuses the rest by name — only head office\'s own reads', async () => {
    const ho = headOffice(answering);
    const s = createShelfTagsSession({ viewer: READER, fetch: ho.fetch });
    expect(s.may).toEqual({ named: true, read: true });
    const out = await s.prepare({ codes: '8901000000011\nOIL-1, OLD\nP-RECALL\nNOPE\n8901000000011', language: 'both', templateId: 'shelf-100x60' });
    expect(out.result).toBe('ok');
    if (out.result !== 'ok') return;
    expect(out.value.packVersion).toBe(12);
    expect(out.value.tags.map((t) => [t.productId, t.sellingPriceMinor, t.unitPrice.unitPriceMinor, t.unitPrice.per, t.nameTa, t.template.templateId])).toEqual([['P-DAL', 72_00, 144_00, 'kg', 'துவரம் பருப்பு', 'shelf-100x60']]);
    expect(out.value.refused.map((r) => [r.code, r.refusal])).toEqual([['OIL-1', 'above_mrp'], ['OLD', 'not_on_sale'], ['P-RECALL', 'not_on_sale'], ['NOPE', 'not_in_pack']]);
    // Reads only (no write is ever sent), every one a route head office serves; the duplicate code made one tag.
    expect(ho.calls.every((c) => c.method === 'GET')).toBe(true);
    expect(ho.calls.map((c) => c.url)).toEqual(['/v1/catalogue/pack', '/v1/catalogue/products/P-DAL', '/v1/catalogue/products/P-OIL']);
    for (const c of ho.calls) expect(isServed(c.method, c.url), c.url).toBe(true);
    expect(shelfTagsOutcomeWords('en', out)).toBe('1 tag(s) ready to print.');
  });

  it('refuses before any call (nobody, no permission, nothing chosen); a lost line prints nothing and says why', async () => {
    const ho = headOffice(answering);
    expect(await createShelfTagsSession({ viewer: undefined, fetch: ho.fetch }).prepare({ codes: 'x', language: 'en', templateId: '' })).toEqual({ result: 'invalid', why: 'nobody' });
    expect(await createShelfTagsSession({ viewer: { userId: 'u', permissions: [] }, fetch: ho.fetch }).prepare({ codes: 'x', language: 'en', templateId: '' })).toEqual({ result: 'invalid', why: 'cannotRead' });
    expect(await createShelfTagsSession({ viewer: READER, fetch: ho.fetch }).prepare({ codes: ' ,\n ', language: 'en', templateId: '' })).toEqual({ result: 'invalid', why: 'needCodes' });
    expect(ho.calls).toEqual([]);
    const lost = await createShelfTagsSession({ viewer: READER, fetch: headOffice(() => 'throw').fetch }).prepare({ codes: 'P-DAL', language: 'en', templateId: '' });
    expect(lost).toEqual({ result: 'lost_link' });
    expect(shelfTagsOutcomeWords('en', lost)).toMatch(/^Head office cannot be reached — no tag was made/);
    expect(shelfTagsOutcomeWords('ta', lost)).toMatch(/தலைமை அலுவலகத்தை அடைய முடியவில்லை/);
    // The master read lost half-way: no half sheet.
    const half = headOffice((url) => (url === '/v1/catalogue/pack' ? { status: 200, body: PACK } : 'throw'));
    expect((await createShelfTagsSession({ viewer: READER, fetch: half.fetch }).prepare({ codes: 'P-DAL', language: 'en', templateId: '' })).result).toBe('lost_link');
  });

  it('finds by name in the pack; reads the pack strictly; matches a barcode, then an item code, then an id', async () => {
    const s = createShelfTagsSession({ viewer: READER, fetch: headOffice(answering).fetch });
    const found = await s.find('dal');
    expect(found.result === 'ok' && found.value.map((r) => r.productId)).toEqual(['P-DAL']);
    const pack = packRowsOf(PACK)!;
    expect(rowFor(pack, '8901000000028')?.productId).toBe('P-OIL');
    expect(rowFor(pack, 'DAL-500')?.productId).toBe('P-DAL');
    expect(rowFor(pack, 'P-OLD')?.onSale).toBe(false);
    expect(packRowsOf({ nope: true })).toBeUndefined();
  });

  it('is on the menu (Products), served by the store computer, and every word — on the screen and on the tag — has a Tamil twin', () => {
    expect(ERP_NAVIGATION.find((i) => i.id === 'shelf-tags')).toMatchObject({ path: '/shelf-tags', requires: 'catalogue.pack.read', group: 'Products' });
    expect(HEAD_OFFICE_PAGE_SCREENS).toContain('shelf-tags');
    expect(HEAD_OFFICE_PAGE_GLOBALS['shelf-tags']).toBe('shelfTagsData');
    expect(Object.keys(SHELF_TAGS_COPY.ta).sort()).toEqual(Object.keys(SHELF_TAGS_COPY.en).sort());
    for (const [k, v] of Object.entries(SHELF_TAGS_COPY.ta)) expect(v, k).toMatch(/[஀-௿]/);
    expect(tagWords('ta').per.kg).toBe('ஒரு கிலோ');
  });
});

describe('printing on the label printer (OB-505) — and never a price cut off (P-08)', () => {
  const pageRule = (css: string): string | undefined => /@page\s*\{([^}]*)\}/.exec(css)?.[1]?.trim();

  it('the label printer is the default; its paper is each template\'s own label size with no margin, one tag per label, no cut line', () => {
    expect(PRINT_MODES).toEqual(['label', 'sheet']);
    expect(SHELF_TAG_TEMPLATES.map((t) => [t.templateId, t.widthMm, t.heightMm])).toEqual([['shelf-70x38', 70, 38], ['shelf-100x60', 100, 60]]);
    for (const t of SHELF_TAG_TEMPLATES) {
      const css = shelfTagPrintCss(t, 'label');
      expect(css.startsWith('@media print {')).toBe(true);
      expect(pageRule(css)).toBe(`size: ${t.widthMm}mm ${t.heightMm}mm; margin: 0;`);
      expect(css).toMatch(/#sheet \.tag \{ border: 0 !important; margin: 0 !important; break-after: page; page-break-after: always; \}/);
      expect(css).toMatch(/#sheet \.tag:last-child \{ break-after: auto; page-break-after: auto; \}/);
      // The screen around the tags is taken out of the print — no blank label is fed for it.
      expect(css).toContain('body *:not(:has(#sheet)):not(#sheet):not(#sheet *) { display: none !important; }');
    }
  });

  it('an ordinary printer keeps the sheet to cut: an 8 mm margin, the paper\'s own size, no page per tag, the cut lines left on', () => {
    const css = shelfTagPrintCss(STD, 'sheet');
    expect(pageRule(css)).toBe('margin: 8mm;');
    expect(css).not.toMatch(/size:|break-after|\.tag \{ border/);
    expect(css).toContain('display: none !important;');
  });

  it('says what to load and choose, for the printer and the tag size, in English and Tamil', () => {
    expect(printHint('en', 'label', STD)).toBe('Load 70 × 38 mm labels in the label printer. In the print window choose the label printer and 100% scale.');
    expect(printHint('ta', 'label', SHELF_TAG_TEMPLATES[1]!)).toMatch(/^லேபிள் அச்சுப்பொறியில் 100 × 60 மி\.மீ லேபிள்களை/);
    expect(printHint('en', 'sheet', STD)).toMatch(/cut along the dashed lines/);
    expect(printHint('ta', 'sheet', STD)).toMatch(/வெட்டுங்கள்/);
  });

  it('a tag whose content does not fit its label is found — taller, wider, or a part drawn outside — and named; rounding is not', () => {
    const fits: TagMeasure = { productId: 'P-DAL', name: 'Toor dal 500 g', boxWidth: 263, boxHeight: 142, contentWidth: 263, contentHeight: 142, partsOutside: [] };
    const rounding: TagMeasure = { ...fits, productId: 'P-R', name: 'Rounded', contentHeight: 143, contentWidth: 264 };
    const tall: TagMeasure = { ...fits, productId: 'P-LONG', name: 'A very long name', contentHeight: 179 };
    const wide: TagMeasure = { ...fits, productId: 'P-RICE', name: 'Ponni rice 25 kg', contentWidth: 300 };
    const outside: TagMeasure = { ...fits, productId: 'P-OIL', name: 'Oil', partsOutside: ['mrp', 'unit'] };
    expect(tagsThatOverflow([fits, rounding])).toEqual([]);
    expect(tagsThatOverflow([fits, tall, wide, outside, rounding])).toEqual([
      { productId: 'P-LONG', name: 'A very long name', partsOutside: [] },
      { productId: 'P-RICE', name: 'Ponni rice 25 kg', partsOutside: [] },
      { productId: 'P-OIL', name: 'Oil', partsOutside: ['mrp', 'unit'] },
    ]);
  });

  it('the refusal names every product and says how to fix it, in English and Tamil', () => {
    const en = overflowWords('en', ['A very long name', 'Ponni rice 25 kg']);
    expect(en).toBe('Not printed — these tags do not fit their label, so the price, MRP or price per kg would be cut off: A very long name, Ponni rice 25 kg. Shorten the product name, or choose the larger tag size, then make the tags again.');
    const ta = overflowWords('ta', ['A very long name']);
    expect(ta).toMatch(/^அச்சிடப்படவில்லை — .*: A very long name\. பொருளின் பெயரைச் சுருக்குங்கள்/);
  });

  it('the page is handed the print choices, the print rules and the fit check with its session', () => {
    const win: Record<string, unknown> = { shelfTagsData: { userId: 'u', permissions: ['catalogue.pack.read'] } };
    wireShelfTagsAndQuotations(win, (raw) => raw as { userId?: string; permissions: readonly string[] });
    expect(win['shelfTags']).toMatchObject({ printModes: PRINT_MODES, printCss: shelfTagPrintCss, tagsThatOverflow, overflowWords, printHint });
  });
});
