// The timed ROLLBACK DRILL (pilot gate G9) on the store PC's WINDOWS SERVICES — CR-01 step 3e (OI-05 "the rollback
// drill, G9, still passes" · ADR-0032 · OB-246 · OB-718 · roadmap §32 · P-04 · P-08 · hard rules #2 #6).
//
//   drill --by "<name>" --to <backup drive folder> [--previous <installed release folder>] [--run]
//   drill --continue <folder>     the second half, run by the task "SRE\Rollback drill" from the KEPT copy of this release
//   drill-result                  the newest drill record, in plain words
//
// The same drill as the Docker one (store-computer-recovery.mjs, `drill`), in the same order and against the same §32
// targets — the database back within 4 hours, the service back within 30 minutes — with Windows-services plumbing:
//
//   1. back up this copy onto the backup drive (encrypted, the hourly backup's own method);
//   2. restore that backup into a NEW scratch database and reconcile it (never into the real database);
//   3. ROLLBACK — the previous release's PROGRAM put back over the program folder (robocopy /MIR from its kept copy), its
//      own `setup` run (the services re-made, started, READY), and the PC's checks by that program (its version,
//      `services-status`, the till's screens); the database's steps must be unchanged by it;
//   4. ROLL FORWARD — always, once step 3 was tried: this release's program put back the same way, and checked;
//   5. each time against its target, and a NEW dated record (the records folder, and a read-only copy on the drive).
//
// The database is NEVER rolled back (hard rule #2; the drill's own rule: the previous release runs on the current
// database, allowed only when its database steps are the first steps of this release's). Nothing is ever deleted.
//
// Steps 1–2 run at the keyboard (the backup passphrase opens the backup for step 2). Steps 3–4 replace the program, and
// a program cannot replace the folder it runs from (the same reason as the updater's two halves, CR-01 step 3d): they
// run as their own task, as Windows (SYSTEM), from the KEPT copy of this release, and the person reads the outcome with
// `drill-result` (or the record file). The till pauses for a few minutes, so the drill refuses while any till shift is
// open (OB-718's rule for anything that restarts the services).
//
// "The previous release" is an INSTALLED release folder: by default the newest kept copy older than this release (the
// updater keeps one at every update, in …\SRE Retail OS kept\<version>), or one named with --previous.

import { pathFor, stampOf } from './store-computer.mjs';
import {
  STEP_TARGETS, backupFiles, dataFolderReady, drillVerdict, ensureBackupKey, folderRefusal, freshName, migrationProblems, migrationsOf, mins,
  parseTotals, psqlArgs, ready, recordBackupOutcome, runRestoreCheck, size, takeStoreBackup, totalsScript, unlockWithPassphrase, writeRecord,
} from './store-computer-recovery.mjs';
import { DRILL_TARGETS } from './rollback-drill.mjs';
import { dbSpawn } from './store-computer-db.mjs';
import { refusedOnServer } from './store-computer-windows.mjs';
import { SERVICES, serviceState } from './store-computer-services.mjs';
import { RELEASE_MARKER, releaseInfo } from './store-computer-setup.mjs';
import { tasksFor } from './store-computer-schedule.mjs';
import { compareVersions, isReleaseVersion } from './store-pc-update.mjs';
import { mirror, openShifts, stopServices, systemTaskXml, theChecks, updaterPaths, SETUP_WAIT_MS } from './store-pc-updater.mjs';

export const DRILL_TASK = 'SRE\\Rollback drill';
export const DRILL_DIR_PREFIX = 'drill-';
export const DRILL_STATE = 'drill.json';
export const DRILL_KIND = 'store-computer-rollback-drill';

const readJson = (fs, f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return undefined; } };
const ran = (r) => r !== undefined && r.error === undefined && r.status === 0;

