#!/usr/bin/env node
// CR-01 step 2c — on a clean Windows machine, after the first-run screens set a shop up as Windows services: the backup
// takes ONE consistent snapshot of the PC's own PostgreSQL (store-computer-db.mjs, nativeBackupScript), and the restore
// check opens it, restores it into a NEW scratch database, and reconciles every table, the money and the newest event.
// Then G4 checks 1 and 2 must PASS against the database service.
//
//   <release>\runtime\node\node.exe tests\windows\services-backup.drive.mjs <release folder> <backup folder>
//
// It drives the SHIPPED code in the release folder. The backup normally goes only to a USB drive and its passphrase is
// typed at the keyboard; here the same functions are called with a test folder and a synthetic test passphrase — the
// key, the snapshot, the encryption, the restore and the reconcile are the real ones.

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [release, backupDir] = process.argv.slice(2);
const say = (l) => { process.stdout.write(`${l}\n`); };
const fail = (why) => { say(`FAIL — ${why}`); process.exit(1); };
const lib = await import(pathToFileURL(join(release, 'scripts', 'lib', 'store-computer.mjs')).href);
const rec = await import(pathToFileURL(join(release, 'scripts', 'lib', 'store-computer-recovery.mjs')).href);

const base = lib.defaultDeps();
const found = lib.resolveDataFolder(base);
if (found.problem !== undefined) fail(found.problem);
const PASSPHRASE = 'synthetic passphrase for a throw-away test machine only';
const deps = { ...found.deps, askSecret: async () => PASSPHRASE, say };
const ctx = rec.ready(deps);
if (ctx.code !== undefined) fail('this copy is not ready');
if (ctx.native === undefined) fail('this copy does not run as Windows services (no services marker)');
say(`The database service: ${ctx.native.pgBin} on port ${ctx.native.port}.`);

const key = await rec.ensureBackupKey(deps, ctx.L);
if (key === undefined) fail('no backup key');
const b = rec.takeStoreBackup(deps, ctx, backupDir, key);
if (!b.ok) fail(`backup: ${b.problem}`);
const rows = Object.values(b.manifest.controlTotals?.rowCounts ?? {}).reduce((x, y) => x + y, 0);
say(`BACKUP DONE — ${b.manifest.backupId} (${rows} rows counted in the snapshot).`);

const u = await rec.unlockWithPassphrase(deps, key, 'check the test backup');
if (!u.ok) fail(`the backup key did not open: ${u.problem}`);
const r = rec.runRestoreCheck(deps, ctx, rec.backupFiles('win32', b.manifestPath), u.privateKey);
for (const d of r.differences ?? []) say(`  difference: ${d}`);
if (r.outcome !== 'restored_and_reconciled') fail(`the restore check said ${r.outcome}`);
say(`RESTORED AND RECONCILED — ${r.reconciled.tables} tables, ${r.reconciled.rows} rows, newest event ${r.reconciled.maxEventSeq}; scratch database ${r.dropped ? 'removed' : 'NOT removed'}.`);

const check = spawnSync(process.execPath, [join(release, 'scripts', 'store-computer.mjs'), 'check', '--by', 'CI test'], { cwd: release, env: process.env, encoding: 'utf8' });
const out = `${check.stdout ?? ''}`;
say(out.split(/\r?\n/).filter((l) => /^\s*(1|2)\s+\w/.test(l) || /^\s{10,}/.test(l)).slice(0, 4).join('\n'));
if (!/\n\s*1\s+PASS\s+Own project, own storage/.test(out)) fail('G4 check 1 did not PASS on the database service');
if (!/\n\s*2\s+PASS\s+Own database/.test(out)) fail('G4 check 2 did not PASS on the database service');
say('PASS — backup, restore check and G4 checks 1 and 2 work on the Windows services, with no Docker.');
