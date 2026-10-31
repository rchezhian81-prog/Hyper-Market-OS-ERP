// API-04 Quality hold / release register (M10-FR-02) — the DURABLE cloud record of which batches are
// held for quality and who released each one, run on the tested `releaseFromQualityHold` engine.
//
// M10-FR-02's flow ends "… → hold/release", its §28 permission is "quality release by authorized QC",
// and its acceptance is "quality-held stock is not sellable until released". Cold-chain ASSESS
// (`/v1/quality/cold-chain/assess`) already runs the verdict but is deliberately stateless — it decides,
// it does not remember. This is the memory: a hold is an append-only fact (`QualityHeld`), a release is
// another (`QualityReleased`), and the two together are the register a food-safety inspector reads. The
// record is never overwritten (hard rule #2/#6) — a re-hold or a release is a NEW event; the current
// state folds from the append-only stream.
//
// The engine, not this file, decides whether a release is allowed: it is refused for a FAILED or
// OUTSTANDING sample, a cold-chain breach, an expired batch, or an unnamed releaser — "it was checked"
// is not evidence, a name and a time are. This file is the persistence + HTTP skin.
//
// Honest scope: this is the cloud GOVERNANCE register. The other half of the acceptance clause — a
// held batch being un-sellable at the till, offline — reaches the POS on the signed pack exactly as the
// recall block does (M10-FR-04), and is a separate slice; it is NOT claimed here.
//
// Placing/reading a hold is `quality.hold.manage`; RELEASING is the dedicated `quality.hold.release`
// — "authorized QC" (§28) as its own least-privilege code, so a QC role can be granted release without
// anything else, and the person who holds and the person who releases can differ (SoD, P-04).

import type { Route } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import {
  releaseFromQualityHold,
  type QualityHold, type QualitySample, type ColdChainAssessment,
  type QualityReleaseResult, type ReleaseRefusal,
} from '../../../packages/quality/src/index';

export interface QualityHoldDeps {
  /** The current hold record for one batch (folded from the append-only stream), or undefined. */
  readonly hold: (tenantId: string, batchId: string) => Promise<QualityHold | undefined> | QualityHold | undefined;
  /** Every batch's CURRENT hold record — for the register read. */
  readonly holds: (tenantId: string) => Promise<readonly QualityHold[]> | readonly QualityHold[];
  /** Append a hold placement (idempotent on the caller's key). */
  readonly recordHeld: (tenantId: string, hold: QualityHold, key: string) => Promise<void> | void;
  /** Append a release (idempotent on the caller's key). */
  readonly recordReleased: (tenantId: string, hold: QualityHold, key: string) => Promise<void> | void;
  readonly now: () => string;
  /**
   * OB-513 (owner, 28 Oct 2026): whether a product is FOOD by head office's category list (its department is regulated
   * `food`) — a held food batch needs at least one recorded sample before it is released. undefined → head office cannot
   * tell, and the release asks for a sample (never assumed not food). Absent on a bare stub (no sample is required).
   */
  readonly isFood?: (tenantId: string, productId: string) => Promise<boolean | undefined> | boolean | undefined;
}

/** OB-513: why this hold does, or does not, need a recorded sample before release — in head office's words. */
export interface SampleRule {
  readonly required: boolean;
  /** `food`: the product is food; `food_not_known`: head office cannot tell; `not_food`: it may be released without one. */
  readonly because: 'food' | 'food_not_known' | 'not_food';
  readonly detail: string;
}

/** OB-513: the sample rule for a hold (none required when no food lookup is wired). */
export async function sampleRuleFor(deps: Pick<QualityHoldDeps, 'isFood'>, tenantId: string, hold: Pick<QualityHold, 'batchId' | 'productId'>): Promise<SampleRule> {
  if (deps.isFood === undefined) return { required: false, because: 'not_food', detail: `batch ${hold.batchId} may be released without a recorded sample` };
  const food = await deps.isFood(tenantId, hold.productId);
  if (food === true) return { required: true, because: 'food', detail: `${hold.productId} is a food item, so held batch ${hold.batchId} needs at least one quality sample recorded on its hold before it is released (OB-513)` };
  if (food === undefined) return { required: true, because: 'food_not_known', detail: `head office cannot tell whether ${hold.productId} is food (it is not on the product master), so held batch ${hold.batchId} needs at least one recorded sample before it is released (OB-513)` };
  return { required: false, because: 'not_food', detail: `${hold.productId} is not a food item, so batch ${hold.batchId} may be released without a recorded sample (OB-513)` };
}