/** An installed release folder's version, or undefined (release.json, its own Node and the tool must be there). */
export function installedVersion(deps, folder) {
  const p = pathFor(deps.platform);
  const P = updaterPaths(deps, { dataRoot: '', statusDir: '', runDir: '' });
  const v = readJson(deps.fs, p.join(folder, RELEASE_MARKER))?.version;
  if (!isReleaseVersion(v) || !deps.fs.existsSync(P.nodeOf(folder)) || !deps.fs.existsSync(P.toolOf(folder))) return undefined;
  return v;
}

/** The newest kept copy older than `current` (…\SRE Retail OS kept\<version>), or undefined. */
export function newestKeptBefore(deps, current) {
  const P = updaterPaths(deps, { dataRoot: '', statusDir: '', runDir: '' });
  if (!deps.fs.existsSync(P.keptRoot)) return undefined;
  const found = deps.fs.readdirSync(P.keptRoot).map(String)
    .filter((n) => isReleaseVersion(n) && compareVersions(n, current) < 0 && installedVersion(deps, P.keptOf(n)) === n)
    .sort((a, b) => compareVersions(b, a));
  return found.length === 0 ? undefined : P.keptOf(found[0]);
}

/** The checks before anything changes (dry run and real run). { problems, plan }. */
export function nativeDrillPlan(deps, ctx, opts) {
  const p = pathFor(deps.platform);
  const problems = [];
  const to = p.resolve(opts.to);
  const refusal = folderRefusal(deps, to);
  if (refusal !== undefined) problems.push(refusal);
  const current = releaseInfo(deps)?.version;
  if (!isReleaseVersion(current) || installedVersion(deps, deps.repoRoot) !== current) {
    problems.push(`${deps.repoRoot} is not an installed release (release.json with a version, its own Node, the tool) — run the drill from the installed program`);
    return { problems, plan: { to } };
  }
  const given = typeof opts.previous === 'string' && opts.previous.trim() !== '' ? p.resolve(opts.previous.trim()) : undefined;
  const previous = given ?? newestKeptBefore(deps, current);
  if (previous === undefined) {
    problems.push(`there is no previous release on this PC to go back to. One is kept by itself at every update from the Software update page (…\\${p.basename(updaterPaths(deps, ctx.L).keptRoot)}\\<version>); or name one with --previous <installed release folder>`);
    return { problems, plan: { to, current } };
  }
  const prevVersion = installedVersion(deps, previous);
  if (prevVersion === undefined) problems.push(`${previous} is not an installed release (release.json, runtime\\node\\node.exe and scripts\\store-computer.mjs must be there)`);
  else if (compareVersions(prevVersion, current) >= 0) problems.push(`${previous} holds version ${prevVersion}, which is not older than this release (${current}) — that rehearses nothing`);
  const before = migrationsOf(deps.fs, deps.platform, previous);
  const now = migrationsOf(deps.fs, deps.platform, deps.repoRoot);
  if (prevVersion !== undefined) problems.push(...migrationProblems(before, now));
  const migrations = { previous: Object.keys(before ?? {}).length, current: Object.keys(now ?? {}).length };
  return { problems, plan: { to, current, previous, previousVersion: prevVersion, migrations, newerMigrations: migrations.current - migrations.previous } };
}

/** The database's applied steps now (on the PC's own PostgreSQL), or undefined when it does not answer. */
function appliedNow(deps, ctx) {
  const r = dbSpawn(deps, ctx, 'psql', psqlArgs(ctx.user, ctx.database), { input: `${totalsScript()[3]}\n` });
  return ran(r) ? parseTotals(r.stdout ?? '').migrations : undefined;
}

