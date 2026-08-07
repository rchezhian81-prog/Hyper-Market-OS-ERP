import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { CatalogueCache } from '../../packages/catalogue/src/index';
import { START_REFUSAL_KINDS, CLOSE_REFUSAL_KINDS } from '../../apps/web-erp/src/expiry-session';

/**
 * **The recall block, and the reason it was unreachable.**
 *
 * `CatalogueCache.assertSellable` refuses a recall-blocked scan **before it checks anything else**,
 * and its message says *"even offline"* — the loudest safety claim in this system. The flag it reads
 * had **no field in the store pack to arrive in**, and `posPayload` served a shape that was not a
 * `CatalogueSnapshot` at all: no `barcodes` array, no `status`, no `taxBps`. So on a real box
 * `new CatalogueCache(payload)` **threw before the till rendered anything** — a cashier saw a blank
 * screen — and once that was fixed there was still no recall flag to honour.
 *
 * The integration test that was supposed to cover this checked the payload's *contents* and never
 * that the lane could consume them. That is exactly how it survived.
 *
 * Five things must stay true:
 *
 *   1. **the box serves a snapshot the lane can actually build**, proved by building one;
 *   2. **the recall flag reaches the lane**, and either source saying blocked means blocked;
 *   3. **a product that cannot be priced safely stays off the lane** — but a RECALLED one is
 *      shipped anyway, so the refusal is by name rather than by absence;
 *   4. **an empty expiry list is distinguished from a shop that records no dates**;
 *   5. **a recall cannot be closed without evidence**, nor quietly with stock unaccounted for.
 */

const SCREEN_DATA = readFileSync('edge/store-edge/src/screen-data.ts', 'utf8');
const CATALOGUE = readFileSync('packages/catalogue/src/catalogue.ts', 'utf8');
const MODEL = readFileSync('apps/web-erp/src/expiry-session.ts', 'utf8');
const VIEW = readFileSync('apps/web-erp/web/expiry.js', 'utf8');
const HTML = readFileSync('apps/web-erp/web/expiry.html', 'utf8');
const ENTRY = readFileSync('apps/web-erp/src/browser-entry.ts', 'utf8');

/** Comments discuss these on purpose, so only real code counts. */
const code = (source: string): string => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

const expectWordsFor = (vocabulary: readonly string[], mapName: string): void => {
  const from = code(VIEW).indexOf(`const ${mapName}`);
  expect(from, `${mapName} is missing from the view`).toBeGreaterThan(-1);
  const words = code(VIEW).slice(from);
  expect(vocabulary.length, `${mapName} guards nothing`).toBeGreaterThan(1);
  for (const member of vocabulary) {
    const at = words.indexOf(`${member}: {`);
    expect(at, `"${member}" has no words in ${mapName}`).toBeGreaterThan(-1);
    const entry = words.slice(at, words.indexOf('\n  },', at));
    expect(entry, `"${member}" has no English`).toMatch(/\ben:/);
    expect(entry, `"${member}" has no Tamil`).toMatch(/\bta:/);
  }
};

/** A snapshot in exactly the shape `posPayload` emits. */
const snapshot = (over: Record<string, unknown> = {}) => ({
  tenantId: 'store-1', version: 1, builtAt: '2026-08-06T13:00:00.000Z',
  products: [{
    productId: 'p1', name: 'Toor dal 1kg', baseUom: 'ea', unitPriceMinor: 145_00,
    taxBps: 500, status: 'active', ...over,
  }],
  barcodes: [{ code: '8901', productId: 'p1', kind: 'ean13' }],
});

// ── 1 & 2. The lane can build it, and the block arrives ─────────────────────

