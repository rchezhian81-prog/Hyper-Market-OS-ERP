import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { join } from 'node:path';
import { backingsFor, headOffice, linkBoxTo, startBox, storePack, type Box } from '../support/till-bill-world';
import { signInAtLane, operatorHeader } from '../support/till-operator';
import { readLog } from '../../edge/store-edge/src/file-log';
import { deviceBatchMessage } from '../../packages/integration/src/floor-devices';

/**
 * **R8-3 · R8-7 (M15) — a paid self-checkout basket's evidence goes from the lane to the store computer's disk, survives
 * its cold restart, reaches head office through the store computer's own relay, and is read by the loss-prevention office
 * beside the camera events.** On the in-memory store AND real PostgreSQL (DATABASE_URL), head office restarted cold.
 *
 * The box believes the record only when the payment it names was confirmed by the colleague signed in at the lane; head
 * office stamps the relaying box's store, re-checks that colleague's till authority from its own grants, keeps it once,
 * and ranks the day's baskets by what needed a colleague — the risk figure "not set" while the owner has not set it.
 */

const { backings, open, close } = backingsFor(process.env['DATABASE_URL']);
beforeAll(open);
afterAll(close);
const boxes: Box[] = [];
afterEach(async () => { for (const b of boxes.splice(0)) { await b.stop(); await b.remove(); } });

type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;

const evidence = (paidBy: string, at: string) => ({
  format: 'sre-sco-basket/1', lines: 2, voids: 1, riskBps: null, auditSelected: null,
  interventions: [
    { kind: 'age_check', blocking: true, outcome: 'old_enough', settledBy: 'u-attend', at, productId: 'P-CIG' },
    { kind: 'payment', blocking: true, outcome: 'approved', settledBy: paidBy, at },
  ],
});

