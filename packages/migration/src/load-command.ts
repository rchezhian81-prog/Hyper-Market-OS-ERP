// The operator's load, end to end and testable without a terminal: the six extract files, their
// manifest and the cleaning report go in; a plain-English outcome, an exit code and (when it ran) the
// load report come out. `scripts/migration-load.ts` is the thin shell that reads the folder, mints the
// operator's token and speaks HTTP; everything that can be wrong lives here, where a test can reach it.
//
// The order is the runbook's order, and each stage refuses on its own:
//   manifest → seal (MG-02: the bytes are the sealed bytes) → completeness (the row count read off the
//   screen) → cleaning (MG-04: no blocking exception undecided) → mapping (every unreadable row named) →
//   target (an empty, non-demo, non-production tenant the operator can read) → plan → dry run | load.
//
// Exit codes are for the person: 0 the load (or dry run) is done, 1 refused / not everything landed,
// 2 could not read what it was given.

import { parseDelimited } from '../../import/src/delimited';
import { verifyExtract, simpleHasher, type SealedExtract, type Hasher } from './discovery';
import { checkExportCompleteness } from './completeness';
import { outstandingExceptions, type MigrationException } from './cleaning';
import { bundleFromFiles, type CsvRows, type ExtractFiles } from './load-csv';
import { planLoad, executeLoad, type LoadPlan, type LoadReport, type LoadRequest } from './load';
import type { TargetKind } from './trial';

export const EXTRACT_FILES = ['products.csv', 'categories.csv', 'tax-rates.csv', 'suppliers.csv', 'customers.csv', 'opening-stock.csv'] as const;
export type ExtractFileName = (typeof EXTRACT_FILES)[number];

/** `manifest.json` in the extract folder — written by the person who sealed the files. */
export interface LoadManifest {
  readonly loadId: string;
  readonly tenantId: string;
  readonly operator: string;
  readonly stockLocationId: string;
  /** YYYY-MM-DD — the physical-count date the opening stock is true at. */
  readonly receivedOnDate: string;
  readonly currency?: string;
  /** One entry per file in the folder: the seal the seal route returned, and the row count read off the screen. */
  readonly files: Readonly<Record<string, { readonly seal: SealedExtract; readonly declaredRows?: number }>>;
}

/** GET + POST as the named operator — the test harness in-process, or the script over HTTP. */
export interface CommandClient {
  request(input: {
    readonly method: 'GET' | 'POST';
    readonly path: string;
    readonly userId: string;
    readonly tenantId: string;
    readonly body?: unknown;
    readonly idempotencyKey?: string;
  }): Promise<{ readonly status: number; readonly body: unknown }>;
}

export interface LoadCommandInput {
  /** `manifest.json`, parsed. */
  readonly manifest: unknown;
  /** The raw text of each file present in the folder. */
  readonly files: Readonly<Partial<Record<ExtractFileName, string>>>;
  /** `exceptions.json`, parsed — the cleaning report (MG-04) with the decisions written onto its exceptions. */
  readonly exceptions: unknown;
  /** `MIGRATION_TARGET_KIND` as the box has it; unset means the API's default, rehearsal. */
  readonly targetKind: string | undefined;
  readonly demoTenantIds: readonly string[];
  readonly dryRun: boolean;
  /** Absent only for a dry run without an API — then the target's emptiness is NOT checked and the outcome says so. */
  readonly client?: CommandClient;
  readonly hasher?: Hasher;
}

export type CommandStage = 'manifest' | 'seal' | 'completeness' | 'cleaning' | 'mapping' | 'target' | 'plan' | 'dry_run' | 'load';

export interface LoadCommandOutcome {
  readonly exitCode: 0 | 1 | 2;
  /** The stage the command ended at — the first one that refused, or the last one that ran. */
  readonly stage: CommandStage;
  readonly lines: readonly string[];
  readonly plan?: LoadPlan;
  readonly report?: LoadReport;
}

