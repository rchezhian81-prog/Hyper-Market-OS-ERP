// Assets, warranty, AMC and service (M26-FR-01 / M26-FR-04 / §35 / hard rule #6).
//
// A hypermarket is a building full of machines that lose money quietly. The chiller that
// runs two degrees warm does not stop; it shortens the life of everything inside it and the
// shop finds out at the shrinkage count. The DG that has not been serviced starts fine every
// month until the one power cut that matters.
//
// So the design decision here is about **what counts as critical**:
//
//   • **CRITICALITY IS A PROPERTY OF THE ASSET, NOT OF THE ALERT.** A cold room overdue for
//     service and a shelf trolley overdue for service are not the same event, and putting
//     them in one list at the same weight is how the cold room gets missed. Critical assets
//     are reported separately and first.
//   • **AN EXPIRED AMC IS REPORTED AGAINST WHAT IT PROTECTS.** "AMC-14 expired" tells the
//     owner nothing. *"The cold room has no maintenance contract and ₹8,00,000 of stock sits
//     in it"* is the sentence that gets it renewed.
//   • **DOWNTIME IS MEASURED FROM WHEN IT BROKE, NOT FROM WHEN IT WAS REPORTED.** The gap
//     between those two is usually the story: an hour of downtime reported four hours late
//     is a five-hour cold-chain exposure, and only the first number gets written down.
//
// Pure and deterministic: the clock is injected, no I/O.

export type AssetCriticality = 'critical' | 'important' | 'routine';

export type AssetKind =
  | 'refrigeration'
  | 'cold_room'
  | 'freezer'
  | 'power_ups'
  | 'power_dg'
  | 'pos_hardware'
  | 'weighing'
  | 'fire_safety'
  | 'handling'
  | 'other';

export interface Asset {
  readonly assetId: string;
  readonly tenantId: string;
  readonly branchId: string;
  readonly name: string;
  readonly kind: AssetKind;
  readonly criticality: AssetCriticality;
  readonly installedOn: string;
  readonly warrantyUntil?: string;
  /** Annual maintenance contract expiry, YYYY-MM-DD. */
  readonly amcUntil?: string;
  readonly amcVendor?: string;
  /** Service interval in days. Absent means service is not scheduled for this asset. */
  readonly serviceEveryDays?: number;
  /** What is at risk if this asset stops. Turns an ID into a sentence the owner acts on. */
  readonly protectsValueMinor?: number;
  readonly active: boolean;
}

export interface ServiceLog {
  readonly serviceId: string;
  readonly assetId: string;
  readonly performedOn: string;
  readonly performedBy: string;
  readonly kind: 'preventive' | 'breakdown' | 'inspection';
  readonly notes?: string;
  readonly costMinor?: number;
  readonly sparesUsed?: readonly { readonly sparePartId: string; readonly qty: number }[];
}

export type CoverState = 'covered' | 'expiring' | 'expired' | 'none';

export interface AssetAlert {
  readonly assetId: string;
  readonly name: string;
  readonly criticality: AssetCriticality;
  readonly kind:
    | 'amc_expiring'
    | 'amc_expired'
    | 'amc_missing'
    | 'warranty_expiring'
    | 'service_overdue'
    | 'never_serviced';
  readonly daysRemaining?: number;
  readonly daysOverdue?: number;
  readonly protectsValueMinor?: number;
  readonly detail: string;
}

export interface AssetHealth {
  readonly asAt: string;
  readonly branchId: string;
  /** Critical-asset alerts, first and separate. */
  readonly critical: readonly AssetAlert[];
  readonly other: readonly AssetAlert[];
  readonly detail: string;
}

const DAY_MS = 86_400_000;

