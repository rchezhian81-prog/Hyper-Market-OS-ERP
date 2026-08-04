import { describe, it, expect } from 'vitest';
import {
  assessAssets,
  summariseDowntime,
  reportEnergy,
  type Asset,
  type ServiceLog,
  type DowntimeEvent,
} from '../../packages/facilities/src/assets';
import {
  assessEquipment,
  assessPower,
  type EquipmentReading,
  type EquipmentRange,
  type PowerEvent,
} from '../../packages/facilities/src/monitoring';
import {
  assessCompletion,
  findOverdue,
  closeIncident,
  buildComplianceEvidence,
  type MaintenanceSchedule,
  type ScheduledTask,
  type SafetyIncident,
} from '../../packages/facilities/src/schedules';

// M26-FR-01..04 acceptance: "an AMC nearing expiry alerts; a cold-room breach alerts and
// records evidence against affected stock; a due safety check routes, is evidenced, and
// escalates if missed; downtime/energy report computes."

const asset = (over: Partial<Asset>): Asset => ({
  assetId: 'a-cold',
  tenantId: 't-sre',
  branchId: 'b-main',
  name: 'Cold room 1',
  kind: 'cold_room',
  criticality: 'critical',
  installedOn: '2024-01-10',
  amcUntil: '2027-01-10',
  serviceEveryDays: 90,
  protectsValueMinor: 80_000_00,
  active: true,
  ...over,
});

const TROLLEY = asset({
  assetId: 'a-trolley', name: 'Shelf trolley', kind: 'handling', criticality: 'routine',
  amcUntil: undefined, serviceEveryDays: undefined, protectsValueMinor: undefined,
});

const service = (over: Partial<ServiceLog>): ServiceLog => ({
  serviceId: 's-1', assetId: 'a-cold', performedOn: '2026-07-01',
  performedBy: 'v-coolcare', kind: 'preventive', ...over,
});

describe('critical assets are reported SEPARATELY, not merely sorted higher (M26-FR-01)', () => {
  it('keeps the cold room out of the same list as the shelf trolley', () => {
    const health = assessAssets({
      branchId: 'b-main',
      assets: [asset({ amcUntil: '2026-06-01' }), TROLLEY],
      services: [service({})],
      asAt: '2026-08-04',
    });
    expect(health.critical.map((a) => a.assetId)).toEqual(['a-cold']);
    expect(health.other.map((a) => a.assetId)).toEqual(['a-trolley']);
    expect(health.detail).toContain('1 CRITICAL asset(s)');
  });

  it('names what an expired AMC leaves unprotected, in money', () => {
    const health = assessAssets({
      branchId: 'b-main', assets: [asset({ amcUntil: '2026-06-01' })],
      services: [service({})], asAt: '2026-08-04',
    });
    const alert = health.critical.find((a) => a.kind === 'amc_expired');
    expect(alert?.daysOverdue).toBe(64);
    // "AMC-14 expired" gets ignored. This does not.
    expect(alert?.detail).toContain('8000000 of stock depends on it');
  });

  it('warns before an AMC lapses, so it can be renewed', () => {
    const health = assessAssets({
      branchId: 'b-main', assets: [asset({ amcUntil: '2026-09-01', amcVendor: 'CoolCare' })],
      services: [service({})], asAt: '2026-08-04',
    });
    const alert = health.critical.find((a) => a.kind === 'amc_expiring');
    expect(alert?.daysRemaining).toBe(28);
    expect(alert?.detail).toContain('CoolCare');
  });

  it('flags an asset with NO maintenance contract at all', () => {
    const health = assessAssets({
      branchId: 'b-main', assets: [asset({ amcUntil: undefined })],
      services: [service({})], asAt: '2026-08-04',
    });
    expect(health.critical[0]?.kind).toBe('amc_missing');
  });

  it('catches an asset that has NEVER been serviced', () => {
    const health = assessAssets({
      branchId: 'b-main', assets: [asset({})], services: [], asAt: '2026-08-04',
    });
    const alert = health.critical.find((a) => a.kind === 'never_serviced');
    expect(alert).toBeDefined();
    expect(alert?.detail).toContain('NEVER been serviced');
  });

  it('flags an overdue service and does not count a breakdown call as one', () => {
    const overdue = assessAssets({
      branchId: 'b-main', assets: [asset({})],
      services: [service({ performedOn: '2026-01-01' }), service({ serviceId: 's-2', performedOn: '2026-08-01', kind: 'breakdown' })],
      asAt: '2026-08-04',
    });
    // A breakdown visit is not preventive maintenance. Counting it as one is how an
    // asset goes two years without a service and shows as fine.
    expect(overdue.critical.some((a) => a.kind === 'service_overdue')).toBe(true);
  });

  it('says nothing when everything is covered and serviced', () => {
    const health = assessAssets({
      branchId: 'b-main', assets: [asset({})], services: [service({})], asAt: '2026-08-04',
    });
    expect(health.critical).toEqual([]);
    expect(health.detail).toBe('every asset is covered and serviced');
  });

  it('nudges while an asset is still under warranty', () => {
    const health = assessAssets({
      branchId: 'b-main', assets: [asset({ warrantyUntil: '2026-09-01' })],
      services: [service({})], asAt: '2026-08-04',
    });
    expect(health.critical.find((a) => a.kind === 'warranty_expiring')?.detail).toContain('raised NOW');
  });
});

