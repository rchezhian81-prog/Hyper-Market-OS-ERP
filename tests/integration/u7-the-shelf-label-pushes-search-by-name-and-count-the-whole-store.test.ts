import { describe, it, expect } from 'vitest';
import { floorDeviceRoutes, type FloorDeviceDeps, type EslPush, type StoredFloorEvent } from '../../services/platform/src/device-events';
import type { RequestContext, Route } from '../../services/kernel/src/index';

/**
 * U7 (OB-726) · the Shelf labels page pages its pushes at head office. A person searches by the product's NAME (head office
 * reads the product master), and the page's cards and "Send all again" read a SUMMARY of the whole store's pushes that
 * head office answers beside the page — never counted from the ten rows on screen (P-08).
 */
const T = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const route = (routes: readonly Route[]): Route => routes.find((r) => r.method === 'GET' && r.path === '/v1/devices/esl/pushes')!;
const ctxOf = (query: Record<string, string>): RequestContext => ({ tenantId: T, userId: 'u-owner', scope: 'all', params: {}, query, body: undefined, traceId: 't' } as unknown as RequestContext);
const push = (n: number, product: string, devices: readonly string[]): EslPush => ({
  pushId: `p${n}`, branchId: 'S1', productId: product, priceMinor: 100 * n, because: 'price_change', sourceRef: `s${n}`, by: 'u',
  at: `2026-11-1${n}T08:00:00.000Z`, commands: devices.map((deviceId) => ({ deviceId, accepted: true, detail: 'ok' })), adapter: 'stub',
} as unknown as EslPush);

describe('U7 · shelf-label pushes: search by name, counts from the whole store', () => {
  // p1 MILK on d1 (confirmed by d1) · p2 RICE on d2+d3 (d2 only: partial) · p3 DAL on d4 (none: unconfirmed) · p4 SALT, no labels
  const pushes = [push(1, 'MILK', ['d1']), push(2, 'RICE', ['d2', 'd3']), push(3, 'DAL', ['d4']), push(4, 'SALT', [])];
  // A label echoes the price it shows (the stored, recorded `esl.echo` event the confirmations are read from).
  const confirm = (deviceId: string, priceMinor: number, productId: string): StoredFloorEvent => ({
    kind: 'esl_label', deviceId, branchId: 'S1', outcome: { state: 'recorded' },
    event: { type: 'esl.echo', productId, displayedPriceMinor: priceMinor, at: '2026-11-15T08:00:00.000Z' },
  } as unknown as StoredFloorEvent);
  const names: Record<string, string> = { MILK: 'Toned milk 500 ml', RICE: 'Ponni rice (loose)', DAL: 'Toor dal 1 kg', SALT: 'Salt 1 kg' };
  const deps = {
    pushes: async () => pushes, events: async () => [confirm('d1', 100, 'MILK'), confirm('d2', 200, 'RICE')],
    now: () => '2026-11-16T09:00:00.000Z', productName: async (_t: string, id: string) => names[id],
  } as unknown as FloorDeviceDeps;

  it('finds a push by the product\'s name, not only its code', async () => {
    const body = (await route(floorDeviceRoutes(deps)).handler(ctxOf({ branchId: 'S1', page: '1', size: '10', search: 'ponni' }))).body as { pushes: { push: { pushId: string } }[]; paging: { total: number } };
    expect(body.pushes.map((p) => p.push.pushId)).toEqual(['p2']);
    expect(body.paging.total).toBe(1);
  });

  it('answers a summary of the WHOLE store beside one page: sent, shown everywhere, waiting (with what "send all again" needs)', async () => {
    const body = (await route(floorDeviceRoutes(deps)).handler(ctxOf({ branchId: 'S1', page: '1', size: '1' }))).body as { pushes: unknown[]; summary: { sent: number; confirmed: number; waiting: number; noLabels: number; waitingPushes: { pushId: string; productId: string; priceMinor: number; unconfirmed: number }[] } };
    expect(body.pushes).toHaveLength(1);
    expect(body.summary).toMatchObject({ sent: 4, confirmed: 1, waiting: 2, noLabels: 1 });
    expect(body.summary.waitingPushes).toEqual([
      { pushId: 'p3', productId: 'DAL', priceMinor: 300, unconfirmed: 1 },
      { pushId: 'p2', productId: 'RICE', priceMinor: 200, unconfirmed: 1 },
    ]);
  });
});
