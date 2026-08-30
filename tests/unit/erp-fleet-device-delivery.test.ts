import { describe, it, expect } from 'vitest';
import {
  classifyDeviceResponse, deliverQueuedDeviceChanges, deviceChangeRequest, type FleetDeliveryPort,
} from '../../apps/web-erp/src/fleet-device-delivery';
import { buildDeviceChangeCommand, type DeviceChangeCommand } from '../../apps/web-erp/src/fleet-device-command';
import { SyncOutbox } from '../../packages/sync/src/outbox';

// The device-fleet delivery step (M33-FR-02/04, P-04/P-05, hard rule #6). Drains the offline outbox through an
// operator-authenticated port, transitioning each command honestly: accepted → done, lost link → held for
// retry, a real refusal → dead-lettered and kept for a person.

const AT = '2026-08-30T05:00:00Z';
const blockCmd = (deviceId = 'till-3'): DeviceChangeCommand =>
  buildDeviceChangeCommand({ deviceId, change: 'block', observedStatus: 'registered', requestedBy: 'u-mgr', at: AT, reason: 'cracked' });

/** A port that answers each command with a scripted status, and records what it was asked to send. */
const scriptedPort = (answer: (cmd: DeviceChangeCommand) => number) => {
  const sent: { deviceId: string; key: string }[] = [];
  const port: FleetDeliveryPort = {
    post: (command, idempotencyKey) => {
      sent.push({ deviceId: command.payload.deviceId, key: idempotencyKey });
      return Promise.resolve(answer(command));
    },
  };
  return { port, sent };
};

describe('classifyDeviceResponse', () => {
  it('treats 2xx as accepted', () => {
    expect(classifyDeviceResponse(200)).toBe('accepted');
    expect(classifyDeviceResponse(201)).toBe('accepted');
  });
  it('treats a lost link, a 5xx and a transient 4xx as retryable', () => {
    for (const s of [0, 500, 503, 408, 425, 429, 401]) expect(classifyDeviceResponse(s)).toBe('retryable');
  });
  it('treats a permanent 4xx (403 not-authorised, 404 not-registered, 400) as rejected', () => {
    for (const s of [400, 403, 404, 409]) expect(classifyDeviceResponse(s)).toBe('rejected');
  });
});

describe('deviceChangeRequest — command → registry route + body', () => {
  it('maps a block to the status route with the target status and reason', () => {
    const req = deviceChangeRequest(blockCmd('till-3'));
    expect(req.path).toBe('/v1/platform/devices/till-3/status');
    expect(req.body).toEqual({ status: 'blocked', reason: 'cracked' });
  });

  it('maps retire and bring-back to their target statuses', () => {
    const retire = deviceChangeRequest(buildDeviceChangeCommand({ deviceId: 'd', change: 'retire', observedStatus: 'registered', requestedBy: 'u', at: AT, reason: 'old' }));
    expect(retire.body).toEqual({ status: 'retired', reason: 'old' });
    const back = deviceChangeRequest(buildDeviceChangeCommand({ deviceId: 'd', change: 'reinstate', observedStatus: 'blocked', requestedBy: 'u', at: AT, reason: 'fixed' }));
    expect(back.body).toEqual({ status: 'registered', reason: 'fixed' });
  });

  it('maps a register to the register route with the device identity, and URL-encodes the id', () => {
    const req = deviceChangeRequest(buildDeviceChangeCommand({
      deviceId: 'kiosk/2', change: 'register', observedStatus: 'unregistered', requestedBy: 'u', at: AT,
      register: { branchId: 'main', kind: 'kiosk', label: 'Front kiosk', appVersion: '2.0.0' },
    }));
    expect(req.path).toBe('/v1/platform/devices/kiosk%2F2/register');
    expect(req.body).toEqual({ branchId: 'main', kind: 'kiosk', label: 'Front kiosk', appVersion: '2.0.0' });
  });
});

describe('deliverQueuedDeviceChanges', () => {
  it('acknowledges a change the cloud accepts, carrying the command’s own idempotency key', () => {
    const outbox = new SyncOutbox();
    const item = outbox.enqueue(blockCmd());
    const { port, sent } = scriptedPort(() => 200);
    return deliverQueuedDeviceChanges(outbox, port).then((report) => {
      expect(report.delivered).toEqual([item.key]);
      expect(report.held).toEqual([]);
      expect(report.refused).toEqual([]);
      expect(outbox.find(item.key)?.state).toBe('acknowledged');
      expect(outbox.unsentCount()).toBe(0);
      expect(sent[0]?.key).toBe(item.event.idempotencyKey); // a retry cannot apply the change twice
    });
  });

  it('holds a lost-link change pending for retry — a slow link never loses it', async () => {
    const outbox = new SyncOutbox();
    const item = outbox.enqueue(blockCmd());
    const report = await deliverQueuedDeviceChanges(outbox, scriptedPort(() => 0).port);
    expect(report.held).toEqual([item.key]);
    expect(outbox.find(item.key)?.state).toBe('pending'); // still pending
    expect(outbox.find(item.key)?.attempts).toBe(1);       // attempt counted
    expect(outbox.unsentCount()).toBe(1);
  });

  it('dead-letters a refusal, kept for a person, never silently dropped (hard rule #6)', async () => {
    const outbox = new SyncOutbox();
    const item = outbox.enqueue(blockCmd());
    const report = await deliverQueuedDeviceChanges(outbox, scriptedPort(() => 403).port);
    expect(report.refused).toEqual([item.key]);
    expect(outbox.find(item.key)?.state).toBe('dead_letter');
    expect(outbox.find(item.key)?.reason).toContain('403');
    expect(outbox.deadLetters()).toHaveLength(1); // visible, not gone
  });

  it('drains a mixed batch, transitioning each on its own answer', async () => {
    const outbox = new SyncOutbox();
    const ok = outbox.enqueue(blockCmd('a'));
    const held = outbox.enqueue(buildDeviceChangeCommand({ deviceId: 'b', change: 'retire', observedStatus: 'registered', requestedBy: 'u', at: AT, reason: 'old' }));
    const bad = outbox.enqueue(buildDeviceChangeCommand({ deviceId: 'c', change: 'block', observedStatus: 'registered', requestedBy: 'u', at: AT, reason: 'x' }));
    const answers: Record<string, number> = { a: 200, b: 0, c: 404 };
    const report = await deliverQueuedDeviceChanges(outbox, scriptedPort((cmd) => answers[cmd.payload.deviceId] ?? 500).port);
    expect(report.delivered).toEqual([ok.key]);
    expect(report.held).toEqual([held.key]);
    expect(report.refused).toEqual([bad.key]);
    expect(outbox.unsentCount()).toBe(1); // only the held one still waits
  });

  it('does not re-send an already-acknowledged change on a second drain', async () => {
    const outbox = new SyncOutbox();
    outbox.enqueue(blockCmd());
    const first = scriptedPort(() => 200);
    await deliverQueuedDeviceChanges(outbox, first.port);
    const second = scriptedPort(() => 200);
    const report = await deliverQueuedDeviceChanges(outbox, second.port);
    expect(second.sent).toHaveLength(0); // nothing pending — the port is not called again
    expect(report.delivered).toEqual([]);
  });
});
