// GT-05 — the CSV files of the phases that follow the master-data and opening load, read the way load-csv.ts reads the
// main files: case/space-insensitive columns, money in rupees and paise, every unreadable row named with its file and line,
// never a guessed value.
//
//   history.csv                  kind, legacy_id, number, date, party, net, tax, gross, attachments (pipe-separated ids)
//   history-lines.csv            kind, legacy_id, item_code, qty, net, tax                         (optional: lines per document)
//   history-control-totals.csv   kind, count, gross, tax          — from the OLD system's own report, never from the extract
//   attachments.csv              legacy_id, file_name, content_type, sha256 — the bytes are the files in attachments/
//   open-orders.csv              po_id, number, supplier, deliver_to, item_code, ordered, received, unit_cost (a row per line)
//   trial-balance.csv            account_code, account_name, debit, credit (one balance per ledger account, mapped — MG-03)
//   trial-balance-totals.csv     total_debit, total_credit, account_count — printed on the old system's trial balance
//
// Type-only imports from the history phase: this file stays free of node:crypto, so the barrel can carry it to the browser.

import { cell, list, moneyToMinor, type CsvRows } from './load-csv';
import type { ExtractHistory, ExtractHistoryDocument, ExtractAttachment, HistoryControlTotal, HistoryKind, HistoryLine } from './history-load';
import type { ExtractOpenOrder } from './open-orders';
import type { ExtractTrialBalance } from './account-openings';

const at = (file: string, rows: CsvRows, i: number): string => `${file} line ${rows.lineNumbers?.[i] ?? i + 2}`;
const whole = (text: string | undefined): number | undefined => (text !== undefined && /^\d+$/.test(text.replace(/[,\s]/g, '')) ? Number(text.replace(/[,\s]/g, '')) : undefined);
const signedWhole = (text: string | undefined): number | undefined => (text !== undefined && /^-?\d+$/.test(text.replace(/[,\s]/g, '')) ? Number(text.replace(/[,\s]/g, '')) : undefined);

export interface HistoryFiles {
  readonly documents: CsvRows;
  readonly lines?: CsvRows;
  readonly controlTotals?: CsvRows;
  readonly attachments?: CsvRows;
  /** The attachment files' bytes, base64, by file name (from the extract's attachments/ folder). */
  readonly attachmentBytes?: Readonly<Record<string, string>>;
}

