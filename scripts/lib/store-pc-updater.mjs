// The store PC's UPDATER — CR-01 step 3d (OI-05 · OB-717 · OB-718 · OB-719 · OB-721 · P-01 · P-04 · P-08 · hard rules #1 #2 #4 #6).
//
//   apply-update                 what the Windows task "SRE\Software update" runs every 5 minutes (as Windows itself,
//                                SYSTEM — the only account allowed to stop the services and replace the program). It acts
//                                ONLY on a request the owner made on the Software update page (step 3c), and does nothing
//                                otherwise.
//   apply-update --install <W>   the second half, run by the task "SRE\Software update - install" from the KEPT copy of
//                                the running release (see "Why two halves" below). Never typed by a person.
//
// ── What one update is, in order — every step written down BEFORE the next one starts ─────────────────────────────
//   1. The request (update-request.json in the till's data folder) is TAKEN: moved into <data>\updates\<id>\, kept, never
//      deleted, so it is acted on once only. It is checked: the shape, a version newer than the one running, made within
//      the last hour (an older one must be made again — the owner expects it now, not tomorrow).
//   2. No till shift may be open (OB-718): asked of the till itself, which reads its own till-cash log. A till that does
//      not answer is a refusal — "not known to be closed" is never "closed".
//   3. The release is downloaded from GitHub (OB-717 · OB-721 "C": with the kept read-only key when there is one) and
//      checked as step 3a wrote: signed, the signature verifies with THIS PC's release public key, the file is the signed
//      one (SHA-256), newer than the running version — and the same version and fingerprint the owner was shown.
//   4. An ENCRYPTED BACKUP to the backup drive (the hourly backup's own method). No backup, no update.
//   5. The running release is KEPT: copied whole beside the program (…\SRE Retail OS kept\<version>), and checked.
//   6. The second half is handed to its own task, run from that kept copy.
//   7. (second half) No till shift open — asked once more, right before anything stops. Then SRE-Setup.exe of the new
//      version runs silently: it stops the three services, replaces the program, and runs `setup`, which keeps every
//      setting and every record, starts the services and waits for the office to say READY and the till to answer.
//   8. The PC's checks, by the NEW program: release.json says the new version; `services-status` (all three services
//      running, starting by themselves, each under its own account, the office ready); the till's screens answer.
//   9. Any failure from step 7 on: THE OLD VERSION IS PUT BACK BY ITSELF — the services stopped, the kept copy put back
//      over the program folder exactly, the old `setup` run (services re-made, started, READY), the same checks again.
//      The outcome — UPDATED · PUT BACK · NOT PUT BACK (a person is needed) — is written down and shown on the page.
//
// ── What is never touched ──────────────────────────────────────────────────────────────────────────────────────────
// The shop's DATA is never rolled back, copied over or deleted (hard rule #2: ledgers are append-only; the project's own
// rollback rule, docs/runbooks/rollback-drill.md: "nothing is ever restored over the live database"). Putting the old
// version back puts back the PROGRAM only; the old version runs on the same database, as the rollback drill (G9) proves it
// can (its database steps must be the first steps of the new one — checked and said). The encrypted backup of step 4 is
// the safety net a person can restore from. No record, request, log or kept copy is ever deleted by the updater (#6).
//
// ── Why two halves ─────────────────────────────────────────────────────────────────────────────────────────────────
// SRE-Setup.exe stops every node.exe that runs from the program's own folder before it copies (it must: Windows refuses to
// replace a file in use — the owner's PC, 9 Nov 2026). The first half runs from that folder, so it would be stopped half
// way. The second half therefore runs from the KEPT copy (a different node.exe), as its own task, so it outlives the
// first and drives the install AND the way back with the code of the release that was known to work.
//
// ── Who is trusted ─────────────────────────────────────────────────────────────────────────────────────────────────
// The request file is written by the till's own low-privilege account; the updater runs as SYSTEM. So the request is
// treated as a WISH, never as authority: whatever it says, only a release that is signed with the shop's release key,
// verifies, and is newer than the running one can ever be installed. The owner's PIN, role and the shift check were
// decided (and written down) by the page; the updater re-checks the shift and the release itself.
//
// Node built-ins only; every program is started with an argument array and no shell; everything that touches Windows or
// the internet arrives in `deps`, so the tests drive it on a pretend Windows.

