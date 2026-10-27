import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareSnapshots, parseSnapshot, qg10Record, snapshotProblem } from '../../scripts/lib/release-reconcile.mjs';

/**
 * **QG-10 · WF-20 "smoke/reconcile" — do the books after a release agree with the books before it?** (roadmap §22 QG-10:
 * "Health, smoke, reconciliation, monitoring and rollback verified after every release.") The pure comparison and the
 * per-release QG-10 evidence line that `infra/deploy/release.sh` writes; the release script itself is driven end to end
 * in `tests/integration/the-release-script-deploys-and-rolls-back.test.ts`, and the snapshot on real PostgreSQL in
 * `tests/integration/qg10-the-release-snapshot-reads-the-real-books-on-postgresql.test.ts`.
 */

const before = { version: 1 as const, at: 'x', ledger: { count: 10, maxSeq: 10, digest: 'd10', byFamily: { sales: 7, stock: 3 } }, outbox: { pending: 2, deadLetter: 1, oldestPendingSeconds: 30 } };
const agreeing = { ...before, ledger: { count: 14, maxSeq: 14, digest: 'd14', byFamily: { sales: 10, stock: 4 } }, upTo: { seq: 10, count: 10, digest: 'd10', byFamily: { sales: 7, stock: 3 } } };

describe('compareSnapshots — the books before and after a release', () => {
  it('agree when every earlier event is still there unchanged, with trading since; no new dead letter; the backlog no larger', () => {
    expect(compareSnapshots(before, agreeing)).toEqual({ ok: true, differences: [] });
  });

  it('a lost event, an altered one, a family that moved, a shrunk ledger — each a difference in words', () => {
    const lost = compareSnapshots(before, { ...agreeing, upTo: { seq: 10, count: 9, digest: 'other', byFamily: { sales: 6, stock: 3 } } });
    expect(lost.ok).toBe(false);
    expect(lost.differences).toEqual([
      'the ledger held 10 event(s) before the release and holds 9 of them now — some were LOST',
      'the events that were on the ledger before the release are not the same events now (their digest differs) — something was changed or replaced',
      'the "sales" ledger had 7 event(s) before the release and 6 of those now',
    ]);
    const shrunk = compareSnapshots(before, { ...agreeing, ledger: { ...agreeing.ledger, count: 8, maxSeq: 8 } });
    expect(shrunk.differences.join(' ')).toMatch(/the ledger shrank/);
    expect(compareSnapshots(before, { ...agreeing, upTo: undefined }).differences).toEqual(['the after-release snapshot does not re-read the ledger up to where it stood before the release']);
    expect(compareSnapshots(before, { ...agreeing, upTo: { ...agreeing.upTo, seq: 9 } }).differences[0]).toMatch(/up to sequence 9, not 10/);
  });

  it('a new dead letter, a dead letter gone, a grown backlog — differences; the box\'s allowance is honoured', () => {
    expect(compareSnapshots(before, { ...agreeing, outbox: { ...agreeing.outbox, deadLetter: 3 } }).differences).toEqual(['2 new dead letter(s) in the outbox since the release (from 1 to 3; allowed +0)']);
    expect(compareSnapshots(before, { ...agreeing, outbox: { ...agreeing.outbox, deadLetter: 0 } }).differences[0]).toMatch(/never deleted \(hard rule #6\)/);
    const grown = { ...agreeing, outbox: { ...agreeing.outbox, pending: 5 } };
    expect(compareSnapshots(before, grown).differences).toEqual(['the sync backlog grew by 3 (from 2 pending to 5; allowed +0)']);
    expect(compareSnapshots(before, grown, { maxBacklogGrowth: 3 }).ok).toBe(true);
  });

  it('a snapshot that cannot be read is a difference, never a pass (P-08)', () => {
    expect(compareSnapshots(undefined, agreeing)).toEqual({ ok: false, differences: ['the before-release snapshot cannot be trusted: it is not a snapshot at all'] });
    expect(compareSnapshots(before, { ...agreeing, outbox: { pending: -1, deadLetter: 0 } }).differences).toEqual(['the after-release snapshot cannot be trusted: its outbox figures cannot be read']);
    expect(snapshotProblem({ ...before, version: 2 })).toMatch(/version-1/);
    expect(parseSnapshot('not json')).toBeUndefined();
    expect(parseSnapshot(JSON.stringify(before))).toEqual(before);
  });
});

describe('qg10Record — one evidence line per release', () => {
  const base = { sha: 'a'.repeat(40), previous: 'b'.repeat(40), at: 't', by: 'octocat', run: '1', attempt: '1', box: 'demo', outcome: 'deployed' };
  it('verified only when health, smoke, reconciliation and monitoring are verified and rollback is ready (or was exercised and came back)', () => {
    const all = qg10Record({ ...base, checks: { health: 'verified', smoke: 'verified', reconciliation: 'verified', monitoring: 'verified', rollback: 'ready' } });
    expect(all).toMatchObject({ gate: 'QG-10', verified: true, notVerified: [], passCondition: 'Health, smoke, reconciliation, monitoring and rollback verified after every release.' });
    expect(all.decision).toMatch(/not decided here — this is evidence for the owner's QG-10 decision/);
    const noBake = qg10Record({ ...base, checks: { health: 'verified', smoke: 'verified', reconciliation: 'verified', monitoring: 'not_run_on_this_box', rollback: 'ready' } });
    expect(noBake).toMatchObject({ verified: false, notVerified: ['monitoring'] });
    const failedBack = qg10Record({ ...base, outcome: 'rollback_failed', checks: { health: 'failed', smoke: 'not_run', reconciliation: 'verified', monitoring: 'not_run', rollback: 'exercised_failed' } });
    expect(failedBack.notVerified).toEqual(['health', 'smoke', 'monitoring', 'rollback']);
    // An unknown state is "not run", never quietly accepted.
    expect(qg10Record({ ...base, checks: { health: 'GO!' } }).checks.health).toBe('not_run');
  });
});

describe('the release-reconcile command line', () => {
  const CLI = join(process.cwd(), 'scripts/release-reconcile.mjs');
  const run = (...args: string[]) => spawnSync('node', [CLI, ...args], { encoding: 'utf8', env: { ...process.env, DATABASE_URL: '' } });
  it('compare says RECONCILED or each DIFFERENCE (exit 1) and writes the result for the QG-10 line; qg10 prints the line; snapshot without a database refuses', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qg10-'));
    try {
      writeFileSync(join(dir, 'b.json'), JSON.stringify(before));
      writeFileSync(join(dir, 'a.json'), JSON.stringify(agreeing));
      writeFileSync(join(dir, 'bad.json'), JSON.stringify({ ...agreeing, outbox: { ...agreeing.outbox, deadLetter: 2 } }));
      const ok = run('compare', join(dir, 'b.json'), join(dir, 'a.json'));
      expect([ok.status, ok.stdout.trim()]).toEqual([0, 'RECONCILED — every event on the ledger before the release is still there, unchanged; no new dead letters; the sync backlog did not grow.']);
      const bad = run('compare', join(dir, 'b.json'), join(dir, 'bad.json'), '--json', join(dir, 'r.json'));
      expect(bad.status).toBe(1);
      expect(bad.stdout).toContain('DIFFERENCE — 1 new dead letter(s) in the outbox since the release');
      expect(run('max-seq', join(dir, 'b.json')).stdout.trim()).toBe('10');
      expect(run('max-seq', join(dir, 'nothing.json')).status).toBe(1);
      const line = run('qg10', '--sha', 'a'.repeat(40), '--previous', 'b'.repeat(40), '--by', 'octocat', '--run', '9', '--attempt', '2', '--box', 'demo', '--outcome', 'rolled_back_on_reconcile',
        '--health', 'verified', '--smoke', 'verified', '--reconciliation', 'failed', '--monitoring', 'verified', '--rollback', 'exercised_ok', '--differences', join(dir, 'r.json'));
      expect(line.status).toBe(0);
      const rec = JSON.parse(line.stdout) as { verified: boolean; differences: string[]; outcome: string; run: string; attempt: string };
      expect(rec).toMatchObject({ verified: false, outcome: 'rolled_back_on_reconcile', run: '9', attempt: '2' }); // OB-423 (a): the run and the attempt are in the line
      expect(rec.differences[0]).toMatch(/new dead letter/);
      expect(JSON.parse(readFileSync(join(dir, 'r.json'), 'utf8'))).toMatchObject({ ok: false });
      const snap = run('snapshot');
      expect(snap.status).toBe(1);
      expect(snap.stderr).toContain('DATABASE_URL is not set in this container');
      expect(run('nonsense').status).toBe(64);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
