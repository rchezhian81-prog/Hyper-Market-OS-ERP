// The operator's department-slice load (OB-241 · MG-05 · MG-06 · §34.1), end to end and testable without a terminal.
// `scripts/migration-slice.ts` is the thin shell that reads the folder from disk (with a size limit far above the
// screen's 1 MB paste), mints the signed-in person's token and speaks HTTP; everything that can refuse lives here.
//
// Three modes, run by named people in this order:
//
//   stage   the operator: target guard (never production, never the demo tenant) → seals (MG-02) → per-row staging
//           (good rows staged, bad rows quarantined with their reasons) → the LOAD RECORD on the cloud, kept under the
//           operator's own session. Prints the exception list and the digest the acceptor must accept.
//   accept  a named person (in their own session) reads that list and accepts it by its digest.
//   apply   the operator again: re-stages the same files (they must give the SAME digest), reads the load record from
//           the cloud — the operator is the record's, not a typed name — refuses unless the exception list is accepted,
//           checks the cleaning register and the empty target, then loads the STAGED rows only through the same routes
//           a person uses, and records what landed.
//
// Exit codes: 0 done, 1 refused / not everything landed, 2 could not read what it was given.

import { verifyExtract, simpleHasher, type Hasher, type SealedExtract } from './discovery';
import { outstandingExceptions } from './cleaning';
import { readExceptions, type CommandClient } from './load-command';
import { planLoad, executeLoad, type LoadPlan, type LoadReport } from './load';
import { assertNonProduction, type TargetKind } from './trial';
import {
  stageSlice, sliceApplyGate, sliceExceptionsCsv, SLICE_FILES,
  type SliceAcceptance, type SliceDepartment, type SliceFile, type StagedSlice,
} from './slice-import';
import type { RegulatedKind } from '../../product/src/product';

/** `slice.json` in the folder — written by the person who sealed the files. */
export interface SliceManifest {
  readonly loadId: string;
  readonly tenantId: string;
  /** The login the command signs in as. The cloud records whoever that session is — never this field — as the operator. */
  readonly operator: string;
  /** The store whose tills the prices are for. */
  readonly storeId: string;
  readonly currency?: string;
  readonly department: SliceDepartment;
  readonly files: Readonly<Partial<Record<SliceFile, { readonly seal: SealedExtract; readonly declaredRows?: number }>>>;
}

export type SliceMode = 'stage' | 'accept' | 'apply';
export type SliceStage = 'manifest' | 'target' | 'seal' | 'staging' | 'record' | 'acceptance' | 'cleaning' | 'plan' | 'load' | 'done';

export interface SliceCommandInput {
  readonly mode: SliceMode;
  readonly manifest: unknown;
  readonly files: Readonly<Partial<Record<SliceFile, string>>>;
  /** `MIGRATION_TARGET_KIND` as the box has it; unset means rehearsal (the API's own default). */
  readonly targetKind: string | undefined;
  readonly demoTenantIds: readonly string[];
  /** Accept mode: who is accepting (their own session) and what they read. */
  readonly acceptAs?: string;
  readonly statement?: string;
  readonly client?: CommandClient;
  /** The slice digest's hasher (the CLI passes SHA-256). The seals are checked with the seal route's own hasher. */
  readonly hasher?: Hasher;
}

export interface SliceCommandOutcome {
  readonly exitCode: 0 | 1 | 2;
  readonly stage: SliceStage;
  readonly lines: readonly string[];
  readonly staged?: StagedSlice;
  /** The exception list as CSV — the file the acceptor reads. */
  readonly exceptionsCsv?: string;
  readonly plan?: LoadPlan;
  readonly report?: LoadReport;
}

const TARGET_KINDS: readonly TargetKind[] = ['rehearsal', 'staging', 'local', 'production'];
const REGULATED: readonly RegulatedKind[] = ['food', 'packed', 'weighed', 'age_restricted', 'drug', 'hazardous'];
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

