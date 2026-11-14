// The store PC's "Import from the old system" page — the server behind it (owner, 7 Nov 2026, OB-704 · M30 · OB-257).
//
// The owner asked for screens, not commands, and for every gap in the old ERP's data to be FIXED here, not carried. This
// small server runs on the store PC only (127.0.0.1), serves one page, and does on the PC what the commands did:
//
//   sign in      staff ID + their own till PIN, checked on this PC (the till's own check, OB-257); a session of 20
//                minutes. Every call to this copy of head office is made AS THAT PERSON, with a short-lived token minted
//                after their PIN matched — never a shared login (hard rule #4), never a name typed.
//   read         the old ERP's three Excel reports, uploaded from the page: read here, kept here (D:\SRE-data\imports\…,
//                with the original files as evidence — never deleted, hard rule #6), and recorded at head office by
//                fingerprint (they never leave the PC).
//   fix          each gap, by the person whose job it is (head office refuses anyone else by name): a GST rate by Finance;
//                a barcode, a price, the label facts or "not in this department" by whoever runs the load.
//   load         the ready items → the four published slice files → SEALED (MG-02), STAGED (MG-05), ACCEPTED by a
//                second person (MG-06), APPLIED — the same tested steps as `migration:slice`, each step re-asking the
//                acting person's PIN. The person who prepares a load can never accept it.
//
// Every rule lives in tested modules (packages/migration/src/old-system-import.ts, slice-import.ts, slice-command.ts,
// owner-steps-command.ts); this is the shell around them. Nothing here talks to anything but this PC's own head office.

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { PILOT_CATEGORY_ID, PILOT_CATEGORY_NAME, readPurchaseReport, csv, forExcel, LABEL_FACTS, paiseText } from '../../packages/migration/src/bpal-slice';
import { analyseOldSystem, importSummary, isReady, resolveImport, sliceFilesFor, type ImportFix, type OldItem, type ResolvedItem } from '../../packages/migration/src/old-system-import';
import { runSliceCommand } from '../../packages/migration/src/slice-command';
import { sealSlice, type PinVerdict, type SetupClient } from '../../packages/migration/src/owner-steps-command';
import type { CommandClient } from '../../packages/migration/src/load-command';
import { readXlsxTable } from './xlsx-read.mjs';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';

export interface ImportAppDeps {
  /** Calls this PC's head office as the named person; `signedInAt` is when their PIN matched (the token's step-up). */
  readonly client: SetupClient;
  readonly verifyPin: (userId: string, pin: string) => PinVerdict;
  readonly tenantId: string;
  readonly storeId: string;
  readonly targetKind: string | undefined;
  readonly demoTenantIds: readonly string[];
  /** Where imports are kept on this PC: <data folder>\imports. */
  readonly dataDir: string;
  readonly pageHtml: string;
  readonly now: () => Date;
  /**
   * CR-01 step 4 (OI-07): inside the store PC's Office app, the person is the one signed in to the office screens with their
   * own PIN (OB-259) — this page asks for no sign-in of its own, and every load step still asks their PIN again. Absent:
   * the page's own staff ID + PIN sign-in, as before.
   */
  readonly officeSession?: (req: IncomingMessage) => Promise<{ readonly userId: string; readonly signedInAt: string } | null>;
}

const SESSION_MS = 20 * 60_000;
const MAX_UPLOAD_BYTES = 96 * 1024 * 1024;
const WRONG_PIN_LIMIT = 5;
const LOCK_MS = 15 * 60_000;
const ID = /^[A-Za-z0-9._-]{1,80}$/;
const sha256 = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

interface Session { readonly userId: string; readonly signedInAt: string; lastSeen: number }
interface StoredRead { readonly importId: string; readonly today: string; readonly ratesFrom: string; readonly backupRestoredOn: string; readonly items: readonly OldItem[] }
interface LoadEntry { readonly loadId: string; readonly itemIds: readonly string[]; readonly preparedBy: string; readonly preparedAt: string; applied?: boolean }

