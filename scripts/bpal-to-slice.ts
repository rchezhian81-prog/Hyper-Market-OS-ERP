// pnpm run migration:from-bpal — the old ERP's three Excel reports → the department-slice folder (OB-693 · OB-694 · OB-695
// · OB-696). Run on the store PC; reads only the files it is given and writes only into the --out folder.
//
//   pnpm run migration:from-bpal -- --ean EANCODE.xlsx --hsn HSN.xlsx --purchases Product_wise_Detail_Report.xlsx
//        --out C:\SRE-slice --rates-from YYYY-MM-DD --tenant <uuid> --store SRE-MAIN --operator owner-01
//        [--label-facts C:\SRE-slice\label-facts.csv] [--already <earlier products.csv>[,<…>]] [--load-id <id>] [--today YYYY-MM-DD]
//
// Writes tax-classes.csv, products.csv, prices.csv and barcodes.csv (the published templates), label-facts.csv (the items
// still waiting for their five label facts, best sellers first), bpal-set-aside.csv (every item it could not take, with
// the reason) and — when the folder has none — slice.json naming the pilot department. A folder whose slice.json already
// holds seals is never written into: a sealed file is evidence (hard rule #6); the next load uses a new folder.
// The rules are in packages/migration/src/bpal-slice.ts (tested). Nothing here talks to the network.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { bpalToSlice, labelFactsFrom, readCsv, readPurchaseReport, PILOT_CATEGORY_ID, PILOT_CATEGORY_NAME } from '../packages/migration/src/bpal-slice';
import { parseFlags } from './lib/operator-env';
import { readXlsxTable } from './lib/xlsx-read.mjs';
import { shopDateIn } from '../packages/calendar/src/shop-clock';

const out = (s = ''): void => { process.stdout.write(`${s}\n`); };
const fail = (s: string): never => { out(`REFUSED — ${s}`); process.exit(2); };
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const flags = parseFlags(process.argv.slice(2).filter((a) => a !== '--'));
const str = (k: string): string | undefined => (typeof flags[k] === 'string' ? (flags[k] as string).trim() : undefined);
const need = (k: string, what: string): string => str(k) ?? fail(`--${k} is missing: ${what}`);

const eanFile = need('ean', 'the EANCODE report (Item Id, Item Name, EanCode), as .xlsx');
const hsnFile = need('hsn', 'the HSN report (Item Id, Hsn Code, Item Quantity, Gst %), as .xlsx');
const purchaseFile = need('purchases', 'the Product wise Detail Report for the last 12 months, as .xlsx');
const outDir = resolve(need('out', 'the slice folder, e.g. C:\\SRE-slice'));
const ratesFrom = need('rates-from', 'the day the GST rates were read off the old ERP (YYYY-MM-DD) — each tax class is in force from it');
if (!DAY.test(ratesFrom)) fail(`--rates-from "${ratesFrom}" is not a date like 2026-11-06`);
// The shop's day (India), never the UTC date of now (M01-FR-02).
const today = str('today') ?? shopDateIn(new Date().toISOString());
if (!DAY.test(today)) fail(`--today "${today}" is not a date like 2026-11-06`);

const read = (file: string, header: string): Record<string, string>[] => {
  const path = resolve(file);
  if (!existsSync(path)) fail(`${path} is not there`);
  try { return readXlsxTable(readFileSync(path), header); } catch (e) { return fail(`${path}: ${e instanceof Error ? e.message : String(e)}`); }
};

// A sealed folder is never written into (its files are the evidence of what was loaded).
const manifestPath = join(outDir, 'slice.json');
let manifestExists = false;
if (existsSync(manifestPath)) {
  manifestExists = true;
  let m: { files?: Record<string, unknown> } = {};
  try { m = JSON.parse(readFileSync(manifestPath, 'utf8')) as typeof m; } catch { fail(`${manifestPath} could not be read — nothing was written`); }
  if (m.files !== undefined && Object.keys(m.files).length > 0) fail(`${outDir} is already sealed (slice.json holds seals) — a sealed file is never replaced. Use a new folder for the next load, e.g. ${outDir}-2, and name this one with --already.`);
}

