import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTillPinCommand } from '../../edge/store-edge/src/till-pin-command';
import { loadTillCredentials } from '../../edge/store-edge/src/till-operators';
import { tillPinKey, tillPinMatches } from '../../packages/identity/src/till-pin';
import { testPin } from '../support/till-operator';

/**
 * **A till PIN is set on the store computer itself (ADR-0020 §2 · hard rules #2 #4).**
 *
 * The old way — the command makes the PIN and shows it once — is kept only behind `--generate-and-show`, with a warning
 * (the default, where the person types their own, is tests/unit/till-pin-the-person-types-their-own.test.ts). Either way
 * only the verifier is kept — appended, owner-only. Reissuing replaces, revoking ends, and nothing is ever edited in place.
 */

const BOX_KEY = ['till', 'pin', 'command', 'key'].join('-').padEnd(48, '0');
const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
const box = async () => { const d = await mkdtemp(join(tmpdir(), 'sre-till-pin-cmd-')); dirs.push(d); return { EDGE_DATA_DIR: d, PACK_SIGNING_KEY: BOX_KEY }; };

describe('till-pin, on the store computer', () => {
  it('--generate-and-show: warns first, prints the PIN once, keeps only its verifier, owner-only — and the box then matches it', async () => {
    const env = await box();
    const pin = testPin(7);
    const out = await runTillPinCommand(['--user', 'u-meena', '--by', 'Store admin', '--generate-and-show'], env, { now: () => '2026-10-06T08:00:00.000Z', newPin: () => pin });
    expect(out.ok).toBe(true);
    expect(out.lines[0]).toMatch(/^WARNING: --generate-and-show puts the new PIN on this screen/);
    expect(out.lines[1]).toBe(`Till PIN for u-meena: ${pin}`);
    expect(out.lines.join(' ')).toMatch(/not stored anywhere/);
    const file = join(env.EDGE_DATA_DIR, 'till-credentials.json');
    const raw = await readFile(file, 'utf8');
    expect(raw).not.toContain(pin);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const credential = (await loadTillCredentials(file)).get('u-meena')!;
    expect(credential).toMatchObject({ userId: 'u-meena', issuedBy: 'Store admin', issuedAt: '2026-10-06T08:00:00.000Z' });
    expect(tillPinMatches(pin, credential, tillPinKey(BOX_KEY))).toBe(true);
  });

  it('reissue replaces (the old PIN stops working), revoke ends — each an appended entry, never an edit', async () => {
    const env = await box();
    const first = testPin(8);
    const second = testPin(9);
    await runTillPinCommand(['--user', 'u-meena', '--by', 'Store admin', '--generate-and-show'], env, { newPin: () => first });
    await runTillPinCommand(['--user', 'u-meena', '--by', 'Store admin', '--generate-and-show'], env, { newPin: () => second });
    const file = join(env.EDGE_DATA_DIR, 'till-credentials.json');
    const key = tillPinKey(BOX_KEY);
    const current = (await loadTillCredentials(file)).get('u-meena')!;
    expect(tillPinMatches(first, current, key)).toBe(false);
    expect(tillPinMatches(second, current, key)).toBe(true);

    const revoked = await runTillPinCommand(['--user', 'u-meena', '--by', 'Store admin', '--revoke'], env);
    expect(revoked).toMatchObject({ ok: true, lines: [expect.stringMatching(/revoked by Store admin/)] });
    expect(revoked.pin).toBeUndefined();
    expect(tillPinMatches(second, (await loadTillCredentials(file)).get('u-meena')!, key)).toBe(false);
    const entries = (JSON.parse(await readFile(file, 'utf8')) as { credentials: unknown[] }).credentials;
    expect(entries).toHaveLength(3);
  });

  it('says how to use it, and refuses to run without the box\'s settings or a named issuer', async () => {
    const env = await box();
    expect(await runTillPinCommand(['--user', 'u-meena'], env)).toMatchObject({ ok: false, lines: [expect.stringMatching(/Usage: till-pin/)] });
    expect(await runTillPinCommand(['--user', 'u-meena', '--by', 'Store admin'], { EDGE_DATA_DIR: env.EDGE_DATA_DIR })).toMatchObject({ ok: false, lines: [expect.stringMatching(/store computer/)] });
    expect(await runTillPinCommand(['--user', 'u-meena', '--by', 'Store admin', '--revoke', '--generate-and-show'], env)).toMatchObject({ ok: false, lines: [expect.stringMatching(/Usage: till-pin/)] });
  });
});
