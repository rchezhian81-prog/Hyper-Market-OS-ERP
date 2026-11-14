// The timed rollback drill (pilot gate G9 · QG-08 · roadmap §32) ON WINDOWS SERVICES — CR-01 step 3e (OI-05 · ADR-0032 ·
// OB-246 · OB-718 · P-01 · P-04 · P-08 · hard rules #2 #4 #6 #7).
//
//   drill --by "<name>" [--to <backup drive folder>] [--previous <earlier version's folder>] [--run]
//                                the first half, typed by the administrator with the owner watching (UAT-53)
//   drill --legs <folder>        the second half, run by the task "SRE\Rollback drill" from the KEPT copy of the running
//                                version (as the updater's install half is). Never typed by a person.
//
// ── What it proves ─────────────────────────────────────────────────────────────────────────────────────────────────
// The same as the Docker drill (store-computer-recovery.mjs `drill`) and the Linux box's drill (rollback-drill.mjs): that
// the data can be restored from the backup drive, and that the PREVIOUS version can be put back and the current one put
// forward again, each timed against the roadmap's targets (§32: the database back within 4 hours, the service back within
// 30 minutes). On Windows services "putting a version back" is exactly what the updater does when an update fails
// (store-pc-updater.mjs `putBack`): the services stopped, the earlier version's folder put over the program folder, that
// version's own `setup` run (services re-made and started, the office READY), and the PC's checks run by that version.
// So a passing drill is also the proof the updater's way back works on this PC.
//
// ── In order — every step written down before the next one starts ──────────────────────────────────────────────────
//   First half (the person's window):
//     0. Refusals before anything: Windows, a store PC not a server, the shop's data folder, the services installed, the
//        Docker copy gone, the backup drive (the automatic backup's, or --to) a USB drive, an EARLIER version kept on
//        this PC (the updater keeps one before every update; or --previous), its database steps the first steps of this
//        version's (else going back is not safe — refused, never faked), every step applied to the shop's database.
//        Without --run it stops here and prints the plan (and how the last drill went).
//     1. No till shift open, by the till's own word (OB-718: the drill stops the till twice, as an update does).
//     2. BACKUP — encrypted, onto the backup drive (the hourly backup's own method).
//     3. RESTORE — that backup opened with the backup passphrase, restored into a NEW scratch database and reconciled to
//        the paisa; only the scratch database is removed afterwards. Never restored over the shop's database.
//     4. The running version is KEPT whole beside the program (…\SRE Retail OS kept\<version>), and checked.
//     5. The second half is handed to its own task, "SRE\Rollback drill", as Windows itself (SYSTEM), run from that kept
//        copy: Windows refuses to replace a program file that is running, so the half that swaps the program must not
//        run from the program folder.
//   Second half (the task):
//     6. No till shift open — asked once more, right before anything stops.
//     7. ROLLBACK — the previous version put back, its setup run, its checks passed, and the shop's database steps
//        unchanged (the previous version added none). Timed.
//     8. ROLL FORWARD — ALWAYS once the rollback was tried: the kept current version put back, its setup run, its checks
//        passed. Timed. If this fails, the page and the record say a person is needed now.
//     9. The verdict (G9 PASSED only when every step worked inside its target), a NEW dated record in the records folder
//        and a read-only copy on the backup drive, and — when every step worked — the body of POST /v1/platform/dr-drills
//        for the ROLLBACK rehearsal (the evidence the QG-08 gate reads, scored by head office against its 30 minutes).
//
// ── What is never touched ─────────────────────────────────────────────────────────────────────────────────────────
// The shop's database is never rolled back, restored over, copied over or deleted (hard rule #2): only the PROGRAM is
// swapped. No record, log, backup or kept copy is ever deleted (#6). No secret is ever said or written (#4): the backup
// passphrase is asked for, used and dropped. It never runs on a server or against production (#7: `ready` refuses a
// production settings file, as every store-computer command does).
//
// Node built-ins only; every program is started with an argument array and no shell; everything that touches Windows
// arrives in `deps`, so the tests drive it on a pretend Windows. The real-Windows run is CR-01 step 3f's CI job.

