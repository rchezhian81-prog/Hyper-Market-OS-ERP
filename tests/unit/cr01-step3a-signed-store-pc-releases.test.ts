import { describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  UPDATE_KIND, checkUpdate, compareVersions, isReleaseVersion, releaseTag, releaseVersion, sha256Of, signUpdate, updateManifest, updateRecord, verifyUpdate,
} from '../../scripts/lib/store-pc-update.mjs';
// @ts-expect-error — plain .mjs script module.
import { main } from '../../scripts/store-pc-release.mjs';
// @ts-expect-error — plain .mjs script module.
import { releasePublicKey } from '../../scripts/build-store-pc-release.mjs';

/**
 * **CR-01 step 3a · OI-05 · OB-717 "A": every merge to main publishes a SIGNED store PC release.**
 *
 *   CI publishes the exact SRE-Setup.exe that ran on a clean Windows machine as a GitHub Release, beside update.json —
 *   its version (1.0.<run number>), commit and SHA-256, signed with the release signing key (OB-342). The store PC checks
 *   the signature with the public key that came with the release it already runs, and the file's fingerprint against
 *   the signed one; anything unsigned, unverifiable, altered or not newer is refused in plain words. With no signing key
 *   the release is published NOT SIGNED, and a store PC refuses it — never a made-up key.
 */

const keys = () => {
  const k = generateKeyPairSync('ed25519');
  return { priv: k.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, pub: k.publicKey.export({ type: 'spki', format: 'pem' }) as string };
};
const COMMIT = 'a'.repeat(40);
const SETUP = Buffer.from('pretend SRE-Setup.exe bytes');
const fields = (over: Record<string, string> = {}) => ({ version: '1.0.42', commit: COMMIT, sha256: sha256Of(SETUP), ...over });

describe('release versions only grow', () => {
  it('a merge to main is 1.0.<run number>; a test build is not a release', () => {
    expect(releaseVersion(1234)).toBe('1.0.1234');
    expect(releaseTag('1.0.1234')).toBe('store-pc-v1.0.1234');
    expect(isReleaseVersion('1.0.7')).toBe(true);
    for (const v of ['0.0.0-ci.12', '1.0.0', '1.0.07', '2.0.1', '1.0.1 ', undefined]) expect(isReleaseVersion(v)).toBe(false);
    for (const bad of ['0', '-3', 'x', '1.5']) expect(() => releaseVersion(bad)).toThrow();
  });

  it('compares by run number, not as text', () => {
    expect(compareVersions('1.0.10', '1.0.9')).toBe(1);
    expect(compareVersions('1.0.9', '1.0.10')).toBe(-1);
    expect(compareVersions('1.0.9', '1.0.9')).toBe(0);
  });
});

describe('the signature covers version, commit and fingerprint', () => {
  it('signs the four lines and verifies only with the right key and the same lines', () => {
    const a = keys();
    const b = keys();
    expect(updateManifest(fields())).toBe(`${UPDATE_KIND}\nversion=1.0.42\ncommit=${COMMIT}\nsha256=${sha256Of(SETUP)}\n`);
    const sig = signUpdate(fields(), a.priv);
    expect(verifyUpdate(fields(), a.pub, sig)).toBe(true);
    expect(verifyUpdate(fields(), b.pub, sig)).toBe(false);
    expect(verifyUpdate(fields({ version: '1.0.43' }), a.pub, sig)).toBe(false);
    expect(verifyUpdate(fields({ commit: 'b'.repeat(40) }), a.pub, sig)).toBe(false);
    expect(verifyUpdate(fields({ sha256: sha256Of(Buffer.from('other')) }), a.pub, sig)).toBe(false);
    expect(verifyUpdate(fields(), a.pub, 'not a signature')).toBe(false);
    expect(verifyUpdate(fields(), 'not a key', sig)).toBe(false);
  });

  it('refuses to sign with anything but an Ed25519 key, and refuses malformed fields', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    expect(() => signUpdate(fields(), rsa)).toThrow(/Ed25519/);
    expect(() => updateManifest(fields({ commit: 'abc' }))).toThrow();
    expect(() => updateManifest(fields({ sha256: 'z'.repeat(64) }))).toThrow();
    expect(() => updateRecord({ ...fields(), signature: 'nonsense' })).toThrow();
  });
});

