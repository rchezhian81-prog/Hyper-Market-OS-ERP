// The production screen's DURABLE QUEUE through the store computer — OB-288 lane 2 · P2 (M11-FR-01/02/03 · §31 · P-01 ·
// P-08 · hard rules #6 #10).
//
// "Offline (§31): production capture queue-capable; reconciled on sync" · "weight capture offline; costing reconciles
// online" · "labelling/packing works at the counter offline". When the store computer serves this screen, what the kitchen
// does here is written to THIS device's durable queue before the screen says "saved", handed to the store computer (which
// keeps it on its own disk) and carried to head office when the line is up — the same device → box → head office path the
// floor indents and the shelf counts take. Head office then books it with its own rules (the recipe, the stock, the cost,
// the use-by) and re-checks each person; anything it cannot accept comes back REFUSED with its reason, shown here, never
// dropped and never quietly retried. A counter label is rendered by the store computer itself from what it holds.
//
// Nothing here decides a rule: a run is the cook's word on what was made; a release is the QC person's decision (head
// office refuses one by somebody without the release right); a weigh is the scale's grams — the cost is head office's.
// DOM-free and tested; the shell renders what this hands over.

import { makeEvent } from '../../../packages/contracts/src/event';
import type { SyncOutbox } from '../../../packages/sync/src/outbox';
import { deviceItemState, deviceItemReason, type BoxItemStatus, type DeviceItemState } from '../../../packages/sync/src/device-relay';
import type { RunCommitPort, LabelPort, TaskPostResult } from './production-tasks-session';
import type { ReleasePort, ReleaseResult } from './production-session';

export const PRODUCTION_RUN_CAPTURED = 'ProductionRunCaptured';
export const PRODUCTION_RELEASE_DECIDED = 'ProductionReleaseDecided';
export const WEIGHED_RUN_CAPTURED = 'WeighedRunCaptured';
export const productionRunKey = (runId: string): string => `run:${runId}`;
export const productionReleaseKey = (runId: string): string => `release:${runId}`;
export const weighedRunKey = (runId: string): string => `weighed:${runId}`;
/** The box's own counter-label door (edge/store-edge/src/screen-server.ts `PRODUCTION_LABEL_PATH`). */
export const PRODUCTION_LABEL_DOOR = '/production/label';

const QUEUED_TYPES = new Set([PRODUCTION_RUN_CAPTURED, PRODUCTION_RELEASE_DECIDED, WEIGHED_RUN_CAPTURED]);

export interface ProductionQueueConfig {
  /** Who is at the screen — the person the store computer verified. `null` → nothing is saved in nobody's name. */
  readonly userId: string | null;
  readonly storeId: string | null;
  readonly now: () => string;
  /** A fresh id on this device; injected for tests. */
  readonly freshId?: (prefix: string) => string;
  /**
   * Round 7 · OB-502 (M25-FR-03): the store computer's judgement of the signed-in person's food-handling certificate (from
   * the signed pack). When it is not valid, no run and no weigh is saved in their name — refused here in those words (the
   * box's door and head office refuse it too). Absent → not judged on this screen.
   */
  readonly foodHandling?: { readonly allowed: boolean; readonly words?: { readonly en: string; readonly ta: string } } | null;
}

export interface WeighedCaptureInput {
  readonly departmentId: string;
  /** What went in: one product and its weight in whole grams. */
  readonly inputProductId: string;
  readonly inputGrams: string;
  /** What came out to sell, and any by-product (bone, trim) — whole grams. */
  readonly outputProductId: string;
  readonly outputGrams: string;
  readonly byproductProductId?: string;
  readonly byproductGrams?: string;
}

export type WeighedOutcome =
  | { readonly outcome: 'saved'; readonly runId: string }
  | { readonly outcome: 'nobody' | 'no_store' | 'missing' | 'bad_weight' | 'more_out_than_in' }
  /** OB-502: the person's food-handling certificate expired or is missing — in the store computer's own words. */
  | { readonly outcome: 'certificate'; readonly words: { readonly en: string; readonly ta: string } };

