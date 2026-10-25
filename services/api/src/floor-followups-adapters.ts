// OB-288 floor-device follow-ups — head office's wiring for the owner's decisions of 25 Oct 2026 (OB-373 to OB-379) that
// need a register the shared adapters do not already give. Kept in its own file: main.ts carries only registration lines.
//
//   • queueTillHandhelds     — OB-376: the handhelds head office registered at each store, so the till-prefix route can
//                              issue a handheld queue till's lane (`device:<id>`) its own bill-number prefix — and refuse
//                              a device that is not one.
//   • floorDeviceSettings*   — OB-375 · OB-378: the owner's price-kiosk "stop quoting after" minutes and self-checkout watch
//                              numbers — owner-only, append-only, audited — and the store pack's policies that carry them.
//   • billCopies*            — OB-373: every copy of a bill a till printed by its number (a handheld's bill above all),
//                              relayed by the store computer and kept for ever.

import { InMemoryEventStore, type EventStore } from '../../../packages/persistence/src/event-store';
import { makeEvent } from '../../../packages/contracts/src/event';
import type { Route } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { deviceRegistryAdapter, permissionsHeldBy, STREAM, streamName } from './adapters';
import {
  floorDeviceSettingRoutes, floorDevicePackPolicies, type FloorDeviceSetting, type FloorDeviceSettingsDeps,
} from '../../pos/src/floor-device-settings';
import { billCopyRoutes, type BillCopyRecord, type BillCopyDeps } from '../../pos/src/bill-copies';

interface Base { readonly store: EventStore; readonly now: () => string }
type Recorder = (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;

/** OB-376: every handheld head office registered at a store (not retired) — a queue till's lane is `device:<deviceId>`. */
export function queueTillHandhelds(input: Base): (tenantId: string) => Promise<readonly { readonly storeId: string; readonly deviceId: string; readonly label?: string }[]> {
  return async (tenantId) => (await deviceRegistryAdapter(input).fleet(tenantId))
    .filter((d) => d.kind === 'handheld' && d.status !== 'retired' && d.branchId !== '')
    .map((d) => ({ storeId: d.branchId, deviceId: d.deviceId, ...(d.label === '' ? {} : { label: d.label }) }));
}

// ── OB-375 · OB-378: the owner's numbers for the price kiosk and the self-checkout watch ─────────────────────────────

/** Where head office keeps the owner's floor-device settings (one append-only stream per shop). */
export const floorDeviceSettingsStream = (): string => streamName(STREAM.platform, 'floor-device-settings');

export function floorDeviceSettingsAdapter(input: Base & { readonly recordAudit?: Recorder }): FloorDeviceSettingsDeps {
  const { store, now } = input;
  return {
    now,
    settings: async (t) => (await store.readStream(t, floorDeviceSettingsStream(), { type: 'FloorDeviceSettingRecorded' })).map((e) => e.event.payload as unknown as FloorDeviceSetting),
    record: async (t, s, key) => {
      await store.append(t, floorDeviceSettingsStream(), makeEvent({
        id: `floor-device-setting-${s.setting}-${s.version}`, type: 'FloorDeviceSettingRecorded', occurredAt: s.setAt,
        idempotencyKey: `floor-device-setting-${t}-${s.setting}-${s.version}-${key}`.slice(0, 250), source: 'api/pos', payload: s as unknown as Record<string, unknown>,
      }));
    },
    ...(input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit }),
  };
}

/** The owner's floor-device settings routes (read, and the owner's own set). */
export function floorDeviceSettingRoutesFor(input: { readonly store: EventStore | undefined; readonly now: () => string; readonly recordAudit?: Recorder }): readonly Route[] {
  return floorDeviceSettingRoutes(floorDeviceSettingsAdapter({ store: input.store ?? new InMemoryEventStore(), now: input.now, ...(input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit }) }));
}

/** The store pack's floor-device policies (the kiosk's minutes, the watch numbers) — for `buildStorePackSections`. */
export function floorDevicePackPoliciesOf(input: Base): (tenantId: string) => Promise<Record<string, unknown>> {
  const deps = floorDeviceSettingsAdapter(input);
  return async (tenantId) => floorDevicePackPolicies(await deps.settings(tenantId));
}

// ── OB-373: copies of a bill printed by its number ──────────────────────────────────────────────────────────────────

export const billCopiesStream = (): string => streamName(STREAM.sales, 'bill-copies');

export function billCopiesAdapter(input: Base): BillCopyDeps {
  const { store, now } = input;
  return {
    now,
    copies: async (t) => (await store.readStream(t, billCopiesStream(), { type: 'BillCopyKept' })).map((e) => e.event.payload as unknown as BillCopyRecord),
    record: async (t, r) => {
      const key = r.copyId.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 180);
      await store.append(t, billCopiesStream(), makeEvent({
        id: `bill-copy-${key}`, type: 'BillCopyKept', occurredAt: r.at, idempotencyKey: `bill-copy-${t}-${key}`, source: 'api/pos', payload: r as unknown as Record<string, unknown>,
      }));
    },
    permissionsOf: (t, u) => permissionsHeldBy(store, t, u),
  };
}

export function billCopyRoutesFor(input: { readonly store: EventStore | undefined; readonly now: () => string }): readonly Route[] {
  return billCopyRoutes(billCopiesAdapter({ store: input.store ?? new InMemoryEventStore(), now: input.now }));
}
