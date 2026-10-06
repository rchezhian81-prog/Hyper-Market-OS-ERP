import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { prepareTillBox, signInAtLane, operatorHeader, pinOf, testPin } from '../support/till-operator';

/**
 * **The person on a sale is the person the store computer verified — offline (ADR-0020 · Wave 2b · audit PF-02 ·
 * M02-FR-01 · M12-FR-01 · closes GAP-POS-LOGIN-01).**
 *
 * The audit's finding: the till wrote whatever staff code was typed as the cashier, and the box committed it. These
 * drive a REAL box, its real lane socket and its real disk, with nothing stubbed and no cloud at all: a typed name is
 * refused before the disk; the cashier who signed in with their own PIN is the only person a sale, refund or cash
 * movement may name; the box stamps who it verified; sign-out ends the session and a restart keeps it; the hosted copy's
 * verified sign-in is honoured only where its overlay switches it on. The screens' own forwarded-user setting — which
 * the box's settings loader silently dropped until this slice — is proved to reach the box too.
 */

const KEY = ['till', 'signs', 'operator', 'in', 'key'].join('-').padEnd(48, '0');
const dirs: string[] = [];
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const PEOPLE = [{ userId: 'u-meena', displayName: 'Meena' }, { userId: 'u-ravi', displayName: 'Ravi' }, { userId: 'u-floor', displayName: 'Floor', till: false }];

const startBox = async (opts: { readonly dir?: string; readonly extra?: Record<string, string>; readonly laneId?: string | null; readonly pack?: boolean } = {}): Promise<EdgeProcess> => {
  const dir = opts.dir ?? await mkdtemp(join(tmpdir(), 'sre-till-signin-'));
  if (opts.dir === undefined) dirs.push(dir);
  const ready = opts.pack === false
    ? { EDGE_LANE_ID: 'lane-1' }
    : await prepareTillBox({ dir, key: KEY, people: PEOPLE, ...(opts.laneId === undefined ? {} : { laneId: opts.laneId }) });
  const edge = (await startEdge({
    EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
    ...ready, ...(opts.extra ?? {}),
  }, () => {}))!;
  stops.push(() => edge.stop());
  return edge;
};

