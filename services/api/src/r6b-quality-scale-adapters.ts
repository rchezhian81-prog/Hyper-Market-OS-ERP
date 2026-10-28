// Round 6 (builder R6-B) — head office's wiring for two registers the fresh audit found unread on their real paths:
//
//   • M10-FR-02 "sampling": each quality sample recorded on a hold is its own append-only `QualitySampleRecorded` fact on
//     its own stream (never the hold stream, whose fold reads every event as a hold). Every version is kept — a pending
//     sample's result is a new version, never an edit (hard rules #2, #6) — and a release reads them from here.
//   • B7 "an alert fires before expiry": the weighing-scale register is swept on the ops-alert worker's pass, and a scale
//     whose Legal Metrology stamp falls due within the register's notice period (or has lapsed) is raised into every
//     owner's alert inbox — the same lifecycle the contract-expiry and GST time-bar sweeps raise into — once while it is
//     open, and cleared when the scale is re-stamped (a new version with a later date).

import { makeEvent } from '../../../packages/contracts/src/event';
import type { EventStore } from '../../../packages/persistence/src/event-store';
import { shopClock, type ShopCalendarOf } from '../../../packages/calendar/src/shop-clock';
import { weighingScaleVerification, SCALE_VERIFICATION_NOTICE_DAYS } from '../../../packages/facilities/src/index';
import type { QualitySampleDeps, StoredQualitySample } from '../../inventory/src/quality-hold';
import { foldScaleRegister } from '../../platform/src/scale-register';
import { STREAM, streamName, alertLifecycleAdapter } from './adapters';
import { scaleRegisterAdapter } from './r2-till-adapters';
import { finBridgeRaiseToOwners } from './finance-bridge-adapters';
import { eventWords } from '../../platform/src/alert-lifecycle';
import { told, alertText, type AlertText } from '../../../packages/ops/src/alert-words';

// ── M10-FR-02: the quality-sample register ───────────────────────────────────────────────────────────────────────────

export const QUALITY_SAMPLES_STREAM = streamName(STREAM.inventory, 'quality-samples');
const SAMPLE_RECORDED = 'QualitySampleRecorded';

/** The sample register on head office's event store: one event per version of a sample, never edited. */
export function qualitySampleAdapter(input: { readonly store: EventStore }): Pick<QualitySampleDeps, 'sampleVersions' | 'recordSample'> {
  return {
    sampleVersions: async (tenantId, batchId) => (await input.store.readStream(tenantId, QUALITY_SAMPLES_STREAM, { type: SAMPLE_RECORDED }))
      .map((e) => e.event.payload as StoredQualitySample)
      .filter((s) => s.batchId === batchId),
    recordSample: async (tenantId, s) => {
      await input.store.append(tenantId, QUALITY_SAMPLES_STREAM, makeEvent({
        id: `qsample-${s.batchId}-${s.sampleId}-${s.holdHeldAt}-v${s.version}`, type: SAMPLE_RECORDED, occurredAt: s.recordedAt,
        // One fact per sample per version: a resend of the same version is the same fact (hard rule #10).
        idempotencyKey: `qsample-${tenantId}-${s.batchId}-${s.sampleId}-${s.holdHeldAt}-v${s.version}`, source: 'api/inventory',
        payload: s as unknown as Record<string, unknown>,
      }));
    },
  };
}

/** No store: samples held in memory for the life of the process (the composition with no durable store). */
export function inMemoryQualitySamples(): Pick<QualitySampleDeps, 'sampleVersions' | 'recordSample'> {
  const held = new Map<string, StoredQualitySample[]>();
  return {
    sampleVersions: (tenantId, batchId) => (held.get(tenantId) ?? []).filter((s) => s.batchId === batchId),
    recordSample: (tenantId, s) => { held.set(tenantId, [...(held.get(tenantId) ?? []), s]); },
  };
}

// ── B7: weighing-scale stamps falling due, raised to the owners ──────────────────────────────────────────────────────

const SCALE_ALERT_PREFIX = 'scale-stamp-due:';
const scaleAlertId = (assetId: string, dueOn: string): string => `${SCALE_ALERT_PREFIX}${assetId}:${dueOn}`;

/**
 * The ops-alert worker's pass (one line in ops-alert-sweeps.ts): every scale on the register whose stamp is due within the
 * register's notice period (`SCALE_VERIFICATION_NOTICE_DAYS`, the same window the Scales page judges "due soon" by) or has
 * lapsed is raised to every owner — once while it is open; an open alert for a scale since re-stamped (or moved out of the
 * window) is cleared. Answers how many it raised.
 */
export function scaleStampExpirySweep(input: { readonly store: EventStore; readonly now: () => string; readonly calendar?: ShopCalendarOf }): (tenantId: string, at: string) => Promise<number> {
  const clock = shopClock(input.calendar);
  return async (tenantId, at) => {
    const today = await clock.today(tenantId, at);
    const register = foldScaleRegister(await scaleRegisterAdapter(input).scaleVersions(tenantId));
    const due: { readonly alertId: string; readonly component: string; readonly detail: string; readonly text: AlertText; readonly componentText: AlertText }[] = [];
    for (const s of register) {
      const v = weighingScaleVerification({ reverificationDueOn: s.reverificationDueOn }, today, SCALE_VERIFICATION_NOTICE_DAYS);
      if (v.level === 'current') continue;
      // OB-435: the words structured — English word for word as before, and Tamil for a Tamil reader.
      const words = told(v.level === 'expired' ? 'scale.lapsed' : 'scale.dueSoon', {
        assetId: s.assetId, approvalNo: s.approvalNo, lanes: [...s.laneIds], dueOn: s.reverificationDueOn, days: v.level === 'expired' ? -v.daysRemaining : v.daysRemaining,
      });
      const component = alertText('scale.component', { assetId: s.assetId, storeId: s.storeId });
      due.push({
        alertId: scaleAlertId(s.assetId, s.reverificationDueOn),
        component: `Weighing scale ${s.assetId} (${s.storeId})`, componentText: component,
        detail: words.detail, text: words.text,
      });
    }
    let raised = 0;
    for (const a of due) {
      if (await finBridgeRaiseToOwners(input.store, input.now, tenantId, a.alertId, a.component, a.detail, 'system:scale-stamp', at, a.alertId, { text: a.text, componentText: a.componentText })) raised += 1;
    }
    const lifecycle = alertLifecycleAdapter({ store: input.store, now: input.now });
    const dueIds = new Set(due.map((a) => a.alertId));
    const stale = (await lifecycle.alerts(tenantId))
      .filter((x) => x.state !== 'cleared' && x.alert.alertId.startsWith(SCALE_ALERT_PREFIX) && !dueIds.has(x.alert.alertId))
      .map((x) => x.alert.alertId).sort();
    for (const id of stale) {
      await lifecycle.recordAlertEvent(tenantId, { alertId: id, change: 'cleared', by: 'system:scale-stamp', at, ...eventWords(told('scale.cleared')) }, `${id}|cleared|${at}`);
    }
    return raised;
  };
}