describe('a recalled tin cannot be sold at the till', () => {
  it('builds a real lane catalogue from the shape the box emits', () => {
    // The check that was missing. `new CatalogueCache(payload)` threw on `snapshot.barcodes`
    // before the till rendered anything, and every test looked at the payload instead.
    const cache = new CatalogueCache(snapshot() as never);
    expect(cache.scan('8901').product.name).toBe('Toor dal 1kg');
  });

  it('refuses the scan when the block is set, by name', () => {
    const cache = new CatalogueCache(snapshot({ recallBlock: true }) as never);
    expect(() => cache.scan('8901')).toThrow(/under recall/);
  });

  it('checks recall FIRST, before status, so a recalled clearance item is still refused', () => {
    const sellable = code(CATALOGUE).slice(code(CATALOGUE).indexOf('private assertSellable'));
    const recall = sellable.indexOf('product.recallBlock');
    const status = sellable.indexOf('SELLABLE.includes');
    expect(recall).toBeGreaterThan(-1);
    expect(recall, 'status is judged before recall').toBeLessThan(status);
  });

  it('serves the flag from the box, from EITHER source, failing safe', () => {
    // Recall lives on the master and on the lane-facing summary, so the two can disagree. On a
    // safety flag a disagreement must fail one way only.
    const builder = code(SCREEN_DATA).slice(code(SCREEN_DATA).indexOf('export function posPayload'));
    const scope = builder.slice(0, builder.indexOf('\nexport function', 1));
    expect(scope).toMatch(/const recallBlock = p\.recallBlock === true \|\| m\?\.recallBlocked === true/);
    expect(scope).toMatch(/recallBlock \? \{ recallBlock: true \} : \{\}/);
  });

  it('serves a real CatalogueSnapshot, not a shape of its own invention', () => {
    const builder = code(SCREEN_DATA).slice(code(SCREEN_DATA).indexOf('export function posPayload'));
    const scope = builder.slice(0, builder.indexOf('\nexport function', 1));
    for (const field of ['tenantId', 'builtAt', 'barcodes', 'taxBps', 'status', 'baseUom']) {
      expect(scope, `the lane payload has no ${field}`).toMatch(new RegExp(`${field}[:,]`));
    }
  });

  it('tripwire — the detector fires on the shape it exists to catch', () => {
    // The old payload: products carrying their own barcodes, no top-level array.
    const knownBad = { version: 1, products: [{ productId: 'p1', barcodes: ['8901'] }] };
    expect(() => new CatalogueCache(knownBad as never)).toThrow();
  });
});

// ── 3. Off the lane, unless recalled ────────────────────────────────────────

describe('a product the lane cannot judge is not given to the lane', () => {
  it('excludes it and names it, rather than shipping a guessed tax rate', () => {
    const builder = code(SCREEN_DATA).slice(code(SCREEN_DATA).indexOf('export function posPayload'));
    expect(builder).toMatch(/p\.taxBps === undefined \|\| status === undefined/);
    expect(builder).toMatch(/excludedProducts/);
  });

  it('ships a RECALLED one anyway, so the refusal is by name and not by absence', () => {
    // "Unknown barcode" on a recalled tin is a cashier keying it in by hand.
    const builder = code(SCREEN_DATA).slice(code(SCREEN_DATA).indexOf('export function posPayload'));
    expect(builder).toMatch(/\) && !recallBlock\) \{/);
  });
});

// ── 4. The two empty lists that mean opposite things ────────────────────────

describe('nothing expiring, or nothing recorded', () => {
  it('serves the batches only when the box was told them', () => {
    const builder = code(SCREEN_DATA).slice(code(SCREEN_DATA).indexOf('export function expiryPayload'));
    expect(builder).toMatch(/if \(input\.pack\.batches\.known\) payload\['batches'\]/);
    expect(builder.slice(0, 200)).toMatch(/if \(!input\.pack\.expiryPolicy\.known\) return null;/);
  });

  it('says which of the two an empty list is', () => {
    expect(code(VIEW)).toMatch(/noBatches/);
    expect(code(VIEW)).toMatch(/nothingExpiring/);
    expect(code(VIEW)).toMatch(/window\.expiryData\.batches === undefined/);
    const en = code(VIEW).slice(code(VIEW).indexOf('en: {'), code(VIEW).indexOf('ta: {'));
    expect(en).toMatch(/noBatches:.*does not record batch dates/);
  });

  it('takes the near-expiry window from the shop, never a constant', () => {
    expect(code(MODEL)).toMatch(/readonly nearExpiryDays: number/);
    expect(code(SCREEN_DATA)).toMatch(/nearExpiryDays: policy\.nearExpiryDays/);
    expect(code(MODEL)).not.toMatch(/nearExpiryDays = \d/);
  });

  it('never lists stock that is held for another reason as a markdown', () => {
    const fefo = readFileSync('packages/fefo/src/fefo.ts', 'utf8');
    expect(code(fefo)).toMatch(/state !== 'on_hand' \|\| batch\.recallBlocked \|\| batch\.qty <= 0/);
  });
});

// ── 5. A recall is not finished when it is started ──────────────────────────

