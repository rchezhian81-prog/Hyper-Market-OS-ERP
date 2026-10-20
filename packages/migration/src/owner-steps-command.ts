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
// Pure: the HTTP client is injected (scripts/migration-slice.ts mints the person's short-lived token), so tests drive it
// with a stand-in API. Never against production (hard rule #7), never into the demo tenant (gate G4).

import { assertNonProduction, type TargetKind } from './trial';
import type { CommandClient } from './load-command';
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
  readonly client?: CommandClient;
  /** A short content fingerprint for the idempotency key (SHA-256 in the shell). */
  readonly fingerprint: (text: string) => string;
  readonly today: string;
}

/** Seal every slice file in the folder through the seal route. A file already sealed is never sealed again. */
export async function sealSlice(input: SealSliceInput): Promise<OwnerStepOutcome> {
  const lines: string[] = [];
  const say = (s: string): void => { lines.push(s); };
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
      idempotencyKey: `${extractId}-seal-${input.fingerprint(text).slice(0, 16)}`,
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
  readonly client?: CommandClient;
}

/** Write the parallel-run policy through PUT /v1/migration/parallel-run/policy. Every value comes from the owner. */
export async function writeParallelPolicy(input: ParallelPolicyInput): Promise<OwnerStepOutcome> {
  const lines: string[] = [];
  const say = (s: string): void => { lines.push(s); };
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
  const res = await input.client.request({
    method: 'PUT', path: '/v1/migration/parallel-run/policy', userId: input.as!, tenantId: input.tenantId,
    body: { cutoverId: input.cutoverId, dailyReconcilerUserId: input.reconcilerUserId, requiredCleanDays: input.requiredCleanDays, maxParallelDays: input.maxParallelDays, startedOn: input.startedOn },
    idempotencyKey: `parallel-policy-${input.cutoverId}-${input.reconcilerUserId}-${input.requiredCleanDays}-${input.maxParallelDays}-${input.startedOn}`,
  });
  if (res.status !== 200 && res.status !== 201) { say(`REFUSED — the policy was not recorded: ${errorOf(res.body, res.status)}`); return { exitCode: 1, lines }; }
  const p = (res.body as { policy: { dailyReconcilerUserId: string; requiredCleanDays: number; maxParallelDays: number; startedOn: string; setBy: string; setAt: string } }).policy;
  say(`POLICY RECORDED — from ${p.startedOn}, ${p.dailyReconcilerUserId} reconciles every day; ${p.requiredCleanDays} clean day(s) in a row needed, at most ${p.maxParallelDays} day(s). Set by ${p.setBy} at ${p.setAt}.`);
  say('A later policy is a new, dated fact — the newest applies; this one stays on record.');
  return { exitCode: 0, lines };
}
