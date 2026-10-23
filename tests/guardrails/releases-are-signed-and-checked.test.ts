import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * WF-20 · AID-08 "sign releases" guardrail (OB-288 P5). The automatic build self-tests the signing tool on every run and
 * signs each merged commit with the custodian's key (never a key in the repository); the box's release script checks a
 * signature BEFORE its backup or anything else when it holds the public key, and says out loud when it does not. This
 * fails if a step is removed, if the private key is ever named outside the CI secret, or if the box's check is weakened.
 */

const CI = readFileSync('.github/workflows/ci.yml', 'utf8');
const RELEASE = readFileSync('infra/deploy/release.sh', 'utf8');
const SIGNER = readFileSync('scripts/release-signing.mjs', 'utf8');
const job = (name: string): string => {
  const start = CI.indexOf(`\n  ${name}:\n`);
  const next = CI.slice(start + 1).search(/\n {2}[a-z][a-z-]*:\n/);
  return next < 0 ? CI.slice(start) : CI.slice(start, start + 1 + next);
};

describe('releases are signed in the build and checked on the box (WF-20 · AID-08)', () => {
  const scans = job('security-scans');

  it('the build self-tests the signer every run and signs a merged commit from the CI secret only', () => {
    expect(scans).toContain('node scripts/release-signing.mjs selftest "$GITHUB_SHA"');
    expect(scans).toContain('RELEASE_SIGNING_KEY: ${{ secrets.RELEASE_SIGNING_KEY }}');
    expect(scans).toContain('node scripts/release-signing.mjs sign "$GITHUB_SHA"');
    expect(scans).toContain("github.event_name == 'push' && github.ref == 'refs/heads/main'");
    expect(scans).toContain('NOT SIGNED');
    expect(scans).toContain('name: release-signature');
    // The private key appears nowhere else in the workflow.
    expect(CI.split('RELEASE_SIGNING_KEY').length - 1).toBe(scans.split('RELEASE_SIGNING_KEY').length - 1);
  });

  it('the signer reads its key from the environment only and never signs without one', () => {
    expect(SIGNER).toContain('process.env.RELEASE_SIGNING_KEY');
    expect(SIGNER).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
    expect(SIGNER).toContain("asymmetricKeyType !== 'ed25519'");
    expect(SIGNER).toContain('process.exit(2)');
  });

  it('the box checks the signature with openssl over a manifest it builds itself, before the backup, and refuses with 77', () => {
    const check = RELEASE.indexOf('if [ -n "$SRE_RELEASE_PUBKEY" ]; then');
    expect(check).toBeGreaterThan(RELEASE.indexOf('is-ancestor'));
    expect(check).toBeLessThan(RELEASE.indexOf('taking the pre-release backup'));
    expect(RELEASE).toContain('git rev-parse "$SHA^{tree}"');
    expect(RELEASE).toContain("printf 'sre-release-v1\\ncommit=%s\\ntree=%s\\n'");
    expect(RELEASE).toContain('openssl pkeyutl -verify -pubin -inkey "$SRE_RELEASE_PUBKEY" -rawin');
    expect(RELEASE).toContain('record unsigned_refused');
    expect(RELEASE).toContain('record signature_refused');
    expect(RELEASE.match(/exit 77/g)?.length).toBe(2);
    expect(RELEASE).toContain('release signature NOT CHECKED on this box');
  });
});
