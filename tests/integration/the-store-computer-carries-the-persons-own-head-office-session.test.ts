import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { issueTillPins, pinOf, signInAtLane, receiptNumberAt, operatorHeader } from '../support/till-operator';
import { startStandInIdentityServer, standInPerson, type StandInIdentityServer, type StandInPerson } from '../support/stand-in-identity-server';
import { startStandInHeadOffice, type StandInHeadOffice } from '../support/stand-in-head-office';

/**
 * **OB-388 (owner, 26 Oct 2026, in writing) · ADR-0029 — on the store PC a person opens an office page, signs in to head
 * office with their OWN login and second step, and the store computer carries THAT person's own session to head office.**
 *
 * A REAL store computer (`startEdge`: lane socket, disk, screens, the office PIN on), a stand-in identity server (a
 * different site, `localhost`, with a login form, PKCE, RS256 tokens, refresh) and a stand-in head office that believes a
 * token exactly as head office does (the product's `verifyToken`, pinned to the shop) and records whose token each call
 * carried. It proves, through the box's own doors:
 *   • the office PIN alone opens no head-office page and carries no `/v1` call — the page sends the person to sign in;
 *   • after their head-office sign-in (password + one-time code) the page opens as them and each `/v1` call reaches head
 *     office with THEIR token — never the box's machine credential, never a cookie; head office's cookies never come back;
 *   • refusals: no session (401), a write from another site (403), the PIN person not the head-office person (403), a
 *     sign-in with no second step (ended at once), a sign-in for another shop (not confirmed);
 *   • expiry and revocation: a refresh the identity server refuses (a leaver switched off) ends the session; a 401 from
 *     head office (a revoked token) ends it here too, and nothing more is sent;
 *   • sign-out ends it; head office or the identity server down is said plainly (P-08) — and the till still sells.
 */

const KEY = ['ho', 'session', 'box', 'signing', 'key'].join('-').padEnd(48, '0');
const TENANT = 't-sre';
const MACHINE = randomBytes(24).toString('hex');

