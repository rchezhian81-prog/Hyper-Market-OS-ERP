import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiHarness, TEST_IDP, TEST_PACK_KEY, type ApiHarness } from '../support/api-harness';
import type { HttpRequest } from '../../services/kernel/src/index';
import { startEdge } from '../../edge/store-edge/src/main';
import { bootPos, laneDurable, laneCashMovement, laneShiftClose, laneTillCash } from '../../apps/pos/src/browser-entry';
import { prepareTillBox, holdSignedInAt } from '../support/till-operator';
import { loyaltyMemberKey, memberRefFor } from '../../packages/loyalty/src/index';

/**
 * **The till names a loyalty member by mobile number; the number is never written anywhere (PF-09 step 2 · OB-28 "1" ·
 * M17-FR-01 · M16-FR-01 · P-04 · §31).**
 *
 * The cashier keys the customer's mobile number on the till. It goes to the store computer with the sale, which swaps it
 * for the member code BEFORE the disk — so the box's logs hold the code and never the number. With the cable out the
 * sale is on the box only; when the line returns, head office banks it and the member earns by the owner's rule. A
 * number that is not one keeps no member and the sale still goes ahead.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaa9b2';
const MOBILE = '98400 12345';
const MEMBER = memberRefFor(loyaltyMemberKey(TEST_PACK_KEY), MOBILE)!;

/** Every byte the store computer wrote, as text — to prove the number is in none of it. */
async function everythingOnDisk(dir: string): Promise<string> {
  const out: string[] = [];
  for (const name of await readdir(dir)) {
    const path = join(dir, name);
    if ((await stat(path)).isDirectory()) out.push(await everythingOnDisk(path));
    else out.push(await readFile(path, 'utf8'));
  }
  return out.join('\n');
}

describe('the till names a loyalty member by mobile number, and the number never reaches a disk', () => {
  const KEY = TEST_PACK_KEY;
  let h: ApiHarness;
  let dir: string;
  let online = false;
  const savedFetch = globalThis.fetch;

  beforeAll(async () => {
    h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-meena', 'cashier');
    await h.provisionRole(A, 'u-box', 'cashier');
    await h.provisionRole(A, 'u-mgr', 'store_manager');
    // The owner switches loyalty on (1 point per ₹100); the customer joins at the desk.
    expect((await h.request({ method: 'PUT', path: '/v1/platform/setup/loyalty.points_per_100_inr', userId: 'u-owner', tenantId: A, idempotencyKey: 'rule', body: { value: 1 } })).status).toBeLessThan(300);
    expect((await h.request({ method: 'POST', path: '/v1/loyalty/members', userId: 'u-mgr', tenantId: A, idempotencyKey: 'join', body: { mobile: MOBILE, consent: true, verifiedHow: 'seen_on_phone' } })).status).toBe(201);

    globalThis.fetch = (async (url: string, init: RequestInit): Promise<Response> => {
      if (String(url).startsWith('http://127.0.0.1:')) return savedFetch(url, init);
      if (!online) throw new Error('ENETUNREACH');
      const hdr = (init.headers ?? {}) as Record<string, string>;
      const res = await h.raw({
        method: (init.method ?? 'GET') as HttpRequest['method'],
        path: new URL(url).pathname,
        token: hdr['authorization']?.replace(/^Bearer /, ''),
        idempotencyKey: hdr['idempotency-key'],
        body: init.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown,
      });
      return new Response(JSON.stringify(res.body), { status: res.status });
    }) as unknown as typeof globalThis.fetch;
    dir = await mkdtemp(join(tmpdir(), 'sre-till-loyalty-'));
    await prepareTillBox({
      dir, key: KEY, people: [{ userId: 'u-meena', displayName: 'Meena' }],
      pack: {
        policies: { storeId: 'store-1', branchId: 'store-1', branchName: 'Main', tradingDayCutoff: '02:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, cashVarianceToleranceMinor: 10_000, privacySlaDays: 30, warehouseId: 'wh-1' },
        lossPreventionRules: [],
      },
    });
  });
  afterAll(async () => {
    globalThis.fetch = savedFetch;
    await rm(dir, { recursive: true, force: true });
  });

  const env = () => ({
    EDGE_DATA_DIR: dir, EDGE_TENANT_ID: A, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_LANE_ID: 'lane-1',
    EDGE_PACK_FILE: join(dir, 'store-pack.json'),
    CLOUD_API_URL: 'https://cloud.example.test',
    CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-box', tenantId: A }),
  });

  it('a member named on a sale offline earns when the line returns; the box never wrote the number', async () => {
    const edge = (await startEdge(env(), () => {}))!;
    const port = edge.lane!.port;
    const till = bootPos({ laneId: 'lane-1', taxPercent: 0, lanePort: port, durable: laneDurable(port), cashMovement: laneCashMovement(port), shiftClose: laneShiftClose(port), tillCash: laneTillCash(port) });
    await holdSignedInAt(port, 'u-meena');
    till.signIn('u-meena');

    // A number that is not a mobile is refused at the till — nothing is set.
    expect(till.setLoyaltyMobile('12345')).toMatchObject({ ok: false });
    expect(till.loyaltyMemberLast4()).toBeNull();
    // The member's number, keyed as people say it; the screen shows only the last four digits.
    expect(till.setLoyaltyMobile('+91 98400-12345')).toEqual({ ok: true, last4: '2345' });
    expect(till.loyaltyMemberLast4()).toBe('2345');

    // ₹1,250 sale, cable out.
    till.scan({ productId: 'P1', description: 'Basmati rice 5kg', unitPriceMinor: 125_000, qty: 1 });
    await till.tenderCash('S-loyal-1', await till.nextReceipt(), new Date().toISOString());
    // The screen starts the next bill (as app.js does after payment): it names nobody.
    till.newSale();
    expect(till.loyaltyMemberLast4()).toBeNull();

    // On the box's disk: the member code — and not one byte of the phone number.
    const disk = await everythingOnDisk(dir);
    expect(disk).toContain(MEMBER);
    expect(disk).not.toContain('9840012345');
    expect(disk).not.toContain('98400');

    // The line returns: head office banks the sale and the member earns 12 points.
    online = true;
    expect((await edge.syncOnce!()).dead).toBe(0);
    const points = (await h.request({ method: 'GET', path: `/v1/customers/${MEMBER}/points`, userId: 'u-owner', tenantId: A })).body as { pointsBalance?: number };
    expect(points.pointsBalance).toBe(12);
    await edge.stop();
  }, 30_000);

  it('a box sent a code by the till itself drops it — only the store computer makes a member code', async () => {
    online = true;
    const edge = (await startEdge(env(), () => {}))!;
    const port = edge.lane!.port;
    await holdSignedInAt(port, 'u-meena');
    const forged = await savedFetch(`http://127.0.0.1:${port}/lane/sales`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify({ id: 'S-forged', cashierId: 'u-meena', customerRef: memberRefFor(loyaltyMemberKey(TEST_PACK_KEY), '9000000001'), lines: [], total: 0, tenders: [] }),
    });
    const answer = await forged.json() as Record<string, unknown>;
    expect(answer['loyalty']).toBeUndefined();
    expect(await everythingOnDisk(dir)).not.toContain(memberRefFor(loyaltyMemberKey(TEST_PACK_KEY), '9000000001'));
    await edge.stop();
  }, 30_000);
});
