import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiHarness, TEST_IDP, type ApiHarness } from '../support/api-harness';
import type { HttpRequest } from '../../services/kernel/src/index';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { makeEvent } from '../../packages/contracts/src/event';
import { enrolmentCodeHash } from '../../packages/platform-admin/src/device-enrolment';
import type { DeviceAck } from '../../packages/sync/src/device-relay';
import { withTillPeople, issueTillPins, signInOnPhone, pinOf, type TillPerson } from '../support/till-operator';

/**
 * **Each person signs in on the warehouse, picker or driver phone with the SAME personal PIN as the till, and the work they
 * do on it is recorded as theirs (Wave 4 · PA-06 = DF-3-c · OB-30 "A" · ADR-0019 · ADR-0020 · §28 · hard rules #1/#4/#10).**
 *
 * The REAL box (`startEdge` with its device socket, its till-PIN register and fsync'd sign-in log, its device-events log and
 * sync agent) against the REAL cloud (the API harness behind a `fetch` the test can cut):
 *
 *   • TWO PEOPLE, ONE PHONE: Kavya signs in and scans a delivery in; Ravi signs in on the same phone — Kavya is signed out
 *     by it (her old session opens nothing and sends nothing); Ravi scans; Kavya's scan that was still queued on the phone
 *     is taken under Ravi's sign-in as HERS; head office records each scan against the person who did it;
 *   • nobody signed in → the phone is sent to the sign-in page and the box takes nothing (and refuses nothing — it waits);
 *   • a record naming a person who never held this phone is refused by name and never reaches head office;
 *   • the sign-in survives a box restart, and works with head office unreachable (the PIN is checked on the box);
 *   • a LEAVER: once the store setup no longer gives them the job, their live session sends nothing more and they cannot
 *     sign in again; a withdrawn PIN signs nobody in.
 *
 * Every PIN is made at run time from a seed — none is written in the repo. Synthetic data only (hard rule #7).
 */

const KEY = ['phone', 'sign', 'in', 'edge', 'signing', 'key'].join('-').padEnd(48, '0');
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AT = '2026-10-10T10:00:00.000Z';
const CODE = 'ABCDE-FGHJK-LMNPQ-RSTUV';
const KAVYA: TillPerson = { userId: 'u-kavya', displayName: 'Kavya', permissions: ['inventory.movement.append'] };
const RAVI: TillPerson = { userId: 'u-ravi', displayName: 'Ravi', permissions: ['inventory.movement.append'] };

const packJson = (people: readonly TillPerson[] = [KAVYA, RAVI]): string => JSON.stringify(withTillPeople({
  version: 1,
  policies: { tradingDayCutoff: '02:00', storeId: 'store-1', branchId: 'store-1', branchName: 'Main', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, privacySlaDays: 30, warehouseId: 'wh-1' },
  lossPreventionRules: [],
  warehouse: {
    assignmentId: 'A-1', workerId: 'u-named-in-the-setup', storeId: 'store-1',
    bins: [{ binId: 'BIN-A', storeId: 'store-1', capacityMinor: 1000, pickable: true, zone: 'ambient' }],
  },
  devices: [{ deviceId: 'hh-01', kind: 'handheld', status: 'registered', label: 'Back door', enrolment: { codeHash: enrolmentCodeHash(CODE), expiresAt: '2099-01-01T00:00:00.000Z' } }],
}, people));

/** A receiving scan as the warehouse phone queues it — naming the person the phone was signed in as. */
const scanned = (id: string, receivedBy: string) => makeEvent({
  id: `recv-grn-1-${id}`, type: 'ReceivingScanned', occurredAt: AT, idempotencyKey: `recv:grn-1:${id}`, source: 'A-1',
  payload: { grnId: 'grn-1', commandId: id, productId: 'p-rice', batchId: null, quantityMinor: 1, uom: 'EA', source: 'po', poId: null, state: 'on_hand', expiry: null, receivedBy, storeId: 'store-1', at: AT },
});
const item = (e: ReturnType<typeof scanned>) => ({ key: e.idempotencyKey, event: e });