import { pathFor, resolveLayout, stampOf } from './store-computer.mjs';
import { dbSpawn } from './store-computer-db.mjs';
import {
  STEP_TARGETS, backupFiles, drillVerdict, ensureBackupKey, folderRefusal, freshName, migrationProblems, migrationsOf, mins,
  parseTotals, psqlArgs, ready, recordBackupOutcome, runRestoreCheck, size, takeStoreBackup, totalsScript, unlockWithPassphrase,
  writeRecord,
} from './store-computer-recovery.mjs';
import { DRILL_TARGETS } from './rollback-drill.mjs';
import { readSchedule } from './store-computer-status.mjs';
import { refusedOnServer } from './store-computer-windows.mjs';
import { dockerCopyState } from './store-computer-adopt.mjs';
import { SERVICES, serviceState } from './store-computer-services.mjs';
import { RELEASE_MARKER, releaseInfo } from './store-computer-setup.mjs';
import { tasksFor } from './store-computer-schedule.mjs';
import { compareVersions, isReleaseVersion } from './store-pc-update.mjs';
import { mirror, openShifts, stopServices, systemTaskXml, theChecks, updaterPaths } from './store-pc-updater.mjs';

// ── Names ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export const DRILL_TASK = 'SRE\\Rollback drill';
/** <data>\drills\: one folder per drill (its plan), and the append-only log of every drill's steps. */
export const DRILLS_DIR = 'drills';
export const DRILL_LOG = 'drill-outcomes.log';
/** <data>\status\drill-progress.json: the latest word, replaced whole (the dry run shows it). */
export const DRILL_PROGRESS = 'drill-progress.json';
export const DRILL_PROGRESS_KIND = 'sre-store-pc-drill-progress-v1';
export const DRILL_PLAN_KIND = 'sre-store-pc-drill-plan-v1';
export const DRILL_RECORD_KIND = 'store-computer-rollback-drill';
export const SETUP_WAIT_MS = 60 * 60_000;

const readJson = (fs, f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return undefined; } };
const ran = (r) => r !== undefined && r.error === undefined && r.status === 0;
const firstLine = (r) => String(`${r?.stderr ?? ''}\n${r?.stdout ?? ''}`).split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '') ?? (r?.error?.code ?? `it ended ${r?.status}`);

function drillPaths(deps, L) {
  const p = pathFor(deps.platform);
  return {
    dir: p.join(L.dataRoot, DRILLS_DIR),
    log: p.join(L.dataRoot, DRILLS_DIR, DRILL_LOG),
    progress: p.join(L.statusDir, DRILL_PROGRESS),
  };
}

/** Every step appended to <data>\drills\drill-outcomes.log (never rewritten); the latest word in status\drill-progress.json. */
function journal(deps, L, base) {
  const { fs } = deps;
  const D = drillPaths(deps, L);
  return {
    step(step, outcome, extra = {}) {
      fs.mkdirSync(D.dir, { recursive: true });
      fs.appendFileSync(D.log, `${JSON.stringify({ at: deps.now().toISOString(), ...base, step, outcome, ...extra })}\n`, 'utf8');
    },
    progress(state, said, extra = {}) {
      try {
        fs.mkdirSync(L.statusDir, { recursive: true });
        const tmp = `${D.progress}.tmp`;
        fs.writeFileSync(tmp, `${JSON.stringify({ kind: DRILL_PROGRESS_KIND, at: deps.now().toISOString(), ...base, state, said, ...extra }, null, 2)}\n`, 'utf8');
        fs.renameSync(tmp, D.progress);
      } catch { /* the log line is the record; the progress file is only a convenience */ }
    },
  };
}