/** A thrown answer: the page shows `message` as it is — plain words, what happened and what to do. */
class Said extends Error { constructor(readonly status: number, message: string, readonly lines: readonly string[] = []) { super(message); } }

export function createImportApp(deps: ImportAppDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const sessions = new Map<string, Session>();
  const wrong = new Map<string, { count: number; until: number }>();
  mkdirSync(deps.dataDir, { recursive: true });

  const nowIso = (): string => deps.now().toISOString();
  // The shop's day (India), never the UTC date of now (M01-FR-02): a 2 a.m. read is that shop day's.
  const today = (): string => shopDateIn(nowIso());
  const write = (path: string, text: string | Buffer): void => { writeFileSync(`${path}.part`, text); renameSync(`${path}.part`, path); };
  const writeOnce = (path: string, text: string | Buffer): void => { if (!existsSync(path)) write(path, text); };

  /** Head office, as this session's person. A non-2xx answer becomes the page's words, never a raw code. */
  const as = (s: Session) => async (method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, idempotencyKey?: string): Promise<{ status: number; body: unknown }> => {
    const r = await deps.client.request({ method, path, userId: s.userId, tenantId: deps.tenantId, signedInAt: s.signedInAt, ...(body === undefined ? {} : { body }), ...(idempotencyKey === undefined ? {} : { idempotencyKey }) });
    return { status: r.status, body: r.body };
  };
  const said = (r: { status: number; body: unknown }, what: string): never => {
    const e = isObj(r.body) && isObj(r.body['error']) ? r.body['error'] : undefined;
    const words = e === undefined ? '' : `${String(e['whatHappened'] ?? '')} ${String(e['nextSafeAction'] ?? '')}`.trim();
    throw new Said(r.status === 403 ? 403 : 422, `${what}: ${words === '' ? `head office answered ${r.status}` : words}`);
  };
  /** The commands' client, held to THIS person: a step that would act as anybody else is refused, never made. */
  const commandClient = (s: Session, signedInAt: string): CommandClient => ({
    request: async (r) => {
      if (r.userId !== s.userId) throw new Said(403, `This step would act as ${r.userId}, but ${s.userId} is signed in. Each person does their own step, signed in as themselves.`);
      const qs = r.query === undefined || Object.keys(r.query).length === 0 ? '' : `?${new URLSearchParams(r.query).toString()}`;
      return deps.client.request({ method: r.method, path: `${r.path}${qs}`, userId: r.userId, tenantId: r.tenantId, signedInAt, ...(r.body === undefined ? {} : { body: r.body }), ...(r.idempotencyKey === undefined ? {} : { idempotencyKey: r.idempotencyKey }) });
    },
  });

  // ── the PIN: checked on this PC, five wrong in a row lock the staff ID for 15 minutes (as the till does) ──────────
  const checkPin = (userId: string, pin: unknown): void => {
    const lock = wrong.get(userId);
    if (lock !== undefined && lock.until > Date.now()) throw new Said(423, `${userId} is locked for a few minutes after ${WRONG_PIN_LIMIT} wrong PINs. Wait, then try again.`);
    const verdict = typeof pin === 'string' && /^\d{6}$/.test(pin) ? deps.verifyPin(userId, pin) : 'wrong';
    if (verdict === 'cannot_check') throw new Said(503, 'This PC cannot check till PINs yet (the till is not installed, or its settings cannot be read). Install the till first (owner guide Part 13).');
    if (verdict === 'no_pin_issued') throw new Said(401, `${userId} has no till PIN on this computer. Make one first (owner guide Part 16), with them there.`);
    if (verdict !== 'ok') {
      const n = (lock?.count ?? 0) + 1;
      wrong.set(userId, { count: n, until: n >= WRONG_PIN_LIMIT ? Date.now() + LOCK_MS : 0 });
      throw new Said(401, `That is not ${userId}'s till PIN. Nothing was done.`);
    }
    wrong.delete(userId);
  };

  const sessionOf = async (req: IncomingMessage): Promise<Session> => {
    if (deps.officeSession !== undefined) {
      const o = await deps.officeSession(req);
      if (o === null) throw new Said(401, 'Your office sign-in has ended. Open the office screens and enter your PIN again.');
      return { userId: o.userId, signedInAt: o.signedInAt, lastSeen: Date.now() };
    }
    const id = /(?:^|;\s*)sre_import=([A-Za-z0-9_-]+)/.exec(req.headers.cookie ?? '')?.[1];
    const s = id === undefined ? undefined : sessions.get(id);
    if (s === undefined || Date.now() - s.lastSeen > SESSION_MS) { if (id !== undefined) sessions.delete(id); throw new Said(401, 'Sign in with your staff ID and your till PIN.'); }
    s.lastSeen = Date.now();
    return s;
  };

  // ── an import kept on this PC ────────────────────────────────────────────────────────────────────────────────
  const dirOf = (importId: string): string => { if (!ID.test(importId)) throw new Said(404, 'No such import.'); return join(deps.dataDir, importId); };
  const readOf = (importId: string): StoredRead => {
    const p = join(dirOf(importId), 'read.json');
    if (!existsSync(p)) throw new Said(404, `Import ${importId} is not on this computer.`);
    return JSON.parse(readFileSync(p, 'utf8')) as StoredRead;
  };
  const loadsOf = (importId: string): LoadEntry[] => { const p = join(dirOf(importId), 'loads.json'); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) as LoadEntry[] : []; };
  const saveLoads = (importId: string, loads: readonly LoadEntry[]): void => write(join(dirOf(importId), 'loads.json'), `${JSON.stringify(loads, null, 2)}\n`);

  /** The import as it stands: what the PC read, every fix from head office, what has been loaded — each item resolved. */
  const standing = async (s: Session, importId: string): Promise<{ read: StoredRead; record: Record<string, unknown>; fixes: readonly ImportFix[]; resolved: ResolvedItem[]; loads: LoadEntry[]; finance: boolean }> => {
    const read = readOf(importId);
    const call = as(s);
    let finance = false;
    let r = await call('GET', `/v1/migration/old-system-imports/${encodeURIComponent(importId)}`);
    if (r.status === 403) { finance = true; r = await call('GET', `/v1/migration/old-system-imports/${encodeURIComponent(importId)}/for-finance`); }
    if (r.status !== 200) said(r, 'The import could not be read from head office');
    const body = r.body as { import: Record<string, unknown>; fixes: ImportFix[] };
    const readDigest = sha256(readFileSync(join(dirOf(importId), 'read.json')));
    if (body.import['readDigest'] !== readDigest) throw new Said(409, `What this PC holds for import ${importId} is not what was recorded at head office (the read changed). Nothing is shown from it — read the files again as a new import.`);
    const loads = loadsOf(importId);
    if (!finance) {
      let changed = false;
      for (const l of loads.filter((x) => x.applied !== true)) {
        const v = await call('GET', `/v1/migration/loads/${encodeURIComponent(l.loadId)}`);
        if (v.status === 200 && isObj(v.body) && v.body['applied'] !== undefined) { l.applied = true; changed = true; }
      }
      if (changed) saveLoads(importId, loads);
    }
    const loaded = new Set(loads.filter((l) => l.applied === true).flatMap((l) => l.itemIds));
    return { read, record: body.import, fixes: body.fixes, resolved: resolveImport(read.items, body.fixes, loaded), loads, finance };
  };

  const loadPaths = (importId: string, loadId: string): { dir: string; manifest: string } => {
    if (!ID.test(loadId)) throw new Said(404, 'No such load.');
    const dir = join(dirOf(importId), loadId);
    return { dir, manifest: join(dir, 'slice.json') };
  };
  const sliceFilesIn = (dir: string): Record<string, string> =>
    Object.fromEntries(['tax-classes.csv', 'products.csv', 'prices.csv', 'barcodes.csv'].filter((f) => existsSync(join(dir, f))).map((f) => [f, readFileSync(join(dir, f), 'utf8')]));

  // ── the routes ───────────────────────────────────────────────────────────────────────────────────────────────
  async function route(req: IncomingMessage, url: URL, body: unknown): Promise<{ status?: number; json?: unknown; csv?: { name: string; text: string }; cookie?: string }> {
    const m = req.method ?? 'GET';
    const p = url.pathname;
    const b = isObj(body) ? body : {};

    if (deps.officeSession !== undefined && (p === '/session' || p === '/session/end')) {
      // Inside the Office app the office screens' own sign-in and sign-out are the only ones (OB-259).
      if (p === '/session/end') return { json: { signedOut: false, office: true } };
      throw new Said(409, 'You are signed in through the office screens. Sign out there.');
    }
    if (m === 'POST' && p === '/session') {
      const userId = typeof b['staffId'] === 'string' ? b['staffId'].trim() : '';
      if (!ID.test(userId)) throw new Said(400, 'Type your staff ID (for example cashier-01).');
      checkPin(userId, b['pin']);
      const id = randomBytes(24).toString('base64url');
      sessions.set(id, { userId, signedInAt: nowIso(), lastSeen: Date.now() });
      return { json: { userId }, cookie: `sre_import=${id}; HttpOnly; SameSite=Strict; Path=/` };
    }
    if (m === 'POST' && p === '/session/end') {
      const id = /(?:^|;\s*)sre_import=([A-Za-z0-9_-]+)/.exec(req.headers.cookie ?? '')?.[1];
      if (id !== undefined) sessions.delete(id);
      return { json: { signedOut: true }, cookie: 'sre_import=; Max-Age=0; Path=/' };
    }

    const s = await sessionOf(req);
    const call = as(s);
    if (m === 'GET' && p === '/api/me') return { json: { userId: s.userId, office: deps.officeSession !== undefined } };

    if (m === 'GET' && p === '/api/imports') {
      const r = await call('GET', '/v1/migration/old-system-imports');
      const here = existsSync(deps.dataDir) ? readdirSync(deps.dataDir).filter((d) => existsSync(join(deps.dataDir, d, 'read.json'))) : [];
      if (r.status === 403) return { json: { imports: here.map((importId) => ({ importId })), finance: true } };
      if (r.status !== 200) said(r, 'The imports could not be read from head office');
      return { json: { imports: (r.body as { imports: unknown[] }).imports } };
    }

    if (m === 'POST' && p === '/api/imports') {
      // { files: [{ name, base64 }, …], backupRestoredOn? } — every Excel file the old ERP gave, in ONE choice, in any order
      // (owner, 8 Nov 2026, OB-706: "it should read autonomously"). Each file is recognised by its own column names: the
      // barcode report (EanCode), the HSN report (Hsn Code + Gst %) and the purchase report (Purc Date, MRP, Selling,
      // Cost) — and any of them may come as several files (Bpal exports three months at a time, OB-705). A file that is
      // none of them is named, with its columns; nothing is read until every file is understood. The older shape
      // { files: { ean, hsn, purchases } } is still taken.
      const raw = Array.isArray(b['files']) ? b['files']
        : isObj(b['files']) ? ['ean', 'hsn', 'purchases'].flatMap((k) => { const v = (b['files'] as Record<string, unknown>)[k]; return Array.isArray(v) ? v : v === undefined ? [] : [v]; }) : [];
      const chosen = raw.map((v) => (isObj(v) && typeof v['name'] === 'string' && typeof v['base64'] === 'string' ? { name: v['name'], bytes: Buffer.from(v['base64'], 'base64') } : undefined));
      if (chosen.length === 0 || chosen.some((f) => f === undefined)) throw new Said(400, 'Choose the old system\'s Excel files: the barcode (EANCODE) report, the HSN report and the Product wise Detail Report files — all together.');
      if (chosen.length > 30) throw new Said(400, 'Choose at most 30 files at once.');
      const seenDigest = new Map<string, string>();
      for (const f of chosen as { name: string; bytes: Buffer }[]) {
        const d = sha256(f.bytes);
        if (seenDigest.has(d)) throw new Said(400, `${f.name} and ${seenDigest.get(d)} are the same file — choose each file once. Nothing was read.`);
        seenDigest.set(d, f.name);
      }
      const has = (headers: readonly string[], ...names: string[]): boolean => headers.some((h) => names.some((n) => h.trim().toLowerCase() === n.toLowerCase()));
      const sorted: Record<'ean' | 'hsn' | 'purchases', { name: string; bytes: Buffer; rows: Record<string, string>[] }[]> = { ean: [], hsn: [], purchases: [] };
      for (const f of chosen as { name: string; bytes: Buffer }[]) {
        let rows: Record<string, string>[];
        try { rows = readXlsxTable(f.bytes, 'Item Id'); } catch (e) { throw new Said(422, `${f.name}: ${e instanceof Error ? e.message : String(e)}. Nothing was read.`); }
        const headers = rows.length === 0 ? [] : Object.keys(rows[0]!);
        if (has(headers, 'EanCode', 'EAN Code', 'Barcode')) sorted.ean.push({ ...f, rows });
        else if (has(headers, 'Hsn Code', 'HSN Code', 'HSN') && has(headers, 'Gst %', 'GST %', 'Gst%')) sorted.hsn.push({ ...f, rows });
        else if (readPurchaseReport(rows).problems.length === 0) sorted.purchases.push({ ...f, rows });
        else if (has(headers, 'Purc Date', 'Purchase Date', 'MRP', 'Selling')) throw new Said(422, `${f.name} looks like a purchase report but cannot give the prices: ${readPurchaseReport(rows).problems.join('; ')}. Nothing was read.`);
        else throw new Said(422, `${f.name} is not a report this page reads (its columns are: ${headers.join(', ') || 'none'}). Choose the barcode (EANCODE), HSN and Product wise Detail reports. Nothing was read.`);
      }
      if (sorted.ean.length === 0) throw new Said(400, 'The barcode report (EANCODE: Item Id, Item Name, EanCode) is not among the files chosen. Nothing was read.');
      if (sorted.hsn.length === 0) throw new Said(400, 'The HSN report (Item Id, Hsn Code, Gst %) is not among the files chosen. Nothing was read.');
      if (sorted.purchases.length === 0) throw new Said(400, 'No Product wise Detail Report (Purc Date, Cost, NetCost, Selling, MRP) is among the files chosen — the prices come from it. Nothing was read.');
      const got: { role: string; name: string; bytes: Buffer }[] = (['ean', 'hsn', 'purchases'] as const).flatMap((k) => sorted[k].map((f, i) => ({ role: `${k}-${i + 1}`, name: f.name, bytes: f.bytes })));
      // The rates are taken as in force from the day they were read (the shop's day); never a day typed by hand.
      const ratesFrom = today();
      // MG-02: the day the old system's backup was restored on another PC and checked is a fact only a person knows — asked
      // ONCE, then remembered: an import that does not give it takes the day the newest import recorded.
      let backup = typeof b['backupRestoredOn'] === 'string' && b['backupRestoredOn'] !== '' ? b['backupRestoredOn'] : '';
      if (backup === '') {
        const list = await call('GET', '/v1/migration/old-system-imports');
        const newest = list.status === 200 ? ((list.body as { imports?: { backupRestoredOn?: string; recordedAt?: string }[] }).imports ?? []).filter((i) => typeof i.backupRestoredOn === 'string').sort((x, y) => String(y.recordedAt).localeCompare(String(x.recordedAt)))[0] : undefined;
        if (newest === undefined) throw new Said(400, 'First time only: give the day the old system\'s backup was restored on another PC and checked (MG-02). The page remembers it after this.');
        backup = newest.backupRestoredOn!;
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(backup)) throw new Said(400, 'The backup check day must be a date.');
      const purchaseRows = sorted.purchases.flatMap((f) => f.rows);
      const reading = readPurchaseReport(purchaseRows);
      const analysis = analyseOldSystem({ eanRows: sorted.ean.flatMap((f) => f.rows), hsnRows: sorted.hsn.flatMap((f) => f.rows), purchaseRows, today: today() });
      if (analysis.items.length === 0) throw new Said(422, 'No packaged-grocery item was found in the HSN report. Is it the HSN report (Item Id, Hsn Code, Gst %)?');
      const importId = `bpal-${nowIso().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}`;
      const dir = dirOf(importId);
      if (existsSync(dir)) throw new Said(409, 'An import was read this same second — wait a moment and read again.');
      mkdirSync(join(dir, 'files'), { recursive: true });
      for (const f of got) writeOnce(join(dir, 'files', `${f.role}-${f.name.replace(/[^A-Za-z0-9._ -]/g, '_')}`), f.bytes);
      const read: StoredRead = { importId, today: today(), ratesFrom, backupRestoredOn: backup, items: analysis.items };
      const readText = `${JSON.stringify(read)}\n`;
      writeOnce(join(dir, 'read.json'), readText);
      const r = await call('POST', `/v1/migration/old-system-imports/${encodeURIComponent(importId)}`, {
        source: 'bpal', readDigest: sha256(readText), items: analysis.items.length, ratesFrom, backupRestoredOn: backup,
        files: got.map((f) => ({ role: f.role, name: f.name, bytes: f.bytes.length, digest: sha256(f.bytes) })),
      }, `old-import-${importId}`);
      if (r.status !== 201 && r.status !== 200) said(r, 'Head office did not record the import (the files stay on this PC)');
      return { status: 201, json: { importId, items: analysis.items.length, files: { barcodes: sorted.ean.map((f) => f.name), hsn: sorted.hsn.map((f) => f.name), purchases: sorted.purchases.map((f) => f.name) }, purchaseFiles: sorted.purchases.length, purchaseRows: reading.rows, purchasesFrom: reading.oldest ?? null, purchasesTo: reading.newest ?? null, backupRestoredOn: backup } };
    }

    const im = /^\/api\/imports\/([A-Za-z0-9._-]+)(\/.*)?$/.exec(p);
    if (im === null) throw new Said(404, 'There is nothing at this address.');
    const importId = im[1]!;
    const rest = im[2] ?? '';

    if (m === 'GET' && rest === '') {
      const st = await standing(s, importId);
      return { json: { importId, record: st.record, summary: importSummary(st.resolved), items: st.resolved, loads: st.loads, finance: st.finance, fixes: st.fixes.length } };
    }

    if (m === 'POST' && rest === '/fix') {
      readOf(importId);
      const kind = typeof b['kind'] === 'string' ? b['kind'] : '';
      const path = `/v1/migration/old-system-imports/${encodeURIComponent(importId)}/${kind === 'tax' ? 'tax-fixes' : 'fixes'}`;
      const r = await call('POST', path, { itemId: b['itemId'], kind, value: b['value'], reason: b['reason'] }, `fix-${importId}-${String(b['itemId'])}-${kind}-${sha256(JSON.stringify(b['value']) + String(b['reason'])).slice(0, 16)}`);
      if (r.status === 403) {
        throw new Said(403, kind === 'tax'
          ? 'Not saved: an item\'s HSN and GST rate are a tax decision — only Finance (the accountant or the owner) can save it, signed in as themselves.'
          : 'Not saved: a barcode, a price, the label facts or leaving an item out is fixed by whoever runs the load (the owner or the store manager), signed in as themselves.');
      }
      if (r.status !== 201 && r.status !== 200) said(r, 'Not saved');
      return { status: 201, json: r.body };
    }

    if (m === 'GET' && rest.startsWith('/export/')) {
      const what = rest.slice('/export/'.length);
      const st = await standing(s, importId);
      const live = st.resolved.filter((r) => !r.excluded && !r.loaded);
      if (what === 'gaps.csv') {
        return { csv: { name: `${importId}-gaps.csv`, text: forExcel(csv(['item_code', 'description', 'sold_qty', 'gap', 'what_to_do'], live.flatMap((r) => r.gaps.map((g) => [r.itemId, r.name, String(r.sold), g.kind, g.why])))) } };
      }
      if (what === 'items.csv') {
        return { csv: { name: `${importId}-items.csv`, text: forExcel(csv(['item_code', 'description', 'sold_qty', 'status', 'barcodes', 'hsn', 'gst_percent', 'mrp', 'selling_price', 'cost', ...LABEL_FACTS],
          st.resolved.map((r) => [r.itemId, r.name, String(r.sold), r.loaded ? 'loaded' : r.excluded ? 'not in this department' : r.gaps.length === 0 ? 'ready' : `${r.gaps.length} gap(s)`,
            r.barcodes.join(' '), r.hsn ?? '', r.gstBps === undefined ? '' : String(r.gstBps / 100), r.price === undefined ? '' : paiseText(r.price.mrp), r.price === undefined ? '' : paiseText(r.price.sell), r.price === undefined ? '' : paiseText(r.price.cost),
            ...LABEL_FACTS.map((k) => r.facts[k] ?? '')]))) } };
      }
      throw new Said(404, 'There is no such export.');
    }

    if (m === 'POST' && rest === '/prepare') {
      // The ready items → the four files → sealed by the person preparing (their PIN again) → staged in their name.
      checkPin(s.userId, b['pin']);
      const signedInAt = nowIso();
      const st = await standing(s, importId);
      if (st.finance) throw new Said(403, 'Preparing a load is done by whoever runs the load (the owner or the store manager).');
      const ready = st.resolved.filter(isReady);
      if (ready.length === 0) throw new Said(422, 'No item is ready yet: every item still has a gap to fix.');
      const pending = st.loads.filter((l) => l.applied !== true);
      if (pending.length > 0) throw new Said(409, `Load ${pending[0]!.loadId} is prepared and not loaded yet. Finish it (accept, then load) before preparing another.`);
      const loadId = `${importId}-load-${st.loads.length + 1}`;
      const { dir, manifest } = loadPaths(importId, loadId);
      mkdirSync(dir, { recursive: true });
      const files = sliceFilesFor(ready, st.read.ratesFrom);
      for (const [f, text] of Object.entries(files)) writeOnce(join(dir, f), text);
      const base = { loadId, tenantId: deps.tenantId, operator: s.userId, storeId: deps.storeId, department: { categoryId: PILOT_CATEGORY_ID, name: PILOT_CATEGORY_NAME, regulated: ['food', 'packed'] }, files: {} };
      writeOnce(manifest, `${JSON.stringify(base, null, 2)}\n`);
      const sealed = await sealSlice({
        manifest: base, files, targetKind: deps.targetKind, demoTenantIds: deps.demoTenantIds, sealAs: s.userId, backupRestoredOn: st.read.backupRestoredOn,
        sourceId: 'bpal', client: { request: (r) => (r.userId === s.userId ? deps.client.request({ ...r, signedInAt }) : Promise.resolve({ status: 403, body: { error: { whatHappened: 'Only the person preparing seals.' } } })) },
        pin: { askPin: async () => String(b['pin']), verifyPin: deps.verifyPin }, fingerprint: (t) => sha256(t), today: today(), now: nowIso,
      });
      if (sealed.exitCode !== 0 || sealed.manifest === undefined) throw new Said(422, 'The files could not be sealed. Nothing was staged.', sealed.lines);
      write(manifest, `${JSON.stringify(sealed.manifest, null, 2)}\n`);
      const staged = await runSliceCommand({ mode: 'stage', manifest: sealed.manifest, files, targetKind: deps.targetKind, demoTenantIds: deps.demoTenantIds, client: commandClient(s, signedInAt), hasher: (t) => sha256(t) });
      if (staged.exceptionsCsv !== undefined) writeOnce(join(dir, 'exceptions.csv'), staged.exceptionsCsv);
      if (staged.exitCode !== 0) throw new Said(422, 'The load could not be staged. Nothing was loaded.', staged.lines);
      saveLoads(importId, [...st.loads, { loadId, itemIds: ready.map((r) => r.itemId), preparedBy: s.userId, preparedAt: nowIso() }]);
      return { status: 201, json: { loadId, items: ready.length, lines: [...sealed.lines, ...staged.lines] } };
    }

    const lm = /^\/loads\/([A-Za-z0-9._-]+)\/(accept|apply)$/.exec(rest);
    if (m === 'POST' && lm !== null) {
      const [, loadId, step] = lm as unknown as [string, string, 'accept' | 'apply'];
      const entry = loadsOf(importId).find((l) => l.loadId === loadId);
      if (entry === undefined) throw new Said(404, `Load ${loadId} is not on this computer.`);
      const { dir, manifest } = loadPaths(importId, loadId);
      const sealed = JSON.parse(readFileSync(manifest, 'utf8')) as unknown;
      checkPin(s.userId, b['pin']);
      const signedInAt = nowIso();
      if (step === 'accept') {
        if (entry.preparedBy === s.userId) throw new Said(403, `${s.userId} prepared this load, so ${s.userId} cannot accept it. A second person (the store manager or the owner) reads the list and accepts it, signed in as themselves.`);
        const statement = typeof b['statement'] === 'string' ? b['statement'].trim() : '';
        if (statement.length < 20) throw new Said(400, 'Say in a full sentence what you read and decided (for example "Read the 200 items and the 3 set aside; the prices match the old system").');
        const r = await runSliceCommand({ mode: 'accept', manifest: sealed, files: sliceFilesIn(dir), targetKind: deps.targetKind, demoTenantIds: deps.demoTenantIds, acceptAs: s.userId, statement, client: commandClient(s, signedInAt), hasher: (t) => sha256(t) });
        if (r.exitCode !== 0) throw new Said(422, 'Not accepted.', r.lines);
        return { json: { accepted: true, lines: r.lines } };
      }
      if (entry.preparedBy !== s.userId) throw new Said(403, `Load ${loadId} is loaded by the person who prepared it (${entry.preparedBy}), signed in as themselves.`);
      const r = await runSliceCommand({ mode: 'apply', manifest: sealed, files: sliceFilesIn(dir), targetKind: deps.targetKind, demoTenantIds: deps.demoTenantIds, client: commandClient(s, signedInAt), hasher: (t) => sha256(t) });
      if (r.exitCode !== 0) throw new Said(422, 'Not loaded.', r.lines);
      const loads = loadsOf(importId).map((l) => (l.loadId === loadId ? { ...l, applied: true } : l));
      saveLoads(importId, loads);
      return { json: { applied: true, lines: r.lines } };
    }

    if (m === 'GET' && /^\/loads\/[A-Za-z0-9._-]+\/exceptions\.csv$/.test(rest)) {
      const loadId = rest.split('/')[2]!;
      const { dir } = loadPaths(importId, loadId);
      const f = join(dir, 'exceptions.csv');
      return { csv: { name: `${loadId}-exceptions.csv`, text: existsSync(f) ? forExcel(readFileSync(f, 'utf8')) : '\uFEFFnothing was set aside\r\n' } };
    }

    throw new Said(404, 'There is nothing at this address.');
  }

  return async (req, res) => {
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        res.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'" });
        res.end(deps.pageHtml);
        return;
      }
      // A write must come from this page (same origin), never from another site the browser has open.
      if (req.method !== 'GET' && req.headers['x-sre-import'] !== '1') throw new Said(403, 'Refused: this request did not come from the import page.');
      const chunks: Buffer[] = []; let size = 0;
      for await (const c of req) { size += (c as Buffer).length; if (size > MAX_UPLOAD_BYTES) throw new Said(413, 'The files are too big together (over 96 MB).'); chunks.push(c as Buffer); }
      let body: unknown;
      if (chunks.length > 0) { try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Said(400, 'The request could not be read.'); } }
      const out = await route(req, url, body);
      const extra = out.cookie === undefined ? {} : { 'set-cookie': out.cookie };
      if (out.csv !== undefined) {
        res.writeHead(200, { ...headers, ...extra, 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${out.csv.name}"` });
        res.end(out.csv.text);
        return;
      }
      res.writeHead(out.status ?? 200, { ...headers, ...extra, 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(out.json ?? {}));
    } catch (e) {
      const status = e instanceof Said ? e.status : 500;
      const message = e instanceof Said ? e.message : `Something went wrong on this PC: ${e instanceof Error ? e.message : String(e)}. Nothing more was done — send a photo of this.`;
      res.writeHead(status, { ...headers, 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: message, lines: e instanceof Said ? e.lines : [] }));
    }
  };
}