export function historyFromFiles(files: HistoryFiles): { readonly history: ExtractHistory; readonly problems: readonly string[] } {
  const problems: string[] = [];
  const lineRows = new Map<string, HistoryLine[]>();
  files.lines?.rows.forEach((row, i) => {
    const where = at('history-lines.csv', files.lines!, i);
    const kind = cell(row, 'kind', 'document_kind', 'type');
    const legacyId = cell(row, 'legacy_id', 'document_id', 'id');
    const quantityMinor = signedWhole(cell(row, 'qty', 'quantity'));
    const netMinor = moneyToMinor(cell(row, 'net', 'net_amount', 'taxable_value'));
    const taxMinor = moneyToMinor(cell(row, 'tax', 'tax_amount', 'gst'));
    if (kind === undefined || legacyId === undefined || quantityMinor === undefined || netMinor === undefined || taxMinor === undefined) {
      problems.push(`${where}: needs the document kind and id, a whole quantity, and net and tax in rupees`);
      return;
    }
    const productId = cell(row, 'item_code', 'product_id', 'item');
    const description = cell(row, 'description');
    const k = `${kind}|${legacyId}`;
    lineRows.set(k, [...(lineRows.get(k) ?? []), { quantityMinor, netMinor, taxMinor, ...(productId === undefined ? {} : { productId }), ...(description === undefined ? {} : { description }) }]);
  });
  const documents: ExtractHistoryDocument[] = [];
  files.documents.rows.forEach((row, i) => {
    const where = at('history.csv', files.documents, i);
    const kind = cell(row, 'kind', 'document_kind', 'type');
    const legacyId = cell(row, 'legacy_id', 'document_id', 'id');
    const number = cell(row, 'number', 'document_number', 'invoice_number');
    const date = cell(row, 'date', 'document_date');
    const netMinor = moneyToMinor(cell(row, 'net', 'net_amount', 'taxable_value'));
    const taxMinor = moneyToMinor(cell(row, 'tax', 'tax_amount', 'gst'));
    const grossMinor = moneyToMinor(cell(row, 'gross', 'total', 'gross_amount'));
    if (kind === undefined || legacyId === undefined || number === undefined || date === undefined || netMinor === undefined || taxMinor === undefined || grossMinor === undefined) {
      problems.push(`${where}: needs kind, legacy id, number, date, and net, tax and gross in rupees`);
      return;
    }
    const partyRef = cell(row, 'party', 'party_code', 'customer_code', 'supplier_code');
    const attachmentIds = list(cell(row, 'attachments', 'attachment_ids'));
    const lines = lineRows.get(`${kind}|${legacyId}`);
    documents.push({
      kind: kind as HistoryKind, legacyId, number, date, netMinor, taxMinor, grossMinor,
      ...(partyRef === undefined ? {} : { partyRef }), ...(lines === undefined ? {} : { lines }), ...(attachmentIds.length === 0 ? {} : { attachmentIds }),
    });
  });
  for (const k of lineRows.keys()) if (!documents.some((d) => `${d.kind}|${d.legacyId}` === k)) problems.push(`history-lines.csv: lines for ${k.replace('|', ' ')}, which is not in history.csv`);
  const controlTotals: HistoryControlTotal[] = [];
  files.controlTotals?.rows.forEach((row, i) => {
    const kind = cell(row, 'kind', 'document_kind', 'type');
    const count = whole(cell(row, 'count', 'documents'));
    const grossMinor = moneyToMinor(cell(row, 'gross', 'total'));
    const taxMinor = moneyToMinor(cell(row, 'tax', 'gst'));
    if (kind === undefined || count === undefined || grossMinor === undefined || taxMinor === undefined) { problems.push(`${at('history-control-totals.csv', files.controlTotals!, i)}: needs kind, a whole count, and gross and tax in rupees`); return; }
    controlTotals.push({ kind: kind as HistoryKind, count, grossMinor, taxMinor });
  });
  if (files.controlTotals === undefined && documents.length > 0) problems.push('history-control-totals.csv is missing: history is reconciled to the old system\'s own report (MG-06 · §34), never to the extract itself');
  const attachments: ExtractAttachment[] = [];
  files.attachments?.rows.forEach((row, i) => {
    const where = at('attachments.csv', files.attachments!, i);
    const legacyId = cell(row, 'legacy_id', 'document_id', 'id');
    const fileName = cell(row, 'file_name', 'file', 'name');
    const contentType = cell(row, 'content_type', 'type', 'mime_type');
    const sha256 = cell(row, 'sha256', 'hash');
    if (legacyId === undefined || fileName === undefined || contentType === undefined || sha256 === undefined) { problems.push(`${where}: needs legacy id, file name, content type and the manifest SHA-256`); return; }
    const contentBase64 = files.attachmentBytes?.[fileName];
    if (contentBase64 === undefined) { problems.push(`${where}: the file ${fileName} is not in the attachments folder`); return; }
    attachments.push({ legacyId, fileName, contentType, sha256: sha256.toLowerCase(), contentBase64 });
  });
  return { history: { documents, attachments, controlTotals, attachmentManifestCount: files.attachments?.rows.length ?? 0 }, problems };
}

