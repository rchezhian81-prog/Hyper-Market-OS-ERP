// The store computer runs itself — OB-249 (automatic hourly encrypted backup to a drive that stays plugged in) and audit
// row 5 / C-11 (after a reboot nothing restarted).
//
//   schedule-backup --to <drive folder> --every 60   Windows Task Scheduler: a backup every N minutes (15–60) and a status
//                                                     check every 15 minutes; asks for the backup passphrase only if none
//                                                     is set; takes the first backup at once
//   unschedule-backup                                 removes both tasks; every backup and the key are kept
//   backup-status                                     the schedule, the last backup, the drive's backups and free space
//   autostart [--off]                                 a sign-in task: wait for Docker Desktop (starting it if needed),
//                                                     start this copy and the till, then check
//
// ── How a task runs, and the truth about Windows ──────────────────────────────────────────────────────────────────
// Each task is registered from an XML definition (`schtasks /Create /XML`, an argument array, no shell): it runs as the
// owner, ONLY while he is signed in ("InteractiveToken" — no password is stored anywhere), with no time limit problems
// for a laptop on battery, and a missed run is run as soon as possible. Its action is a hidden PowerShell window that
// starts Node with the data folder's small launcher (run\launch.mjs), which opens the store-computer tool of the release
// named in run\current-release.json — so after an update the tasks never need changing.
//
// Docker Desktop runs only inside a signed-in Windows session. So after a power cut or an overnight update restart,
// NOTHING runs — not the database, not the till, not the backup — until the owner signs in. The sign-in task then does
// the rest. With OB-251's separate cashier account: the owner signs in first, locks the PC (Windows key + L), and the
// cashier uses "Switch user"; the owner's session — Docker, the till's box, the backups — keeps running behind it.
//
// Nothing here deletes a backup. There is no retention rule in the roadmap or the decisions register, so every backup is
// kept; backup-status shows how many there are, how much room is left and about how many days that lasts.

import {
  composeBase, composeEnv, dockerProblem, lines, loadSettings, pathFor, PROJECT, resolveLayout, waitReady,
} from './store-computer.mjs';
import {
  BACKUP_LOG, backupLines, dataFolderReady, ensureBackupKey, folderRefusal, mins, readBackupKey, readLastBackup, ready,
  recordBackupOutcome, size, takeStoreBackup, tillFolders,
} from './store-computer-recovery.mjs';
import { ALERT_RULES, SCHEDULE_FILE, ageWords, backupRoom, readSchedule, status } from './store-computer-status.mjs';
// Kept importable from here, where they were first written (OB-262 · OB-268 moved them beside the status check).
export { daysOfRoom, driveTally } from './store-computer-status.mjs';

/** The tasks, by name, in their own "SRE" folder of the Task Scheduler Library. */
export const TASKS = Object.freeze({
  backup: 'SRE\\Automatic backup',
  status: 'SRE\\Store computer check',
  start: 'SRE\\Start the shop system at sign-in',
});
export const LAUNCHER = 'launch.mjs';
export const CURRENT_RELEASE = 'current-release.json';
/** OB-249: hourly. More often is allowed (down to 15 minutes); less often is not — it would break "at most about an hour". */
export const EVERY_LIMITS = Object.freeze({ min: 15, max: 60 });
export const DOCKER_WAIT_MS = 10 * 60_000;
export const TILL_WAIT_MS = 60_000;

const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const pad = (n) => String(n).padStart(2, '0');
/** A Task Scheduler start time: this computer's LOCAL time, to the minute, without a zone (how the XML wants it). */
export const localStamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;

/**
 * One task's XML. `trigger` is { kind: 'logon', delay } or { kind: 'repeat', everyMinutes, start }. Runs as `userId`, only
 * while that person is signed in, never more than one at a time, on battery too, and catches up a missed run.
 */
