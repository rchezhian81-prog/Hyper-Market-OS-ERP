// Batch 18b · B1 — "Download to Excel" on every list (M30-FR-02 "exports for every domain" · P-06 · NFR-12).
//
// Every office list is the chrome's one register (`sreOffice.table` in `apps/web-erp/web/sre-chrome.js`). Its download
// button writes EXACTLY what the person sees — the rows their search and filters leave, every page of them, the columns
// they chose, in the order on the screen — as a CSV file that Excel opens directly (OB-867: CSV with a UTF-8 byte-order
// mark, so Tamil survives; no new library). It is built in this browser from the rows already on the screen, so it works
// with the internet off on the store computer.
//
// Three rules carried over unchanged from the governed export engine (`packages/export`), never weakened:
//   • PERSONAL DATA — a column holding personal data (a customer's name or number, a phone, an email, an address, a
//     customer's own words…) is REDACTED unless the person holds `export.sensitive` — the SAME permission and the SAME
//     marker (`[redacted]`) the engine uses. Redacted, not dropped: the file's shape never lies about what exists. A
//     person whose permissions this page was not told gets the redacted file (fails closed).
//   • THE RECORD — every download is recorded in head office's export audit ledger (`POST /v1/exports/screen-lists`, the
//     same append-only `DataExported` ledger every other export writes): who, which list, when, how many rows, which
//     columns were redacted. With head office out of reach the record is kept on this computer and sent when it answers;
//     the page says so (P-08). It is never dropped.
//   • NO FORMULA — a cell that would start a spreadsheet formula (= + - @) is written with a leading apostrophe, so a value
//     typed by anyone can never run as a formula when the file is opened (OB-868).
//
// DOM-free and tested (tests/unit/batch18b-list-download.test.ts).

import { EXPORT_SENSITIVE, REDACTED } from '../../../packages/export/src/export';

export { EXPORT_SENSITIVE, REDACTED };

/** One column of the file: the heading the person reads, and whether it holds personal data. */
export interface ListFileColumn {
  readonly key: string;
  readonly label: string;
  readonly personal: boolean;
}

export interface ListFile {
  /** The file's text, starting with the UTF-8 byte-order mark (U+FEFF) so Excel reads Tamil correctly. */
  readonly text: string;
  readonly rowCount: number;
  /** The headings of the columns whose values were redacted for this person. */
  readonly redactedColumns: readonly string[];
}

/** The byte-order mark Excel needs to read a CSV file as UTF-8. */
export const BOM = '﻿';

/**
 * Column keys that always hold personal data, whatever the page says — the engine's sensitive columns (customer and member
 * codes, a mobile, a phone, an email, an address, consent evidence) as a page names them. A page marks any other column
 * `personal: true` itself.
 */
const PERSONAL_KEYS = /^(customerRef|memberRef|mobile|mobileLast4|phone|email|address|consentEvidence)$/i;

export function isPersonalKey(key: string): boolean {
  return PERSONAL_KEYS.test(key);
}

/** OB-868: a cell that a spreadsheet would read as a formula starts with an apostrophe. A plain negative number is left as it is. */
export function neutralise(value: string): string {
  if (/^[=+@\t\r]/.test(value)) return `'${value}`;
  if (value.startsWith('-') && !/^-[\d₹.,\s]/.test(value)) return `'${value}`;
  return value;
}