export function openOrdersFromFile(rows: CsvRows): { readonly orders: readonly ExtractOpenOrder[]; readonly problems: readonly string[] } {
  const problems: string[] = [];
  const byId = new Map<string, { number: string; supplierId: string; deliverToLocationId: string; lines: ExtractOpenOrder['lines'][number][] }>();
  rows.rows.forEach((row, i) => {
    const where = at('open-orders.csv', rows, i);
    const poId = cell(row, 'po_id', 'order_id', 'po');
    const number = cell(row, 'number', 'po_number', 'order_number');
    const supplierId = cell(row, 'supplier', 'supplier_code', 'supplier_id');
    const deliverTo = cell(row, 'deliver_to', 'store', 'location', 'delivery_location');
    const productId = cell(row, 'item_code', 'product_id', 'item');
    const orderedQty = whole(cell(row, 'ordered', 'ordered_qty', 'quantity'));
    const receivedQty = whole(cell(row, 'received', 'received_qty')) ?? (cell(row, 'received', 'received_qty') === undefined ? 0 : undefined);
    const unitCostMinor = moneyToMinor(cell(row, 'unit_cost', 'cost', 'rate'));
    if (poId === undefined || number === undefined || supplierId === undefined || deliverTo === undefined || productId === undefined || orderedQty === undefined || receivedQty === undefined || unitCostMinor === undefined) {
      problems.push(`${where}: needs order id and number, supplier, the store it is delivered to, item code, whole ordered (and received) quantities and a unit cost in rupees`);
      return;
    }
    const o = byId.get(poId) ?? { number, supplierId, deliverToLocationId: deliverTo, lines: [] };
    if (o.number !== number || o.supplierId !== supplierId || o.deliverToLocationId !== deliverTo) problems.push(`${where}: order ${poId} names a different number, supplier or store than its first line`);
    o.lines.push({ productId, orderedQty, receivedQty, unitCostMinor });
    byId.set(poId, o);
  });
  return { orders: [...byId].map(([poId, o]) => ({ poId, ...o })), problems };
}

export function trialBalanceFromFiles(lines: CsvRows, totals: CsvRows | undefined): { readonly trialBalance?: ExtractTrialBalance; readonly problems: readonly string[] } {
  const problems: string[] = [];
  const out: ExtractTrialBalance['lines'][number][] = [];
  lines.rows.forEach((row, i) => {
    const accountCode = cell(row, 'account_code', 'ledger_code', 'account', 'code');
    const accountName = cell(row, 'account_name', 'ledger_name', 'name');
    const debitText = cell(row, 'debit', 'dr', 'debit_balance');
    const creditText = cell(row, 'credit', 'cr', 'credit_balance');
    const debitMinor = debitText === undefined ? 0 : moneyToMinor(debitText);
    const creditMinor = creditText === undefined ? 0 : moneyToMinor(creditText);
    if (accountCode === undefined || accountName === undefined || debitMinor === undefined || creditMinor === undefined || debitMinor < 0 || creditMinor < 0) {
      problems.push(`${at('trial-balance.csv', lines, i)}: needs an account code and name, and a debit or credit balance in rupees (a blank side is zero)`);
      return;
    }
    out.push({ accountCode, accountName, debitMinor, creditMinor });
  });
  const t = totals?.rows[0];
  const debit = t === undefined ? undefined : moneyToMinor(cell(t, 'total_debit', 'debit', 'dr'));
  const credit = t === undefined ? undefined : moneyToMinor(cell(t, 'total_credit', 'credit', 'cr'));
  const count = t === undefined ? undefined : whole(cell(t, 'account_count', 'accounts', 'ledgers'));
  if (totals === undefined || totals.rows.length !== 1 || debit === undefined || credit === undefined || count === undefined) {
    problems.push('trial-balance-totals.csv must hold ONE row: total_debit, total_credit, account_count — as printed on the old system\'s trial balance (the figures the books are reconciled to)');
  }
  if (problems.length > 0) return { problems };
  return { trialBalance: { lines: out, oldSystemTotals: { debitMinor: debit!, creditMinor: credit!, accountCount: count! } }, problems };
}
