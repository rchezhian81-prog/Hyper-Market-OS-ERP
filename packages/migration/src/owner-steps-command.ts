// Two owner steps that had no command — audit row 8 (lane B MG2 and MG10b), both P1 for the first real load:
//
//   • SEAL the old ERP's exported files (MG-02, §34.1 "immutable raw extract manifest with hash"). Until now the only way
//     was a hand-made POST /v1/migration/extracts/<id>/seal with the whole CSV as a JSON string and a hand-minted token.
//     `sealSlice` reads each slice file in the folder, asks the EXISTING seal route — as the signed-in operator, in the
//     slice's tenant — to seal it, and returns slice.json with every seal in it. The route itself refuses an extract with
//     no verified backup restore of the old ERP, an empty one, or one with nobody's name on it (MG-02); this command adds
//     no rule of its own beyond refusing to replace a seal that is already there (a seal is evidence, hard rule #6).
//   • WRITE THE PARALLEL-RUN POLICY (MG-10, R-05): who reconciles every day, how many clean days, the longest the run may
//     last, the first day. Until now only PUT /v1/migration/parallel-run/policy could. `writeParallelPolicy` sends exactly
//     that, as the signed-in person (the route allows only `migration.cutover.decide` — the owner's role). The numbers are
//     the owner's to choose; nothing here defaults them.
//
// Both ask for the acting person's OWN till PIN, checked on this PC, before any call is made — the same check the owner
// setup commands make (OB-257 · OB-267, `runOwnerSetup` below): no PIN, a wrong one, or none issued, and nothing is
// called, so the shell never mints that person's token without it.
//
// Pure: the HTTP client, the PIN question and the PIN check are injected (scripts/migration-slice.ts mints the person's
// short-lived token, after their PIN matched), so tests drive it with a stand-in API. Never against production (hard
// rule #7), never into the demo tenant (gate G4).

import { assertNonProduction, type TargetKind } from './trial';
import { SLICE_FILES, type SliceFile } from './slice-import';
import { readSliceManifest, type SliceManifest } from './slice-command';
import type { SealedExtract } from './discovery';

export interface OwnerStepOutcome {
  readonly exitCode: 0 | 1 | 2;
  readonly lines: readonly string[];
  /** Seal: slice.json as it must now be written (every seal added). Absent when nothing new was sealed. */
  readonly manifest?: SliceManifest;
}

const TARGET_KINDS: readonly TargetKind[] = ['rehearsal', 'staging', 'local', 'production'];
const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const errorOf = (body: unknown, status: number): string => {
  const e = (body as { error?: { code?: string; whatHappened?: string } } | undefined)?.error;
  return e?.whatHappened !== undefined ? `${e.code ?? `HTTP ${status}`} — ${e.whatHappened}` : `HTTP ${status}`;
};

/** The same refusals the slice command makes before it reads a row: a known kind, never production, never the demo. */
function targetRefusal(kind: string | undefined, tenantId: string, demoTenantIds: readonly string[], label: string): string | undefined {
  const k = kind ?? 'rehearsal';
  if (!(TARGET_KINDS as readonly string[]).includes(k)) return `REFUSED — MIGRATION_TARGET_KIND is "${k}", not one of ${TARGET_KINDS.join(', ')}.`;
  const guard = assertNonProduction({ targetId: label, tenantId, kind: k as TargetKind, label: `MIGRATION_TARGET_KIND=${k}` });
  if (!guard.permitted) return `REFUSED (production_target) — ${guard.detail}. You are on the wrong machine. Stop.`;
  if (demoTenantIds.includes(tenantId)) return `REFUSED (demo_tenant) — tenant "${tenantId}" is a demo tenant. Real data never goes into it (pilot gate G4).`;
  return undefined;
}

/** The data rows in a slice file: every non-empty line after the header — the count the slice's seal check uses. */
export const dataRowsOf = (text: string): number => text.replace(/^\uFEFF/, '').split(/\r?\n/).slice(1).filter((l) => l.trim() !== '').length;

/**
 * OB-257 · OB-267: the acting person's own till PIN, asked at THIS keyboard and checked on this PC before any call. Both
 * owner steps and every owner setup command use it; there is no way to run one without it.
 */
export interface OwnerPin {
  /** Ask THIS person for their own till PIN, hidden. Undefined when nothing was typed (or there is no keyboard). */
  readonly askPin: (userId: string) => Promise<string | undefined>;
  readonly verifyPin: (userId: string, pin: string) => PinVerdict;
}

