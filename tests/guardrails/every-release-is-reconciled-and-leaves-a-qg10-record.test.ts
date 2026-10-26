import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * **QG-10 · WF-20: every release is reconciled, and leaves a QG-10 record (FG-3).** Roadmap §22 QG-10: "Health, smoke,
 * reconciliation, monitoring and rollback verified after every release." WF-20: "deploy/canary → smoke/reconcile →
 * monitor → rollback". This pins the properties that make the reconcile real and safe:
 *   • the before-snapshot is taken in phase 2 BEFORE anything is rebuilt, the after-snapshot only after verify and the
 *     bake, and a difference goes down the rollback path (exit 70, `rolled_back_on_reconcile`);
 *   • unreadable books before the release refuse it (69); the reconcile is on by default and "off" is said;
 *   • the snapshot reads the database from the migrate container's own environment — release.sh never names the
 *     database setting or reads the env file; the snapshot script opens a READ ONLY transaction and never prints the URL;
 *   • every outcome writes a QG-10 record, which is evidence and never a GO; CI copies it to the summary and artifacts
 *     for the canary and the demo stage alike; no server address is written anywhere.
 */

const SCRIPT = readFileSync('infra/deploy/release.sh', 'utf8');
const CODE = SCRIPT.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
const TOOL = readFileSync('scripts/release-reconcile.mjs', 'utf8');
const LIB = readFileSync('scripts/lib/release-reconcile.mjs', 'utf8');
const CI = readFileSync('.github/workflows/ci.yml', 'utf8');
const CONF = readFileSync('infra/deploy/deploy.conf.example', 'utf8');
const job = (name: string, next: string | undefined) => CI.slice(CI.indexOf(`\n  ${name}:\n`), next === undefined ? undefined : CI.indexOf(`\n  ${next}:\n`));

describe('the release script reconciles the books around every release', () => {
  it('snapshots before anything is rebuilt, compares only after verify and the bake, and rolls back on a difference', () => {
    const before = CODE.indexOf('reconcile_snapshot > "$RECON_DIR/before.json"');
    const firstUp = CODE.indexOf('if bring_up && verify && bake && reconcile_after; then');
    expect(before).toBeGreaterThan(0);
    expect(firstUp).toBeGreaterThan(before);
    expect(CODE.indexOf('reconcile_snapshot --upto "$upto"')).toBeGreaterThan(0);
    expect(CODE).toContain('record rolled_back_on_reconcile');
    expect(CODE).toContain('record reconcile_snapshot_failed');
    expect(CODE).toMatch(/exit 69\n/);
    expect(CODE).toContain(': "${SRE_RECONCILE:=on}"');
    expect(CODE).toContain('the post-deploy reconcile is SWITCHED OFF on this box');
  });

  it('never handles the database secret: the snapshot runs in the migrate container, read only, and never prints the URL', () => {
    expect(CODE).toContain('compose run --rm --no-deps -T -v "$SRE_APP_DIR/scripts:/app/scripts:ro" migrate node scripts/release-reconcile.mjs snapshot');
    expect(CODE).not.toMatch(/DATABASE_URL|PGPASSWORD|psql/);
    expect(CODE).not.toMatch(/(cat|source|\.)\s+[^\n]*\$SRE_ENV_FILE/);
    expect(TOOL).toContain("client.query('BEGIN READ ONLY')");
    expect(TOOL).not.toMatch(/(INSERT|UPDATE|DELETE)\s/);
    expect(TOOL).not.toMatch(/\$\{url\}|write\(url|log\(url|\(e\.message\)/);
    expect(LIB).not.toMatch(/import\s/); // pure: no I/O
  });

  it('every outcome writes a QG-10 record — evidence, never a GO', () => {
    for (const outcome of ['deployed', 'rolled_back_on_reconcile', 'rolled_back_in_canary_bake', 'rolled_back', 'rollback_failed', 'refused_books_unreadable']) {
      expect(CODE, outcome).toContain(`qg10_record ${outcome}`);
    }
    expect(LIB).toContain('Health, smoke, reconciliation, monitoring and rollback verified after every release.');
    expect(LIB).toContain('not decided here — this is evidence for the owner');
    expect(LIB).not.toMatch(/decision:\s*'GO'/);
    expect(CONF).toMatch(/^SRE_RECONCILE=on$/m);
    expect(CONF).toMatch(/^SRE_QG10_LOG=\/opt\/sre\/qg10-evidence\.jsonl$/m);
  });

  it('CI keeps the box\'s QG-10 line for the canary and the demo stage, says when there is none, and names no server', () => {
    for (const [name, next] of [['canary', 'release'], ['release', undefined]] as const) {
      const j = job(name, next);
      expect(j, name).toContain('| tee release-output.txt');
      expect(j, name).toContain('set -o pipefail');
      expect(j, name).toContain("grep '^release: QG-10 record: ' release-output.txt");
      expect(j, name).toContain('QG-10 is NOT evidenced for this release');
      expect(j, name).toMatch(/name: qg10-(canary|demo)-\$\{\{ github\.sha \}\}/);
      expect(j, name).toMatch(/if: always\(\) && steps\.box\.outputs\.configured == 'true'/);
    }
    // No server address in the repository: hosts come only from the environment's secrets.
    expect(CI).not.toMatch(/@\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
    expect(`${SCRIPT}${CONF}`).not.toMatch(/\b(?!127\.0\.0\.1)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
  });
});
