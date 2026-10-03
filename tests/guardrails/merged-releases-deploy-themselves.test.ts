import { describe, it, expect } from 'vitest';
import { readFileSync, statSync } from 'node:fs';

/**
 * **Merged releases deploy themselves — and only merged releases (Stage F slice 1 · §20 · AID-08 · hard rule #8).**
 *
 * The pipeline's `release` job and the on-box script are production code that runs unattended. This guardrail
 * pins the properties that make that safe: the job runs only for pushes to main, only after the three
 * verification jobs passed on the same commit, in the `demo` environment, queued never cancelled; it pins the
 * box's host key and never echoes the key; the script refuses anything but a 40-hex commit on origin/main,
 * rolls back, never tears volumes down and never traces; the key example is a forced command; the runbook
 * names every secret and records no server address.
 */

const CI = readFileSync('.github/workflows/ci.yml', 'utf8');
const SCRIPT = readFileSync('infra/deploy/release.sh', 'utf8');
const SCRIPT_CODE = SCRIPT.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
const KEYS = readFileSync('infra/deploy/authorized_keys.example', 'utf8');
const CONF = readFileSync('infra/deploy/deploy.conf.example', 'utf8');
const RUNBOOK = readFileSync('docs/runbooks/automatic-deployment.md', 'utf8');
const releaseJob = CI.slice(CI.indexOf('\n  release:\n'));

describe('the release job deploys only a merged, verified main commit', () => {
  it('exists, needs all three verification jobs, and runs only for a push to main', () => {
    expect(CI.indexOf('\n  release:\n')).toBeGreaterThan(0);
    expect(releaseJob).toMatch(/needs:\s*\[verify, integration, deploy\]/);
    expect(releaseJob).toMatch(/if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/);
    expect(releaseJob).toMatch(/environment: demo/);
  });

  it('queues rather than cancels, keeps read-only repository permissions, and deploys exactly the pushed SHA', () => {
    expect(releaseJob).toMatch(/group: deploy-demo/);
    expect(releaseJob).toMatch(/cancel-in-progress: false/);
    expect(CI).toMatch(/^permissions:\n\s+contents: read/m);
    expect(releaseJob).toContain('release "$GITHUB_SHA" "$GITHUB_ACTOR" "$GITHUB_RUN_ID"');
  });

  it('pins the host key, never asks, never echoes the key, and deploys nothing when the box is not configured', () => {
    expect(releaseJob).toContain('StrictHostKeyChecking=yes');
    expect(releaseJob).toContain('BatchMode=yes');
    expect(releaseJob).toContain('IdentitiesOnly=yes');
    expect(releaseJob).not.toMatch(/echo[^\n]*\$DEPLOY_SSH_KEY/);
    expect(releaseJob).not.toMatch(/set -x/);
    expect(releaseJob).toContain('configured=false');
    expect(releaseJob).toMatch(/if: steps\.box\.outputs\.configured == 'true'/);
    expect(releaseJob).toContain('rm -f "$HOME/.ssh/deploy_key"');
  });
});

describe('the on-box release script is the one thing the key can run, and it is careful', () => {
  it('is executable, strict, and accepts only a 40-hex commit that is on origin/<release branch>', () => {
    expect(statSync('infra/deploy/release.sh').mode & 0o111).not.toBe(0);
    expect(SCRIPT_CODE).toContain('set -euo pipefail');
    expect(SCRIPT_CODE).toContain('^[0-9a-f]{40}$');
    expect(SCRIPT_CODE).toContain('merge-base --is-ancestor');
    expect(SCRIPT_CODE).toContain('SSH_ORIGINAL_COMMAND');
  });

  it('waits for READY and the stand-up check, rolls back to the previous commit, records every attempt, and never tears down or traces', () => {
    expect(SCRIPT_CODE).toContain('/readyz');
    expect(SCRIPT_CODE).toContain('standup-check.mjs');
    expect(SCRIPT_CODE).toContain('SRE_FRONT_URL'); // the public front is checked too — the stand-up check sees loopback only
    expect(SCRIPT_CODE).toMatch(/compose restart "\$tool"/); // a tool that runs a mounted bundle is restarted on every release
    expect(CONF).toMatch(/^SRE_FRONT_URL=https:\/\/127\.0\.0\.1$/m);
    expect(SCRIPT_CODE).toContain('SRE_WEB_URL'); // after a tool restart the release waits for the web front before the stand-up check
    expect(SCRIPT_CODE).toContain('record deployed');
    expect(SCRIPT_CODE).toContain('record rolled_back');
    expect(SCRIPT_CODE).toContain('record rollback_failed');
    expect(SCRIPT_CODE).toContain("result=%s sha=%s previous=%s by=%s run=%s");
    expect(SCRIPT_CODE).toContain('flock -n');
    expect(SCRIPT_CODE).not.toContain('down -v');
    expect(SCRIPT_CODE).not.toMatch(/^\s*set -x/m);
    expect(SCRIPT_CODE).not.toMatch(/cat[^\n]*\.env/); // it hands the env file's PATH on, never its contents
  });

  it('the authorized_keys example is a forced command with every forwarding switched off; no private key anywhere', () => {
    expect(KEYS).toMatch(/^command="\/opt\/sre\/app\/infra\/deploy\/release\.sh",restrict,no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ssh-ed25519 REPLACE_WITH_THE_PUBLIC_KEY/m);
    for (const f of [KEYS, CONF, RUNBOOK, SCRIPT]) expect(f).not.toContain('PRIVATE KEY');
  });
});

describe('the runbook names the human steps and records no address or secret', () => {
  it('names every pipeline secret, the forced command and the rollback, and holds no server address', () => {
    for (const s of ['DEPLOY_HOST', 'DEPLOY_USER', 'DEPLOY_PORT', 'DEPLOY_SSH_KEY', 'DEPLOY_HOST_KEY']) expect(RUNBOOK).toContain(s);
    expect(RUNBOOK).toContain('authorized_keys');
    expect(RUNBOOK).toContain('ssh-keyscan');
    expect(RUNBOOK.toLowerCase()).toContain('rolls back');
    expect(RUNBOOK).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    expect(CONF).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b(?<!127\.0\.0\.1)/);
  });
});