function daysBetween(from: string, to: string): number {
  return Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

function valuePhrase(asset: Asset): string {
  return asset.protectsValueMinor === undefined || asset.protectsValueMinor === 0
    ? ''
    : ` — ${asset.protectsValueMinor} of stock depends on it`;
}

/**
 * Assess every asset's cover and service position on one date.
 *
 * Critical assets come back **separately**, not merely sorted higher. A list where the cold
 * room and the shelf trolley sit together at the same weight is a list where the cold room
 * gets missed, and the shop finds out at the shrinkage count.
 */
export function assessAssets(input: {
  readonly branchId: string;
  readonly assets: readonly Asset[];
  readonly services: readonly ServiceLog[];
  readonly asAt: string;
  /** Days before expiry at which cover is flagged. Per-tenant. Default 45. */
  readonly warnWithinDays?: number;
}): AssetHealth {
  const warn = input.warnWithinDays ?? 45;
  const alerts: AssetAlert[] = [];

  for (const asset of input.assets.filter((a) => a.branchId === input.branchId && a.active)) {
    const base = {
      assetId: asset.assetId,
      name: asset.name,
      criticality: asset.criticality,
      protectsValueMinor: asset.protectsValueMinor,
    };

    // --- maintenance contract -------------------------------------------------
    if (asset.amcUntil === undefined) {
      alerts.push({
        ...base,
        kind: 'amc_missing',
        detail: `${asset.name} has NO maintenance contract${valuePhrase(asset)}`,
      });
    } else {
      const daysRemaining = daysBetween(input.asAt, asset.amcUntil);
      if (daysRemaining < 0) {
        alerts.push({
          ...base,
          kind: 'amc_expired',
          daysOverdue: -daysRemaining,
          detail: `${asset.name}'s maintenance contract expired ${-daysRemaining} day(s) ago${valuePhrase(asset)}`,
        });
      } else if (daysRemaining <= warn) {
        alerts.push({
          ...base,
          kind: 'amc_expiring',
          daysRemaining,
          detail: `${asset.name}'s maintenance contract runs out in ${daysRemaining} day(s)${asset.amcVendor === undefined ? '' : ` (${asset.amcVendor})`}${valuePhrase(asset)}`,
        });
      }
    }

    // --- warranty --------------------------------------------------------------
    if (asset.warrantyUntil !== undefined) {
      const daysRemaining = daysBetween(input.asAt, asset.warrantyUntil);
      if (daysRemaining >= 0 && daysRemaining <= warn) {
        alerts.push({
          ...base,
          kind: 'warranty_expiring',
          daysRemaining,
          detail: `${asset.name} is still under warranty for ${daysRemaining} day(s) — anything wrong with it should be raised NOW, not paid for next month`,
        });
      }
    }

    // --- service ---------------------------------------------------------------
    if (asset.serviceEveryDays !== undefined) {
      const last = input.services
        .filter((s) => s.assetId === asset.assetId && s.kind !== 'breakdown')
        .sort((a, b) => b.performedOn.localeCompare(a.performedOn))[0];

      if (last === undefined) {
        const sinceInstall = daysBetween(asset.installedOn, input.asAt);
        if (sinceInstall > asset.serviceEveryDays) {
          alerts.push({
            ...base,
            kind: 'never_serviced',
            daysOverdue: sinceInstall - asset.serviceEveryDays,
            detail: `${asset.name} has NEVER been serviced in ${sinceInstall} day(s) since it was installed${valuePhrase(asset)}`,
          });
        }
      } else {
        const since = daysBetween(last.performedOn, input.asAt);
        if (since > asset.serviceEveryDays) {
          alerts.push({
            ...base,
            kind: 'service_overdue',
            daysOverdue: since - asset.serviceEveryDays,
            detail: `${asset.name} is ${since - asset.serviceEveryDays} day(s) past its ${asset.serviceEveryDays}-day service${valuePhrase(asset)}`,
          });
        }
      }
    }
  }

  const byUrgency = (a: AssetAlert, b: AssetAlert): number =>
    (b.daysOverdue ?? 0) - (a.daysOverdue ?? 0) ||
    (a.daysRemaining ?? 9_999) - (b.daysRemaining ?? 9_999) ||
    a.assetId.localeCompare(b.assetId);

  const critical = alerts.filter((a) => a.criticality === 'critical').sort(byUrgency);
  const other = alerts.filter((a) => a.criticality !== 'critical').sort(byUrgency);

  return {
    asAt: input.asAt,
    branchId: input.branchId,
    critical,
    other,
    detail:
      critical.length === 0
        ? other.length === 0
          ? 'every asset is covered and serviced'
          : `nothing critical; ${other.length} routine item(s) to book in`
        : `${critical.length} CRITICAL asset(s) need attention, and ${other.length} routine item(s) behind them`,
  };
}

export interface DowntimeEvent {
  readonly eventId: string;
  readonly assetId: string;
  /** When it actually stopped, as best anyone knows. */
  readonly failedAt: string;
  /** When somebody told the system. The gap between these two IS the story. */
  readonly reportedAt: string;
  readonly restoredAt?: string;
  readonly cause?: string;
}

export interface DowntimeSummary {
  readonly assetId: string;
  readonly name: string;
  readonly events: number;
  readonly totalMinutes: number;
  /** Minutes that passed before anyone recorded the failure. */
  readonly unreportedMinutes: number;
  readonly stillDown: boolean;
  readonly detail: string;
}

/**
 * Summarise downtime **from when it failed, not from when it was reported**.
 *
 * An hour of downtime reported four hours late is a five-hour exposure, and a system that
 * measures from the report writes down one hour. For a chiller that difference is the
 * difference between stock that is fine and stock that must be destroyed — which is why
 * `unreportedMinutes` is a number of its own rather than being folded into the total.
 */
export function summariseDowntime(input: {
  readonly assets: readonly Asset[];
  readonly events: readonly DowntimeEvent[];
  readonly asAt: string;
}): readonly DowntimeSummary[] {
  const byAsset = new Map<string, DowntimeEvent[]>();
  for (const event of input.events) {
    byAsset.set(event.assetId, [...(byAsset.get(event.assetId) ?? []), event]);
  }

  const asAtMs = Date.parse(input.asAt);
  const summaries: DowntimeSummary[] = [];

  for (const [assetId, events] of byAsset) {
    const asset = input.assets.find((a) => a.assetId === assetId);
    let totalMinutes = 0;
    let unreportedMinutes = 0;
    let stillDown = false;

    for (const event of events) {
      const failedMs = Date.parse(event.failedAt);
      const endMs = event.restoredAt === undefined ? asAtMs : Date.parse(event.restoredAt);
      if (event.restoredAt === undefined) stillDown = true;
      totalMinutes += Math.max(0, Math.round((endMs - failedMs) / 60_000));
      unreportedMinutes += Math.max(0, Math.round((Date.parse(event.reportedAt) - failedMs) / 60_000));
    }

    summaries.push({
      assetId,
      name: asset?.name ?? assetId,
      events: events.length,
      totalMinutes,
      unreportedMinutes,
      stillDown,
      detail: stillDown
        ? `${asset?.name ?? assetId} is STILL DOWN after ${totalMinutes} minute(s)`
        : unreportedMinutes > 0
          ? `${totalMinutes} minute(s) down across ${events.length} event(s), of which ${unreportedMinutes} passed before anyone recorded it — the exposure is the whole ${totalMinutes}, not what was reported`
          : `${totalMinutes} minute(s) down across ${events.length} event(s)`,
    });
  }

  return summaries.sort((a, b) => b.totalMinutes - a.totalMinutes || a.assetId.localeCompare(b.assetId));
}

export interface EnergyReading {
  readonly assetId?: string;
  readonly branchId: string;
  readonly onDate: string;
  readonly kilowattHours: number;
  readonly costMinor: number;
  readonly source: 'meter' | 'bill' | 'estimate';
}

export interface EnergyReport {
  readonly branchId: string;
  readonly from: string;
  readonly to: string;
  readonly kilowattHours: number;
  readonly costMinor: number;
  /** How much of the total came from an estimate rather than a real reading. */
  readonly estimatedShareBps: number | 'not_meaningful';
  readonly perDayCostMinor: number | 'not_meaningful';
  readonly detail: string;
}

/**
 * Energy over a window, with **how much of it was guessed** stated on the face of it.
 *
 * An energy figure that silently blends meter readings with estimates is a figure that will
 * be quoted in a decision about buying a chiller. If a third of it is estimated, the owner
 * should be told that before, not after.
 */
export function reportEnergy(input: {
  readonly branchId: string;
  readonly readings: readonly EnergyReading[];
  readonly from: string;
  readonly to: string;
}): EnergyReport {
  const inWindow = input.readings.filter(
    (r) => r.branchId === input.branchId && r.onDate >= input.from && r.onDate <= input.to,
  );

  const kilowattHours = inWindow.reduce((s, r) => s + r.kilowattHours, 0);
  const costMinor = inWindow.reduce((s, r) => s + r.costMinor, 0);
  const estimatedMinor = inWindow.filter((r) => r.source === 'estimate').reduce((s, r) => s + r.costMinor, 0);
  const days = Math.max(1, daysBetween(input.from, input.to) + 1);

  const estimatedShareBps =
    costMinor === 0
      ? ('not_meaningful' as const)
      : Number((BigInt(estimatedMinor) * 10_000n) / BigInt(costMinor));

  return {
    branchId: input.branchId,
    from: input.from,
    to: input.to,
    kilowattHours,
    costMinor,
    estimatedShareBps,
    perDayCostMinor: inWindow.length === 0 ? ('not_meaningful' as const) : Math.round(costMinor / days),
    detail:
      inWindow.length === 0
        ? 'no readings in this window — this is an absence of data, not an absence of consumption'
        : estimatedShareBps === 'not_meaningful' || estimatedShareBps === 0
          ? `${kilowattHours} kWh costing ${costMinor} over ${days} day(s), all from real readings`
          : `${kilowattHours} kWh costing ${costMinor} over ${days} day(s) — ${(estimatedShareBps / 100).toFixed(1)}% of that cost is ESTIMATED, not metered`,
  };
}
