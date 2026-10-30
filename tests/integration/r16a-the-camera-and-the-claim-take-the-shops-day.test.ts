import { describe, it, expect, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { r3OpsBackings, tenantClient } from '../support/r3-ops-backings';
import type { ApiHarness } from '../support/api-harness';
import { ownerApprovedSetting } from '../support/owner-approved-setting';
import { pinTheEveningClock } from '../support/evening-clock';
import { floorDevicesAdapter, StandInEslVendor } from '../../services/api/src/floor-devices-adapters';
import { rebateClaimsAdapter } from '../../services/api/src/rebate-claims-adapters';

/**
 * **Round 16 (R16-A · P3 · M01-FR-02 · P-08): a camera event's day (the CCTV links) and a rebate claim's "raised on" are the
 * SHOP's date, in the tenant's calendar, on the live API.**
 *
 * The clock is pinned to an evening UTC moment (tests/support/evening-clock.ts): 01:00 the next morning in the shop. A camera
 * event and a raised claim are KEPT at that moment (through head office's own adapters, as the gateway relay and the raise
 * route keep them), head office restarts cold, and then: the CCTV links of the shop's day list the event (not those of the
 * UTC day before), and the claim document says it was raised on the shop's date. The tenant's zone is then changed
 * (owner-approved) to one still on the UTC date, and both follow it. In memory and on real PostgreSQL. Synthetic data only.
 */

const backings = r3OpsBackings();
const evening = pinTheEveningClock();
afterAll(() => { vi.useRealTimers(); });

describe.each(backings)('the camera and the claim take the shop\'s day — on $name (R16-A P3)', ({ harness, restart }) => {
  it('after a cold restart: the event is on the shop\'s day\'s CCTV links and the claim was raised on the shop\'s date; both follow the tenant\'s zone', async () => {
    const tenant = randomUUID();
    let h: ApiHarness = harness();
    await h.seedOwner(tenant, 'u-owner');
    const now = (): string => new Date().toISOString();

    // ── kept at 01:00 shop time: a camera at branch B1 and its event; a raised rebate claim ─────────────────────────────
    const floor = floorDevicesAdapter({ store: h.store, now, eslVendor: new StandInEslVendor() }, []);
    await floor.recordLog(tenant, { entry: 'registered', by: 'u-owner', at: evening.at, registration: { deviceId: 'cam-1', branchId: 'B1', label: 'Lane camera', vendor: 'stand-in', publicKey: 'not-used-here', binding: { kind: 'cctv_source', cameraId: 'CAM-1', laneIds: ['lane-1'] } } });
    await floor.recordEvents(tenant, [{
      deviceId: 'cam-1', branchId: 'B1', kind: 'cctv_source', eventId: 'c1', receivedAt: evening.at, relayedBy: 'u-gw',
      event: { eventId: 'c1', type: 'cctv.event', at: evening.at, from: evening.at, to: new Date(Date.parse(evening.at) + 5 * 60_000).toISOString(), eventKind: 'lane_activity' } as never,
      outcome: { state: 'recorded', detail: 'kept' },
    }]);
    await rebateClaimsAdapter({ store: h.store, now }).recordFact(tenant, 'rb-1', { type: 'raised', claimId: 'c-1', schemeId: 'rb-1', supplierId: 'sup-1', amountMinor: 1_500, raisedBy: 'u-owner', raisedAt: evening.at }, undefined as never);

    h = restart(h); // ── COLD RESTART ──────────────────────────────────────────────────────────────────────────────────────
    await h.provisionRole(tenant, 'u-cash', 'cashier', ['B1']);
    const { req, ok } = tenantClient(() => h, tenant);
    const links = async (day: string): Promise<string[]> => ((await ok(req('GET', '/v1/devices/cctv/links', undefined, 'u-owner', { branchId: 'B1', day }), 'links')).body as { links: { eventId: string }[] }).links.map((l) => l.eventId);
    const raisedOn = async (): Promise<string> => ((await ok(req('GET', '/v1/purchase/rebate-claims/c-1/document'), 'document')).body as { document: { raisedOn: string } }).document.raisedOn;

    expect(await links(evening.shopDate)).toEqual(['c1']);
    expect(await links(evening.utcDate)).toEqual([]);
    expect(await raisedOn()).toBe(evening.shopDate);

    // The shop's zone is the TENANT's: in a zone still on the UTC date, both are on the UTC date.
    expect((await ownerApprovedSetting(h, tenant, 'locale.time_zone', { value: 'Europe/London' })).status).toBe(200);
    expect(await links(evening.utcDate)).toEqual(['c1']);
    expect(await links(evening.shopDate)).toEqual([]);
    expect(await raisedOn()).toBe(evening.utcDate);

    // The error paths are unchanged: a cashier reads neither.
    expect((await req('GET', '/v1/devices/cctv/links', undefined, 'u-cash', { branchId: 'B1', day: evening.shopDate })).status).toBe(403);
    expect((await req('GET', '/v1/purchase/rebate-claims/c-1/document', undefined, 'u-cash')).status).toBe(403);
  }, 60_000);
});
