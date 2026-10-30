import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TEST_PACK_KEY } from '../support/api-harness';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { GLOBAL_FOR, type ScreenName } from '../../edge/store-edge/src/screen-data';
import { ERP_NAVIGATION } from '../../apps/web-erp/src/navigation';
import { permissionsForScreen, screenOfPath } from '../../edge/store-edge/src/screen-server';

/**
 * SEC-1 (P-04 least privilege · §27 · P-07). On the hosted copy the person reaches the store computer through the front:
 * its sign-in gate names them in `X-Sre-User` and the box trusts that name (`EDGE_SCREEN_TRUST_FORWARDED_USER=1`, the pilot
 * overlay and nginx.pilot.conf). On that path the box must hold them to the SAME per-screen rule the PIN and head-office
 * sign-ins are held to: a cashier who types /owner/, /manager/ or an Admin address is refused — 403, the "may not open this
 * screen" page, and none of the box's figures in it — while the owner and the manager still open theirs, and the menu the
 * box draws offers only what the person may open. Drives the REAL store computer (`startEdge`). Synthetic people only.
 */

const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EVERY_SCREEN_WORD = [...new Set(ERP_NAVIGATION.map((i) => i.requires))];
const PACK_JSON = JSON.stringify({
  version: 1, lossPreventionRules: [],
  policies: { tradingDayCutoff: '02:00', storeId: 'store-1', branchId: 'store-1' },
  roles: [
    { id: 'owner', name: 'Owner', permissions: EVERY_SCREEN_WORD },
    { id: 'store_manager', name: 'Store manager', permissions: ['till.dayclose.read', 'pos.sale.read'] },
    { id: 'cashier', name: 'Cashier', permissions: ['pos.sale.read', 'pos.sale.create'] },
  ],
  roleAssignments: [
    { userId: 'u-owner', roleId: 'owner', branchScope: 'all' },
    { userId: 'u-mgr', roleId: 'store_manager', branchScope: ['store-1'] },
    { userId: 'pilot-cashier', roleId: 'cashier', branchScope: ['store-1'] },
  ],
  people: [{ userId: 'pilot-cashier', displayName: 'Pilot Cashier' }],
});

let edge: EdgeProcess;
let dir: string;
let base: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sre-sec1-'));
  const packFile = join(dir, 'store-pack.json');
  await writeFile(packFile, PACK_JSON, 'utf8');
  edge = (await startEdge({
    EDGE_DATA_DIR: dir, EDGE_TENANT_ID: T, PACK_SIGNING_KEY: TEST_PACK_KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
    EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile, EDGE_SCREEN_TRUST_FORWARDED_USER: '1',
  }, () => {}))!;
  base = `http://127.0.0.1:${edge.screens!.port}`;
});
afterAll(async () => {
  await edge?.stop();
  await rm(dir, { recursive: true, force: true });
});

/** A screen as the front forwards it: the signed-in person in X-Sre-User, under the public `/store` prefix. */
const open = async (path: string, user?: string): Promise<{ status: number; body: string }> => {
  const res = await fetch(`${base}${path}`, { redirect: 'manual', headers: { 'x-forwarded-prefix': '/store', ...(user === undefined ? {} : { 'x-sre-user': user }) } });
  return { status: res.status, body: await res.text() };
};
const carriesBoxData = (body: string, screen: ScreenName): boolean =>
  body.includes(`window.${GLOBAL_FOR[screen]} =`) || body.includes('window.sreNavigation =') || body.includes('window.catalogueFreshness =');

describe('SEC-1 — the person the front signed in opens only the screens their role gives them', () => {
  it('a cashier is refused the owner, manager and Admin screens: 403, the refusal page, none of the box\'s figures', async () => {
    for (const [path, screen] of [['/owner/', 'owner'], ['/manager/', 'manager'], ['/admin/', 'admin']] as const) {
      const got = await open(path, 'pilot-cashier');
      expect(got.status, path).toBe(403);
      expect(got.body, path).toContain('Pilot Cashier may not open this screen');
      expect(carriesBoxData(got.body, screen), `${path} carried the box's data`).toBe(false);
      expect(got.body, path).not.toContain('managerData');
    }
  });

  it('with nobody named by the front, a gated screen is refused too — never served as whoever the pack named', async () => {
    for (const [path, screen] of [['/owner/', 'owner'], ['/manager/', 'manager'], ['/admin/', 'admin']] as const) {
      const got = await open(path);
      expect(got.status, path).toBe(403);
      expect(carriesBoxData(got.body, screen), path).toBe(false);
    }
  });

  it('the owner and the manager still open theirs; the manager is refused the owner\'s and the Admin screens', async () => {
    for (const path of ['/owner/', '/manager/', '/admin/']) expect((await open(path, 'u-owner')).status, `owner ${path}`).toBe(200);
    const manager = await open('/manager/', 'u-mgr');
    expect(manager.status).toBe(200);
    expect(manager.body).toContain('window.managerData =');
    expect((await open('/owner/', 'u-mgr')).status).toBe(403);
    expect((await open('/admin/', 'u-mgr')).status).toBe(403);
  });

  it('the till stays open to the cashier (they sign in at the till itself)', async () => {
    expect((await open('/pos/', 'pilot-cashier')).status).toBe(200);
  });

  it('the menu the box draws offers only screens the person may open, and the refusal page lists only those, under the front\'s prefix', async () => {
    const got = await open('/manager/', 'u-mgr');
    const m = /<script>window\.sreNavigation = ([\s\S]*?);<\/script>/.exec(got.body);
    expect(m).not.toBeNull();
    const nav = JSON.parse(m![1]!) as { groups: { items: { path: string }[] }[] };
    const held = ['till.dayclose.read', 'pos.sale.read'];
    const paths = nav.groups.flatMap((g) => g.items.map((i) => i.path));
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) {
      const screen = screenOfPath(p.replace(/^\/store/, '').split('?')[0]!);
      const needs = screen === null ? null : permissionsForScreen(screen);
      expect(needs === null || needs.some((w) => held.includes(w)), `${p} is offered but may not be opened`).toBe(true);
      // …and every link the menu offers really opens for them.
      expect((await open(p.replace(/^\/store/, ''), 'u-mgr')).status, p).toBeLessThan(400);
    }
    const refused = await open('/admin/', 'u-mgr');
    const links = [...refused.body.matchAll(/<a href="([^"]+)"/g)].map((x) => x[1]!);
    expect(links).toContain('/store/manager/');
    expect(links.some((l) => l.includes('/admin/'))).toBe(false);
  });
});
