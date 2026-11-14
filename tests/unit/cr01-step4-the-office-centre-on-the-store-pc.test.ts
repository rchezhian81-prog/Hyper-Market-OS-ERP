import { describe, it, expect } from 'vitest';
import { buildPersonToken } from '../../scripts/lib/operator-env';
import { isLoopbackUrl, personFetch, personToken, thisPcApiSettingsFrom, type ThisPcApiSettings } from '../../edge/store-edge/src/this-pc-api';
import {
  CENTRE_WORDS, OFFICE_CENTRE_REDIRECTS, createOfficeCentre, excelSafeCell, excelSafeCsv, parseCsv, type OfficeCentreDeps, type PinVerdict,
} from '../../edge/store-edge/src/office-centre';
import { importExportPage, peoplePage } from '../../edge/store-edge/src/office-centre-pages';
// @ts-expect-error — plain .mjs script module, imported for its pure helpers (no types file needed).
import { THIS_PC_KEYS, planTillSettings, renderTillEnv, tillEnvChangesFor } from '../../scripts/install-till.mjs';
import { grantsFor, servicePaths, SERVICES } from '../../scripts/lib/store-computer-services.mjs';
import { main as storeComputer, parseEnvText as parseEnv } from '../../scripts/lib/store-computer.mjs';
import { world as world2 } from '../support/store-computer-world';
import { settingsIn, storePc } from '../support/store-pc-windows';

/**
 * **CR-01 step 4 — the Office centre on the store PC: Users & roles (OI-06) and Import & export (OI-07), Tamil (OI-09).**
 *
 *   On the store PC the shop's own API runs beside the till (ADR-0032). The Office app's Users & roles and Import & export
 *   work there with the staff ID + own till PIN sign-in (OB-259), never the head-office internet sign-in: every act asks
 *   the person's PIN AGAIN, and only then is a five-minute token made for THAT person (the same bytes the import page and
 *   the owner setup commands make, OB-257) and carried to this PC's loopback API — which judges it with its own rules:
 *   two people for a privilege change (§28), OB-95, step-up, audit. Every act and refusal is first written to this PC's
 *   own append-only log; a log that cannot be written stops the act.
 */