/** One piece of production work this screen saved, and where it has got to (the five shared device states). */
export interface SavedProductionWork {
  readonly key: string;
  readonly kind: 'run' | 'release' | 'hold' | 'weighed';
  readonly id: string;
  readonly detail: string;
  readonly at: string;
  readonly state: DeviceItemState;
  readonly attempts: number;
  readonly reason?: string;
}

export interface ProductionQueue {
  /** The run port the tasks session records through — saved on this device, then carried by the store computer. */
  runPort(): RunCommitPort;
  /** The release port the release desk decides through — saved here; head office applies it (or refuses it by name). */
  releasePort(): ReleasePort;
  recordWeighed(input: WeighedCaptureInput): WeighedOutcome;
  savedWork(): readonly SavedProductionWork[];
  handedKeys(): readonly string[];
  noteBoxStatus(statuses: readonly BoxItemStatus[]): void;
}

const wholeGrams = (raw: string | undefined): number | undefined => (raw !== undefined && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : undefined);
let counter = 0;
const defaultFreshId = (prefix: string): string => {
  const uuid = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID?.();
  counter += 1;
  return uuid === undefined ? `${prefix}-${Date.now()}-${counter}` : `${prefix}-${uuid.slice(0, 12)}`;
};

export function createProductionQueue(config: ProductionQueueConfig, outbox: SyncOutbox, boxWords: Map<string, BoxItemStatus> = new Map()): ProductionQueue {
  const freshId = config.freshId ?? defaultFreshId;
  const enqueue = (type: string, key: string, payload: Record<string, unknown>, at: string): void => {
    outbox.enqueue(makeEvent({ id: key, type, occurredAt: at, idempotencyKey: key, source: 'web-erp/production', payload }));
  };
  return {
    runPort: () => ({
      post: async (input): Promise<TaskPostResult<{ runId: string }>> => {
        if (config.userId === null || config.storeId === null) return { result: 'refused', reason: 'this store computer has not said who is at the screen and which store it is' };
        if (config.foodHandling !== undefined && config.foodHandling !== null && !config.foodHandling.allowed) return { result: 'refused', reason: config.foodHandling.words?.en ?? 'the food-handling certificate is not valid' };
        const key = productionRunKey(input.runId);
        // The same run id already saved here is the same run (§31.1): nothing is queued twice.
        if (outbox.find(key) === undefined) {
          const at = config.now();
          enqueue(PRODUCTION_RUN_CAPTURED, key, {
            runId: input.runId, storeId: config.storeId, recipeId: input.recipeId, batches: input.batches, actualOutputMinor: input.actualOutputMinor,
            outputBatchId: input.outputBatchId, locationId: input.locationId, producedBy: config.userId, at, source: 'production-screen',
          }, at);
        }
        return { result: 'done', value: { runId: input.runId } };
      },
    }),
    releasePort: () => ({
      post: async ({ runId, qcPassed, notes }): Promise<ReleaseResult> => {
        if (config.userId === null || config.storeId === null) return 'refused';
        const key = productionReleaseKey(runId);
        if (outbox.find(key) === undefined) {
          const at = config.now();
          enqueue(PRODUCTION_RELEASE_DECIDED, key, { runId, storeId: config.storeId, qcPassed, releasedBy: config.userId, at, ...(notes === undefined ? {} : { notes }), source: 'production-screen' }, at);
        }
        return 'saved';
      },
    }),
    recordWeighed: (input) => {
      if (config.userId === null) return { outcome: 'nobody' };
      if (config.storeId === null) return { outcome: 'no_store' };
      if (config.foodHandling !== undefined && config.foodHandling !== null && !config.foodHandling.allowed) {
        return { outcome: 'certificate', words: config.foodHandling.words ?? { en: 'The food-handling certificate is not valid. Nothing was saved.', ta: 'உணவு கையாளும் சான்றிதழ் செல்லுபடியாகவில்லை. எதுவும் சேமிக்கப்படவில்லை.' } };
      }
      const dept = input.departmentId.trim(); const inId = input.inputProductId.trim(); const outId = input.outputProductId.trim();
      if (dept === '' || inId === '' || outId === '') return { outcome: 'missing' };
      const inG = wholeGrams(input.inputGrams); const outG = wholeGrams(input.outputGrams);
      const byId = (input.byproductProductId ?? '').trim(); const byG = byId === '' ? 0 : wholeGrams(input.byproductGrams);
      if (inG === undefined || inG <= 0 || outG === undefined || byG === undefined) return { outcome: 'bad_weight' };
      // The scale cannot make meat: more out than in is a mis-weigh, caught before it is saved.
      if (outG + byG > inG) return { outcome: 'more_out_than_in' };
      const runId = freshId('weigh');
      const at = config.now();
      enqueue(WEIGHED_RUN_CAPTURED, weighedRunKey(runId), {
        runId, storeId: config.storeId, departmentId: dept, inputs: [{ productId: inId, weightGrams: inG }],
        outputs: [{ productId: outId, weightGrams: outG }, ...(byId === '' ? [] : [{ productId: byId, weightGrams: byG, isByproduct: true }])],
        weighedBy: config.userId, at, source: 'production-screen',
      }, at);
      return { outcome: 'saved', runId };
    },
    savedWork: () => outbox.all()
      .filter((i) => QUEUED_TYPES.has(i.event.type))
      .map((item): SavedProductionWork => {
        const p = item.event.payload as Record<string, unknown>;
        const box = boxWords.get(item.key);
        const reason = deviceItemReason(item, box);
        const kind: SavedProductionWork['kind'] = item.event.type === PRODUCTION_RUN_CAPTURED ? 'run'
          : item.event.type === WEIGHED_RUN_CAPTURED ? 'weighed' : p['qcPassed'] === true ? 'release' : 'hold';
        const detail = kind === 'run' ? `${String(p['recipeId'])} · ${String(p['outputBatchId'])} · ${String(p['actualOutputMinor'])}`
          : kind === 'weighed' ? `${String((p['inputs'] as { productId: string; weightGrams: number }[])[0]?.productId)} ${String((p['inputs'] as { weightGrams: number }[])[0]?.weightGrams)} g`
            : String(p['runId']);
        return { key: item.key, kind, id: String(p['runId']), detail, at: String(p['at']), state: deviceItemState(item, box), attempts: item.attempts, ...(reason === undefined ? {} : { reason }) };
      })
      .reverse(),
    handedKeys: () => outbox.all().filter((i) => QUEUED_TYPES.has(i.event.type) && i.state === 'acknowledged').map((i) => i.key),
    noteBoxStatus: (statuses) => { for (const s of statuses) boxWords.set(s.key, s); },
  };
}

