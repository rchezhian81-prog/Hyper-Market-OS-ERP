import { describe, it, expect } from 'vitest';
import {
  DEVICE_CHANGE_EVENT, DEVICE_CHANGE_KINDS, DEVICE_KINDS,
  deviceChangeAllowed, deviceChangeKey, statusForChange, buildDeviceChangeCommand, queueDeviceChange,
  type DeviceChangePayload,
} from '../../apps/web-erp/src/fleet-device-command';
import { SyncOutbox } from '../../packages/sync/src/outbox';

// The device-fleet write path (M33-FR-02/04, §31, P-01, P-04/P-05). A governance command captured to the
// offline outbox: guarded against the device's observed status, human-attributed, deduplicated by content.

describe('deviceChangeAllowed — the status-transition guard', () => {
  it('register is allowed only for a device not already in the fleet', () => {
    expect(deviceChangeAllowed('register', 'unregistered')).toEqual({ ok: true });
    expect(deviceChangeAllowed('register', 'registered')).toEqual({ ok: false, reason: 'already_registered' });
  });

  it('block only from registered; a device nobody registered is unknown', () => {
    expect(deviceChangeAllowed('block', 'registered')).toEqual({ ok: true });
    expect(deviceChangeAllowed('block', 'blocked')).toEqual({ ok: false, reason: 'not_actionable' });
    expect(deviceChangeAllowed('block', 'unregistered')).toEqual({ ok: false, reason: 'unknown_device' });
  });

  it('retire from registered or blocked, but a retired device is terminal', () => {
    expect(deviceChangeAllowed('retire', 'registered')).toEqual({ ok: true });
    expect(deviceChangeAllowed('retire', 'blocked')).toEqual({ ok: true });
    expect(deviceChangeAllowed('retire', 'retired')).toEqual({ ok: false, reason: 'not_actionable' });
  });

  it('reinstate brings back a blocked or retired device, but not one already trading', () => {
    expect(deviceChangeAllowed('reinstate', 'blocked')).toEqual({ ok: true });
    expect(deviceChangeAllowed('reinstate', 'retired')).toEqual({ ok: true });
    expect(deviceChangeAllowed('reinstate', 'registered')).toEqual({ ok: false, reason: 'not_actionable' });
  });
});

describe('statusForChange — the registry status a change moves a device to', () => {
  it('maps the status changes and leaves register (a different route) as null', () => {
    expect(statusForChange('register')).toBeNull();
    expect(statusForChange('block')).toBe('blocked');
    expect(statusForChange('retire')).toBe('retired');
    expect(statusForChange('reinstate')).toBe('registered');
  });
  it('covers every change kind', () => {
    for (const change of DEVICE_CHANGE_KINDS) expect(() => statusForChange(change)).not.toThrow();
  });
});

describe('deviceChangeKey / buildDeviceChangeCommand — the dedupe identity', () => {
  it('keys on change + device + observed status, so the same request collapses', () => {
    expect(deviceChangeKey('till-3', 'block', 'registered')).toBe('device-change|block|till-3|registered');
    // a re-request after the device moves to a new status is a DISTINCT command
    expect(deviceChangeKey('till-3', 'retire', 'blocked')).not.toBe(deviceChangeKey('till-3', 'retire', 'registered'));
  });

  it('builds a command whose id equals its idempotency key and carries the manager', () => {
    const cmd = buildDeviceChangeCommand({
      deviceId: 'till-3', change: 'block', observedStatus: 'registered', requestedBy: 'u-mgr', at: '2026-08-30T05:00:00Z', reason: 'cracked',
    });
    expect(cmd.type).toBe(DEVICE_CHANGE_EVENT);
    expect(cmd.id).toBe(cmd.idempotencyKey);
    expect(cmd.source).toBe('web-erp/fleet');
    const p = cmd.payload as DeviceChangePayload;
    expect(p).toMatchObject({ deviceId: 'till-3', change: 'block', requestedBy: 'u-mgr', observedStatus: 'registered', reason: 'cracked' });
    expect(p.register).toBeUndefined();
  });
});