class Jar {
  readonly cookies = new Map<string, string>();
  readonly raw: string[] = [];
  take(res: Response): void {
    for (const c of res.headers.getSetCookie()) {
      this.raw.push(c);
      const [pair] = c.split(';');
      const eq = pair!.indexOf('=');
      const v = pair!.slice(eq + 1);
      if (v === '') this.cookies.delete(pair!.slice(0, eq)); else this.cookies.set(pair!.slice(0, eq), v);
    }
  }
  header(): string { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '); }
}

describe('OB-388: the store computer carries the person\'s own head-office session for the office pages', () => {
  let idp: StandInIdentityServer;
  let ho: StandInHeadOffice;
  let edge: EdgeProcess;
  let dir = '';
  let base = '';
  const acct = standInPerson({ sreUserId: 'u-acct', tenantId: TENANT });
  const mgr = standInPerson({ sreUserId: 'u-mgr', tenantId: TENANT });
  const said: string[] = [];

  beforeAll(async () => {
    idp = await startStandInIdentityServer();
    for (const p of [acct, mgr]) idp.people.set(p.username, p);
    ho = await startStandInHeadOffice({ issuer: idp.issuer, publicKey: idp.publicKey, tenantId: TENANT, machineToken: MACHINE });
    dir = await mkdtemp(join(tmpdir(), 'sre-ho-session-'));
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, JSON.stringify({
      version: 1, lossPreventionRules: [], policies: { tradingDayCutoff: '02:00', storeId: 'store-1', branchId: 'store-1' },
      products: [{ productId: 'P1', name: 'Toor dal 1kg', categoryId: 'grocery', unitPriceMinor: 16_000, uom: 'ea', barcodes: ['8901234567890'], availableMinor: 100, taxBps: 0, status: 'active' }],
      people: [
        { userId: 'u-acct', displayName: 'Accountant Person', roleId: 'accountant' },
        { userId: 'u-mgr', displayName: 'Manager Person', roleId: 'store_manager' },
        { userId: 'u-lanecash', displayName: 'Lane Cashier', roleId: 'cashier' },
      ],
      roles: [
        { id: 'accountant', name: 'Accountant', permissions: ['identity.self.read', 'finance.period.read'] },
        { id: 'store_manager', name: 'Store manager', permissions: ['identity.self.read', 'finance.period.read', 'till.dayclose.read'] },
        { id: 'cashier', name: 'Cashier', permissions: ['identity.self.read', 'pos.sale.sync'] },
      ],
      roleAssignments: [
        { userId: 'u-acct', roleId: 'accountant', branchScope: 'all' },
        { userId: 'u-mgr', roleId: 'store_manager', branchScope: 'all' },
        { userId: 'u-lanecash', roleId: 'cashier', branchScope: 'all' },
      ],
    }), 'utf8');
    await issueTillPins(dir, KEY, ['u-acct', 'u-mgr', 'u-lanecash']);
    edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_PACK_FILE: packFile,
      EDGE_LANE_PORT: '0', EDGE_LANE_ID: 'lane-1', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_OFFICE_SIGN_IN: 'pin',
      CLOUD_API_URL: ho.base, CLOUD_API_TOKEN: MACHINE, EDGE_HEAD_OFFICE_SIGN_IN_ISSUER: idp.issuer,
    }, (t) => { said.push(t); }))!;
    base = `http://127.0.0.1:${edge.screens!.port}`;
  }, 60_000);
  afterAll(async () => {
    await edge?.stop();
    await ho?.stop();
    await idp?.stop();
    if (dir !== '') await rm(dir, { recursive: true, force: true });
  });

  /** The person's browser on the store PC: one jar for the box, one for the identity server's own site. */
  const browser = () => {
    const box = new Jar();
    const kc = new Jar();
    const get = async (url: string, headers: Record<string, string> = {}): Promise<Response> => {
      const full = url.startsWith('http') ? url : `${base}${url}`;
      const jar = full.startsWith(base) ? box : kc;
      const res = await fetch(full, { redirect: 'manual', headers: { ...headers, ...(jar.cookies.size === 0 ? {} : { cookie: jar.header() }) } });
      jar.take(res);
      return res;
    };
    const post = async (url: string, body: string, headers: Record<string, string> = {}): Promise<Response> => {
      const full = url.startsWith('http') ? url : `${base}${url}`;
      const jar = full.startsWith(base) ? box : kc;
      const res = await fetch(full, { method: 'POST', redirect: 'manual', body, headers: { 'sec-fetch-site': 'same-origin', ...headers, ...(jar.cookies.size === 0 ? {} : { cookie: jar.header() }) } });
      jar.take(res);
      return res;
    };
    const pin = async (who: string): Promise<void> => {
      const res = await post('/office/sign-in', new URLSearchParams({ staffId: who, pin: pinOf(who), next: '/manager/' }).toString(), { 'content-type': 'application/x-www-form-urlencoded' });
      expect(res.status).toBe(303);
    };
    /** The head-office sign-in as a browser does it: the box → the identity server's form → back to the box's callback. */
    const headOffice = async (person: StandInPerson, next: string, otp = person.otp): Promise<Response> => {
      const start = await get(`/login/?next=${encodeURIComponent(next)}`);
      expect(start.status, await start.clone().text()).toBe(303);
      const auth = new URL(start.headers.get('location')!);
      expect(auth.origin).toBe(new URL(idp.issuer).origin);
      expect(auth.searchParams.get('prompt')).toBe('login'); // a shared PC: the password every time
      expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
      const form = await get(auth.toString());
      const action = /id="kc-form-login"[^>]*action="([^"]+)"/.exec(await form.text())![1]!.replace(/&amp;/g, '&');
      const posted = await post(action, new URLSearchParams({ username: person.username, password: person.password, otp: otp ?? '' }).toString(), { 'content-type': 'application/x-www-form-urlencoded' });
      const back = posted.headers.get('location') ?? '';
      expect(back.startsWith(`${base}/login/callback?`), await posted.clone().text()).toBe(true);
      return get(back);
    };
    return { box, get, post, pin, headOffice };
  };
  const personCalls = (path: string) => ho.calls.filter((c) => c.path === path);

  it('the PIN alone opens no head-office page and carries nothing; the person\'s own head-office sign-in does, as them', async () => {
    const b = browser();
    await b.pin('u-acct');
    // The office PIN alone: an office page head office answers sends the person to sign in to head office first.
    const page = await b.get('/finance-close/');
    expect(page.status).toBe(303);
    expect(page.headers.get('location')).toBe('/login/?next=%2Ffinance-close%2F');
    const pinOnly = await b.get('/v1/finance/payment-exceptions', { accept: 'application/json' });
    expect(pinOnly.status).toBe(401);
    expect(((await pinOnly.json()) as { error: { code: string } }).error.code).toBe('head_office_sign_in_needed');
    expect(personCalls('/v1/finance/payment-exceptions')).toEqual([]);

    // The person's own head-office sign-in: password AND the one-time code.
    const landed = await b.headOffice(acct, '/finance-close/');
    expect(landed.status).toBe(200);
    const cookie = b.box.raw.find((c) => c.startsWith('sre_session='))!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(await landed.text()).toContain('url=/finance-close/');

    const opened = await b.get('/finance-close/');
    expect(opened.status, await opened.clone().text()).toBe(200);
    const html = await opened.text();
    expect(html).toContain('"userId":"u-acct"');
    expect(html).toContain('sre-office-bar'); // the Sign out bar
    expect(html).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\./); // no token ever reaches the page

    const read = await b.get('/v1/finance/payment-exceptions', { accept: 'application/json' });
    expect(read.status).toBe(200);
    expect(((await read.json()) as { open: number }).open).toBe(0);
    expect(read.headers.getSetCookie()).toEqual([]); // head office's cookies never come back to the browser
    const call = personCalls('/v1/finance/payment-exceptions').at(-1)!;
    expect(call).toMatchObject({ as: 'u-acct', cookie: false });

    // A write goes as them, with its idempotency key; one from another site is refused here, never sent.
    const echo = await b.post('/v1/echo', '{"x":1}', { 'content-type': 'application/json', 'idempotency-key': 'k-echo-1' });
    expect(await echo.json()).toEqual({ youAre: 'u-acct', idempotencyKey: 'k-echo-1', got: '{"x":1}' });
    const forged = await b.post('/v1/echo', '{"x":2}', { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' });
    expect(forged.status).toBe(403);
    expect(((await forged.json()) as { error: { code: string } }).error.code).toBe('not_from_this_screen');
    expect(ho.calls.filter((c) => c.path === '/v1/echo')).toHaveLength(1);

    // Never the box's machine credential on a page's call; nothing in the box's log names a token or an address.
    expect(ho.calls.filter((c) => c.path.startsWith('/v1/finance') || c.path === '/v1/echo').every((c) => c.as === 'u-acct')).toBe(true);
    const log = said.join('\n');
    expect(log).not.toContain(idp.issuer);
    expect(log).not.toContain(new URL(ho.base).port);
    expect(log).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
    expect(log).toContain('head-office sign-in: signed_in — u-acct');

    // Sign out ends both: the next call is refused here and head office hears nothing.
    const before = ho.calls.length;
    expect((await b.post('/office/sign-out', '')).status).toBe(200);
    expect((await b.get('/v1/finance/payment-exceptions')).status).toBe(401);
    expect(ho.calls.length).toBe(before);
  });

  it('the PIN person must be the head-office person; no second step and another shop are refused', async () => {
    const b = browser();
    await b.pin('u-acct');
    expect((await b.headOffice(mgr, '/finance-close/')).status).toBe(200);
    const mixed = await b.get('/finance-close/');
    expect(mixed.status).toBe(403);
    expect(await mixed.text()).toContain('not the person signed in to the office screens');
    const call = await b.get('/v1/finance/payment-exceptions');
    expect(call.status).toBe(403);
    expect(((await call.json()) as { error: { code: string } }).error.code).toBe('not_the_signed_in_person');

    // No second step: the identity server let the password through, the box ends the sign-in at once.
    const noOtp = standInPerson({ sreUserId: 'u-mgr', tenantId: TENANT, secondStep: false });
    idp.people.set('u-mgr-no-otp', { ...noOtp, username: 'u-mgr-no-otp' });
    const c = browser();
    await c.pin('u-mgr');
    const refused = await c.headOffice({ ...noOtp, username: 'u-mgr-no-otp' }, '/finance-close/');
    expect(refused.status).toBe(401);
    expect(await refused.text()).toContain('second step');
    expect((await c.get('/v1/finance/payment-exceptions')).status).toBe(401);

    // Another shop's sign-in is not confirmed for this one.
    const other: StandInPerson = { ...standInPerson({ sreUserId: 'u-mgr', tenantId: 't-another-shop' }), username: 'u-mgr-other-shop' };
    idp.people.set(other.username, other);
    const d = browser();
    await d.pin('u-mgr');
    const wrongShop = await d.headOffice(other, '/finance-close/');
    expect(wrongShop.status).toBe(401);
    expect(await wrongShop.text()).toContain('did not confirm this sign-in for this shop');
    expect((await d.get('/v1/finance/payment-exceptions')).status).toBe(401);
  });

  it('a revoked token (401 at head office) ends the session here; a refresh refused (a leaver switched off) ends it too', async () => {
    const b = browser();
    await b.pin('u-acct');
    await b.headOffice(acct, '/finance-close/');
    expect((await b.get('/v1/finance/payment-exceptions')).status).toBe(200);
    ho.revoked.add('u-acct');
    expect((await b.get('/v1/finance/payment-exceptions')).status).toBe(401); // head office's own refusal, passed on
    const after = ho.calls.length;
    const again = await b.get('/v1/finance/payment-exceptions');
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe('head_office_sign_in_needed');
    expect(ho.calls.length).toBe(after); // nothing more was carried
    ho.revoked.delete('u-acct');

    // Short-lived tokens are renewed with the refresh token on each use; once the person is switched off, the renewal is
    // refused and the session is over.
    idp.accessSeconds = 30;
    const c = browser();
    await c.pin('u-mgr');
    await c.headOffice(mgr, '/finance-close/');
    expect((await c.get('/v1/finance/payment-exceptions')).status).toBe(200);
    mgr.disabled = true;
    const ended = await c.get('/v1/finance/payment-exceptions');
    expect(ended.status).toBe(401);
    expect(((await ended.json()) as { error: { code: string } }).error.code).toBe('head_office_sign_in_needed');
    expect(said.join('\n')).toContain('session_ended_at_identity_server — u-mgr');
    mgr.disabled = false;
    idp.accessSeconds = 300;
  });

  it('head office down: the call is a lost link; the identity server down: the sign-in says so plainly — and the till still sells', async () => {
    const b = browser();
    await b.pin('u-acct');
    await b.headOffice(acct, '/finance-close/');
    await ho.stop();
    await expect(fetch(`${base}/v1/finance/payment-exceptions`, { headers: { cookie: b.box.header() } })).rejects.toThrow();
    await idp.down();
    const c = browser();
    await c.pin('u-mgr');
    const start = await c.get('/login/?next=%2Ffinance-close%2F');
    expect(start.status).toBe(503);
    const words = await start.text();
    expect(words).toContain('Head office cannot be reached from this computer right now');
    expect(words).toContain('தலைமை அலுவலகத்தை அடைய முடியவில்லை');
    // Hard rule #1: the till's sale commits on the box's own disk whatever head office is doing.
    const lane = edge.lane!.port;
    const token = await signInAtLane(lane, 'u-lanecash');
    const number = await receiptNumberAt(lane, token);
    const today = new Date().toISOString().slice(0, 10);
    const sale = await (await fetch(`http://127.0.0.1:${lane}/lane/sales`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...operatorHeader(token) },
      body: JSON.stringify({
        id: `S-${number}`, number, laneId: 'lane-1', cashierId: 'u-lanecash', tradingDay: today, committedAt: new Date().toISOString(),
        lines: [{ productId: 'P1', quantityMinor: 1, uom: 'ea', unitPriceMinor: 16_000, lineTotalMinor: 16_000, taxRateBps: 0 }],
        tenders: [{ kind: 'cash', amount: { minor: 16_000, currency: 'INR' }, status: 'settled' }], total: 16_000, currency: 'INR',
      }),
    })).json() as { committed?: boolean };
    expect(sale.committed).toBe(true);
    expect(await readLog(edge.log.path)).toHaveLength(1);
    await idp.up();
  });
});