describe('downtime is measured from when it BROKE (M26-FR-04)', () => {
  const event = (over: Partial<DowntimeEvent>): DowntimeEvent => ({
    eventId: 'd-1', assetId: 'a-cold',
    failedAt: '2026-08-01T02:00:00Z', reportedAt: '2026-08-01T06:00:00Z',
    restoredAt: '2026-08-01T07:00:00Z', ...over,
  });

  it('counts the whole exposure, not the reported hour', () => {
    const [summary] = summariseDowntime({
      assets: [asset({})], events: [event({})], asAt: '2026-08-04T00:00:00Z',
    });
    expect(summary?.totalMinutes).toBe(300);
    expect(summary?.unreportedMinutes).toBe(240);
    expect(summary?.detail).toContain('the exposure is the whole 300');
  });

  it('counts an unresolved failure up to now and says it is still down', () => {
    const [summary] = summariseDowntime({
      assets: [asset({})],
      events: [event({ restoredAt: undefined, failedAt: '2026-08-03T22:00:00Z', reportedAt: '2026-08-03T22:00:00Z' })],
      asAt: '2026-08-04T00:00:00Z',
    });
    expect(summary?.stillDown).toBe(true);
    expect(summary?.totalMinutes).toBe(120);
  });
});

describe('an energy figure states how much of it was GUESSED (M26-FR-04)', () => {
  it('reports the estimated share on the face of it', () => {
    const report = reportEnergy({
      branchId: 'b-main',
      readings: [
        { branchId: 'b-main', onDate: '2026-07-01', kilowattHours: 400, costMinor: 400_000, source: 'meter' },
        { branchId: 'b-main', onDate: '2026-07-02', kilowattHours: 200, costMinor: 200_000, source: 'estimate' },
      ],
      from: '2026-07-01', to: '2026-07-31',
    });
    expect(report.kilowattHours).toBe(600);
    expect(report.estimatedShareBps).toBe(3_333);
    expect(report.detail).toContain('ESTIMATED, not metered');
  });

  it('says an absence of readings is not an absence of consumption', () => {
    const report = reportEnergy({ branchId: 'b-main', readings: [], from: '2026-07-01', to: '2026-07-31' });
    expect(report.perDayCostMinor).toBe('not_meaningful');
    expect(report.detail).toContain('not an absence of consumption');
  });
});

const RANGE: EquipmentRange = {
  assetId: 'a-cold', minTenthsC: -10, maxTenthsC: 50, graceMinutes: 30, expectEveryMinutes: 120,
};

const reading = (at: string, tenthsC: number): EquipmentReading => ({
  readingId: `r-${at}`, assetId: 'a-cold', tenthsC, at, source: 'sensor', recordedBy: 'probe-1',
});

const CONTENTS = [
  { batchId: 'b-1', productId: 'p-chicken', valueMinor: 120_000 },
  { batchId: 'b-2', productId: 'p-paneer', valueMinor: 64_000 },
];