describe('queueDeviceChange — validate then enqueue', () => {
  it('queues a valid status change once and refuses a duplicate', () => {
    const outbox = new SyncOutbox();
    const first = queueDeviceChange(outbox, { deviceId: 'till-3', change: 'block', observedStatus: 'registered', requestedBy: 'u-mgr', at: '2026-08-30T05:00:00Z', reason: 'cracked' });
    expect(first).toMatchObject({ ok: true, state: 'pending' });
    const again = queueDeviceChange(outbox, { deviceId: 'till-3', change: 'block', observedStatus: 'registered', requestedBy: 'u-mgr', at: '2026-08-30T05:00:00Z', reason: 'cracked' });
    expect(again).toEqual({ ok: false, refusal: 'already_queued' });
    expect(outbox.unsentCount()).toBe(1);
  });

  it('refuses an illegal transition before it ever queues', () => {
    const outbox = new SyncOutbox();
    expect(queueDeviceChange(outbox, { deviceId: 'till-3', change: 'block', observedStatus: 'unregistered', requestedBy: 'u', at: '2026-08-30T05:00:00Z', reason: 'x' }))
      .toEqual({ ok: false, refusal: 'unknown_device' });
    expect(outbox.unsentCount()).toBe(0);
  });

  it('requires a non-blank reason for a status change', () => {
    const outbox = new SyncOutbox();
    expect(queueDeviceChange(outbox, { deviceId: 'till-3', change: 'retire', observedStatus: 'registered', requestedBy: 'u', at: '2026-08-30T05:00:00Z', reason: '   ' }))
      .toEqual({ ok: false, refusal: 'missing_reason' });
  });

  it('requires a branch, a known kind and a label for a register', () => {
    const outbox = new SyncOutbox();
    const bad = (register: { branchId: string; kind: string; label: string }) =>
      queueDeviceChange(outbox, { deviceId: 'new-1', change: 'register', observedStatus: 'unregistered', requestedBy: 'u', at: '2026-08-30T05:00:00Z', register: register as never });
    expect(bad({ branchId: '', kind: 'pos_lane', label: 'L' })).toEqual({ ok: false, refusal: 'missing_details' });
    expect(bad({ branchId: 'b', kind: 'pos_lane', label: '' })).toEqual({ ok: false, refusal: 'missing_details' });
    expect(bad({ branchId: 'b', kind: 'not_a_kind', label: 'L' })).toEqual({ ok: false, refusal: 'missing_details' });
    // a complete register queues, and its payload carries the identity
    expect(DEVICE_KINDS).toContain('pos_lane');
    const ok = queueDeviceChange(outbox, { deviceId: 'new-1', change: 'register', observedStatus: 'unregistered', requestedBy: 'u', at: '2026-08-30T05:00:00Z', register: { branchId: 'b', kind: 'pos_lane', label: 'Lane 1' } });
    expect(ok.ok).toBe(true);
  });

  it('a register never carries a reason and a status change never carries register details', () => {
    const outbox = new SyncOutbox();
    queueDeviceChange(outbox, { deviceId: 'new-1', change: 'register', observedStatus: 'unregistered', requestedBy: 'u', at: '2026-08-30T05:00:00Z', reason: 'ignored', register: { branchId: 'b', kind: 'kiosk', label: 'K' } });
    queueDeviceChange(outbox, { deviceId: 'till-3', change: 'block', observedStatus: 'registered', requestedBy: 'u', at: '2026-08-30T05:00:00Z', reason: 'x', register: { branchId: 'b', kind: 'kiosk', label: 'K' } });
    const reg = outbox.find(deviceChangeKey('new-1', 'register', 'unregistered'))?.event.payload as DeviceChangePayload;
    const blk = outbox.find(deviceChangeKey('till-3', 'block', 'registered'))?.event.payload as DeviceChangePayload;
    expect(reg.reason).toBeUndefined();
    expect(reg.register).toBeDefined();
    expect(blk.register).toBeUndefined();
    expect(blk.reason).toBe('x');
  });
});