import { createHash } from 'node:crypto';
import { loadSettings, pathFor, resolveLayout, stampOf } from './store-computer.mjs';
import { folderRefusal, migrationProblems, migrationsOf, readBackupKey, ready, recordBackupOutcome, takeStoreBackup, tillFolders } from './store-computer-recovery.mjs';
import { readSchedule } from './store-computer-status.mjs';
import { hostedTestMachine, refusedOnServer } from './store-computer-windows.mjs';
import { dockerCopyState } from './store-computer-adopt.mjs';
import { SERVICES, SERVICE_ORDER, serviceState } from './store-computer-services.mjs';
import { RELEASE_MARKER, releaseInfo } from './store-computer-setup.mjs';
import { takeLock, tasksFor, taskAction } from './store-computer-schedule.mjs';
import { PUBLIC_KEY_FILE, UPDATE_REPO, keptKey } from './store-pc-update-check.mjs';
import { UPDATE_ASSET, UPDATE_KIND, UPDATE_RECORD, checkUpdate, compareVersions, isReleaseVersion, releaseTag } from './store-pc-update.mjs';

// ── Names ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export const UPDATER_TASK = 'SRE\\Software update';
export const INSTALL_TASK = 'SRE\\Software update - install';
/** How often the updater looks for the owner's request. The page says "within 5 minutes". */
export const UPDATER_EVERY_MINUTES = 5;
/** A request older than this is not acted on: the owner presses Update again. */
export const REQUEST_MAX_AGE_MS = 60 * 60_000;
/** The request the Software update page leaves (edge/store-edge/src/update-page.ts, UPDATE_REQUEST_FILE). */
export const REQUEST_FILE = 'update-request.json';
export const REQUEST_KIND = 'sre-store-pc-update-request-v1';
/** <data>\updates\: one folder per update (its request, its plan, the setup program, its own words), and the log. */
export const UPDATES_DIR = 'updates';
export const OUTCOME_LOG = 'update-outcomes.log';
/** <data>\status\: what the page shows (replaced whole) and the mark that the updater is set up. */
export const PROGRESS_FILE = 'update-progress.json';
export const PROGRESS_KIND = 'sre-store-pc-update-progress-v1';
export const UPDATER_MARK = 'updater.json';
/** The kept copies of earlier releases, beside the program's own folder (Program Files: only administrators may write). */
export const KEPT_FOLDER = 'SRE Retail OS kept';
/** Windows itself (SYSTEM): the account the updater's tasks run as. */
export const SYSTEM_SID = 'S-1-5-18';
/** Room asked for beyond what is copied. */
export const SPARE_BYTES = 512 * 1024 ** 2;
export const SETUP_WAIT_MS = 60 * 60_000;
export const TILL_ANSWER_WAIT_MS = 2 * 60_000;
export const OPEN_SHIFTS_PATH = '/update/open-shifts';

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const readJson = (fs, f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return undefined; } };
const ran = (r) => r !== undefined && r.error === undefined && r.status === 0;
const firstLine = (r) => String(`${r?.stderr ?? ''}\n${r?.stdout ?? ''}`).split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '') ?? (r?.error?.code ?? `it ended ${r?.status}`);

/**
 * Where releases are asked for: GitHub's API — except on GitHub's own throw-away Windows test machine, where the
 * clean-Windows update job (CR-01 step 3f) names a stand-in on this machine (SRE_UPDATE_API_BASE, http://127.0.0.1 only).
 * The signature check is the same either way: a stand-in can serve nothing that is not signed with the PC's own key.
 */
export function updateApiBase(deps) {
  const given = String(deps.env?.SRE_UPDATE_API_BASE ?? '').trim();
  if (given !== '' && hostedTestMachine(deps) && /^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(given)) return given;
  return 'https://api.github.com';
}

// ── Where things are ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Every place the updater uses, for this release (the program folder) and data folder. */
export function updaterPaths(deps, L) {
  const p = pathFor(deps.platform);
  const app = deps.repoRoot;
  return {
    app,
    keptRoot: p.join(p.dirname(app), KEPT_FOLDER),
    keptOf: (version) => p.join(p.dirname(app), KEPT_FOLDER, version),
    updatesDir: p.join(L.dataRoot, UPDATES_DIR),
    outcomeLog: p.join(L.dataRoot, UPDATES_DIR, OUTCOME_LOG),
    progressFile: p.join(L.statusDir, PROGRESS_FILE),
    markFile: p.join(L.statusDir, UPDATER_MARK),
    lock: p.join(L.runDir, 'update.lock'),
    nodeOf: (root) => p.join(root, 'runtime', 'node', 'node.exe'),
    toolOf: (root) => p.join(root, 'scripts', 'store-computer.mjs'),
  };
}

// ── Writing it down (P-08 · OB-719 · hard rule #6) ───────────────────────────────────────────────────────────────────

/**
 * One line appended to <data>\updates\update-outcomes.log — never rewritten, never deleted — and, for the page, the
 * latest state in status\update-progress.json (replaced whole). Throws when the log cannot be written: an update that
 * cannot be written down does not go on.
 */