describe('closing a recall costs something', () => {
  it('leads with what is STILL OUT THERE, not with what is on the shelf', () => {
    // The shelf figure is the easy one, and it is the one that makes a recall look finished.
    expect(code(MODEL)).toMatch(/stillOutThere: Math\.max\(0, trace\.issuedQty/);
    expect(code(VIEW)).toMatch(/view\.stillOutThere/);
  });

  it('counts the buyers it CANNOT contact, rather than reporting only the ones it can', () => {
    // Four of nineteen is the number that decides whether a public notice goes up.
    expect(code(MODEL)).toMatch(/anonymousSales/);
    expect(code(MODEL)).toMatch(/identifiedCustomers/);
    expect(code(VIEW)).toMatch(/cannotContact/);
  });

  it('refuses to close with no evidence', () => {
    const close = code(MODEL).slice(code(MODEL).indexOf('close: (input)'));
    expect(close).toMatch(/input\.evidence\.trim\(\) === ''/);
    expect(close).toMatch(/needs_evidence/);
  });

  it('refuses to close quietly while stock is unaccounted for', () => {
    const close = code(MODEL).slice(code(MODEL).indexOf('close: (input)'));
    expect(close).toMatch(/stillOut > 0 && \(input\.acceptUnrecovered \?\? ''\)\.trim\(\) === ''/);
    expect(close).toMatch(/stock_not_accounted_for/);
    // …and when it IS closed anyway, the reason goes into the record, which is all that survives.
    expect(close).toMatch(/unaccounted for: \$\{input\.acceptUnrecovered!\.trim\(\)\}/);
  });

  it('never edits a closed recall — a correction is a new record', () => {
    const close = code(MODEL).slice(code(MODEL).indexOf('close: (input)'));
    expect(close).toMatch(/already_closed/);
    expect(close).toMatch(/never an edit/);
  });

  it('starts and closes nothing under a name nobody holds', () => {
    expect(code(MODEL)).toMatch(/readonly userId: string \| null/);
    for (const fn of ['start: (input)', 'close: (input)']) {
      const body = code(MODEL).slice(code(MODEL).indexOf(fn));
      expect(body.indexOf('config.userId === null'), `${fn} does not check who is asking`)
        .toBeGreaterThan(-1);
    }
    expect(code(ENTRY)).toMatch(/userId: data\.userId === undefined \? null : data\.userId/);
    expect(HTML).toMatch(/id="nobody"/);
  });

  it('refuses to start the same recall twice, which would split the evidence', () => {
    expect(code(MODEL)).toMatch(/already_recalled/);
    expect(code(MODEL)).toMatch(/split the evidence/);
  });

  it('has words for every refusal it can give, in both languages', () => {
    expectWordsFor(START_REFUSAL_KINDS, 'START_REFUSAL_WORDS');
    expectWordsFor(CLOSE_REFUSAL_KINDS, 'CLOSE_REFUSAL_WORDS');
  });
});

// ── The screen itself ───────────────────────────────────────────────────────

describe('the expiry and recall screen', () => {
  it('is routed, named and served by the box', () => {
    const server = readFileSync('edge/store-edge/src/screen-server.ts', 'utf8');
    expect(server).toMatch(/expiry: \{ dir: 'web-erp', file: 'expiry\.html' \}/);
    expect(code(SCREEN_DATA)).toMatch(/expiry: 'expiryData'/);
    expect(code(SCREEN_DATA)).toMatch(/expiry: expiryPayload/);
  });

  it('opens with no network and says where the page came from', () => {
    expect(HTML).toMatch(/<!--SCREEN-DATA-->/);
    expect(code(VIEW)).toMatch(/navigator\.serviceWorker\.register\('\.\/sw\.js'\)/);
    expect(code(VIEW)).toMatch(/window\.shellCachedAt/);
    expect(HTML).toMatch(/id="stale"/);
  });

  it('never interrupts anybody with a browser dialog', () => {
    // Least of all on this screen: a dialog cannot be read in Tamil and cannot be tested.
    expect(code(VIEW)).not.toMatch(/\b(prompt|confirm|alert)\s*\(/);
    expect(code(VIEW)).toMatch(/function tell\(/);
  });

  it('says expired and near-expiry in words, not by colour alone', () => {
    expect(code(VIEW)).toMatch(/t\('dispose'\)/);
    expect(code(VIEW)).toMatch(/t\('markdown'\)/);
    expect(HTML).toMatch(/\.row\.expired/);
    expect(HTML).toMatch(/\.row\.near_expiry/);
  });

  it('shows a product’s NAME, because this is a screen about food', () => {
    expect(code(MODEL)).toMatch(/ports\.productNames\(\)\?\.\[productId\] \?\? productId/);
    expect(code(ENTRY)).not.toMatch(/productNames: \(\) => data\?\.productNames \?\? \{\}/);
  });

  it('is offered in Tamil everywhere it is offered in English', () => {
    const en = code(VIEW).slice(code(VIEW).indexOf('en: {'), code(VIEW).indexOf('ta: {'));
    const ta = code(VIEW).slice(code(VIEW).indexOf('ta: {'), code(VIEW).indexOf('};'));
    const keys = (block: string): string[] => [...block.matchAll(/(\w+):\s*['"]/g)].map((m) => m[1]!);
    expect(keys(en).length).toBeGreaterThan(25);
    expect(keys(ta).length).toBe(keys(en).length);
    for (const key of keys(en)) expect(ta, `"${key}" has no Tamil`).toMatch(new RegExp(`\\b${key}:`));
  });
});
