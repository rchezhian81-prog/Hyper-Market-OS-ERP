// MG-09 "Delta: freeze or capture changes after the final extract; load controlled deltas exactly once" — capture by
// COMPARING TWO FULL EXPORTS (owner decision OB-309, 23 Oct 2026: "compare two full exports — works with any old ERP").
//
// Between the final extract and the night, the old ERP keeps changing: an item added, a price raised, a barcode moved, a
// supplier's GSTIN corrected, a customer's phone changed. Any old ERP can export its masters as a spreadsheet, so the
// capture is two full exports of the same domain — the earlier one (the BASELINE, as loaded) and the latest — read
// through a one-time column mapping (our field ← their column name, exactly as the evening check reads its reports), and
// compared record by record on the domain's key:
//
//   • ADDED — a key in the latest export the baseline does not have;
//   • CHANGED — a key in both whose compared fields differ (each field named, before and after);
//   • REMOVED — a key the baseline has that the latest export no longer does.
//
// Every difference is a REVIEWABLE EXCEPTION for the migration register — `blocking`, so the cutover cannot pass while
// any is undecided — and nothing is applied by this step. A person decides each one (load it / keep the old value),
// and the register never deletes it (hard rule #6). Customer names and phone numbers are personal data (P-04): the
// exception says WHICH field changed and carries a fingerprint of each value, never the value itself.
//
// A file is refused WHOLE when a mapped column is missing, a row cannot be read, or a key appears twice — a row nobody
// can read is a difference nobody could see (P-08). Rupees become paise by reading the digits, never a float.
//
// Pure: no clock, no I/O, no Node built-ins (the fingerprint is a small FNV-1a hash, enough to tell values apart).

import { readCsv, headerKey, rupeesToPaise, cleanItemCode, isScientificNotation, isTotalLine, type CsvTable } from './old-erp-reports';
import type { MigrationException } from './cleaning';

export type ExportDomain = 'items' | 'prices' | 'barcodes' | 'suppliers' | 'customers';
export const EXPORT_DOMAINS: readonly ExportDomain[] = Object.freeze(['items', 'prices', 'barcodes', 'suppliers', 'customers']);

type FieldKind = 'text' | 'code' | 'rupees' | 'number';

interface FieldSpec {
  readonly key: string;
  readonly kind: FieldKind;
  readonly required: boolean;
  /** Personal data: compared by fingerprint, never kept or shown as a value. */
  readonly personal?: boolean;
  readonly words: { readonly en: string; readonly ta: string };
}

interface DomainSpec {
  readonly domain: ExportDomain;
  /** The field that identifies a record in both exports. */
  readonly keyField: string;
  readonly fields: readonly FieldSpec[];
  readonly words: { readonly en: string; readonly ta: string };
}

