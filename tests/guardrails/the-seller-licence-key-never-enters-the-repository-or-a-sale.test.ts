import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';

/**
 * **CR-01 step 5 · OI-10 · OB-710 · hard rules 1 and 4: the seller's licence key never enters the repository, and a sale
 * never reads the licence.**
 *
 *   1. No committed file holds a private key in any form (plain or ENCRYPTED PKCS#8), the seller key's file name, its paper
 *      backup or the register of issued licences — the master key lives on the owner's USB drive and in the safe only.
 *   2. The seller's key in the repository, when there is one, is a PUBLIC key and nothing more.
 *   3. The licence is read only by the store PC's licence screen and gate, the setup screens and the store-computer tool:
 *      no till, sale, payment or app code imports it, so an expired (or any) licence can never stop a sale (hard rule 1,
 *      P-01) — expiry warns, gives grace, then reduces (OB-750), never in the middle of a sale.
 *   Each tripwire is shown to fire on a known-bad sample.
 */

const tracked = (): string[] => execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter((f) => f !== '');
const text = (f: string): string => { try { return readFileSync(f, 'utf8'); } catch { return ''; } };

/** A private key's header FOLLOWED BY its body (a sentence that only names the header, as an instruction does, is not one). */
const PRIVATE_KEY = /-----BEGIN (?:ENCRYPTED |RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----\s*\r?\n[A-Za-z0-9+/=]{40,}/;
const FORBIDDEN_NAME = /(?:^|\/)(?:sre-licence-seller-key\.pem|PAPER-BACKUP-[^/]*\.txt|issued-licences\.log)$/;
/** Where the licence may be read: the licence's own code, the store PC's screens and tool, and the tests. */
const MAY_READ_LICENCE = [
  /^scripts\/lib\/(?:licence|licence-desk|store-licence|store-computer-licence|store-computer|setup-app)\.(?:mjs|d\.mts|ts)$/,
  /^scripts\/(?:licence-desk\.mjs|setup-server\.ts)$/,
  /^edge\/store-edge\/src\/(?:main|licence-page|screen-server|update-page)\.ts$/,
  /^tests\//,
];
const IMPORTS_LICENCE = /from\s+['"][^'"]*(?:\/licence\.mjs|\/store-licence\.mjs|\/licence-page|\/licence-desk\.mjs|\/store-computer-licence\.mjs)['"]/;

describe('the seller\'s licence key never enters the repository', () => {
  it('no committed file holds a private key, the seller key\'s file, its paper backup or the issued register', () => {
    const files = tracked();
    const named = files.filter((f) => FORBIDDEN_NAME.test(f));
    const holding = files.filter((f) => !f.startsWith('tests/guardrails/') && /\.(?:pem|key|txt|json|pub|md|mjs|ts|js|yml|yaml|env|cfg|conf|iss)$/.test(f) && PRIVATE_KEY.test(text(f)));
    expect(named).toEqual([]);
    expect(holding).toEqual([]);
    // The tripwires fire.
    expect(FORBIDDEN_NAME.test('keys/sre-licence-seller-key.pem')).toBe(true);
    expect(FORBIDDEN_NAME.test('PAPER-BACKUP-abcd.txt')).toBe(true);
    // The samples are joined from pieces so that this file itself never holds a key's header (the secret scan reads it too).
    const header = (kind: string): string => ['-----BEGIN', `${kind}PRIVATE`, 'KEY-----'].join(' ').replace('  ', ' ');
    expect(PRIVATE_KEY.test(`${header('ENCRYPTED ')}\n${'MIGjMF8GCSqGSIb3DQEFDTBSMDEGCSqGSIb3DQEFDDAk'}`)).toBe(true);
    expect(PRIVATE_KEY.test(`from \`${header('')}\` to the end`)).toBe(false);
  });

  it('git ignores the seller key\'s file, its paper backup and the issued register, as a second lock', () => {
    const ignored = (f: string): boolean => { try { execFileSync('git', ['check-ignore', '-q', f]); return true; } catch { return false; } };
    expect(ignored('sre-licence-seller-key.pem')).toBe(true);
    expect(ignored('PAPER-BACKUP-0123456789abcdef.txt')).toBe(true);
    expect(ignored('issued-licences.log')).toBe(true);
    expect(ignored('infra/licence/licence-signing.pub')).toBe(false);
  });

  it('the committed seller key, when there is one, is a PUBLIC key only', () => {
    const p = 'infra/licence/licence-signing.pub';
    if (!existsSync(p)) return;
    const k = readFileSync(p, 'utf8');
    expect(k).toMatch(/^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+-----END PUBLIC KEY-----\n?$/);
    expect(k).not.toMatch(/PRIVATE/);
  });
});

describe('a sale never reads the licence', () => {
  it('only the licence screen and gate, the setup screens and the store-computer tool import the licence code', () => {
    const files = tracked().filter((f) => /\.(?:ts|mts|mjs|js)$/.test(f) && !f.endsWith('.d.mts'));
    const readers = files.filter((f) => IMPORTS_LICENCE.test(text(f)));
    const outside = readers.filter((f) => !MAY_READ_LICENCE.some((re) => re.test(f)));
    expect(outside).toEqual([]);
    expect(readers.some((f) => basename(f) === 'main.ts')).toBe(true);
    // The tripwire fires on a till file that reads it.
    const bad = "import { licenceNow } from '../../../scripts/lib/store-licence.mjs';";
    expect(IMPORTS_LICENCE.test(bad) && !MAY_READ_LICENCE.some((re) => re.test('apps/pos/src/sale.ts'))).toBe(true);
  });

  it('the till\'s own screens and its sale doors are never given the licence notice or a licence check', () => {
    const server = readFileSync('edge/store-edge/src/screen-server.ts', 'utf8');
    // The notice is drawn only for the office pages and the owner's phone.
    expect(server).toMatch(/licenceNotice\(.*\)/);
    expect(server).toMatch(/APP_SHELL\[route\.screen\]\.dir === 'web-erp' \|\| route\.screen === 'owner'\) \? licenceNotice/);
    const lane = ['edge/store-edge/src/lane-server.ts', 'packages/sale/src/index.ts'].filter((f) => existsSync(f)).map(text).join('\n');
    expect(lane).not.toMatch(/licen[cs]e/i);
  });
});
