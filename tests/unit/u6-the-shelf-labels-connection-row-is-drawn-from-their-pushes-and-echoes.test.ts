import { describe, it, expect } from 'vitest';
import { shelfLabelsIntegration, SHELF_LABELS_ADAPTER_ID, ESL_ECHO_GRACE_MINUTES } from '../../services/platform/src/esl-integration';
import { adapterHealth } from '../../packages/integration/src/adapters';
import type { FloorDeviceLogEntry, StoredFloorEvent, EslPush } from '../../services/platform/src/device-events';

/**
 * **U6 (UI/UX gap audit §27 "Product — label/ESL … no integration row" · D14-FR-05 · M32-FR-04 · P-08): the shelf labels'
 * row on the Connections page is DRAWN from the facts head office holds — the labels registered, the prices pushed, the
 * echoes the labels sent back — never a second record (hard rule #2).** No label → no row. Labels but no push → "never
 * worked" (silent). A push the vendor took → healthy. A push nobody echoed after the grace → not ok as of now. Every label
 * echoed → healthy with the price named. Every label blocked → switched off.
 */
const T = '00000000-0000-4000-8000-0000000000e5';
const KEY = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n-----END PUBLIC KEY-----\n';
const reg = (deviceId: string, at: string, status?: 'blocked' | 'retired'): FloorDeviceLogEntry[] => [
  { entry: 'registered', by: 'u-it', at, registration: { deviceId, branchId: 'B1', label: `Label ${deviceId}`, vendor: 'stand-in', publicKey: KEY, binding: { kind: 'esl_label', productId: 'p-soap', shelfAddress: 'A1-01' } } },
  ...(status === undefined ? [] : [{ entry: 'status' as const, deviceId, status, reason: 'test', by: 'u-it', at }]),
];
const push = (pushId: string, at: string, labels: readonly string[], accepted = true): EslPush => ({
  pushId, branchId: 'B1', productId: 'p-soap', priceMinor: 4_500, because: 'price_change', sourceRef: 'chg-1', by: 'u-owner', at,
  commands: labels.map((deviceId) => ({ deviceId, accepted, detail: accepted ? 'taken' : 'the label vendor could not be reached' })), adapter: 'stand-in',
});
const echo = (deviceId: string, at: string, priceMinor = 4_500): StoredFloorEvent => ({
  deviceId, branchId: 'B1', kind: 'esl_label', eventId: `e-${deviceId}-${at}`, receivedAt: at, relayedBy: 'u-gw',
  event: { type: 'esl.echo', eventId: `e-${deviceId}-${at}`, at, productId: 'p-soap', displayedPriceMinor: priceMinor },
  outcome: { state: 'recorded', detail: `shows ₹${(priceMinor / 100).toFixed(2)}` },
});
const minutes = (base: string, n: number): string => new Date(Date.parse(base) + n * 60_000).toISOString();
const NOW = '2026-11-07T12:00:00.000Z';
const healthOf = (r: ReturnType<typeof shelfLabelsIntegration>) => adapterHealth({ config: r.config!, heartbeats: r.heartbeats, at: NOW });

describe('U6: the shelf labels\' connection row', () => {
  it('no label registered → no row; a label but no push → the row has never worked', () => {
    expect(shelfLabelsIntegration({ tenantId: T, log: [], pushes: [], events: [], now: NOW }).config).toBeUndefined();
    const r = shelfLabelsIntegration({ tenantId: T, log: reg('esl-1', minutes(NOW, -600)), pushes: [], events: [], now: NOW });
    expect(r.config).toMatchObject({ adapterId: SHELF_LABELS_ADAPTER_ID, category: 'hardware', vendor: 'stand-in', enabled: true });
    expect(healthOf(r).state).toBe('silent');
    expect(healthOf(r).minutesSinceLastSuccess).toBe('never');
  });

  it('a push the vendor took is healthy inside the grace; unechoed after the grace it is not ok as of now; echoed, healthy and named', () => {
    const log = [...reg('esl-1', minutes(NOW, -600)), ...reg('esl-2', minutes(NOW, -600))];
    const fresh = shelfLabelsIntegration({ tenantId: T, log, pushes: [push('p1', minutes(NOW, -2), ['esl-1', 'esl-2'])], events: [], now: NOW });
    expect(fresh.heartbeats.map((h) => h.ok)).toEqual([true]); // the push, taken; nothing "as of now" inside the grace
    expect(healthOf(fresh).state).toBe('healthy');

    const stale = shelfLabelsIntegration({ tenantId: T, log, pushes: [push('p1', minutes(NOW, -(ESL_ECHO_GRACE_MINUTES + 5)), ['esl-1', 'esl-2'])], events: [echo('esl-1', minutes(NOW, -18))], now: NOW });
    const asOfNow = stale.heartbeats.at(-1)!;
    expect(asOfNow).toMatchObject({ at: NOW, ok: false });
    expect(asOfNow.detail).toMatch(/not shown by 1 label\(s\): esl-2/);
    expect(healthOf(stale).state).toBe('degraded');

    const done = shelfLabelsIntegration({ tenantId: T, log, pushes: [push('p1', minutes(NOW, -40), ['esl-1', 'esl-2'])], events: [echo('esl-1', minutes(NOW, -38)), echo('esl-2', minutes(NOW, -37))], now: NOW });
    expect(done.heartbeats.at(-1)).toMatchObject({ at: NOW, ok: true });
    expect(done.heartbeats.at(-1)!.detail).toMatch(/₹45\.00 for p-soap at B1\) is shown by every label/);
    expect(healthOf(done).state).toBe('healthy');
    expect(done.basis).toMatch(/2 of 2 label\(s\) active · 1 price push\(es\)/);
  });

  it('a push no label took, and a refused report, are failures; every label blocked switches the row off', () => {
    const log = [...reg('esl-1', minutes(NOW, -600))];
    const bad = shelfLabelsIntegration({
      tenantId: T, log, now: NOW,
      pushes: [push('p1', minutes(NOW, -50), ['esl-1'], false), push('p2', minutes(NOW, -40), ['esl-1'], false), push('p3', minutes(NOW, -30), ['esl-1'], false)],
      events: [{ ...echo('esl-1', minutes(NOW, -20)), outcome: { state: 'refused', code: 'label_shows_another_product', detail: 'the label shows p-rice' } }],
    });
    expect(bad.heartbeats.every((h) => !h.ok)).toBe(true);
    expect(healthOf(bad).state).toBe('silent'); // never a success — said as such, not as "configured"
    const off = shelfLabelsIntegration({ tenantId: T, log: reg('esl-1', minutes(NOW, -600), 'blocked'), pushes: [], events: [], now: NOW });
    expect(off.config?.enabled).toBe(false);
    expect(healthOf(off).state).toBe('disabled');
  });
});