const cleanups: Array<() => Promise<void>> = [];
const savedFetch = globalThis.fetch;
afterEach(async () => {
  globalThis.fetch = savedFetch;
  for (const c of cleanups.splice(0).reverse()) await c();
});

const base = (edge: EdgeProcess): string => `http://127.0.0.1:${edge.devices!.port}`;
const enrolPhone = async (edge: EdgeProcess): Promise<string> => {
  const res = await savedFetch(`${base(edge)}/device/enrol`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: 'hh-01', code: CODE }) });
  expect(res.status).toBe(200);
  return res.headers.get('set-cookie')!.split(';')[0]!;
};
const post = async (edge: EdgeProcess, cookie: string, items: unknown[]): Promise<{ status: number; acks: DeviceAck[] }> => {
  const res = await savedFetch(`${base(edge)}/lane/outbox`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ source: 'warehouse', items }) });
  return { status: res.status, acks: ((await res.json()) as { acks?: DeviceAck[] }).acks ?? [] };
};
const shell = (edge: EdgeProcess, cookie: string) => savedFetch(`${base(edge)}/warehouse/`, { headers: { accept: 'text/html', cookie }, redirect: 'manual' });
const signInRaw = (edge: EdgeProcess, deviceCookie: string, staffId: string, pin: string) => savedFetch(`${base(edge)}/device/sign-in?screen=warehouse`, {
  method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', cookie: deviceCookie }, body: JSON.stringify({ staffId, pin }),
});

async function shop(): Promise<{ h: ApiHarness; dir: string; start: (people?: readonly TillPerson[], extra?: Record<string, string>) => Promise<EdgeProcess>; setOnline: (v: boolean) => void }> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-kavya', 'store_manager');
  await h.provisionRole(A, 'u-ravi', 'store_manager');
  await h.provisionRole(A, 'u-box', 'cashier');
  const dir = await mkdtemp(join(tmpdir(), 'sre-phone-sign-in-'));
  cleanups.push(async () => { await rm(dir, { recursive: true, force: true }); });
  await issueTillPins(dir, KEY, ['u-kavya', 'u-ravi']);
  let online = true;
  globalThis.fetch = (async (url: string, init: RequestInit): Promise<Response> => {
    if (url.startsWith('http://127.0.0.1:')) return savedFetch(url, init);
    if (!online) throw new Error('ENETUNREACH');
    const hdr = (init.headers ?? {}) as Record<string, string>;
    const res = await h.raw({
      method: (init.method ?? 'GET') as HttpRequest['method'], path: new URL(url).pathname,
      token: hdr['authorization']?.replace(/^Bearer /, ''), idempotencyKey: hdr['idempotency-key'],
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown,
    });
    return new Response(JSON.stringify(res.body), { status: res.status });
  }) as unknown as typeof globalThis.fetch;
  const start = async (people?: readonly TillPerson[], extra: Record<string, string> = {}): Promise<EdgeProcess> => {
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, packJson(people), 'utf8');
    const edge = (await startEdge({
      EDGE_TENANT_ID: A, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_DEVICE_PORT: '0', EDGE_APPS_DIR: 'apps',
      EDGE_DATA_DIR: dir, EDGE_PACK_FILE: packFile,
      CLOUD_API_URL: 'https://cloud.example.test', CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-box', tenantId: A }), ...extra,
    }, () => {}))!;
    cleanups.push(async () => { await edge.stop(); });
    return edge;
  };
  return { h, dir, start, setOnline: (v) => { online = v; } };
}

const scansAt = async (h: ApiHarness): Promise<{ commandId: string; receivedBy: string }[]> =>
  ((await h.request({ method: 'GET', path: '/v1/inventory/receiving-scans', userId: 'u-owner', tenantId: A, query: { grnId: 'grn-1' } })).body as { scans: { commandId: string; receivedBy: string }[] })
    .scans.map((s) => ({ commandId: s.commandId, receivedBy: s.receivedBy })).sort((x, y) => x.commandId.localeCompare(y.commandId));

