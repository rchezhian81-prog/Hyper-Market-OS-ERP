import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { startScreenServer, SCREEN_HOST, APP_SHELL, screenOfPath, type ScreenServer } from '../../edge/store-edge/src/screen-server';
import type { ScreenInput } from '../../edge/store-edge/src/screen-data';
import { HEAD_OFFICE_PAGES, headOfficePagePayload } from '../../edge/store-edge/src/head-office-pages';
import { readPack } from '../../edge/store-edge/src/store-pack';
import { SyncOutbox } from '../../packages/sync/src/index';
import { ERP_NAVIGATION } from '../../apps/web-erp/src/navigation';

/**
 * **Every menu item marked as the store computer's is ANSWERED by the store computer's own server (OB-380 · P-07 · P-08).**
 *
 * The catalogue test proves each box item's path resolves through the box's router. That is the router agreeing with
 * itself. This asks the real screen socket: every item the menu may offer (`served: 'box'`, the default) is fetched over
 * HTTP, through the box's redirects, and must come back 200 as an HTML page carrying its own shell's title, the menu the
 * box drew for it — no dead link, no 404, no other screen's page. And the box never
 * answers head office's API itself (`/v1/…`): with nothing in front of it carrying head office, such a call fails as a
 * lost link, so a page can never be handed a made-up answer. A new menu item the box does not serve fails here.
 */

const NOW = '2026-10-26T06:00:00.000Z';
const PEOPLE = {
  roles: [{ id: 'owner', name: 'Owner', permissions: [...new Set(ERP_NAVIGATION.map((i) => i.requires))] }],
  roleAssignments: [{ userId: 'u-owner', roleId: 'owner', branchScope: 'all' }],
};
const snapshot = (): ScreenInput => ({
  pack: readPack({ version: 1, lossPreventionRules: [], policies: { tradingDayCutoff: '02:00', storeId: 'S1', branchId: 'S1' }, ...PEOPLE }, NOW),
  sales: [], unreadableRecords: 0, outbox: new SyncOutbox(), now: NOW, tradingDay: '2026-10-26',
}) as unknown as ScreenInput;

const boxItems = ERP_NAVIGATION.filter((i) => (i.served ?? 'box') === 'box');
const titleOf = (html: string): string => /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? '';

/** GET through the box's own redirects (it answers `/x` with 301 → `/x/`, and a menu alias with its target). */
async function follow(base: string, path: string): Promise<{ status: number; type: string; body: string; at: string }> {
  let at = path;
  for (let hop = 0; hop < 4; hop += 1) {
    const res = await fetch(`${base}${at}`, { redirect: 'manual', headers: { 'x-sre-user': 'u-owner' } });
    if (res.status === 301 || res.status === 302) { at = res.headers.get('location') ?? at; continue; }
    return { status: res.status, type: res.headers.get('content-type') ?? '', body: await res.text(), at };
  }
  throw new Error(`${path}: too many redirects`);
}

describe('every menu item the store computer may offer is answered by its server', () => {
  let server: ScreenServer;
  let base: string;
  beforeAll(async () => {
    server = await startScreenServer({ port: 0, appsDir: 'apps', snapshot, trustForwardedUser: true });
    base = `http://${SCREEN_HOST}:${server.port}`;
  });
  afterAll(async () => { await server?.stop(); });

  it('there is something to check: every item is the box\'s (none unbuilt since OB-401), the office pages among them', () => {
    expect(boxItems.length).toBe(ERP_NAVIGATION.length);
    expect(ERP_NAVIGATION.filter((i) => i.served === 'unbuilt')).toEqual([]);
    expect(ERP_NAVIGATION.filter((i) => i.served === 'unserved')).toEqual([]);
    for (const p of HEAD_OFFICE_PAGES) expect(boxItems.map((i) => screenOfPath(i.path)), `${p.screen} has a menu door`).toContain(p.screen);
  });

  // (Whether a page is told anything else depends on what the store pack carries for it — a pack without a section gives
  // that screen nothing, which the screen says. The head-office pages' payload is checked below.)
  it('each box item answers 200 with its OWN page and the menu the box drew', async () => {
    for (const item of boxItems) {
      const screen = screenOfPath(item.path);
      expect(screen, `${item.id} → ${item.path} names a screen`).not.toBeNull();
      const got = await follow(base, item.path);
      expect(got.status, `${item.id} → ${item.path} (${got.at})`).toBe(200);
      expect(got.type, `${item.id} is a page`).toMatch(/^text\/html/);
      const shell = APP_SHELL[screen!];
      const onDisk = readFileSync(`apps/${shell.dir}/web/${shell.file}`, 'utf8');
      expect(titleOf(got.body), `${item.id} is served its own page (${shell.file}), not another screen's`).toBe(titleOf(onDisk));
      // Only the ERP's pages carry the menu; the till and the handhelds under Devices are one job each.
      if (shell.dir === 'web-erp') expect(got.body, `${item.id}: the box drew the menu into the page`).toContain('window.sreNavigation = ');
    }
  });

  it('a head-office page is given ONLY who is looking — never a figure the box holds', async () => {
    expect(Object.keys(headOfficePagePayload()).sort()).toEqual(['permissions', 'servedBy']);
    for (const p of HEAD_OFFICE_PAGES) {
      const got = await follow(base, `/${p.screen}/`);
      const m = new RegExp(`<script>window\\.${p.global} = (\\{[^<]*\\});</script>`).exec(got.body);
      expect(m, `${p.screen} carries ${p.global}`).not.toBeNull();
      const payload = JSON.parse(m![1]!) as Record<string, unknown>;
      // OB-612 (R16-A): the Bill findings page is also told WHICH store this box is (its signed pack's branch), so it asks head
      // office for this store's findings — the box's own identity, as the Devices page is told it (OB-601), never a figure.
      expect(Object.keys(payload).sort(), p.screen).toEqual(p.screen === 'findings' && 'storeId' in payload ? ['permissions', 'servedBy', 'storeId', 'userId'] : ['permissions', 'servedBy', 'userId']);
      expect(payload['userId']).toBe('u-owner');
    }
  });

  it('the box never answers head office\'s API itself — a `/v1` call fails as a lost link, GET or POST', async () => {
    for (const [method, path] of [['GET', '/v1/finance/payment-exceptions'], ['POST', '/v1/hr/payroll/pay-run/PR-1/append'], ['GET', '/v1']] as const) {
      const outcome = await fetch(`${base}${path}`, { method, ...(method === 'POST' ? { body: '{}', headers: { 'content-type': 'application/json' } } : {}) })
        .then((r) => `answered ${r.status}`, () => 'lost link');
      expect(outcome, `${method} ${path}`).toBe('lost link');
    }
    // …and the box keeps serving its pages afterwards.
    expect((await follow(base, '/manager/')).status).toBe(200);
  });
});
