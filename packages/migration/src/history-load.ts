// GT-05 · MG-07 "Migrate all usable historical transactions and attachments" (§17, §17.1, §34) — the HISTORY load.
//
// Opening state (load.ts) is what the shop starts trading with. History is everything that already happened: the old
// system's sales invoices and returns, purchase orders, goods receipts, supplier bills, payments, credit/debit notes, stock
// movements and journals — and the documents behind them (scanned invoices, GRNs, agreements, compliance evidence). §34
// says how each is proven: documents by count and value/tax totals per kind; attachments by "manifest count / hash /
// readability sample".
//
// Three rules shape this file:
//
//   • HISTORY KEEPS ITS IDENTITY. Every record keeps the old system's own id (`legacyId`) and number, and reads back by
//     them. A customer's or supplier's history is found by the old party code it was booked to (`partyRef`).
//   • HISTORY IS READ-ONLY AND NEVER TRADES AGAIN. A migrated sales invoice is not a sale: it does not move stock, earn
//     points, post a journal or open a receivable. It lands in its own append-only register
//     (`POST /v1/migration/history/documents/:kind/:legacyId`), which has no edit or delete route. What the shop still OWES
//     or is OWED at cutover is the opening state (load.ts / supplier openings) — never re-derived from history.
//   • A DOCUMENT IS STORED AS ITS BYTES, WITH ITS HASH. An attachment is sent with the SHA-256 the extract manifest gives
//     it; the server recomputes the hash from the bytes and refuses a mismatch by name, keeps the bytes as an append-only
//     event (ADR 0010 — the documents path this system has), and recomputes the hash again on every read.
//
// Anything left behind needs the owner's written approval (history.ts `approveExclusion`); the reconciliation here lets
// ONLY approved exclusions explain a shortfall against the old system's control totals — anything else is a difference.

import { createHash } from 'node:crypto';
import { assertNonProduction } from './trial';
import type { LoadRequest, LoadClient } from './load';

/** The history kinds §17.1 / §34 name — sales, purchase, inventory, customer/supplier money and finance documents. */
export const HISTORY_KINDS = [
  'sales_invoice', 'sales_return', 'purchase_order', 'goods_receipt', 'purchase_invoice', 'purchase_return',
  'supplier_payment', 'customer_payment', 'credit_note', 'debit_note', 'stock_movement', 'journal',
] as const;
export type HistoryKind = (typeof HISTORY_KINDS)[number];
export const isHistoryKind = (v: unknown): v is HistoryKind => typeof v === 'string' && (HISTORY_KINDS as readonly string[]).includes(v);

/** Content types an attachment may carry — the scanned or exported documents §17.1 lists. */
export const ATTACHMENT_CONTENT_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/tiff', 'text/plain', 'text/csv'] as const;

/**
 * The largest attachment, in bytes, one request carries. The API refuses a body over 1 MiB (services/kernel/src/http-server.ts)
 * and base64 adds a third, so 700 000 bytes is the most that fits with its metadata. A larger scan is refused BY NAME, never
 * truncated; ADR 0010 names large binaries as the point to revisit document storage.
 */
export const MAX_ATTACHMENT_BYTES = 700_000;

export interface HistoryLine {
  readonly productId?: string;
  readonly description?: string;
  /** In the product's smallest steps, as the old system booked it (negative allowed for a stock movement out). */
  readonly quantityMinor: number;
  readonly netMinor: number;
  readonly taxMinor: number;
}

export interface HistoryTender {
  readonly method: string;
  readonly amountMinor: number;
}

/** One historical document as the old system holds it. */
export interface ExtractHistoryDocument {
  readonly kind: HistoryKind;
  /** The old system's own id for the document — its identity here too. */
  readonly legacyId: string;
  /** The number printed on it (invoice no., GRN no., …). */
  readonly number: string;
  /** YYYY-MM-DD — always BEFORE the opening date: a document on/after it is a delta (MG-09), not history. */
  readonly date: string;
  /** The old system's customer or supplier code it was booked to — how a party's history reads back. */
  readonly partyRef?: string;
  readonly lines?: readonly HistoryLine[];
  readonly netMinor: number;
  readonly taxMinor: number;
  readonly grossMinor: number;
  readonly tenders?: readonly HistoryTender[];
  /** Legacy ids of the attachments behind this document (each must be in the extract and loaded first). */
  readonly attachmentIds?: readonly string[];
}