const SECRET = 'k'.repeat(48);
const API: ThisPcApiSettings = { apiBase: 'http://127.0.0.1:8081', tenantId: 'shop-1', policy: { secret: SECRET, issuer: 'sre-store-pc', audience: 'sre-api' } };
const NOW = Date.parse('2026-11-14T06:00:00.000Z');
const claimsOf = (auth: string | null): Record<string, unknown> => JSON.parse(Buffer.from(String(auth).replace(/^Bearer /, '').split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;

describe('the token: made for one person after their PIN, the same bytes as the import page makes', () => {
  it('personToken equals buildPersonToken byte for byte', () => {
    const c = { sub: 'owner-01', tenantId: 'shop-1', ttlSeconds: 300, authTimeSec: 1_700_000_000, jti: 'j-1' };
    expect(personToken(c, API.policy, NOW)).toBe(buildPersonToken(c, { secret: SECRET, issuer: 'sre-store-pc', audience: 'sre-api' }, NOW));
  });

  it('the link is on only with this-pc, the office PIN, every key, and an address on THIS PC', () => {
    const full = { EDGE_OFFICE_HEAD_OFFICE: 'this-pc', EDGE_OFFICE_SIGN_IN: 'pin', CLOUD_API_URL: 'http://127.0.0.1:8081/', EDGE_TENANT_ID: 'shop-1', IDP_SIGNING_KEY: SECRET, IDP_ISSUER: 'i', IDP_AUDIENCE: 'a' };
    expect(thisPcApiSettingsFrom(full)).toMatchObject({ on: true, settings: { apiBase: 'http://127.0.0.1:8081', tenantId: 'shop-1' } });
    expect(thisPcApiSettingsFrom({ ...full, EDGE_OFFICE_HEAD_OFFICE: '' })).toEqual({ on: false, why: null });
    expect(thisPcApiSettingsFrom({ ...full, EDGE_OFFICE_SIGN_IN: '' })).toMatchObject({ on: false, why: expect.stringContaining('office PIN') });
    expect(thisPcApiSettingsFrom({ ...full, CLOUD_API_URL: 'https://head-office.example/api' })).toMatchObject({ on: false, why: expect.stringContaining('not an address on this PC') });
    expect(thisPcApiSettingsFrom({ ...full, IDP_SIGNING_KEY: '' })).toMatchObject({ on: false, why: expect.stringContaining('IDP_SIGNING_KEY') });
    expect(JSON.stringify(thisPcApiSettingsFrom({ ...full, IDP_SIGNING_KEY: 'zq7zq7' }))).not.toContain('zq7zq7'); // never says a key
    for (const ok of ['http://127.0.0.1:1', 'http://localhost:2', 'http://[::1]:3']) expect(isLoopbackUrl(ok)).toBe(true);
    for (const no of ['http://192.168.1.5:8081', 'https://example.com', 'file:///x', 'nonsense']) expect(isLoopbackUrl(no)).toBe(false);
  });

  it('carries only /v1 calls, to this PC, as the person, with WHEN their PIN was checked', async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const f = personFetch(API, { userId: 'owner-01', pinCheckedAt: '2026-11-14T05:59:50.000Z' }, {
      now: () => NOW,
      fetch: (async (url: string, init?: RequestInit) => { seen.push({ url, auth: new Headers(init?.headers).get('authorization') }); return new Response('{}'); }) as typeof fetch,
    });
    await f('/v1/identity/grants?x=1');
    expect(seen[0]!.url).toBe('http://127.0.0.1:8081/v1/identity/grants?x=1');
    expect(claimsOf(seen[0]!.auth)).toMatchObject({ sub: 'owner-01', tenant_id: 'shop-1', auth_time: Date.parse('2026-11-14T05:59:50.000Z') / 1000, amr: ['pin', 'swk'], exp: NOW / 1000 + 300 });
    for (const bad of ['/manager/', 'https://evil.example/v1/identity/grants', '/v2/x']) expect((await f(bad)).status).toBe(400);
    expect(seen).toHaveLength(1);
  });
});

describe('Excel-safe exports (M30-FR-02)', () => {
  it('a byte-order mark, Windows line ends, formulas neutralised, numbers and Tamil kept', () => {
    const out = excelSafeCsv('name,qty,note\n"அரிசி, 5 kg",-12.5,"=HYPERLINK(""x"")"\n+cmd,@sum,"a ""b""\nc"\n-x,\t1,ok\n');
    expect(out.startsWith('\uFEFF')).toBe(true);
    expect(out.slice(1).split('\r\n')[0]).toBe('name,qty,note');
    const rows = parseCsv(out.slice(1));
    expect(rows[1]).toEqual(['அரிசி, 5 kg', '-12.5', '\'=HYPERLINK("x")']);
    expect(rows[2]).toEqual(['\'+cmd', '\'@sum', 'a "b"\nc']);
    expect(rows[3]).toEqual(['\'-x', '\'\t1', 'ok']);
    expect(excelSafeCell('500')).toBe('500');
    expect(excelSafeCell('-3')).toBe('-3');
  });
});

// ── a pretend store PC: its API, its PIN register, its log ────────────────────────────────────────────────────────

interface Call { method: string; path: string; sub: unknown; authTime: unknown; body: unknown }
function world(over: { perms?: Record<string, string[]>; pins?: Record<string, string>; holders?: string[]; failLog?: boolean; api?: (c: Call) => { status: number; body: unknown } | undefined } = {}) {
  const calls: Call[] = []; const log: Record<string, unknown>[] = []; const setPins: { userId: string; pin: string; by: string }[] = []; let refreshed = 0;
  let clock = NOW;
  const pins: Record<string, string> = over.pins ?? { 'owner-01': '111111', 'manager-01': '222222', 'cashier-01': '333333' };
  const perms = over.perms ?? {
    'owner-01': ['identity.role.read', 'identity.role.request', 'identity.role.grant', 'export.read', 'migration.cleaning.read'],
    'manager-01': ['identity.role.request', 'export.read'],
    'cashier-01': ['pos.sale.read'],
  };
  const grants = [
    { userId: 'owner-01', roleId: 'owner', branchScope: 'all' },
    { userId: 'manager-01', roleId: 'store_manager', branchScope: ['S1'] },
    { userId: 'cashier-01', roleId: 'cashier', branchScope: ['S1'] },
    { userId: 'far-01', roleId: 'cashier', branchScope: ['S2'] },
  ];
  const fetch = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const c = claimsOf(new Headers(init?.headers).get('authorization'));
    const call: Call = { method: init?.method ?? 'GET', path: `${u.pathname}${u.search}`, sub: c['sub'], authTime: c['auth_time'], body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) };
    calls.push(call);
    const custom = over.api?.(call);
    const r = custom ?? (
      call.path === '/v1/identity/roles' ? { status: 200, body: { roles: [{ id: 'cashier', name: 'Cashier', nameTa: 'காசாளர்', permissions: ['pos.sale.read'] }, { id: 'owner', name: 'Owner', permissions: [] }], awaitingOwnerApproval: [] } }
        : call.path === '/v1/identity/grants' && call.method === 'GET' ? { status: 200, body: { grants } }
          : call.path === '/v1/identity/grants/pending' ? { status: 200, body: { requests: [{ grantId: 'g-9', userId: 'cashier-02', roleId: 'cashier', branchScope: ['S1'], requestedBy: 'manager-01', requestedAt: 'x', reason: 'new' }, { grantId: 'g-8', userId: 'x-02', roleId: 'cashier', branchScope: ['S2'], requestedBy: 'manager-01', requestedAt: 'x', reason: 'elsewhere' }] } }
            : call.path === '/v1/approvals/requests' && call.method === 'GET' ? { status: 200, body: { waitingForMe: [{ requestId: 'a-1', kind: 'access_change', summary: 'Take back', requestedBy: 'manager-01', reason: 'moved' }, { requestId: 'a-2', kind: 'price_change', summary: 'not ours' }], mine: [] } }
              : call.path === '/v1/export' ? { status: 200, body: { domains: [{ domain: 'products', columns: [] }] } }
                : call.path === '/v1/exports' ? { status: 200, body: { exports: [] } }
                  : call.path === '/v1/export/products' ? { status: 200, body: { domain: 'products', csv: 'productId,name\np1,=1+1\n', schema: {}, audit: { rowCount: 1 } } }
                    : call.path === '/v1/approvals/requests' && call.method === 'POST' ? { status: 201, body: { requestId: 'a-9', status: 'waiting' } }
                    : call.method === 'POST' ? { status: 202, body: { grantId: 'g-new', state: 'pending' } } : { status: 404, body: {} });
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  const deps: OfficeCentreDeps = {
    api: API, fetch, now: () => clock, storeId: 'S1',
    verifyPin: async (u, p): Promise<PinVerdict> => (pins[u] === p ? 'ok' : 'wrong'),
    pinHolders: async () => new Set(over.holders ?? ['owner-01', 'manager-01', 'cashier-01']),
    setPin: async (userId, pin, by) => { setPins.push({ userId, pin, by }); return { ok: true, lines: ['set'] }; },
    permissionsOf: (u) => perms[u] ?? [],
    refreshPack: async () => { refreshed += 1; },
    append: async (e) => { if (over.failLog) throw new Error('disk full'); log.push(e); },
    newId: (p) => `${p}-1`,
  };
  return { centre: createOfficeCentre(deps), calls, log, setPins, refreshed: () => refreshed, tick: (ms: number) => { clock += ms; } };
}
const OWNER = { userId: 'owner-01', signedInAt: '2026-11-14T05:40:00.000Z' };
const MANAGER = { userId: 'manager-01', signedInAt: '2026-11-14T05:40:00.000Z' };