describe('an equipment breach NAMES the stock it exposes (M26-FR-02)', () => {
  it('holds everything in the room, including the batches nobody probed', () => {
    const result = assessEquipment({
      assetId: 'a-cold', range: RANGE,
      readings: [
        reading('2026-08-04T06:00:00Z', 40),
        reading('2026-08-04T07:00:00Z', 95),
        reading('2026-08-04T09:00:00Z', 98),
      ],
      contents: CONTENTS,
      asAt: '2026-08-04T10:00:00Z',
    });
    expect(result.state).toBe('breach');
    expect(result.minutesOutOfRange).toBe(180);
    expect(result.holdStock).toBe(true);
    expect(result.exposedValueMinor).toBe(184_000);
    expect(result.detail).toContain('including the ones nobody probed');
  });

  it('does NOT hold on a brief excursion inside the grace window', () => {
    const result = assessEquipment({
      assetId: 'a-cold', range: RANGE,
      readings: [reading('2026-08-04T09:40:00Z', 95), reading('2026-08-04T10:00:00Z', 40)],
      contents: CONTENTS, asAt: '2026-08-04T10:05:00Z',
    });
    expect(result.state).toBe('drifting');
    expect(result.holdStock).toBe(false);
    expect(result.detail).toContain('not a hold');
  });

  it('treats a SILENT probe as a fault, not a pass', () => {
    const result = assessEquipment({
      assetId: 'a-cold', range: RANGE,
      readings: [reading('2026-08-01T09:00:00Z', 40)],
      contents: CONTENTS, asAt: '2026-08-04T10:00:00Z',
    });
    expect(result.state).toBe('stale');
    expect(result.holdStock).toBe(true);
    expect(result.detail).toContain('reads as "no alerts" forever');
  });

  it('treats no reading at all as a breach of the monitoring itself', () => {
    const result = assessEquipment({
      assetId: 'a-cold', range: RANGE, readings: [], contents: CONTENTS, asAt: '2026-08-04T10:00:00Z',
    });
    expect(result.state).toBe('no_data');
    expect(result.source).toBe('none');
    expect(result.detail).toContain('silence is not a pass');
  });

  it('passes a room in range and records how it was measured (D14 — IoT is readiness)', () => {
    const manual = assessEquipment({
      assetId: 'a-cold', range: RANGE,
      readings: [{ ...reading('2026-08-04T09:30:00Z', 30), source: 'log_sheet' }],
      contents: CONTENTS, asAt: '2026-08-04T10:00:00Z',
    });
    expect(manual.state).toBe('within_range');
    expect(manual.holdStock).toBe(false);
    // A hand-written 3.0°C and a metered one are assessed identically but never confused.
    expect(manual.source).toBe('log_sheet');
  });

  it('holds nothing when the room is empty', () => {
    const result = assessEquipment({
      assetId: 'a-cold', range: RANGE, readings: [], contents: [], asAt: '2026-08-04T10:00:00Z',
    });
    expect(result.holdStock).toBe(false);
  });
});

describe('power is assessed by WHAT IT PROTECTS (M26-FR-02)', () => {
  const power = (kind: PowerEvent['kind'], at: string): PowerEvent => ({
    eventId: `p-${at}`, branchId: 'b-main', kind, at,
  });
  const critical = [{ assetId: 'a-cold', name: 'Cold room 1', onBackup: false }];

  it('counts unprotected minutes from the MAINS failure, not from the DG attempt', () => {
    const result = assessPower({
      branchId: 'b-main',
      events: [power('mains_failed', '2026-08-04T09:00:00Z'), power('dg_failed_to_start', '2026-08-04T09:05:00Z')],
      criticalAssets: critical,
      asAt: '2026-08-04T09:47:00Z',
    });
    expect(result.severity).toBe('unprotected');
    expect(result.unprotectedMinutes).toBe(47);
    expect(result.assetsAtRisk).toEqual(['Cold room 1']);
    expect(result.detail).toContain('which piece of equipment let it down');
  });

  it('stops the clock when the generator picks up', () => {
    const result = assessPower({
      branchId: 'b-main',
      events: [power('mains_failed', '2026-08-04T09:00:00Z'), power('dg_started', '2026-08-04T09:03:00Z')],
      criticalAssets: critical, asAt: '2026-08-04T10:00:00Z',
    });
    expect(result.severity).toBe('on_backup');
    expect(result.unprotectedMinutes).toBe(3);
    expect(result.detail).toContain('check fuel');
  });

  it('closes the outage cleanly when the mains come back', () => {
    const result = assessPower({
      branchId: 'b-main',
      events: [
        power('mains_failed', '2026-08-04T09:00:00Z'),
        power('dg_started', '2026-08-04T09:04:00Z'),
        power('mains_restored', '2026-08-04T11:00:00Z'),
      ],
      criticalAssets: critical, asAt: '2026-08-04T12:00:00Z',
    });
    expect(result.severity).toBe('normal');
    expect(result.unprotectedMinutes).toBe(4);
    expect(result.assetsAtRisk).toEqual([]);
  });

  it('is quiet with no events', () => {
    const result = assessPower({ branchId: 'b-main', events: [], criticalAssets: critical, asAt: '2026-08-04T12:00:00Z' });
    expect(result.detail).toBe('mains normal, nothing lost');
  });
});