/** One document file from the old system's document store, as the extract manifest lists it. */
export interface ExtractAttachment {
  readonly legacyId: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly contentBase64: string;
  /** The SHA-256 (hex) the extract manifest recorded for the file — checked against the bytes, never trusted alone. */
  readonly sha256: string;
}

/** What the OLD system's own report says it holds, per kind — the figure the load is reconciled to (MG-06 · §34). */
export interface HistoryControlTotal {
  readonly kind: HistoryKind;
  readonly count: number;
  readonly grossMinor: number;
  readonly taxMinor: number;
}

export interface ExtractHistory {
  readonly documents: readonly ExtractHistoryDocument[];
  readonly attachments: readonly ExtractAttachment[];
  /** Per kind, from the old system's report (not computed from the extract — that would reconcile the file to itself). */
  readonly controlTotals: readonly HistoryControlTotal[];
  /** The old document store's own file count (the §34 "manifest count"). */
  readonly attachmentManifestCount: number;
}

const isId = (s: unknown): s is string => typeof s === 'string' && s.trim() !== '';
const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00.000Z`));
const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n);
const isMinor = (n: unknown): n is number => isInt(n) && n >= 0;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** The bytes of a strict base64 string, or undefined when it is not one (never a lenient decode that drops characters). */
export function strictBase64(s: unknown): Buffer | undefined {
  if (typeof s !== 'string' || s === '' || !BASE64.test(s)) return undefined;
  const bytes = Buffer.from(s, 'base64');
  return bytes.toString('base64') === s ? bytes : undefined;
}

/**
 * Every reason this document cannot be history, in words the operator can check in the old system. Shared by the plan (so a
 * bad row is named before anything is sent) and the route (so a hand-sent one is refused the same way). Empty = usable.
 */
export function historyDocumentProblems(input: Readonly<Record<string, unknown>> | ExtractHistoryDocument, openingDate: string): readonly string[] {
  const d = input as Partial<ExtractHistoryDocument>;
  const p: string[] = [];
  if (!isHistoryKind(d.kind)) p.push(`kind must be one of ${HISTORY_KINDS.join(', ')}`);
  if (!isId(d.legacyId)) p.push('the old system\'s id is required — history keeps its identity');
  if (!isId(d.number)) p.push('the document number is required');
  if (!isDate(d.date)) p.push('the date must be YYYY-MM-DD');
  else if (isDate(openingDate) && d.date >= openingDate) p.push(`dated ${d.date}, on or after the opening date ${openingDate} — that is a change since the extract (a delta, MG-09), not history`);
  if (d.partyRef !== undefined && !isId(d.partyRef)) p.push('the party code, when given, must name a customer or supplier');
  if (!isMinor(d.netMinor) || !isMinor(d.taxMinor) || !isMinor(d.grossMinor)) p.push('net, tax and gross must be whole non-negative paise');
  else if (d.netMinor + d.taxMinor !== d.grossMinor) p.push(`net ${d.netMinor} + tax ${d.taxMinor} is not the gross ${d.grossMinor} — a document whose total does not add up is not usable as it stands`);
  if (d.lines !== undefined) {
    if (!Array.isArray(d.lines)) p.push('lines, when given, must be a list');
    else {
      const bad = d.lines.findIndex((l) => l === null || typeof l !== 'object' || !isInt(l.quantityMinor) || !isMinor(l.netMinor) || !isMinor(l.taxMinor)
        || (l.productId !== undefined && !isId(l.productId)));
      if (bad >= 0) p.push(`line ${bad + 1}: needs a whole quantity and whole non-negative net and tax paise`);
      else if (isMinor(d.netMinor) && isMinor(d.taxMinor)) {
        const net = d.lines.reduce((s, l) => s + l.netMinor, 0);
        const tax = d.lines.reduce((s, l) => s + l.taxMinor, 0);
        if (net !== d.netMinor || tax !== d.taxMinor) p.push(`its lines add up to net ${net} / tax ${tax}, not the document's net ${d.netMinor} / tax ${d.taxMinor}`);
      }
    }
  }
  if (d.tenders !== undefined) {
    if (!Array.isArray(d.tenders) || d.tenders.some((t) => t === null || typeof t !== 'object' || !isId(t.method) || !isMinor(t.amountMinor))) p.push('tenders, when given, need a method and whole non-negative paise each');
    else if (isMinor(d.grossMinor)) {
      const paid = d.tenders.reduce((s, t) => s + t.amountMinor, 0);
      if (paid !== d.grossMinor) p.push(`its tenders add up to ${paid}, not the gross ${d.grossMinor}`);
    }
  }
  if (d.attachmentIds !== undefined && (!Array.isArray(d.attachmentIds) || !d.attachmentIds.every(isId))) p.push('attachment ids, when given, must each name an attachment');
  return p;
}