export function readSliceManifest(raw: unknown): { readonly manifest?: SliceManifest; readonly problems: readonly string[] } {
  const problems: string[] = [];
  if (!isObj(raw)) return { problems: ['slice.json is not an object'] };
  for (const key of ['loadId', 'tenantId', 'operator', 'storeId'] as const) if (!isStr(raw[key])) problems.push(`slice.json: "${key}" is required`);
  if (isStr(raw['loadId']) && !/^[A-Za-z0-9._-]{1,80}$/.test(raw['loadId'])) problems.push('slice.json: "loadId" may hold only letters, digits, dot, dash and underscore');
  const d = raw['department'];
  if (!isObj(d) || !isStr(d['categoryId']) || !isStr(d['name'])) problems.push('slice.json: "department" must be { categoryId, name, regulated? } — the ONE pilot department (OB-241)');
  else if (d['regulated'] !== undefined && !(Array.isArray(d['regulated']) && d['regulated'].every((r) => (REGULATED as readonly string[]).includes(r as string)))) {
    problems.push(`slice.json: "department.regulated" must be a list of ${REGULATED.join(', ')}`);
  }
  const files = raw['files'];
  if (!isObj(files)) problems.push('slice.json: "files" must map each file name to { seal, declaredRows? }');
  else {
    for (const [name, entry] of Object.entries(files)) {
      if (!(SLICE_FILES as readonly string[]).includes(name)) { problems.push(`slice.json: "${name}" is not a slice file (${SLICE_FILES.join(', ')})`); continue; }
      if (!isObj(entry) || !isObj(entry['seal']) || !isStr(entry['seal']['digest']) || typeof entry['seal']['rowCount'] !== 'number') problems.push(`slice.json: "${name}" needs the seal the seal route returned`);
    }
  }
  if (problems.length > 0) return { problems };
  return { manifest: raw as unknown as SliceManifest, problems: [] };
}