const TARGET_KINDS: readonly TargetKind[] = ['rehearsal', 'staging', 'local', 'production'];
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Read the manifest; every problem, not the first. */
export function readManifest(raw: unknown): { readonly manifest?: LoadManifest; readonly problems: readonly string[] } {
  const problems: string[] = [];
  if (!isObj(raw)) return { problems: ['manifest.json is not an object'] };
  for (const key of ['loadId', 'tenantId', 'operator', 'stockLocationId', 'receivedOnDate'] as const) {
    if (!isStr(raw[key])) problems.push(`manifest.json: "${key}" is required`);
  }
  if (isStr(raw['receivedOnDate']) && !/^\d{4}-\d{2}-\d{2}$/.test(raw['receivedOnDate'])) problems.push('manifest.json: "receivedOnDate" must be YYYY-MM-DD');
  if (raw['currency'] !== undefined && !isStr(raw['currency'])) problems.push('manifest.json: "currency" must be a code such as INR when given');
  const files = raw['files'];
  if (!isObj(files)) problems.push('manifest.json: "files" must map each file name to { seal, declaredRows? }');
  else {
    for (const [name, entry] of Object.entries(files)) {
      if (!(EXTRACT_FILES as readonly string[]).includes(name)) { problems.push(`manifest.json: "${name}" is not one of the six extract files (${EXTRACT_FILES.join(', ')})`); continue; }
      if (!isObj(entry) || !isObj(entry['seal'])) { problems.push(`manifest.json: "${name}" needs the seal the seal route returned`); continue; }
      const seal = entry['seal'];
      if (!isStr(seal['digest']) || typeof seal['rowCount'] !== 'number' || !isStr(seal['extractedBy']) || !isStr(seal['extractId'])) {
        problems.push(`manifest.json: "${name}" seal is missing extractId, digest, rowCount or extractedBy`);
      }
      if (entry['declaredRows'] !== undefined && (!Number.isInteger(entry['declaredRows']) || (entry['declaredRows'] as number) < 0)) {
        problems.push(`manifest.json: "${name}" declaredRows must be a whole number`);
      }
    }
    if (files['products.csv'] === undefined) problems.push('manifest.json: "products.csv" must be listed — a load with no products loads nothing');
  }
  if (problems.length > 0) return { problems };
  return { manifest: raw as unknown as LoadManifest, problems: [] };
}

/** Read `exceptions.json`: the cleaning route's report, or a bare list of exceptions. */
export function readExceptions(raw: unknown): { readonly exceptions?: readonly MigrationException[]; readonly problem?: string } {
  const list = Array.isArray(raw) ? raw : isObj(raw) && Array.isArray(raw['exceptions']) ? raw['exceptions'] : undefined;
  if (list === undefined) return { problem: 'exceptions.json is neither the cleaning report nor a list of exceptions' };
  for (const e of list) {
    if (!isObj(e) || !isStr(e['exceptionId']) || !isStr(e['severity']) || !isStr(e['kind'])) return { problem: 'exceptions.json: an entry is missing exceptionId, kind or severity' };
  }
  return { exceptions: list as MigrationException[] };
}

function csvRows(text: string): CsvRows {
  const parsed = parseDelimited(text, { header: true });
  return { headers: parsed.headers, rows: parsed.rows, lineNumbers: parsed.lineNumbers };
}

