import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error — plain .mjs script module, imported for its pure helpers.
import { mirrorSettingsProblem, parseArgs, planTillSettings, renderTillEnv, tillEnvChangesFor, updateTillEnv } from '../../scripts/install-till.mjs';
// @ts-expect-error — plain .mjs script module.
import { parseEnv } from '../../scripts/standup-check.mjs';

/**
 * OB-248 (the pilot is a MIRROR) · OB-252 (guest sales only) · OB-256 — `till:install` for the store computer's REAL copy
 * writes `EDGE_MIRROR_PILOT=1` together with `EDGE_GUEST_SALES_ONLY=1`, and a real-copy till can NOT be written without
 * both: a fresh file has both; an older file (round 2: guest sales only, no mirror setting) gains the mirror setting in
 * place; a file that says otherwise (changed by hand) is refused, nothing is written, and the words say why and how to
 * fix it. Outside the real copy there is no such rule. The installer itself is run once to prove the refusal is real.
 */

const KEY = 'k'.repeat(64);
const REAL = { EDGE_TENANT_ID: 'ab000000-0000-4000-8000-000000000001', PACK_SIGNING_KEY: KEY, IDP_SIGNING_KEY: 'i'.repeat(64), IDP_ISSUER: 'sre-real-x', IDP_AUDIENCE: 'sre-real-api', API_PORT: '8081' };
const flags = (over: Record<string, unknown> = {}) => ({ ...parseArgs(['--lane', 'lane-1']), settingsNamed: true, ...over });
const plan = (over: Record<string, unknown> = {}) => planTillSettings({ flags: flags(), installDir: '/d/till', appsDir: '/r/apps', composeEnv: REAL, realCopy: true, ...over });

describe('till:install on the real copy — the mirror pilot and guest sales only, always together', () => {
  it('a fresh real-copy till.env says both, with a comment, and round-trips', () => {
    const p = plan();
    expect(p.ok).toBe(true);
    expect(p.settings).toMatchObject({ EDGE_MIRROR_PILOT: '1', EDGE_GUEST_SALES_ONLY: '1' });
    const text = renderTillEnv(p.settings);
    expect(text).toMatch(/^# OB-248 · OB-256: the mirror pilot — every sale and refund is "Paid on old system", with the old bill number \(OB-264\)\.$/m);
    expect(text).toMatch(/^EDGE_MIRROR_PILOT=1$/m);
    expect(text).toMatch(/^EDGE_GUEST_SALES_ONLY=1$/m);
    expect(parseEnv(text)).toEqual(p.settings);
    expect(p.notes.join(' ')).toMatch(/mirror pilot \(OB-248 · OB-256\)/);
    expect(mirrorSettingsProblem({ realCopy: true, finalSettings: p.settings })).toBeUndefined();
  });

  it('not the real copy: neither is written, and nothing is required', () => {
    const p = plan({ realCopy: false });
    expect(p.settings.EDGE_MIRROR_PILOT).toBeUndefined();
    expect(p.settings.EDGE_GUEST_SALES_ONLY).toBeUndefined();
    expect(mirrorSettingsProblem({ realCopy: false, finalSettings: p.settings })).toBeUndefined();
  });

  it('an older real till.env (guest sales only, no mirror setting) gains EDGE_MIRROR_PILOT=1 in place, and nothing else changes', () => {
    const fresh = plan().settings;
    const older = { ...fresh };
    delete older.EDGE_MIRROR_PILOT;
    const text = renderTillEnv(older);
    const changes = tillEnvChangesFor({ settings: plan({ existing: older }).settings, existing: older, flags: flags() });
    expect(changes).toEqual({ EDGE_MIRROR_PILOT: '1' });
    const out = updateTillEnv(text, changes);
    expect(out.changed).toEqual(['EDGE_MIRROR_PILOT']);
    expect(parseEnv(out.text)).toMatchObject({ EDGE_MIRROR_PILOT: '1', EDGE_GUEST_SALES_ONLY: '1', PACK_SIGNING_KEY: KEY });
    expect(mirrorSettingsProblem({ realCopy: true, finalSettings: { ...older, ...changes } })).toBeUndefined();
  });

  it('a real till without both can not be written: either one missing or off is refused, by name', () => {
    const fresh = plan().settings;
    for (const [k, v] of [['EDGE_MIRROR_PILOT', '0'], ['EDGE_GUEST_SALES_ONLY', '0'], ['EDGE_MIRROR_PILOT', undefined], ['EDGE_GUEST_SALES_ONLY', undefined]] as const) {
      const final = { ...fresh, [k]: v };
      if (v === undefined) delete (final as Record<string, unknown>)[k];
      expect(mirrorSettingsProblem({ realCopy: true, finalSettings: final })).toMatch(new RegExp(`would not say ${k}=1\\. Nothing was written\\.`));
    }
    expect(mirrorSettingsProblem({ realCopy: true, finalSettings: { ...fresh, EDGE_MIRROR_PILOT: '0', EDGE_GUEST_SALES_ONLY: '0' } }))
      .toMatch(/would not say EDGE_MIRROR_PILOT=1 and EDGE_GUEST_SALES_ONLY=1\. Nothing was written\. If till\.env says otherwise, it was changed by hand: run the install again with --force/);
  });

  it('the installer itself: a hand-changed real till.env is refused and left exactly as it was; --force writes both', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sre-mirror-install-'));
    const settings = join(dir, '.env.real');
    writeFileSync(settings, Object.entries(REAL).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
    const till = join(dir, 'till');
    mkdirSync(till, { recursive: true });
    const handChanged = renderTillEnv({ ...plan({ installDir: till }).settings, EDGE_MIRROR_PILOT: '0' });
    writeFileSync(join(till, 'till.env'), handChanged);
    const run = (extra: string[] = []) => spawnSync(process.execPath, ['scripts/install-till.mjs', '--lane', 'lane-1', '--settings', settings, '--dir', till, '--skip-build', ...extra], { encoding: 'utf8' });
    const refused = run();
    expect(refused.status, refused.stderr).toBe(78);
    expect(refused.stderr).toMatch(/✕ this is the store computer's real copy, which runs the mirror pilot with guest sales only \(OB-248, OB-252\), but the till's settings would not say EDGE_MIRROR_PILOT=1\. Nothing was written\./);
    expect(readFileSync(join(till, 'till.env'), 'utf8')).toBe(handChanged);
    const forced = run(['--force']);
    expect(forced.status, forced.stderr).toBe(0);
    expect(parseEnv(readFileSync(join(till, 'till.env'), 'utf8'))).toMatchObject({ EDGE_MIRROR_PILOT: '1', EDGE_GUEST_SALES_ONLY: '1' });
  }, 60_000);
});