/** Every reason this attachment cannot be stored — including bytes that do not hash to what the manifest says. */
export function attachmentProblems(input: Readonly<Record<string, unknown>> | ExtractAttachment): readonly string[] {
  const a = input as Partial<ExtractAttachment>;
  const p: string[] = [];
  if (!isId(a.legacyId)) p.push('the old document store\'s id is required');
  if (!isId(a.fileName)) p.push('the file name is required');
  if (typeof a.contentType !== 'string' || !(ATTACHMENT_CONTENT_TYPES as readonly string[]).includes(a.contentType)) p.push(`content type must be one of ${ATTACHMENT_CONTENT_TYPES.join(', ')}`);
  if (typeof a.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(a.sha256)) p.push('the manifest SHA-256 must be 64 lower-case hex characters');
  const bytes = strictBase64(a.contentBase64);
  if (bytes === undefined) p.push('the content is not readable as base64 — the file cannot be checked or stored');
  else if (bytes.length === 0) p.push('the file is empty');
  else if (bytes.length > MAX_ATTACHMENT_BYTES) p.push(`the file is ${bytes.length} bytes, over the ${MAX_ATTACHMENT_BYTES}-byte limit one request carries — it is not truncated; it waits for the owner's decision on large documents`);
  else if (typeof a.sha256 === 'string' && sha256Hex(bytes) !== a.sha256) p.push(`its bytes hash to ${sha256Hex(bytes)}, not the manifest's ${a.sha256} — the file changed or was mis-copied after the extract was sealed`);
  return p;
}

// ── The plan ─────────────────────────────────────────────────────────────────────────────────────────────

export interface HistoryLoadStep {
  readonly group: 'attachment' | 'document';
  readonly what: string;
  readonly path: string;
  readonly body: unknown;
  readonly idempotencyKey: string;
}

export type HistoryPlan =
  | { readonly ok: true; readonly loadId: string; readonly tenantId: string; readonly operator: string; readonly steps: readonly HistoryLoadStep[] }
  | { readonly ok: false; readonly refusedBecause: 'production_target' | 'demo_tenant' | 'tenant_mismatch' | 'no_operator' | 'extract_not_sealed' | 'malformed_rows'; readonly detail: string; readonly problems: readonly string[] };

export type HistoryRequest = Pick<LoadRequest, 'target' | 'tenantId' | 'demoTenantIds' | 'operator' | 'extractSealed' | 'loadId' | 'receivedOnDate'>;