/** Ask one person for their PIN and check it. `ok` carries when it matched (the token's step-up time). */
async function pinChecked(who: string, pin: OwnerPin, now: () => string, say: (s: string) => void): Promise<{ readonly ok: true; readonly signedInAt: string } | { readonly ok: false; readonly exitCode: 1 | 2 }> {
  say(`${who}: type YOUR OWN till PIN now (six digits; nothing shows while you type). Only ${who} types it.`);
  const typed = await pin.askPin(who);
  if (typed === undefined || typed === '') { say(`NOT DONE — no PIN was typed for ${who}. Nothing was done.`); return { ok: false, exitCode: 1 }; }
  const verdict = pin.verifyPin(who, typed);
  if (verdict === 'cannot_check') { say('REFUSED — this PC cannot check till PINs yet (the till is not installed, or its settings cannot be read). Install the till first (owner guide Part 13). Nothing was done.'); return { ok: false, exitCode: 2 }; }
  if (verdict === 'no_pin_issued') { say(`REFUSED — ${who} has no till PIN on this computer. Make one first, with ${who} there: pnpm run till:pin -- --user ${who} --by "<your name>". Nothing was done.`); return { ok: false, exitCode: 1 }; }
  if (verdict !== 'ok') { say(`REFUSED — that is not ${who}'s till PIN. Nothing was done.`); return { ok: false, exitCode: 1 }; }
  say(`  ${who}'s PIN matches.`);
  return { ok: true, signedInAt: now() };
}

export interface SealSliceInput {
  readonly manifest: unknown;
  readonly files: Readonly<Partial<Record<SliceFile, string>>>;
  readonly targetKind: string | undefined;
  readonly demoTenantIds: readonly string[];
  /** Who is sealing: their own session. The route stamps the seal with this person (MG-02 "who took it"). */
  readonly sealAs?: string;
  /** The day the old ERP's own backup was restored and checked (MG-02 refuses a seal without it). YYYY-MM-DD. */
  readonly backupRestoredOn?: string;
  /** Which legacy source the files came from, as named in the discovery inventory. */
  readonly sourceId?: string;
  /** Called only after the sealer's PIN matched; each request carries when (`signedInAt`). */
  readonly client?: SetupClient;
  /** OB-257: the sealer's own till PIN, before any call. */
  readonly pin: OwnerPin;
  /** A short content fingerprint for the idempotency key (SHA-256 in the shell). */
  readonly fingerprint: (text: string) => string;
  readonly today: string;
  readonly now: () => string;
  /** Each line, as it is said (the PIN question comes between them). */
  readonly say?: (line: string) => void;
}

/** Seal every slice file in the folder through the seal route. A file already sealed is never sealed again. */
export async function sealSlice(input: SealSliceInput): Promise<OwnerStepOutcome> {
  const lines: string[] = [];
  const say = (s: string): void => { lines.push(s); input.say?.(s); };
  const read = readSliceManifest(input.manifest);
  if (read.manifest === undefined) { say('REFUSED — slice.json could not be read:'); for (const p of read.problems) say(`  • ${p}`); return { exitCode: 2, lines }; }
  const m = read.manifest;
  const refused = targetRefusal(input.targetKind, m.tenantId, input.demoTenantIds, `seal-${m.loadId}`);
  if (refused !== undefined) { say(refused); return { exitCode: 1, lines }; }
  if (input.sealAs === undefined || input.sealAs.trim() === '') { say('REFUSED — say who is sealing, in their own name: --as <login>.'); return { exitCode: 2, lines }; }
  if (!isDate(input.backupRestoredOn)) { say('REFUSED — say the day the old ERP\'s backup was restored and checked (MG-02): --backup-restored-on YYYY-MM-DD. A backup job that said "success" is not enough: it must have been restored.'); return { exitCode: 2, lines }; }
  if (input.backupRestoredOn > input.today) { say(`REFUSED — --backup-restored-on ${input.backupRestoredOn} is after today (${input.today}).`); return { exitCode: 2, lines }; }
  if (input.client === undefined) { say('An API address is needed to seal. Give --api.'); return { exitCode: 2, lines }; }
  const present = SLICE_FILES.filter((f) => input.files[f] !== undefined);
  if (present.length === 0) { say(`REFUSED — the folder holds none of the slice files (${SLICE_FILES.join(', ')}). Put the old ERP's exported files there first.`); return { exitCode: 2, lines }; }

  // OB-257: the sealer's own PIN, before any call — so no token of theirs is ever made without it.
  const signedIn = await pinChecked(input.sealAs, input.pin, input.now, say);
  if (!signedIn.ok) return { exitCode: signedIn.exitCode, lines };

  const sourceId = input.sourceId !== undefined && input.sourceId.trim() !== '' ? input.sourceId.trim() : 'old-erp';
  const files: Record<string, { seal: SealedExtract; declaredRows?: number }> = { ...(m.files as Record<string, { seal: SealedExtract; declaredRows?: number }>) };
  let sealed = 0;
  let failed = 0;
  for (const f of present) {
    if (files[f] !== undefined) { say(`kept — ${f} is already sealed (${files[f]!.seal.rowCount} row(s), digest ${files[f]!.seal.digest}). A seal is never replaced.`); continue; }
    const text = input.files[f]!;
    const rowCount = dataRowsOf(text);
    const extractId = `${m.loadId}-${f.replace(/\.csv$/, '')}`;
    const res = await input.client.request({
      method: 'POST', path: `/v1/migration/extracts/${encodeURIComponent(extractId)}/seal`, userId: input.sealAs, tenantId: m.tenantId,
      body: { sourceId, material: text, rowCount, extractedBy: input.sealAs, backupVerifiedAt: input.backupRestoredOn },
      idempotencyKey: `${extractId}-seal-${input.fingerprint(text).slice(0, 16)}`, signedInAt: signedIn.signedInAt,
    });
    if (res.status !== 200) { failed += 1; say(`NOT SEALED — ${f}: ${errorOf(res.body, res.status)}`); continue; }
    const seal = res.body as SealedExtract;
    files[f] = { seal };
    sealed += 1;
    say(`SEALED — ${f}: ${seal.rowCount} row(s), digest ${seal.digest}, by ${seal.extractedBy} at ${seal.extractedAt}.`);
  }
  if (sealed === 0) { say(failed > 0 ? 'Nothing new was sealed. slice.json is unchanged.' : 'Every file was already sealed. slice.json is unchanged.'); return { exitCode: failed > 0 ? 1 : 0, lines }; }
  say(failed > 0 ? `${sealed} file(s) sealed, ${failed} not. Fix the one(s) named above and run this again — the sealed ones are kept.` : `All ${present.length} file(s) are sealed. Next: stage the slice (--stage).`);
  return { exitCode: failed > 0 ? 1 : 0, lines, manifest: { ...m, files } };
}