// ── The earlier version ──────────────────────────────────────────────────────────────────────────────────────────────

/** A folder that holds a whole installed version: its release.json, its own node.exe and the store-computer tool. */
function versionIn(deps, P, folder) {
  const { fs } = deps;
  const p = pathFor(deps.platform);
  const rel = readJson(fs, p.join(folder, RELEASE_MARKER));
  if (!isReleaseVersion(rel?.version)) return undefined;
  if (!fs.existsSync(P.nodeOf(folder)) || !fs.existsSync(P.toolOf(folder))) return undefined;
  return rel.version;
}

/** The newest kept version older than the running one, or undefined. */
export function newestEarlierKept(deps, P, running) {
  const { fs } = deps;
  const p = pathFor(deps.platform);
  if (!fs.existsSync(P.keptRoot)) return undefined;
  const found = fs.readdirSync(P.keptRoot).map(String)
    .filter((name) => isReleaseVersion(name) && compareVersions(name, running) < 0)
    .map((name) => ({ folder: p.join(P.keptRoot, name), version: versionIn(deps, P, p.join(P.keptRoot, name)) }))
    .filter((v) => v.version !== undefined)
    .sort((a, b) => compareVersions(b.version, a.version));
  return found[0];
}

const sameOrInside = (platform, folder, root) => {
  const norm = (x) => (platform === 'win32' ? String(x).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase() : String(x).replace(/\/+$/, ''));
  const f = norm(folder);
  const r = norm(root);
  return f === r || f.startsWith(`${r}${platform === 'win32' ? '\\' : '/'}`);
};

/** The checks both the dry run and the real run make, before anything changes. { problems, plan }. */
export function nativeDrillPlan(deps, ctx, opts) {
  const { fs } = deps;
  const p = pathFor(deps.platform);
  const L = ctx.L;
  const P = updaterPaths(deps, L);
  const problems = [];
  const running = releaseInfo(deps)?.version;
  if (!isReleaseVersion(running) || !fs.existsSync(P.nodeOf(P.app))) problems.push(`${P.app} is not an installed version of the store computer (no release.json or no runtime\\node\\node.exe)`);
  if (serviceState(deps, SERVICES.database) === 'missing') problems.push('the shop\'s Windows services are not installed on this PC');
  const docker = dockerCopyState(deps, L, true);
  if (typeof docker === 'object') problems.push(docker.refuse);
  else if (docker !== 'none') problems.push('this shop still has its data in Docker — the move to Windows services must be finished first (run SRE-Setup.exe)');

  const to = typeof opts.to === 'string' && opts.to.trim() !== '' ? p.resolve(opts.to) : readSchedule(deps, L)?.to;
  if (to === undefined) problems.push('no backup drive: set up the automatic backup first, or name the backup drive\'s folder with --to (for example --to E:\\sre-real)');
  else {
    const refusal = folderRefusal(deps, to);
    if (refusal !== undefined) problems.push(refusal);
  }

  let previous;
  if (typeof opts.previous === 'string' && opts.previous.trim() !== '') {
    const folder = p.resolve(opts.previous);
    const version = versionIn(deps, P, folder);
    if (sameOrInside(deps.platform, folder, P.app)) problems.push(`--previous (${folder}) is the program's own folder, or inside it. Name an EARLIER version's folder, for example ${p.join(P.keptRoot, '1.0.2005')}.`);
    else if (version === undefined) problems.push(`there is no whole installed version in ${folder} (it needs release.json, runtime\\node\\node.exe and scripts\\store-computer.mjs)`);
    else previous = { folder, version };
  } else if (isReleaseVersion(running)) {
    previous = newestEarlierKept(deps, P, running);
    if (previous === undefined) problems.push(`no earlier version is kept on this PC yet (${P.keptRoot} holds none older than ${running}). The updater keeps the running version before every update, so after the first update there is one. Until then, name an earlier version's folder with --previous.`);
  }
  let migrations;
  if (previous !== undefined && isReleaseVersion(running)) {
    if (compareVersions(previous.version, running) >= 0) problems.push(`the version in ${previous.folder} is ${previous.version}, not earlier than the running ${running} — that rehearses nothing`);
    const before = migrationsOf(fs, deps.platform, previous.folder);
    const now = migrationsOf(fs, deps.platform, P.app);
    problems.push(...migrationProblems(before, now));
    migrations = { previous: Object.keys(before ?? {}).length, current: Object.keys(now ?? {}).length };
  }
  return { problems, plan: { app: P.app, running, previous, to, kept: isReleaseVersion(running) ? P.keptOf(running) : undefined, migrations } };
}