const labelFactsFile = str('label-facts');
const labelFacts = labelFactsFile === undefined ? undefined
  : existsSync(resolve(labelFactsFile)) ? labelFactsFrom(readCsv(readFileSync(resolve(labelFactsFile), 'utf8'))) : fail(`${resolve(labelFactsFile)} is not there`);
const already = new Set<string>();
for (const f of (str('already') ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '')) {
  const p = resolve(f);
  if (!existsSync(p)) fail(`${p} (--already) is not there`);
  for (const r of readCsv(readFileSync(p, 'utf8'))) if ((r['item_code'] ?? '') !== '') already.add(r['item_code']!);
}

const purchaseRows = read(purchaseFile, 'Item Id');
// The purchase report is read first: one whose dates or prices cannot be read is refused, naming its columns — never
// every item set aside as "no purchase", which would say the wrong thing (P-08).
const purchases = readPurchaseReport(purchaseRows);
if (purchases.problems.length > 0) {
  out(`REFUSED — ${resolve(purchaseFile)} cannot give the prices. Nothing was written:`);
  for (const p of purchases.problems) out(`  • ${p}`);
  out('Send a photo of this window: the converter is told the column\'s name, or the right report is exported.');
  process.exit(2);
}
const result = bpalToSlice({
  eanRows: read(eanFile, 'Item Id'), hsnRows: read(hsnFile, 'Item Id'), purchaseRows,
  ...(labelFacts === undefined ? {} : { labelFacts }), alreadyLoaded: already, ratesFrom, today,
});

mkdirSync(outDir, { recursive: true });
/** Written whole, then moved into place: a half-written file never sits in the folder. */
const put = (name: string, text: string): void => { const p = join(outDir, name); writeFileSync(`${p}.part`, text, 'utf8'); renameSync(`${p}.part`, p); };
for (const [name, text] of Object.entries(result.files)) put(name, text);
put('label-facts.csv', result.labelFactsSheet);
put('bpal-set-aside.csv', result.setAsideCsv);
put('hsn-to-check.csv', result.hsnToCheckCsv);
if (!manifestExists) {
  const tenantId = need('tenant', 'the tenant id from Part 5 of the workbook (for slice.json)');
  const manifest = {
    loadId: str('load-id') ?? `slice-${PILOT_CATEGORY_ID}-1`,
    tenantId, operator: need('operator', 'the login of the person who stages the load (for slice.json)'),
    storeId: need('store', 'the store code, e.g. SRE-MAIN (for slice.json)'),
    department: { categoryId: PILOT_CATEGORY_ID, name: PILOT_CATEGORY_NAME, regulated: ['food', 'packed'] },
    files: {},
  };
  put('slice.json', `${JSON.stringify(manifest, null, 2)}\n`);
}

const c = result.counts;
out(`Read the old ERP's reports into ${outDir} (the old ERP itself was not touched).`);
out(`  Purchase report: ${purchases.rows} row(s), ${purchases.datedRows} with a date, from ${purchases.oldest ?? '?'} to ${purchases.newest ?? '?'}; prices are taken from the 12 months to ${today}.`);
out(`  In the pilot department (packaged groceries, OB-694): ${c.inDepartment} item(s).`);
out(`  Ready to load (barcode, HSN and price): ${c.ready} item(s), ${c.barcodes} barcode(s), ${c.taxClasses} tax class(es).`);
out(`  Of those, label facts still to read off the pack: ${c.factsStillToRead} item(s) — they load and sell at the till only, and stay listed until filled (OB-733); label-facts.csv, best sellers first.`);
if (c.alreadyLoaded > 0) out(`  Already loaded by an earlier slice (not written again): ${c.alreadyLoaded} item(s).`);
out(`  Set aside, each with its reason: ${c.setAside} item(s) — bpal-set-aside.csv. Nothing was guessed.`);
out('  HSN codes the old ERP taxes at more than one rate, for the accountant: hsn-to-check.csv.');
out(manifestExists ? '  slice.json was already there and was kept as it is.' : '  slice.json written: the pilot department, packaged groceries.');
out(c.ready === 0
  ? 'Next: nothing is ready to load — read bpal-set-aside.csv for why each item was set aside.'
  : `Next: check the four files, then seal them (Part 22, step 2).${c.factsStillToRead > 0 ? ' Meanwhile staff keep filling label-facts.csv from the packs (allergens or "none", country of origin, net quantity, packer, consumer care), best sellers first.' : ''}`);
