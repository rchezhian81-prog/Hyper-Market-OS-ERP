// Updating must never lose data — audit row 9 (lane B B11 · lane C C-12; hard rules #1, #2, #6).
//
//   migrate-data-folder        moves a copy set up the first way (settings, records and the till's data INSIDE the release
//                              folder) into the shop's data folder (C:\SRE-data): every file copied, its SHA-256 checked,
//                              the settings file last — and only then the old places renamed "…moved-to-data-folder-<time>"
//                              (never deleted). The till's start scripts are rewritten to read the data folder.
//   update --from <folder>     installs a new release from its own, freshly extracted folder: checks it is a complete,
//                              compatible release holding no shop data; takes an encrypted backup first; stops the till
//                              this tool started (or asks you to close it); installs and builds the new release; starts it
//                              on the SAME data; makes it the release the Windows tasks run; starts the till; checks.
//
// ── Why a new release goes in its OWN folder, not over C:\SRE ─────────────────────────────────────────────────────
// Two things on Windows make "replace C:\SRE" unsafe even with the data moved out: (1) the database container keeps a
// bind mount of the release folder's infra\compose\db-init, and Docker re-creates it from that path after every restart —
// a renamed or deleted folder stops the database from starting; (2) a folder PowerShell or the till is running from cannot
// be renamed. So each release has its own folder (C:\SRE, then for example C:\SRE-2026-11), the data folder never moves,
// and run\current-release.json says which release is live. The release before the live one is the rollback drill's
// --previous; only older ones may be deleted.

import { createHash } from 'node:crypto';
import {
  bothLayouts, composeBase, dataRootOnDrive, ensureDataFolder, layout, parseEnvText, pathFor, PROJECT, refusals, sameFolder, stampOf,
  waitReady, writeDataPointer,
} from './store-computer.mjs';
import { refusedOnServer } from './store-computer-windows.mjs';
import {
  dataFolderReady, ensureBackupKey, folderRefusal, migrationProblems, migrationsOf, ready, recordBackupOutcome, releaseId,
  takeStoreBackup, tillFolders, DRILL_READY_WAIT_MS,
} from './store-computer-recovery.mjs';
import { readSchedule, status } from './store-computer-status.mjs';
import { currentRelease, runningTill, startTill, tasksFor, TASKS, writeLauncher } from './store-computer-schedule.mjs';
import { renderStartScript } from '../install-till.mjs';

const sha256File = (fs, f) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const inside = (p, root, x) => { const r = p.relative(root, x); return r === '' || (!r.startsWith('..') && !p.isAbsolute(r)); };

/** Every file under a folder, relative ('/'-separated). */
function filesUnder(fs, p, dir) {
  const out = [];
  const walk = (rel) => {
    const abs = rel === '' ? dir : p.join(dir, ...rel.split('/'));
    for (const n of fs.readdirSync(abs).map(String).sort()) {
      const r = rel === '' ? n : `${rel}/${n}`;
      if (fs.statSync(p.join(abs, n)).isDirectory()) walk(r); else out.push(r);
    }
  };
  if (fs.existsSync(dir)) walk('');
  return out;
}

/** The till's settings with its folders pointed at the data folder, and the status file named. Values otherwise kept. */
export function rewriteTillEnv(text, { edgeData, witness, statusFile, deviceTls }) {
  // OB-422: the handheld door's lock moves with the till's folders (on this computer only) and is named, so it is never lost.
  const set = { EDGE_DATA_DIR: edgeData, EDGE_WITNESS_DIR: witness, EDGE_STORE_COMPUTER_STATUS_FILE: statusFile, ...(deviceTls === undefined ? {} : { EDGE_DEVICE_TLS_DIR: deviceTls }) };
  const done = new Set();
  const out = String(text).split(/\r?\n/).map((raw) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || !line.includes('=')) return raw;
    const k = line.slice(0, line.indexOf('=')).trim();
    if (!(k in set)) return raw;
    done.add(k);
    return `${k}=${set[k]}`;
  });
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
  for (const k of Object.keys(set)) if (!done.has(k)) out.push(...(k === 'EDGE_STORE_COMPUTER_STATUS_FILE' ? ['# The store computer\'s own check (store-computer status): the office screens show its red banner.'] : []), `${k}=${set[k]}`);
  return `${out.join('\n')}\n`;
}