/** Our fields per domain. The old ERP's column names are mapped onto these once; nothing guesses a column. */
export const EXPORT_DOMAIN_SPECS: Readonly<Record<ExportDomain, DomainSpec>> = Object.freeze({
  items: {
    domain: 'items', keyField: 'item_code', words: { en: 'Items', ta: 'பொருட்கள்' },
    fields: [
      { key: 'item_code', kind: 'code', required: true, words: { en: 'Item code', ta: 'பொருள் குறியீடு' } },
      { key: 'name', kind: 'text', required: true, words: { en: 'Item name', ta: 'பொருள் பெயர்' } },
      { key: 'uom', kind: 'text', required: false, words: { en: 'Unit', ta: 'அலகு' } },
      { key: 'hsn', kind: 'code', required: false, words: { en: 'HSN code', ta: 'HSN குறியீடு' } },
      { key: 'tax_rate', kind: 'number', required: false, words: { en: 'GST rate (%)', ta: 'ஜிஎஸ்டி விகிதம் (%)' } },
      { key: 'category', kind: 'text', required: false, words: { en: 'Category', ta: 'வகை' } },
    ],
  },
  prices: {
    domain: 'prices', keyField: 'item_code', words: { en: 'Prices', ta: 'விலைகள்' },
    fields: [
      { key: 'item_code', kind: 'code', required: true, words: { en: 'Item code', ta: 'பொருள் குறியீடு' } },
      { key: 'mrp', kind: 'rupees', required: false, words: { en: 'MRP (₹)', ta: 'அதிகபட்ச சில்லறை விலை (₹)' } },
      { key: 'selling_price', kind: 'rupees', required: true, words: { en: 'Selling price (₹)', ta: 'விற்பனை விலை (₹)' } },
    ],
  },
  barcodes: {
    domain: 'barcodes', keyField: 'barcode', words: { en: 'Barcodes', ta: 'பார்கோடுகள்' },
    fields: [
      { key: 'barcode', kind: 'code', required: true, words: { en: 'Barcode', ta: 'பார்கோடு' } },
      { key: 'item_code', kind: 'code', required: true, words: { en: 'Item code it belongs to', ta: 'அது சேர்ந்த பொருள் குறியீடு' } },
    ],
  },
  suppliers: {
    domain: 'suppliers', keyField: 'supplier_code', words: { en: 'Suppliers', ta: 'சப்ளையர்கள்' },
    fields: [
      { key: 'supplier_code', kind: 'code', required: true, words: { en: 'Supplier code', ta: 'சப்ளையர் குறியீடு' } },
      { key: 'name', kind: 'text', required: true, words: { en: 'Supplier name', ta: 'சப்ளையர் பெயர்' } },
      { key: 'gstin', kind: 'code', required: false, words: { en: 'GSTIN', ta: 'ஜிஎஸ்டிஐஎன்' } },
      { key: 'state', kind: 'text', required: false, words: { en: 'State', ta: 'மாநிலம்' } },
    ],
  },
  customers: {
    domain: 'customers', keyField: 'customer_code', words: { en: 'Customers', ta: 'வாடிக்கையாளர்கள்' },
    fields: [
      { key: 'customer_code', kind: 'code', required: true, words: { en: 'Customer code', ta: 'வாடிக்கையாளர் குறியீடு' } },
      { key: 'name', kind: 'text', required: false, personal: true, words: { en: 'Customer name', ta: 'வாடிக்கையாளர் பெயர்' } },
      { key: 'phone', kind: 'code', required: false, personal: true, words: { en: 'Phone', ta: 'தொலைபேசி' } },
      { key: 'gstin', kind: 'code', required: false, words: { en: 'GSTIN (credit customers)', ta: 'ஜிஎஸ்டிஐஎன் (கடன் வாடிக்கையாளர்கள்)' } },
      { key: 'credit_limit', kind: 'rupees', required: false, words: { en: 'Credit limit (₹)', ta: 'கடன் வரம்பு (₹)' } },
    ],
  },
}) as Readonly<Record<ExportDomain, DomainSpec>>;

/** Our field → the old ERP's own column name (from its header row). */
export type ExportMapping = Readonly<Record<string, string>>;

/** One value as compared: text as written (trimmed), paise for rupees, a fingerprint for personal data. */
type Value = string;

/** A small, deterministic fingerprint (FNV-1a, 32-bit, hex) — enough to say "changed", never to recover the value. */
export function fingerprint(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `fp:${h.toString(16).padStart(8, '0')}`;
}

export interface ReadExport {
  readonly ok: true;
  readonly rows: ReadonlyMap<string, Readonly<Record<string, Value>>>;
  readonly totalLinesSkipped: number;
}
export type ExportRead = ReadExport | { readonly ok: false; readonly problems: readonly string[] };

const PROBLEMS_LISTED = 12;

/** Judge a mapping against a domain (and, given, the file's header): every required field mapped, every column present. */
export function judgeExportMapping(domain: ExportDomain, mapping: unknown, header?: readonly string[]): { readonly ok: true; readonly mapping: ExportMapping } | { readonly ok: false; readonly problems: readonly string[] } {
  const spec = EXPORT_DOMAIN_SPECS[domain];
  if (mapping === null || typeof mapping !== 'object' || Array.isArray(mapping)) return { ok: false, problems: ['the column mapping is { "<our field>": "<the old ERP\'s column name>" }'] };
  const m = mapping as Record<string, unknown>;
  const problems: string[] = [];
  for (const f of spec.fields) {
    const col = m[f.key];
    if (col === undefined) { if (f.required) problems.push(`"${f.key}" (${f.words.en}) is required and is not mapped to a column`); continue; }
    if (typeof col !== 'string' || col.trim() === '') { problems.push(`"${f.key}" is mapped to an empty column name`); continue; }
    if (header !== undefined && !header.map(headerKey).includes(headerKey(col))) problems.push(`the column "${col}" for "${f.key}" is not in the file's header row`);
  }
  for (const k of Object.keys(m)) if (!spec.fields.some((f) => f.key === k)) problems.push(`"${k}" is not a field of ${spec.words.en.toLowerCase()}`);
  return problems.length > 0 ? { ok: false, problems } : { ok: true, mapping: m as ExportMapping };
}