const schedule = (over: Partial<MaintenanceSchedule>): MaintenanceSchedule => ({
  scheduleId: 'sch-fire',
  tenantId: 't-sre',
  branchId: 'b-main',
  title: 'Fire extinguisher check',
  category: 'fire_safety',
  frequency: 'monthly',
  assignedRole: 'facilities',
  evidenceRequired: true,
  verificationRequired: true,
  escalatesTo: 'u-owner',
  active: true,
  ...over,
});

const task = (over: Partial<ScheduledTask>): ScheduledTask => ({
  taskId: 't-1', scheduleId: 'sch-fire', dueOn: '2026-08-01',
  completedOn: '2026-08-01', completedBy: 'u-raj',
  evidenceRefs: ['photo-1'], verifiedBy: 'u-manager', ...over,
});

describe('a tick without evidence is REFUSED, not warned about (M26-FR-03)', () => {
  it('accepts a properly evidenced and verified completion', () => {
    const result = assessCompletion({ schedule: schedule({}), task: task({}) });
    expect(result.accepted).toBe(true);
    expect(result.outcome).toBe('complete');
  });

  it('refuses a tick with no evidence attached', () => {
    const result = assessCompletion({ schedule: schedule({}), task: task({ evidenceRefs: [] }) });
    expect(result.accepted).toBe(false);
    expect(result.outcome).toBe('evidence_missing');
    expect(result.detail).toContain('worth nothing at an inspection');
  });

  it('refuses SELF-VERIFICATION of a safety check', () => {
    const result = assessCompletion({ schedule: schedule({}), task: task({ verifiedBy: 'u-raj' }) });
    expect(result.outcome).toBe('self_verified');
    expect(result.detail).toContain('a signature against nothing');
  });

  it('refuses an unverified safety check', () => {
    expect(assessCompletion({ schedule: schedule({}), task: task({ verifiedBy: undefined }) }).outcome)
      .toBe('not_verified');
  });

  it('does not demand evidence where the schedule does not require it', () => {
    const cleaning = schedule({
      scheduleId: 'sch-mop', title: 'Mop aisle 4', category: 'cleaning',
      evidenceRequired: false, verificationRequired: false,
    });
    const result = assessCompletion({
      schedule: cleaning,
      task: task({ scheduleId: 'sch-mop', evidenceRefs: [], verifiedBy: undefined }),
    });
    expect(result.accepted).toBe(true);
  });
});

describe('a missed compliance task escalates by ITSELF (M26-FR-03, P-03)', () => {
  const CLEANING = schedule({
    scheduleId: 'sch-mop', title: 'Mop aisle 4', category: 'cleaning',
    evidenceRequired: false, verificationRequired: false, escalatesTo: 'u-manager',
  });

  it('puts a compliance risk above everything else and names who hears about it', () => {
    const overdue = findOverdue({
      schedules: [schedule({}), CLEANING],
      tasks: [
        task({ taskId: 't-fire', dueOn: '2026-07-20', completedOn: undefined, completedBy: undefined }),
        task({ taskId: 't-mop', scheduleId: 'sch-mop', dueOn: '2026-07-10', completedOn: undefined, completedBy: undefined, evidenceRefs: [], verifiedBy: undefined }),
      ],
      asAt: '2026-08-04',
    });
    expect(overdue[0]?.taskId).toBe('t-fire');
    expect(overdue[0]?.level).toBe('compliance_risk');
    expect(overdue[0]?.escalateTo).toBe('u-owner');
    // Cleaning is deliberately NOT compliance-linked: burying the fire check among forty
    // mop-the-aisle alerts is the same failure by another route.
    expect(overdue[1]?.complianceLinked).toBe(false);
  });

  it('catches a task that was TICKED but never evidenced', () => {
    const overdue = findOverdue({
      schedules: [schedule({})],
      tasks: [task({ dueOn: '2026-07-20', evidenceRefs: [] })],
      asAt: '2026-08-04',
    });
    expect(overdue[0]?.level).toBe('compliance_risk');
    expect(overdue[0]?.detail).toContain('it was ticked, but with no evidence');
  });

  it('says nothing about a task that is not yet due', () => {
    expect(findOverdue({
      schedules: [schedule({})],
      tasks: [task({ dueOn: '2026-09-01', completedOn: undefined, completedBy: undefined })],
      asAt: '2026-08-04',
    })).toEqual([]);
  });

  it('ignores a deactivated schedule', () => {
    expect(findOverdue({
      schedules: [schedule({ active: false })],
      tasks: [task({ dueOn: '2026-07-01', completedOn: undefined, completedBy: undefined })],
      asAt: '2026-08-04',
    })).toEqual([]);
  });
});

