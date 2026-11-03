import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { HAVE_BROWSER, startBoxPageShop, says, type BoxPageShop } from './lib/r4c-box-page';
import { aBranch } from '../support/a-branch';

/**
 * **Round 4c (M33-FR-02): Tills & devices registers a till, in a real browser, on the store computer, to head office's
 * device registry.** The form refuses a register with no name before anything is queued; a full one waits in the outbox
 * until "Send now", then reaches `POST /v1/platform/devices/:id/register` as the signed-in manager, and head office lists
 * the till. A cashier the box lets press it is refused by head office: the change is kept for a person, never applied.
 */

const OWNER = 'u-owner'; const MGR = 'u-mgr'; const CASH = 'u-cash';
const FLEET_WORDS = ['platform.health.read', 'platform.device.manage'];
// W6 (M33-FR-04): the page reads head office's fleet health with a POST that records nothing — a read, not a change.
const notTheFleetRead = (w: string): boolean => w !== 'POST /v1/platform/devices/fleet-health';

describe.skipIf(!HAVE_BROWSER)('Tills & devices: register a till (Round 4c)', () => {
  let shop: BoxPageShop;
  beforeAll(async () => {
    shop = await startBoxPageShop({
      name: 'fleet', pack: { fleetPolicy: { permissions: [] } },
      people: [{ userId: MGR, permissions: FLEET_WORDS }, { userId: CASH, permissions: FLEET_WORDS }],
      seed: async (ho, T, store) => {
        await ho.seedOwner(T, OWNER);
        await aBranch(ho, T, OWNER, store);
        await ho.provisionRole(T, MGR, 'store_manager', [store]);
        await ho.provisionRole(T, CASH, 'cashier', [store]);
      },
    });
  }, 240_000);
  afterAll(async () => { await shop?.stop(); });

  const register = async (who: string, id: string) => {
    const p = await shop.open(who, '/fleet/');
    await p.page.waitForSelector('#register:not([hidden])');
    await p.page.fill('#reg-id', id); await p.page.selectOption('#reg-kind', 'pos_lane'); await p.page.fill('#reg-store', shop.store);
    await p.page.click('#reg-btn');
    await says(p.page, '#reg-status', /Give the device id, its kind, a name and the store/);
    expect(p.writes.filter(notTheFleetRead)).toEqual([]);
    await p.page.fill('#reg-label', 'Till 4 by the door');
    await p.page.click('#reg-btn');
    await says(p.page, '#reg-status', /Waiting to send/);
    expect(p.writes.filter(notTheFleetRead)).toEqual([]);
    await p.page.click('#send');
    return p;
  };

  it('the manager registers a till; it waits until "Send now", then head office lists it', async () => {
    const m = await register(MGR, 'lane-4');
    await says(m.page, '#deliver-msg', /^1 sent/);
    expect(m.writes.filter(notTheFleetRead)).toEqual(['POST /v1/platform/devices/lane-4/register']);
    const fleet = (await shop.call('GET', '/v1/platform/devices', OWNER)).body as { devices: { deviceId: string; kind: string; label: string; branchId: string }[] };
    expect(fleet.devices).toEqual([expect.objectContaining({ deviceId: 'lane-4', kind: 'pos_lane', label: 'Till 4 by the door', branchId: shop.store })]);
    expect(m.errors).toEqual([]);
    await m.close();
  });

  it('a cashier is refused by head office: the change is kept for a person, never applied', async () => {
    const c = await register(CASH, 'lane-9');
    await says(c.page, '#deliver-msg', /could not be sent — a person should check/);
    const fleet = (await shop.call('GET', '/v1/platform/devices', OWNER)).body as { devices: { deviceId: string }[] };
    expect(fleet.devices.map((d) => d.deviceId)).not.toContain('lane-9');
    await c.close();
  });
});