/** The guards, every bad row by name, then the ordered calls: attachments first, so each document's links resolve. */
export function planHistoryLoad(history: ExtractHistory, req: HistoryRequest): HistoryPlan {
  const assertion = assertNonProduction(req.target);
  if (!assertion.permitted) return { ok: false, refusedBecause: 'production_target', detail: assertion.detail, problems: [] };
  if (req.demoTenantIds.includes(req.tenantId)) return { ok: false, refusedBecause: 'demo_tenant', detail: `tenant "${req.tenantId}" is a demo tenant — real history never goes into it (G4)`, problems: [] };
  if (req.tenantId !== req.target.tenantId) return { ok: false, refusedBecause: 'tenant_mismatch', detail: `the load names tenant "${req.tenantId}" but the target is for "${req.target.tenantId}"`, problems: [] };
  if (req.operator.trim() === '') return { ok: false, refusedBecause: 'no_operator', detail: 'a history load needs a named person', problems: [] };
  if (!req.extractSealed) return { ok: false, refusedBecause: 'extract_not_sealed', detail: 'the extract has not been sealed and verified (MG-02)', problems: [] };

  const problems: string[] = [];
  const attachmentIds = new Set<string>();
  history.attachments.forEach((a, i) => {
    const at = `attachment row ${i + 1} (${String(a.legacyId)})`;
    for (const x of attachmentProblems(a)) problems.push(`${at}: ${x}`);
    if (attachmentIds.has(a.legacyId)) problems.push(`${at}: listed twice`);
    attachmentIds.add(a.legacyId);
  });
  const docKeys = new Set<string>();
  history.documents.forEach((d, i) => {
    const at = `history row ${i + 1} (${String(d.kind)} ${String(d.legacyId)})`;
    for (const x of historyDocumentProblems(d, req.receivedOnDate)) problems.push(`${at}: ${x}`);
    const key = `${d.kind}|${d.legacyId}`;
    if (docKeys.has(key)) problems.push(`${at}: listed twice`);
    docKeys.add(key);
    for (const id of d.attachmentIds ?? []) if (!attachmentIds.has(id)) problems.push(`${at}: attachment "${id}" is not in the extract`);
  });
  if (problems.length > 0) return { ok: false, refusedBecause: 'malformed_rows', detail: `${problems.length} history row(s) cannot load — fix the file once, then plan again`, problems };

  const key = (s: string): string => `${req.loadId}-history-${s}`;
  const steps: HistoryLoadStep[] = [
    ...history.attachments.map((a): HistoryLoadStep => ({
      group: 'attachment', what: `attachment ${a.legacyId} (${a.fileName})`,
      path: `/v1/migration/history/attachments/${encodeURIComponent(a.legacyId)}`,
      body: { loadId: req.loadId, fileName: a.fileName, contentType: a.contentType, contentBase64: a.contentBase64, sha256: a.sha256 },
      idempotencyKey: key(`attachment-${a.legacyId}`),
    })),
    ...history.documents.map((d): HistoryLoadStep => ({
      group: 'document', what: `${d.kind} ${d.legacyId} (${d.number})`,
      path: `/v1/migration/history/documents/${encodeURIComponent(d.kind)}/${encodeURIComponent(d.legacyId)}`,
      body: {
        loadId: req.loadId, openingDate: req.receivedOnDate, number: d.number, date: d.date,
        ...(d.partyRef === undefined ? {} : { partyRef: d.partyRef }),
        ...(d.lines === undefined ? {} : { lines: d.lines }),
        netMinor: d.netMinor, taxMinor: d.taxMinor, grossMinor: d.grossMinor,
        ...(d.tenders === undefined ? {} : { tenders: d.tenders }),
        ...(d.attachmentIds === undefined ? {} : { attachmentIds: d.attachmentIds }),
      },
      idempotencyKey: key(`document-${d.kind}-${d.legacyId}`),
    })),
  ];
  return { ok: true, loadId: req.loadId, tenantId: req.tenantId, operator: req.operator, steps };
}

// ── The read-back: identity, read-only, count/total per kind, hashes ─────────────────────────────────────

export interface HistoryReadBackClient {
  request(input: { readonly method: 'GET'; readonly path: string; readonly userId: string; readonly tenantId: string; readonly query?: Readonly<Record<string, string>> }): Promise<{ readonly status: number; readonly body: unknown }>;
}

export interface HistoryCheckLine {
  readonly check: 'document' | 'kind_count' | 'kind_gross' | 'kind_tax' | 'attachment' | 'attachment_count' | 'exclusions';
  readonly key: string;
  readonly expected: number | string;
  readonly actual: number | string | null;
  readonly agrees: boolean;
  readonly note?: string;
}

export interface HistoryReadBack {
  readonly loadId: string;
  readonly lines: readonly HistoryCheckLine[];
  readonly differences: readonly HistoryCheckLine[];
  readonly agrees: boolean;
}