const post = async (edge: EdgeProcess, path: string, body: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(`http://127.0.0.1:${edge.lane!.port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
};
const sale = (id: string, cashierId: string) => ({ id, number: `R-${id}`, total: 48_000, cashierId, lines: [], tenders: [] });
const saleRecords = async (edge: EdgeProcess) => (await readLog(edge.log.path)).flatMap((r) => (r.ok ? [JSON.parse(r.record) as Record<string, unknown>] : []));

describe('a sale names the person the box verified — never a typed name', () => {
  it('with nobody signed in, a sale naming anyone is refused BEFORE the disk, in the cashier\'s words', async () => {
    const edge = await startBox();
    const out = await post(edge, '/lane/sales', sale('S-typed', 'u-meena'));
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ committed: false, refusedBecause: 'operator_not_signed_in', laneMessage: expect.stringMatching(/Sign in with your staff ID and till PIN/) });
    expect(await saleRecords(edge)).toHaveLength(0);
    expect(edge.outbox.unsentCount()).toBe(0);
  });

  it('signed in as Meena, a sale naming Ravi is refused; a sale naming Meena is saved and STAMPED with who the box verified', async () => {
    const edge = await startBox();
    const meena = operatorHeader(await signInAtLane(edge.lane!.port, 'u-meena'));
    const wrong = await post(edge, '/lane/sales', sale('S-ravi', 'u-ravi'), meena);
    expect(wrong.body).toMatchObject({ committed: false, refusedBecause: 'operator_not_the_one_named', laneMessage: expect.stringMatching(/Meena is signed in at this till/) });
    const right = await post(edge, '/lane/sales', sale('S-meena', 'u-meena'), meena);
    expect(right.body).toMatchObject({ committed: true });
    const records = await saleRecords(edge);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ id: 'S-meena', cashierId: 'u-meena', operatorVerified: { userId: 'u-meena', via: 'pin' } });
  });

  it('the same sale re-sent after a lost reply is "already recorded" — the stamp carries no clock, so the replay is not a conflict', async () => {
    const edge = await startBox();
    const meena = operatorHeader(await signInAtLane(edge.lane!.port, 'u-meena'));
    expect((await post(edge, '/lane/sales', sale('S-twice', 'u-meena'), meena)).body).toMatchObject({ committed: true });
    const again = await post(edge, '/lane/sales', sale('S-twice', 'u-meena'), meena);
    expect(again.body).toMatchObject({ committed: true, laneMessage: 'This sale was already recorded.' });
    expect(await saleRecords(edge)).toHaveLength(1);
  });

  it('a refund names the person processing it, and a cash movement the person holding the till — both checked the same way', async () => {
    const edge = await startBox();
    const ravi = operatorHeader(await signInAtLane(edge.lane!.port, 'u-ravi'));
    const refund = { id: 'RT-1', returnId: 'RT-1', originalSaleId: 'S-1', number: 'RT-1', processedBy: 'u-meena', reasonCode: 'damaged', refundMinor: 1_000, currency: 'INR', refundTender: 'cash', processedAt: '2026-10-06T10:00:00.000Z', lines: [] };
    expect((await post(edge, '/lane/returns', refund, ravi)).body).toMatchObject({ committed: false, refusedBecause: 'operator_not_the_one_named' });
    expect(await readLog(edge.returnsLog.path)).toHaveLength(0);
    const float = { movementId: 'cm-1', movementKind: 'float_issue', amountMinor: 200_000, at: '2026-10-06T09:00:00.000Z', custodianId: 'u-meena' };
    expect((await post(edge, '/lane/cash-movements', float)).body).toMatchObject({ committed: false, refusedBecause: 'operator_not_signed_in' });
    expect((await post(edge, '/lane/cash-movements', float, ravi)).body).toMatchObject({ committed: false, refusedBecause: 'operator_not_the_one_named' });
    expect((await post(edge, '/lane/cash-movements', { ...float, custodianId: 'u-ravi' }, ravi)).body).toMatchObject({ committed: true });
    expect((await post(edge, '/lane/shift-close', { shiftId: 'sh-1', closedAt: '2026-10-06T20:00:00.000Z', cashierId: 'u-ravi', countedMinor: 200_000 })).body)
      .toMatchObject({ closed: false, refusedBecause: 'operator_not_signed_in' });
    expect((await post(edge, '/lane/shift-close', { shiftId: 'sh-1', closedAt: '2026-10-06T20:00:00.000Z', cashierId: 'u-ravi', countedMinor: 200_000 }, ravi)).body)
      .toMatchObject({ closed: true });
  });
});

describe('signing in through the box\'s socket', () => {
  it('a wrong PIN and an unknown staff ID get one answer; a person without till authority is told so; nothing about the PIN is echoed', async () => {
    const edge = await startBox();
    const wrongPin = await post(edge, '/lane/operator/sign-in', { staffId: 'u-meena', pin: testPin(999) === pinOf('u-meena') ? testPin(998) : testPin(999) });
    const unknown = await post(edge, '/lane/operator/sign-in', { staffId: 'u-ghost', pin: pinOf('u-meena') });
    expect(wrongPin.body).toEqual(unknown.body);
    expect(wrongPin.body).toMatchObject({ signedIn: false, refusedBecause: 'wrong_staff_id_or_pin' });
    expect(JSON.stringify(wrongPin.body)).not.toContain(pinOf('u-meena'));
    expect((await post(edge, '/lane/operator/sign-in', { staffId: 'u-floor', pin: pinOf('u-floor') })).body).toMatchObject({ signedIn: false, refusedBecause: 'no_till_authority' });
  });

  it('GET /lane/operator says how this box signs people in and who holds the session — loopback only', async () => {
    const edge = await startBox();
    const token = await signInAtLane(edge.lane!.port, 'u-meena');
    const status = async (headers: Record<string, string>) => {
      const res = await fetch(`http://127.0.0.1:${edge.lane!.port}/lane/operator`, { headers });
      return { status: res.status, body: await res.json() as Record<string, unknown> };
    };
    expect((await status({})).body).toMatchObject({ signInBy: 'pin', signedIn: false });
    expect((await status(operatorHeader(token))).body).toMatchObject({ signInBy: 'pin', signedIn: true, userId: 'u-meena', displayName: 'Meena', via: 'pin' });
    expect(JSON.stringify((await status(operatorHeader(token))).body)).not.toContain(token);
    expect((await status({ origin: 'https://untrusted.invalid' })).status).toBe(403);
  });

  it('sign-out ends the session at once; a restart of the box does not', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-till-signin-restart-'));
    dirs.push(dir);
    const first = await startBox({ dir });
    const keep = operatorHeader(await signInAtLane(first.lane!.port, 'u-meena'));
    const leave = operatorHeader(await signInAtLane(first.lane!.port, 'u-ravi'));
    expect((await post(first, '/lane/operator/sign-out', {}, leave)).body).toEqual({ signedOut: true });
    expect((await post(first, '/lane/sales', sale('S-after-out', 'u-ravi'), leave)).body).toMatchObject({ committed: false, refusedBecause: 'operator_not_signed_in' });
    await first.stop();
    stops.splice(0);
    const second = await startBox({ dir });
    expect((await post(second, '/lane/sales', sale('S-after-restart', 'u-meena'), keep)).body).toMatchObject({ committed: true });
    const log = await readFile(join(dir, 'till-operators.log'), 'utf8');
    expect(log).not.toContain(pinOf('u-meena'));
    expect(log).not.toContain(keep['x-sre-operator']!);
  });

  it('a box with no people in its pack signs nobody in; a box never told its lane takes no money at all', async () => {
    const noPeople = await startBox({ pack: false });
    expect((await post(noPeople, '/lane/operator/sign-in', { staffId: 'u-meena', pin: pinOf('u-meena') })).body).toMatchObject({ signedIn: false, refusedBecause: 'no_people_register' });
    const laneless = await startBox({ laneId: null });
    expect((await post(laneless, '/lane/operator/sign-in', { staffId: 'u-meena', pin: pinOf('u-meena') })).body).toMatchObject({ signedIn: false, refusedBecause: 'no_lane' });
    expect((await post(laneless, '/lane/sales', sale('S-nolane', 'u-meena'))).body).toMatchObject({ committed: false, refusedBecause: 'no_lane' });
    expect(await saleRecords(laneless)).toHaveLength(0);
  });
});