describe.each(backings)('a self-checkout basket reaches loss prevention and the camera links — on $name', (backing) => {
  it('lane → box disk → cold restart → head office (stamped, re-checked, once) → ranked for the office → linked to a camera event', async () => {
    const ho = await headOffice(backing, [
      { userId: 'u-it', role: 'platform_admin' }, { userId: 'u-box', role: 'store_computer', stores: ['B1'] },
      { userId: 'u-gw', role: 'floor_device_gateway', stores: ['B1'] }, { userId: 'u-attend', role: 'cashier', stores: ['B1'] },
    ]);
    await ho.ok('POST', '/v1/org/nodes/SRE', 'u-owner', { kind: 'company', name: 'SRE Hyper Market Private Limited' });
    await ho.ok('POST', '/v1/org/nodes/B1', 'u-owner', { kind: 'branch', name: 'Store B1', parentId: 'SRE', companyId: 'SRE' });
    await ho.ok('POST', '/v1/platform/devices/lane-1/register', 'u-owner', { branchId: 'B1', kind: 'pos_lane', label: 'Lane 1 (self-checkout)' });

    const link = linkBoxTo(ho, 'u-box', 'B1');
    try {
      const box = await startBox({ tenantId: ho.tenantId, people: [{ userId: 'u-attend', displayName: 'Attendant' }, { userId: 'u-other', displayName: 'Other' }], pack: storePack('B1'), cloud: { boxUser: 'u-box', storeId: 'B1' } });
      boxes.push(box);
      const port = box.edge.lane!.port;
      const post = async (token: string, body: unknown): Promise<Record<string, unknown>> => (await (await fetch(`http://127.0.0.1:${port}/lane/till-activity`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...operatorHeader(token) }, body: JSON.stringify(body),
      })).json()) as Record<string, unknown>;
      const at = new Date().toISOString();
      const token = await signInAtLane(port, 'u-attend');
      const basket = { activityId: 'SCO-S-1', kind: 'self_checkout_basket', billRef: 'S-1', valueMinor: 25_000, reason: 'self-checkout basket', selfCheckout: evidence('u-attend', at) };

      // The box refuses what it cannot believe, by name: a payment confirmed by someone else, an unreadable record.
      const other = await signInAtLane(port, 'u-other');
      expect(await post(other, basket)).toMatchObject({ recorded: false, refusedBecause: 'payment_not_confirmed_by_this_colleague' });
      expect(await post(token, { ...basket, selfCheckout: { ...evidence('u-attend', at), interventions: [{ kind: 'age_check', blocking: true, outcome: 'sent_to_scale', settledBy: 'u-attend', at }] } })).toMatchObject({ recorded: false, refusedBecause: 'not_readable' });
      // No colleague signed in: the till door refuses before anything is read.
      expect(await post('not-a-session', basket)).toMatchObject({ recorded: false });
      expect(await post(token, basket)).toMatchObject({ recorded: true });
      expect(await post(token, basket)).toMatchObject({ recorded: true, laneMessage: 'Already recorded.' });

      // On the box's own disk, once — and still once after a cold restart.
      await box.restartCold();
      const kept = (await readLog(join(box.dir, 'device-events.log'))).flatMap((r) => (r.ok ? [JSON.parse(r.record) as { type: string; payload: Record<string, unknown> }] : [])).filter((e) => e.type === 'SelfCheckoutBasketRecorded');
      expect(kept).toHaveLength(1);
      const day = kept[0]!.payload['tradingDay'] as string;

      // The box's own relay carries it to head office (the store computer's role covers the route).
      const sent = await box.edge.syncOnce!();
      expect(sent.dead, JSON.stringify(sent)).toBe(0);
      ho.restartCold(); // ── head office COLD ──

      const view = await ho.ok('GET', '/v1/loss-prevention/self-checkout', 'u-owner', undefined, { branchId: 'B1', day }) as { baskets: Record<string, unknown>[]; count: number; withColleague: number; flagged: number };
      expect(view).toMatchObject({ count: 1, withColleague: 1, flagged: 0 });
      expect(view.baskets[0]).toMatchObject({ activityId: 'SCO-S-1', storeId: 'B1', laneId: 'lane-1', cashierId: 'u-attend', colleagueAuthorityHeld: true, relayedBy: 'u-box', riskFigure: 'not set', colleagueNeeded: 1 });
      expect(String(view.baskets[0]!['summary'])).toContain('age check → old enough (u-attend)');
      // A cashier does not read the office's view; nobody but a store computer relays (hard rule #4).
      expect((await ho.call('GET', '/v1/loss-prevention/self-checkout', 'u-attend', undefined, { branchId: 'B1', day }, 'B1')).status).toBe(403);
      expect((await ho.call('POST', '/v1/self-checkout/baskets/SCO-X/synced', 'u-attend', { ...kept[0]!.payload, activityId: 'SCO-X', storeId: 'B1' }, undefined, 'B1')).status).toBe(403);
      expect(codeOf(await ho.call('POST', '/v1/self-checkout/baskets/SCO-Y/synced', 'u-box', { activityId: 'SCO-Y', storeId: 'B1' }, undefined, 'B1'))).toBe('not_readable_as_a_self_checkout_basket');
      expect(codeOf(await ho.call('GET', '/v1/loss-prevention/self-checkout', 'u-owner', undefined, { branchId: 'B1' }))).toBe('branch_and_day_not_given');

      // R8-7: a camera over lane 1 whose event covers the basket links it — a place to look, never an accusation.
      const { publicKey, privateKey } = generateKeyPairSync('ed25519');
      await ho.ok('POST', '/v1/devices/floor/cam-1', 'u-it', { kind: 'cctv_source', branchId: 'B1', label: 'Self-checkout camera', vendor: 'stand-in', publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(), cameraId: 'CAM-SCO', laneIds: ['lane-1'] });
      await ho.ok('PUT', '/v1/platform/rollout/cctv', 'u-it', { branchId: 'B1', enabled: true, reason: 'camera events trial' });
      const basketAt = kept[0]!.payload['at'] as string;
      const events = [{ eventId: 'c1', type: 'cctv.event', at: new Date().toISOString(), from: new Date(Date.parse(basketAt) - 60_000).toISOString(), to: new Date(Date.parse(basketAt) + 1_000).toISOString(), eventKind: 'lane_activity' }];
      const signature = sign(null, Buffer.from(deviceBatchMessage('cam-1', events)), privateKey).toString('base64');
      expect((await ho.call('POST', '/v1/devices/floor/cam-1/events', 'u-gw', { events, signature }, undefined, 'B1')).status).toBe(200);
      const links = await ho.ok('GET', '/v1/devices/cctv/links', 'u-owner', undefined, { branchId: 'B1', day: basketAt.slice(0, 10) }) as { links: { exceptions: { ref: string; detail: string }[] }[] };
      expect(links.links[0]!.exceptions).toEqual([expect.objectContaining({ ref: 'self-checkout:SCO-S-1', detail: expect.stringContaining('age check') })]);
    } finally {
      link.restore();
    }
  }, 120_000);
});
