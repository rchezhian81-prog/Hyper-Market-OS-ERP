import { describe, it, expect, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PEOPLE, startOfficeBox, type OfficeBox } from '../support/office-box';

/**
 * OB-259 (owner, 20 Oct 2026, "Ask PIN for office screens") · W-7 — on a REAL store box (startEdge, its own disk):
 *
 *   • every office screen (manager, migration, owner, …) answers 401 "Enter your PIN" (English and Tamil) with no sign-in,
 *     while the till's own page is served exactly as before;
 *   • a wrong PIN is refused (401) in the till register's words, and the attempt is on the box's refusals log;
 *   • a CASHIER's correct PIN is refused (403): it opens the till only;
 *   • the manager's own PIN opens the screens (303 + an HttpOnly, SameSite=Strict cookie), and the page then runs AS the
 *     manager — their id in the payload, their menu, the Sign out bar;
 *   • a screen the person's role does not include is refused (403) with the screens they may open;
 *   • a sign-in from another site is refused (403); Sign out ends it at once;
 *   • a COLD RESTART over the same disk keeps a live sign-in, never revives a signed-out one, and still checks PINs.
 *
 * The PIN never appears in any log on the disk.
 */

const form = (fields: Record<string, string>): string => new URLSearchParams(fields).toString();
const cookieOf = (res: Response): string | undefined => res.headers.get('set-cookie')?.split(';')[0];

