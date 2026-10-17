// R2 gap lane 1 (till enforcement) — head office's wiring for the till's legal gates (roadmap v2.1 B6 · B14 · B19).
//
//   • The weighing-scale register (B6 · B7): each scale's Legal Metrology fields and the lanes it weighs for, append-only
//     on its own stream (hard rules #2, #6) — every change a new version with who and when, audited.
//   • The store pack's `weighingScales` section: the register for one store, carried signed to its store computer so a
//     lane refuses a weighed line when its scale stamp has lapsed — with no network (hard rule #1).
//
// B14 and B19 need no register of their own: the tobacco pack size and the carry-bag / plastic facts are the product
// master's (`safety`), and they reach the lane in the signed catalogue pack's `regulatedFlags`.

import { makeEvent } from '../../../packages/contracts/src/event';
import type { EventStore } from '../../../packages/persistence/src/event-store';
import type { Route } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import {
  scaleRegisterRoutes, foldScaleRegister, weighingScalesSection, type ScaleRegisterDeps, type WeighingScaleRecord,
} from '../../platform/src/scale-register';
import { STREAM, streamName, orgStructureAdapter, saleStockLocationOf, approvalRequestsAdapter } from './adapters';
import type { IncomingSale } from '../../pos/src/index';

const SCALES = streamName(STREAM.facilities, 'weighing-scales');
const SCALE_SET = 'WeighingScaleSet';

/** The register on head office's event store: one event per version, never edited. */
export function scaleRegisterAdapter(input: { readonly store: EventStore; readonly now: () => string }): Pick<ScaleRegisterDeps, 'scaleVersions' | 'recordScale'> {
  return {
    scaleVersions: async (tenantId) => (await input.store.readStream(tenantId, SCALES, { type: SCALE_SET })).map((e) => e.event.payload as WeighingScaleRecord),
    recordScale: async (tenantId, r) => {
      await input.store.append(tenantId, SCALES, makeEvent({
        id: `weighing-scale-${r.assetId}-v${r.version}`, type: SCALE_SET, occurredAt: r.setAt,
        // One version per scale per number: a resend of the same version is the same fact (hard rule #10).
        idempotencyKey: `weighing-scale-${tenantId}-${r.assetId}-v${r.version}`, source: 'api/platform', payload: r,
      }));
    },
  };
}

/** The store pack's `weighingScales` section for one store, or undefined when head office holds no scale for it. */
export async function weighingScalesSectionFor(store: EventStore, now: () => string, tenantId: string, storeId: string): Promise<readonly Record<string, unknown>[] | undefined> {
  const section = weighingScalesSection(foldScaleRegister(await scaleRegisterAdapter({ store, now }).scaleVersions(tenantId)), storeId);
  // Left out when there is nothing: the store computer then says it was not told, and sells nothing by weight (B6).
  return section.length === 0 ? undefined : section;
}

/** The routes this lane adds to head office, composed from its store (or held in memory when there is none). */
export function r2TillRoutes(input: {
  readonly store: EventStore | undefined;
  readonly now: () => string;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
}): readonly Route[] {
  const { store, now } = input;
  if (store === undefined) {
    const held = new Map<string, WeighingScaleRecord[]>();
    return scaleRegisterRoutes({
      now,
      scaleVersions: async (t) => held.get(t) ?? [],
      recordScale: async (t, r) => { held.set(t, [...(held.get(t) ?? []), r]); },
    });
  }
  return scaleRegisterRoutes({
    now,
    ...scaleRegisterAdapter({ store, now }),
    stores: async (t) => new Map((await orgStructureAdapter({ store, now }).nodes(t)).filter((n) => n.kind === 'branch').map((n) => [n.nodeId, n.name] as const)),
    ...(input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit }),
    // L2: a changed stamp date is approved by a second person on head office's maker-checker engine (ADR-0024).
    approvals: approvalRequestsAdapter({ store, now }),
  });
}

/**
 * L3 (B6): the scales head office's OWN register says weigh for a sale's lane, in the sale's store — what intake judges a
 * weighed line by (`services/pos/src/sale-intake.ts`), rather than the till's claim. `undefined` while head office holds
 * no scale at all for that store (the register is not set up there yet): the till's evidence is then judged, as before.
 */
export function scalesOnRegisterAdapter(input: { readonly store: EventStore; readonly now: () => string }): (tenantId: string, sale: IncomingSale) => Promise<readonly { readonly assetId: string; readonly reverificationDueOn: string }[] | undefined> {
  return async (tenantId, sale) => {
    const register = foldScaleRegister(await scaleRegisterAdapter(input).scaleVersions(tenantId));
    if (register.length === 0) return undefined;
    const { locationId } = await saleStockLocationOf(input.store, tenantId, sale);
    const inStore = register.filter((s) => s.storeId === locationId);
    if (inStore.length === 0) return undefined;
    return inStore.filter((s) => s.laneIds.includes(sale.laneId)).map((s) => ({ assetId: s.assetId, reverificationDueOn: s.reverificationDueOn }));
  };
}
