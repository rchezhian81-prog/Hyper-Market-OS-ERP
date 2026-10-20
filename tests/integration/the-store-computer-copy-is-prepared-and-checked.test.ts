import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../../scripts/lib/store-computer.mjs';
import { loadConfig, CLOUD_API_CONFIG, STORE_EDGE_CONFIG } from '../../services/kernel/src/config';
// @ts-expect-error — plain .mjs operator script, imported for its settings reader (the one the stand-up check uses).
import { parseEnv } from '../../scripts/standup-check.mjs';
import { settingsOf, world } from '../support/store-computer-world';

/**
 * OB-240 · OB-244: `prepare` against a temporary repository folder writes a settings file that is well formed — the
 * API's and the store edge's own boot checks accept it as it stands — with five distinct secrets; and `check` runs the
 * REAL `migration:slice` refusal paths (checks 7 and 8) on empty temporary folders, leaving nothing behind. Docker is
 * pretended (none is needed here); no real data is read anywhere.
 */

const SECRETS = ['POSTGRES_PASSWORD', 'DATABASE_URL', 'PACK_SIGNING_KEY', 'BOX_HISTORY_SEAL_KEY', 'IDP_SIGNING_KEY'];

describe('the store computer\'s real-data copy — prepared and checked', () => {
  it('prepare writes a file the API and the store edge would boot on, with distinct secrets, never shown', async () => {
    const w = world();
    expect(await main(['--', 'prepare'], w.deps)).toBe(0);
    const text = readFileSync(join(w.root, 'infra', 'compose', '.env.real'), 'utf8');
    const s = settingsOf(w);
    // The same reading every other tool uses gives the same values.
    expect(parseEnv(text)).toEqual(s);
    // No placeholder survives in a value (the commented-out optional identity-server lines stay comments).
    expect(Object.entries(s).filter(([, v]) => v.includes('REPLACE_WITH'))).toEqual([]);
    // The API's own boot check accepts it; so does the store edge's.
    const api = loadConfig(CLOUD_API_CONFIG, s);
    expect(api.problems).toEqual([]);
    expect(api.ok).toBe(true);
    expect(loadConfig(STORE_EDGE_CONFIG, { ...s, EDGE_DATA_DIR: '/var/lib/sre-edge' }).ok).toBe(true);
    // The API also refuses a seal key equal to the pack or sign-in key; they are all distinct, and long.
    const secrets = SECRETS.map((k) => s[k]!);
    expect(new Set(secrets).size).toBe(5);
    for (const v of secrets) expect(v.length).toBeGreaterThanOrEqual(32);
    // DATABASE_URL is a valid URL built from the parts, as the application role (never the administrator).
    const url = new URL(s['DATABASE_URL']!);
    expect([url.protocol, url.username, url.password, url.hostname, url.port, url.pathname]).toEqual(['postgres:', s['APP_DB_USER'], s['POSTGRES_PASSWORD'], 'db', '5432', `/${s['POSTGRES_DB']}`]);
    expect(url.username).not.toBe(s['POSTGRES_USER']);
    for (const k of ['PACK_SIGNING_KEY', 'BOX_HISTORY_SEAL_KEY', 'IDP_SIGNING_KEY']) expect(encodeURIComponent(s[k]!)).toBe(s[k]);
    const said = w.said.join('\n');
    for (const v of secrets) expect(said.includes(v)).toBe(false);
  });

  it('check runs the real loader: REFUSED (demo_tenant) and REFUSED (production_target), on folders that are then gone', async () => {
    const w = world({}, { realNode: true });
    expect(await main(['prepare'], w.deps)).toBe(0);
    w.said.length = 0;
    expect(await main(['check', '--by', 'Integration test'], w.deps)).toBe(1); // 3, 5 and 10 need a person here
    const recDir = join(w.root, 'infra', 'compose', 'records');
    const files = readdirSync(recDir);
    expect(files).toHaveLength(1);
    const rec = JSON.parse(readFileSync(join(recDir, files[0]!), 'utf8')) as { results: { n: number; result: string; detail: string }[]; overall: string };
    expect(rec.results.find((r) => r.n === 7)).toMatchObject({ result: 'PASS', detail: expect.stringMatching(/REFUSED \(demo_tenant\)/) });
    expect(rec.results.find((r) => r.n === 8)).toMatchObject({ result: 'PASS', detail: expect.stringMatching(/REFUSED \(production_target\).*deleted/) });
    expect(rec.overall).toBe('G4 NOT PASSED');
    // The temporary folders and the temporary settings copy are gone; nothing was written beside the slice.json.
    for (const c of w.calls.filter((x) => x.args[0]?.includes('migration-slice'))) {
      expect(existsSync(c.args[c.args.indexOf('--dir') + 1]!)).toBe(false);
    }
    const copy = w.calls.filter((x) => x.args[0]?.includes('migration-slice'))[1]!;
    expect(existsSync(copy.args[copy.args.indexOf('--settings') + 1]!)).toBe(false);
    const s = settingsOf(w);
    const everything = [...w.said, readFileSync(join(recDir, files[0]!), 'utf8')].join('\n');
    for (const k of SECRETS) expect(everything.includes(s[k]!), k).toBe(false);
  }, 60_000);
});