/** The shop database's applied steps (schema_migrations), on the PC's own PostgreSQL — or undefined when it does not answer. */
function appliedSteps(deps, ctx) {
  const r = dbSpawn(deps, ctx, 'psql', psqlArgs(ctx.user, ctx.database), { input: `${totalsScript().join('\n')}\n` });
  return ran(r) ? parseTotals(r.stdout ?? '').migrations : undefined;
}

// ── One timed step, as the Docker drill writes it ────────────────────────────────────────────────────────────────────

async function timedStep(deps, record, j, key, title, fn) {
  const t0 = deps.now().getTime();
  let r;
  try { r = await fn(); } catch (e) { r = { ok: false, detail: e instanceof Error ? e.message : String(e) }; }
  const ms = deps.now().getTime() - t0;
  const step = { key, title, ok: r.ok === true, ms, targetMs: STEP_TARGETS[key], withinTarget: ms <= STEP_TARGETS[key], ...(r.detail === undefined ? {} : { detail: r.detail }) };
  record.steps.push(step);
  j.step(key, step.ok ? 'done' : `FAILED: ${r.detail ?? ''}`, { ms });
  deps.say(`  ${step.ok ? (step.withinTarget ? 'done' : 'SLOW') : 'FAILED'}  ${title} — ${mins(ms)} (target ${mins(STEP_TARGETS[key])})${r.detail === undefined ? '' : ` — ${r.detail}`}`);
  return { ...r, ms };
}

/** The verdict, a NEW record in the records folder and on the backup drive, and the QG-08 rollback body when it ran. */
function finishRecord(deps, L, record, j, to) {
  const { say, fs } = deps;
  const verdict = drillVerdict(record.steps);
  record.overall = verdict.passed ? 'G9 PASSED' : 'G9 NOT PASSED';
  record.finishedAt = deps.now().toISOString();
  const total = record.steps.reduce((a, s) => a + s.ms, 0);
  if (record.steps.length > 0) say(`  times    ${record.steps.map((s) => `${s.key} ${mins(s.ms)}`).join(' · ')} · total ${mins(total)}`);
  say(verdict.line);
  fs.mkdirSync(L.records, { recursive: true });
  const at = new Date(record.at);
  const recFile = freshName(deps, L.records, `g9-drill-${stampOf(at)}`, '.json');
  writeRecord(deps, recFile, record, false);
  say(`Record written: ${recFile}  (no secret is in it — keep it with the workbook)`);
  let onDrive;
  if (to !== undefined) {
    try {
      onDrive = freshName(deps, to, `g9-drill-${stampOf(at)}`, '.json');
      writeRecord(deps, onDrive, record, true);
      say(`  A copy is on the backup drive: ${onDrive}`);
    } catch { onDrive = undefined; say('  The copy for the backup drive could not be written. Copy the record above onto it by hand.'); }
  }
  // W4 · QG-08: only a drill whose every step WORKED has a rollback time to score (an over-target one is scored a miss by
  // head office, never quietly a pass). The data loss is 0: the drill never touches the shop's database.
  const rollback = record.steps.find((s) => s.key === 'rollback');
  let evidence;
  if (rollback !== undefined && record.steps.every((s) => s.ok) && record.steps.some((s) => s.key === 'rollForward')) {
    evidence = freshName(deps, L.records, `g9-drill-${stampOf(at)}.qg08-rollback`, '.json');
    writeRecord(deps, evidence, { drillId: record.drillId, rehearsal: 'rollback', dataLossSeconds: 0, recoverySeconds: Math.ceil(rollback.ms / 1000) }, false);
    say(`  QG-08 evidence (the body of POST /v1/platform/dr-drills, for the custodian to record on head office's register): ${evidence}`);
  } else {
    say('  QG-08: NOT a rehearsal record — not every step worked, so there is no rollback time to score; record the miss (QG-08 stays HOLD).');
  }
  j.step('verdict', record.overall, { record: recFile, ...(onDrive === undefined ? {} : { onDrive }), ...(evidence === undefined ? {} : { evidence }) });
  return { verdict, recFile, evidence };
}