export interface ParallelPolicyInput {
  readonly tenantId: string;
  readonly targetKind: string | undefined;
  readonly demoTenantIds: readonly string[];
  /** Who is writing it: the owner, in his own session (the route needs migration.cutover.decide). */
  readonly as?: string;
  readonly cutoverId?: string;
  readonly reconcilerUserId?: string;
  readonly requiredCleanDays?: number;
  readonly maxParallelDays?: number;
  readonly startedOn?: string;
  /** Called only after the owner's PIN matched; each request carries when (`signedInAt`). */
  readonly client?: SetupClient;
  /** OB-257: the owner's own till PIN, before any call. */
  readonly pin: OwnerPin;
  readonly now: () => string;
  /** Each line, as it is said (the PIN question comes between them). */
  readonly say?: (line: string) => void;
}

/** Write the parallel-run policy through PUT /v1/migration/parallel-run/policy. Every value comes from the owner. */
export async function writeParallelPolicy(input: ParallelPolicyInput): Promise<OwnerStepOutcome> {
  const lines: string[] = [];
  const say = (s: string): void => { lines.push(s); input.say?.(s); };
  const refused = targetRefusal(input.targetKind, input.tenantId, input.demoTenantIds, 'parallel-policy');
  if (refused !== undefined) { say(refused); return { exitCode: 1, lines }; }
  const missing: string[] = [];
  if (input.as === undefined || input.as.trim() === '') missing.push('--as <your login>');
  if (input.cutoverId === undefined || input.cutoverId.trim() === '') missing.push('--cutover <the cutover id>');
  if (input.reconcilerUserId === undefined || input.reconcilerUserId.trim() === '') missing.push('--reconciler <the ONE person who reconciles each day>');
  if (!Number.isInteger(input.requiredCleanDays) || (input.requiredCleanDays ?? 0) < 1) missing.push('--clean-days <how many clean days in a row, at least 1>');
  if (!Number.isInteger(input.maxParallelDays) || (input.maxParallelDays ?? 0) < (input.requiredCleanDays ?? 1)) missing.push('--max-days <the most days the parallel run may last, at least the clean days>');
  if (!isDate(input.startedOn)) missing.push('--start <the first day, YYYY-MM-DD>');
  if (missing.length > 0) { say(`REFUSED — the parallel-run policy needs: ${missing.join(', ')}. Nothing is filled in for you: these are your decisions (R-05).`); return { exitCode: 2, lines }; }
  if (input.client === undefined) { say('An API address is needed. Give --api.'); return { exitCode: 2, lines }; }
  // OB-257: the owner's own PIN, before the call — so no token of his is ever made without it.
  const signedIn = await pinChecked(input.as!, input.pin, input.now, say);
  if (!signedIn.ok) return { exitCode: signedIn.exitCode, lines };
  const res = await input.client.request({
    method: 'PUT', path: '/v1/migration/parallel-run/policy', userId: input.as!, tenantId: input.tenantId,
    body: { cutoverId: input.cutoverId, dailyReconcilerUserId: input.reconcilerUserId, requiredCleanDays: input.requiredCleanDays, maxParallelDays: input.maxParallelDays, startedOn: input.startedOn },
    idempotencyKey: `parallel-policy-${input.cutoverId}-${input.reconcilerUserId}-${input.requiredCleanDays}-${input.maxParallelDays}-${input.startedOn}`,
    signedInAt: signedIn.signedInAt,
  });
  if (res.status !== 200 && res.status !== 201) { say(`REFUSED — the policy was not recorded: ${errorOf(res.body, res.status)}`); return { exitCode: 1, lines }; }
  const p = (res.body as { policy: { dailyReconcilerUserId: string; requiredCleanDays: number; maxParallelDays: number; startedOn: string; setBy: string; setAt: string } }).policy;
  say(`POLICY RECORDED — from ${p.startedOn}, ${p.dailyReconcilerUserId} reconciles every day; ${p.requiredCleanDays} clean day(s) in a row needed, at most ${p.maxParallelDays} day(s). Set by ${p.setBy} at ${p.setAt}.`);
  say('A later policy is a new, dated fact — the newest applies; this one stays on record.');
  return { exitCode: 0, lines };
}