/** `drill` on a Windows-services copy. Called by recovery's `drill` when the copy runs as services. */
export async function nativeDrill(deps, ctx, opts) {
  const { say, fs } = deps;
  const p = pathFor(deps.platform);
  if (opts.continue !== undefined) return continueDrill(deps, String(opts.continue));
  const by = typeof opts.by === 'string' ? opts.by.trim() : '';
  if (by === '' || typeof opts.to !== 'string' || opts.to.trim() === '') {
    say('REFUSED — the drill needs: --by "<your name>" and --to <your backup drive folder, for example E:\\sre-real>');
    say('  store-computer drill --by "Your Name" --to E:\\sre-real   (the previous release: the newest kept one, or --previous <folder>)');
    return 2;
  }
  if (deps.platform !== 'win32') { say('REFUSED — this drill is for the store computer (Windows 10 or 11).'); return 2; }
  if (refusedOnServer(deps)) return 2;
  const { problems, plan } = nativeDrillPlan(deps, ctx, opts);
  if (problems.length > 0) { for (const pr of problems) say(`REFUSED — ${pr}.`); say('  Nothing was changed.'); return 2; }
  const steps = [
    `1. back up this copy onto ${plan.to} (target: with step 2, inside 4 hours);`,
    '2. restore that backup into a new scratch database and reconcile it (never into the real database);',
    `3. put the previous release (${plan.previousVersion}, from ${plan.previous}) back over the program and run its own setup — on this copy's database, which is NOT rolled back (its ${plan.migrations.previous} steps are this release's first ${plan.migrations.previous}; the ${plan.newerMigrations} newer one(s) only add) — then check it (target 30 minutes);`,
    `4. put this release (${plan.current}) back the same way and check it again (target 30 minutes);`,
    '5. print each time against its target, and write a new dated record.',
  ];
  if (opts.run !== true) {
    say('DRY RUN — nothing will change. With --run the drill will, in order:');
    for (const s of steps) say(`  ${s}`);
    say('  Steps 3 and 4 restart the services: the till pauses for a few minutes. Close every till first, at a quiet time.');
    say('  Run it as administrator. When you are ready, run the same command with --run at the end.');
    return 0;
  }
  if (!dataFolderReady(deps, ctx)) return 2;
  const L = ctx.L;
  const P = updaterPaths(deps, L);
  for (const n of [SERVICES.database, SERVICES.api, SERVICES.till]) {
    if (serviceState(deps, n) !== 'running') { say(`REFUSED — the Windows service ${n} is not running. Restart the PC first; the drill starts from a working shop. Nothing was changed.`); return 2; }
  }
  // OB-718's rule: anything that restarts the services waits until every till is closed.
  const shifts = await openShifts(deps, L);
  if (shifts.unknown) { say('REFUSED — the till did not answer, so it is not known that every till shift is closed. Nothing was changed.'); return 2; }
  if (shifts.open.length > 0) { say(`REFUSED — a till shift is open (${shifts.open.join(', ')}). Close every till first. Nothing was changed.`); return 2; }
  const before = appliedNow(deps, ctx);
  const want = Object.keys(migrationsOf(fs, deps.platform, deps.repoRoot) ?? {});
  if (before === undefined || want.some((n) => !before.includes(n))) {
    say('REFUSED — this copy\'s database has not got every step of this release yet (or did not answer). Restart the PC and try again. Nothing was changed.');
    return 2;
  }

  // The backup is encrypted, and step 2 opens it: the passphrase is asked for now, before any step is timed.
  const key = await ensureBackupKey(deps, L);
  if (key === undefined) { say('REFUSED — the drill needs the backup passphrase. Nothing was changed.'); return 2; }
  const opened = await unlockWithPassphrase(deps, key, 'check the drill\'s backup');
  if (!opened.ok) { say(`REFUSED — ${opened.problem}. Nothing was changed.`); return 2; }

  const at = deps.now();
  const W = p.join(P.updatesDir, `${DRILL_DIR_PREFIX}${stampOf(at)}`);
  fs.mkdirSync(W, { recursive: true });
  const record = {
    kind: DRILL_KIND, version: 1, at: at.toISOString(), by, project: 'windows-services',
    computer: 'Windows (services, ADR-0032)',
    method: 'the previous release\'s program put back over the program folder and its own setup run, on this copy\'s current database — the database is not rolled back (its steps only add)',
    previousRelease: { folder: plan.previous, version: plan.previousVersion, migrations: plan.migrations.previous },
    currentRelease: { folder: deps.repoRoot, version: plan.current, migrations: plan.migrations.current },
    targets: { recoveryMs: DRILL_TARGETS.recoveryMs, rollbackMs: DRILL_TARGETS.rollbackMs, rollForwardMs: DRILL_TARGETS.rollForwardMs },
    appliedSteps: before.length,
    steps: [],
  };
  say(`Rollback drill (pilot gate G9) on this PC's Windows services, by ${by}: back to ${plan.previousVersion}, then forward to ${plan.current}.`);
  const b = await timed(deps, record, 'backup', 'backup onto the backup drive', () => {
    const r = takeStoreBackup(deps, ctx, plan.to, key);
    recordBackupOutcome(deps, L, { kind: 'drill', to: plan.to, ...r });
    record.backupManifest = r.manifestPath;
    return r.ok ? { ok: true, detail: `${r.manifest.backupId}, ${size(r.manifest.parts.database.sizeBytes + r.manifest.parts.files.sizeBytes + r.manifest.parts.settings.sizeBytes)}` } : { ok: false, detail: r.problem };
  });
  if (b.ok) {
    await timed(deps, record, 'restore', 'restore into a new scratch database and reconcile', () => {
      const r = runRestoreCheck(deps, ctx, backupFiles(deps.platform, record.backupManifest), opened.privateKey);
      record.restoreCheckRecord = r.recordPath;
      const fine = r.outcome === 'restored_and_reconciled' && r.dropped !== false;
      return { ok: fine, detail: fine ? 'restored_and_reconciled' : `${r.outcome}${r.differences.length > 0 ? `: ${r.differences.join('; ')}` : ''}${r.dropped === false ? '; the scratch database could not be removed' : ''}` };
    });
  }
  const recoveryFine = record.steps.length === 2 && record.steps.every((s) => s.ok);
  if (!recoveryFine) return finish(deps, ctx, plan.to, W, record);

  // This release, kept whole beside the program: the way forward again, and where the second half runs from.
  const keptNow = P.keptOf(plan.current);
  const m = mirror(deps, deps.repoRoot, keptNow);
  if (!m.ok || installedVersion(deps, keptNow) !== plan.current) {
    say(`NOT DONE — this release could not be kept beside the program (${m.ok ? 'the copy is not complete' : m.said}). Steps 3 and 4 did not run; nothing else was changed.`);
    record.steps.push({ key: 'rollback', title: 'keep this release before going back', ok: false, ms: 0, targetMs: STEP_TARGETS.rollback, withinTarget: true, detail: 'this release could not be kept' });
    return finish(deps, ctx, plan.to, W, record);
  }
  const state = { ...record, drill: { W, to: plan.to, app: deps.repoRoot, previous: plan.previous, previousVersion: plan.previousVersion, kept: keptNow, current: plan.current } };
  fs.writeFileSync(p.join(W, DRILL_STATE), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  const node = P.nodeOf(keptNow);
  const tool = P.toolOf(keptNow);
  if (/['"]/.test(`${node}${tool}${W}`)) { say('NOT DONE — a folder name has a quote mark in it, which a task cannot carry safely. Steps 3 and 4 did not run.'); return 1; }
  const root = String(deps.env.SystemRoot || deps.env.windir || 'C:\\Windows');
  const tasks = tasksFor(deps, L);
  const reg = tasks?.register(DRILL_TASK, systemTaskXml({
    description: `SRE Retail OS: the rollback drill's steps 3 and 4 (G9) — back to ${plan.previousVersion}, then forward to ${plan.current}. Made for one drill. CR-01 step 3e.`,
    command: p.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: `-NoProfile -NonInteractive -WindowStyle Hidden -Command "& '${node}' '${tool}' drill --continue '${W}'; exit $LASTEXITCODE"`,
    workingDir: keptNow, timeLimit: 'PT3H',
  }));
  const go = reg?.ok ? tasks.run?.(DRILL_TASK) : undefined;
  if (!reg?.ok || !go?.ok) {
    say(`NOT DONE — Windows did not start steps 3 and 4 (${reg?.said ?? go?.said ?? 'no task scheduler'}). Run this as administrator. Nothing else was changed.`);
    record.steps.push({ key: 'rollback', title: 'start steps 3 and 4', ok: false, ms: 0, targetMs: STEP_TARGETS.rollback, withinTarget: true, detail: 'Windows did not start the task' });
    return finish(deps, ctx, plan.to, W, record);
  }
  say(`STARTED — steps 3 and 4 run by themselves now, as the task "${DRILL_TASK}" (from ${keptNow}). The till pauses for a few minutes.`);
  say('  In about 10–15 minutes, see the outcome with:  store-computer drill-result');
  return 0;
}

/** Time one step and say it. */
async function timed(deps, record, key, title, fn) {
  const t0 = deps.now().getTime();
  let r;
  try { r = await fn(); } catch (e) { r = { ok: false, detail: e instanceof Error ? e.message : String(e) }; }
  const ms = deps.now().getTime() - t0;
  const step = { key, title, ok: r.ok === true, ms, targetMs: STEP_TARGETS[key], withinTarget: ms <= STEP_TARGETS[key], detail: r.detail };
  record.steps.push(step);
  deps.say(`  ${step.ok ? (step.withinTarget ? 'done' : 'SLOW') : 'FAILED'}  ${title} — ${mins(ms)} (target ${mins(STEP_TARGETS[key])})${r.detail === undefined ? '' : ` — ${r.detail}`}`);
  return { ...r, ms };
}

/** Put one installed release's program in place, run its own setup, check it. { ok, detail }. */
async function putInPlace(deps, ctx, from, app, version) {
  const L = ctx.L;
  const P = { ...updaterPaths(deps, L), app };
  await stopServices(deps);
  const m = mirror(deps, from, app);
  if (!m.ok) return { ok: false, detail: `${from} could not be put over ${app} (${m.said})` };
  const setup = deps.spawn(P.nodeOf(app), [P.toolOf(app), 'setup'], { cwd: app, env: deps.env, timeout: SETUP_WAIT_MS });
  if (!ran(setup)) return { ok: false, detail: `version ${version}'s own setup did not finish` };
  const failure = await theChecks(deps, L, P, version);
  return failure === undefined ? { ok: true } : { ok: false, detail: failure };
}

/** The second half (the task, as SYSTEM, from the kept copy): steps 3 and 4, then the record. */
async function continueDrill(deps, W) {
  const { say, fs } = deps;
  const p = pathFor(deps.platform);
  const state = readJson(fs, p.join(W, DRILL_STATE));
  if (state?.kind !== DRILL_KIND || state.drill === undefined) { say(`REFUSED — ${W} holds no drill to continue. Nothing was changed.`); return 2; }
  const ctx = ready(deps);
  if (ctx.code !== undefined) return ctx.code;
  const d = state.drill;
  const record = { ...state };
  delete record.drill;
  const shifts = await openShifts(deps, ctx.L);
  if (shifts.unknown || shifts.open.length > 0) {
    const why = shifts.unknown ? 'the till did not answer, so it is not known that every till shift is closed' : `a till shift was opened (${shifts.open.join(', ')})`;
    say(`NOT DONE — ${why}. Steps 3 and 4 did not run; nothing was changed.`);
    record.steps.push({ key: 'rollback', title: 'put the previous release back and check it', ok: false, ms: 0, targetMs: STEP_TARGETS.rollback, withinTarget: true, detail: `not started: ${why}` });
    return finish(deps, ctx, d.to, W, record);
  }
  const before = appliedNow(deps, ctx);
  await timed(deps, record, 'rollback', 'put the previous release back and check it', async () => {
    const r = await putInPlace(deps, ctx, d.previous, d.app, d.previousVersion);
    if (!r.ok) return r;
    const after = appliedNow(deps, ctx);
    if (before === undefined || after === undefined || after.length !== before.length) return { ok: false, detail: 'the database\'s steps changed (or it did not answer) — that is not a clean rollback' };
    return { ok: true, detail: `version ${d.previousVersion} runs on this copy's current database` };
  });
  // Forward again ALWAYS once the previous release was tried: the shop must end on this release.
  await timed(deps, record, 'rollForward', 'put this release back and check it', () => putInPlace(deps, ctx, d.kept, d.app, d.current));
  return finish(deps, ctx, d.to, W, record);
}

/** The verdict, said, and a new dated record — in the records folder and, read-only, on the backup drive. */
function finish(deps, ctx, to, W, record) {
  const { say, fs } = deps;
  const p = pathFor(deps.platform);
  const verdict = drillVerdict(record.steps);
  record.overall = verdict.passed ? 'G9 PASSED' : 'G9 NOT PASSED';
  record.finishedAt = deps.now().toISOString();
  const total = record.steps.reduce((a, s) => a + s.ms, 0);
  say(`  times    ${record.steps.map((s) => `${s.key} ${mins(s.ms)}`).join(' · ')} · total ${mins(total)}`);
  say(verdict.line);
  const forward = record.steps.find((s) => s.key === 'rollForward');
  if (forward !== undefined && !forward.ok) say(`  THIS PC MAY NOT BE ON ${record.currentRelease.version} NOW. A PERSON IS NEEDED: restart the PC; if the till does not come back, run SRE-Setup.exe of ${record.currentRelease.version} again, and send me a photo of this screen.`);
  fs.mkdirSync(ctx.L.records, { recursive: true });
  const recFile = freshName(deps, ctx.L.records, `g9-drill-${stampOf(new Date(record.at))}`, '.json');
  writeRecord(deps, recFile, record, false);
  try { fs.writeFileSync(p.join(W, 'record-path.txt'), `${recFile}\n`, 'utf8'); } catch { /* the record itself is written */ }
  say(`Record written: ${recFile}  (no secret is in it — keep it with the workbook)`);
  try {
    const onDrive = freshName(deps, to, `g9-drill-${stampOf(new Date(record.at))}`, '.json');
    writeRecord(deps, onDrive, record, true);
    say(`  A copy is on your backup drive: ${onDrive}`);
  } catch { say('  The copy for your backup drive could not be written. Copy the record above onto it by hand.'); }
  return verdict.passed ? 0 : 1;
}

/** `drill-result`: the newest drill record, in plain words. 0 passed · 1 not passed · 2 none, or still running. */
export function drillResult(deps, L) {
  const { say, fs } = deps;
  const p = pathFor(deps.platform);
  const files = fs.existsSync(L.records) ? fs.readdirSync(L.records).map(String).filter((f) => /^g9-drill-.*\.json$/.test(f)).sort() : [];
  const newest = files.length === 0 ? undefined : readJson(fs, p.join(L.records, files[files.length - 1]));
  const P = updaterPaths(deps, L);
  const running = fs.existsSync(P.updatesDir) ? fs.readdirSync(P.updatesDir).map(String).filter((f) => f.startsWith(DRILL_DIR_PREFIX)).sort().pop() : undefined;
  if (running !== undefined && !fs.existsSync(p.join(P.updatesDir, running, 'record-path.txt'))) {
    say(`STILL RUNNING — the drill started ${running.slice(DRILL_DIR_PREFIX.length)} has not finished yet. Ask again in a few minutes.`);
    return 2;
  }
  if (newest === undefined) { say('No rollback drill has been run on this PC yet.'); return 2; }
  say(`${newest.overall} — the drill of ${newest.at}, by ${newest.by}: back to ${newest.previousRelease?.version ?? newest.previousRelease?.releaseId}, then forward to ${newest.currentRelease?.version ?? newest.currentRelease?.releaseId}.`);
  for (const s of newest.steps ?? []) say(`  ${s.ok ? (s.withinTarget ? 'done' : 'SLOW') : 'FAILED'}  ${s.title} — ${mins(s.ms)} (target ${mins(s.targetMs)})${s.detail === undefined ? '' : ` — ${s.detail}`}`);
  return newest.overall === 'G9 PASSED' ? 0 : 1;
}
