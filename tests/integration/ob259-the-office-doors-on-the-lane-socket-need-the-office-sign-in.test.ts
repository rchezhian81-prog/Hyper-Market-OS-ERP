import { describe, it, expect, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PEOPLE, startOfficeBox, type OfficeBox } from '../support/office-box';
import { OPERATOR_HEADER } from '../../edge/store-edge/src/till-operators';
import { OFFICE_ACT_WORDS } from '../../edge/store-edge/src/office-sign-in';
import { OFFICE_LANE_ROUTES } from '../../edge/store-edge/src/lane-server';
import { readLog } from '../../edge/store-edge/src/file-log';

/**
 * OB-259 completeness (owner, 20 Oct 2026, "Ask PIN for office screens") — on a REAL store box (startEdge, its own disk),
 * with the office screens asking for the PIN (`EDGE_OFFICE_SIGN_IN=pin`):
 *
 * Round 2 put the office PAGES behind the person's own PIN, but the jobs those pages do on the till's lane socket — the
 * manager's day close, a reopen, the office screens' decisions handed to the box — answered anybody on this PC. Now each
 * of those doors needs the office sign-in itself:
 *
 *   • no sign-in → 401, "sign in to the office screens first", in English and Tamil; nothing is written;
 *   • a cashier signed in at the TILL → 403 (a till sign-in opens the till only), and the attempt is kept, as theirs;
 *   • an office person without the door's permission (the accountant, at the day close) → 403, kept as theirs;
 *   • the manager, signed in with their own PIN → the day closes, in the manager's name and nobody else's;
 *   • after a COLD RESTART over the same disk: the manager's sign-in still holds and the reopen is done AS the manager
 *     (sealed for them, `via: office_pin`), with the owner approving by their own PIN; no session still gets 401 and the
 *     cashier still gets 403;
 *   • the till's own doors (its sign-in, its sync badge) answer exactly as before, with no office sign-in at all.
 *
 * No PIN and no sign-in token is ever written to a log.
 */

const form = (fields: Record<string, string>): string => new URLSearchParams(fields).toString();
const cookieOf = (res: Response): string | undefined => res.headers.get('set-cookie')?.split(';')[0];