/** Read one full export of a domain through its mapping. Refused whole on any unreadable row or repeated key. */
export function readExport(domain: ExportDomain, text: string, mappingRaw: unknown): ExportRead {
  const spec = EXPORT_DOMAIN_SPECS[domain];
  const csv = readCsv(text);
  if (!csv.ok) return { ok: false, problems: [csv.problem] };
  const table: CsvTable = csv.table;
  // The header row: the first row that names every mapped column (report title lines may come first).
  const judged0 = judgeExportMapping(domain, mappingRaw);
  if (!judged0.ok) return { ok: false, problems: judged0.problems };
  const mapping = judged0.mapping;
  const wanted = Object.values(mapping).map(headerKey);
  const headerIndex = table.records.findIndex((r) => wanted.every((w) => r.cells.map(headerKey).includes(w)));
  if (headerIndex < 0) return { ok: false, problems: [`no row of the file holds every mapped column (${Object.values(mapping).join(', ')})`] };
  const header = table.records[headerIndex]!.cells.map(headerKey);
  const col = (field: string): number => (mapping[field] === undefined ? -1 : header.indexOf(headerKey(mapping[field]!)));
  const problems: string[] = [];
  const rows = new Map<string, Record<string, Value>>();
  let totals = 0;
  for (const rec of table.records.slice(headerIndex + 1)) {
    const cell = (field: string): string => { const i = col(field); return i < 0 ? '' : (rec.cells[i] ?? '').trim(); };
    const keyRaw = cleanItemCode(cell(spec.keyField));
    if (keyRaw === '' && rec.cells.every((c) => c.trim() === '')) continue;
    if (isTotalLine(keyRaw)) { totals += 1; continue; }
    if (keyRaw === '') { problems.push(`line ${rec.line}: the ${EXPORT_DOMAIN_SPECS[domain].fields.find((f) => f.key === spec.keyField)!.words.en.toLowerCase()} is empty`); continue; }
    if (isScientificNotation(keyRaw)) { problems.push(`line ${rec.line}: "${keyRaw}" lost its digits in Excel (scientific notation) — format the column as text and save again`); continue; }
    if (rows.has(keyRaw)) { problems.push(`line ${rec.line}: ${keyRaw} appears twice — one record per ${spec.keyField}`); continue; }
    const row: Record<string, Value> = {};
    let bad = false;
    for (const f of spec.fields) {
      if (mapping[f.key] === undefined) continue;
      const raw = f.kind === 'code' ? cleanItemCode(cell(f.key)) : cell(f.key);
      if (raw === '') { if (f.required) { problems.push(`line ${rec.line}: ${f.words.en} is empty`); bad = true; } else row[f.key] = ''; continue; }
      if (f.kind === 'rupees') {
        const p = rupeesToPaise(raw);
        if (p === undefined) { problems.push(`line ${rec.line}: "${raw}" is not a rupee figure (${f.words.en})`); bad = true; continue; }
        row[f.key] = String(p);
      } else if (f.kind === 'number') {
        if (!/^-?\d+(\.\d+)?$/.test(raw.replace(/%$/, ''))) { problems.push(`line ${rec.line}: "${raw}" is not a number (${f.words.en})`); bad = true; continue; }
        row[f.key] = raw.replace(/%$/, '');
      } else row[f.key] = f.personal === true ? fingerprint(raw.replace(/\s+/g, ' ').toLowerCase()) : raw.replace(/\s+/g, ' ');
    }
    if (!bad) rows.set(keyRaw, row);
  }
  if (problems.length > 0) {
    const listed = problems.slice(0, PROBLEMS_LISTED);
    return { ok: false, problems: problems.length > PROBLEMS_LISTED ? [...listed, `… and ${problems.length - PROBLEMS_LISTED} more`] : listed };
  }
  return { ok: true, rows, totalLinesSkipped: totals };
}

export interface FieldChange {
  readonly field: string;
  /** The value before and after — for personal data, only whether it was there; the fingerprints say it changed. */
  readonly before: string;
  readonly after: string;
  readonly personal: boolean;
}

export interface ExportDiff {
  readonly domain: ExportDomain;
  readonly baselineRecords: number;
  readonly latestRecords: number;
  readonly added: readonly { readonly key: string; readonly fields: Readonly<Record<string, string>> }[];
  readonly changed: readonly { readonly key: string; readonly changes: readonly FieldChange[] }[];
  readonly removed: readonly { readonly key: string }[];
  readonly unchanged: number;
}