describe("the store PC's check — any doubt is a refusal", () => {
  const a = keys();
  const signed = () => updateRecord({ ...fields(), signature: signUpdate(fields(), a.priv) });

  it('accepts a signed, verifying, newer release whose file is the signed one', () => {
    expect(checkUpdate({ record: signed(), setupBytes: SETUP, publicKeyPem: a.pub, runningVersion: '1.0.41' })).toEqual({ ok: true, version: '1.0.42' });
    // A PC still on a test build (0.0.0-ci.N) may take any signed release.
    expect(checkUpdate({ record: signed(), setupBytes: SETUP, publicKeyPem: a.pub, runningVersion: '0.0.0-ci.9' }).ok).toBe(true);
  });

  it.each([
    ['NOT SIGNED', () => ({ record: updateRecord({ ...fields(), signature: null }), setupBytes: SETUP, publicKeyPem: a.pub, runningVersion: '1.0.41' }), /NOT SIGNED/],
    ['no public key on this PC', () => ({ record: signed(), setupBytes: SETUP, publicKeyPem: undefined, runningVersion: '1.0.41' }), /no release public key/],
    ['signed with another key', () => ({ record: signed(), setupBytes: SETUP, publicKeyPem: keys().pub, runningVersion: '1.0.41' }), /does not verify/],
    ['the file is not the signed one', () => ({ record: signed(), setupBytes: Buffer.from('tampered'), publicKeyPem: a.pub, runningVersion: '1.0.41' }), /not the file that was signed/],
    ['the same version', () => ({ record: signed(), setupBytes: SETUP, publicKeyPem: a.pub, runningVersion: '1.0.42' }), /not newer/],
    ['an older version', () => ({ record: signed(), setupBytes: SETUP, publicKeyPem: a.pub, runningVersion: '1.0.100' }), /not newer/],
    ['a record of another kind', () => ({ record: { ...signed(), kind: 'something-else' }, setupBytes: SETUP, publicKeyPem: a.pub, runningVersion: '1.0.41' }), /not one this PC understands/],
    ['a record with a changed version', () => ({ record: { ...signed(), version: '1.0.99' }, setupBytes: SETUP, publicKeyPem: a.pub, runningVersion: '1.0.41' }), /does not verify/],
  ])('refuses: %s', (_name, input, reason) => {
    const verdict = checkUpdate(input());
    expect(verdict.ok).toBe(false);
    expect(verdict).toHaveProperty('reason');
    expect((verdict as { reason: string }).reason).toMatch(reason);
  });
});