describe('the lane socket\'s office doors need the office sign-in (OB-259)', () => {
  const boxes: OfficeBox[] = [];
  afterEach(async () => { for (const b of boxes.splice(0).reverse()) await b.stop(); });

  const officeSignIn = async (box: OfficeBox, who: { userId: string; pin: string }): Promise<string> => {
    const res = await fetch(`${box.base}/office/sign-in`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ staffId: who.userId, pin: who.pin, next: '/manager/' }) });
    expect(res.status).toBe(303);
    return cookieOf(res)!;
  };
  const tillSignIn = async (box: OfficeBox, who: { userId: string; pin: string }): Promise<string> => {
    const res = await fetch(`${box.lane}/lane/operator/sign-in`, { method: 'POST', headers: { 'content-type': 'application/json', origin: box.base }, body: JSON.stringify({ staffId: who.userId, pin: who.pin }) });
    const body = await res.json() as { signedIn?: boolean; token?: string };
    expect(body.signedIn).toBe(true);
    return body.token!;
  };
  /** A call the way the office screen makes it: from the screens' origin, JSON, the office cookie when there is one. */
  const post = async (box: OfficeBox, path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown>; allowCredentials: string | null }> => {
    const res = await fetch(`${box.lane}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: box.base, ...headers }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() as Record<string, unknown>, allowCredentials: res.headers.get('access-control-allow-credentials') };
  };
  const dayCloses = async (box: OfficeBox): Promise<Record<string, unknown>[]> =>
    (await readLog(box.edge.dayCloseLog.path)).flatMap((r) => (r.ok ? [JSON.parse(r.record) as Record<string, unknown>] : []))
      .filter((r) => typeof r['closedBy'] === 'string' || typeof r['reopenedBy'] === 'string');
  const officeLog = async (box: OfficeBox): Promise<Record<string, unknown>[]> =>
    (await readFile(join(box.dataDir, 'office-sign-ins.log'), 'utf8')).split('\n').flatMap((line) => {
      const at = line.indexOf('{');
      if (at === -1) return [];
      try { return [JSON.parse(line.slice(at)) as Record<string, unknown>]; } catch { return []; }
    });

  it('the office doors are exactly the day close, the reopen and the office screens\' hand-over — none of the till\'s', () => {
    expect(Object.keys(OFFICE_LANE_ROUTES).sort()).toEqual(['/lane/day-close', '/lane/day-reopen', '/lane/outbox']);
    for (const till of ['/lane/sales', '/lane/returns', '/lane/operator/sign-in', '/lane/cash-movements', '/lane/shift-close', '/lane/approvals', '/lane/receipt-numbers', '/lane/held-bills', '/lane/payment-attempts', '/lane/till-activity']) {
      expect(Object.keys(OFFICE_LANE_ROUTES), till).not.toContain(till);
    }
  });

  it('no sign-in 401, a cashier 403, the accountant 403 at the close, the manager closes as the manager; then after a cold restart the manager reopens as the manager', async () => {
    const box = await startOfficeBox();
    const close = { dayCloseId: 'dc-office-1', closedBy: PEOPLE.manager.userId };

    // No office sign-in: 401 at every office door, in both languages, and nothing written.
    for (const [path, body, shape] of [
      ['/lane/day-close', close, 'closed'], ['/lane/day-reopen', { dayCloseId: 'dc-office-1', reopenedBy: PEOPLE.manager.userId, reason: 'r', approvedBy: PEOPLE.owner.userId }, 'reopened'],
      ['/lane/outbox', { source: 'manager', items: [] }, 'acks'],
    ] as const) {
      const r = await post(box, path, body);
      expect(r.status, path).toBe(401);
      expect(r.body, path).toMatchObject({ refusedBecause: 'office_sign_in_needed', reason: OFFICE_ACT_WORDS.office_sign_in_needed.en, reasonTa: OFFICE_ACT_WORDS.office_sign_in_needed.ta });
      expect(r.body[shape], path).toEqual(shape === 'acks' ? [] : false);
      // The office screen sends its cookie, so the door says it may (loopback origins only).
      expect(r.allowCredentials, path).toBe('true');
    }
    expect(await dayCloses(box)).toEqual([]);

    // A cashier signed in at the till — and even with the manager's own PIN typed into the close — is refused: 403.
    const cashierTill = await tillSignIn(box, PEOPLE.cashier);
    const cashier = await post(box, '/lane/day-close', { ...close, closerPin: PEOPLE.manager.pin }, { [OPERATOR_HEADER]: cashierTill });
    expect(cashier.status).toBe(403);
    expect(cashier.body).toMatchObject({ closed: false, refusedBecause: 'not_an_office_sign_in', reason: OFFICE_ACT_WORDS.not_an_office_sign_in.en, reasonTa: OFFICE_ACT_WORDS.not_an_office_sign_in.ta });
    expect((await post(box, '/lane/outbox', { source: 'manager', items: [] }, { [OPERATOR_HEADER]: cashierTill })).status).toBe(403);
    expect(await dayCloses(box)).toEqual([]);

    // The accountant is an office person, but closing the day is not in their role: 403. The hand-over is any office job.
    const acc = await officeSignIn(box, PEOPLE.accountant);
    const accClose = await post(box, '/lane/day-close', { ...close, closedBy: PEOPLE.accountant.userId }, { cookie: acc });
    expect(accClose.status).toBe(403);
    expect(accClose.body).toMatchObject({ closed: false, refusedBecause: 'lacks_permission', reasonTa: OFFICE_ACT_WORDS.lacks_permission.ta });
    expect((await post(box, '/lane/outbox', { source: 'manager', items: [] }, { cookie: acc })).status).toBe(200);

    // The manager, signed in with their own PIN: never in somebody else's name (403), then in their own — closed.
    const mgr = await officeSignIn(box, PEOPLE.manager);
    const asOwner = await post(box, '/lane/day-close', { ...close, closedBy: PEOPLE.owner.userId }, { cookie: mgr });
    expect(asOwner.status).toBe(403);
    expect(asOwner.body).toMatchObject({ closed: false, refusedBecause: 'not_the_signed_in_person' });
    const closed = await post(box, '/lane/day-close', close, { cookie: mgr });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body).toMatchObject({ closed: true, locked: true });
    expect(await dayCloses(box)).toEqual([expect.objectContaining({ dayCloseId: 'dc-office-1', closedBy: PEOPLE.manager.userId, locked: true })]);
    await box.stop();

    // A COLD RESTART over the same disk.
    const again = await startOfficeBox({ dataDir: box.dataDir });
    boxes.push(again);
    const reopen = { dayCloseId: 'dc-office-1', reopenedBy: PEOPLE.manager.userId, reason: 'a sale was keyed on the wrong day', approvedBy: PEOPLE.owner.userId, approverPin: PEOPLE.owner.pin };
    expect((await post(again, '/lane/day-reopen', reopen)).status).toBe(401);
    expect((await post(again, '/lane/day-reopen', reopen, { [OPERATOR_HEADER]: await tillSignIn(again, PEOPLE.cashier) })).body).toMatchObject({ reopened: false, refusedBecause: 'not_an_office_sign_in' });
    expect((await post(again, '/lane/day-reopen', { ...reopen, reopenedBy: PEOPLE.owner.userId }, { cookie: mgr })).status).toBe(403);
    const reopened = await post(again, '/lane/day-reopen', reopen, { cookie: mgr });
    expect(reopened.status, JSON.stringify(reopened.body)).toBe(200);
    expect(reopened.body).toMatchObject({ reopened: true });
    const record = (await dayCloses(again)).find((r) => r['reopenedBy'] === PEOPLE.manager.userId)!;
    expect(record).toMatchObject({ reopenedBy: PEOPLE.manager.userId, approvedBy: PEOPLE.owner.userId });
    // Done AS the manager: the box sealed the reopen for the person signed in to the office screens.
    expect(record['deciderVerified']).toMatchObject({ userId: PEOPLE.manager.userId, via: 'office_pin' });
    expect(record['approverVerified']).toMatchObject({ userId: PEOPLE.owner.userId, via: 'pin' });

    // Every refusal is kept — who, which door, why — and nothing on the disk holds a PIN or a token.
    const refused = (await officeLog(again)).filter((r) => r['kind'] === 'office_act_refused').map((r) => [r['route'], r['userId'], r['reason']]);
    expect(refused).toEqual(expect.arrayContaining([
      ['/lane/day-close', '(nobody)', 'office_sign_in_needed'],
      ['/lane/day-close', PEOPLE.cashier.userId, 'not_an_office_sign_in'],
      ['/lane/day-close', PEOPLE.accountant.userId, 'lacks_permission'],
      ['/lane/day-close', PEOPLE.manager.userId, 'not_the_signed_in_person'],
      ['/lane/day-reopen', PEOPLE.cashier.userId, 'not_an_office_sign_in'],
      ['/lane/day-reopen', PEOPLE.manager.userId, 'not_the_signed_in_person'],
    ]));
    const token = mgr.split('=')[1]!;
    for (const file of ['office-sign-ins.log', 'till-operators.log']) {
      const text = await readFile(join(again.dataDir, file), 'utf8');
      for (const p of Object.values(PEOPLE)) expect(text, file).not.toContain(p.pin);
      expect(text, file).not.toContain(token);
    }
  }, 90_000);

  it('the till\'s own doors answer exactly as before with no office sign-in at all', async () => {
    const box = await startOfficeBox();
    boxes.push(box);
    const token = await tillSignIn(box, PEOPLE.cashier);
    const who = await fetch(`${box.lane}/lane/operator`, { headers: { [OPERATOR_HEADER]: token, origin: box.base } });
    expect(who.status).toBe(200);
    expect(await who.json()).toMatchObject({ signedIn: true, userId: PEOPLE.cashier.userId });
    expect(who.headers.get('access-control-allow-credentials')).toBeNull(); // a till door: nothing about cookies
    expect((await fetch(`${box.lane}/lane/sync-status`, { headers: { origin: box.base } })).status).toBe(200);
    const preflight = await fetch(`${box.lane}/lane/sales`, { method: 'OPTIONS', headers: { origin: box.base, 'access-control-request-method': 'POST' } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-credentials')).toBeNull();
    // The office door's preflight says the office screen may send its sign-in cookie.
    const officePreflight = await fetch(`${box.lane}/lane/day-close`, { method: 'OPTIONS', headers: { origin: box.base, 'access-control-request-method': 'POST' } });
    expect(officePreflight.status).toBe(204);
    expect(officePreflight.headers.get('access-control-allow-credentials')).toBe('true');
  }, 60_000);

  it('without the setting the office doors behave as before (the hosted copy and older tills)', async () => {
    const box = await startOfficeBox({ gate: false });
    boxes.push(box);
    // No office gate: the close goes to the box's own checks, which still want the closer's own PIN or session.
    const r = await post(box, '/lane/day-close', { dayCloseId: 'dc-x', closedBy: PEOPLE.manager.userId });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ closed: false });
    expect(r.body['refusedBecause']).toBeUndefined();
  }, 60_000);
});
