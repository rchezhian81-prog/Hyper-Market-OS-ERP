import { describe, it, expect } from 'vitest';
import { main, type Deps } from '../../scripts/lib/store-computer.mjs';
import { SHORTCUTS } from '../../scripts/lib/store-computer-setup.mjs';
import { createSetupDoor, shortcutsFrom, type Progress } from '../../scripts/lib/setup-app';
import { aboutPage, releaseFrom } from '../../edge/store-edge/src/about-page';
import { world, type World } from '../support/store-computer-world';
import { settingsIn, storePc } from '../support/store-pc-windows';

/**
 * **CR-01 step 2d · OI-04 — desktop shortcuts offered at the end of setup; OI-03 — the tenant id on the About screen.**
 *
 *   `store-computer shortcuts [--only till,office,import]` puts the chosen shortcuts on the desktop of the person running
 *   it: "SRE Till" (this PC's till screen), "SRE Office" (the office pages), "SRE Import & export" (the import page,
 *   through the data folder's launcher, with the Node the release brings). No secret is in any of them.
 *   The first-run screens offer the three on their last page, and only once the setup has finished well.
 *   The About screen (/about/, this PC only) says the shop's tenant id, its store, this till and the release — names only.
 */

const said = (w: World): string => w.said.join('\n');

/** A store PC already set up (settings on F:, the till installed), with the owner's Desktop folder. */
async function setUpPc(): Promise<{ w: World; d: Deps }> {
  const w = world();
  const pc = storePc(w);
  const d: Deps = { ...pc.d, env: { ...pc.d.env, USERPROFILE: 'C:\\Users\\owner' } };
  d.fs.mkdirSync('C:\\Users\\owner\\Desktop', { recursive: true });
  expect(await main(['prepare', '--data-drive', 'F:'], d)).toBe(0);
  const s = settingsIn(d.fs, 'F:\\SRE-data');
  d.fs.mkdirSync('F:\\SRE-data\\till', { recursive: true });
  d.fs.writeFileSync('F:\\SRE-data\\till\\till.env', `EDGE_TENANT_ID=${s['EDGE_TENANT_ID']}\nPACK_SIGNING_KEY=${s['PACK_SIGNING_KEY']}\nEDGE_LANE_PORT=8090\nEDGE_SCREEN_PORT=8091\n`);
  w.said.length = 0;
  return { w, d };
}