// ── OB-257: head office's own jobs, done on the store PC by the owner's setup commands ────────────────────────────────
//
// On the store PC there is no head-office screen and no sign-in server (W-3). The owner decided (OB-257, "Owner setup
// commands"): `store-computer` commands he types himself, under the PC lock he accepted in OB-251, with each person typing
// their OWN till PIN for their own part. Each command below calls the EXISTING head-office route — nothing here writes to
// the database, and nothing here adds a rule of its own beyond refusing production and the demo tenant (the routes keep
// every rule: maker-checker, the GSTIN check digit, the prefix two tills may never share, the store-computer role that
// names one store). Every command:
//
//   1. refuses production (hard rule #7) and the demo tenant (gate G4) before anything else;
//   2. refuses a missing value by name — nothing is defaulted for the owner (only the privacy reply time, which OB-195
//      fixes at 15 days for every store and the route refuses any other);
//   3. says, in plain words, exactly what it will do, and asks for a YES;
//   4. asks each person whose act it is for their own till PIN — typed by that person, never shown, checked on this PC
//      against the verifier `till-pin` made (packages/identity/src/till-pin.ts); a wrong PIN, or none, and nothing is done;
//   5. calls the route as that person (the shell mints that person's short-lived token only after their PIN matched), so
//      the route's own audit and its own "who" fields name the person, never the owner on somebody's behalf.
//
// Pure: the HTTP client, the questions and the PIN check are injected (scripts/owner-setup.ts holds the real ones).

/** The commands, as the owner types them after `store-computer`. */
export const SETUP_STEPS = Object.freeze(['shop', 'store-settings', 'bill-prefix', 'grant', 'publish-catalogue'] as const);
export type SetupStep = (typeof SETUP_STEPS)[number];

/** A request made as one person, after their PIN was checked at `signedInAt` (the token's step-up time). */
export interface SetupRequest {
  readonly method: 'GET' | 'POST' | 'PUT';
  readonly path: string;
  readonly userId: string;
  readonly tenantId: string;
  readonly body?: unknown;
  readonly idempotencyKey?: string;
  readonly signedInAt: string;
}
export interface SetupClient { request(input: SetupRequest): Promise<{ readonly status: number; readonly body: unknown }> }

/** What the PIN check said: the PIN matches; it does not; this person has no PIN on this PC; the PC cannot check. */
export type PinVerdict = 'ok' | 'wrong' | 'no_pin_issued' | 'cannot_check';

export interface SetupInput {
  readonly step: string;
  readonly tenantId: string;
  readonly targetKind: string | undefined;
  readonly demoTenantIds: readonly string[];
  /** The values the owner typed, by flag name without the dashes (`legal-name`, `gstin`, `store`, …). */
  readonly values: Readonly<Record<string, string | undefined>>;
  /** Today, YYYY-MM-DD, on this PC's clock (the catalogue's "as of"). */
  readonly today: string;
  readonly now: () => string;
}