/**
 * `migrate-data-folder [--data-drive F:]`: move the shop's data out of the release folder, checked file by file — into
 * the data folder on the drive named (OB-283), whose place is then recorded. A copy whose data folder is already set up
 * on one drive is moved WHOLE to the drive named (`moveDataFolder`).
 */
export async function migrateDataFolder(given, opts = {}) {
  const { say, fs } = given;
  let deps = given;
  if (opts.dataDrive !== undefined) {
    if (given.dataPointer === undefined) { say('REFUSED — this computer has no place to record where the data folder is. Send me a photo of this screen.'); return 2; }
    const t = dataRootOnDrive(given, opts.dataDrive);
    if (t.problem !== undefined) { say(`REFUSED — ${t.problem}. Nothing was moved.`); return 2; }
    const now = bothLayouts(given);
    if (now.data !== undefined && fs.existsSync(now.data.settings)) {
      if (sameFolder(given.platform, now.data.dataRoot, t.dataRoot)) { say(`Nothing to move — this copy already uses the shop's data folder ${t.dataRoot}.`); return 0; }
      return moveDataFolder(given, now.data, t.dataRoot);
    }
    deps = { ...given, dataRoot: t.dataRoot };
  }
  const p = pathFor(deps.platform);
  const { legacy, data } = bothLayouts(deps);
  if (data === undefined) { say('REFUSED — this computer has no data folder named. Send me a photo of this screen.'); return 2; }
  const haveOld = fs.existsSync(legacy.settings);
  const haveNew = fs.existsSync(data.settings);
  if (haveOld && haveNew) { say(`REFUSED — there are two settings files: ${legacy.settings} and ${data.settings}. Nothing was moved. Send me a photo of this screen (never of the files).`); return 2; }
  if (haveNew) { say(`Nothing to move — this copy already uses the shop's data folder ${data.dataRoot}.`); return 0; }
  if (!haveOld) { say('REFUSED — there is no settings file to move. A new copy is set up straight into the data folder: pnpm run store-computer -- prepare'); return 2; }
  if (inside(p, deps.repoRoot, data.dataRoot)) { say(`REFUSED — the data folder ${data.dataRoot} is inside the system's own folder. It must be beside it.`); return 2; }
  const settings = parseEnvText(fs.readFileSync(legacy.settings, 'utf8'));
  const stop = refusals(settings, deps.env);
  if (stop.length > 0) { for (const r of stop) say(`REFUSED — ${r}`); return 2; }

  // The till must not be running: its files are open, and a sale written during the copy would be in the old place only.
  const oldTill = tillFolders(deps, legacy);
  const screenPort = Number(oldTill.env?.EDGE_SCREEN_PORT || 8091);
  if (oldTill.installed && ((await deps.portInUse(oldTill.lanePort)) || (await deps.portInUse(screenPort)))) {
    say(`REFUSED — the till is running (port ${oldTill.lanePort} or ${screenPort} answers). Close the till's black window (start-till) first, then run this again. Nothing was moved.`);
    return 2;
  }

  ensureDataFolder(deps, data);
  // OB-283: the data folder's place is recorded before anything is copied. Until its settings file is there, every
  // command still finds this copy in the old place (resolveLayout), so a stop half-way changes nothing.
  writeDataPointer(deps, data.dataRoot, 'migrate-data-folder');
  const stamp = stampOf(deps.now());
  const edgeDataNew = p.join(data.tillDir, 'edge-data');
  const witnessNew = p.join(data.tillDir, 'edge-witness');
  const deviceTlsNew = p.join(data.tillDir, 'edge-data-device-tls');
  // What moves: folders inside the release folder only. A till folder already outside it is left exactly where it is.
  const moves = [];
  const folder = (from, to, what) => { if (fs.existsSync(from) && inside(p, deps.repoRoot, from)) moves.push({ from, to, what }); };
  folder(legacy.records, data.records, 'the check records');
  if (oldTill.installed) {
    folder(oldTill.edgeData, edgeDataNew, "the till's data (sales, queue, dead letters, PIN checks)");
    folder(oldTill.witness, witnessNew, "the till's bill-number witness");
    folder(oldTill.deviceTls, deviceTlsNew, "the handheld door's lock (it stays on this computer)");
  }
  const made = [];
  const copied = [];
  try {
    for (const m of moves) {
      for (const relPath of filesUnder(fs, p, m.from)) {
        const src = p.join(m.from, ...relPath.split('/'));
        const dst = p.join(m.to, ...relPath.split('/'));
        fs.mkdirSync(p.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst, fs.constants?.COPYFILE_EXCL ?? 1);
        made.push(dst);
        if (sha256File(fs, src) !== sha256File(fs, dst)) throw new Error(`the copy of ${src} is not the same as the original`);
        copied.push(relPath);
      }
    }
    if (oldTill.installed) {
      const edgeData = moves.some((m) => m.from === oldTill.edgeData) ? edgeDataNew : oldTill.edgeData;
      const witness = moves.some((m) => m.from === oldTill.witness) ? witnessNew : oldTill.witness;
      const deviceTls = moves.some((m) => m.from === oldTill.deviceTls) ? deviceTlsNew : oldTill.deviceTls;
      fs.mkdirSync(data.tillDir, { recursive: true });
      fs.writeFileSync(data.tillEnv, rewriteTillEnv(fs.readFileSync(legacy.tillEnv, 'utf8'), { edgeData, witness, statusFile: data.statusFile, deviceTls }), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      made.push(data.tillEnv);
    }
    // The settings file LAST: until it is in the data folder, every command still uses the old place.
    fs.copyFileSync(legacy.settings, data.settings, fs.constants?.COPYFILE_EXCL ?? 1);
    made.push(data.settings);
    if (sha256File(fs, legacy.settings) !== sha256File(fs, data.settings)) throw new Error('the copy of the settings file is not the same as the original');
  } catch (e) {
    // The originals were only read. Take back the partial copies, so a second try starts clean.
    for (const f of made.reverse()) { try { fs.rmSync(f, { force: true }); } catch { /* left; the next try names it */ } }
    say(`NOT DONE — ${e instanceof Error ? e.message : String(e)}. Nothing was moved: everything is still in the old place, exactly as it was. Send me a photo of this screen.`);
    return 1;
  }

  // Every copy is checked. Only now are the old places renamed — kept, never deleted, until the old release goes.
  const renamed = [];
  const keep = (x) => { if (fs.existsSync(x)) { const to = `${x}.moved-to-data-folder-${stamp}`; fs.renameSync(x, to); renamed.push(to); } };
  for (const m of moves) keep(m.from);
  if (oldTill.installed) keep(legacy.tillEnv);
  keep(legacy.settings);

  // The till's start scripts, in this release, now read the till's settings from the data folder.
  if (oldTill.installed) {
    fs.mkdirSync(legacy.releaseTill, { recursive: true });
    fs.writeFileSync(p.join(legacy.releaseTill, 'start-till.cmd'), renderStartScript('win32', { repoRoot: deps.repoRoot, tillEnvPath: data.tillEnv, platformPath: p }));
    fs.writeFileSync(p.join(legacy.releaseTill, 'start-till.sh'), renderStartScript('linux', { repoRoot: deps.repoRoot, tillEnvPath: data.tillEnv, platformPath: p }), { mode: 0o755 });
  }
  say(`MOVED — this copy's data is now in the shop's data folder ${data.dataRoot}:`);
  say(`  the settings file (${data.settings})${oldTill.installed ? ", the till's settings and its start scripts" : ''}`);
  for (const m of moves) say(`  ${m.what}`);
  say(`  ${copied.length + 1 + (oldTill.installed ? 1 : 0)} file(s), each copied and checked by its SHA-256 before anything was renamed.`);
  say('  The old places are renamed, not deleted (they go when this release folder goes):');
  for (const r of renamed) say(`    ${r}`);
  say('Next: start the till again (double-click till\\start-till.cmd, or set up autostart), then run: pnpm run store-computer -- status');
  return 0;
}

// ── The whole data folder to another internal drive (OB-283) ─────────────────────────────────────────────────────

/**
 * Move a data folder that is already set up (C:\SRE-data) WHOLE to another internal drive (F:\SRE-data): every file
 * copied and checked by its SHA-256, the till's settings rewritten to the new place, the settings file last, the new
 * place recorded — and only then the old folder renamed "…moved-to-F-<time>", never deleted. Refused while the till
 * runs or while the Windows tasks (which run from the data folder) are on. Docker's disk image is moved in Docker
 * Desktop itself (guide Part 2): the database lives there, not in this folder.
 */
export async function moveDataFolder(deps, from, toRoot) {
  const { say, fs } = deps;
  const p = pathFor(deps.platform);
  const to = layout(deps.repoRoot, deps.platform, toRoot);
  const settings = parseEnvText(fs.readFileSync(from.settings, 'utf8'));
  const stop = refusals(settings, deps.env);
  if (stop.length > 0) { for (const r of stop) say(`REFUSED — ${r}`); return 2; }
  if (inside(p, deps.repoRoot, toRoot)) { say(`REFUSED — ${toRoot} is inside the system's own folder. Nothing was moved.`); return 2; }
  if (inside(p, from.dataRoot, toRoot) || inside(p, toRoot, from.dataRoot)) { say(`REFUSED — ${toRoot} and ${from.dataRoot} are one inside the other. Nothing was moved.`); return 2; }
  if (fs.existsSync(toRoot) && fs.readdirSync(toRoot).length > 0) { say(`REFUSED — ${toRoot} is already there and not empty. Nothing was moved. Send me a photo of this screen (never of the files).`); return 2; }

  const tasks = tasksFor(deps, from);
  const on = tasks === undefined ? [] : Object.values(TASKS).filter((n) => tasks.exists(n));
  if (on.length > 0) {
    say(`REFUSED — the Windows tasks ${on.map((n) => `"${n}"`).join(', ')} run from ${from.runDir}. Nothing was moved.`);
    say('  Turn them off first: pnpm run store-computer -- unschedule-backup  and  pnpm run store-computer -- autostart --off');
    say('  Then run this again, and afterwards set them up again (guide Part 14, step 1 and Part 28, step 1).');
    return 2;
  }
  const till = tillFolders(deps, from);
  const screenPort = Number(till.env?.EDGE_SCREEN_PORT || 8091);
  if (till.installed && ((await deps.portInUse(till.lanePort)) || (await deps.portInUse(screenPort)))) {
    say(`REFUSED — the till is running (port ${till.lanePort} or ${screenPort} answers). Close the till first: restart the PC, sign in as yourself and run this again straight away (with autostart off, nothing starts the till). Nothing was moved.`);
    return 2;
  }

  const stamp = stampOf(deps.now());
  const mapped = (x) => (inside(p, from.dataRoot, x) ? p.join(toRoot, p.relative(from.dataRoot, x)) : x);
  const skip = new Set([p.relative(from.dataRoot, from.settings), ...(till.installed ? [p.relative(from.dataRoot, from.tillEnv)] : [])].map((r) => r.split(p.sep).join('/')));
  const files = filesUnder(fs, p, from.dataRoot).filter((r) => !skip.has(r) && !r.startsWith('scratch/'));
  const made = [];
  try {
    fs.mkdirSync(toRoot, { recursive: true });
    for (const relPath of files) {
      const src = p.join(from.dataRoot, ...relPath.split('/'));
      const dst = p.join(toRoot, ...relPath.split('/'));
      fs.mkdirSync(p.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst, fs.constants?.COPYFILE_EXCL ?? 1);
      made.push(dst);
      if (sha256File(fs, src) !== sha256File(fs, dst)) throw new Error(`the copy of ${src} is not the same as the original`);
    }
    if (till.installed) {
      fs.mkdirSync(to.tillDir, { recursive: true });
      fs.writeFileSync(to.tillEnv, rewriteTillEnv(fs.readFileSync(from.tillEnv, 'utf8'), { edgeData: mapped(till.edgeData), witness: mapped(till.witness), statusFile: to.statusFile, deviceTls: mapped(till.deviceTls) }), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      made.push(to.tillEnv);
    }
    // The settings file LAST, then the record of the new place: until both are there, every command uses the old folder.
    fs.copyFileSync(from.settings, to.settings, fs.constants?.COPYFILE_EXCL ?? 1);
    made.push(to.settings);
    if (sha256File(fs, from.settings) !== sha256File(fs, to.settings)) throw new Error('the copy of the settings file is not the same as the original');
    writeDataPointer(deps, toRoot, 'migrate-data-folder');
  } catch (e) {
    for (const f of made.reverse()) { try { fs.rmSync(f, { force: true }); } catch { /* left; the next try names it */ } }
    try { writeDataPointer(deps, from.dataRoot, 'migrate-data-folder (put back)'); } catch { /* the note was not changed */ }
    say(`NOT DONE — ${e instanceof Error ? e.message : String(e)}. Nothing was moved: this copy still uses ${from.dataRoot}, exactly as it was. Send me a photo of this screen.`);
    return 1;
  }

  // The till's start scripts, in this release, now read the till's settings from the new place.
  if (till.installed) {
    fs.mkdirSync(from.releaseTill, { recursive: true });
    fs.writeFileSync(p.join(from.releaseTill, 'start-till.cmd'), renderStartScript('win32', { repoRoot: deps.repoRoot, tillEnvPath: to.tillEnv, platformPath: p }));
    fs.writeFileSync(p.join(from.releaseTill, 'start-till.sh'), renderStartScript('linux', { repoRoot: deps.repoRoot, tillEnvPath: to.tillEnv, platformPath: p }), { mode: 0o755 });
  }
  const letter = /^([A-Za-z]):/.exec(toRoot)?.[1]?.toUpperCase();
  const keptAs = `${from.dataRoot.replace(/[\\/]+$/, '')}.moved-to-${letter ?? 'new-drive'}-${stamp}`;
  let kept = keptAs;
  try { fs.renameSync(from.dataRoot, keptAs); } catch { kept = undefined; }
  say(`MOVED — this copy's data is now in ${toRoot}: ${files.length + 1 + (till.installed ? 1 : 0)} file(s), each copied and checked by its SHA-256 first.`);
  say(`  Where the data folder is, is recorded in ${deps.dataPointer}: every command finds it there from now on.`);
  say(kept === undefined
    ? `  The old folder ${from.dataRoot} could not be renamed (a program has a file in it open). Nothing reads it now; it is kept as it is. Restart the PC and send me a photo of this screen.`
    : `  The old folder is renamed, not deleted: ${kept}. It still holds this copy's secrets — keep it locked (guide Part 26c) and ask me before you remove it.`);
  say(`Next: lock the new folder (guide Part 26c, step 1, with ${toRoot}), start the till again, then run: pnpm run store-computer -- status`);
  return 0;
}

// ── update ────────────────────────────────────────────────────────────────────────────────────────────────────────

const samePath = (platform, a, b) => (platform === 'win32' ? String(a).toLowerCase() === String(b).toLowerCase() : a === b);

/** Is `folder` a new release that can be installed over this copy's data? Returns the problems (none = yes). */
export function releaseProblems(deps, folder) {
  const { fs } = deps;
  const p = pathFor(deps.platform);
  const problems = [];
  if (samePath(deps.platform, folder, deps.repoRoot)) return [`--from names this release's own folder (${folder}). Extract the NEW release's ZIP into its own folder, for example C:\\SRE-2026-11.`];
  if (inside(p, deps.repoRoot, folder)) return [`--from (${folder}) is inside this release's folder. Extract the new release beside it, for example C:\\SRE-2026-11.`];
  if (deps.dataRoot !== undefined && inside(p, deps.dataRoot, folder)) return [`--from (${folder}) is inside the shop's data folder. Extract the new release in its own folder.`];
  for (const f of [['infra', 'compose', 'docker-compose.yml'], ['scripts', 'lib', 'store-computer.mjs'], ['scripts', 'install-till.mjs'], ['package.json'], ['db', 'migrations']]) {
    if (!fs.existsSync(p.join(folder, ...f))) problems.push(`${folder} is not a complete release (${p.join(...f)} is missing). Extract the whole ZIP there.`);
  }
  if (problems.length > 0) return problems;
  for (const f of [['infra', 'compose', '.env.real'], ['till', 'till.env'], ['till', 'edge-data']]) {
    if (fs.existsSync(p.join(folder, ...f))) problems.push(`the new release folder holds shop data (${p.join(...f)}). It must be a fresh extract of the ZIP — never a copy of this one.`);
  }
  problems.push(...migrationProblems(migrationsOf(fs, deps.platform, deps.repoRoot), migrationsOf(fs, deps.platform, folder)).map((x) => x.replace('the previous release', 'this release').replace('going back is not safe', 'the new release does not continue this one')));
  if (problems.length === 0 && releaseId(fs, deps.platform, folder) === releaseId(fs, deps.platform, deps.repoRoot)) problems.push('the new folder holds the same release as this one — there is nothing to update.');
  return problems;
}

/** `update --from <new release folder> [--to <backup drive folder>]`. */
export async function update(deps, opts) {
  const { say } = deps;
  const p = pathFor(deps.platform);
  if (refusedOnServer(deps)) return 2; // OB-282: nothing is ever installed on the shop's server
  const fromGiven = typeof opts.from === 'string' ? opts.from.trim() : '';
  if (fromGiven === '') { say('REFUSED — name the new release\'s folder: pnpm run store-computer -- update --from C:\\SRE-2026-11  (the ZIP extracted there, nothing else in it)'); return 2; }
  const from = p.resolve(fromGiven);
  const ctx = ready(deps);
  if (ctx.code !== undefined) return ctx.code;
  if (!dataFolderReady(deps, ctx)) return 2;
  const L = ctx.L;
  const live = currentRelease(deps, L)?.folder;
  if (live !== undefined && !samePath(deps.platform, live, deps.repoRoot)) { say(`REFUSED — the live release is ${live}, not this folder. Run update from there: open PowerShell in ${live}.`); return 2; }
  const problems = releaseProblems(deps, from);
  if (problems.length > 0) { for (const x of problems) say(`REFUSED — ${x}`); say('  Nothing was changed.'); return 2; }
  const execPath = String(deps.env.npm_execpath ?? '').trim();
  if (execPath === '') { say('REFUSED — run this through pnpm, so the new release can be installed: pnpm run store-computer -- update --from …'); return 2; }

  // 1. A backup first, to the drive that stays plugged in (or the one named).
  const to = typeof opts.to === 'string' && opts.to.trim() !== '' ? p.resolve(opts.to.trim()) : readSchedule(deps, L)?.to;
  if (to === undefined) { say('REFUSED — say where the backup before the update goes: add --to G:\\sre-auto (or set up the automatic backup first). Nothing was changed.'); return 2; }
  const refusal = folderRefusal(deps, to);
  if (refusal !== undefined) { say(`REFUSED — ${refusal}`); return 2; }
  const key = await ensureBackupKey(deps, L);
  if (key === undefined) return 1;
  say(`1. Backing up everything to ${to} before anything changes…`);
  const b = takeStoreBackup(deps, ctx, to, key);
  recordBackupOutcome(deps, L, { kind: 'before-update', to, ...b });
  if (!b.ok) { say(`NOT DONE — the backup before the update did not work: ${b.problem}. Nothing was changed.`); return 1; }
  say(`   BACKUP DONE — ${b.manifest.backupId}.`);

  // 2. The till stops: the one this tool started is stopped; one started by hand must be closed by hand.
  const till = tillFolders(deps, L);
  if (till.installed && (await deps.portInUse(till.lanePort))) {
    const rt = runningTill(deps, L);
    if (rt === undefined) { say(`REFUSED — the till is running in a window this tool did not open. Close the till's black window (start-till), then run update again. Nothing else was changed (the backup ${b.manifest.backupId} is kept).`); return 2; }
    say(`2. Stopping the till (process ${rt.pid}). Every sale it saved is already on disk; the till screen keeps what it has not yet handed over.`);
    deps.killProcess(rt.pid);
    for (let i = 0; i < 20 && (await deps.portInUse(till.lanePort)); i += 1) await deps.sleep(1_000);
    if (await deps.portInUse(till.lanePort)) { say('NOT DONE — the till did not stop. Restart the computer, then run update again. Nothing else was changed.'); return 1; }
  } else say('2. The till is not running.');

  // 3. The new release: its packages, its till build (on the same till settings), its containers.
  say(`3. Installing the new release in ${from} (this needs the internet once, for its packages)…`);
  const inst = deps.spawn(deps.nodePath, [execPath, 'install', '--frozen-lockfile'], { cwd: from, env: deps.env, stdio: 'inherit' });
  if (inst.error !== undefined || inst.status !== 0) return goBack(deps, ctx, 'the new release\'s packages could not be installed (the lines above say why)');
  if (till.installed) {
    const built = deps.spawn(deps.nodePath, [p.join(from, 'scripts', 'install-till.mjs'), '--settings', L.settings], { cwd: from, env: deps.env, stdio: 'inherit' });
    if (built.error !== undefined || built.status !== 0) return goBack(deps, ctx, 'the new release\'s till could not be built');
  }
  const newCompose = p.join(from, 'infra', 'compose');
  const up = deps.spawn('docker', [...composeBase(L), 'up', '-d', '--build', 'db', 'migrate', 'api'], { cwd: newCompose, env: ctx.env, stdio: 'inherit' });
  if (up.error !== undefined || up.status !== 0) return goBack(deps, ctx, 'Docker could not start the new release');
  if (!(await waitReady(deps, ctx.settings.API_PORT || '8081', DRILL_READY_WAIT_MS))) return goBack(deps, ctx, `the new release did not say ready within ${DRILL_READY_WAIT_MS / 60_000} minutes`);
  say(`   READY — the new release runs on this copy's own database (${PROJECT}), with the same settings.`);

  // 4. It is the live release now: the Windows tasks run it from here on. Then the till, from the new release.
  writeLauncher(deps, L, from, deps.repoRoot);
  const t = await startTill({ ...deps, repoRoot: from }, L);
  say(`4. ${t.ok ? 'TILL' : 'TILL NOT STARTED'} — ${t.detail}`);
  await status(deps, { quiet: true });
  say(`UPDATED — the shop system now runs from ${from}. The shop's data stayed in ${L.dataRoot}.`);
  say(`  From now on open PowerShell in ${from}.`);
  say(`  Keep ${deps.repoRoot}: it is now the PREVIOUS release (the rollback drill's --previous). Never delete the live or the previous release folder.`);
  say('Next: pnpm run store-computer -- status');
  return t.ok || !till.installed ? 0 : 1;
}

/** The new release did not come up: this release's containers are built and started again, so the shop is not left down. */
async function goBack(deps, ctx, why) {
  const { say } = deps;
  say(`NOT UPDATED — ${why}.`);
  say(`  Putting this release (${deps.repoRoot}) back: rebuilding and starting it on the same data. This needs the internet for the build.`);
  const back = deps.spawn('docker', [...composeBase(ctx.L), 'up', '-d', '--build', 'db', 'migrate', 'api'], { cwd: ctx.L.composeDir, env: ctx.env, stdio: 'inherit' });
  const okBack = back.error === undefined && back.status === 0 && (await waitReady(deps, ctx.settings.API_PORT || '8081', DRILL_READY_WAIT_MS));
  const t = await startTill(deps, ctx.L);
  say(okBack ? `  This release is running again. ${t.ok ? 'The till is running.' : `The till: ${t.detail}.`} The data was never changed by the update.` : '  THIS RELEASE DID NOT START AGAIN. Run: pnpm run store-computer -- up — and send me a photo of this screen.');
  await status(deps, { quiet: true });
  return 1;
}
