// The timed rollback drill — pilot gate G9 (docs/runbooks/rollback-drill.md). IT runs it ON THE BOX; never from a
// developer machine, never against production. The logic and its refusals live in scripts/lib/rollback-drill.mjs.
//
// Usage (from the repository folder on the box):
//   DATABASE_URL=… RESTORE_TARGET_URL=… node scripts/rollback-drill.mjs \
//     --previous <40-hex commit> --current <40-hex commit> --project <compose project> \
//     --work <folder for the drill record> --backup-drive <the owner's backup drive folder> [--settings infra/compose/.env] [--run]
//
// Without --run it prints the plan and changes nothing. DATABASE_URL is the database the box runs on (backed up);
// RESTORE_TARGET_URL is an EMPTY database standing in for a replacement machine (the restore refuses one with tables).
// Both come from the environment, never the command line, so no credential lands in shell history.

import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { runRollbackDrill, drillProblems } from './lib/rollback-drill.mjs';
import { rehearseRecovery } from './lib/recovery-rehearsal.mjs';

const arg = (flag) => { const i = process.argv.indexOf(flag); return i === -1 ? undefined : process.argv[i + 1]; };
const has = (flag) => process.argv.includes(flag);

const envFile = resolve(arg('--settings') ?? join('infra', 'compose', '.env'));
const env = {};
if (existsSync(envFile)) {
  for (const raw of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || !line.includes('=')) continue;
    env[line.slice(0, line.indexOf('=')).trim()] = line.slice(line.indexOf('=') + 1).trim();
  }
}
const input = { previous: arg('--previous'), current: arg('--current'), project: arg('--project'), targetKind: env['MIGRATION_TARGET_KIND'] };
const workDir = arg('--work');
const backupDrive = arg('--backup-drive');
const apiUrl = (process.env['SRE_API_URL'] ?? `http://127.0.0.1:${env['API_PORT'] ?? '8081'}`).replace(/\/$/, '');
const problems = drillProblems(input);
if (workDir === undefined) problems.push('--work must name the folder the drill record is written to');
if (backupDrive === undefined) problems.push('--backup-drive must name the owner\'s backup drive folder');
if (has('--run') && (process.env['DATABASE_URL'] === undefined || process.env['RESTORE_TARGET_URL'] === undefined)) problems.push('DATABASE_URL and RESTORE_TARGET_URL must be set in the environment (never on the command line)');
if (problems.length > 0) {
  for (const p of problems) console.error(`REFUSED — ${p}`);
  process.exit(2);
}

if (!has('--run')) {
  console.log('DRY RUN — nothing will change. With --run the drill will, in order:');
  console.log(`  1. back up the database, copy it to ${backupDrive}, restore it into the EMPTY database in RESTORE_TARGET_URL and reconcile;`);
  console.log(`  2. put the previous release ${input.previous} back (infra/deploy/release.sh) and wait for ${apiUrl}/readyz;`);
  console.log(`  3. put the current release ${input.current} back and wait for READY again;`);
  console.log(`  4. print the times against the targets (rollback and roll forward 30 min each, recovery 4 h) and write the record to ${workDir}.`);
  process.exit(0);
}

const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });
const steps = {
  recovery: () => rehearseRecovery({ sourceUrl: process.env['DATABASE_URL'], targetUrl: process.env['RESTORE_TARGET_URL'], workDir, offsiteDir: backupDrive, log: (l) => console.log(l) }),
  deploy: async (sha) => {
    const r = spawnSync('bash', ['infra/deploy/release.sh', sha, 'rollback-drill', `drill-${Date.now()}`], { stdio: 'inherit', env: { ...process.env, SRE_COMPOSE_PROJECT: input.project } });
    return { ok: r.status === 0, code: r.status, ...(r.status === 0 ? {} : { detail: `release.sh ended ${r.status}` }) };
  },
  ready: async () => {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${apiUrl}/readyz`);
        if (res.ok && (await res.json())?.ready === true) return true;
      } catch { /* not up yet */ }
      await wait(2_000);
    }
    return false;
  },
};

const record = await runRollbackDrill({ ...input, steps, workDir, log: (l) => console.log(l) });
console.log(`  record   ${join(workDir, `${record.drillId}.json`)}`);
process.exit(record.outcome === 'passed' ? 0 : 1);
