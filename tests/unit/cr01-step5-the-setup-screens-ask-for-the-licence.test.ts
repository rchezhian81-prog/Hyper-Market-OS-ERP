import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createSetupDoor, type Progress, type SetupLicence } from '../../scripts/lib/setup-app';

/**
 * **CR-01 step 5 · OI-10: the first-run screens ask for the licence file (SRE-Setup.exe).**
 *
 *   The tenant id is made by the setup itself (OI-03), so a licence naming it can only exist AFTER this PC is set up: the
 *   screens' last page shows the tenant id and the licence request to send the seller, and takes the licence file the seller
 *   sends back — checked offline, on this PC (P-01). Not before the setup finished well; only with the one-time key. Without
 *   a licence yet the shop still trades (the setup period); the same file can be loaded later on the Licence screen.
 */

const key = { 'x-setup-key': 'k' };

function door(opts: { setUp?: boolean } = {}) {
  const loaded: string[] = [];
  let finishWell = true;
  const licence: SetupLicence = {
    view: () => ({ state: 'no_licence', en: 'No licence is loaded yet. Setup period: 30 day(s) left', ta: 'இன்னும் உரிமம் ஏற்றப்படவில்லை', keyBuiltIn: true, tenantId: 't-1', request: { kind: 'sre-retail-os-licence-request-v1', tenantId: 't-1' } }),
    load: (text) => { loaded.push(text); return text === 'good' ? { ok: true, en: 'LICENCE LOADED — LIC-1', ta: 'உரிமம் ஏற்றப்பட்டது' } : { ok: false, refusedBecause: 'another_shop', en: 'This licence is for ANOTHER shop (a copy)', ta: 'நகல்' }; },
  };
  const handle = createSetupDoor({
    key: 'k', page: '',
    state: () => ({ setUp: opts.setUp ?? true, drives: [], tenantId: 't-1' }),
    install: async () => true,
    keep: async (p: Progress) => { p.done = true; p.ok = finishWell; return finishWell; },
    shortcuts: async () => ({ ok: true, lines: [] }),
    licence,
  });
  return { handle, loaded, failNext: () => { finishWell = false; } };
}

describe('the licence on the setup screens\' last page', () => {
  it('shows the standing, the tenant id and the request to send the seller — names only', async () => {
    const { handle } = door();
    const r = await handle({ method: 'GET', path: '/setup/api/licence', headers: key });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({ state: 'no_licence', tenantId: 't-1', request: { tenantId: 't-1' } });
  });

  it('loads the seller\'s file only after the setup finished well; a copy is refused by name', async () => {
    const { handle, loaded } = door();
    expect((await handle({ method: 'POST', path: '/setup/api/licence', headers: key, body: { licence: 'good' } })).status).toBe(409);
    await handle({ method: 'POST', path: '/setup/api/keep', headers: key });
    const copy = await handle({ method: 'POST', path: '/setup/api/licence', headers: key, body: { licence: 'copy' } });
    expect(copy.status).toBe(422);
    expect(JSON.parse(copy.body)).toMatchObject({ ok: false, refusedBecause: 'another_shop' });
    const good = await handle({ method: 'POST', path: '/setup/api/licence', headers: key, body: { licence: 'good' } });
    expect(good.status).toBe(200);
    expect(JSON.parse(good.body)).toMatchObject({ ok: true });
    expect(loaded).toEqual(['copy', 'good']);
  });

  it('never without the one-time key, never after a setup that did not finish well', async () => {
    const { handle, loaded, failNext } = door();
    expect((await handle({ method: 'GET', path: '/setup/api/licence', headers: {} })).status).toBe(403);
    failNext();
    await handle({ method: 'POST', path: '/setup/api/keep', headers: key });
    expect((await handle({ method: 'POST', path: '/setup/api/licence', headers: key, body: { licence: 'good' } })).status).toBe(409);
    expect(loaded).toEqual([]);
  });

  it('the page has the licence section, in English and Tamil, with the request download and the file input', () => {
    const page = readFileSync('scripts/setup-page/index.html', 'utf8');
    expect(page).toContain('id="licence"');
    expect(page).toContain('id="licFile"');
    expect(page).toContain('id="licRequest"');
    for (const k of ['licH', 'licP', 'licBtn', 'licLater']) {
      expect(page).toContain(`data-t="${k}"`);
      expect(page).toMatch(new RegExp(`${k}: '[^']*[\\u0B80-\\u0BFF]`));
    }
  });
});