// ── Round 6 · M10-FR-02 "sampling": each quality sample is RECORDED on the hold ─────────────────────────────────────────
//
// Before this round a release carried the samples in its own body — the QC's word, judged and then forgotten. Now each
// sample (what was tested, pass / fail / pending, who took it and when, who recorded it) is its own append-only fact on
// its own stream, retained beside the hold; a pending sample's result is a NEW version of it (pending → pass or fail),
// and a final result is never changed — a failed sample stands, and a re-test is a new sample. A release reads the
// STORED samples of the hold it releases: any failed or still-pending sample refuses it. A release body that sends its own
// samples is refused — they are recorded on the hold first, never typed into a release.

/** One sample on a hold, as recorded — the latest version of it is its current result; every version is kept. */
export interface StoredQualitySample extends QualitySample {
  /** The hold this sample belongs to (its `heldAt`) — a batch held again later starts with no samples. */
  readonly holdHeldAt: string;
  readonly version: number;
  readonly recordedBy: string;
  readonly recordedAt: string;
}

export interface QualitySampleDeps {
  /** Every recorded version of every sample on this batch (oldest first). */
  readonly sampleVersions: (tenantId: string, batchId: string) => Promise<readonly StoredQualitySample[]> | readonly StoredQualitySample[];
  /** Append one version of a sample (one fact per sample per version). */
  readonly recordSample: (tenantId: string, sample: StoredQualitySample) => Promise<void> | void;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
}

/** The current version of each sample on the hold now in force (the hold placed at `holdHeldAt`). */
export function currentSamples(versions: readonly StoredQualitySample[], hold: Pick<QualityHold, 'batchId' | 'heldAt'>): readonly StoredQualitySample[] {
  const latest = new Map<string, StoredQualitySample>();
  for (const v of versions) {
    if (v.batchId !== hold.batchId || v.holdHeldAt !== hold.heldAt) continue;
    const held = latest.get(v.sampleId);
    if (held === undefined || v.version > held.version) latest.set(v.sampleId, v);
  }
  return [...latest.values()].sort((a, b) => a.takenAt.localeCompare(b.takenAt) || a.sampleId.localeCompare(b.sampleId));
}

const SAMPLE_RESULTS: readonly QualitySample['result'][] = ['pass', 'fail', 'pending'];
const sentSamples = (v: unknown): boolean => Array.isArray(v) && v.length > 0;
const SAMPLES_NOT_IN_A_RELEASE = {
  code: 'samples_are_recorded_on_the_hold',
  whatHappened: 'A release no longer carries its own samples: each sample is recorded on the hold first (POST /v1/quality/holds/:batchId/samples/:sampleId), and the release is judged on the samples recorded there.',
  wasItSaved: 'not_saved' as const,
};

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

// A held batch first (nothing more urgent than stock that must not be sold), then most-recently held.
const byUrgency = (a: QualityHold, b: QualityHold): number => {
  const held = (h: QualityHold): number => (h.status === 'released' ? 1 : 0);
  if (held(a) !== held(b)) return held(a) - held(b);
  return a.heldAt < b.heldAt ? 1 : a.heldAt > b.heldAt ? -1 : 0;
};

// How the engine's refusal reaches the person: an HTTP status, a safe next step, and a fallback
// `what` in case the engine's `detail` is thin (the cold-chain detail is caller-supplied, so it may
// be absent — an error reply must still say what happened, §27.1). The engine's own `detail` is
// preferred when it is usable; the fallback keeps every refusal a complete, honest error.
const REFUSAL: Readonly<Record<Exclude<ReleaseRefusal, 'released'>, { status: number; what: string; next: string }>> = {
  not_held: { status: 409, what: 'This batch has already been released, so there is no hold to release.', next: 'This batch is already released — nothing is held, so there is nothing to release again.' },
  sample_failed: { status: 422, what: 'A quality sample for this batch failed, so it cannot be released for sale.', next: 'The batch stays held. A failed sample cannot be released — route it to disposal (M28) or re-sample.' },
  sample_pending: { status: 422, what: 'A quality sample for this batch has not come back yet, so releasing now would be a guess.', next: 'The batch stays held. Wait for the outstanding sample to come back, then release.' },
  sample_required: { status: 422, what: 'This is a held food batch and no quality sample is recorded on its hold, so it cannot be released yet (OB-513).', next: 'The batch stays held. Take a sample, record it on the hold (POST /v1/quality/holds/:batchId/samples/:sampleId), then release.' },
  cold_chain_breach: { status: 422, what: 'A cold-chain breach is on record for this batch, so it cannot be released for sale.', next: 'The batch stays held. A cold-chain breach cannot be released — the incident and evidence stand (M10-FR-04).' },
  expired: { status: 422, what: 'This batch has passed its expiry date, so it can never be released.', next: 'The batch has expired and can never be released — route it to disposal (M28).' },
  no_releaser: { status: 422, what: 'A release arrived without the name of the person making it.', next: 'A release must carry the name of the person making it — sign in and release again.' },
};