describe('shortcuts — the till, the office pages, import & export, on the desktop (OI-04)', () => {
  it('all three by default: two links to this PC\'s own screens and the import page\'s launcher — no secret in any', async () => {
    const { w, d } = await setUpPc();
    expect(await main(['shortcuts'], d)).toBe(0);
    const desk = (f: string): string => d.fs.readFileSync(`C:\\Users\\owner\\Desktop\\${f}`, 'utf8');
    expect(desk(SHORTCUTS.till)).toBe('[InternetShortcut]\r\nURL=http://127.0.0.1:8091/pos/\r\n');
    expect(desk(SHORTCUTS.office)).toBe('[InternetShortcut]\r\nURL=http://127.0.0.1:8091/manager/\r\n');
    expect(desk(SHORTCUTS.import)).toContain(`"${d.nodePath}" "F:\\SRE-data\\run\\launch.mjs" import`);
    expect(d.fs.existsSync('F:\\SRE-data\\run\\launch.mjs')).toBe(true);
    expect(said(w)).toMatch(/^ON THE DESKTOP — "SRE Till"\.$/m);
    expect(said(w)).toMatch(/About this PC \(its tenant id and release\): http:\/\/127\.0\.0\.1:8091\/about\//);
    const s = settingsIn(d.fs, 'F:\\SRE-data');
    for (const f of Object.values(SHORTCUTS)) for (const k of ['POSTGRES_PASSWORD', 'PACK_SIGNING_KEY', 'IDP_SIGNING_KEY']) expect(desk(f)).not.toContain(s[k]!);
  });

  it('only the chosen ones; an unknown name is refused by name; a PC not set up is refused', async () => {
    const { w, d } = await setUpPc();
    expect(await main(['shortcuts', '--only', 'till'], d)).toBe(0);
    expect(d.fs.existsSync(`C:\\Users\\owner\\Desktop\\${SHORTCUTS.till}`)).toBe(true);
    expect(d.fs.existsSync(`C:\\Users\\owner\\Desktop\\${SHORTCUTS.office}`)).toBe(false);
    w.said.length = 0;
    expect(await main(['shortcuts', '--only', 'till,games'], d)).toBe(2);
    expect(said(w)).toMatch(/REFUSED — not a shortcut this offers: games\./);
    const fresh = world();
    const pc = storePc(fresh);
    expect(await main(['shortcuts'], { ...pc.d, env: { ...pc.d.env, USERPROFILE: 'C:\\Users\\owner' } })).toBe(2);
    expect(said(fresh)).toMatch(/REFUSED — this PC is not set up yet\./);
  });
});

describe('the first-run screens offer the shortcuts on their last page, only after a good setup', () => {
  const door = () => {
    const asked: string[][] = [];
    let finishWell = true;
    const handle = createSetupDoor({
      key: 'k', page: '',
      state: () => ({ setUp: true, drives: [], tenantId: 't-1', dataRoot: 'F:\\SRE-data' }),
      install: async () => true,
      keep: async (p: Progress) => { p.done = true; p.ok = finishWell; return finishWell; },
      shortcuts: async (chosen) => { asked.push([...chosen]); return { ok: true, lines: chosen.map((c) => `ON THE DESKTOP — ${c}`) }; },
    });
    return { handle, asked, failNext: () => { finishWell = false; } };
  };
  const key = { 'x-setup-key': 'k' };

  it('refused before the setup has finished; then exactly the ticked ones, in a fixed order', async () => {
    const { handle, asked } = door();
    expect((await handle({ method: 'POST', path: '/setup/api/shortcuts', headers: key, body: { till: true } })).status).toBe(409);
    expect((await handle({ method: 'POST', path: '/setup/api/keep', headers: key })).status).toBe(202);
    const r = await handle({ method: 'POST', path: '/setup/api/shortcuts', headers: key, body: { import: true, till: true, games: true } });
    expect(r.status).toBe(200);
    expect(asked).toEqual([['till', 'import']]);
    const none = await handle({ method: 'POST', path: '/setup/api/shortcuts', headers: key, body: {} });
    expect(JSON.parse(none.body).lines[0]).toMatch(/No shortcut was chosen/);
    expect((await handle({ method: 'POST', path: '/setup/api/shortcuts', headers: {}, body: { till: true } })).status).toBe(403);
  });

  it('not offered when the setup did not finish well', async () => {
    const { handle, asked, failNext } = door();
    failNext();
    await handle({ method: 'POST', path: '/setup/api/keep', headers: key });
    expect((await handle({ method: 'POST', path: '/setup/api/shortcuts', headers: key, body: { till: true } })).status).toBe(409);
    expect(asked).toEqual([]);
  });

  it('only true ticks count', () => {
    expect(shortcutsFrom({ till: 'yes', office: true, import: 1 })).toEqual(['office']);
  });
});

describe('the About screen (OI-03): the tenant id, the store, the till, the release — names only', () => {
  it('says each fact, in English and Tamil; a fact this PC does not know says so', () => {
    const html = aboutPage({ tenantId: '8538cb43-36d6-4346-b093-a72ebe25e400', storeId: 'SRE-MAIN', laneId: 'lane-1', release: '1.0.0', commit: 'abcdef12' });
    expect(html).toContain('<code>8538cb43-36d6-4346-b093-a72ebe25e400</code>');
    expect(html).toContain('<code>SRE-MAIN</code>');
    expect(html).toContain('<code>1.0.0 (abcdef12)</code>');
    expect(html).toContain('கடையின் டெனன்ட் எண்');
    expect(aboutPage({})).toContain('not known on this PC');
    expect(aboutPage({ tenantId: '<script>' })).toContain('&lt;script&gt;');
  });
  it('the release is read from release.json; anything unreadable gives nothing', () => {
    expect(releaseFrom('{"version":"1.2.3","commit":"0123456789abcdef"}')).toEqual({ release: '1.2.3', commit: '01234567' });
    expect(releaseFrom('not json')).toEqual({});
    expect(releaseFrom(undefined)).toEqual({});
  });
});