export async function runLoadCommand(input: LoadCommandInput): Promise<LoadCommandOutcome> {
  const lines: string[] = [];
  const say = (s: string): void => { lines.push(s); };
  const done = (exitCode: 0 | 1 | 2, stage: CommandStage, extra: { plan?: LoadPlan; report?: LoadReport } = {}): LoadCommandOutcome =>
    ({ exitCode, stage, lines, ...extra });
  const hasher = input.hasher ?? simpleHasher;

  // ── manifest ──────────────────────────────────────────────────────────────────────────────────
  const read = readManifest(input.manifest);
  if (read.manifest === undefined) {
    say('REFUSED — the manifest could not be read:');
    for (const p of read.problems) say(`  • ${p}`);
    return done(2, 'manifest');
  }
  const manifest = read.manifest;
  say(`Load "${manifest.loadId}" into tenant ${manifest.tenantId} by ${manifest.operator}; opening stock at ${manifest.stockLocationId} as of ${manifest.receivedOnDate}.`);

  // ── seal (MG-02) ──────────────────────────────────────────────────────────────────────────────
  const present = (Object.keys(input.files) as ExtractFileName[]).filter((f) => input.files[f] !== undefined);
  const unsealed = present.filter((f) => manifest.files[f] === undefined);
  if (unsealed.length > 0) {
    say(`REFUSED — file(s) in the folder that were never sealed: ${unsealed.join(', ')}. Every file that loads must have been sealed (MG-02); seal them or take them out.`);
    return done(1, 'seal');
  }
  const missing = Object.keys(manifest.files).filter((f) => input.files[f as ExtractFileName] === undefined);
  if (missing.length > 0) {
    say(`Could not read sealed file(s) named in the manifest: ${missing.join(', ')}.`);
    return done(2, 'manifest');
  }
  const parsed: Partial<Record<ExtractFileName, CsvRows>> = {};
  let sealBroken = false;
  for (const name of present) {
    const text = input.files[name]!;
    let rows: CsvRows;
    try { rows = csvRows(text); } catch (e) {
      say(`Could not read ${name}: ${e instanceof Error ? e.message : String(e)}`);
      return done(2, 'manifest');
    }
    parsed[name] = rows;
    const entry = manifest.files[name]!;
    const verdict = verifyExtract({ extract: entry.seal, material: text, rowCount: rows.rows.length, hasher });
    if (!verdict.matches || !verdict.rowCountMatches) {
      sealBroken = true;
      say(`SEAL BROKEN — ${name}: ${verdict.detail}`);
    } else {
      say(`Seal verified — ${name}: ${rows.rows.length} row(s), digest matches the seal taken by ${entry.seal.extractedBy}.`);
    }
  }
  if (sealBroken) {
    say('REFUSED — the bytes about to load are not the bytes that were sealed (MG-02). Nothing was sent. Re-export and re-seal, or find out what changed the file.');
    return done(1, 'seal');
  }

  // ── completeness (the row count read off the screen) ──────────────────────────────────────────
  for (const name of present) {
    const entry = manifest.files[name]!;
    const rows = parsed[name]!;
    const check = checkExportCompleteness({
      lines: input.files[name]!.split(/\r?\n/), rowsFound: rows.rows.length,
      ...(entry.declaredRows === undefined ? {} : { declaredRowCount: entry.declaredRows }),
    });
    if (check.truncated) {
      say(`REFUSED — ${name} is short: ${check.signals.filter((s) => s.available && !s.passed).map((s) => s.detail).join('; ')}. A truncated file loads perfectly and gives you a smaller shop.`);
      return done(1, 'completeness');
    }
    if (entry.declaredRows === undefined) say(`Not checked — ${name}: no row count from the screen in the manifest (declaredRows), so completeness rests on the seal alone.`);
  }

  // ── cleaning (MG-04) ──────────────────────────────────────────────────────────────────────────
  if (input.exceptions === undefined) {
    say('REFUSED — exceptions.json is missing: the cleaning step (MG-04) was not run, or its report was not put in the folder. Run the cleaning check, decide every blocking exception in writing, and put the report here.');
    return done(1, 'cleaning');
  }
  const exceptions = readExceptions(input.exceptions);
  if (exceptions.exceptions === undefined) {
    say(`Could not read exceptions.json: ${exceptions.problem}`);
    return done(2, 'cleaning');
  }
  const outstanding = outstandingExceptions(exceptions.exceptions);
  say(`Cleaning report: ${exceptions.exceptions.length} exception(s), ${outstanding.blockingUnresolved.length} blocking still undecided.`);

  // ── mapping (every unreadable row named) ──────────────────────────────────────────────────────
  const files: ExtractFiles = {
    products: parsed['products.csv']!,
    ...(parsed['categories.csv'] === undefined ? {} : { categories: parsed['categories.csv'] }),
    ...(parsed['tax-rates.csv'] === undefined ? {} : { taxRates: parsed['tax-rates.csv'] }),
    ...(parsed['suppliers.csv'] === undefined ? {} : { suppliers: parsed['suppliers.csv'] }),
    ...(parsed['customers.csv'] === undefined ? {} : { customers: parsed['customers.csv'] }),
    ...(parsed['opening-stock.csv'] === undefined ? {} : { openingStock: parsed['opening-stock.csv'] }),
  };
  const mapped = bundleFromFiles(files);
  if (mapped.problems.length > 0) {
    say(`REFUSED — ${mapped.problems.length} row(s) could not be read. Fix the file once, re-seal it, and run again:`);
    for (const p of mapped.problems) say(`  • ${p}`);
    return done(1, 'mapping');
  }
  say(`Read: ${mapped.bundle.products.length} products, ${mapped.bundle.categories.length} categories, ${mapped.bundle.taxRates.length} tax rates, ${mapped.bundle.suppliers.length} suppliers, ${mapped.bundle.customers.length} customers, ${mapped.bundle.openingStock.length} opening-stock lines.`);

  // ── target ────────────────────────────────────────────────────────────────────────────────────
  const kind = input.targetKind ?? 'rehearsal';
  if (!(TARGET_KINDS as readonly string[]).includes(kind)) {
    say(`REFUSED — MIGRATION_TARGET_KIND is "${kind}", not one of ${TARGET_KINDS.join(', ')}. A box whose kind cannot be read is not one to load into.`);
    return done(1, 'target');
  }
  let targetProductCount = 0;
  if (input.client === undefined) {
    if (!input.dryRun) {
      say('An API address is needed to load. Give --api, or add --dry-run to plan without one.');
      return done(2, 'target');
    }
    say('NOT CHECKED — whether the target tenant is empty (no API given to this dry run). The real run checks it.');
  } else {
    const probe = await input.client.request({ method: 'GET', path: '/v1/catalogue/products', userId: manifest.operator, tenantId: manifest.tenantId });
    if (probe.status === 401 || probe.status === 403) {
      say(`REFUSED — ${manifest.operator} cannot read tenant ${manifest.tenantId} (HTTP ${probe.status}): the token or the role is wrong. The operator must hold a role that reads the catalogue in THIS tenant (bootstrap the tenant first).`);
      return done(1, 'target');
    }
    if (probe.status !== 200) {
      say(`Could not reach the target (HTTP ${probe.status} on the catalogue read).`);
      return done(2, 'target');
    }
    // A target is "empty" when it holds nothing this extract does not name. Products that ARE in the
    // extract mean an earlier run of this same load stopped part-way (or completed): re-running sends
    // the same keys again and lands only what is missing. A product the extract does NOT name is
    // someone else's data, and the load is refused (target_not_empty).
    const held = ((probe.body as { products?: { productId?: unknown }[] }).products ?? []).map((p) => String(p.productId ?? ''));
    const inExtract = new Set(mapped.bundle.products.map((p) => p.productId));
    const foreign = held.filter((id) => !inExtract.has(id));
    targetProductCount = foreign.length;
    if (held.length === 0) say('Target tenant holds no products — a prepared, empty tenant.');
    else if (foreign.length === 0) say(`Target tenant holds ${held.length} product(s), every one named by this extract — an earlier run of this load; re-running sends only what is missing.`);
    else say(`Target tenant holds ${held.length} product(s), ${foreign.length} of them NOT in this extract (e.g. "${foreign[0]}").`);
  }

  // ── plan ──────────────────────────────────────────────────────────────────────────────────────
  const request: LoadRequest = {
    target: { targetId: `load-${manifest.loadId}`, tenantId: manifest.tenantId, kind: kind as TargetKind, label: `MIGRATION_TARGET_KIND=${kind}` },
    tenantId: manifest.tenantId, demoTenantIds: input.demoTenantIds, operator: manifest.operator, targetProductCount,
    extractSealed: true, blockingExceptionsOpen: outstanding.blockingUnresolved.length,
    loadId: manifest.loadId, stockLocationId: manifest.stockLocationId, receivedOnDate: manifest.receivedOnDate, currency: manifest.currency ?? 'INR',
  };
  const plan = planLoad(mapped.bundle, request);
  if (!plan.ok) {
    say(`REFUSED (${plan.refusedBecause}) — ${plan.detail}`);
    for (const p of plan.problems) say(`  • ${p}`);
    return done(1, 'plan', { plan });
  }
  const c = plan.counts;
  say(`Plan: ${plan.steps.length} step(s) — ${c.tax} tax rate(s), ${c.product} product(s), ${c.barcode} barcode(s), ${c.price} price(s), ${c.supplier} supplier(s), ${c.customer} customer step(s), ${c.stock} opening receipt.`);
  for (const w of plan.warnings) say(`  ! ${w}`);

  if (input.dryRun) {
    say('DRY RUN — nothing was sent. Run again without --dry-run to load.');
    return done(0, 'dry_run', { plan });
  }

  // ── load ──────────────────────────────────────────────────────────────────────────────────────
  const report = await executeLoad(input.client!, plan);
  const l = report.landed;
  say(`Landed: ${l.tax} tax rate(s), ${l.product} product(s), ${l.barcode} barcode(s), ${l.price} price(s), ${l.supplier} supplier(s), ${l.customer} customer step(s), ${l.stock} opening receipt.`);
  const failed = report.steps.filter((s) => !s.ok);
  if (failed.length > 0) {
    say(`${failed.length} step(s) did NOT land — each is a line to work through, then run the same load again (a re-run only sends what is missing):`);
    for (const f of failed) say(`  ✗ ${f.what} (HTTP ${f.status})${f.detail === undefined ? '' : `: ${f.detail}`}`);
    return done(1, 'load', { plan, report });
  }
  say(`LOADED — every step landed. Reconcile the target against the sealed extract next (MG-06), and sign nothing until the figures agree.`);
  return done(0, 'load', { plan, report });
}
