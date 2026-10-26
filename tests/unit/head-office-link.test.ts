import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHeadOfficeLink, headOfficeLinkSettingsFrom, headOfficeCallRefusal, headOfficeSignInPage, HEAD_OFFICE_CALL_WORDS, HEAD_OFFICE_SIGN_IN_WORDS, type HeadOfficeLink } from '../../edge/store-edge/src/head-office-link';
import { startStandInIdentityServer, standInPerson, type StandInIdentityServer } from '../support/stand-in-identity-server';

/**
 * **OB-388 · ADR-0029 — the store computer's head-office link, on its own.**
 *
 * Its settings (off unless both the identity server and head office's API are named; https unless this PC's loopback), the
 * words it says (English and Tamil, every refusal), its log (the event and the person — never a token, a code or an
 * address), the ten-hour ceiling on a session, sign-out, and what it carries to head office (the person's token and the
 * page's own headers — never a cookie, never who-is-this headers, never head office's cookies back).
 */

const TENANT = 't-sre';
const stops: (() => Promise<void>)[] = [];
afterEach(async () => { for (const s of stops.splice(0).reverse()) await s(); });

describe('the link\'s settings', () => {
  it('is off unless the identity server is named; names what is missing; refuses plain http except this PC\'s loopback', () => {
    expect(headOfficeLinkSettingsFrom({})).toEqual({ on: false, why: null });
    expect(headOfficeLinkSettingsFrom({ EDGE_HEAD_OFFICE_SIGN_IN_ISSUER: 'https://id.example.test/realms/sre-store', EDGE_TENANT_ID: TENANT }))
      .toMatchObject({ on: false, why: expect.stringContaining('CLOUD_API_URL') });
    expect(headOfficeLinkSettingsFrom({ EDGE_HEAD_OFFICE_SIGN_IN_ISSUER: 'http://id.example.test/realms/sre-store', CLOUD_API_URL: 'https://ho.example.test', EDGE_TENANT_ID: TENANT }))
      .toMatchObject({ on: false, why: expect.stringContaining('must be an https address') });
    expect(headOfficeLinkSettingsFrom({ EDGE_HEAD_OFFICE_SIGN_IN_ISSUER: 'https://id.example.test/realms/sre-store', CLOUD_API_URL: 'http://ho.example.test', EDGE_TENANT_ID: TENANT }))
      .toMatchObject({ on: false, why: expect.stringContaining('CLOUD_API_URL must be an https address') });
    expect(headOfficeLinkSettingsFrom({ EDGE_HEAD_OFFICE_SIGN_IN_ISSUER: 'https://id.example.test/realms/sre-store', CLOUD_API_URL: 'https://ho.example.test' }))
      .toMatchObject({ on: false, why: expect.stringContaining('EDGE_TENANT_ID') });
    expect(headOfficeLinkSettingsFrom({ EDGE_HEAD_OFFICE_SIGN_IN_ISSUER: 'https://id.example.test/realms/sre-store', CLOUD_API_URL: 'https://ho.example.test', EDGE_TENANT_ID: TENANT }))
      .toEqual({ on: true, settings: { issuer: 'https://id.example.test/realms/sre-store', apiBase: 'https://ho.example.test', tenantId: TENANT, clientId: 'sre-web', audience: 'sre-retail-os-api' } });
    expect(headOfficeLinkSettingsFrom({ EDGE_HEAD_OFFICE_SIGN_IN_ISSUER: 'http://localhost:9/realms/x', CLOUD_API_URL: 'http://127.0.0.1:9', EDGE_TENANT_ID: TENANT })).toMatchObject({ on: true });
  });

  it('every refusal and every sign-in problem is said in English and Tamil, in head office\'s own error shape', () => {
    for (const w of [...Object.values(HEAD_OFFICE_CALL_WORDS), ...Object.values(HEAD_OFFICE_SIGN_IN_WORDS)]) {
      expect(w.en.length).toBeGreaterThan(20);
      expect(w.ta).toMatch(/[஀-௿]/);
    }
    expect(JSON.parse(headOfficeCallRefusal('head_office_sign_in_needed'))).toMatchObject({ error: { code: 'head_office_sign_in_needed', wasItSaved: 'not_saved' } });
    const page = headOfficeSignInPage({ problem: 'unreachable', next: '/finance-close/' });
    expect(page).toContain(HEAD_OFFICE_SIGN_IN_WORDS.unreachable.en);
    expect(page).toContain('href="/manager/"');
    expect(headOfficeSignInPage({ problem: 'not_confirmed', next: '/x"><script>' })).not.toContain('<script>');
  });
});

