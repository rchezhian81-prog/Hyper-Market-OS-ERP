import { describe, it, expect } from 'vitest';
import {
  createFleetSession, FLEET_COPY, FLEET_VERDICTS,
  type FleetDeviceRow, type FleetPorts, type FleetSummaryRollup,
} from '../../apps/web-erp/src/fleet-session';
import { DEVICE_CHANGE_EVENT, deviceChangeKey, type DeviceChangePayload } from '../../apps/web-erp/src/fleet-device-command';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { isBilingualComplete } from '../../packages/ui/src/index';

// Fleet manager — the device & version status view (M33-FR-02/04, A-10). A DOM-free session model:
// control by exception (worst first), silence is a warning not health (P-08), and colour is never the
// only signal (an icon + a word ride with every tone).

const device = (over: Partial<FleetDeviceRow> = {}): FleetDeviceRow => ({
  deviceId: 'till-3', label: 'Lane 3', kind: 'pos_lane', branchId: 'b-main', status: 'registered',
  appVersion: '1.10.0', lastSeenAt: '2026-08-29T09:00:00Z',
  verdict: 'ok', mayTrade: true, mustUpgrade: false, detail: 'up to date', silent: false, ...over,
});

const ports = (devices: readonly FleetDeviceRow[], caps: { read?: boolean; manage?: boolean } = {}): FleetPorts => {
  const summary: FleetSummaryRollup = {
    total: devices.length,
    trading: devices.filter((d) => d.mayTrade).length,
    blocked: devices.filter((d) => d.verdict === 'blocked').length,
    mustUpgrade: devices.filter((d) => d.mustUpgrade).length,
    silent: devices.filter((d) => d.silent).length,
    byVersion: {},
  };
  return { fleet: () => ({ summary, devices }), mayRead: () => caps.read ?? true, mayManage: () => caps.manage ?? false };
};

describe('createFleetSession — the fleet at a glance, exceptions first', () => {
  it('refuses the view to someone without read permission', () => {
    const s = createFleetSession({ userId: 'u-1' }, ports([device()], { read: false }));
    const v = s.view('en');
    expect(v.screenState.tone).toBe('error');
    expect(v.devices).toEqual([]);
    expect(v.mayManage).toBe(false);
  });

  it('reports an empty fleet as empty, not as an error', () => {
    const v = createFleetSession({ userId: 'u-1' }, ports([])).view('en');
    expect(v.total).toBe(0);
    expect(v.screenState.label).toBe('No devices are registered yet.');
  });

  it('puts the devices that need a look first: must-update and gone-quiet before the healthy ones', () => {
    const v = createFleetSession({ userId: 'u-1' }, ports([
      device({ deviceId: 'till-1', verdict: 'ok', mayTrade: true }),
      device({ deviceId: 'till-2', verdict: 'upgrade_required', mayTrade: false, mustUpgrade: true }),
      device({ deviceId: 'till-3', verdict: 'ok', mayTrade: true, silent: true, lastSeenAt: undefined }),
    ])).view('en');
    expect(v.total).toBe(3);
    expect(v.attentionCount).toBe(2); // the must-update and the silent one
    expect(v.devices[0]?.deviceId).toBe('till-2'); // cannot trade — worst
    expect(v.devices[1]?.deviceId).toBe('till-3'); // silent — needs a look
    expect(v.devices[2]?.deviceId).toBe('till-1'); // healthy — last
    // A must-update device is an error tone; the silent-but-otherwise-ok one is degraded, not fine.
    expect(v.devices[0]?.status.tone).toBe('error');
    expect(v.devices[1]?.status.tone).toBe('degraded');
    expect(v.devices[2]?.status.tone).toBe('ok');
    // Never colour alone — a word rides with every device.
    expect(v.devices[0]?.status.label).toContain('Must update');
    expect(v.devices[1]?.status.label).toContain('quiet');
  });

  it('shows the register/block/retire affordance only to someone who may manage', () => {
    expect(createFleetSession({ userId: 'u-1' }, ports([device()], { manage: true })).view('en').mayManage).toBe(true);
    expect(createFleetSession({ userId: 'u-1' }, ports([device()], { manage: false })).view('en').mayManage).toBe(false);
  });

  it('names a never-seen device as never checked in, not as a recent time', () => {
    const v = createFleetSession({ userId: 'u-1' }, ports([device({ deviceId: 'till-9', lastSeenAt: undefined, silent: true })])).view('en');
    expect(v.devices[0]?.lastSeen).toBe('never checked in');
  });

  it('flags when the box was not told who is looking', () => {
    expect(createFleetSession({ userId: null }, ports([device()])).view('en').nobodyNamed).toBe(true);
    expect(createFleetSession({ userId: 'u-1' }, ports([device()])).view('en').nobodyNamed).toBe(false);
  });

  it('speaks both languages — every copy key has English and Tamil', () => {
    expect(isBilingualComplete(FLEET_COPY)).toBe(true);
    expect(createFleetSession({ userId: 'u-1' }, ports([device()])).text('ta', 'title')).toBe('சாதனங்கள்');
    // every verdict maps to a label key that exists in both languages (guards a verdict added without copy)
    for (const verdict of FLEET_VERDICTS) {
      const v = createFleetSession({ userId: 'u-1' }, ports([device({ verdict, mayTrade: verdict === 'ok' })])).view('ta');
      expect(v.devices[0]?.status.label.length).toBeGreaterThan(0);
    }
  });
});

