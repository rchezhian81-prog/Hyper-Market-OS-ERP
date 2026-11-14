// The shelf labels' connection row, read from the ledger and laid beside the registered adapters (U6 · §27 "label/ESL").
// The integration routes keep their deps; this wraps `adapters` and `heartbeats` so `GET /v1/integration/health` judges
// the labels with the same rule as every other connection (M32-FR-04). Derived at read time — nothing is written.

import type { EventStore } from '../../../packages/persistence/src/event-store';
import type { IntegrationDeps } from '../../platform/src/integration';
import { shelfLabelsIntegration } from '../../platform/src/esl-integration';
import type { FloorDeviceLogEntry, StoredFloorEvent, EslPush } from '../../platform/src/device-events';
import { STREAM, streamName } from './adapters';

// The same streams the floor-device adapter writes (floor-devices-adapters.ts keeps them private; the names are its contract).
const DEVICES_STREAM = streamName(STREAM.platform, 'floor-devices');
const EVENTS_STREAM = streamName(STREAM.platform, 'floor-device-events');
const PUSHES_STREAM = streamName(STREAM.platform, 'esl-pushes');

const payloads = async <T>(store: EventStore, tenantId: string, stream: string, type: string): Promise<T[]> =>
  (await store.readStream(tenantId, stream, { type })).map((e) => e.event.payload as T);

export function withShelfLabelsIntegration(deps: IntegrationDeps, store: EventStore): IntegrationDeps {
  const row = async (tenantId: string) => {
    const [log, pushes, events] = await Promise.all([
      payloads<FloorDeviceLogEntry>(store, tenantId, DEVICES_STREAM, 'FloorDeviceLogged'),
      payloads<EslPush>(store, tenantId, PUSHES_STREAM, 'EslPriceSent'),
      payloads<StoredFloorEvent>(store, tenantId, EVENTS_STREAM, 'FloorDeviceEventKept'),
    ]);
    return shelfLabelsIntegration({ tenantId, log, pushes, events, now: deps.now() });
  };
  return {
    ...deps,
    adapters: async (tenantId) => {
      const [registered, labels] = await Promise.all([deps.adapters(tenantId), row(tenantId)]);
      return labels.config === undefined ? registered : [...registered.filter((a) => a.adapterId !== labels.config!.adapterId), labels.config];
    },
    heartbeats: async (tenantId) => {
      const [recorded, labels] = await Promise.all([deps.heartbeats(tenantId), row(tenantId)]);
      return [...recorded, ...labels.heartbeats];
    },
  };
}
