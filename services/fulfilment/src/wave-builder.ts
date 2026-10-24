// API-08 — the dispatcher builds a picker's wave from CONFIRMED orders (M19-FR-01 · WF-14 · D09-FR-03 · OB-300 · OB-313 ·
// §28 · hard rules #2/#6/#10).
//
//   GET  /v1/fulfilment/wave-candidates?storeId=    the confirmed orders at a store not yet on a wave — and the ones the
//                                                   contribution rule holds for a manager, said so
//   POST /v1/fulfilment/waves/:waveId/build         { storeId, pickerId, orderIds[] } → the wave's lines from head office's
//                                                   own facts, handed to the picker on the SAME register the assignment
//                                                   route writes (the box pulls it for the picker's phone)
//   GET  /v1/fulfilment/wave-board?storeId=         every wave at the store and how far its picker has got
//
// The bin comes from the store's bin register and the price, name and unit from the store's catalogue pack — never typed.
// An order is never split (OB-300): an order with any line that has no bin or no price stays out of the wave whole, named
// with the reason. An order the contribution rule holds (OB-313) is refused until a manager approves it. An order already
// on another open wave is refused rather than picked twice. A single-order pick is a wave of one.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { planWave, pickBinFor, type BinContents, type WaveOrder, type WaveProduct } from '../../../packages/fulfilment/src/index';
import type { Bin } from '../../../packages/warehouse/src/movements';
import { assignmentDigest, latestWaves, requireAuthority, PICK_PERMISSION, type WaveAssignment } from './assignments';
import { latestOutcomes, type WaveLineOutcome } from './waves';
import { mayGoOut, type ContributionStanding } from './delivery-controls';

/** An order as the wave builder reads it: where it is held, its lines, its current state, how it reaches the customer. */
export interface CandidateOrder {
  readonly orderId: string;
  readonly locationId: string;
  readonly lines: readonly { readonly productId: string; readonly quantityMinor: number }[];
  readonly state: string;
  readonly fulfilment?: 'delivery' | 'pickup';
  readonly placedAt: string;
}

export interface WaveBuilderDeps {
  readonly permissionsOfUser: (tenantId: string, userId: string) => Promise<readonly string[] | undefined>;
  /** Every order placed at a store, with its current state. */
  readonly ordersAt: (tenantId: string, storeId: string) => Promise<readonly CandidateOrder[]>;
  readonly bins: (tenantId: string) => Promise<readonly Bin[]>;
  readonly binContents: (tenantId: string) => Promise<BinContents>;
  /** The products of the catalogue pack the store sells from; undefined when no pack is published. */
  readonly packProducts: (tenantId: string) => Promise<readonly WaveProduct[] | undefined>;
  readonly waveAssignments: (tenantId: string, storeId: string) => Promise<readonly WaveAssignment[]>;
  readonly recordWaveAssignment: (tenantId: string, a: WaveAssignment) => Promise<void>;
  readonly wavePacked: (tenantId: string, waveId: string) => Promise<boolean>;
  readonly lineOutcomes: (tenantId: string, waveId: string) => Promise<readonly WaveLineOutcome[]>;
  /** Where a delivery order stands under the contribution rule (OB-313). Collections are never held. */
  readonly standing: (tenantId: string, orderId: string) => Promise<ContributionStanding>;
  /** The delivery slot an order booked, when it is a delivery. */
  readonly slotOf: (tenantId: string, orderId: string) => Promise<{ readonly startsAt: string; readonly endsAt: string } | undefined>;
  readonly now: () => string;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** The order ids on a store's OPEN waves (not yet packed) — an order on one is not offered again. */
async function onOpenWaves(deps: WaveBuilderDeps, tenantId: string, storeId: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const w of latestWaves(await deps.waveAssignments(tenantId, storeId))) {
    if (await deps.wavePacked(tenantId, w.waveId)) continue;
    for (const l of w.lines) out.set(l.orderRef, w.waveId);
  }
  return out;
}

