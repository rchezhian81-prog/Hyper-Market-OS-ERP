// The shelf labels' CONNECTION ROW (U6 · UI/UX gap audit §27 "Product — label/ESL … no integration row" · D14-FR-05 ·
// D06-FR-06 · M32-FR-04 · P-08 · hard rules #2 and #5).
//
// The Connections page (`GET /v1/integration/health`) judges every adapter by WHEN IT LAST WORKED. The electronic shelf
// labels are a device PORT, not a registered adapter: nobody registers "the labels" with a vault credential, the labels
// sign their own reports with their own keys (device-events.ts). So their row is DERIVED, at read time, from the facts head
// office already holds — never a second record of them (hard rule #2):
//   • the row exists once a label is registered at any branch (before that there is no connection to judge);
//   • it is `enabled` while at least one label is active (every label blocked or retired = switched off);
//   • its heartbeats are the price pushes (ok when the vendor took the price for every label of the product), the labels'
//     own echoes (ok — a label showed a price back) and the refused label reports (not ok);
//   • one more heartbeat is drawn "as of now": the latest push, judged — ok once every label echoed it back, NOT ok when
//     it is still unconfirmed after the echo grace. Without it a shop whose prices change twice a week would read "gone
//     quiet" every afternoon, which is noise, not control by exception (P-03).
// Nothing here changes a price, a label or a device; the vendor port stays a stand-in (HARDWARE_NOT_VERIFIED).

import type { AdapterConfig, AdapterHeartbeat } from '../../../packages/integration/src/adapters';
import { HARDWARE_NOT_VERIFIED } from '../../../packages/integration/src/floor-devices';
import { floorDevices, judgePush, type FloorDeviceLogEntry, type StoredFloorEvent, type EslPush, type FloorDeviceRecord } from './device-events';

/** The adapter id the Connections page shows for the labels. */
export const SHELF_LABELS_ADAPTER_ID = 'shelf-labels';
/** A label has this long to echo a price back before the row says the push is not confirmed. */
export const ESL_ECHO_GRACE_MINUTES = 15;

export interface ShelfLabelsIntegration {
  /** Absent when no label was ever registered — there is no connection to judge yet. */
  readonly config?: AdapterConfig;
  readonly heartbeats: readonly AdapterHeartbeat[];
  /** What the row rests on, said on the page. */
  readonly basis: string;
}

const rupees = (minor: number): string => `₹${(minor / 100).toFixed(2)}`;

/** The labels among the fleet, as registered (status included). */
export function shelfLabels(log: readonly FloorDeviceLogEntry[]): readonly FloorDeviceRecord[] {
  return floorDevices(log).filter((d) => d.binding.kind === 'esl_label');
}

export function shelfLabelsIntegration(input: {
  readonly tenantId: string;
  readonly log: readonly FloorDeviceLogEntry[];
  readonly pushes: readonly EslPush[];
  readonly events: readonly StoredFloorEvent[];
  readonly now: string;
}): ShelfLabelsIntegration {
  const labels = shelfLabels(input.log);
  if (labels.length === 0) return { heartbeats: [], basis: 'no electronic shelf label is registered — there is no label connection to judge yet' };
  const active = labels.filter((l) => l.status === 'active');
  const vendor = [...new Set(labels.map((l) => l.vendor))].sort().join(', ');
  const config: AdapterConfig = {
    adapterId: SHELF_LABELS_ADAPTER_ID, tenantId: input.tenantId, category: 'hardware', vendor,
    // The labels sign their reports with their own keys; head office holds no credential for them (hard rule #4). A
    // stand-in vendor is a sandbox until a real one is contracted and certified.
    environment: 'sandbox', credentialRef: 'vault://none (each label signs with its own key)', enabled: active.length > 0,
  };
  const heartbeats: AdapterHeartbeat[] = [];
  const pushes = [...input.pushes].sort((a, b) => a.at.localeCompare(b.at));
  for (const p of pushes) {
    const taken = p.commands.filter((c) => c.accepted).length;
    heartbeats.push({
      adapterId: SHELF_LABELS_ADAPTER_ID, at: p.at, ok: p.commands.length > 0 && taken === p.commands.length,
      detail: p.commands.length === 0 ? `price ${rupees(p.priceMinor)} for ${p.productId} at ${p.branchId}: no label to send it to`
        : `price ${rupees(p.priceMinor)} for ${p.productId} at ${p.branchId}: ${taken} of ${p.commands.length} label(s) took it`,
    });
  }
  for (const e of [...input.events].filter((e) => e.kind === 'esl_label').sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))) {
    heartbeats.push(e.outcome.state === 'recorded'
      ? { adapterId: SHELF_LABELS_ADAPTER_ID, at: e.receivedAt, ok: true, detail: `${e.deviceId} showed a price back (${e.outcome.detail})` }
      : { adapterId: SHELF_LABELS_ADAPTER_ID, at: e.receivedAt, ok: false, detail: `${e.deviceId}'s report was refused: ${e.outcome.detail}` });
  }
  // As of now: the latest push, judged against every echo so far.
  const latest = pushes.at(-1);
  if (latest !== undefined) {
    const judged = judgePush(latest, input.events);
    const ageMinutes = Math.max(0, (Date.parse(input.now) - Date.parse(latest.at)) / 60_000);
    if (judged.safeToChangeAtTill) {
      heartbeats.push({ adapterId: SHELF_LABELS_ADAPTER_ID, at: input.now, ok: true, detail: `the last price sent (${rupees(latest.priceMinor)} for ${latest.productId} at ${latest.branchId}) is shown by every label` });
    } else if (ageMinutes > ESL_ECHO_GRACE_MINUTES) {
      heartbeats.push({ adapterId: SHELF_LABELS_ADAPTER_ID, at: input.now, ok: false, detail: `the last price sent (${rupees(latest.priceMinor)} for ${latest.productId} at ${latest.branchId}, ${Math.round(ageMinutes)} minute(s) ago) is not shown by ${judged.unconfirmed.length} label(s): ${judged.unconfirmed.join(', ')}` });
    }
  }
  return {
    config, heartbeats,
    basis: `${active.length} of ${labels.length} label(s) active · ${pushes.length} price push(es) · judged from the labels' own echoes · ${HARDWARE_NOT_VERIFIED}`,
  };
}
