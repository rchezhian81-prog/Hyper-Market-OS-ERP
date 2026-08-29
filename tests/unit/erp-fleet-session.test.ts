import { describe, it, expect } from 'vitest';
import {
  createFleetSession, FLEET_COPY, FLEET_VERDICTS,
  type FleetDeviceRow, type FleetPorts, type FleetSummaryRollup,
} from '../../apps/web-erp/src/fleet-session';
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