/**
 * Read the history back through the API and reconcile it: every document by its legacy id (same number, date, party and
 * totals, flagged read-only), every attachment by its legacy id (bytes re-hashed by the server AND here, to the manifest's
 * hash), and per kind the count / gross / tax against the OLD SYSTEM's control totals — where a shortfall is explained
 * only by owner-approved exclusions (MG-07), and only when it matches them exactly.
 */
export async function readBackHistory(client: HistoryReadBackClient, history: ExtractHistory, req: Pick<LoadRequest, 'tenantId' | 'operator' | 'loadId'>): Promise<HistoryReadBack> {
  const get = async (path: string, query?: Readonly<Record<string, string>>): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await client.request({ method: 'GET', path, userId: req.operator, tenantId: req.tenantId, ...(query === undefined ? {} : { query }) });
    return { status: res.status, body: (res.body ?? {}) as Record<string, unknown> };
  };
  const lines: HistoryCheckLine[] = [];

  const listed = await get('/v1/migration/history/documents', { loadId: req.loadId });
  const docs = (Array.isArray(listed.body['documents']) ? listed.body['documents'] : []) as Record<string, unknown>[];
  const byKey = new Map(docs.map((d) => [`${String(d['kind'])}|${String(d['legacyId'])}`, d]));
  for (const d of history.documents) {
    const key = `${d.kind}/${d.legacyId}`;
    const got = byKey.get(`${d.kind}|${d.legacyId}`);
    if (got === undefined) { lines.push({ check: 'document', key, expected: d.grossMinor, actual: null, agrees: false, note: 'not in the history register' }); continue; }
    const wrong: string[] = [];
    if (got['number'] !== d.number) wrong.push(`number ${String(got['number'])}`);
    if (got['date'] !== d.date) wrong.push(`date ${String(got['date'])}`);
    if ((got['partyRef'] ?? undefined) !== d.partyRef) wrong.push(`party ${String(got['partyRef'])}`);
    if (got['netMinor'] !== d.netMinor || got['taxMinor'] !== d.taxMinor) wrong.push(`net/tax ${String(got['netMinor'])}/${String(got['taxMinor'])}`);
    if (got['readOnly'] !== true) wrong.push('not marked read-only');
    if (JSON.stringify(got['attachmentIds'] ?? []) !== JSON.stringify(d.attachmentIds ?? [])) wrong.push('different attachments');
    const actual = typeof got['grossMinor'] === 'number' ? got['grossMinor'] : null;
    lines.push({ check: 'document', key, expected: d.grossMinor, actual, agrees: wrong.length === 0 && actual === d.grossMinor, ...(wrong.length === 0 ? {} : { note: wrong.join('; ') }) });
  }

  // Per kind, against the old system's own report — counted over the WHOLE register (every load), since that is what the
  // shop now holds as history; an approved exclusion is the only thing allowed to explain a shortfall.
  const all = await get('/v1/migration/history/documents');
  const totals = (all.body['totals'] ?? {}) as Record<string, { count?: number; grossMinor?: number; taxMinor?: number }>;
  const exclusions = await get('/v1/migration/history/exclusions');
  const position = (exclusions.body['position'] ?? {}) as { approvedRecords?: number; approvedValueMinor?: number; awaitingOwner?: unknown[] };
  let shortRecords = 0;
  let shortValue = 0;
  for (const c of history.controlTotals) {
    const t = totals[c.kind] ?? {};
    const count = typeof t.count === 'number' ? t.count : 0;
    const gross = typeof t.grossMinor === 'number' ? t.grossMinor : 0;
    const tax = typeof t.taxMinor === 'number' ? t.taxMinor : 0;
    shortRecords += c.count - count;
    shortValue += c.grossMinor - gross;
    lines.push({ check: 'kind_count', key: c.kind, expected: c.count, actual: count, agrees: count === c.count });
    lines.push({ check: 'kind_gross', key: c.kind, expected: c.grossMinor, actual: gross, agrees: gross === c.grossMinor });
    lines.push({ check: 'kind_tax', key: c.kind, expected: c.taxMinor, actual: tax, agrees: tax === c.taxMinor });
  }
  const approvedRecords = position.approvedRecords ?? 0;
  const approvedValue = position.approvedValueMinor ?? 0;
  if (shortRecords !== 0 || shortValue !== 0 || approvedRecords !== 0) {
    const explained = shortRecords === approvedRecords && shortValue === approvedValue;
    lines.push({
      check: 'exclusions', key: 'approved exclusions', expected: `${shortRecords} record(s) / ${shortValue} paise short`, actual: `${approvedRecords} record(s) / ${approvedValue} paise approved`,
      agrees: explained,
      note: explained ? 'the shortfall is exactly what the owner approved leaving behind' : 'the shortfall is NOT explained by owner-approved exclusions — it is an open difference',
    });
    // An explained shortfall turns the per-kind count/value lines it explains into agreed lines with the reason said.
    if (explained) {
      for (let i = 0; i < lines.length; i += 1) {
        const l = lines[i]!;
        if ((l.check === 'kind_count' || l.check === 'kind_gross' || l.check === 'kind_tax') && !l.agrees) lines[i] = { ...l, agrees: true, note: 'short by an owner-approved exclusion' };
      }
    }
  }

  // Attachments — every file by its legacy id; the server's re-hash on read and ours must both be the manifest's.
  const index = await get('/v1/migration/history/attachments');
  const stored = typeof index.body['count'] === 'number' ? index.body['count'] : null;
  lines.push({ check: 'attachment_count', key: 'manifest', expected: history.attachmentManifestCount, actual: stored, agrees: stored === history.attachmentManifestCount });
  for (const a of history.attachments) {
    const res = await get(`/v1/migration/history/attachments/${encodeURIComponent(a.legacyId)}`);
    if (res.status !== 200) { lines.push({ check: 'attachment', key: a.legacyId, expected: a.sha256, actual: null, agrees: false, note: `not readable (${res.status})` }); continue; }
    const bytes = strictBase64(res.body['contentBase64']);
    const ours = bytes === undefined ? null : sha256Hex(bytes);
    const theirs = res.body['sha256Now'];
    const ok = ours === a.sha256 && theirs === a.sha256 && res.body['fileName'] === a.fileName;
    lines.push({ check: 'attachment', key: a.legacyId, expected: a.sha256, actual: ours, agrees: ok, ...(ok ? {} : { note: `server re-hash ${String(theirs)}; file ${String(res.body['fileName'])}` }) });
  }

  const differences = lines.filter((l) => !l.agrees);
  return { loadId: req.loadId, lines, differences, agrees: differences.length === 0 };
}