/** The counter label, rendered by the store computer from what it holds (no head-office call — works with the cable out). */
export function openBoxLabelPort(fetchFn: typeof fetch | undefined, door: string = PRODUCTION_LABEL_DOOR): LabelPort {
  return {
    post: async (input): Promise<TaskPostResult<{ lines: readonly string[] }>> => {
      if (fetchFn === undefined) return { result: 'lost_link' };
      try {
        const res = await fetchFn(door, {
          method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ runId: input.runId, netQuantity: input.netQuantity, packerDetails: input.packerDetails, ...(input.weightGrams === undefined ? {} : { weightGrams: input.weightGrams }), ...(input.allergens === undefined ? {} : { allergens: input.allergens }), ...(input.vegClass === undefined ? {} : { vegClass: input.vegClass }) }),
        });
        const body = (await res.json().catch(() => ({}))) as { ok?: boolean; lines?: unknown; detail?: unknown };
        if (res.status === 200 && body.ok === true) return { result: 'done', value: { lines: Array.isArray(body.lines) ? body.lines.filter((l): l is string => typeof l === 'string') : [] } };
        return { result: 'refused', reason: typeof body.detail === 'string' ? body.detail : 'the store computer did not make the label' };
      } catch {
        return { result: 'lost_link' };
      }
    },
  };
}
