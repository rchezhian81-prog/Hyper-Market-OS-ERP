import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { dataPointerPath, defaultDataRoot, fallbackDataRoot, main } from '../../scripts/lib/store-computer.mjs';
// @ts-expect-error — plain .mjs script module (till:pin), imported for its pure lookup.
import { tillEnvPathFor } from '../../scripts/till-pin.mjs';
import { loadConfig, CLOUD_API_CONFIG } from '../../services/kernel/src/config';
import { world } from '../support/store-computer-world';

/**
 * OB-283 — `prepare --data-drive <drive>` on a temporary "data drive": the settings are written in <drive>/SRE-data, the
 * place is recorded in the note, and then each LATER command — started fresh, knowing only the fall-back folder, as a new
 * PowerShell window would — finds the data there: `check` (running the REAL migration:slice refusals) writes its record
 * on the data drive, `status` writes the office screen's status file there, and till:pin's lookup and every other
 * script's `defaultDataRoot` name the same folder. Nothing lands in the fall-back folder. Docker is pretended; no real
 * data is read. (On Linux paths here; the Windows paths are driven in tests/unit/the-store-pc-keeps-its-data-on-f-and-is-never-the-server.test.ts.)
 */

describe('the store computer\'s data on the data drive — prepared there, and found there by every later command', () => {
  it('prepare --data-drive records the place; a fresh check and status use it; the fall-back folder stays empty', async () => {
    const w = world({}, { realNode: true });
    const drive = `${w.root}-drive-f`;
    mkdirSync(drive);
    const env = { SRE_DATA_POINTER: `${w.root}-programdata/SRE/data-folder.json` };
    const fresh = () => ({ ...w.deps, env, dataRoot: fallbackDataRoot(w.root, 'linux', env), dataPointer: dataPointerPath(w.root, 'linux', env) });

    expect(await main(['--', 'prepare', '--data-drive', drive], fresh())).toBe(0);
    const data = join(drive, 'SRE-data');
    expect(existsSync(join(data, '.env.real'))).toBe(true);
    expect(existsSync(join(data, 'THIS-IS-THE-SHOP-DATA-FOLDER.txt'))).toBe(true);
    expect(JSON.parse(readFileSync(env.SRE_DATA_POINTER, 'utf8'))).toMatchObject({ kind: 'sre-data-folder', dataRoot: data });
    // The API's own boot check accepts the settings written on the data drive.
    const text = readFileSync(join(data, '.env.real'), 'utf8');
    const settings = Object.fromEntries(text.split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    expect(loadConfig(CLOUD_API_CONFIG, settings).ok).toBe(true);

    // A new window: only the fall-back is known — the note decides.
    w.said.length = 0;
    expect(await main(['check', '--by', 'Integration test'], fresh())).toBe(1); // 3, 5 and 10 need a person
    const records = readdirSync(join(data, 'records'));
    expect(records).toHaveLength(1);
    const rec = JSON.parse(readFileSync(join(data, 'records', records[0]!), 'utf8')) as { results: { n: number; result: string }[] };
    expect(rec.results.find((r) => r.n === 7)?.result).toBe('PASS');
    expect(rec.results.find((r) => r.n === 8)?.result).toBe('PASS');
    await main(['status'], fresh());
    expect(existsSync(join(data, 'status', 'store-computer-status.json'))).toBe(true);

    // till:pin and every other script read the same note.
    expect(defaultDataRoot(w.root, 'linux', env)).toBe(data);
    expect(tillEnvPathFor({ repoRoot: w.root, platform: 'linux', env, exists: (p: string) => p === join(data, 'till', 'till.env') })).toBe(join(data, 'till', 'till.env'));
    // Nothing was made in the fall-back folder.
    expect(existsSync(fallbackDataRoot(w.root, 'linux', env))).toBe(false);
  }, 60_000);
});