export function taskXml({ description, userId, trigger, command, args, workingDir, timeLimit }) {
  const triggerXml = trigger.kind === 'logon'
    ? ['    <LogonTrigger>', '      <Enabled>true</Enabled>', `      <UserId>${xmlEscape(userId)}</UserId>`, `      <Delay>${trigger.delay}</Delay>`, '    </LogonTrigger>']
    : ['    <TimeTrigger>', '      <Repetition>', `        <Interval>PT${trigger.everyMinutes}M</Interval>`, '        <StopAtDurationEnd>false</StopAtDurationEnd>', '      </Repetition>', `      <StartBoundary>${trigger.start}</StartBoundary>`, '      <Enabled>true</Enabled>', '    </TimeTrigger>'];
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    `    <Description>${xmlEscape(description)}</Description>`,
    '    <Author>SRE Retail OS store-computer</Author>',
    '  </RegistrationInfo>',
    '  <Triggers>',
    ...triggerXml,
    '  </Triggers>',
    '  <Principals>',
    '    <Principal id="Author">',
    `      <UserId>${xmlEscape(userId)}</UserId>`,
    '      <LogonType>InteractiveToken</LogonType>',
    '      <RunLevel>LeastPrivilege</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <AllowHardTerminate>true</AllowHardTerminate>',
    '    <StartWhenAvailable>true</StartWhenAvailable>',
    '    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>',
    '    <IdleSettings>',
    '      <StopOnIdleEnd>false</StopOnIdleEnd>',
    '      <RestartOnIdle>false</RestartOnIdle>',
    '    </IdleSettings>',
    '    <AllowStartOnDemand>true</AllowStartOnDemand>',
    '    <Enabled>true</Enabled>',
    '    <Hidden>false</Hidden>',
    '    <RunOnlyIfIdle>false</RunOnlyIfIdle>',
    '    <WakeToRun>false</WakeToRun>',
    `    <ExecutionTimeLimit>${timeLimit}</ExecutionTimeLimit>`,
    '    <Priority>7</Priority>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    `      <Command>${xmlEscape(command)}</Command>`,
    `      <Arguments>${xmlEscape(args)}</Arguments>`,
    `      <WorkingDirectory>${xmlEscape(workingDir)}</WorkingDirectory>`,
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    '',
  ].join('\r\n');
}

/** Who the tasks run as: this Windows sign-in (DOMAIN\name). */
export const windowsUser = (env) => (String(env.USERNAME ?? '').trim() === '' ? undefined : `${String(env.USERDOMAIN ?? '').trim() === '' ? '.' : env.USERDOMAIN}\\${env.USERNAME}`);