export function waveBuilderRoutes(deps: WaveBuilderDeps): readonly Route[] {
  const storeOf = (q: Readonly<Record<string, string>>): string => {
    const storeId = (q['storeId'] ?? '').trim();
    if (storeId === '') throw apiError(400, { code: 'store_needed', whatHappened: 'Say which store: ?storeId=.', wasItSaved: 'not_saved', nextSafeAction: 'Send the store. Nothing was changed.' });
    return storeId;
  };
  return [
    {
      api: 'API-08', method: 'GET', path: '/v1/fulfilment/wave-candidates',
      permission: 'fulfilment.wave.assign',
      handler: async (ctx) => {
        const storeId = storeOf(ctx.query);
        const open = await onOpenWaves(deps, ctx.tenantId, storeId);
        const ready: Record<string, unknown>[] = [];
        const held: Record<string, unknown>[] = [];
        const onWave: Record<string, unknown>[] = [];
        for (const o of await deps.ordersAt(ctx.tenantId, storeId)) {
          if (o.state !== 'confirmed') continue;
          const slot = o.fulfilment === 'delivery' ? await deps.slotOf(ctx.tenantId, o.orderId) : undefined;
          const standing: ContributionStanding = o.fulfilment === 'delivery' ? await deps.standing(ctx.tenantId, o.orderId) : 'clear';
          const row = { orderId: o.orderId, fulfilment: o.fulfilment ?? 'pickup', lineCount: o.lines.length, placedAt: o.placedAt, slot: slot ?? null, standing };
          if (open.has(o.orderId)) onWave.push({ ...row, waveId: open.get(o.orderId) });
          else if (!mayGoOut(standing)) held.push(row);
          else ready.push(row);
        }
        // Earliest slot first (a collection has none and goes by when it was placed).
        const when = (r: Record<string, unknown>): string => ((r['slot'] as { startsAt: string } | null)?.startsAt ?? (r['placedAt'] as string));
        ready.sort((a, b) => when(a).localeCompare(when(b)) || String(a['orderId']).localeCompare(String(b['orderId'])));
        return { status: 200, body: { storeId, ready, held, onWave, asAt: deps.now() } };
      },
    },
    {
      // Build a wave and hand it to a picker. Body: { storeId, pickerId, orderIds: [..] }.
      api: 'API-08', method: 'POST', path: '/v1/fulfilment/waves/:waveId/build',
      permission: 'fulfilment.wave.assign', idempotent: true,
      handler: async (ctx) => {
        const waveId = (ctx.params['waveId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const ids = b['orderIds'];
        if (waveId === '' || !isStr(b['storeId']) || !isStr(b['pickerId']) || !Array.isArray(ids) || ids.length === 0 || ids.length > 200 || !ids.every(isStr)) {
          throw apiError(400, {
            code: 'not_readable_as_a_wave_build',
            whatHappened: 'Building a wave needs the wave id in the path and { storeId, pickerId, orderIds: [one to 200 order ids] }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Choose the orders and the picker. Nothing was assigned.',
          });
        }
        const storeId = (b['storeId'] as string).trim();
        const pickerId = (b['pickerId'] as string).trim();
        await requireAuthority(deps, ctx.tenantId, pickerId, PICK_PERMISSION, 'picker');
        if (await deps.wavePacked(ctx.tenantId, waveId)) {
          throw apiError(409, { code: 'wave_already_packed', whatHappened: `Wave ${waveId} has already been packed, so it cannot be built again.`, wasItSaved: 'not_saved', nextSafeAction: 'Build the orders into a new wave id. Nothing was changed.' });
        }
        const products = await deps.packProducts(ctx.tenantId);
        if (products === undefined) {
          throw apiError(409, { code: 'no_catalogue_pack', whatHappened: 'No catalogue pack is published, so no line can be priced or named for the picker.', wasItSaved: 'not_saved', nextSafeAction: 'Publish the store\'s catalogue pack first. Nothing was assigned.' });
        }
        const all = new Map((await deps.ordersAt(ctx.tenantId, storeId)).map((o) => [o.orderId, o] as const));
        const open = await onOpenWaves(deps, ctx.tenantId, storeId);
        // Every order chosen is judged here first; only the ones that may be picked reach the wave plan.
        const blocked: { orderId: string; reason: string; detail: string }[] = [];
        const chosen: WaveOrder[] = [];
        for (const id of ids as string[]) {
          const o = all.get(id);
          if (o === undefined) { blocked.push({ orderId: id, reason: 'not_at_this_store', detail: `${id} is not an order placed at ${storeId}. It is picked where it is held — never split across stores (OB-300).` }); continue; }
          if (o.state !== 'confirmed') { blocked.push({ orderId: id, reason: 'not_confirmed', detail: `${id} is ${o.state}, not confirmed — only a confirmed order is picked.` }); continue; }
          const elsewhere = open.get(id);
          if (elsewhere !== undefined && elsewhere !== waveId) { blocked.push({ orderId: id, reason: 'on_another_wave', detail: `${id} is already on wave ${elsewhere}, which is not packed yet. It is never picked twice.` }); continue; }
          if (o.fulfilment === 'delivery') {
            const standing = await deps.standing(ctx.tenantId, id);
            if (!mayGoOut(standing)) { blocked.push({ orderId: id, reason: standing === 'held' ? 'held_for_manager' : 'declined_by_manager', detail: standing === 'held' ? `${id} contributes less than the owner's threshold; a manager must approve it before it is picked (OB-313).` : `${id} was declined by a manager under the contribution rule; it is not picked until the online store desk resolves it.` }); continue; }
          }
          chosen.push({ orderId: o.orderId, locationId: o.locationId, lines: o.lines });
        }
        const [bins, contents] = await Promise.all([deps.bins(ctx.tenantId), deps.binContents(ctx.tenantId)]);
        const byId = new Map(products.map((p) => [p.productId, p] as const));
        const plan = planWave({
          waveId, storeId, orders: chosen,
          binOf: (productId) => pickBinFor(productId, storeId, bins, contents),
          productOf: (productId) => byId.get(productId),
        });
        const refused = [...blocked, ...plan.refused.map((r) => ({ orderId: r.orderId, reason: r.reason, detail: r.detail, productIds: r.productIds }))];
        if (plan.lines.length === 0) {
          throw apiError(422, {
            code: 'nothing_to_pick', whatHappened: 'None of the chosen orders can go on this wave.', wasItSaved: 'not_saved',
            nextSafeAction: 'Read each order\'s reason, put it right, and build again. Nothing was assigned.', refused,
          } as Parameters<typeof apiError>[1]);
        }
        const lines = plan.lines;
        const digest = assignmentDigest({ pickerId, lines });
        const current = latestWaves(await deps.waveAssignments(ctx.tenantId, storeId)).find((a) => a.waveId === waveId);
        if (current !== undefined && current.digest === digest) {
          return { status: 200, body: { waveId, storeId, pickerId, orderIds: plan.orderIds, lineCount: lines.length, refused, assigned: true, alreadyAssigned: true } };
        }
        const now = deps.now();
        const record: WaveAssignment = { waveId, storeId, pickerId, lines, assignedBy: ctx.userId, at: now, digest };
        await deps.recordWaveAssignment(ctx.tenantId, record);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'fulfilment.wave.build', objectType: 'pick_wave', objectId: waveId,
          at: now, origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: current === undefined ? null : { pickerId: current.pickerId, lineCount: String(current.lines.length) },
          after: { storeId, pickerId, lineCount: String(lines.length), orderRefs: plan.orderIds.join(','), refused: refused.map((r) => `${r.orderId}:${r.reason}`).join(','), replaced: String(current !== undefined) },
          correlationId: waveId,
        });
        return { status: 201, body: { waveId, storeId, pickerId, orderIds: plan.orderIds, lineCount: lines.length, lines, refused, assigned: true, replaced: current !== undefined } };
      },
    },
    {
      // Every wave at the store and how far it has got — the dispatcher's progress view.
      api: 'API-08', method: 'GET', path: '/v1/fulfilment/wave-board',
      permission: 'fulfilment.wave.assign',
      handler: async (ctx) => {
        const storeId = storeOf(ctx.query);
        const waves: Record<string, unknown>[] = [];
        for (const w of latestWaves(await deps.waveAssignments(ctx.tenantId, storeId))) {
          const outcomes = latestOutcomes(await deps.lineOutcomes(ctx.tenantId, w.waveId));
          const count = (state: string): number => outcomes.filter((o) => o.state === state).length;
          const packed = await deps.wavePacked(ctx.tenantId, w.waveId);
          waves.push({
            waveId: w.waveId, pickerId: w.pickerId, assignedBy: w.assignedBy, assignedAt: w.at,
            orderIds: [...new Set(w.lines.map((l) => l.orderRef))], lineCount: w.lines.length,
            picked: count('picked'), short: count('short'), substituted: count('substituted'), qualityFailed: count('quality_failed'),
            notYet: w.lines.filter((l) => !outcomes.some((o) => o.lineId === l.lineId)).length,
            packed, stage: packed ? 'packed' : outcomes.length === 0 ? 'not_started' : 'picking',
          });
        }
        return { status: 200, body: { storeId, waves, asAt: deps.now() } };
      },
    },
  ];
}