describe('the tool CI runs (scripts/store-pc-release.mjs)', () => {
  const io = (env: Record<string, string | undefined> = {}) => {
    const said: string[] = [];
    return { said, io: { env, out: (s: string) => said.push(s), err: (s: string) => said.push(s) } };
  };
  const dir = () => {
    const d = mkdtempSync(join(tmpdir(), 'cr01-3a-'));
    writeFileSync(join(d, 'SRE-Setup.exe'), SETUP);
    return d;
  };

  it('with no signing key: publishes NOT SIGNED (exit 2, signature null) — never a made-up key', () => {
    const d = dir();
    const { said, io: o } = io({});
    expect(main(['record', '--setup', join(d, 'SRE-Setup.exe'), '--version', '1.0.5', '--commit', COMMIT, '--out', join(d, 'update.json')], o)).toBe(2);
    const record = JSON.parse(readFileSync(join(d, 'update.json'), 'utf8'));
    expect(record).toEqual({ kind: UPDATE_KIND, version: '1.0.5', commit: COMMIT, sha256: sha256Of(SETUP), asset: 'SRE-Setup.exe', signature: null });
    expect(said.join('')).toMatch(/NOT SIGNED/);
  });

  it('with the key: signs, and the PC-side check accepts it — and refuses an altered file', () => {
    const d = dir();
    const k = keys();
    writeFileSync(join(d, 'release-signing.pub'), k.pub);
    const { said, io: o } = io({ RELEASE_SIGNING_KEY: k.priv });
    expect(main(['record', '--setup', join(d, 'SRE-Setup.exe'), '--version', '1.0.6', '--commit', COMMIT, '--out', join(d, 'update.json')], o)).toBe(0);
    expect(said.join('')).toMatch(/SIGNED — version 1\.0\.6/);
    expect(said.join('')).not.toContain('PRIVATE KEY');
    const check = ['check', '--setup', join(d, 'SRE-Setup.exe'), '--record', join(d, 'update.json'), '--public-key', join(d, 'release-signing.pub'), '--running', '1.0.5'];
    expect(main(check, io().io)).toBe(0);
    writeFileSync(join(d, 'SRE-Setup.exe'), 'tampered');
    const r = io();
    expect(main(check, r.io)).toBe(1);
    expect(r.said.join('')).toMatch(/REFUSED — the downloaded SRE-Setup\.exe is not the file that was signed/);
  });

  it('a key that cannot sign stops the job without printing the key', () => {
    const d = dir();
    const { said, io: o } = io({ RELEASE_SIGNING_KEY: ['-----BEGIN', ' PRIVATE', ' KEY-----\nnot really\n-----END', ' PRIVATE', ' KEY-----\n'].join('') });
    expect(main(['record', '--setup', join(d, 'SRE-Setup.exe'), '--version', '1.0.6', '--commit', COMMIT, '--out', join(d, 'update.json')], o)).toBe(1);
    expect(said.join('')).toMatch(/NOT SIGNED/);
    expect(said.join('')).not.toContain('not really');
  });

  it('prints the release version for a run number, and refuses bad usage', () => {
    const r = io();
    expect(main(['version', '77'], r.io)).toBe(0);
    expect(r.said.join('')).toBe('1.0.77\n');
    expect(main(['record'], io().io)).toBe(64);
    expect(main(['nonsense'], io().io)).toBe(64);
  });
});

describe('the release carries the public key the NEXT release is checked with', () => {
  it('includes infra/deploy/release-signing.pub when it is committed, and says so when it is not', () => {
    const root = mkdtempSync(join(tmpdir(), 'cr01-3a-root-'));
    expect(releasePublicKey(root)).toBeUndefined();
    mkdirSync(join(root, 'infra', 'deploy'), { recursive: true });
    writeFileSync(join(root, 'infra', 'deploy', 'release-signing.pub'), keys().pub);
    expect(releasePublicKey(root)).toBe(join(root, 'infra', 'deploy', 'release-signing.pub'));
  });
});

describe('CI publishes only from main, only after every suite, with the least permission', () => {
  const ci = readFileSync(join(__dirname, '..', '..', '.github', 'workflows', 'ci.yml'), 'utf8');
  /** One job's block: from "  <name>:" to the next top-level job. */
  const jobBlock = (name: string): string => {
    const at = ci.indexOf(`\n  ${name}:\n`);
    expect(at).toBeGreaterThan(-1);
    const rest = ci.slice(at + 1);
    const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
    return next === -1 ? rest : rest.slice(0, next + 1);
  };
  const job = jobBlock('store-pc-publish');

  it('runs only on a push to main, after the clean-Windows setup run and every other suite', () => {
    expect(job).toContain("    if: github.event_name == 'push' && github.ref == 'refs/heads/main'\n");
    const needs = /\n {4}needs: \[([^\]]+)\]/.exec(job)![1]!.split(',').map((n) => n.trim());
    for (const n of ['verify', 'integration', 'store-pc-windows', 'store-pc-setup', 'store-pc-first-run', 'security-scans', 'browser', 'performance', 'identity']) expect(needs).toContain(n);
  });

  it('only this job may write; the workflow default stays read-only', () => {
    expect(ci).toMatch(/\npermissions:\n {2}contents: read\n/);
    expect(job).toMatch(/\n {4}permissions:\n {6}contents: write\n/);
    expect(ci.split('contents: write').length - 1).toBe(1);
  });

  it('publishes the very setup program proven on Windows, signs with the custodian key, never replaces a release', () => {
    expect(job).toContain('name: store-pc-setup');
    expect(job).toContain('secrets.RELEASE_SIGNING_KEY');
    expect(job).toContain('already published — nothing replaced');
    expect(job).toContain('gh release create');
    expect(jobBlock('store-pc-setup')).toContain('scripts/store-pc-release.mjs version');
  });
});