// ── Execution ───────────────────────────────────────────────────────────────────────────────────────────

export interface HistoryLoadReport {
  readonly loadId: string;
  readonly steps: readonly { readonly group: HistoryLoadStep['group']; readonly what: string; readonly ok: boolean; readonly status: number; readonly detail?: string }[];
  readonly landed: number;
  readonly failed: number;
  readonly ok: boolean;
}

/**
 * Run the plan as the named operator, in order. A refused step is a visible line (never a silent skip); a re-run replays the
 * same keys, and the register's own identity (kind + legacy id) means a re-run records nothing twice.
 */
export async function executeHistoryLoad(client: LoadClient, plan: Extract<HistoryPlan, { ok: true }>): Promise<HistoryLoadReport> {
  const steps: { group: HistoryLoadStep['group']; what: string; ok: boolean; status: number; detail?: string }[] = [];
  for (const s of plan.steps) {
    const res = await client.request({ method: 'POST', path: s.path, userId: plan.operator, tenantId: plan.tenantId, body: s.body, idempotencyKey: s.idempotencyKey });
    const ok = res.status === 200 || res.status === 201;
    const err = (res.body as { error?: { code?: string; whatHappened?: string } } | undefined)?.error;
    steps.push({ group: s.group, what: s.what, ok, status: res.status, ...(ok || err === undefined ? {} : { detail: `${err.code ?? ''}: ${err.whatHappened ?? ''}` }) });
  }
  const landed = steps.filter((s) => s.ok).length;
  return { loadId: plan.loadId, steps, landed, failed: steps.length - landed, ok: landed === plan.steps.length };
}