const usable = (s: string | undefined): s is string => typeof s === 'string' && s.trim().length >= 10;

export function qualityHoldRoutes(deps: QualityHoldDeps & QualitySampleDeps): readonly Route[] {
  const samplesOf = async (tenantId: string, hold: QualityHold): Promise<readonly StoredQualitySample[]> =>
    currentSamples(await deps.sampleVersions(tenantId, hold.batchId), hold);
  return [
    {
      // M10-FR-02: record a quality sample on a held batch — or the result of one that was pending. Body: { test, result,
      // takenAt?, notes? }. The recorder is the signed-in person; the sample is taken by them unless it was already on
      // record. Append-only: pending → pass / fail is a new version; a final result never changes (a re-test is a new id).
      api: 'API-04', method: 'POST', path: '/v1/quality/holds/:batchId/samples/:sampleId',
      permission: 'quality.hold.manage', idempotent: true,
      handler: async (ctx) => {
        const batchId = (ctx.params['batchId'] ?? '').trim();
        const sampleId = (ctx.params['sampleId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const result = b['result'] as QualitySample['result'];
        const takenAt = b['takenAt'];
        if (batchId === '' || sampleId === '' || !SAMPLE_RESULTS.includes(result)
          || (b['test'] !== undefined && !isStr(b['test'])) || (takenAt !== undefined && !(isStr(takenAt) && !Number.isNaN(Date.parse(takenAt))))
          || (b['notes'] !== undefined && typeof b['notes'] !== 'string')) {
          throw apiError(400, {
            code: 'not_readable_as_a_quality_sample',
            whatHappened: 'A quality sample needs the batch and sample id in the address and { test, result: pass | fail | pending } in the body (takenAt and notes optional).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send what was tested and its result. Nothing was saved.',
          });
        }
        const hold = await deps.hold(ctx.tenantId, batchId);
        if (hold === undefined) throw notFound(`quality hold for batch ${batchId}`);
        if (hold.status === 'released') {
          throw apiError(409, { code: 'not_held', whatHappened: `Batch ${batchId} has already been released, so no sample can be added to its hold.`, wasItSaved: 'not_saved', nextSafeAction: 'Place a new hold first if the batch must be checked again. Nothing was saved.' });
        }
        const current = (await samplesOf(ctx.tenantId, hold)).find((s) => s.sampleId === sampleId);
        const at = deps.now();
        const judged = judgeSample(current, {
          batchId, sampleId, holdHeldAt: hold.heldAt, test: isStr(b['test']) ? (b['test'] as string).trim() : undefined, result,
          takenAt: isStr(takenAt) ? new Date(Date.parse(takenAt)).toISOString() : at,
          notes: typeof b['notes'] === 'string' ? b['notes'] : undefined, recordedBy: ctx.userId, recordedAt: at,
        });
        if (judged.kind === 'refuse') {
          if (judged.code === 'no_test') throw apiError(400, { code: 'not_readable_as_a_quality_sample', whatHappened: judged.what, wasItSaved: 'not_saved', nextSafeAction: 'Send the test name. Nothing was saved.' });
          throw apiError(409, {
            code: judged.code, whatHappened: judged.what, wasItSaved: 'not_saved',
            nextSafeAction: judged.code === 'sample_is_another_test' ? 'Record a different test under its own sample id. Nothing was changed.' : 'Take a new sample and record it under its own id — the first result stays on record. Nothing was changed.',
          });
        }
        if (judged.kind === 'same') return { status: 200, body: { sample: judged.sample, alreadyRecorded: true } };
        const { sample } = judged;
        const test = sample.test;
        await deps.recordSample(ctx.tenantId, sample);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'quality.sample.record', objectType: 'quality_sample', objectId: `${batchId}/${sampleId}`, at,
          origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: current === undefined ? null : { result: current.result, version: String(current.version) },
          after: { test, result, version: String(sample.version) }, correlationId: `quality-hold:${batchId}`,
        });
        return { status: current === undefined ? 201 : 200, body: { sample } };
      },
    },
    {
      // The samples recorded on a batch's current hold (each one's current result), and every version ever recorded.
      api: 'API-04', method: 'GET', path: '/v1/quality/holds/:batchId/samples',
      permission: 'quality.hold.manage',
      handler: async (ctx) => {
        const batchId = (ctx.params['batchId'] ?? '').trim();
        const hold = await deps.hold(ctx.tenantId, batchId);
        if (hold === undefined) throw notFound(`quality hold for batch ${batchId}`);
        const versions = (await deps.sampleVersions(ctx.tenantId, batchId)).filter((v) => v.holdHeldAt === hold.heldAt);
        return { status: 200, body: { batchId, samples: currentSamples(versions, hold), history: versions } };
      },
    },
    {
      // Place a quality hold on a batch. Body: { productId, reason }. The holder is the authenticated caller.
      // Idempotent: a batch already held is one effect (the hold is already in force).
      api: 'API-04', method: 'POST', path: '/v1/quality/holds/:batchId',
      permission: 'quality.hold.manage', idempotent: true,
      handler: async (ctx) => {
        const batchId = (ctx.params['batchId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (batchId === '' || !isStr(b['productId']) || !isStr(b['reason'])) {
          throw apiError(400, {
            code: 'not_readable_as_a_quality_hold',
            whatHappened: 'Placing a quality hold needs a batch id in the path and { productId, reason } in the body.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send { productId: "...", reason: "..." } with the batch id in the URL — the reason is what a person later has to justify.',
          });
        }
        const existing = await deps.hold(ctx.tenantId, batchId);
        if (existing !== undefined && existing.status !== 'released') {
          // Already held — the block is already in force; nothing new to record (no double hold).
          return { status: 200, body: { hold: existing, alreadyHeld: true } };
        }
        const hold: QualityHold = {
          batchId,
          productId: b['productId'] as string,
          status: 'held',
          reason: b['reason'] as string,
          heldAt: deps.now(),
          heldBy: ctx.userId,
        };
        await deps.recordHeld(ctx.tenantId, hold, ctx.idempotencyKey ?? batchId);
        return { status: 201, body: { hold } };
      },
    },
    {
      // Release a held batch for sale — run on the tested engine, gated to authorized QC (§28). The
      // samples / cold-chain verdict / expiry the QC reviewed are supplied here as their attestation;
      // the engine enforces the rules on them, and the DURABLE facts are the release, its releaser and
      // its time. Refused → 4xx and NOTHING is appended (the hold stands).
      api: 'API-04', method: 'POST', path: '/v1/quality/holds/:batchId/release',
      permission: 'quality.hold.release', idempotent: true,
      handler: async (ctx) => {
        const batchId = (ctx.params['batchId'] ?? '').trim();
        if (batchId === '') throw notFound('quality hold (no batch id given)');
        const hold = await deps.hold(ctx.tenantId, batchId);
        if (hold === undefined) throw notFound(`quality hold for batch ${batchId}`);
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (sentSamples(b['samples'])) throw apiError(400, { ...SAMPLES_NOT_IN_A_RELEASE, nextSafeAction: 'Record each sample on the hold, then release with no samples in the body. Nothing was released.' });
        // M10-FR-02: the release is judged on the samples RECORDED on this hold — never on a list the releaser sends.
        const samples = await samplesOf(ctx.tenantId, hold);
        const coldChain = (b['coldChain'] ?? undefined) as ColdChainAssessment | undefined;
        const expiresOn = isStr(b['expiresOn']) ? (b['expiresOn'] as string) : undefined;

        // OB-513: a held FOOD batch needs at least one recorded sample first; other holds may release without.
        const rule = await sampleRuleFor(deps, ctx.tenantId, hold);
        const result: QualityReleaseResult = releaseFromQualityHold({
          hold, samples, coldChain, expiresOn, releasedBy: ctx.userId, at: deps.now(),
          ...(rule.required ? { sampleRequired: rule.detail } : {}),
        });

        if (!result.released) {
          const map = REFUSAL[result.outcome as Exclude<ReleaseRefusal, 'released'>];
          throw apiError(map.status, {
            code: result.outcome,
            whatHappened: usable(result.detail) ? result.detail : map.what,
            wasItSaved: 'not_saved',
            nextSafeAction: map.next,
          });
        }
        await deps.recordReleased(ctx.tenantId, result.hold, ctx.idempotencyKey ?? `${batchId}:release`);
        return { status: 200, body: { release: result, samples } };
      },
    },
    {
      // The register — held batches first (nothing more urgent), then released ones (record retained).
      api: 'API-04', method: 'GET', path: '/v1/quality/holds',
      permission: 'quality.hold.manage',
      handler: async (ctx) => {
        const all = [...(await deps.holds(ctx.tenantId))].sort(byUrgency);
        return {
          status: 200,
          body: { holds: all, count: all.length, heldCount: all.filter((h) => h.status !== 'released').length },
        };
      },
    },
    {
      // One batch's current hold record (held or released). 404 when the batch was never held.
      api: 'API-04', method: 'GET', path: '/v1/quality/holds/:batchId',
      permission: 'quality.hold.manage',
      handler: async (ctx) => {
        const batchId = (ctx.params['batchId'] ?? '').trim();
        const hold = await deps.hold(ctx.tenantId, batchId);
        if (hold === undefined) throw notFound(`quality hold for batch ${batchId}`);
        return { status: 200, body: { hold, samples: await samplesOf(ctx.tenantId, hold), sampleRule: await sampleRuleFor(deps, ctx.tenantId, hold) } };
      },
    },
  ];
}

// ── OB-333 (owner, 23 Oct 2026, in writing): a quality-hold RELEASE decided at the store with the line down ──────────────
//
// The store computer gets a narrow RELEASE-ONLY right (`quality.hold.release.sync`) and this synced route: the facilities
// screen it serves keeps the release on its durable device queue before it says "saved", and the box relays it here
// under the store's credential. Head office trusts the FACT (who released which batch, when) and re-checks everything
// else on its own records: the hold must be one head office placed and still holds; the PERSON named is re-checked from
// THEIR grants (`quality.hold.release`, the §28 "authorized QC" right); the tested `releaseFromQualityHold` engine re-runs
// on the samples, cold-chain verdict and expiry sent. A refusal is by name (422), so the box keeps it as a visible
// exception (hard rules #6, #10). The box can NEVER place a hold: there is no synced hold route, and the store computer
// holds neither `quality.hold.manage` nor `quality.hold.release`. A re-sent release by the same person is ONE release.

export interface SyncedQualityHoldDeps extends QualityHoldDeps, QualitySampleDeps {
  /** The permissions a person holds now, from their own grants — undefined for someone head office does not know. */
  readonly permissionsOfUser: (tenantId: string, userId: string) => Promise<readonly string[] | undefined> | readonly string[] | undefined;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
}

const isIsoTime = (v: unknown): v is string => isStr(v) && !Number.isNaN(Date.parse(v));
const asObj = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
/** The samples a store-decided release rests on: each sample id and the result the store saw for it (never judged on). */
type SampleRef = { readonly sampleId: string; readonly result: QualitySample['result'] };
const isSampleRefs = (v: unknown): v is readonly SampleRef[] => Array.isArray(v)
  && v.every((r) => r !== null && typeof r === 'object' && isStr((r as SampleRef).sampleId) && SAMPLE_RESULTS.includes((r as SampleRef).result));

// ── M10-FR-02 "Offline (§31): evidence captured offline; queued" — a quality SAMPLE recorded at the store with the line down ─
//
// OB-513 says a held food batch needs a recorded sample before release, and OB-333 lets that release be decided at the store
// with the line down. Until this route the sample could only be recorded here at head office, so the two did not fit
// together offline. Now the facilities screen keeps the sample on its durable device queue, the store computer relays it
// HERE under the store's narrow `quality.sample.record.sync` right, and head office trusts only the FACT (who recorded which
// result on which hold, when). It re-checks everything else on its own records:
//   • the hold must be one head office placed, still held, and the SAME hold the store saw (`holdHeldAt`) — a batch head
//     office already released, or released and held again since, is a conflict refused by name (422), never applied over;
//   • the PERSON named is re-checked from THEIR grants (`quality.hold.manage`, the right the direct sample route asks for) —
//     the box's word is never their authority;
//   • the sample rules are the direct route's: a final result never changes, a re-test is a new sample id, the same result
//     again is ONE sample.
// A refusal is 422 by name, so the store computer keeps it as a visible exception (hard rules #6, #10).

/** What one sample recording would do to the samples already on the hold — shared by the direct and the synced routes. */
export type SampleJudgement =
  | { readonly kind: 'same'; readonly sample: StoredQualitySample }
  | { readonly kind: 'record'; readonly sample: StoredQualitySample; readonly before: StoredQualitySample | undefined }
  | { readonly kind: 'refuse'; readonly code: 'no_test' | 'sample_is_another_test' | 'sample_result_final'; readonly what: string };

/** Judge one sample recording against the current version of that sample on the hold (pure). */
export function judgeSample(current: StoredQualitySample | undefined, input: {
  readonly batchId: string; readonly sampleId: string; readonly holdHeldAt: string; readonly test: string | undefined;
  readonly result: QualitySample['result']; readonly takenAt: string; readonly notes: string | undefined;
  readonly recordedBy: string; readonly recordedAt: string;
}): SampleJudgement {
  const { batchId, sampleId } = input;
  const test = input.test ?? current?.test;
  if (test === undefined) return { kind: 'refuse', code: 'no_test', what: 'A new sample needs what was tested (test).' };
  if (current !== undefined) {
    if (current.result === input.result && current.test === test) return { kind: 'same', sample: current };
    if (current.test !== test) return { kind: 'refuse', code: 'sample_is_another_test', what: `Sample ${sampleId} on batch ${batchId} is the "${current.test}" test, not "${test}".` };
    if (current.result !== 'pending') {
      return { kind: 'refuse', code: 'sample_result_final', what: `Sample ${sampleId} on batch ${batchId} already came back ${current.result.toUpperCase()} (recorded by ${current.recordedBy} at ${current.recordedAt}); a final result is never changed.` };
    }
  }
  const notes = input.notes !== undefined && input.notes.trim() !== '' ? input.notes.trim() : current?.notes;
  return {
    kind: 'record', before: current,
    sample: {
      sampleId, batchId, holdHeldAt: input.holdHeldAt, test, result: input.result,
      takenBy: current?.takenBy ?? input.recordedBy, takenAt: current?.takenAt ?? input.takenAt,
      ...(notes === undefined ? {} : { notes }),
      version: (current?.version ?? 0) + 1, recordedBy: input.recordedBy, recordedAt: input.recordedAt,
    },
  };
}

export function syncedQualityHoldRoutes(deps: SyncedQualityHoldDeps): readonly Route[] {
  return [
    {
      // Body: { batchId (= path), sampleId (= path), holdHeldAt, storeId, test, result, takenAt, recordedBy, at, notes?,
      // source? }. Idempotent: the same result for the same sample again is 200, one sample.
      api: 'API-04', method: 'POST', path: '/v1/quality/holds/:batchId/samples/:sampleId/synced',
      permission: 'quality.sample.record.sync', idempotent: true,
      handler: async (ctx) => {
        const batchId = (ctx.params['batchId'] ?? '').trim();
        const sampleId = (ctx.params['sampleId'] ?? '').trim();
        const b = asObj(ctx.body);
        const result = b['result'] as QualitySample['result'];
        if (batchId === '' || sampleId === '' || b['batchId'] !== batchId || b['sampleId'] !== sampleId || !isIsoTime(b['holdHeldAt'])
          || !isStr(b['test']) || !SAMPLE_RESULTS.includes(result) || !isIsoTime(b['takenAt']) || !isStr(b['recordedBy']) || !isIsoTime(b['at'])
          || (b['notes'] !== undefined && typeof b['notes'] !== 'string')) {
          throw apiError(400, {
            code: 'not_readable_as_a_relayed_sample',
            whatHappened: 'This could not be read as a quality sample from the store — it needs the batch and sample ids matching the path, the hold it was taken on (holdHeldAt), what was tested and its result, when it was taken, who recorded it (recordedBy) and when (at).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Do not discard it at the store. Keep it in the queue and raise it.',
          });
        }
        const recordedBy = (b['recordedBy'] as string).trim();
        const at = new Date(Date.parse(b['at'] as string)).toISOString();
        const holdHeldAt = b['holdHeldAt'] as string;
        const test = (b['test'] as string).trim();
        const hold = await deps.hold(ctx.tenantId, batchId);
        if (hold === undefined) {
          throw apiError(422, {
            code: 'no_hold_on_record',
            whatHappened: `Head office holds no quality hold on batch ${batchId}, so there is no hold to record sample ${sampleId} on.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Kept at the store for a person to look at. A hold is placed only at head office.',
          });
        }
        // The same sample result already on record for the hold the store saw: one sample, even after a later release.
        const onThatHold = currentSamples(await deps.sampleVersions(ctx.tenantId, batchId), { batchId, heldAt: holdHeldAt }).find((s) => s.sampleId === sampleId);
        if (onThatHold !== undefined && onThatHold.result === result && onThatHold.test === test) {
          return { status: 200, body: { batchId, sampleId, sample: onThatHold, alreadyRecorded: true } };
        }
        // Hard rule #10: head office moved on while the store was offline — said by name, never written over.
        if (hold.status === 'released') {
          throw apiError(422, {
            code: 'batch_no_longer_held',
            whatHappened: `Batch ${batchId} was already released by ${hold.releasedBy ?? 'someone'}${hold.releasedAt === undefined ? '' : ` at ${hold.releasedAt}`}, so the ${result.toUpperCase()} result of "${test}" recorded at the store by ${recordedBy} at ${at} is not added to its hold.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Kept at the store for a person to compare. If the result matters (a FAIL above all), place a new hold at head office and record it there.',
          });
        }
        if (hold.heldAt !== holdHeldAt) {
          throw apiError(422, {
            code: 'hold_changed_since',
            whatHappened: `The store recorded sample ${sampleId} on batch ${batchId}'s hold placed at ${holdHeldAt}, but the hold head office has now was placed at ${hold.heldAt} — the batch was released and held again since.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Kept at the store for a person to compare. Record the sample again on the hold in force now.',
          });
        }
        // The person recording is re-checked HERE, from their own grants — the box's word is never their authority.
        const held = await deps.permissionsOfUser(ctx.tenantId, recordedBy);
        if (held === undefined || !held.includes('quality.hold.manage')) {
          throw apiError(422, {
            code: held === undefined ? 'recorder_unknown_at_head_office' : 'recorder_lacks_authority',
            whatHappened: `${recordedBy} ${held === undefined ? 'is not anyone head office knows' : 'does not hold the right to record quality samples (quality.hold.manage)'}, so the sample on batch ${batchId} is not recorded in their name.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'The batch stays held and is not sold. Someone who may record samples must take and record it again.',
          });
        }
        const current = currentSamples(await deps.sampleVersions(ctx.tenantId, batchId), hold).find((s) => s.sampleId === sampleId);
        const judged = judgeSample(current, {
          batchId, sampleId, holdHeldAt: hold.heldAt, test, result, takenAt: new Date(Date.parse(b['takenAt'] as string)).toISOString(),
          notes: typeof b['notes'] === 'string' ? b['notes'] : undefined, recordedBy, recordedAt: at,
        });
        if (judged.kind === 'refuse') {
          throw apiError(422, { code: judged.code, whatHappened: judged.what, wasItSaved: 'not_saved', nextSafeAction: 'Kept at the store for a person to look at. A re-test is recorded under a new sample id. Nothing was changed.' });
        }
        if (judged.kind === 'same') return { status: 200, body: { batchId, sampleId, sample: judged.sample, alreadyRecorded: true } };
        await deps.recordSample(ctx.tenantId, judged.sample);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: recordedBy, action: 'quality.sample.record', objectType: 'quality_sample', objectId: `${batchId}/${sampleId}`, at,
          origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null, capturedOffline: true },
          before: judged.before === undefined ? null : { result: judged.before.result, version: String(judged.before.version) },
          after: { test, result, version: String(judged.sample.version), relayedBy: ctx.userId, source: isStr(b['source']) ? b['source'] : 'unknown', storeId: isStr(b['storeId']) ? b['storeId'] : '' },
          correlationId: `quality-hold:${batchId}`,
        });
        return { status: 202, body: { batchId, sampleId, sample: judged.sample, alreadyRecorded: false, relayedBy: ctx.userId } };
      },
    },
    {
      // Body: { batchId (= path), storeId, releasedBy, at, samples?, samplesRecordedHere?, coldChain?, expiresOn?, notes?, source? }. Idempotent:
      // the same release again is 200, one release.
      api: 'API-04', method: 'POST', path: '/v1/quality/holds/:batchId/release/synced',
      permission: 'quality.hold.release.sync', idempotent: true,
      handler: async (ctx) => {
        const batchId = (ctx.params['batchId'] ?? '').trim();
        const b = asObj(ctx.body);
        if (batchId === '' || b['batchId'] !== batchId || !isStr(b['releasedBy']) || !isIsoTime(b['at'])
          || (b['samples'] !== undefined && !Array.isArray(b['samples'])) || (b['expiresOn'] !== undefined && !isStr(b['expiresOn']))
          || (b['notes'] !== undefined && typeof b['notes'] !== 'string') || (b['samplesRecordedHere'] !== undefined && !isSampleRefs(b['samplesRecordedHere']))) {
          throw apiError(400, {
            code: 'not_readable_as_a_relayed_release',
            whatHappened: 'This could not be read as a quality-hold release from the store — it needs the batchId matching the path, who released it (releasedBy) and when (at).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Do not discard it at the store. Keep it in the queue and raise it.',
          });
        }
        // M10-FR-02: a relayed release never carries its own samples — they are recorded on the hold at head office.
        if (sentSamples(b['samples'])) throw apiError(422, { ...SAMPLES_NOT_IN_A_RELEASE, nextSafeAction: 'Kept at the store for a person to look at. Nothing was released.' });
        const releasedBy = (b['releasedBy'] as string).trim();
        const at = new Date(Date.parse(b['at'] as string)).toISOString();
        const hold = await deps.hold(ctx.tenantId, batchId);
        if (hold === undefined) {
          // Holds are placed only at head office: a release of a batch it never held is not a release of anything.
          throw apiError(422, {
            code: 'no_hold_on_record',
            whatHappened: `Head office holds no quality hold on batch ${batchId}, so there is nothing to release.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Kept at the store for a person to look at. A hold is placed only at head office.',
          });
        }
        if (hold.status === 'released') {
          if (hold.releasedBy === releasedBy) return { status: 200, body: { batchId, released: true, releasedBy, alreadyReleased: true } };
          throw apiError(422, {
            code: 'batch_released_by_another',
            whatHappened: `Batch ${batchId} was already released by ${hold.releasedBy ?? 'someone'}${hold.releasedAt === undefined ? '' : ` at ${hold.releasedAt}`}; this store says ${releasedBy} released it.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Kept at the store for a person to compare. Nothing was changed.',
          });
        }
        // OB-333: the person releasing is re-checked HERE, from their own grants — the box's word is never their authority.
        const held = await deps.permissionsOfUser(ctx.tenantId, releasedBy);
        if (held === undefined || !held.includes('quality.hold.release')) {
          throw apiError(422, {
            code: held === undefined ? 'releaser_unknown_at_head_office' : 'releaser_lacks_authority',
            whatHappened: `${releasedBy} ${held === undefined ? 'is not anyone head office knows' : 'does not hold the quality-release right (quality.hold.release)'}, so batch ${batchId} is not released in their name.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'The batch stays held and is not sold. Someone who may release for sale must look at it.',
          });
        }
        const recorded = currentSamples(await deps.sampleVersions(ctx.tenantId, batchId), hold);
        // M10-FR-02 offline: a release decided on a sample recorded at the store waits for that sample to reach this hold.
        // The store computer relays the sample first; if this release overtakes it (a lost reply, a blip mid-pass), it is
        // 425 — kept and sent again — never judged without its sample and refused for want of it. Only ids and results ride:
        // the release is still judged on the results head office holds, never on the store's word. A sample head office
        // holds only as PENDING, where the store saw its final result, is not here yet either (the result is on its way).
        const notYetHere = (isSampleRefs(b['samplesRecordedHere']) ? b['samplesRecordedHere'] : [])
          .filter((r) => { const s = recorded.find((x) => x.sampleId === r.sampleId); return s === undefined || (s.result === 'pending' && r.result !== 'pending'); })
          .map((r) => r.sampleId);
        if (notYetHere.length > 0) {
          throw apiError(425, {
            code: 'samples_not_yet_at_head_office',
            whatHappened: `The release of batch ${batchId} was decided on sample${notYetHere.length === 1 ? '' : 's'} ${notYetHere.join(', ')} recorded at the store, which head office does not hold on this hold yet.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Kept at the store and sent again after the sample arrives. The batch stays held until then.',
          });
        }
        const result: QualityReleaseResult = releaseFromQualityHold({
          hold,
          samples: recorded,
          coldChain: (b['coldChain'] ?? undefined) as ColdChainAssessment | undefined,
          expiresOn: isStr(b['expiresOn']) ? (b['expiresOn'] as string) : undefined,
          releasedBy, at,
          // OB-513: the same rule as the direct release — a held food batch needs a recorded sample first.
          ...await (async () => { const rule = await sampleRuleFor(deps, ctx.tenantId, hold); return rule.required ? { sampleRequired: rule.detail } : {}; })(),
        });
        if (!result.released) {
          const map = REFUSAL[result.outcome as Exclude<ReleaseRefusal, 'released'>];
          throw apiError(422, {
            code: result.outcome, whatHappened: usable(result.detail) ? result.detail : map.what, wasItSaved: 'not_saved',
            nextSafeAction: `${map.next} (Kept at the store as a visible exception.)`,
          });
        }
        await deps.recordReleased(ctx.tenantId, result.hold, `synced:${batchId}:${releasedBy}`);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: releasedBy, action: 'quality.hold.release', objectType: 'quality_hold', objectId: batchId, at,
          origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null, capturedOffline: true },
          before: { status: hold.status }, after: { status: 'released', relayedBy: ctx.userId, source: isStr(b['source']) ? b['source'] : 'unknown', storeId: isStr(b['storeId']) ? b['storeId'] : '' },
          ...(typeof b['notes'] === 'string' && b['notes'].trim() !== '' ? { reason: b['notes'] } : {}), correlationId: `quality-hold:${batchId}`,
        });
        return { status: 202, body: { batchId, released: true, releasedBy, alreadyReleased: false, relayedBy: ctx.userId } };
      },
    },
    {
      // What the store computer may release with the line down: the batches head office holds NOW (a read; the box's feed).
      api: 'API-04', method: 'GET', path: '/v1/quality/holds-for-release',
      permission: 'quality.hold.release.sync',
      handler: async (ctx) => {
        const open = [...(await deps.holds(ctx.tenantId))].filter((h) => h.status !== 'released').sort(byUrgency);
        // M10-FR-02: each held batch carries its recorded samples, so the screen that releases it shows what was found.
        const held = await Promise.all(open.map(async (h) => ({
          batchId: h.batchId, productId: h.productId, reason: h.reason, heldAt: h.heldAt, heldBy: h.heldBy,
          samples: currentSamples(await deps.sampleVersions(ctx.tenantId, h.batchId), h)
            .map((s) => ({ sampleId: s.sampleId, test: s.test, result: s.result, takenBy: s.takenBy, takenAt: s.takenAt, recordedBy: s.recordedBy, recordedAt: s.recordedAt })),
          // OB-513: whether this hold needs a recorded sample before release, and why — so the screen can say it offline.
          sampleRule: await sampleRuleFor(deps, ctx.tenantId, h),
        })));
        return { status: 200, body: { holds: held, count: held.length, asAt: deps.now() } };
      },
    },
  ];
}
