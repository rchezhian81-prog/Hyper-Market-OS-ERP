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
}

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
  cold_chain_breach: { status: 422, what: 'A cold-chain breach is on record for this batch, so it cannot be released for sale.', next: 'The batch stays held. A cold-chain breach cannot be released — the incident and evidence stand (M10-FR-04).' },
  expired: { status: 422, what: 'This batch has passed its expiry date, so it can never be released.', next: 'The batch has expired and can never be released — route it to disposal (M28).' },
  no_releaser: { status: 422, what: 'A release arrived without the name of the person making it.', next: 'A release must carry the name of the person making it — sign in and release again.' },
};

const usable = (s: string | undefined): s is string => typeof s === 'string' && s.trim().length >= 10;

export function qualityHoldRoutes(deps: QualityHoldDeps): readonly Route[] {
  return [
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
        const samples = Array.isArray(b['samples']) ? (b['samples'] as QualitySample[]) : [];
        const coldChain = (b['coldChain'] ?? undefined) as ColdChainAssessment | undefined;
        const expiresOn = isStr(b['expiresOn']) ? (b['expiresOn'] as string) : undefined;

        const result: QualityReleaseResult = releaseFromQualityHold({
          hold, samples, coldChain, expiresOn, releasedBy: ctx.userId, at: deps.now(),
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
        return { status: 200, body: { release: result } };
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
        return { status: 200, body: { hold } };
      },
    },
  ];
}