// ── the register / block / retire write path (inc-2c-i): a governed action captured to the offline outbox ──

const managed = (
  devices: readonly FleetDeviceRow[],
  outbox: SyncOutbox,
  caps: { read?: boolean; manage?: boolean } = {},
): FleetPorts => {
  const base = ports(devices, { read: caps.read, manage: caps.manage ?? true });
  return { ...base, outbox: () => outbox };
};

describe('requestDeviceChange — the register/block/retire write path', () => {
  it('captures a block to the outbox: one command, its key, and the manager who asked', () => {
    const outbox = new SyncOutbox();
    const s = createFleetSession({ userId: 'u-mgr' }, managed([device({ deviceId: 'till-3', status: 'registered' })], outbox));
    const r = s.requestDeviceChange({ deviceId: 'till-3', change: 'block', reason: 'screen cracked', at: '2026-08-30T05:00:00Z' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.key).toBe(deviceChangeKey('till-3', 'block', 'registered'));
    expect(r.state).toBe('pending');
    const item = outbox.find(r.key);
    expect(item?.event.type).toBe(DEVICE_CHANGE_EVENT);
    const payload = item?.event.payload as DeviceChangePayload;
    expect(payload.requestedBy).toBe('u-mgr');       // stamped with WHO — never a bare store identity
    expect(payload.change).toBe('block');
    expect(payload.observedStatus).toBe('registered'); // captured for the dedupe identity
    expect(payload.reason).toBe('screen cracked');    // the append-only "why"
    // the idempotency key IS the event id, so a duplicate collapses
    expect(item?.event.idempotencyKey).toBe(item?.event.id);
  });

  it('is refused for someone who may not manage, or whom the box cannot name (P-05)', () => {
    const outbox = new SyncOutbox();
    const noManage = createFleetSession({ userId: 'u-1' }, managed([device({ status: 'registered' })], outbox, { manage: false }));
    expect(noManage.requestDeviceChange({ deviceId: 'till-3', change: 'block', reason: 'x', at: '2026-08-30T05:00:00Z' }))
      .toEqual({ ok: false, reason: 'not_permitted' });
    const nobody = createFleetSession({ userId: null }, managed([device({ status: 'registered' })], outbox));
    expect(nobody.requestDeviceChange({ deviceId: 'till-3', change: 'block', reason: 'x', at: '2026-08-30T05:00:00Z' }))
      .toEqual({ ok: false, reason: 'not_permitted' });
    expect(outbox.unsentCount()).toBe(0); // nothing queued under a refusal
  });

  it('refuses without an outbox — a read-only mount cannot change the fleet', () => {
    const base = ports([device({ status: 'registered' })], { manage: true });
    const s = createFleetSession({ userId: 'u-mgr' }, base); // no outbox port
    expect(s.requestDeviceChange({ deviceId: 'till-3', change: 'block', reason: 'x', at: '2026-08-30T05:00:00Z' }))
      .toEqual({ ok: false, reason: 'no_outbox' });
  });

  it('re-checks the transition against the device’s current status, not a stale button', () => {
    const outbox = new SyncOutbox();
    // block on a device nobody registered → unknown_device
    const empty = createFleetSession({ userId: 'u-mgr' }, managed([], outbox));
    expect(empty.requestDeviceChange({ deviceId: 'ghost', change: 'block', reason: 'x', at: '2026-08-30T05:00:00Z' }))
      .toEqual({ ok: false, reason: 'unknown_device' });
    // block on an already-blocked device → not_actionable
    const blocked = createFleetSession({ userId: 'u-mgr' }, managed([device({ deviceId: 'till-3', status: 'blocked' })], outbox));
    expect(blocked.requestDeviceChange({ deviceId: 'till-3', change: 'block', reason: 'x', at: '2026-08-30T05:00:00Z' }))
      .toEqual({ ok: false, reason: 'not_actionable' });
    // register a device already in the fleet → already_registered
    const reg = createFleetSession({ userId: 'u-mgr' }, managed([device({ deviceId: 'till-3', status: 'registered' })], outbox));
    expect(reg.requestDeviceChange({ deviceId: 'till-3', change: 'register', at: '2026-08-30T05:00:00Z', register: { branchId: 'b', kind: 'pos_lane', label: 'L' } }))
      .toEqual({ ok: false, reason: 'already_registered' });
    expect(outbox.unsentCount()).toBe(0);
  });

  it('requires a reason for a status change and full details for a register', () => {
    const outbox = new SyncOutbox();
    const s = createFleetSession({ userId: 'u-mgr' }, managed([device({ deviceId: 'till-3', status: 'registered' })], outbox));
    expect(s.requestDeviceChange({ deviceId: 'till-3', change: 'retire', reason: '  ', at: '2026-08-30T05:00:00Z' }))
      .toEqual({ ok: false, reason: 'missing_reason' });
    const add = createFleetSession({ userId: 'u-mgr' }, managed([], outbox));
    expect(add.requestDeviceChange({ deviceId: 'new-1', change: 'register', at: '2026-08-30T05:00:00Z', register: { branchId: '', kind: 'pos_lane', label: 'L' } }))
      .toEqual({ ok: false, reason: 'missing_details' });
    expect(outbox.unsentCount()).toBe(0);
  });

  it('collapses a double-click to one command (§31.1)', () => {
    const outbox = new SyncOutbox();
    const s = createFleetSession({ userId: 'u-mgr' }, managed([device({ deviceId: 'till-3', status: 'registered' })], outbox));
    expect(s.requestDeviceChange({ deviceId: 'till-3', change: 'retire', reason: 'sold', at: '2026-08-30T05:00:00Z' }).ok).toBe(true);
    expect(s.requestDeviceChange({ deviceId: 'till-3', change: 'retire', reason: 'sold', at: '2026-08-30T05:00:00Z' }))
      .toEqual({ ok: false, reason: 'already_queued' });
    expect(outbox.unsentCount()).toBe(1);
  });

  it('registers a brand-new device with its identity and an unregistered observed status', () => {
    const outbox = new SyncOutbox();
    const s = createFleetSession({ userId: 'u-mgr' }, managed([], outbox));
    const r = s.requestDeviceChange({ deviceId: 'scale-9', change: 'register', at: '2026-08-30T05:00:00Z', register: { branchId: 'b-main', kind: 'scale', label: 'Deli scale', appVersion: '2.0.0' } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const payload = outbox.find(r.key)?.event.payload as DeviceChangePayload;
    expect(payload.observedStatus).toBe('unregistered');
    expect(payload.register).toEqual({ branchId: 'b-main', kind: 'scale', label: 'Deli scale', appVersion: '2.0.0' });
  });

  it('offers block+retire on a registered device to a manager, and nothing to a read-only viewer', () => {
    const outbox = new SyncOutbox();
    const manager = createFleetSession({ userId: 'u-mgr' }, managed([device({ deviceId: 'till-3', status: 'registered' })], outbox));
    const row = manager.view('en').devices[0];
    expect(row?.actions.map((a) => a.change).sort()).toEqual(['block', 'retire']);
    expect(row?.actions.every((a) => a.enabled)).toBe(true);
    // a read-only viewer (cannot manage) is offered no actions
    const viewer = createFleetSession({ userId: 'u-1' }, ports([device({ status: 'registered' })], { manage: false }));
    expect(viewer.view('en').devices[0]?.actions).toEqual([]);
  });

  it('shows a queued action as in-flight and disabled, never invisible (P-08)', () => {
    const outbox = new SyncOutbox();
    const s = createFleetSession({ userId: 'u-mgr' }, managed([device({ deviceId: 'till-3', status: 'registered' })], outbox));
    s.requestDeviceChange({ deviceId: 'till-3', change: 'block', reason: 'x', at: '2026-08-30T05:00:00Z' });
    const block = s.view('en').devices[0]?.actions.find((a) => a.change === 'block');
    expect(block?.queued).toBe('pending');
    expect(block?.enabled).toBe(false);
    expect(block?.note).toBe('Requested — it will be sent when there is a connection.');
  });
});