describe('OB-388 on a store computer with no office PIN: the head-office sign-in alone names who is looking', () => {
  it('a person not working at this store is not carried; a person without the page\'s permission is refused the page', async () => {
    const idp = await startStandInIdentityServer();
    const ho = await startStandInHeadOffice({ issuer: idp.issuer, publicKey: idp.publicKey, tenantId: TENANT });
    const dir = await mkdtemp(join(tmpdir(), 'sre-ho-session-nopin-'));
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, JSON.stringify({
      version: 1, lossPreventionRules: [], policies: { tradingDayCutoff: '02:00', storeId: 'store-1', branchId: 'store-1' },
      people: [{ userId: 'u-acct', displayName: 'Accountant Person', roleId: 'accountant' }, { userId: 'u-clerk', displayName: 'Clerk', roleId: 'clerk' }],
      roles: [{ id: 'accountant', name: 'Accountant', permissions: ['identity.self.read', 'finance.period.read'] }, { id: 'clerk', name: 'Clerk', permissions: ['identity.self.read'] }],
      roleAssignments: [{ userId: 'u-acct', roleId: 'accountant', branchScope: 'all' }, { userId: 'u-clerk', roleId: 'clerk', branchScope: 'all' }],
    }), 'utf8');
    const edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_PACK_FILE: packFile,
      EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', CLOUD_API_URL: ho.base, CLOUD_API_TOKEN: MACHINE, EDGE_HEAD_OFFICE_SIGN_IN_ISSUER: idp.issuer,
    }, () => {}))!;
    const base = `http://127.0.0.1:${edge.screens!.port}`;
    try {
      const signIn = async (person: StandInPerson): Promise<string> => {
        const start = await fetch(`${base}/login/?next=%2Ffinance-close%2F`, { redirect: 'manual' });
        const form = await (await fetch(start.headers.get('location')!)).text();
        const action = /action="([^"]+)"/.exec(form)![1]!.replace(/&amp;/g, '&');
        const posted = await fetch(action, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: person.username, password: person.password, otp: person.otp ?? '' }).toString() });
        const back = await fetch(posted.headers.get('location')!, { redirect: 'manual' });
        return `sre_session=${/sre_session=([^;]+)/.exec(back.headers.get('set-cookie') ?? '')![1]!}`;
      };
      for (const id of ['u-acct', 'u-clerk', 'u-stranger']) idp.people.set(id, standInPerson({ sreUserId: id, tenantId: TENANT }));
      // The accountant: the page opens as them, with the Sign out bar; their call is carried as them.
      const acctCookie = await signIn(idp.people.get('u-acct')!);
      const page = await fetch(`${base}/finance-close/`, { headers: { cookie: acctCookie } });
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain('"userId":"u-acct"');
      expect(html).toContain('sre-office-bar');
      expect((await fetch(`${base}/v1/finance/payment-exceptions`, { headers: { cookie: acctCookie } })).status).toBe(200);
      expect(ho.calls.at(-1)).toMatchObject({ path: '/v1/finance/payment-exceptions', as: 'u-acct' });
      // A clerk works here but may not open Month-end: refused the page by the box's own role register.
      const clerkCookie = await signIn(idp.people.get('u-clerk')!);
      expect((await fetch(`${base}/finance-close/`, { headers: { cookie: clerkCookie } })).status).toBe(403);
      // Somebody this store's setup does not name: head office would know them, but this box will not carry them.
      const strangerCookie = await signIn(idp.people.get('u-stranger')!);
      const refused = await fetch(`${base}/v1/finance/payment-exceptions`, { headers: { cookie: strangerCookie } });
      expect(refused.status).toBe(403);
      expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('not_at_this_store');
      expect(ho.calls.filter((c) => c.as === 'u-stranger')).toEqual([]);
      // Sign out (no PIN on this box): the head-office session ends.
      const out = await fetch(`${base}/office/sign-out`, { method: 'POST', redirect: 'manual', headers: { cookie: acctCookie, 'sec-fetch-site': 'same-origin' } });
      expect(out.status).toBe(303);
      expect((await fetch(`${base}/v1/finance/payment-exceptions`, { headers: { cookie: acctCookie } })).status).toBe(401);
    } finally {
      await edge.stop();
      await ho.stop();
      await idp.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