describe('staff sign in on the phones with their till PIN; the work is recorded as theirs (DF-3-c · OB-30 "A")', () => {
  it('two people, one phone: the second sign-in ends the first; each scan reaches head office as the person who did it — including the first person\'s scan still queued on the phone', async () => {
    const s = await shop();
    const edge = await s.start();
    const phone = await enrolPhone(edge);

    // Nobody signed in: the phone gets the sign-in page, and the box takes nothing — a wait, not a refusal.
    expect((await shell(edge, phone)).headers.get('location')).toBe('/device/sign-in?screen=warehouse');
    expect((await post(edge, phone, [item(scanned('k1', 'u-kavya'))])).status).toBe(401);

    // Kavya signs in: the screen is HERS — the person the setup named for the job is replaced by the one holding the phone.
    const kavya = await signInOnPhone(base(edge), phone, 'u-kavya');
    const kavyaScreen = await (await shell(edge, kavya)).text();
    expect(kavyaScreen).toContain('"workerId":"u-kavya"');
    expect(kavyaScreen).not.toContain('u-named-in-the-setup');
    expect(kavyaScreen).toContain('Signed in: <strong>Kavya</strong>');
    expect((await post(edge, kavya, [item(scanned('k1', 'u-kavya'))])).acks).toEqual([{ key: 'recv:grn-1:k1', status: 'accepted' }]);

    // Ravi takes the phone and signs in: Kavya is signed out by it — her cookie opens nothing and sends nothing.
    const ravi = await signInOnPhone(base(edge), phone, 'u-ravi');
    expect((await shell(edge, kavya)).status).toBe(302);
    expect((await post(edge, kavya, [item(scanned('k2', 'u-kavya'))])).status).toBe(401);
    expect(await (await shell(edge, ravi)).text()).toContain('"workerId":"u-ravi"');

    // Ravi's scan, Kavya's scan that was still queued on the phone (it is still hers), and a scan naming somebody who never
    // held this phone — refused by name, never sent.
    const acks = (await post(edge, ravi, [item(scanned('r1', 'u-ravi')), item(scanned('k2', 'u-kavya')), item(scanned('x1', 'u-stranger'))])).acks;
    expect(acks).toEqual([
      { key: 'recv:grn-1:r1', status: 'accepted' },
      { key: 'recv:grn-1:k2', status: 'accepted' },
      { key: 'recv:grn-1:x1', status: 'refused', reason: 'the record names u-stranger, who has not been signed in on this phone this shift' },
    ]);

    const pass = await edge.syncOnce!();
    expect(pass.sent).toBe(3);
    expect(pass.dead).toBe(0);
    expect(await scansAt(s.h)).toEqual([
      { commandId: 'k1', receivedBy: 'u-kavya' },
      { commandId: 'k2', receivedBy: 'u-kavya' },
      { commandId: 'r1', receivedBy: 'u-ravi' },
    ]);

    // The box's own sign-in log says who held the phone and that Ravi's sign-in ended Kavya's — never a PIN or a token.
    const log = await readFile(join(s.dir, 'till-operators.log'), 'utf8');
    expect(log).toContain('"kind":"signed_out"');
    expect(log).toContain('"why":"replaced"');
    expect(log).toContain('"laneId":"device:hh-01"');
    expect(log).not.toContain(pinOf('u-kavya'));
    expect(log).not.toContain(decodeURIComponent(kavya.split('sre_operator=')[1]!));
  });

  it('the sign-in survives a box restart and works with head office unreachable — the PIN is checked on the box', async () => {
    const s = await shop();
    s.setOnline(false);
    const first = await s.start();
    const phone = await enrolPhone(first);
    const kavya = await signInOnPhone(base(first), phone, 'u-kavya');
    expect((await post(first, kavya, [item(scanned('k1', 'u-kavya'))])).acks.map((a) => a.status)).toEqual(['accepted']);
    expect((await first.syncOnce!()).sent).toBe(0); // the cloud is down: the scan waits on the box

    await first.stop();
    cleanups.pop();
    const second = await s.start();
    // Same phone, same cookie, after the restart: still Kavya, still working.
    expect(await (await shell(second, kavya)).text()).toContain('"workerId":"u-kavya"');
    expect((await post(second, kavya, [item(scanned('k2', 'u-kavya'))])).acks.map((a) => a.status)).toEqual(['accepted']);
    s.setOnline(true);
    expect((await second.syncOnce!()).sent).toBe(2);
    expect((await scansAt(s.h)).map((x) => x.receivedBy)).toEqual(['u-kavya', 'u-kavya']);
  });

  it('a leaver: once the store setup no longer gives them the job their live session sends nothing and they cannot sign in again; a wrong or withdrawn PIN signs nobody in', async () => {
    const s = await shop();
    const first = await s.start();
    const phone = await enrolPhone(first);
    const ravi = await signInOnPhone(base(first), phone, 'u-ravi');
    expect((await post(first, ravi, [item(scanned('r1', 'u-ravi'))])).acks.map((a) => a.status)).toEqual(['accepted']);
    // What Ravi did while he held the job reaches head office as his.
    expect((await first.syncOnce!()).sent).toBe(1);
    expect(await scansAt(s.h)).toEqual([{ commandId: 'r1', receivedBy: 'u-ravi' }]);

    // Ravi leaves: the next store setup names him with no warehouse job.
    await first.stop();
    cleanups.pop();
    const second = await s.start([KAVYA, { userId: 'u-ravi', displayName: 'Ravi', permissions: ['pos.exception.read'] }]);
    const sent = await post(second, ravi, [item(scanned('r2', 'u-ravi'))]);
    expect(sent.status).toBe(401);
    expect((await shell(second, ravi)).status).toBe(302);
    const again = await signInRaw(second, phone, 'u-ravi', pinOf('u-ravi'));
    expect(again.status).toBe(401);
    expect(await again.json()).toMatchObject({ signedIn: false, refusedBecause: 'no_handheld_authority' });

    // A wrong PIN — one answer for a wrong ID and a wrong PIN.
    const wrong = await signInRaw(second, phone, 'u-kavya', pinOf('u-ravi'));
    expect(await wrong.json()).toMatchObject({ signedIn: false, refusedBecause: 'wrong_staff_id_or_pin' });

    // Kavya's PIN is withdrawn on the box (a new entry, never an edit): she cannot sign in either.
    const file = join(s.dir, 'till-credentials.json');
    const creds = JSON.parse(await readFile(file, 'utf8')) as { version: number; credentials: unknown[] };
    creds.credentials.push({ userId: 'u-kavya', revoked: true, issuedAt: '2026-10-10T09:00:00.000Z', issuedBy: 'test-admin' });
    await writeFile(file, JSON.stringify(creds), 'utf8');
    const withdrawn = await signInRaw(second, phone, 'u-kavya', pinOf('u-kavya'));
    expect(await withdrawn.json()).toMatchObject({ signedIn: false, refusedBecause: 'wrong_staff_id_or_pin' });

    // Nothing more of his reached head office.
    expect(await scansAt(s.h)).toEqual([{ commandId: 'r1', receivedBy: 'u-ravi' }]);
  });

  it('the hosted copy: a phone screen served behind the front\'s sign-in is the SIGNED-IN person\'s too, never whoever the setup named', async () => {
    const s = await shop();
    const edge = await s.start(undefined, { EDGE_SCREEN_PORT: '0', EDGE_SCREEN_TRUST_FORWARDED_USER: '1' });
    const html = await (await savedFetch(`http://127.0.0.1:${edge.screens!.port}/warehouse/`, { headers: { 'x-sre-user': 'u-ravi' } })).text();
    expect(html).toContain('"workerId":"u-ravi"');
    expect(html).not.toContain('u-named-in-the-setup');
  });
});