export interface SetupDeps {
  readonly client?: SetupClient;
  /** Ask for a YES. The plan has already been said. */
  readonly confirm: () => Promise<boolean>;
  /** Ask THIS person for their own till PIN, hidden. Undefined when nothing was typed (or there is no keyboard). */
  readonly askPin: (userId: string) => Promise<string | undefined>;
  readonly verifyPin: (userId: string, pin: string) => PinVerdict;
  /** Each line, as it is said (the questions come between them). */
  readonly say?: (line: string) => void;
}

export interface SetupOutcome { readonly exitCode: 0 | 1 | 2; readonly lines: readonly string[] }

/** A short, stable key for a place of business (a request key may not carry the address itself): FNV-1a over its lines. */
function placeKey(lines: readonly string[]): string {
  let h = 0x811c9dc5;
  for (const ch of lines.join('|')) { h ^= ch.codePointAt(0)!; h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

/** The privacy reply time every store promises — fixed by OB-195; the settings route refuses any other value. */
export const PRIVACY_REPLY_DAYS = 15;
/** The login the store PC's till syncs as: its store token is made for this name (scripts/install-till.mjs, W-5). */
export const STORE_EDGE_LOGIN = 'store-edge';
/** The store computer's own role (services/api/src/roles.ts STORE_COMPUTER_ROLE_ID). */
export const STORE_COMPUTER_ROLE = 'store_computer';

const LOGIN = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;
const CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const GSTIN_SHAPE = /^[0-9]{2}[A-Z0-9]{13}$/;
const CUTOFF_SHAPE = /^([01]\d|2[0-3]):[0-5]\d$/;
const RUPEES = /^\d{1,9}(\.\d{1,2})?$/;
const WHOLE = /^\d{1,7}$/;
const paise = (rupees: string): number => Math.round(Number(rupees) * 100);
const rupeesText = (v: string): string => `₹${Number(v).toFixed(2)}`;

interface PlannedCall {
  readonly as: string;
  readonly method: 'POST';
  /** A path, or one made from the answers of the calls before it (e.g. the approval asked for one step earlier). */
  readonly path: string | ((answers: readonly unknown[]) => string);
  readonly body: unknown | ((answers: readonly unknown[]) => unknown);
  readonly key: string;
  readonly ok: readonly number[];
  readonly said: (body: unknown) => string;
}
interface Planned { readonly actors: readonly string[]; readonly plan: readonly string[]; readonly calls: readonly PlannedCall[]; readonly done: string }

/** Read the values for one step: every problem named at once, or the plan. */
function planStep(step: SetupStep, v: Readonly<Record<string, string | undefined>>, today: string, nowIso: string): { readonly problems: readonly string[] } | { readonly planned: Planned } {
  const problems: string[] = [];
  const need = (flag: string, shape: RegExp, words: string): string => {
    const value = (v[flag] ?? '').trim();
    if (value === '') problems.push(`--${flag} <${words}>`);
    else if (!shape.test(value)) problems.push(`--${flag} must be ${words} (got "${value}")`);
    return value;
  };
  const named = (flag: string, min: number, words: string): string => {
    const value = (v[flag] ?? '').trim();
    if (value.length < min) problems.push(`--${flag} "<${words}>"`);
    return value;
  };
  const as = need('as', LOGIN, 'your own login');
  switch (step) {
    case 'shop': {
      const company = need('company', CODE, 'a short code for the company, e.g. SRE');
      const legalName = named('legal-name', 3, 'the legal name exactly as on the GST certificate');
      const gstin = need('gstin', GSTIN_SHAPE, 'the 15-character GSTIN, in capital letters and digits');
      const store = need('store', CODE, 'a short code for this store, e.g. SRE-MAIN');
      const storeName = named('store-name', 2, "the store's name");
      // OB-271 · OB-278: the store's PLACE OF BUSINESS as its tax invoice prints it (CGST Rule 46(a)) — optional (the mirror
      // pilot needs none; a real-trading bill without it is refused at the till). Lines split by "|", blank ones dropped,
      // at most 4 lines of at most 80 characters, so the owner types it on one PowerShell line.
      const placeRaw = (v['place-of-business'] ?? '').trim();
      const place = placeRaw === '' ? [] : placeRaw.split('|').map((l) => l.trim()).filter((l) => l !== '');
      if (placeRaw !== '' && (place.length === 0 || place.length > 4 || place.some((l) => l.length > 80))) {
        problems.push('--place-of-business "<the store\'s address as the bill prints it: up to 4 lines of up to 80 characters, split by |>"');
      }
      // OB-288 P1 (M01-FR-01 "structural changes are owner-approved (maker-checker, §28)"): making the store active is
      // asked for by the person setting the shop up and approved by a second person, the owner, with their own PIN.
      const approver = need('approver', LOGIN, 'the login of the SECOND person, the owner, who approves making the store active');
      if (as !== '' && approver !== '' && as === approver) problems.push('--as and --approver must be two different people: one sets the shop up and asks, the owner approves (§28, M01-FR-01)');
      if (problems.length > 0) return { problems };
      const requestOf = (answers: readonly unknown[]): string => String((answers[3] as { requestId?: unknown } | undefined)?.requestId ?? '');
      return {
        planned: {
          actors: [as, approver],
          plan: [
            `1. Record the company ${company} under its legal name "${legalName}".`,
            `2. Record the GST registration ${gstin} for "${legalName}" (head office checks the GSTIN's check digit).`,
            `3. Record the store ${store} ("${storeName}") under the company, filed under GSTIN ${gstin}${place.length === 0 ? '' : `, its place of business for the bill: ${place.join(', ')}`}.`,
            `4. ${as} asks for the store ${store} to be made active; ${approver} approves it — a second person, with their own PIN.`,
            `5. Make the store ${store} active, naming that approval.`,
          ],
          calls: [
            { as, method: 'POST', path: `/v1/org/nodes/${encodeURIComponent(company)}`, body: { kind: 'company', name: legalName }, key: `owner-setup-company-${company}`, ok: [200, 201], said: () => `company ${company} recorded` },
            { as, method: 'POST', path: `/v1/org/gst-registrations/${encodeURIComponent(gstin)}`, body: { companyId: company, legalName }, key: `owner-setup-gstin-${gstin}`, ok: [200, 201], said: () => `GST registration ${gstin} recorded for "${legalName}"` },
            {
              as, method: 'POST', path: `/v1/org/nodes/${encodeURIComponent(store)}`,
              body: { kind: 'branch', name: storeName, parentId: company, companyId: company, gstin, ...(place.length === 0 ? {} : { placeOfBusiness: place }) },
              // A place of business is its own request: the same store typed again with a new address is a new, named fact.
              key: place.length === 0 ? `owner-setup-store-${store}` : `owner-setup-store-${store}-place-${placeKey(place)}`, ok: [200, 201],
              said: () => `store ${store} ("${storeName}") recorded under ${company}${place.length === 0 ? '' : ', with its place of business'}`,
            },
            {
              as, method: 'POST', path: '/v1/approvals/requests',
              body: { kind: 'org_structure_change', subjectRef: store, details: { nodeId: store, action: 'activate' }, valueMinor: null, summary: `Make the store ${store} ("${storeName}") active`, reason: 'owner setup on the store PC' },
              key: `owner-setup-store-${store}-activation-ask`, ok: [200, 201], said: () => `${as} asked for the store to be made active; it waits for ${approver}`,
            },
            {
              as: approver, method: 'POST', path: (a: readonly unknown[]) => `/v1/approvals/requests/${encodeURIComponent(requestOf(a))}/decide`, body: { decision: 'approved', reason: 'owner setup on the store PC' },
              key: `owner-setup-store-${store}-activation-approve`, ok: [200, 201], said: () => `${approver} approved it`,
            },
            { as, method: 'POST', path: `/v1/org/nodes/${encodeURIComponent(store)}/activation`, body: (a: readonly unknown[]) => ({ approvalId: requestOf(a) }), key: `owner-setup-store-${store}-activation`, ok: [200, 201], said: () => `store ${store} is active` },
          ],
          done: `DONE — the shop is set up at head office on this computer: company ${company} ("${legalName}"), GSTIN ${gstin}, store ${store} active. Done as ${as}, approved by ${approver}.`,
        },
      };
    }
    case 'store-settings': {
      const store = need('store', CODE, "the store's code");
      const cutoff = need('cutoff', CUTOFF_SHAPE, "the time the shop's day ends, HH:MM (00:00 is midnight)");
      const stale = need('stale-after-minutes', WHOLE, 'whole minutes');
      const count = need('count-approval-rupees', RUPEES, 'rupees, e.g. 500');
      const handover = need('handover-tolerance-rupees', RUPEES, 'rupees, e.g. 0');
      const variance = need('cash-variance-rupees', RUPEES, 'rupees, e.g. 0');
      if (problems.length > 0) return { problems };
      const body = {
        tradingDayCutoff: cutoff, staleAfterSeconds: Number(stale) * 60, countApprovalThresholdMinor: paise(count),
        handoverToleranceMinor: paise(handover), cashVarianceToleranceMinor: paise(variance), privacySlaDays: PRIVACY_REPLY_DAYS,
      };
      return {
        planned: {
          actors: [as],
          plan: [
            `1. Save store ${store}'s settings as a NEW version (every older version is kept):`,
            `   the shop's day ends at ${cutoff}; the store computer's copy of head office's setup counts as old after ${stale} minute(s);`,
            `   a stock count difference over ${rupeesText(count)} needs a second person; a cash handover may be out by ${rupeesText(handover)};`,
            `   a till's cash may be out by ${rupeesText(variance)} before it is a variance; privacy requests are answered within ${PRIVACY_REPLY_DAYS} days (fixed, OB-195).`,
          ],
          calls: [{
            as, method: 'POST', path: `/v1/stores/${encodeURIComponent(store)}/settings`, body,
            key: `owner-setup-settings-${store}-${cutoff}-${stale}-${body.countApprovalThresholdMinor}-${body.handoverToleranceMinor}-${body.cashVarianceToleranceMinor}`,
            ok: [200, 201], said: (b) => `store ${store}'s settings saved as version ${String((b as { settings?: { version?: number } } | undefined)?.settings?.version ?? '?')}`,
          }],
          done: `DONE — store ${store}'s settings are saved at head office on this computer. Done as ${as}.`,
        },
      };
    }
    case 'bill-prefix': {
      const store = need('store', CODE, "the store's code");
      const till = need('till', CODE, "the till's lane, e.g. lane-1");
      const prefix = need('prefix', /^[A-Za-z0-9-]{1,10}$/, 'up to 10 letters, digits or "-", e.g. S1L1-');
      const reason = (v['reason'] ?? '').trim();
      if (problems.length > 0) return { problems };
      return {
        planned: {
          actors: [as],
          plan: [`1. Issue till ${till} at store ${store} the bill prefix ${prefix}: its bills are numbered ${prefix}000001 onwards, and no other till may ever use ${prefix}.`],
          calls: [{
            as, method: 'POST', path: `/v1/stores/${encodeURIComponent(store)}/tills/${encodeURIComponent(till)}/receipt-prefix`,
            body: { prefix, ...(reason === '' ? {} : { reason }) }, key: `owner-setup-prefix-${store}-${till}-${prefix}`, ok: [200, 201],
            said: (b) => ((b as { unchanged?: boolean } | undefined)?.unchanged === true ? `till ${till} already has the prefix ${prefix} — nothing new recorded` : `till ${till} at ${store} has the prefix ${prefix}`),
          }],
          done: `DONE — the bill prefix ${prefix} is issued to till ${till} at store ${store}. The till takes it the next time it reaches this copy's books. Done as ${as}.`,
        },
      };
    }
    case 'grant': {
      const approver = need('approver', LOGIN, 'the login of the SECOND person, who approves');
      const person = need('person', LOGIN, 'the login of the person who gets the role');
      const role = need('role', /^[a-z][a-z_]{1,40}$/, 'a role, e.g. cashier, store_manager or store_computer');
      const store = need('store', CODE, "the store's code");
      const reason = named('reason', 3, 'why, in a few words');
      if (as !== '' && approver !== '' && as === approver) problems.push('--as and --approver must be two different people: one asks, the other approves (§28)');
      if (person !== '' && (person === as || person === approver)) problems.push('the person who gets the role never asks for it or approves it for themselves');
      if (role === STORE_COMPUTER_ROLE && person !== '' && person !== STORE_EDGE_LOGIN) problems.push(`the store computer role is only for the till's own sign-in, ${STORE_EDGE_LOGIN} — never a person`);
      if (person === STORE_EDGE_LOGIN && role !== '' && role !== STORE_COMPUTER_ROLE) problems.push(`${STORE_EDGE_LOGIN} is the till's own sign-in: it holds only the ${STORE_COMPUTER_ROLE} role`);
      if (problems.length > 0) return { problems };
      const grantId = `grant-${person}-${role}-${store}`;
      return {
        planned: {
          actors: [as, approver],
          plan: [
            `1. ${as} asks head office to give ${person} the role "${role}" at store ${store} only. Reason: "${reason}".`,
            `2. ${approver} approves it — a second person, with their own PIN. Until then nothing is granted.`,
          ],
          calls: [
            {
              as, method: 'POST', path: '/v1/identity/grants', body: { grantId, userId: person, roleId: role, branchScope: [store], reason },
              key: `owner-setup-${grantId}-request`, ok: [200, 201, 202],
              said: (b) => ((b as { alreadyRequested?: boolean } | undefined)?.alreadyRequested === true ? `already asked — the request is ${String((b as { state?: string }).state)}` : `${as} asked for it; it waits for a second person`),
            },
            {
              as: approver, method: 'POST', path: `/v1/identity/grants/${encodeURIComponent(grantId)}/approve`, body: {},
              key: `owner-setup-${grantId}-approve`, ok: [200, 201],
              said: (b) => ((b as { alreadyGranted?: boolean } | undefined)?.alreadyGranted === true ? 'it was already granted' : `${approver} approved it`),
            },
          ],
          done: `DONE — ${person} holds "${role}" at store ${store}: asked by ${as}, approved by ${approver}. The till learns it the next time it reaches this copy's books.`,
        },
      };
    }
    case 'publish-catalogue': {
      const store = need('store', CODE, "the store's code");
      if (problems.length > 0) return { problems };
      return {
        planned: {
          actors: [as],
          plan: [`1. Publish the signed price list (the catalogue pack) for store ${store} as of ${today}: every product, barcode, tax class and price head office holds now. The till takes it the next time it reaches this copy's books.`],
          calls: [{
            as, method: 'POST', path: '/v1/catalogue/pack', body: { storeId: store, asOf: today }, key: `owner-setup-pack-${store}-${nowIso}`, ok: [201],
            said: (b) => `the catalogue pack version ${String((b as { version?: number } | undefined)?.version ?? '?')} is published`,
          }],
          done: `DONE — the catalogue pack is published for store ${store}. Done as ${as}.`,
        },
      };
    }
  }
  return { problems: [`no such step ${String(step)}`] };
}

/** Run one owner setup command. Exit 0 done · 1 refused or not done · 2 could not be understood. */
export async function runOwnerSetup(input: SetupInput, deps: SetupDeps): Promise<SetupOutcome> {
  const lines: string[] = [];
  const say = (s: string): void => { lines.push(s); deps.say?.(s); };
  if (!(SETUP_STEPS as readonly string[]).includes(input.step)) { say(`Not understood: "${input.step}". The setup commands are: ${SETUP_STEPS.join(', ')}.`); return { exitCode: 2, lines }; }
  const step = input.step as SetupStep;
  if (input.tenantId.trim() === '') { say("REFUSED — this copy's settings name no tenant (EDGE_TENANT_ID). Send me a photo of this screen."); return { exitCode: 2, lines }; }
  const refused = targetRefusal(input.targetKind, input.tenantId, input.demoTenantIds, `owner-setup-${step}`);
  if (refused !== undefined) { say(refused); return { exitCode: 1, lines }; }

  const read = planStep(step, input.values, input.today, input.now());
  if ('problems' in read) { say(`REFUSED — ${step} needs: ${read.problems.join('; ')}. Nothing is filled in for you, and nothing was done.`); return { exitCode: 2, lines }; }
  const p = read.planned;
  if (deps.client === undefined) { say("REFUSED — this copy's API cannot be spoken to: its settings have no identity settings (IDP_SIGNING_KEY, IDP_ISSUER, IDP_AUDIENCE). Send me a photo of this screen."); return { exitCode: 2, lines }; }

  say(`This will, at head office on this computer (tenant ${input.tenantId}):`);
  for (const l of p.plan) say(`  ${l}`);
  say(`Who types their own till PIN: ${p.actors.join(', then ')}. Nobody types anyone else's.`);
  if (!(await deps.confirm())) { say('NOT DONE — you did not type YES. Nothing was done.'); return { exitCode: 1, lines }; }

  // Every person's PIN BEFORE any call: a wrong PIN for the second person never leaves the first person's half done.
  const signedIn = new Map<string, string>();
  for (const who of p.actors) {
    const checked = await pinChecked(who, deps, input.now, say);
    if (!checked.ok) return { exitCode: checked.exitCode, lines };
    signedIn.set(who, checked.signedInAt);
  }

  const answers: unknown[] = [];
  for (const call of p.calls) {
    const path = typeof call.path === 'function' ? call.path(answers) : call.path;
    const body = typeof call.body === 'function' ? (call.body as (a: readonly unknown[]) => unknown)(answers) : call.body;
    const res = await deps.client.request({ method: call.method, path, userId: call.as, tenantId: input.tenantId, body, idempotencyKey: call.key, signedInAt: signedIn.get(call.as)! });
    answers.push(res.body);
    if (!call.ok.includes(res.status)) {
      say(`NOT DONE — head office refused: ${errorOf(res.body, res.status)}`);
      say('  What was done before this line stays done (it is recorded, never undone); the same command again carries on from here.');
      return { exitCode: 1, lines };
    }
    say(`  done — ${call.said(res.body)}.`);
  }
  say(p.done);
  return { exitCode: 0, lines };
}