describe('OI-06 Users & roles: every act asks the person\'s own PIN again, then the shop\'s system decides', () => {
  it('no PIN, or a wrong one: refused in both languages, written down, and nothing reaches the API', async () => {
    const w = world();
    const a = await w.centre.peopleAct(MANAGER, { act: 'give', userId: 'cashier-02', name: 'Priya S', roleId: 'cashier', reason: 'new hire' });
    expect(a).toMatchObject({ status: 401, json: { ok: false, en: CENTRE_WORDS.needPin.en, ta: CENTRE_WORDS.needPin.ta } });
    const b = await w.centre.peopleAct(MANAGER, { act: 'give', pin: '999999', userId: 'cashier-02', name: 'Priya S', roleId: 'cashier', reason: 'new hire' });
    expect(b.json['en']).toBe(CENTRE_WORDS.wrongPin.en);
    expect(w.calls).toHaveLength(0);
    expect(w.log.map((e) => e['outcome'])).toEqual(['refused:needPin', 'refused:wrongPin']);
    expect(JSON.stringify(w.log)).not.toContain('999999');
  });

  it('five wrong PINs lock the person for fifteen minutes — even the right PIN then', async () => {
    const w = world();
    for (let i = 0; i < 5; i += 1) await w.centre.peopleAct(MANAGER, { act: 'give', pin: '000000' });
    expect((await w.centre.peopleAct(MANAGER, { act: 'give', pin: '222222', userId: 'cashier-02', name: 'Priya S', roleId: 'cashier', reason: 'x' })).status).toBe(423);
    w.tick(16 * 60_000);
    expect((await w.centre.peopleAct(MANAGER, { act: 'give', pin: '222222', userId: 'cashier-02', name: 'Priya S', roleId: 'cashier', reason: 'x' })).status).toBe(200);
  });

  it('adding a person: their first role is ASKED (this store only), as the asker, with a PIN typed now; written down before and after', async () => {
    const w = world();
    const a = await w.centre.peopleAct(MANAGER, { act: 'give', pin: '222222', userId: 'cashier-02', name: 'Priya S', roleId: 'cashier', reason: 'new hire' });
    expect(a).toMatchObject({ status: 200, json: { ok: true, en: CENTRE_WORDS.asked.en } });
    const post = w.calls.find((c) => c.method === 'POST')!;
    expect(post).toMatchObject({ path: '/v1/identity/grants', sub: 'manager-01', authTime: NOW / 1000, body: { userId: 'cashier-02', roleId: 'cashier', branchScope: ['S1'], reason: 'new hire — Priya S' } });
    expect((post.body as Record<string, unknown>)['requestedBy']).toBeUndefined(); // who asks comes from the sign-in, never the body
    expect(w.log.map((e) => e['outcome'])).toEqual(['asked', 'requested']);
    expect(JSON.stringify(w.log)).not.toContain('222222');
  });

  it.each([
    ['their own access', { userId: 'manager-01' }, 'yourself'],
    ['a staff ID that is not one', { userId: 'Cashier 2' }, 'needStaffId'],
    ['no name', { name: '' }, 'needName'],
    ['no role', { roleId: '' }, 'needRole'],
    ['no reason', { reason: '' }, 'needReason'],
  ] as const)('giving a role is refused here first for %s', async (_n, change, key) => {
    const w = world();
    const a = await w.centre.peopleAct(MANAGER, { act: 'give', pin: '222222', userId: 'cashier-02', name: 'Priya S', roleId: 'cashier', reason: 'new hire', ...change });
    expect(a.json['en']).toBe(CENTRE_WORDS[key].en);
    expect(w.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('the shop\'s system refuses (two-person rule, OB-95 …): its own words are shown, never "done"', async () => {
    const w = world({ api: (c) => (c.method === 'POST' ? { status: 422, body: { error: { code: 'it_role_and_business_role_on_one_person', whatHappened: 'One person may not hold both the IT/platform role and a business role — owner decision OB-95.' } } } : undefined) });
    const a = await w.centre.peopleAct(MANAGER, { act: 'give', pin: '222222', userId: 'it-01', name: 'Ravi K', roleId: 'cashier', reason: 'x' });
    expect(a).toMatchObject({ status: 422, json: { ok: false } });
    expect(String(a.json['en'])).toContain('OB-95');
    expect(w.log.at(-1)).toMatchObject({ outcome: 'refused:refused' });
  });

  it('the second person approves as themselves; the till is asked to read its people again', async () => {
    const w = world();
    const a = await w.centre.peopleAct(OWNER, { act: 'approve', pin: '111111', grantId: 'g-9' });
    expect(a.json['en']).toBe(CENTRE_WORDS.approved.en);
    expect(w.calls.at(-1)).toMatchObject({ method: 'POST', path: '/v1/identity/grants/g-9/approve', sub: 'owner-01' });
    expect(w.refreshed()).toBe(1);
    const r = await w.centre.peopleAct(OWNER, { act: 'reject', pin: '111111', grantId: 'g-9', reason: '' });
    expect(r.json['en']).toBe(CENTRE_WORDS.needReason.en);
  });

  it('a person whose role may not do it is refused before any PIN is asked', async () => {
    const w = world();
    const a = await w.centre.peopleAct({ userId: 'cashier-01', signedInAt: OWNER.signedInAt }, { act: 'give', pin: '333333', userId: 'cashier-03', name: 'X Y', roleId: 'cashier', reason: 'x' });
    expect(a.status).toBe(403);
    expect(w.calls).toHaveLength(0);
    expect(w.centre.may('cashier-01')).toEqual({ people: false, exports: false, import: false });
  });

  it('if this PC cannot write it down, nothing is done', async () => {
    const w = world({ failLog: true });
    const a = await w.centre.peopleAct(MANAGER, { act: 'give', pin: '222222', userId: 'cashier-02', name: 'Priya S', roleId: 'cashier', reason: 'new' });
    expect(a.json['en']).toBe(CENTRE_WORDS.notRecorded.en);
    expect(w.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('taking a role back asks for approval of exactly that change; their only role is a leaver instead', async () => {
    const w = world();
    const only = await w.centre.peopleAct(MANAGER, { act: 'take-back', pin: '222222', userId: 'cashier-01', roleId: 'cashier', reason: 'moved' });
    expect(only.json['en']).toBe(CENTRE_WORDS.onlyRole.en);
    const left = await w.centre.peopleAct(MANAGER, { act: 'leaver', pin: '222222', userId: 'cashier-01', reason: 'resigned' });
    expect(left.json['en']).toBe(CENTRE_WORDS.askedChange.en);
    expect(w.calls.at(-1)).toMatchObject({ method: 'POST', path: '/v1/approvals/requests', sub: 'manager-01', body: { kind: 'access_change', details: { event: 'leaver', userId: 'cashier-01' } } });
  });

  it('a change waiting for this person is decided with a reason, in their name', async () => {
    const w = world({ api: (c) => (c.path.endsWith('/decide') ? { status: 200, body: { status: 'approved' } } : undefined) });
    const a = await w.centre.peopleAct(OWNER, { act: 'decide-change', pin: '111111', requestId: 'a-1', decision: 'approved', reason: 'agreed' });
    expect(a.json['en']).toBe(CENTRE_WORDS.decided.en);
    expect(w.calls.at(-1)).toMatchObject({ path: '/v1/approvals/requests/a-1/decide', sub: 'owner-01', body: { decision: 'approved', reason: 'agreed' } });
  });

  it('what the page shows: this store\'s people only, who has a PIN, what waits for this person', async () => {
    const w = world({ holders: ['owner-01'] });
    const s = await w.centre.peopleState(OWNER);
    expect(s.status).toBe(200);
    const people = s.json['people'] as { userId: string; hasPin: boolean }[];
    expect(people.map((p) => p.userId)).toEqual(['cashier-01', 'manager-01', 'owner-01']); // far-01 works at S2
    expect(people.find((p) => p.userId === 'owner-01')!.hasPin).toBe(true);
    expect((s.json['pending'] as { grantId: string }[]).map((p) => p.grantId)).toEqual(['g-9']);
    expect((s.json['toDecide'] as { requestId: string }[]).map((p) => p.requestId)).toEqual(['a-1']);
    expect(s.json['roles']).toContainEqual({ id: 'cashier', name: 'Cashier', nameTa: 'காசாளர்' });
    // reads use the office sign-in's time — never a made-up fresh PIN
    expect(w.calls.every((c) => c.authTime === Date.parse(OWNER.signedInAt) / 1000)).toBe(true);
  });
});

describe('a new person sets their own first PIN — never a reset, never one\'s own', () => {
  const base = { act: 'set-pin', pin: '111111', userId: 'cashier-02', newPin: '482913', newPinAgain: '482913' };
  it('a person with a role asked here and no PIN: their PIN is set by the till\'s own code, recorded by who confirmed', async () => {
    const w = world();
    const a = await w.centre.peopleAct(OWNER, base);
    expect(a.json['en']).toBe(CENTRE_WORDS.pinSet.en);
    expect(w.setPins).toEqual([{ userId: 'cashier-02', pin: '482913', by: 'owner-01' }]);
    expect(JSON.stringify(w.log)).not.toContain('482913');
  });
  it.each([
    ['already has a PIN (a reset could take over an account)', { userId: 'cashier-01' }, 'pinAlready'],
    ['no role asked or given here', { userId: 'nobody-01' }, 'pinNoRole'],
    ['their own', { userId: 'owner-01' }, 'yourself'],
    ['two different PINs', { newPinAgain: '482914' }, 'pinNotSame'],
    ['the confirmer\'s own PIN', { newPin: '111111', newPinAgain: '111111' }, 'pinSameAsYours'],
  ] as const)('refused when %s', async (_n, change, key) => {
    const w = world();
    const a = await w.centre.peopleAct(OWNER, { ...base, ...change });
    expect(a.json['en']).toBe(CENTRE_WORDS[key].en);
    expect(w.setPins).toHaveLength(0);
  });
  it('someone who may not ask for roles cannot set one', async () => {
    const w = world({ perms: { 'owner-01': ['identity.role.read'] } });
    const a = await w.centre.peopleAct(OWNER, base);
    expect(a.status).toBe(403);
    expect(w.setPins).toHaveLength(0);
  });
});

describe('OI-07 exports: the person\'s own PIN, head office decides what, the file is Excel-safe and logged twice', () => {
  it('exports in the person\'s name, Excel-safe, and written down on this PC', async () => {
    const w = world();
    const a = await w.centre.ioExport(MANAGER, { domain: 'products', pin: '222222' });
    expect(a.json).toMatchObject({ ok: true, fileName: 'products-2026-11-14.csv', en: CENTRE_WORDS.exported.en });
    expect(a.json['csv']).toBe('\uFEFFproductId,name\r\np1,\'=1+1\r\n');
    expect(w.calls.at(-1)).toMatchObject({ method: 'POST', path: '/v1/export/products', sub: 'manager-01', authTime: NOW / 1000 });
    expect(w.log.map((e) => e['outcome'])).toEqual(['asked', 'exported']);
  });
  it('no PIN: nothing exported; no permission: refused; a refusal from the shop\'s system is shown', async () => {
    const w = world({ api: (c) => (c.path === '/v1/export/stock-movements' ? { status: 403, body: { error: { whatHappened: 'You may not export \'stock-movements\'.' } } } : undefined) });
    expect((await w.centre.ioExport(MANAGER, { domain: 'products' })).status).toBe(401);
    expect((await w.centre.ioExport({ userId: 'cashier-01', signedInAt: OWNER.signedInAt }, { domain: 'products', pin: '333333' })).status).toBe(403);
    const r = await w.centre.ioExport(MANAGER, { domain: 'stock-movements', pin: '222222' });
    expect(r.status).toBe(403);
    expect(String(r.json['en'])).toContain('may not export');
  });
  it('the page lists the domains head office offers this person, and the export log', async () => {
    const w = world();
    const s = await w.centre.ioState(OWNER);
    expect(s.json).toMatchObject({ ok: true, may: { exports: true, import: false }, domains: [{ domain: 'products' }] });
  });
});

describe('the pages and the menu (OI-09: every word with its Tamil twin)', () => {
  it('the menu\'s Users & roles and Import & export open the office centre on the store PC', () => {
    expect(OFFICE_CENTRE_REDIRECTS['/users']).toBe('/people/');
    expect(OFFICE_CENTRE_REDIRECTS['/data-io']).toBe('/import-export/');
  });
  it('every label and button on both pages carries Tamil', () => {
    for (const html of [peoplePage(), importExportPage()]) {
      const labels = [...html.matchAll(/<(label|h2|button)\b[^>]*>([\s\S]*?)<\/\1>/g)].map((m) => m[2]!);
      expect(labels.length).toBeGreaterThan(5);
      for (const l of labels) expect(l, l).toMatch(/[\u0B80-\u0BFF]/);
    }
    for (const w of Object.values(CENTRE_WORDS)) { expect(w.en.length).toBeGreaterThan(0); expect(w.ta).toMatch(/[\u0B80-\u0BFF]/); }
  });
});

describe('the store PC is set up for it (ADR-0033)', () => {
  const flags = { lanePort: '8090', screenPort: '8091', store: 'S1', lane: 'lane-1' };
  const compose = { EDGE_TENANT_ID: 'shop-1', PACK_SIGNING_KEY: 'p'.repeat(64), IDP_SIGNING_KEY: SECRET, IDP_ISSUER: 'sre-store-pc', IDP_AUDIENCE: 'sre-api', API_PORT: '8081' };
  it('the shop\'s own copy: the till gets this copy\'s sign-in key, the office centre switch and the imports folder', () => {
    const plan = planTillSettings({ flags, installDir: '/data/till', appsDir: '/r/apps', composeEnv: compose, realCopy: true, mintStoreToken: () => ({ token: 't' }) });
    expect(plan.ok).toBe(true);
    expect(plan.settings).toMatchObject({ EDGE_OFFICE_HEAD_OFFICE: 'this-pc', IDP_SIGNING_KEY: SECRET, EDGE_IMPORTS_DIR: '/data/imports', CLOUD_API_URL: 'http://127.0.0.1:8081', MIGRATION_TARGET_KIND: 'rehearsal' });
    const text = renderTillEnv(plan.settings);
    expect(text).toContain('EDGE_OFFICE_HEAD_OFFICE=this-pc');
    expect(thisPcApiSettingsFrom(Object.fromEntries(text.split('\n').filter((l: string) => /^[A-Z_]+=/.test(l)).map((l: string) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])))).toMatchObject({ on: true });
  });
  it('anything that is not the shop\'s own copy never gets the key', () => {
    const plan = planTillSettings({ flags, installDir: '/data/till', appsDir: '/r/apps', composeEnv: compose, realCopy: false });
    expect(plan.settings['EDGE_OFFICE_HEAD_OFFICE']).toBeUndefined();
    expect(plan.settings['IDP_SIGNING_KEY']).toBeUndefined();
  });
  it('a till.env already there gets the keys only where it has none — a re-run never rotates them', () => {
    const plan = planTillSettings({ flags: { ...flags, store: undefined }, installDir: '/data/till', appsDir: '/r/apps', composeEnv: compose, realCopy: true, existing: { EDGE_LANE_ID: 'lane-1', PACK_SIGNING_KEY: 'p'.repeat(64), IDP_SIGNING_KEY: 'old'.repeat(16) } });
    const changes = tillEnvChangesFor({ settings: plan.settings, existing: { IDP_SIGNING_KEY: 'old'.repeat(16) }, flags: {} });
    expect(changes['IDP_SIGNING_KEY']).toBeUndefined();
    expect(changes['EDGE_OFFICE_HEAD_OFFICE']).toBe('this-pc');
    expect(THIS_PC_KEYS).toContain('EDGE_IMPORTS_DIR');
  });
  it('the till\'s Windows service may write the imports folder (and only its own folders)', () => {
    const P = servicePaths({ platform: 'win32', repoRoot: 'C:\\SRE\\release', dataRoot: 'D:\\SRE-data', pgBin: 'C:\\SRE\\pg\\bin', serviceHost: 'x', nodePath: 'node' });
    const g = grantsFor(P, () => true).filter((x: { target: string }) => x.target === 'D:\\SRE-data\\imports');
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ name: SERVICES.till });
    expect(g[0]!.args[2]).toMatch(/:\(OI\)\(CI\)M$/);
  });
});

describe('the owner\'s PC, set up before step 4: setup (run by every update) adds the Office centre\'s settings it lacks', () => {
  it('added once from this copy\'s own settings, names said never values; a second run changes nothing; nothing it has is replaced', async () => {
    const w = world2();
    const { d } = storePc(w);
    const fs = d.fs;
    for (const dir of ['C:\\SRE\\runtime\\pgsql\\bin', 'C:\\SRE\\runtime\\winsw', 'C:\\SRE\\scripts', 'C:\\SRE\\services\\api\\dist', 'C:\\SRE\\edge\\store-edge\\dist']) fs.mkdirSync(dir, { recursive: true });
    for (const exe of ['initdb.exe', 'pg_ctl.exe', 'postgres.exe', 'psql.exe', 'pg_isready.exe']) fs.writeFileSync(`C:\\SRE\\runtime\\pgsql\\bin\\${exe}`, 'pretend');
    fs.writeFileSync('C:\\SRE\\runtime\\winsw\\WinSW-x64.exe', 'pretend');
    for (const f of ['C:\\SRE\\scripts\\store-computer-service.mjs', 'C:\\SRE\\services\\api\\dist\\start.js', 'C:\\SRE\\edge\\store-edge\\dist\\start.js']) fs.writeFileSync(f, '//');
    fs.writeFileSync('C:\\SRE\\release.json', JSON.stringify({ kind: 'sre-store-pc-release', version: '1.0.0', commit: 'abcdef1234567890' }));
    expect(await storeComputer(['setup', '--data-drive', 'F:'], d)).toBe(0);
    const tillEnv = 'F:\\SRE-data\\till\\till.env';
    // The pretend till install wrote a till.env as it stood before step 4; make it hold its own (old) key to prove it is kept.
    fs.writeFileSync(tillEnv, `${fs.readFileSync(tillEnv, 'utf8')}IDP_ISSUER=kept-issuer\n`);
    w.said.length = 0;
    expect(await storeComputer(['setup'], d)).toBe(0);
    const real = settingsIn(fs, 'F:\\SRE-data');
    const till = parseEnv(fs.readFileSync(tillEnv, 'utf8'));
    expect(till).toMatchObject({ EDGE_OFFICE_HEAD_OFFICE: 'this-pc', IDP_SIGNING_KEY: real['IDP_SIGNING_KEY'], IDP_AUDIENCE: real['IDP_AUDIENCE'], IDP_ISSUER: 'kept-issuer', EDGE_IMPORTS_DIR: 'F:\\SRE-data\\imports' });
    const out = w.said.join('\n');
    expect(out).toContain('The till\'s settings gained the Office centre\'s settings (Users & roles, Import & export): EDGE_OFFICE_HEAD_OFFICE, IDP_SIGNING_KEY, IDP_AUDIENCE, EDGE_IMPORTS_DIR, MIGRATION_TARGET_KIND.');
    expect(out).not.toContain(String(real['IDP_SIGNING_KEY']));
    const after = fs.readFileSync(tillEnv, 'utf8');
    w.said.length = 0;
    expect(await storeComputer(['setup'], d)).toBe(0);
    expect(fs.readFileSync(tillEnv, 'utf8')).toBe(after);
    expect(w.said.join('\n')).not.toContain('gained the Office centre');
  });
});