function journal(deps, L, base) {
  const { fs } = deps;
  const P = updaterPaths(deps, L);
  const say = deps.say;
  return {
    step(step, outcome, extra = {}) {
      fs.mkdirSync(P.updatesDir, { recursive: true });
      fs.appendFileSync(P.outcomeLog, `${JSON.stringify({ at: deps.now().toISOString(), ...base, step, outcome, ...extra })}\n`, 'utf8');
    },
    progress(state, said, extra = {}) {
      try {
        fs.mkdirSync(L.statusDir, { recursive: true });
        const tmp = `${P.progressFile}.tmp`;
        fs.writeFileSync(tmp, `${JSON.stringify({ kind: PROGRESS_KIND, at: deps.now().toISOString(), ...base, state, said, ...extra }, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 });
        fs.renameSync(tmp, P.progressFile);
      } catch (e) {
        say(`(The page could not be told: ${e instanceof Error ? e.message : String(e)})`);
      }
    },
  };
}

// ── The Windows tasks (SYSTEM) ───────────────────────────────────────────────────────────────────────────────────────

/**
 * A task that runs as Windows itself (SYSTEM), whether anyone is signed in or not — the only way the services can be
 * stopped and the program replaced after the owner's request. `everyMinutes` undefined: no schedule (run on demand).
 */
export function systemTaskXml({ description, everyMinutes, start, command, args, workingDir, timeLimit }) {
  const triggers = everyMinutes === undefined ? [] : [
    '  <Triggers>',
    '    <TimeTrigger>',
    '      <Repetition>',
    `        <Interval>PT${everyMinutes}M</Interval>`,
    '        <StopAtDurationEnd>false</StopAtDurationEnd>',
    '      </Repetition>',
    `      <StartBoundary>${xmlEscape(start)}</StartBoundary>`,
    '      <Enabled>true</Enabled>',
    '    </TimeTrigger>',
    '  </Triggers>',
  ];
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    `    <Description>${xmlEscape(description)}</Description>`,
    '    <Author>SRE Retail OS store-computer</Author>',
    '  </RegistrationInfo>',
    ...triggers,
    '  <Principals>',
    '    <Principal id="Author">',
    `      <UserId>${SYSTEM_SID}</UserId>`,
    '      <RunLevel>HighestAvailable</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <AllowHardTerminate>true</AllowHardTerminate>',
    '    <StartWhenAvailable>true</StartWhenAvailable>',
    '    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>',
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

const pad = (n) => String(n).padStart(2, '0');
const localStamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;

/**
 * Set up the updater: the task "SRE\Software update" (SYSTEM, every 5 minutes, through the data folder's launcher so it
 * always runs the LIVE release), and the mark the Software update page reads. Run by `setup` (as administrator).
 * Returns true when set up; says why when not (the page then keeps saying the updater is not set up).
 */
export function registerUpdater(deps, L) {
  const { say, fs } = deps;
  const tasks = tasksFor(deps, L);
  if (tasks === undefined) { say('The updater is not set up: this computer has no Windows Task Scheduler.'); return false; }
  const a = taskAction(deps, L, 'apply-update');
  if (a.problem !== undefined) { say(`The updater is not set up: ${a.problem}.`); return false; }
  const xml = systemTaskXml({
    description: 'SRE Retail OS: acts on the owner\'s "Update" request from the Software update page — never by itself. Runs as Windows (SYSTEM) because only Windows may stop the shop\'s services and replace the program. CR-01 step 3d.',
    everyMinutes: UPDATER_EVERY_MINUTES, start: localStamp(deps.now()), command: a.command, args: a.args, workingDir: a.workingDir, timeLimit: 'PT1H',
  });
  const r = tasks.register(UPDATER_TASK, xml);
  if (!r.ok) { say(`The updater is NOT set up — Windows did not accept the task "${UPDATER_TASK}": ${r.said}. The Software update page will say so; run SRE-Setup.exe again as administrator.`); return false; }
  try {
    const P = updaterPaths(deps, L);
    fs.mkdirSync(L.statusDir, { recursive: true });
    fs.writeFileSync(P.markFile, `${JSON.stringify({ kind: 'sre-store-pc-updater-v1', task: UPDATER_TASK, everyMinutes: UPDATER_EVERY_MINUTES, setAt: deps.now().toISOString() }, null, 2)}\n`, 'utf8');
  } catch { /* the task is there; the page only says it is not set up */ }
  say(`The updater is set up: the task "${UPDATER_TASK}" looks every ${UPDATER_EVERY_MINUTES} minutes for an update the owner asked for on the Software update page, and does nothing otherwise.`);
  return true;
}

// ── Small Windows helpers ────────────────────────────────────────────────────────────────────────────────────────────

/** Copy a folder exactly (robocopy /MIR): the target ends up holding exactly the source's files. 0–7 is success. */
export function mirror(deps, from, to) {
  const r = deps.spawn('robocopy.exe', [from, to, '/MIR', '/R:2', '/W:2', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], {});
  return r.error === undefined && typeof r.status === 'number' && r.status < 8 ? { ok: true } : { ok: false, said: firstLine(r) };
}

/** The size of every file under a folder, in bytes. */
export function folderBytes(fs, p, dir) {
  let n = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d).map(String)) {
      const f = p.join(d, e);
      const st = fs.statSync(f);
      if (st.isDirectory()) walk(f); else n += st.size;
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return n;
}

const sha256File = (fs, f) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');

export async function stopServices(deps) {
  for (const name of [...SERVICE_ORDER].reverse()) {
    if (serviceState(deps, name) === 'missing') continue;
    deps.spawn('sc.exe', ['stop', name], {});
    for (let i = 0; i < 60 && serviceState(deps, name) === 'running'; i += 1) await deps.sleep(1_000);
  }
}

/** Every till whose shift is open, by the till's own answer — or { unknown } when the till does not say. */
export async function openShifts(deps, L) {
  const till = tillFolders(deps, L);
  const port = Number(till.env?.EDGE_SCREEN_PORT || 8091);
  try {
    const r = await deps.fetch(`http://127.0.0.1:${port}${OPEN_SHIFTS_PATH}`);
    const o = await r.json();
    if (r.ok && o?.kind === 'sre-open-shifts-v1' && Array.isArray(o.open)) return { open: o.open.map((s) => String(s?.tillId ?? s)) };
  } catch { /* the till did not answer */ }
  return { unknown: true };
}

async function tillAnswers(deps, L) {
  const till = tillFolders(deps, L);
  const port = Number(till.env?.EDGE_SCREEN_PORT || 8091);
  const deadline = deps.now().getTime() + TILL_ANSWER_WAIT_MS;
  for (;;) {
    try { const r = await deps.fetch(`http://127.0.0.1:${port}/pos/`); if (r.ok) return true; } catch { /* not yet */ }
    if (deps.now().getTime() >= deadline) return false;
    await deps.sleep(2_000);
  }
}

// ── The first half: take the owner's request, check, download, back up, keep the running release ─────────────────────

/** The request as the page left it, checked. { request } or { refuse }. */
export function checkRequest(r, runningVersion, now) {
  if (r === null || typeof r !== 'object' || r.kind !== REQUEST_KIND) return { refuse: 'the request is not one this PC understands' };
  if (!isReleaseVersion(r.version) || !SHA256.test(String(r.sha256 ?? '')) || !COMMIT.test(String(r.commit ?? ''))) return { refuse: 'the request does not name a version, its commit and its fingerprint' };
  if (typeof r.requestedBy !== 'string' || r.requestedBy.trim() === '') return { refuse: 'the request does not say who made it' };
  if (r.tag !== null && r.tag !== undefined && r.tag !== releaseTag(r.version)) return { refuse: `the request names the release ${r.tag}, which is not version ${r.version}'s` };
  const at = Date.parse(String(r.requestedAt ?? ''));
  if (!Number.isFinite(at)) return { refuse: 'the request does not say when it was made' };
  const age = now.getTime() - at;
  if (age > REQUEST_MAX_AGE_MS) return { refuse: `the request was made at ${r.requestedAt}, more than ${REQUEST_MAX_AGE_MS / 60_000} minutes ago — press Update again when the shop is ready` };
  if (age < -5 * 60_000) return { refuse: `the request is dated in the future (${r.requestedAt}) — this PC's clock may be wrong` };
  if (isReleaseVersion(runningVersion) && compareVersions(r.version, runningVersion) <= 0) return { refuse: `version ${r.version} is not newer than the running ${runningVersion}` };
  return { request: r };
}

/** `apply-update` (and, with `install`, its second half). 0 nothing to do or done · 1 not done (said why) · 2 refused. */
export async function applyUpdate(deps, opts = {}) {
  if (opts.install !== undefined) return installUpdate(deps, opts.install);
  const { say, fs } = deps;
  const p = pathFor(deps.platform);
  if (deps.platform !== 'win32') { say('REFUSED — the updater is for the store computer (Windows 10 or 11).'); return 2; }
  if (refusedOnServer(deps)) return 2;
  const L = resolveLayout(deps);
  if (L.mode !== 'data-folder') { say('REFUSED — the updater needs the shop\'s data folder.'); return 2; }
  const P = updaterPaths(deps, L);
  const till = tillFolders(deps, L);
  const requestFile = p.join(till.edgeData, REQUEST_FILE);
  if (!fs.existsSync(requestFile)) { say('Nothing to do — no update was asked for.'); return 0; }
  fs.mkdirSync(L.runDir, { recursive: true });
  if (!takeLock(deps, P.lock)) { say('Another update is still running; this one waits.'); return 0; }
  try {
    return await takeAndPrepare(deps, L, P, requestFile);
  } finally {
    try { fs.rmSync(P.lock, { force: true }); } catch { /* a stale lock is taken over after two hours */ }
  }
}

async function takeAndPrepare(deps, L, P, requestFile) {
  const { say, fs } = deps;
  const p = pathFor(deps.platform);
  const at = deps.now();
  const running = releaseInfo(deps)?.version ?? null;
  const raw = readJson(fs, requestFile);
  const version = isReleaseVersion(raw?.version) ? raw.version : 'unknown';
  const id = `${stampOf(at)}-${version}`;
  const W = p.join(P.updatesDir, id);
  const base = { updateId: id, version, from: running, requestedBy: typeof raw?.requestedBy === 'string' ? raw.requestedBy : null };
  const j = journal(deps, L, base);

  // 1 — Taken: moved into its own folder, so it is acted on once only, and kept.
  try {
    fs.mkdirSync(W, { recursive: true });
    fs.renameSync(requestFile, p.join(W, 'request.json'));
    j.step('request', 'taken', { requestedAt: raw?.requestedAt ?? null });
  } catch (e) {
    say(`NOT DONE — the owner's request could not be taken and written down (${e instanceof Error ? e.message : String(e)}). Nothing was changed.`);
    return 1;
  }
  const refuse = (given, extra = {}) => {
    const why = String(given).replace(/[.\s]+$/, '');
    try { j.step('checks', `refused: ${why}`, extra); } catch { /* said below */ }
    j.progress('refused', `The update to ${version} was not started: ${why}. Nothing was changed.`);
    say(`NOT STARTED — ${why}. Nothing was changed.`);
    return 2;
  };
  const checked = checkRequest(raw, running, at);
  if (checked.refuse !== undefined) return refuse(checked.refuse);
  const req = checked.request;
  j.progress('working', `Checking the update to ${req.version} (asked for by ${req.requestedBy} at ${req.requestedAt}).`, { stepNow: 'checks' });

  // Things that would make the new version's setup refuse, said before anything is touched.
  const { settings } = loadSettings(deps);
  if (settings === undefined) return refuse('this PC\'s settings cannot be read');
  const docker = dockerCopyState(deps, L, true);
  if (typeof docker === 'object') return refuse(docker.refuse);
  if (docker !== 'none') return refuse('this shop still has its data in Docker — the move to Windows services must be finished first (run SRE-Setup.exe)');
  if (serviceState(deps, SERVICES.database) === 'missing') return refuse('the shop\'s Windows services are not installed on this PC');
  if (!fs.existsSync(P.nodeOf(P.app)) || !fs.existsSync(p.join(P.app, RELEASE_MARKER))) return refuse(`${P.app} is not an installed release`);

  // 2 — OB-718: no till shift open, by the till's own word.
  const shifts = await openShifts(deps, L);
  if (shifts.unknown) return refuse('the till did not answer, so it is not known that every till shift is closed');
  if (shifts.open.length > 0) return refuse(`a till shift is open (${shifts.open.join(', ')}) — close every till first, then press Update again`);
  j.step('shifts', 'none open');

  // 3 — The release: downloaded, then checked exactly as step 3a wrote.
  const publicKeyPem = (() => { try { return fs.readFileSync(p.join(P.app, PUBLIC_KEY_FILE), 'utf8'); } catch { return undefined; } })();
  if (deps.web === undefined || deps.download === undefined) return refuse('this PC has no way to download from the internet in the store-computer tool');
  const key = keptKey(deps, L);
  const head = (accept) => ({ accept, 'user-agent': 'sre-store-pc-updater', 'x-github-api-version': '2022-11-28', ...(key === undefined ? {} : { authorization: `Bearer ${key}` }) });
  const tag = releaseTag(req.version);
  let release;
  try {
    const r = await deps.web(`${updateApiBase(deps)}/repos/${UPDATE_REPO}/releases/tags/${tag}`, head('application/vnd.github+json'));
    if (r.status !== 200) return refuse(`GitHub did not give the release ${tag} (it answered ${r.status})`);
    release = JSON.parse(await r.text());
  } catch { return refuse(`GitHub did not answer for the release ${tag} (no internet?)`); }
  const assetUrl = (name) => (Array.isArray(release?.assets) ? release.assets.find((a) => a?.name === name)?.url : undefined);
  const recordUrl = assetUrl(UPDATE_RECORD);
  const setupUrl = assetUrl(UPDATE_ASSET);
  if (typeof recordUrl !== 'string' || typeof setupUrl !== 'string') return refuse(`the release ${tag} does not hold both ${UPDATE_RECORD} and ${UPDATE_ASSET}`);
  let record;
  try {
    const r = await deps.web(recordUrl, head('application/octet-stream'));
    record = r.status === 200 ? JSON.parse(await r.text()) : undefined;
  } catch { record = undefined; }
  if (record?.kind !== UPDATE_KIND) return refuse(`the ${UPDATE_RECORD} of ${tag} could not be downloaded or read`);
  const setupFile = p.join(W, UPDATE_ASSET);
  say(`Downloading ${UPDATE_ASSET} of version ${req.version}…`);
  let got;
  try { got = await deps.download(setupUrl, head('application/octet-stream'), setupFile); } catch { got = { status: 0 }; }
  if (got.status !== 200 || !fs.existsSync(setupFile)) return refuse(`${UPDATE_ASSET} of ${tag} could not be downloaded`);
  const verdict = checkUpdate({ record, setupBytes: fs.readFileSync(setupFile), publicKeyPem, runningVersion: running ?? undefined });
  if (!verdict.ok) return refuse(verdict.reason);
  if (record.version !== req.version || record.sha256 !== req.sha256 || record.commit !== req.commit) {
    return refuse(`the release on GitHub is not the one the owner was shown (version, commit or fingerprint differ)`);
  }
  j.step('download', 'signed and checked', { sha256: record.sha256, commit: record.commit });
  say(`CHECKED — version ${req.version} is signed, its signature verifies with this PC's release key, and the downloaded file is the signed one.`);

  // Room: the kept copy beside the program, and some to spare on the data disk.
  const appBytes = folderBytes(fs, p, P.app);
  const freeApp = deps.freeDiskBytes(p.dirname(P.app));
  if (freeApp < appBytes + SPARE_BYTES) return refuse(`there is not enough room on the program's disk to keep the running version (needs about ${Math.ceil((appBytes + SPARE_BYTES) / 1024 ** 2)} MB, ${Math.floor(freeApp / 1024 ** 2)} MB free)`);
  if (deps.freeDiskBytes(L.dataRoot) < SPARE_BYTES) return refuse('there is not enough room on the data disk (512 MB are needed)');

  // 4 — An encrypted backup first.
  const schedule = readSchedule(deps, L);
  if (schedule === undefined) return refuse('the automatic backup is not set up, so there is no backup drive to back up to first');
  const driveRefusal = folderRefusal(deps, schedule.to);
  if (driveRefusal !== undefined) return refuse(`the backup drive cannot be used: ${driveRefusal}`);
  const ctx = ready({ ...deps, say: () => {} });
  if (ctx.code !== undefined) return refuse('this PC\'s settings refused the backup');
  const bkey = readBackupKey(deps, L).key;
  j.progress('working', `Backing up before the update to ${req.version}.`, { stepNow: 'backup' });
  say(`Backing up everything to ${schedule.to} before anything changes…`);
  const b = takeStoreBackup(deps, ctx, schedule.to, bkey);
  recordBackupOutcome(deps, L, { kind: 'before-update', to: schedule.to, ...b });
  if (!b.ok) return refuse(`the backup before the update did not work: ${b.problem}`);
  j.step('backup', 'done', { backupId: b.manifest.backupId, to: schedule.to });
  say(`BACKUP DONE — ${b.manifest.backupId}.`);

  // 5 — The running release, kept whole beside the program, and checked.
  const kept = P.keptOf(running ?? 'unknown');
  const m = mirror(deps, P.app, kept);
  const keptRel = readJson(fs, p.join(kept, RELEASE_MARKER));
  if (!m.ok || keptRel?.version !== running || !fs.existsSync(P.nodeOf(kept)) || !fs.existsSync(P.toolOf(kept))) {
    return refuse(`the running version could not be kept beside the program (${m.ok ? 'the copy is not complete' : m.said})`);
  }
  j.step('keep', 'running version kept', { kept });
  say(`KEPT — the running version ${running} is copied to ${kept}: it is the way back.`);

  // 6 — The second half, from the kept copy, as its own task.
  const plan = { kind: 'sre-store-pc-update-plan-v1', ...base, version: req.version, commit: req.commit, sha256: record.sha256, setupFile, app: P.app, kept, backupId: b.manifest.backupId, requestedAt: req.requestedAt };
  fs.writeFileSync(p.join(W, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  const tasks = tasksFor(deps, L);
  const keptNode = P.nodeOf(kept);
  const keptTool = P.toolOf(kept);
  if (/['"]/.test(`${keptNode}${keptTool}${W}`)) return refuse('a folder name has a quote mark in it, which a task cannot carry safely');
  const root = String(deps.env.SystemRoot || deps.env.windir || 'C:\\Windows');
  const xml = systemTaskXml({
    description: `SRE Retail OS: installs version ${req.version}, and puts ${running} back by itself if anything fails. Made for one update by "${UPDATER_TASK}". CR-01 step 3d.`,
    command: p.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: `-NoProfile -NonInteractive -WindowStyle Hidden -Command "& '${keptNode}' '${keptTool}' apply-update --install '${W}'; exit $LASTEXITCODE"`,
    workingDir: kept, timeLimit: 'PT3H',
  });
  const reg = tasks?.register(INSTALL_TASK, xml);
  const go = reg?.ok ? tasks.run?.(INSTALL_TASK) : undefined;
  if (!reg?.ok || !go?.ok) return refuse(`Windows did not start the install (${reg?.said ?? go?.said ?? 'no task scheduler'})`);
  j.step('handed-over', 'install started', { task: INSTALL_TASK });
  j.progress('working', `Installing version ${req.version}. The till pauses for a few minutes; the old version comes back by itself if anything fails.`, { stepNow: 'install' });
  say(`STARTED — version ${req.version} is being installed by the task "${INSTALL_TASK}". The till pauses for a few minutes.`);
  return 0;
}

// ── The second half: install, check, and put the old version back by itself on any failure ───────────────────────────

async function installUpdate(deps, W) {
  const { say, fs } = deps;
  const p = pathFor(deps.platform);
  const L = resolveLayout(deps);
  if (deps.platform !== 'win32' || L.mode !== 'data-folder') { say('REFUSED — the install half of the updater runs on the store computer only.'); return 2; }
  const plan = readJson(fs, p.join(String(W), 'plan.json'));
  if (plan?.kind !== 'sre-store-pc-update-plan-v1') { say(`REFUSED — ${W} holds no update plan. Nothing was changed.`); return 2; }
  const P = { ...updaterPaths(deps, L), app: plan.app };
  const base = { updateId: plan.updateId, version: plan.version, from: plan.from, requestedBy: plan.requestedBy };
  const j = journal(deps, L, base);

  // 7 — Once more, right before anything stops: no till shift open; the downloaded file is still the signed one.
  const shifts = await openShifts(deps, L);
  if (shifts.unknown || shifts.open.length > 0) {
    const why = shifts.unknown ? 'the till did not answer, so it is not known that every till shift is closed' : `a till shift was opened (${shifts.open.join(', ')})`;
    j.step('shifts', `refused: ${why}`);
    j.progress('refused', `The update to ${plan.version} was not started: ${why}. Nothing was changed.`);
    say(`NOT STARTED — ${why}. Nothing was changed.`);
    return 2;
  }
  if (!fs.existsSync(plan.setupFile) || sha256File(fs, plan.setupFile) !== plan.sha256) {
    j.step('download', 'refused: the setup program changed on disk after it was checked');
    j.progress('refused', `The update to ${plan.version} was not started: the downloaded setup program is no longer the signed one. Nothing was changed.`);
    say('NOT STARTED — the downloaded setup program is no longer the signed one. Nothing was changed.');
    return 2;
  }

  // The new version's own setup program: stops the services, replaces the program, runs `setup` (keeps everything).
  j.step('install', 'started');
  say(`Installing version ${plan.version} (the services stop, the program is replaced, the services start again)…`);
  const setupLog = p.join(String(W), 'setup-program.log');
  const inst = deps.spawn(plan.setupFile, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', `/LOG=${setupLog}`], { timeout: SETUP_WAIT_MS });
  let failure;
  if (!ran(inst)) {
    failure = inst.status !== null && inst.status !== undefined && inst.status >= 10
      ? `the new version's setup did not finish (it said why in C:\\ProgramData\\SRE\\setup.log; code ${inst.status})`
      : `the new version's setup program failed (${inst.error?.code ?? `code ${inst.status}`})`;
  } else {
    j.step('install', 'setup done');
    failure = await theChecks(deps, L, P, plan.version);
  }
  if (failure === undefined) {
    j.step('checks', 'passed');
    // The page's "what the last check found" is asked again by the NEW program, so it no longer offers this version.
    // Best effort: without the internet the check says so, and the page still shows "Updated" from the line below.
    deps.spawn(P.nodeOf(P.app), [P.toolOf(P.app), 'check-update'], { cwd: P.app, env: deps.env, timeout: 2 * 60_000 });
    j.progress('updated', `Updated to version ${plan.version}. Every check passed.`, { stepNow: 'done', backupId: plan.backupId });
    say(`UPDATED — this PC now runs version ${plan.version}. Every check passed. The backup taken first is ${plan.backupId}; the old version ${plan.from} is kept in ${plan.kept}.`);
    return 0;
  }

  // 9 — Any failure: the old version back, by itself. First, while the new program is still in its folder: can the old
  // version run on the database the new one may have moved on (its database steps the first steps of the new one's)?
  const steps = migrationProblems(migrationsOf(fs, deps.platform, plan.kept), migrationsOf(fs, deps.platform, P.app));
  j.step('install', `failed: ${failure}`, steps.length === 0 ? {} : { databaseSteps: steps });
  j.progress('working', `The update to ${plan.version} did not work (${failure}). Putting version ${plan.from} back…`, { stepNow: 'rollback' });
  say(`NOT UPDATED — ${failure}.`);
  say(`PUTTING VERSION ${plan.from} BACK, by itself. The shop's data is not touched.`);
  if (steps.length > 0) say(`  WARNING — ${steps.join('; ')}. The old version is put back all the same (the shop must not stay down); the checks below say whether it works.`);
  await putBack(deps, L, P, plan, j, steps);
  return 1;
}

/** The PC's checks after an install, by the installed program itself (P.app). Undefined when all pass, else what failed. Also the rollback drill's (step 3e). */
export async function theChecks(deps, L, P, version) {
  const { fs } = deps;
  const p = pathFor(deps.platform);
  const rel = readJson(fs, p.join(P.app, RELEASE_MARKER));
  if (rel?.version !== version) return `the program folder says version ${rel?.version ?? 'unknown'}, not ${version}`;
  const st = deps.spawn(P.nodeOf(P.app), [P.toolOf(P.app), 'services-status'], { cwd: P.app, env: deps.env });
  if (!ran(st)) return `the store computer's check (services-status) did not pass: ${String(st.stdout ?? '').split(/\r?\n/).filter((l) => /^(FIX|MISSING)/.test(l.trim())).map((l) => l.trim()).join(' / ') || firstLine(st)}`;
  if (!(await tillAnswers(deps, L))) return 'the till\'s screens did not answer';
  return undefined;
}

/** Put the kept release back over the program folder, run its own setup, check. Says and writes down the outcome. */
async function putBack(deps, L, P, plan, j, steps) {
  const { say } = deps;
  const p = pathFor(deps.platform);
  await stopServices(deps);
  const m = mirror(deps, plan.kept, P.app);
  const fail = (why) => {
    j.step('rollback', `FAILED: ${why}`);
    j.progress('rollback-failed', `The update to ${plan.version} did not work, and version ${plan.from} could NOT be put back by itself: ${why}. The till may not work. Call for help now; the backup taken first is ${plan.backupId}.`, { stepNow: 'rollback', backupId: plan.backupId });
    say(`NOT PUT BACK — ${why}.`);
    say(`  A PERSON IS NEEDED NOW. Restart the PC; if the till does not come back, run ${p.join(plan.kept, 'runtime', 'node', 'node.exe')} "${p.join(plan.kept, 'scripts', 'store-computer.mjs')}" setup as administrator, and send me a photo of this screen. The backup taken first is ${plan.backupId}.`);
    return 'failed';
  };
  if (!m.ok) return fail(`the kept copy ${plan.kept} could not be put back over ${P.app} (${m.said})`);
  j.step('rollback', 'program put back', { from: plan.kept });
  const setup = deps.spawn(P.nodeOf(P.app), [P.toolOf(P.app), 'setup'], { cwd: P.app, env: deps.env, timeout: SETUP_WAIT_MS });
  if (!ran(setup)) return fail(`version ${plan.from}'s own setup did not finish (${firstLine(setup)})`);
  const failure = await theChecks(deps, L, P, plan.from);
  if (failure !== undefined) return fail(failure);
  j.step('rollback', 'put back and checked');
  const warn = steps.length === 0 ? '' : ' Its database steps differ from the new version\'s, so send a photo of this page today.';
  j.progress('rolled-back', `The update to ${plan.version} did not work. Version ${plan.from} was put back by itself and every check passed. The shop's data was not touched.${warn} Nothing else needs doing now.`, { stepNow: 'done', backupId: plan.backupId, ...(steps.length === 0 ? {} : { databaseSteps: steps }) });
  say(`PUT BACK — version ${plan.from} runs again, and every check passed. The shop's data was not touched. The backup taken first is ${plan.backupId}.`);
  return 'put-back';
}