/** Compare two read exports of the same domain on the domain's key. Pure; ordered by key. */
export function diffExports(domain: ExportDomain, baseline: ReadExport, latest: ReadExport): ExportDiff {
  const spec = EXPORT_DOMAIN_SPECS[domain];
  const personal = new Set(spec.fields.filter((f) => f.personal === true).map((f) => f.key));
  const shown = (field: string, v: string | undefined): string => (v === undefined ? '(not in this export)' : personal.has(field) ? (v === '' ? '(empty)' : '(personal — not shown)') : v);
  const added: { key: string; fields: Record<string, string> }[] = [];
  const changed: { key: string; changes: FieldChange[] }[] = [];
  const removed: { key: string }[] = [];
  let unchanged = 0;
  for (const key of [...latest.rows.keys()].sort()) {
    const after = latest.rows.get(key)!;
    const before = baseline.rows.get(key);
    if (before === undefined) {
      added.push({ key, fields: Object.fromEntries(Object.entries(after).map(([f, v]) => [f, shown(f, v)])) });
      continue;
    }
    const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((f) => f !== spec.keyField).sort();
    const changes = fields.filter((f) => (before[f] ?? '') !== (after[f] ?? ''))
      .map((f) => ({ field: f, before: shown(f, before[f]), after: shown(f, after[f]), personal: personal.has(f) }));
    if (changes.length === 0) unchanged += 1; else changed.push({ key, changes });
  }
  for (const key of [...baseline.rows.keys()].sort()) if (!latest.rows.has(key)) removed.push({ key });
  return { domain, baselineRecords: baseline.rows.size, latestRecords: latest.rows.size, added, changed, removed, unchanged };
}

/** Each difference as a blocking exception for the migration register, keyed so the same comparison records it once. */
export function diffExceptions(diffId: string, tenantId: string, diff: ExportDiff): readonly MigrationException[] {
  const spec = EXPORT_DOMAIN_SPECS[diff.domain];
  const id = (what: string, key: string): string => `delta-${diffId}-${diff.domain}-${what}-${fingerprint(key).slice(3)}`;
  const label = spec.words.en.toLowerCase().replace(/s$/, '');
  const fieldWords = (f: string): string => spec.fields.find((x) => x.key === f)?.words.en ?? f;
  return [
    ...diff.added.map((a): MigrationException => ({
      exceptionId: id('added', a.key), tenantId, kind: 'delta_added', severity: 'blocking', confidence: 'certain', legacyIds: [a.key],
      evidence: `MG-09 delta (${diffId}): ${label} ${a.key} is in the latest export but not in the one loaded — ${Object.entries(a.fields).filter(([f]) => f !== spec.keyField).map(([f, v]) => `${fieldWords(f)}: ${v}`).join('; ')}. Decide: load it, or leave it out.`,
    })),
    ...diff.changed.map((c): MigrationException => ({
      exceptionId: id('changed', c.key), tenantId, kind: 'delta_changed', severity: 'blocking', confidence: 'certain', legacyIds: [c.key],
      evidence: `MG-09 delta (${diffId}): ${label} ${c.key} changed after the export that was loaded — ${c.changes.map((x) => x.personal ? `${fieldWords(x.field)} changed (personal — not shown)` : `${fieldWords(x.field)}: ${x.before} → ${x.after}`).join('; ')}. Decide: load the new value, or keep the old one.`,
      ...(diff.domain === 'prices' ? valueAtStake(c.changes) : {}),
    })),
    ...diff.removed.map((r): MigrationException => ({
      exceptionId: id('removed', r.key), tenantId, kind: 'delta_removed', severity: 'blocking', confidence: 'certain', legacyIds: [r.key],
      evidence: `MG-09 delta (${diffId}): ${label} ${r.key} was in the export that was loaded and is not in the latest one. Decide: stop it in the new system, or keep it (it may have been left out of the export by mistake).`,
    })),
  ];
}

/** For a price change, the money the change is about: the larger price move, in paise. */
function valueAtStake(changes: readonly FieldChange[]): { valueMinor?: number } {
  let most = 0;
  for (const c of changes) {
    const b = Number(c.before);
    const a = Number(c.after);
    if (Number.isSafeInteger(b) && Number.isSafeInteger(a)) most = Math.max(most, Math.abs(a - b));
  }
  return most > 0 ? { valueMinor: most } : {};
}