describe('the hosted copy\'s verified sign-in — only where its overlay switches it on (ADR-0020 §6)', () => {
  it('with EDGE_LANE_TRUST_FORWARDED_USER=1, the person the front names signs in without a PIN — still only with till authority', async () => {
    const edge = await startBox({ extra: { EDGE_LANE_TRUST_FORWARDED_USER: '1' } });
    const status = await (await fetch(`http://127.0.0.1:${edge.lane!.port}/lane/operator`)).json() as Record<string, unknown>;
    expect(status['signInBy']).toBe('verified_sign_in');
    const signed = await post(edge, '/lane/operator/sign-in', {}, { 'x-sre-user': 'u-meena' });
    expect(signed.body).toMatchObject({ signedIn: true, userId: 'u-meena', via: 'verified_sign_in' });
    const sold = await post(edge, '/lane/sales', sale('S-hosted', 'u-meena'), operatorHeader(String(signed.body['token'])));
    expect(sold.body).toMatchObject({ committed: true });
    expect((await saleRecords(edge))[0]).toMatchObject({ operatorVerified: { userId: 'u-meena', via: 'verified_sign_in' } });
    expect((await post(edge, '/lane/operator/sign-in', {}, { 'x-sre-user': 'u-floor' })).body).toMatchObject({ signedIn: false, refusedBecause: 'no_till_authority' });
  });

  it('without it — every store box — the header is ignored and a PIN is required', async () => {
    const edge = await startBox();
    expect((await post(edge, '/lane/operator/sign-in', {}, { 'x-sre-user': 'u-meena' })).body).toMatchObject({ signedIn: false, refusedBecause: 'not_readable' });
  });

  it('EDGE_SCREEN_TRUST_FORWARDED_USER=1 reaches the box: an ERP screen runs as the person the front names (the setting was dropped by the settings loader before this slice)', async () => {
    const screenBox = async (trust: boolean) => startBox({ extra: { EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', ...(trust ? { EDGE_SCREEN_TRUST_FORWARDED_USER: '1' } : {}) } });
    const trusted = await screenBox(true);
    const html = await (await fetch(`http://127.0.0.1:${trusted.screens!.port}/counts/`, { headers: { 'x-sre-user': 'u-meena' } })).text();
    expect(html).toContain('"userId":"u-meena"');
    const store = await screenBox(false);
    const plain = await (await fetch(`http://127.0.0.1:${store.screens!.port}/counts/`, { headers: { 'x-sre-user': 'u-meena' } })).text();
    expect(plain).not.toContain('"userId":"u-meena"');
  });
});