const incident = (over: Partial<SafetyIncident>): SafetyIncident => ({
  incidentId: 'inc-1', tenantId: 't-sre', branchId: 'b-main',
  kind: 'injury', severity: 'serious',
  occurredAt: '2026-08-02T14:00:00Z', reportedAt: '2026-08-02T14:20:00Z',
  reportedBy: 'u-raj', description: 'Slip on a wet floor at the deli',
  evidenceRefs: ['photo-2'], ...over,
});

describe('an incident cannot be closed into silence (M26-FR-04)', () => {
  const close = (over: Partial<Parameters<typeof closeIncident>[0]> = {}) =>
    closeIncident({
      incident: incident({}), closedBy: 'u-manager',
      actionTaken: 'Wet-floor signage stocked at every prep point',
      at: '2026-08-04T09:00:00Z', ...over,
    });

  it('closes with a corrective action, evidence and a second person', () => {
    expect(close().closed).toBe(true);
  });

  it('REFUSES a close with no corrective action', () => {
    const result = close({ actionTaken: '   ' });
    expect(result.outcome).toBe('no_action_recorded');
    expect(result.detail).toContain('will happen again');
  });

  it('refuses to close a serious incident on a description alone', () => {
    expect(close({ incident: incident({ evidenceRefs: [] }) }).outcome).toBe('no_evidence');
  });

  it('refuses to let the reporter close their own serious incident', () => {
    expect(close({ closedBy: 'u-raj' }).outcome).toBe('self_closed');
  });

  it('will not close a REPORTABLE incident with no statutory notification', () => {
    const result = close({ incident: incident({ severity: 'reportable' }) });
    expect(result.outcome).toBe('not_reported_to_authority');
    expect(result.detail).toContain('stop thinking about it');

    const notified = close({
      incident: incident({ severity: 'reportable' }), authorityNotifiedOn: '2026-08-03',
    });
    expect(notified.closed).toBe(true);
  });

  it('lets a minor incident be closed by its reporter without evidence', () => {
    expect(close({ incident: incident({ severity: 'minor', evidenceRefs: [] }), closedBy: 'u-raj' }).closed).toBe(true);
  });
});

describe('the compliance pack says plainly whether it would survive', () => {
  it('is presentable when everything compliance-linked is evidenced and closed', () => {
    const pack = buildComplianceEvidence({
      branchId: 'b-main', schedules: [schedule({})], tasks: [task({})],
      incidents: [incident({ closedAt: '2026-08-04T09:00:00Z', closedBy: 'u-manager' })],
      from: '2026-08-01', to: '2026-08-31',
    });
    expect(pack.presentable).toBe(true);
    expect(pack.tasksEvidenced).toBe(1);
    expect(pack.detail).toContain('can be handed over');
  });

  it('names every gap an inspector would find', () => {
    const pack = buildComplianceEvidence({
      branchId: 'b-main', schedules: [schedule({})],
      tasks: [task({ evidenceRefs: [] })],
      incidents: [incident({})],
      from: '2026-08-01', to: '2026-08-31',
    });
    expect(pack.presentable).toBe(false);
    expect(pack.gaps).toHaveLength(2);
    expect(pack.gaps.join(' ')).toContain('evidence missing');
    expect(pack.gaps.join(' ')).toContain('serious injury still open');
    expect(pack.detail).toContain('worse than handing over nothing');
  });
});