// ── The first half ───────────────────────────────────────────────────────────────────────────────────────────────────

/** `drill` on a store PC that runs as Windows services. 0 done / dry run · 1 not passed · 2 refused. */
export async function nativeDrill(deps, opts) {
  if (opts.legs !== undefined) return drillLegs(deps, opts.legs);
  const { say, fs } = deps;
  const p = pathFor(deps.platform);
  const by = typeof opts.by === 'string' ? opts.by.trim() : '';
  if (by === '') { say('REFUSED — the drill needs: --by "<your name>"'); say('  … store-computer.mjs drill --by "Your Name"   (a dry run; add --run to do it)'); return 2; }
  if (deps.platform !== 'win32') { say('REFUSED — the Windows-services drill is for the store computer (Windows 10 or 11).'); return 2; }
  if (refusedOnServer(deps)) return 2;
  const ctx = ready(deps);
  if (ctx.code !== undefined) return ctx.code;
  if (ctx.L.mode !== 'data-folder') { say('REFUSED — the drill needs the shop\'s data folder.'); return 2; }
  const L = ctx.L;
  const { problems, plan } = nativeDrillPlan(deps, ctx, opts);
  if (problems.length > 0) { for (const pr of problems) say(`REFUSED — ${pr}`); say('  Nothing was changed.'); return 2; }

  const steps = [
    `1. check that no till shift is open (the till stops twice, for a few minutes each);`,
    `2. back up this PC onto ${plan.to}, encrypted (target: with step 3, inside 4 hours);`,
    '3. restore that backup into a new scratch database and reconcile it (never into the shop\'s database);',
    `4. keep the running version ${plan.running} whole in ${plan.kept};`,
    `5. put version ${plan.previous.version} back from ${plan.previous.folder}: the services stop, its program goes in, its setup runs, its checks pass (the shop's database is not rolled back: its ${plan.migrations.previous} database steps are this version's first ${plan.migrations.previous}) — target 30 minutes;`,
    `6. put version ${plan.running} back the same way — target 30 minutes;`,
    '7. print each time against its target, and write a new dated record (and a copy on the backup drive).',
  ];
  if (opts.run !== true) {
    say('DRY RUN — nothing will change. With --run the drill will, in order:');
    for (const s of steps) say(`  ${s}`);
    say('  Steps 5 to 7 run by themselves as the task "SRE\\Rollback drill" (as Windows itself), after this window says STARTED.');
    say('  Do it when the shop is shut. When you are ready, run the same command with --run at the end.');
    const last = readJson(fs, drillPaths(deps, L).progress);
    if (last?.kind === DRILL_PROGRESS_KIND) say(`The last drill (${last.drillId}, ${last.at}): ${last.said}`);
    return 0;
  }

  // 1 — OB-718: no till shift open, by the till's own word.
  const shifts = await openShifts(deps, L);
  if (shifts.unknown) { say('REFUSED — the till did not answer, so it is not known that every till shift is closed. Nothing was changed.'); return 2; }
  if (shifts.open.length > 0) { say(`REFUSED — a till shift is open (${shifts.open.join(', ')}). Close every till first. Nothing was changed.`); return 2; }

  // Every step of this version must be on the shop's database, or "the previous version added nothing" proves nothing.
  const before = appliedSteps(deps, ctx);
  const want = Object.keys(migrationsOf(fs, deps.platform, plan.app) ?? {});
  if (before === undefined || want.some((n) => !before.includes(n))) {
    say('REFUSED — the shop\'s database has not got every step of this version (or did not answer). Run SRE-Setup.exe again first. Nothing was changed.');
    return 2;
  }

  // The passphrase is asked for now, before any step is timed; it opens the backup in step 3 and is then dropped.
  const key = await ensureBackupKey(deps, L);
  if (key === undefined) { say('REFUSED — the drill needs the backup passphrase. Nothing was changed.'); return 2; }
  const opened = await unlockWithPassphrase(deps, key, 'check the drill\'s backup');
  if (!opened.ok) { say(`REFUSED — ${opened.problem}. Nothing was changed.`); return 2; }

  const at = deps.now();
  const drillId = `g9-drill-${stampOf(at)}`;
  const W = freshName(deps, drillPaths(deps, L).dir, drillId, '');
  fs.mkdirSync(W, { recursive: true });
  const j = journal(deps, L, { drillId, by, from: plan.running, previous: plan.previous.version });
  const record = {
    kind: DRILL_RECORD_KIND, version: 2, drillId, at: at.toISOString(), by, computer: 'Windows', runsAs: 'Windows services (ADR-0032)',
    method: 'the earlier version\'s program put over the program folder and its own setup run, on the shop\'s current database — the database is not rolled back (database steps only add); then the running version put back the same way',
    previousRelease: { folder: plan.previous.folder, version: plan.previous.version, migrations: plan.migrations.previous },
    currentRelease: { folder: plan.app, version: plan.running, kept: plan.kept, migrations: plan.migrations.current },
    targets: { recoveryMs: DRILL_TARGETS.recoveryMs, rollbackMs: DRILL_TARGETS.rollbackMs, rollForwardMs: DRILL_TARGETS.rollForwardMs },
    steps: [],
  };
  j.step('start', 'started', { to: plan.to });
  j.progress('working', `The drill started at ${at.toISOString()} (by ${by}): backing up.`);
  say(`Rollback drill (pilot gate G9) on this store PC, by ${by}: back to ${plan.previous.version}, then forward to ${plan.running}.`);

  // 2 and 3 — the backup, and its restore into a scratch database.
  let manifestPath;
  const b = await timedStep(deps, record, j, 'backup', 'backup onto the backup drive, encrypted', () => {
    const r = takeStoreBackup(deps, ctx, plan.to, key);
    recordBackupOutcome(deps, L, { kind: 'drill', to: plan.to, ...r });
    manifestPath = r.manifestPath;
    return r.ok ? { ok: true, detail: `${r.manifest.file}, ${size(r.manifest.sizeBytes)}` } : { ok: false, detail: r.problem };
  });
  if (b.ok) {
    await timedStep(deps, record, j, 'restore', 'restore into a new scratch database and reconcile', () => {
      const r = runRestoreCheck(deps, ctx, backupFiles(deps.platform, manifestPath), opened.privateKey);
      record.restoreCheckRecord = r.recordPath;
      const fine = r.outcome === 'restored_and_reconciled' && r.dropped !== false;
      return { ok: fine, detail: fine ? 'restored_and_reconciled' : `${r.outcome}${r.differences.length > 0 ? `: ${r.differences.join('; ')}` : ''}${r.dropped === false ? '; the scratch database could not be removed' : ''}` };
    });
  }
  record.backupManifest = manifestPath;
  const stopHere = (why) => {
    say(`NOT GOING ON — ${why}. The services were not stopped; the program was not touched.`);
    const done = finishRecord(deps, L, record, j, plan.to);
    j.progress('finished', `${record.overall}: ${why}. Nothing else was touched. Record: ${done.recFile}`, { overall: record.overall, record: done.recFile });
    return 1;
  };
  if (!(record.steps.length === 2 && record.steps.every((s) => s.ok))) return stopHere('the backup did not restore and reconcile — do not rely on it');

  // 4 — The running version, kept whole beside the program: the way forward again, and where the second half runs from.
  const P = updaterPaths(deps, L);
  const m = mirror(deps, plan.app, plan.kept);
  const keptVersion = versionIn(deps, P, plan.kept);
  if (!m.ok || keptVersion !== plan.running) return stopHere(`the running version could not be kept beside the program (${m.ok ? 'the copy is not complete' : m.said})`);
  j.step('keep', 'running version kept', { kept: plan.kept });
  say(`KEPT — the running version ${plan.running} is copied to ${plan.kept}: it is the way forward again.`);

  // 5 — The second half, as its own task, from the kept copy.
  const legs = { kind: DRILL_PLAN_KIND, drillId, by, app: plan.app, running: plan.running, kept: plan.kept, previous: plan.previous, to: plan.to, stepsBefore: before, record };
  fs.writeFileSync(p.join(W, 'plan.json'), `${JSON.stringify(legs, null, 2)}\n`, 'utf8');
  const keptNode = P.nodeOf(plan.kept);
  const keptTool = P.toolOf(plan.kept);
  if (/['"]/.test(`${keptNode}${keptTool}${W}`)) return stopHere('a folder name has a quote mark in it, which a task cannot carry safely');
  const root = String(deps.env.SystemRoot || deps.env.windir || 'C:\\Windows');
  const xml = systemTaskXml({
    description: `SRE Retail OS: the timed rollback drill (G9) — puts version ${plan.previous.version} back, then ${plan.running} again. Made for one drill by ${by}. CR-01 step 3e.`,
    command: p.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: `-NoProfile -NonInteractive -WindowStyle Hidden -Command "& '${keptNode}' '${keptTool}' drill --legs '${W}'; exit $LASTEXITCODE"`,
    workingDir: plan.kept, timeLimit: 'PT3H',
  });
  const tasks = tasksFor(deps, L);
  const reg = tasks?.register(DRILL_TASK, xml);
  const go = reg?.ok ? tasks.run?.(DRILL_TASK) : undefined;
  if (!reg?.ok || !go?.ok) return stopHere(`Windows did not start the task "${DRILL_TASK}" (${reg?.said ?? go?.said ?? 'no task scheduler'}) — run this window as administrator`);
  j.step('handed-over', 'rollback and roll forward started', { task: DRILL_TASK });
  j.progress('working', `Putting version ${plan.previous.version} back, then ${plan.running} again. The till stops twice for a few minutes.`, { stepNow: 'rollback' });
  say(`STARTED — the task "${DRILL_TASK}" now puts version ${plan.previous.version} back, then ${plan.running} again. The till stops twice for a few minutes.`);
  say('  In about 20 minutes run the same command WITHOUT --run: its last line says how the drill went, and where its record is.');
  return 0;
}

// ── The second half ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Put a version's program over the program folder, run its own setup, and run its checks. */
async function putVersion(deps, L, P, folder, version) {
  await stopServices(deps);
  const m = mirror(deps, folder, P.app);
  if (!m.ok) return { ok: false, detail: `${folder} could not be put over ${P.app} (${m.said})` };
  const setup = deps.spawn(P.nodeOf(P.app), [P.toolOf(P.app), 'setup'], { cwd: P.app, env: deps.env, timeout: SETUP_WAIT_MS });
  if (!ran(setup)) return { ok: false, detail: `version ${version}'s own setup did not finish (${firstLine(setup)})` };
  const failure = await theChecks(deps, L, P, version);
  return failure === undefined ? { ok: true } : { ok: false, detail: failure };
}

async function drillLegs(deps, W) {
  const { say, fs } = deps;
  const p = pathFor(deps.platform);
  const L = resolveLayout(deps);
  if (deps.platform !== 'win32' || L.mode !== 'data-folder') { say('REFUSED — the second half of the drill runs on the store computer only.'); return 2; }
  const plan = readJson(fs, p.join(String(W), 'plan.json'));
  if (plan?.kind !== DRILL_PLAN_KIND) { say(`REFUSED — ${W} holds no drill plan. Nothing was changed.`); return 2; }
  const record = plan.record;
  const P = { ...updaterPaths(deps, L), app: plan.app };
  const j = journal(deps, L, { drillId: plan.drillId, by: plan.by, from: plan.running, previous: plan.previous.version });

  // 6 — Once more, right before anything stops.
  const shifts = await openShifts(deps, L);
  if (shifts.unknown || shifts.open.length > 0) {
    const why = shifts.unknown ? 'the till did not answer, so it is not known that every till shift is closed' : `a till shift was opened (${shifts.open.join(', ')})`;
    j.step('shifts', `refused: ${why}`);
    say(`NOT GOING ON — ${why}. Nothing was stopped.`);
    const done = finishRecord(deps, L, record, j, plan.to);
    j.progress('finished', `${record.overall}: ${why}, so nothing was stopped. Run the drill again when every till is closed. Record: ${done.recFile}`, { overall: record.overall, record: done.recFile });
    return 2;
  }
  const ctx = ready({ ...deps, say: () => {} });

  // 7 — The previous version back.
  await timedStep(deps, record, j, 'rollback', `put version ${plan.previous.version} back and pass its checks`, async () => {
    const r = await putVersion(deps, L, P, plan.previous.folder, plan.previous.version);
    if (!r.ok) return r;
    const after = ctx.code === undefined ? appliedSteps(deps, ctx) : undefined;
    if (after === undefined || after.length !== plan.stepsBefore.length || after.some((n) => !plan.stepsBefore.includes(n))) return { ok: false, detail: 'the previous version changed the shop\'s database steps — that is not a clean rollback' };
    return { ok: true, detail: `version ${plan.previous.version} runs on the shop's current database` };
  });
  j.progress('working', `Version ${plan.previous.version} was put back. Now putting ${plan.running} back.`, { stepNow: 'rollForward' });

  // 8 — Forward again, ALWAYS: the shop must end on the version it was on.
  const forward = await timedStep(deps, record, j, 'rollForward', `put version ${plan.running} back and pass its checks`, () => putVersion(deps, L, P, plan.kept, plan.running));

  // 9 — The verdict and the record.
  const done = finishRecord(deps, L, record, j, plan.to);
  if (!forward.ok) {
    const now = versionIn(deps, P, P.app) ?? 'unknown';
    const where = now === plan.running ? `version ${plan.running}'s program is in place, but it did not start or did not pass its checks` : `this PC may be on version ${now}, not ${plan.running}`;
    say(`  A PERSON IS NEEDED NOW — ${where}. Run SRE-Setup.exe of version ${plan.running} again as administrator, and send a photo of this record.`);
    j.progress('forward-failed', `${record.overall}: version ${plan.running} could NOT be put back (${forward.detail}). A person is needed now: run SRE-Setup.exe of version ${plan.running} again as administrator. Record: ${done.recFile}`, { overall: record.overall, record: done.recFile });
    return 1;
  }
  j.progress('finished', `${record.overall} — ${done.verdict.line} Record: ${done.recFile}`, { overall: record.overall, record: done.recFile, ...(done.evidence === undefined ? {} : { evidence: done.evidence }) });
  return done.verdict.passed ? 0 : 1;
}