/** One CSV cell (RFC 4180): quoted when it holds a comma, a quote or a line break; quotes doubled. */
export function csvCell(raw: string): string {
  const value = neutralise(raw);
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * The file: the headings, then one line per row, each cell as the screen shows it. A personal column is `[redacted]` on
 * every row unless the person may see personal data. `rows[i][j]` is row i's text in column j.
 */
export function listFile(columns: readonly ListFileColumn[], rows: readonly (readonly string[])[], maySeePersonal: boolean): ListFile {
  const redact = columns.map((c) => c.personal && !maySeePersonal);
  const header = columns.map((c) => csvCell(c.label)).join(',');
  const body = rows.map((row) => columns.map((_, j) => csvCell(redact[j] ? REDACTED : (row[j] ?? ''))).join(','));
  return {
    text: `${BOM}${[header, ...body].join('\r\n')}\r\n`,
    rowCount: rows.length,
    redactedColumns: columns.filter((_, j) => redact[j]).map((c) => c.label),
  };
}

/** Whether the person may see personal data in a downloaded file — the engine's own permission, nothing else. */
export function maySeePersonal(permissions: readonly string[] | null | undefined): boolean {
  return Array.isArray(permissions) && permissions.includes(EXPORT_SENSITIVE);
}

/** The file's name: the list's name in plain letters, then the shop's day — `Goods-receipts-2026-11-19.csv`. */
export function listFileName(label: string, day: string): string {
  const plain = label.normalize('NFKD').replace(/[^\x20-\x7E]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  const when = /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : '';
  return `${plain === '' ? 'list' : plain}${when === '' ? '' : `-${when}`}.csv`;
}

// ── The record of each download (head office's export audit ledger) ─────────────────────────────────────────────

/** What head office is told about one download — never the rows themselves. */
export interface ListDownloadRecord {
  readonly key: string;
  readonly screen: string;
  readonly list: string;
  readonly label: string;
  readonly rowCount: number;
  readonly columns: readonly string[];
  readonly redactedColumns: readonly string[];
  readonly downloadedAt: string;
}

export const LIST_DOWNLOADS_PATH = '/v1/exports/screen-lists';
const PENDING_KEY = 'sre.list-downloads.pending';

export interface PendingStorage { getItem(k: string): string | null; setItem(k: string, v: string): void }

export function pendingRecords(storage: PendingStorage | undefined): ListDownloadRecord[] {
  if (storage === undefined) return [];
  try {
    const v = JSON.parse(storage.getItem(PENDING_KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? (v.filter((r) => r !== null && typeof r === 'object' && typeof (r as ListDownloadRecord).key === 'string') as ListDownloadRecord[]) : [];
  } catch { return []; }
}

function keepPending(storage: PendingStorage | undefined, records: readonly ListDownloadRecord[]): boolean {
  if (storage === undefined) return false;
  try { storage.setItem(PENDING_KEY, JSON.stringify(records)); return true; } catch { return false; }
}

export type SendOutcome = 'recorded' | 'refused' | 'lost_link';

/** Send one record to head office (the person's own session; a lost link is not a refusal). */
export async function sendRecord(record: ListDownloadRecord, fetchFn: typeof fetch | undefined): Promise<SendOutcome> {
  if (fetchFn === undefined) return 'lost_link';
  try {
    const res = await fetchFn(LIST_DOWNLOADS_PATH, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'idempotency-key': record.key, accept: 'application/json' },
      body: JSON.stringify({ screen: record.screen, list: record.list, label: record.label, rowCount: record.rowCount, columns: record.columns, redactedColumns: record.redactedColumns, downloadedAt: record.downloadedAt }),
    });
    if (res.status >= 200 && res.status < 300) return 'recorded';
    // A store computer that does not carry head office's API answers 404/502/503: that is no answer, not a refusal.
    return res.status === 404 || res.status >= 500 ? 'lost_link' : 'refused';
  } catch { return 'lost_link'; }
}

export interface RecordOutcome {
  /** This download: recorded at head office, or kept here to send later, or refused by head office (kept, said). */
  readonly outcome: SendOutcome;
  /** Records still kept on this computer, waiting for head office. */
  readonly waiting: number;
  /** False when this computer could not keep a record it had to keep (its storage refused) — said on the page. */
  readonly kept: boolean;
}

/**
 * Record one download: first send any records kept from earlier, then this one. A record head office has not taken (no
 * answer, or a refusal) stays on this computer and is sent again next time — never dropped.
 */
export async function recordDownload(record: ListDownloadRecord, storage: PendingStorage | undefined, fetchFn: typeof fetch | undefined): Promise<RecordOutcome> {
  const waiting = [...pendingRecords(storage).filter((r) => r.key !== record.key), record];
  const still: ListDownloadRecord[] = [];
  let mine: SendOutcome = 'lost_link';
  for (const r of waiting) {
    const out = await sendRecord(r, fetchFn);
    if (r.key === record.key) mine = out;
    if (out !== 'recorded') still.push(r);
  }
  if (still.length === 0) { keepPending(storage, []); return { outcome: mine, waiting: 0, kept: true }; }
  return { outcome: mine, waiting: still.length, kept: keepPending(storage, still) };
}

/** Send what is kept on this computer (on page load), and say how many still wait. */
export async function flushPending(storage: PendingStorage | undefined, fetchFn: typeof fetch | undefined): Promise<number> {
  const waiting = pendingRecords(storage);
  if (waiting.length === 0) return 0;
  const still: ListDownloadRecord[] = [];
  for (const r of waiting) if (await sendRecord(r, fetchFn) !== 'recorded') still.push(r);
  keepPending(storage, still);
  return still.length;
}