/** The hidden PowerShell that starts Node with the launcher and one store-computer command. Refuses a path with a quote. */
export function taskAction(deps, L, command) {
  const p = pathFor(deps.platform);
  const launcher = p.join(L.runDir, LAUNCHER);
  for (const x of [deps.nodePath, launcher]) if (/['"]/.test(x)) return { problem: `the path ${x} has a quote mark in it, which a task cannot carry safely` };
  const root = String(deps.env.SystemRoot || deps.env.windir || 'C:\\Windows');
  return {
    command: pathFor('win32').join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: `-NoProfile -NonInteractive -WindowStyle Hidden -Command "& '${deps.nodePath}' '${launcher}' ${command}; exit $LASTEXITCODE"`,
    workingDir: L.runDir,
  };
}

/**
 * Windows Task Scheduler, through `schtasks` with argument arrays (no shell). The XML is written UTF-16 with a byte-order
 * mark, the encoding schtasks reads without complaint. Elsewhere there is no Task Scheduler: undefined.
 */
export function windowsTasks(deps, runDir) {
  const p = pathFor(deps.platform);
  return {
    register: (name, xml) => {
      const file = p.join(runDir, `${name.replace(/^SRE\\/, '').replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}.xml`);
      deps.fs.writeFileSync(file, Buffer.from(`\ufeff${xml}`, 'utf16le'));
      const r = deps.spawn('schtasks', ['/Create', '/TN', name, '/XML', file, '/F'], {});
      return r.error === undefined && r.status === 0 ? { ok: true } : { ok: false, said: lines(`${r.stderr ?? ''}\n${r.stdout ?? ''}`)[0] ?? (r.error?.code ?? `it ended ${r.status}`) };
    },
    remove: (name) => {
      const r = deps.spawn('schtasks', ['/Delete', '/TN', name, '/F'], {});
      return r.error === undefined && r.status === 0 ? { ok: true } : { ok: false, said: lines(`${r.stderr ?? ''}\n${r.stdout ?? ''}`)[0] ?? `it ended ${r.status}` };
    },
    exists: (name) => {
      const r = deps.spawn('schtasks', ['/Query', '/TN', name], {});
      return r.error === undefined && r.status === 0;
    },
  };
}

/** This computer's task scheduler: the one given (tests), Windows' own, or none. */
export const tasksFor = (deps, L) => deps.tasks ?? (deps.platform === 'win32' ? windowsTasks(deps, L.runDir) : undefined);

/** The launcher every task starts: it opens the store-computer tool of the CURRENT release (run\current-release.json). */
export const LAUNCHER_SOURCE = [
  '// Written by "pnpm run store-computer". The Windows tasks start THIS file. It runs the store-computer tool of the release',
  '// named in current-release.json beside it, so an update never needs the tasks changed. No secret is in this file.',
  "import { readFileSync } from 'node:fs';",
  "import { dirname, join } from 'node:path';",
  "import { fileURLToPath, pathToFileURL } from 'node:url';",
  'const here = dirname(fileURLToPath(import.meta.url));',
  "const { folder } = JSON.parse(readFileSync(join(here, 'current-release.json'), 'utf8'));",
  "const tool = await import(pathToFileURL(join(folder, 'scripts', 'lib', 'store-computer.mjs')).href);",
  'process.exitCode = await tool.main(process.argv.slice(2), tool.defaultDeps());',
  '',
].join('\n');

/** The release the tasks run, or undefined. */
export function currentRelease(deps, L) {
  try { return JSON.parse(deps.fs.readFileSync(pathFor(deps.platform).join(L.runDir, CURRENT_RELEASE), 'utf8')); } catch { return undefined; }
}

/** Write the launcher, and name a release as current (this one unless told). Both replaced whole (temp, rename). */
export function writeLauncher(deps, L, release = deps.repoRoot, previous = undefined) {
  const p = pathFor(deps.platform);
  deps.fs.mkdirSync(L.runDir, { recursive: true });
  const swap = (name, text) => {
    const tmp = p.join(L.runDir, `${name}.tmp`);
    deps.fs.writeFileSync(tmp, text, 'utf8');
    deps.fs.renameSync(tmp, p.join(L.runDir, name));
  };
  swap(LAUNCHER, LAUNCHER_SOURCE);
  const was = currentRelease(deps, L);
  const prev = previous ?? (was?.folder !== undefined && was.folder !== release ? was.folder : was?.previous);
  swap(CURRENT_RELEASE, `${JSON.stringify({ folder: release, setAt: deps.now().toISOString(), ...(prev === undefined ? {} : { previous: prev }) }, null, 2)}\n`);
}

const readJson = (fs, f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return undefined; } };

/** The common refusals of the scheduling commands. Returns { ctx, tasks } or { code }. */
function scheduling(deps, needTasks = true) {
  const ctx = ready(deps);
  if (ctx.code !== undefined) return ctx;
  if (!dataFolderReady(deps, ctx)) return { code: 2 };
  const tasks = tasksFor(deps, ctx.L);
  if (needTasks && tasks === undefined) {
    deps.say('REFUSED — this sets up Windows Task Scheduler, and this computer is not Windows. On Linux use a systemd timer that runs: node scripts/store-computer.mjs scheduled-backup');
    return { code: 2 };
  }
  if (needTasks && windowsUser(deps.env) === undefined) { deps.say('REFUSED — Windows did not say who is signed in (USERNAME is not set). Open a new PowerShell window and run this again.'); return { code: 2 }; }
  return { ctx, tasks };
}

function registered(deps, tasks, name, xml) {
  const r = tasks.register(name, xml);
  if (r.ok) return true;
  deps.say(`NOT DONE — Windows did not accept the task "${name}". In Windows' own words: ${r.said}`);
  deps.say('  What to do: if it says "Access is denied", close PowerShell, open it again with right-click → "Run as administrator", go to the same folder, and run this again. Otherwise send me a photo of this screen.');
  return false;
}

function roomLines(deps, L, schedule) {
  const room = backupRoom(deps, L, schedule);
  const t = room.tally;
  if (t === undefined || !t.readable) return [`  The drive folder ${schedule.to} cannot be read now — is the drive plugged in? Room left: NOT KNOWN.`];
  const days = room.known
    ? ` — room for about ${room.days} more day(s) at the current rate${room.days < ALERT_RULES.backupDriveMinDays ? ` (RED: under ${ALERT_RULES.backupDriveMinDays} days)` : ''}`
    : ` — room left: NOT KNOWN yet (${room.why.en})`;
  return [
    `  On the drive: ${t.backups} backup(s), ${size(t.bytes)} in all${t.free === undefined ? '' : `; ${size(t.free)} free`}${days}.`,
    `  NOTHING IS EVER DELETED (OB-262): every backup is kept. When the drive has room for fewer than about ${ALERT_RULES.backupDriveMinDays} more days (OB-268), this says RED and so does the office screen — then decide what to keep, or plug in a bigger drive.`,
  ];
}

// ── schedule-backup · unschedule-backup · backup-status · scheduled-backup ───────────────────────────────────────────

/** `schedule-backup --to <drive folder> --every <minutes>`. */
export async function scheduleBackup(deps, opts) {
  const { say } = deps;
  const p = pathFor(deps.platform);
  const to = typeof opts.to === 'string' ? opts.to.trim() : '';
  const every = Number(opts.every ?? 60);
  if (to === '') { say('REFUSED — say which drive folder the automatic backup goes to: pnpm run store-computer -- schedule-backup --to F:\\sre-auto --every 60  (the drive that STAYS plugged in)'); return 2; }
  if (!Number.isInteger(every) || every < EVERY_LIMITS.min || every > EVERY_LIMITS.max) { say(`REFUSED — --every must be a whole number of minutes from ${EVERY_LIMITS.min} to ${EVERY_LIMITS.max}. OB-249 says hourly (60): a dead disk loses at most about an hour.`); return 2; }
  const s = scheduling(deps);
  if (s.code !== undefined) return s.code;
  const { ctx, tasks } = s;
  const L = ctx.L;
  const dir = p.resolve(to);
  const refusal = folderRefusal(deps, dir);
  if (refusal !== undefined) { say(`REFUSED — ${refusal}`); return 2; }
  try { deps.fs.mkdirSync(dir, { recursive: true }); } catch (e) { say(`NOT DONE — the folder ${dir} could not be made (${e?.code ?? 'error'}). Plug in the backup drive that stays in this computer, check its letter, and run this again.`); return 1; }
  const docker = dockerProblem(deps);
  if (docker !== undefined) { say(`NOT DONE — ${docker.what}`); say(`  What to do: ${docker.fix}`); return 1; }
  const key = await ensureBackupKey(deps, L);
  if (key === undefined) return 1;

  writeLauncher(deps, L, currentRelease(deps, L)?.folder ?? deps.repoRoot);
  const user = windowsUser(deps.env);
  const start = localStamp(new Date(deps.now().getTime() + 2 * 60_000));
  const backupAction = taskAction(deps, L, 'scheduled-backup');
  const statusAction = taskAction(deps, L, 'status --quiet');
  if (backupAction.problem !== undefined || statusAction.problem !== undefined) { say(`REFUSED — ${backupAction.problem ?? statusAction.problem}. Move the folder, then run this again.`); return 2; }
  const backupXml = taskXml({ description: `SRE: encrypted backup of the shop's data every ${every} minutes to ${dir} (store-computer schedule-backup, OB-249).`, userId: user, trigger: { kind: 'repeat', everyMinutes: every, start }, ...backupAction, timeLimit: 'PT50M' });
  const statusXml = taskXml({ description: "SRE: the store computer's own check every 15 minutes — writes the red banner the office screen shows (store-computer status).", userId: user, trigger: { kind: 'repeat', everyMinutes: ALERT_RULES.checkEveryMinutes, start }, ...statusAction, timeLimit: 'PT10M' });
  if (!registered(deps, tasks, TASKS.backup, backupXml)) return 1;
  if (!registered(deps, tasks, TASKS.status, statusXml)) return 1;

  const schedulePath = p.join(L.backupDir, SCHEDULE_FILE);
  deps.fs.mkdirSync(L.backupDir, { recursive: true });
  const tmp = `${schedulePath}.tmp`;
  deps.fs.writeFileSync(tmp, `${JSON.stringify({ to: dir, everyMinutes: every, setAt: deps.now().toISOString(), setBy: user, keyId: key.keyId }, null, 2)}\n`, 'utf8');
  deps.fs.renameSync(tmp, schedulePath);
  deps.fs.appendFileSync(p.join(L.backupDir, BACKUP_LOG), `${JSON.stringify({ at: deps.now().toISOString(), kind: 'schedule-on', to: dir, everyMinutes: every })}\n`, 'utf8');

  say(`AUTOMATIC BACKUP ON — every ${every} minutes to ${dir}, encrypted to backup key ${key.keyId}, while you are signed in to Windows.`);
  say(`  Windows tasks: "${TASKS.backup}" and "${TASKS.status}" (every ${ALERT_RULES.checkEveryMinutes} minutes, for the red banner).`);
  say('Taking the first backup now, so you can see it work…');
  const b = takeStoreBackup(deps, ctx, dir, key);
  recordBackupOutcome(deps, L, { kind: 'first-automatic', to: dir, ...b });
  if (!b.ok) { say(`FIRST BACKUP NOT DONE — ${b.problem}`); say('  The tasks are set up, but fix this first: run "pnpm run store-computer -- up", then "pnpm run store-computer -- backup-status".'); await status(deps, { quiet: true }); return 1; }
  say(`BACKUP DONE — ${b.manifest.backupId}, in ${mins(b.manifest.timeTakenMs)}.`);
  for (const l of backupLines(b.manifest)) say(l);
  for (const l of roomLines(deps, L, { to: dir, everyMinutes: every })) say(l);
  await status(deps, { quiet: true });
  say(`Next: check that it restores — pnpm run store-computer -- restore-check --from ${b.manifestPath}`);
  return 0;
}

/** `unschedule-backup`: both tasks removed; every backup, the log and the key kept. */
export async function unscheduleBackup(deps) {
  const { say } = deps;
  const s = scheduling(deps);
  if (s.code !== undefined) return s.code;
  const { ctx, tasks } = s;
  const p = pathFor(deps.platform);
  const L = ctx.L;
  const problems = [];
  for (const name of [TASKS.backup, TASKS.status]) {
    if (!tasks.exists(name)) continue;
    const r = tasks.remove(name);
    if (!r.ok) problems.push(`"${name}": ${r.said}`);
  }
  if (problems.length > 0) { say(`NOT DONE — Windows did not remove ${problems.join('; ')}. Nothing else was changed.`); return 1; }
  const was = readSchedule(deps, L);
  const schedulePath = p.join(L.backupDir, SCHEDULE_FILE);
  if (was !== undefined) {
    const tmp = `${schedulePath}.tmp`;
    deps.fs.writeFileSync(tmp, `${JSON.stringify({ off: true, offAt: deps.now().toISOString(), was }, null, 2)}\n`, 'utf8');
    deps.fs.renameSync(tmp, schedulePath);
  }
  deps.fs.mkdirSync(L.backupDir, { recursive: true });
  deps.fs.appendFileSync(p.join(L.backupDir, BACKUP_LOG), `${JSON.stringify({ at: deps.now().toISOString(), kind: 'schedule-off' })}\n`, 'utf8');
  say('AUTOMATIC BACKUP OFF — the two Windows tasks are removed.');
  say('  Every backup already on the drives is kept, and so is the backup key. Nothing was deleted.');
  say('  In 2 hours the office screen and "status" turn RED for the backup — on purpose: no backup is a problem, not a quiet state.');
  await status(deps, { quiet: true });
  return 0;
}

/** `backup-status`: the schedule, the last backup and the room left on the drive. Exit 1 when the backup is overdue. */
export async function backupStatus(deps) {
  const { say } = deps;
  const { L, settings } = loadSettings(deps);
  if (settings === undefined) { say('REFUSED — this copy has no settings file yet. Run first: pnpm run store-computer -- prepare'); return 2; }
  if (L.mode !== 'data-folder') { say("This copy's data is still inside the system's own folder. Move it first: pnpm run store-computer -- migrate-data-folder"); return 1; }
  const tasks = tasksFor(deps, L);
  const schedule = readSchedule(deps, L);
  const key = readBackupKey(deps, L);
  const last = readLastBackup(deps, L);
  const nowMs = deps.now().getTime();
  say('Backups on this store computer:');
  const keyLine = key.key === undefined ? 'NOT SET — the first backup asks you to choose the passphrase'
    : `${key.key.keyId} (made ${key.key.createdAt}); the passphrase that opens it is kept nowhere on this computer`;
  say(`  Backup key:     ${keyLine}`);
  if (schedule === undefined) say('  Automatic:      OFF — set it up: pnpm run store-computer -- schedule-backup --to F:\\sre-auto --every 60');
  else {
    const on = tasks === undefined ? undefined : [TASKS.backup, TASKS.status].every((n) => tasks.exists(n));
    say(`  Automatic:      every ${schedule.everyMinutes} minutes to ${schedule.to}${on === false ? ' — BUT THE WINDOWS TASK IS MISSING: run schedule-backup again' : ''}`);
  }
  const okAt = last?.lastSuccess === undefined ? undefined : Date.parse(last.lastSuccess.at);
  const age = okAt === undefined ? undefined : Math.floor((nowMs - okAt) / 60_000);
  say(`  Last good:      ${okAt === undefined ? 'none yet' : `${last.lastSuccess.at} — ${ageWords(age).en} ago, ${last.lastSuccess.backupId} on ${last.lastSuccess.to}`}`);
  if (last?.lastAttempt?.ok === false) say(`  Last try:       FAILED at ${last.lastAttempt.at} — ${last.lastAttempt.problem}`);
  if (schedule !== undefined) for (const l of roomLines(deps, L, schedule)) say(l);
  const overdue = age === undefined || age > ALERT_RULES.backupMaxAgeMinutes;
  say(overdue ? 'RED — the last good backup is more than 2 hours old, or there is none. Plug the backup drive in and run: pnpm run store-computer -- backup --to <its folder>'
    : 'OK — the last good backup is less than 2 hours old.');
  // OB-268: red when the drive has room for fewer than about 30 more days at the current rate; "not known" is said above.
  const room = schedule === undefined ? undefined : backupRoom(deps, L, schedule);
  const filling = room?.known === true && room.days < ALERT_RULES.backupDriveMinDays;
  if (filling) say(`RED — the backup drive has room for about ${room.days} more day(s) of backups at the current rate, under ${ALERT_RULES.backupDriveMinDays}. Nothing is ever deleted: decide what to keep, or plug in a bigger drive.`);
  return overdue || filling ? 1 : 0;
}

/**
 * `scheduled-backup` — what the hourly task runs. Never asks anything (nobody is at the keyboard): it backs up to the
 * scheduled folder with the public key, writes down how it went, refreshes the status file, and logs its lines.
 */
export async function scheduledBackup(deps) {
  const L0 = resolveLayout(deps);
  if (L0.mode !== 'data-folder') { deps.say('REFUSED — the automatic backup needs the shop\'s data folder.'); return 2; }
  const p = pathFor(deps.platform);
  deps.fs.mkdirSync(L0.runDir, { recursive: true });
  const logFile = p.join(L0.runDir, 'automatic-backup.log');
  const outer = deps.say;
  const say = (line) => { outer(line); try { deps.fs.appendFileSync(logFile, `${deps.now().toISOString()} ${line}\n`, 'utf8'); } catch { /* the log is a help, not the record */ } };
  const d = { ...deps, say };
  const lock = p.join(L0.runDir, 'backup.lock');
  if (!takeLock(d, lock)) { say('SKIPPED — another backup is still running.'); return 0; }
  try {
    const schedule = readSchedule(d, L0);
    if (schedule === undefined) { say('SKIPPED — automatic backup is off.'); return 0; }
    const ctx = ready(d);
    if (ctx.code !== undefined) { recordBackupOutcome(d, L0, { kind: 'automatic', to: schedule.to, ok: false, problem: 'this copy\'s settings refused the backup (see the log)' }); return ctx.code; }
    const key = readBackupKey(d, ctx.L).key;
    const refusal = folderRefusal(d, schedule.to);
    const docker = dockerProblem(d);
    const b = refusal !== undefined ? { ok: false, problem: refusal }
      : docker !== undefined ? { ok: false, problem: docker.what }
        : takeStoreBackup(d, ctx, schedule.to, key);
    recordBackupOutcome(d, ctx.L, { kind: 'automatic', to: schedule.to, ...b });
    say(b.ok ? `BACKUP DONE — ${b.manifest.backupId}, ${size(b.manifest.parts.database.sizeBytes + b.manifest.parts.files.sizeBytes + b.manifest.parts.settings.sizeBytes)}, in ${mins(b.manifest.timeTakenMs)}.` : `NOT DONE — ${b.problem}`);
    return b.ok ? 0 : 1;
  } finally {
    try { d.fs.rmSync(lock, { force: true }); } catch { /* a stale lock is taken over after two hours */ }
    await status(d, { quiet: true });
  }
}

/** A lock file made with 'wx'. One older than two hours (a run that was cut off) is taken over. */
export function takeLock(deps, file) {
  try { deps.fs.writeFileSync(file, `${deps.now().toISOString()}\n`, { encoding: 'utf8', flag: 'wx' }); return true; } catch { /* held — is it stale? */ }
  const at = Date.parse(String((() => { try { return deps.fs.readFileSync(file, 'utf8'); } catch { return ''; } })()).trim());
  if (Number.isFinite(at) && deps.now().getTime() - at < 2 * 3_600_000) return false;
  deps.fs.writeFileSync(file, `${deps.now().toISOString()}\n`, 'utf8');
  return true;
}

// ── autostart · start-at-sign-in ─────────────────────────────────────────────────────────────────────────────────

/** `autostart [--off]`: the sign-in task that brings the whole shop system back after a restart. */
export async function autostart(deps, opts = {}) {
  const { say } = deps;
  const s = scheduling(deps);
  if (s.code !== undefined) return s.code;
  const { ctx, tasks } = s;
  if (opts.off === true) {
    if (tasks.exists(TASKS.start)) {
      const r = tasks.remove(TASKS.start);
      if (!r.ok) { say(`NOT DONE — Windows did not remove "${TASKS.start}": ${r.said}`); return 1; }
    }
    say('AUTOSTART OFF — after a restart, start the shop system yourself: pnpm run store-computer -- up, then the till.');
    return 0;
  }
  const L = ctx.L;
  writeLauncher(deps, L, currentRelease(deps, L)?.folder ?? deps.repoRoot);
  const action = taskAction(deps, L, 'start-at-sign-in');
  if (action.problem !== undefined) { say(`REFUSED — ${action.problem}. Move the folder, then run this again.`); return 2; }
  const user = windowsUser(deps.env);
  const xml = taskXml({ description: 'SRE: when the owner signs in, wait for Docker Desktop (start it if needed), start the shop system (database, books, till) and check it (store-computer autostart, audit row 5).', userId: user, trigger: { kind: 'logon', delay: 'PT30S' }, ...action, timeLimit: 'PT30M' });
  if (!registered(deps, tasks, TASKS.start, xml)) return 1;
  const till = tillFolders(deps, L);
  say(`AUTOSTART ON — when ${user} signs in to Windows, the task "${TASKS.start}" will, by itself:`);
  say('  1. wait for Docker Desktop, and start it if it is not running (so nothing in Docker Desktop needs ticking);');
  say(`  2. start this copy (${PROJECT}: the database and the books) and wait until it says ready;`);
  say(till.installed ? '  3. start the till in the background (no window to close by mistake) — do NOT also double-click start-till.cmd;' : '  3. start the till — once it is installed (till:install); there is none on this computer yet;');
  say('  4. run the store computer check, so the office screen shows red if anything is wrong.');
  say('THE TRUTH ABOUT WINDOWS: Docker Desktop runs only while you are signed in. After a power cut or an update restart NOTHING runs');
  say('  — no database, no till, no backup — until YOU sign in. So: sign in first, then lock the PC (Windows key + L). The cashier then');
  say('  uses "Switch user" to his own account (OB-251); your session keeps everything running behind it.');
  say('  Also set: Settings → System → Power → Screen and sleep → "When plugged in, put my device to sleep after": Never.');
  say('Try it now: restart the computer, sign in, wait two minutes, then run: pnpm run store-computer -- status');
  return 0;
}

/** Start the till's box in the background from this release, unless it is already running. Returns what happened. */
export async function startTill(deps, L) {
  const p = pathFor(deps.platform);
  const till = tillFolders(deps, L);
  if (!till.installed) return { ok: false, detail: 'no till is installed on this computer yet' };
  if (await deps.portInUse(till.lanePort)) return { ok: true, detail: `the till is already running (port ${till.lanePort} answers) — not started twice` };
  const entry = p.join(deps.repoRoot, 'edge', 'store-edge', 'dist', 'start.js');
  if (!deps.fs.existsSync(entry)) return { ok: false, detail: `this release's till is not built (${entry} is missing) — run till:install in this release` };
  // The till's own settings, read from its file and handed to it; this release's screens, whatever the file says.
  const env = { ...deps.env, ...till.env, EDGE_APPS_DIR: p.join(deps.repoRoot, 'apps') };
  const logFile = p.join(L.tillDir, 'till-console.log');
  const child = deps.spawnDetached(deps.nodePath, [entry], { cwd: L.tillDir, env, logFile });
  deps.fs.mkdirSync(L.runDir, { recursive: true });
  deps.fs.writeFileSync(p.join(L.runDir, 'till.json'), `${JSON.stringify({ pid: child.pid, startedAt: deps.now().toISOString(), release: deps.repoRoot, logFile }, null, 2)}\n`, 'utf8');
  const deadline = deps.now().getTime() + TILL_WAIT_MS;
  while (deps.now().getTime() < deadline) {
    if (await deps.portInUse(till.lanePort)) return { ok: true, detail: `the till started in the background (process ${child.pid}); its own words go to ${logFile}` };
    await deps.sleep(2_000);
  }
  return { ok: false, detail: `the till did not answer within a minute — read ${logFile}` };
}

/** `start-at-sign-in` — what the sign-in task runs: Docker → this copy → the till → the check. Logs every line. */
export async function startAtSignIn(deps) {
  const L = resolveLayout(deps);
  if (L.mode !== 'data-folder') { deps.say('REFUSED — the sign-in start needs the shop\'s data folder.'); return 2; }
  const p = pathFor(deps.platform);
  deps.fs.mkdirSync(L.runDir, { recursive: true });
  const logFile = p.join(L.runDir, 'start-at-sign-in.log');
  const outer = deps.say;
  const say = (line) => { outer(line); try { deps.fs.appendFileSync(logFile, `${deps.now().toISOString()} ${line}\n`, 'utf8'); } catch { /* the log is a help */ } };
  const d = { ...deps, say };
  let code = 0;
  try {
    // 1. Docker Desktop.
    if (dockerProblem(d) !== undefined) {
      const exe = pathFor('win32').join(String(d.env.ProgramFiles || 'C:\\Program Files'), 'Docker', 'Docker', 'Docker Desktop.exe');
      if (d.platform === 'win32' && d.fs.existsSync(exe)) { say('Docker Desktop is not running — starting it.'); d.spawnDetached(exe, [], {}); }
      const deadline = d.now().getTime() + DOCKER_WAIT_MS;
      while (dockerProblem(d) !== undefined && d.now().getTime() < deadline) await d.sleep(10_000);
      if (dockerProblem(d) !== undefined) { say(`NOT STARTED — Docker Desktop did not start within ${DOCKER_WAIT_MS / 60_000} minutes.`); code = 1; }
    }
    // 2. This copy.
    if (code === 0) {
      const { settings } = loadSettings(d);
      const started = d.spawn('docker', [...composeBase(L), 'up', '-d', 'db', 'migrate', 'api'], { cwd: L.composeDir, env: composeEnv(d.env, settings) });
      if (started.error !== undefined || started.status !== 0) { say('NOT STARTED — Docker could not start this copy.'); code = 1; }
      else if (!(await waitReady(d, settings?.API_PORT || '8081'))) { say('NOT READY — the API did not say ready in time.'); code = 1; }
      else say(`READY — ${PROJECT} is up.`);
    }
    // 3. The till: started even if the books are not up — it sells and saves with no books at all (hard rule #1).
    const t = await startTill(d, L);
    say(`${t.ok ? 'TILL' : 'TILL NOT STARTED'} — ${t.detail}`);
    if (!t.ok) code = 1;
  } finally {
    // 4. The check, whatever happened above.
    await status(d, { quiet: true });
  }
  return code;
}

/** For update and migrate: the till's box this tool started (run\till.json), if it is still running. */
export function runningTill(deps, L) {
  const t = readJson(deps.fs, pathFor(deps.platform).join(L.runDir ?? '', 'till.json'));
  return t !== undefined && Number.isInteger(t.pid) && deps.processAlive(t.pid) ? t : undefined;
}