export async function runSliceCommand(input: SliceCommandInput): Promise<SliceCommandOutcome> {
  const lines: string[] = [];
  const say = (s: string): void => { lines.push(s); };
  const done = (exitCode: 0 | 1 | 2, stage: SliceStage, extra: Partial<SliceCommandOutcome> = {}): SliceCommandOutcome => ({ exitCode, stage, lines, ...extra });
  const hasher = input.hasher ?? simpleHasher;

  // ── manifest ──────────────────────────────────────────────────────────────────────────────────
  const read = readSliceManifest(input.manifest);
  if (read.manifest === undefined) {
    say('REFUSED — slice.json could not be read:');
    for (const p of read.problems) say(`  • ${p}`);
    return done(2, 'manifest');
  }
  const m = read.manifest;

  // ── target: never production, never the demo (hard rule #7 · gate G4) — before a single row is read ──────────
  const kind = input.targetKind ?? 'rehearsal';
  if (!(TARGET_KINDS as readonly string[]).includes(kind)) {
    say(`REFUSED — MIGRATION_TARGET_KIND is "${kind}", not one of ${TARGET_KINDS.join(', ')}. A box whose kind cannot be read is not one to load into.`);
    return done(1, 'target');
  }
  const target = { targetId: `slice-${m.loadId}`, tenantId: m.tenantId, kind: kind as TargetKind, label: `MIGRATION_TARGET_KIND=${kind}` };
  const guard = assertNonProduction(target);
  if (!guard.permitted) { say(`REFUSED (production_target) — ${guard.detail}. You are on the wrong machine. Stop.`); return done(1, 'target'); }
  if (input.demoTenantIds.includes(m.tenantId)) {
    say(`REFUSED (demo_tenant) — tenant "${m.tenantId}" is a demo tenant. Real data never goes into it (pilot gate G4). Use the real tenant the bootstrap created on the store computer.`);
    return done(1, 'target');
  }
  say(`Slice "${m.loadId}" — department ${m.department.categoryId} (${m.department.name}) into tenant ${m.tenantId}, prices for store ${m.storeId}.`);

  // ── accept: a named person, in their own session, accepts the list as the cloud holds it ─────────────
  if (input.mode === 'accept') {
    if (input.client === undefined) { say('An API address is needed to accept an exception list. Give --api.'); return done(2, 'acceptance'); }
    if (!isStr(input.acceptAs) || !isStr(input.statement)) { say('REFUSED — say who is accepting (--as <login>) and what you read (--statement "…").'); return done(2, 'acceptance'); }
    const got = await input.client.request({ method: 'GET', path: `/v1/migration/loads/${encodeURIComponent(m.loadId)}`, userId: input.acceptAs, tenantId: m.tenantId });
    if (got.status !== 200) { say(`REFUSED — cannot read load ${m.loadId} as ${input.acceptAs} (HTTP ${got.status}). Stage it first, or check the role.`); return done(1, 'acceptance'); }
    const view = got.body as { record: { sliceDigest: string; operator: string; exceptions: unknown[] } };
    say(`Load ${m.loadId}: staged by ${view.record.operator}, ${view.record.exceptions.length} quarantined row(s), digest ${view.record.sliceDigest}.`);
    const res = await input.client.request({
      method: 'POST', path: `/v1/migration/loads/${encodeURIComponent(m.loadId)}/exception-list/acceptance`, userId: input.acceptAs, tenantId: m.tenantId,
      body: { sliceDigest: view.record.sliceDigest, statement: input.statement }, idempotencyKey: `${m.loadId}-accept-${view.record.sliceDigest}`,
    });
    if (res.status !== 200 && res.status !== 201) {
      const why = (res.body as { error?: { whatHappened?: string } } | undefined)?.error?.whatHappened ?? `HTTP ${res.status}`;
      say(`REFUSED — the acceptance was not recorded: ${why}`);
      return done(1, 'acceptance');
    }
    const a = (res.body as { acceptance: SliceAcceptance }).acceptance;
    say(`ACCEPTED — ${a.acceptedBy} accepted ${a.quarantined} quarantined row(s) for load ${m.loadId} on ${a.acceptedAt}. The operator may now apply it.`);
    return done(0, 'done');
  }

  // ── seals (MG-02): the bytes about to stage are the bytes that were sealed ──────────────────────────
  const present = SLICE_FILES.filter((f) => input.files[f] !== undefined);
  const unsealed = present.filter((f) => m.files[f] === undefined);
  if (unsealed.length > 0) { say(`REFUSED — file(s) in the folder that were never sealed: ${unsealed.join(', ')}. Seal them (MG-02) or take them out.`); return done(1, 'seal'); }
  const missing = (Object.keys(m.files) as SliceFile[]).filter((f) => input.files[f] === undefined);
  if (missing.length > 0) { say(`Could not read sealed file(s) named in slice.json: ${missing.join(', ')}.`); return done(2, 'manifest'); }
  let broken = false;
  for (const f of present) {
    const text = input.files[f]!;
    const dataLines = text.replace(/^\uFEFF/, '').split(/\r?\n/).slice(1).filter((l) => l.trim() !== '').length;
    const entry = m.files[f]!;
    // The seal route seals with `simpleHasher`, so the seal is checked with it; the slice digest uses `hasher`.
    const verdict = verifyExtract({ extract: entry.seal, material: text, rowCount: dataLines, hasher: simpleHasher });
    if (!verdict.matches || !verdict.rowCountMatches) { broken = true; say(`SEAL BROKEN — ${f}: ${verdict.detail}`); continue; }
    if (entry.declaredRows !== undefined && entry.declaredRows !== dataLines) { broken = true; say(`SHORT — ${f} has ${dataLines} row(s) but ${entry.declaredRows} were read off the old ERP's screen. A cut export loads perfectly and gives you a smaller department.`); continue; }
    say(`Seal verified — ${f}: ${dataLines} row(s).`);
  }
  if (broken) { say('REFUSED — nothing was staged. Re-export and re-seal, or find out what changed the file.'); return done(1, 'seal'); }

  // ── staging: every row on its own ───────────────────────────────────────────────────────────────
  const staged = stageSlice({ department: m.department, files: input.files, hasher });
  const exceptionsCsv = sliceExceptionsCsv(staged);
  if (staged.headerProblems.length > 0) {
    say('REFUSED — the files do not follow the published templates (download them with --templates):');
    for (const p of staged.headerProblems) say(`  • ${p}`);
    return done(1, 'staging', { staged, exceptionsCsv });
  }
  for (const f of SLICE_FILES) {
    const c = staged.counts[f];
    if (c.rows > 0 || input.files[f] !== undefined) say(`  ${f}: ${c.rows} row(s) read, ${c.staged} staged, ${c.quarantined} quarantined.`);
  }
  say(`Staged: ${staged.bundle.products.length} product(s), ${staged.bundle.taxRates.length} tax rate(s), ${staged.bundle.products.reduce((n, p) => n + p.barcodes.length, 0)} barcode(s). Quarantined: ${staged.exceptions.length} row(s). Digest ${staged.digest}.`);
  for (const e of staged.exceptions.slice(0, 50)) say(`  ✗ ${e.file} line ${e.line}${e.sourceKey === '' ? '' : ` (${e.sourceKey})`}: ${e.reason}`);
  if (staged.exceptions.length > 50) say(`  … and ${staged.exceptions.length - 50} more — every one is in the exception list file.`);

  if (input.client === undefined) {
    say(input.mode === 'stage'
      ? 'NOT RECORDED — no API given, so the cloud holds no load record and nobody can accept this list. Run again with --api to record it.'
      : 'An API address is needed to apply. Give --api.');
    return done(input.mode === 'stage' ? 0 : 2, 'record', { staged, exceptionsCsv });
  }
  const client = input.client;
  const loadPath = `/v1/migration/loads/${encodeURIComponent(m.loadId)}`;

  if (input.mode === 'stage') {
    const res = await client.request({
      method: 'POST', path: loadPath, userId: m.operator, tenantId: m.tenantId, idempotencyKey: `${m.loadId}-stage-${staged.digest}`,
      body: { sliceDigest: staged.digest, department: { categoryId: m.department.categoryId, name: m.department.name }, counts: staged.counts, exceptions: staged.exceptions },
    });
    if (res.status !== 200 && res.status !== 201) {
      const why = (res.body as { error?: { whatHappened?: string } } | undefined)?.error?.whatHappened ?? `HTTP ${res.status}`;
      say(`REFUSED — the cloud did not keep the load record: ${why}`);
      return done(1, 'record', { staged, exceptionsCsv });
    }
    const rec = (res.body as { record: { operator: string } }).record;
    say(`RECORDED — load ${m.loadId} is staged on the cloud by ${rec.operator} (the person signed in — that is who ran this load).`);
    say(`NEXT — a named person reads the exception list and accepts it: pnpm run migration:slice -- --dir <folder> --accept --as <their login> --statement "…". Nothing is applied before that.`);
    return done(0, 'record', { staged, exceptionsCsv });
  }

  // ── apply ───────────────────────────────────────────────────────────────────────────────────────
  const got = await client.request({ method: 'GET', path: loadPath, userId: m.operator, tenantId: m.tenantId });
  if (got.status !== 200) { say(`REFUSED — the cloud holds no load record for ${m.loadId} readable by ${m.operator} (HTTP ${got.status}). Stage it first.`); return done(1, 'record', { staged, exceptionsCsv }); }
  const view = got.body as { record: { operator: string; sliceDigest: string }; acceptance?: SliceAcceptance; applied?: unknown };
  // The operator is the STORED record's — the person signed in when the load was staged.
  const operator = view.record.operator;
  if (view.record.sliceDigest !== staged.digest) {
    say(`REFUSED — the files in the folder give digest ${staged.digest}, but the cloud's record is ${view.record.sliceDigest}: they changed after staging. Stage again, and have the new list accepted.`);
    return done(1, 'acceptance', { staged, exceptionsCsv });
  }
  const gate = sliceApplyGate(staged, view.acceptance);
  if (!gate.open) { say(`REFUSED (${gate.refusedBecause}) — ${gate.detail}. Nothing was sent.`); return done(1, 'acceptance', { staged, exceptionsCsv }); }
  say(`Accepted — ${gate.detail}. Operator from the load record: ${operator}.`);

  // MG-04: the cleaning register still governs — a blocking exception undecided there stops the load.
  const reg = await client.request({ method: 'GET', path: '/v1/migration/exceptions', userId: operator, tenantId: m.tenantId });
  if (reg.status !== 200) { say(`REFUSED — cannot read the cloud's cleaning register as ${operator} (HTTP ${reg.status}).`); return done(1, 'cleaning', { staged, exceptionsCsv }); }
  const regRead = readExceptions(reg.body);
  if (regRead.exceptions === undefined) { say(`Could not read the cloud's cleaning register: ${regRead.problem}`); return done(2, 'cleaning', { staged, exceptionsCsv }); }
  const blocking = outstandingExceptions(regRead.exceptions).blockingUnresolved.length;
  say(`Cleaning register: ${regRead.exceptions.length} exception(s), ${blocking} blocking still undecided.`);

  const probe = await client.request({ method: 'GET', path: '/v1/catalogue/products', userId: operator, tenantId: m.tenantId });
  if (probe.status !== 200) { say(`REFUSED — ${operator} cannot read tenant ${m.tenantId}'s catalogue (HTTP ${probe.status}).`); return done(1, 'plan', { staged, exceptionsCsv }); }
  const held = ((probe.body as { products?: { productId?: unknown }[] }).products ?? []).map((p) => String(p.productId ?? ''));
  const ours = new Set(staged.bundle.products.map((p) => p.productId));
  const foreign = held.filter((id) => !ours.has(id));

  const plan = planLoad(staged.bundle, {
    target, tenantId: m.tenantId, demoTenantIds: input.demoTenantIds, operator, targetProductCount: foreign.length,
    extractSealed: true, blockingExceptionsOpen: blocking, loadId: m.loadId, stockLocationId: m.storeId,
    // A slice carries no opening stock, so no count date applies; the plan's expiry check has nothing to read.
    receivedOnDate: '1970-01-01', currency: m.currency ?? 'INR',
  });
  if (!plan.ok) {
    say(`REFUSED (${plan.refusedBecause}) — ${plan.detail}`);
    for (const p of plan.problems) say(`  • ${p}`);
    return done(1, 'plan', { staged, exceptionsCsv, plan });
  }
  const c = plan.counts;
  say(`Plan: ${c.tax} tax rate(s), ${c.product} product(s), ${c.barcode} barcode(s), ${c.price} price(s). No stock, suppliers or customers — stock arrives by goods receipt.`);
  const report = await executeLoad(client, plan);
  const failed = report.steps.filter((s) => !s.ok);
  const rec = await client.request({
    method: 'POST', path: `${loadPath}/applied`, userId: operator, tenantId: m.tenantId, idempotencyKey: `${m.loadId}-applied-${staged.digest}-${failed.length}`,
    body: { sliceDigest: staged.digest, landed: report.landed, failedSteps: failed.length },
  });
  const l = report.landed;
  say(`Landed: ${l.tax} tax rate(s), ${l.product} product(s), ${l.barcode} barcode(s), ${l.price} price(s).`);
  if (rec.status !== 201 && rec.status !== 200) say(`! The cloud did not keep the "applied" record (HTTP ${rec.status}) — say so to the owner; the load itself is in the ledger.`);
  if (failed.length > 0) {
    say(`${failed.length} step(s) did NOT land — each is a line to work through, then run --apply again (it sends only what is missing):`);
    for (const f of failed) say(`  ✗ ${f.what} (HTTP ${f.status})${f.detail === undefined ? '' : `: ${f.detail}`}`);
    return done(1, 'load', { staged, exceptionsCsv, plan, report });
  }
  say(`APPLIED — every staged row landed; ${staged.exceptions.length} quarantined row(s) stayed behind, accepted by ${view.acceptance!.acceptedBy}. Reconcile next (MG-06): the signer must not be ${operator}.`);
  return done(0, 'done', { staged, exceptionsCsv, plan, report });
}