/** The link behind a tiny server, as the screen socket uses it; the clock is the test's. */
async function rig(idp: StandInIdentityServer, clock: { now: number }): Promise<{ link: HeadOfficeLink; base: string; audit: Record<string, unknown>[]; headOffice: { seen: Record<string, string | string[] | undefined>[] } }> {
  const audit: Record<string, unknown>[] = [];
  const seen: Record<string, string | string[] | undefined>[] = [];
  const ho: Server = createServer((req, res) => { seen.push(req.headers); res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'ho=1', 'x-internal': 'secret-ish' }).end('{"ok":true}'); });
  await new Promise<void>((r) => { ho.listen(0, '127.0.0.1', () => r()); });
  stops.push(() => new Promise((r) => { ho.close(() => r()); ho.closeAllConnections(); }));
  const held: { link?: HeadOfficeLink } = {};
  const box: Server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? '/').split('?')[0]!;
      const link = held.link!;
      if (link.isSignInPath(path)) { await link.signInDoor(req, res); return; }
      const s = await link.sessionOf(req);
      if (s === null) { res.writeHead(401).end('none'); return; }
      if (path === '/end') { await link.end(req); res.writeHead(204).end(); return; }
      await link.carry(req, res, s, null);
    })();
  });
  await new Promise<void>((r) => { box.listen(0, '127.0.0.1', () => r()); });
  stops.push(() => new Promise((r) => { box.close(() => r()); box.closeAllConnections(); }));
  const base = `http://127.0.0.1:${(box.address() as AddressInfo).port}`;
  held.link = createHeadOfficeLink({
    settings: { issuer: idp.issuer, apiBase: `http://127.0.0.1:${(ho.address() as AddressInfo).port}`, clientId: 'sre-web', audience: 'sre-retail-os-api', tenantId: TENANT, origin: base },
    fetch: globalThis.fetch, now: () => clock.now, audit: (l) => { audit.push(l); },
  });
  return { link: held.link, base, audit, headOffice: { seen } };
}

async function signIn(base: string, idp: StandInIdentityServer, person: ReturnType<typeof standInPerson>): Promise<string> {
  const start = await fetch(`${base}/login/?next=%2Ffinance-close%2F`, { redirect: 'manual' });
  const form = await (await fetch(start.headers.get('location')!)).text();
  const action = /action="([^"]+)"/.exec(form)![1]!.replace(/&amp;/g, '&');
  const posted = await fetch(action, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: person.username, password: person.password, otp: person.otp ?? '' }).toString() });
  const back = await fetch(posted.headers.get('location')!, { redirect: 'manual' });
  expect(back.status).toBe(200);
  return /sre_session=([^;]+)/.exec(back.headers.get('set-cookie') ?? '')![1]!;
}

describe('the link, against a stand-in identity server', () => {
  it('carries the person\'s token and the page\'s own headers only; never a cookie; head office\'s cookies and inner headers never come back', async () => {
    const idp = await startStandInIdentityServer();
    stops.push(() => idp.stop());
    const p = standInPerson({ sreUserId: 'u-acct', tenantId: TENANT });
    idp.people.set(p.username, p);
    const { base, audit, headOffice } = await rig(idp, { now: Date.now() });
    const id = await signIn(base, idp, p);
    const res = await fetch(`${base}/v1/anything?x=1`, { headers: { cookie: `sre_session=${id}; sre_office=abc`, accept: 'application/json', 'x-sre-user': 'u-owner', 'x-forwarded-for': '1.2.3.4', 'idempotency-key': 'k1' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('x-internal')).toBeNull();
    const h = headOffice.seen.at(-1)!;
    expect(h['authorization']).toMatch(/^Bearer eyJ/);
    expect(h['cookie']).toBeUndefined();
    expect(h['x-sre-user']).toBeUndefined();
    expect(h['x-forwarded-for']).toBeUndefined();
    expect(h['idempotency-key']).toBe('k1');
    // The log names the event and the person; never a token, a code, a session id or an address.
    const text = JSON.stringify(audit);
    expect(audit).toContainEqual({ event: 'signed_in', userId: 'u-acct' });
    expect(text).not.toContain(id);
    expect(text).not.toContain('localhost');
    expect(text).not.toMatch(/eyJ/);
  });

  it('a session lasts ten hours at most, whatever the identity server says; ending it ends it at once', async () => {
    const idp = await startStandInIdentityServer();
    stops.push(() => idp.stop());
    const p = standInPerson({ sreUserId: 'u-acct', tenantId: TENANT });
    idp.people.set(p.username, p);
    const clock = { now: Date.now() };
    const { base } = await rig(idp, clock);
    const id = await signIn(base, idp, p);
    expect((await fetch(`${base}/v1/x`, { headers: { cookie: `sre_session=${id}` } })).status).toBe(200);
    clock.now += 10 * 60 * 60 * 1000 + 1;
    expect((await fetch(`${base}/v1/x`, { headers: { cookie: `sre_session=${id}` } })).status).toBe(401);
    clock.now = Date.now();
    const id2 = await signIn(base, idp, p);
    expect((await fetch(`${base}/end`, { headers: { cookie: `sre_session=${id2}` } })).status).toBe(204);
    expect((await fetch(`${base}/v1/x`, { headers: { cookie: `sre_session=${id2}` } })).status).toBe(401);
  });

  it('a callback with a used or unknown state is said as "start again", never a session', async () => {
    const idp = await startStandInIdentityServer();
    stops.push(() => idp.stop());
    const { base } = await rig(idp, { now: Date.now() });
    const res = await fetch(`${base}/login/callback?code=x&state=never-started`, { redirect: 'manual' });
    expect(res.status).toBe(400);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await res.text()).toContain(HEAD_OFFICE_SIGN_IN_WORDS.expired.en);
  });
});
