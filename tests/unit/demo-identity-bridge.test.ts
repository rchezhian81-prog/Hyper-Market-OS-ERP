// DEMO-ONLY identity bridge (hosted demo, owner decision option A, defect H-11). Proves: it injects ONLY
// the signed-in person's userId + permissions as the LIVE API reports them — never business data —
// for exactly the pages that read their own data from /v1; a forged or absent session gets a sign-in
// redirect and never reaches the API; the payload cannot break out of its <script>; and the page map
// cannot drift from the store edge's own screen → global map.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { LocalIdp } from '../support/local-idp';
import { GLOBAL_FOR } from '../../edge/store-edge/src/screen-data';
import { PILOT_DEMO_TENANT } from '../../db/seed/pilot/dataset';
import { COOKIE_NAME } from '../../infra/pilot/demo-login/login';
import {
  BRIDGED_PAGES, bridgedPath, bridgeScript, createScreenBridgeHandler, embedJson,
} from '../../infra/pilot/demo-login/screen-bridge';

const IDP = { secret: ['bridge', 'test', 'key'].join('-').padEnd(48, '0'), issuer: 'https://pilot-idp.test', audience: 'sre-retail-os-api' };
const NOW = Date.parse('2026-09-28T09:00:00Z');
const token = (sub: string, secret = IDP.secret): string =>
  new LocalIdp({ ...IDP, secret, now: () => NOW }).issue({ sub, tenantId: PILOT_DEMO_TENANT, amr: ['pwd'] });

function handler(me: { status: number; body: unknown }) {
  const calls: Array<{ token: string; forwardedFor: string }> = [];
  const handle = createScreenBridgeHandler({
    idp: IDP, now: () => NOW,
    fetchMe: async (t, f) => { calls.push({ token: t, forwardedFor: f }); return me; },
  });
  return { handle, calls };
}
const get = (page: string, cookie?: string) => ({
  method: 'GET', url: `/login/screen-data.js?page=${encodeURIComponent(page)}`, body: '',
  headers: { 'x-forwarded-for': '203.0.113.7', ...(cookie === undefined ? {} : { cookie: `${COOKIE_NAME}=${cookie}` }) },
});

describe('identity bridge — what it injects', () => {
  it('injects exactly userId + permissions from the live API into the page global', async () => {
    const { handle, calls } = handler({ status: 200, body: { tenantId: PILOT_DEMO_TENANT, userId: 'pilot-manager', branchId: null, permissions: ['lp.case.read', 'workforce.roster.read'] } });
    const res = await handle(get('/erp/rostering.html', token('pilot-manager')));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toBe('window.rosteringData = {"userId":"pilot-manager","permissions":["lp.case.read","workforce.roster.read"]};\n');
    // It asked the API with the person's own token, on behalf of the person's own address.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.forwardedFor).toBe('203.0.113.7');
  });

  it('carries no business data — only userId, permissions and the declared identity-only defaults', async () => {
    const { handle } = handler({ status: 200, body: { userId: 'pilot-owner', permissions: ['export.read'], takings: 99999, anything: 'else' } });
    const res = await handle(get('/erp/data-io.html', token('pilot-owner')));
    const payload = JSON.parse(res.body.replace(/^window\.dataIoData = /, '').replace(/;\n$/, '')) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['importTemplates', 'permissions', 'userId']);
    expect(payload['importTemplates']).toEqual([]);
  });

  it('says nothing for a page that is not bridged (it keeps its sample view)', async () => {
    const { handle, calls } = handler({ status: 200, body: { userId: 'x', permissions: [] } });
    const res = await handle(get('/erp/finance.html', token('pilot-accountant')));
    expect(res.body).toMatch(/^\/\* demo identity bridge: nothing for this page \*\//);
    expect(calls).toHaveLength(0); // not even asked: nothing would be injected
    expect(res.body).not.toMatch(/window\./);
  });
});

describe('identity bridge — no session, no identity', () => {
  it('no cookie: sends the browser to sign in and back, and never calls the API', async () => {
    const { handle, calls } = handler({ status: 200, body: { userId: 'x', permissions: [] } });
    const res = await handle(get('/supplier/'));
    expect(res.body).toBe('location.replace("/login/?next=%2Fsupplier%2Findex.html");\n');
    expect(calls).toHaveLength(0);
  });

  it('a forged cookie (wrong key) never reaches the API', async () => {
    const { handle, calls } = handler({ status: 200, body: { userId: 'pilot-owner', permissions: ['everything'] } });
    const res = await handle(get('/erp/ess.html', token('pilot-owner', 'z'.repeat(48))));
    expect(calls).toHaveLength(0);
    expect(res.body).toMatch(/^location\.replace/);
  });

  it('the API refusing the session (e.g. 401) means sign in again, not a stale identity', async () => {
    const { handle } = handler({ status: 401, body: undefined });
    const res = await handle(get('/erp/ess.html', token('pilot-cashier')));
    expect(res.body).toMatch(/^location\.replace/);
  });
});

describe('identity bridge — injection safety', () => {
  it('a hostile value cannot close the script tag or open a comment', () => {
    const out = bridgeScript({ page: '/erp/ess.html', me: { userId: '</script><script>alert(1)</script><!--', permissions: ['a&b'] } });
    expect(out.script).not.toMatch(/<\/script|<!--|<script/i);
    const json = out.script.replace(/^window\.essData = /, '').replace(/;\n$/, '');
    expect((JSON.parse(json) as { userId: string }).userId).toBe('</script><script>alert(1)</script><!--');
  });

  it('escapes the JavaScript line separators', () => {
    expect(embedJson(`a${String.fromCharCode(0x2028)}b${String.fromCharCode(0x2029)}c`)).toBe('"a\\u2028b\\u2029c"');
  });

  it('only exact, known page paths are bridged', () => {
    expect(bridgedPath('/supplier/')).toBe('/supplier/index.html');
    expect(bridgedPath('/erp/ess.html')).toBe('/erp/ess.html');
    for (const bad of ['', '/erp/ESS.html', '/erp/ess.html?x', '/erp/../erp/ess.html', '/erp/toString', '/erp/__proto__', 'javascript:1']) {
      expect(bridgedPath(bad)).toBeUndefined();
    }
  });
});

describe('identity bridge — cannot drift from the screens', () => {
  const edgeGlobals = new Set(Object.values(GLOBAL_FOR));

  for (const [path, page] of Object.entries(BRIDGED_PAGES)) {
    it(`${path}: carries the marker BEFORE its module bundle, and uses the global the screen reads`, () => {
      const [, shell, file] = /^\/(erp|supplier)\/(.+)$/.exec(path)!;
      const dir = shell === 'erp' ? 'web-erp' : 'supplier-app';
      const html = readFileSync(`apps/${dir}/web/${file!}`, 'utf8');
      const marker = html.indexOf('<!--SCREEN-DATA-->');
      const bundle = html.indexOf(`${dir}.bundle.js`);
      expect(marker).toBeGreaterThan(-1);
      expect(marker).toBeLessThan(bundle);
      if (shell === 'erp') {
        // The same global the store edge injects for this screen — so the bridge feeds what the page reads.
        expect(edgeGlobals.has(page.global)).toBe(true);
      } else {
        expect(readFileSync('apps/supplier-app/src/browser-entry.ts', 'utf8')).toContain(page.global);
      }
    });
  }
});