describe('the office screens ask for the person\'s own PIN (OB-259)', () => {
  const boxes: OfficeBox[] = [];
  afterEach(async () => { for (const b of boxes.splice(0).reverse()) await b.stop(); });
  const signIn = (box: OfficeBox, who: { userId: string; pin: string }, next = '/manager/', origin?: string): Promise<Response> =>
    fetch(`${box.base}/office/sign-in`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(origin === undefined ? {} : { origin }) }, body: form({ staffId: who.userId, pin: who.pin, next }) });

  it('asks, refuses a wrong PIN and a cashier, opens for the manager as the manager, and refuses a screen not theirs', async () => {
    const box = await startOfficeBox();
    boxes.push(box);

    // No sign-in: the office screens ask; the till does not.
    for (const path of ['/manager/', '/migration/', '/owner/']) {
      const res = await fetch(`${box.base}${path}`);
      expect(res.status, path).toBe(401);
      const html = await res.text();
      expect(html).toContain('Enter your PIN');
      expect(html).toContain('உங்கள் PIN-ஐ உள்ளிடுங்கள்');
      expect(html).not.toContain('window.managerData');
    }
    const till = await fetch(`${box.base}/pos/`);
    expect(till.status).toBe(200);
    expect(await till.text()).toContain('pos.bundle.js');
    // The bundles carry no data and stay served (the sign-in page needs nothing from them).
    expect((await fetch(`${box.base}/manager/no-such.js`)).status).toBe(404);

    // A wrong PIN: refused, said in both languages, no cookie.
    const wrong = await signIn(box, { userId: PEOPLE.manager.userId, pin: '000000' });
    expect(wrong.status).toBe(401);
    const wrongHtml = await wrong.text();
    expect(wrongHtml).toContain('That staff ID and PIN do not match.');
    expect(wrongHtml).toContain('பொருந்தவில்லை');
    expect(cookieOf(wrong)).toBe('sre_office=');

    // The cashier's own, correct PIN opens the till only.
    const cashier = await signIn(box, PEOPLE.cashier);
    expect(cashier.status).toBe(403);
    expect(await cashier.text()).toContain('This PIN opens the till only.');

    // Another site cannot sign anybody in.
    expect((await signIn(box, PEOPLE.manager, '/manager/', ['http', '://', 'example.invalid'].join(''))).status).toBe(403);
    expect((await fetch(`${box.base}/office/sign-in`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'cross-site', origin: 'null' }, body: form({ staffId: PEOPLE.manager.userId, pin: PEOPLE.manager.pin }) })).status).toBe(403);

    // The manager's own PIN opens the office screens, as the manager.
    const ok = await signIn(box, PEOPLE.manager, '/migration/');
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe('/migration/');
    expect(ok.headers.get('set-cookie')).toMatch(/^sre_office=[A-Za-z0-9_-]{40,}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=1800$/);
    const cookie = cookieOf(ok)!;
    const manager = await fetch(`${box.base}/manager/`, { headers: { cookie } });
    expect(manager.status).toBe(200);
    const page = await manager.text();
    expect(page).toContain('window.sreOfficeSession = {"userId":"u-manager","displayName":"Manager Person"');
    expect(page).toContain('sre-office-bar');
    expect(/window\.sreNavigation = (\{.*?\});<\/script>/.exec(page)?.[1]).toContain('"userId":"u-manager"');

    // The accountant may open the migration screen, but not the manager's day (their role does not include it): 403.
    const acc = cookieOf(await signIn(box, PEOPLE.accountant))!;
    expect((await fetch(`${box.base}/migration/`, { headers: { cookie: acc } })).status).toBe(200);
    const notTheirs = await fetch(`${box.base}/manager/`, { headers: { cookie: acc } });
    expect(notTheirs.status).toBe(403);
    const notTheirsHtml = await notTheirs.text();
    expect(notTheirsHtml).toContain('Accounts Person may not open this screen');
    expect(notTheirsHtml).toContain('/migration/');

    // Sign out ends it at once.
    const out = await fetch(`${box.base}/office/sign-out`, { method: 'POST', headers: { cookie: acc } });
    expect(out.status).toBe(200);
    expect(cookieOf(out)).toBe('sre_office=');
    expect((await fetch(`${box.base}/migration/`, { headers: { cookie: acc } })).status).toBe(401);
    // Only POST signs anybody in or out; every other write is still refused.
    expect((await fetch(`${box.base}/manager/`, { method: 'POST', headers: { cookie } })).status).toBe(405);

    // Nothing on the disk holds a PIN.
    for (const file of ['till-operators.log', 'office-sign-ins.log']) {
      const text = await readFile(join(box.dataDir, file), 'utf8');
      for (const p of Object.values(PEOPLE)) expect(text, file).not.toContain(p.pin);
    }
    expect(await readFile(join(box.dataDir, 'till-operators.log'), 'utf8')).toContain('"laneId":"office-screens"');
  }, 60_000);

  it('a cold restart keeps a live sign-in, never revives a signed-out one, and still checks the PIN', async () => {
    const first = await startOfficeBox();
    const live = cookieOf(await signIn(first, PEOPLE.owner))!;
    const ended = cookieOf(await signIn(first, PEOPLE.manager))!;
    await fetch(`${first.base}/office/sign-out`, { method: 'POST', headers: { cookie: ended } });
    await first.stop();

    const again = await startOfficeBox({ dataDir: first.dataDir });
    boxes.push(again);
    expect((await fetch(`${again.base}/manager/`, { headers: { cookie: live } })).status).toBe(200);
    expect((await fetch(`${again.base}/manager/`, { headers: { cookie: ended } })).status).toBe(401);
    expect((await fetch(`${again.base}/manager/`)).status).toBe(401);
    expect((await signIn(again, { userId: PEOPLE.owner.userId, pin: '111111' })).status).toBe(401);
    expect((await signIn(again, PEOPLE.cashier)).status).toBe(403);
    expect((await signIn(again, PEOPLE.owner)).status).toBe(303);
  }, 60_000);

  it('without the setting the box serves the office screens as before (the hosted copy and older tills)', async () => {
    const box = await startOfficeBox({ gate: false });
    boxes.push(box);
    expect((await fetch(`${box.base}/manager/`)).status).toBe(200);
    expect((await fetch(`${box.base}/office/sign-in`, { method: 'POST', body: 'x' })).status).toBe(405);
  }, 60_000);
});
