// CR-01 step 2c · OI-08 — MOVING A DOCKER COPY ONTO WINDOWS SERVICES, every record, setting and person kept.
//
// Run by `setup` (SRE-Setup.exe) on a store PC that was set up with Docker (the owner's own, 5–8 Nov 2026). In order:
//   1. Docker must be running, and the demo is never here (G4);
//   2. the till started at sign-in is stopped, then the office (API) container: nothing writes to the database after this;
//   3. ONE consistent snapshot of the database is taken and counted — the very method the hourly backup uses (GT-07);
//   4. the Docker copy is STOPPED, never removed: its storage (sre-real_db-data) stays on this PC, untouched, as the way back;
//   5. the three Windows services are installed and, before the office starts, the snapshot is restored into the new
//      database and COUNTED AGAIN: every table's rows, the money in every kind of event, the newest event's number;
//   6. only when everything matches: the move is recorded (run\services\adopted-from-docker.json), the old sign-in task is
//      removed (Windows starts the services now), and the plain snapshot is deleted.
// If anything does not match, or a step fails after Docker was stopped: the services are removed, the half-filled
// database folder is moved aside (never deleted) and the Docker copy is started again — the shop is as it was. Nothing
// of the shop's data is ever deleted by this module (hard rule #6).

import { composeEnv, dockerProblem, lines, pathFor, stampOf, DEMO_PROJECT, PROJECT } from './store-computer.mjs';
import { backupScript, parseTotals, psqlArgs, ready, reconcile, startsWithMagic, totalsScript } from './store-computer-recovery.mjs';
import { dbSpawn, readServicesMarker } from './store-computer-db.mjs';
import { installServices, removeServices } from './store-computer-services.mjs';
import { runningTill, tasksFor, TASKS } from './store-computer-schedule.mjs';

export const ADOPTED_MARKER = 'adopted-from-docker.json';
export const adoptedMarkerPath = (platform, dataRoot) => pathFor(platform).join(dataRoot, 'run', 'services', ADOPTED_MARKER);

/** Does this PC hold a Docker copy of this shop (its storage), not yet moved? */
export function dockerCopyToMove(deps, L) {
  if (L?.dataRoot === undefined) return false;
  if (deps.fs.existsSync(adoptedMarkerPath(deps.platform, L.dataRoot))) return false;
  if (readServicesMarker(deps, L) !== undefined) return false;
  const v = deps.spawn('docker', ['volume', 'ls', '--format', '{{.Name}}'], {});
  if (v.error !== undefined || v.status !== 0) return false;
  return lines(v.stdout).includes(`${PROJECT}_db-data`);
}

/**
 * Where the Docker copy was MADE: the folder and compose files Docker itself recorded on the copy's containers
 * (labels com.docker.compose.project.working_dir and .config_files). Found on the owner's PC, 10 Nov 2026: the copy was
 * made from the release folder used in November, not from the installed program, whose folder has no compose file —
 * so the move must speak to Docker with the copy's OWN files. undefined (with why) when they cannot be found.
 */
export function dockerCopyMadeFrom(deps) {
  const r = deps.spawn('docker', ['ps', '-a', '--filter', `label=com.docker.compose.project=${PROJECT}`, '--format', '{{.Label "com.docker.compose.project.working_dir"}}|{{.Label "com.docker.compose.project.config_files"}}'], {});
  if (r.error !== undefined || r.status !== 0) return { problem: 'Docker did not list the shop\'s containers' };
  const first = lines(r.stdout).map((l) => l.trim()).find((l) => l !== '' && l !== '|');
  if (first === undefined) return { problem: 'Docker has no container of the shop that says where it was made' };
  const [dir, list] = first.split('|');
  const files = String(list ?? '').split(',').map((f) => f.trim()).filter((f) => f !== '');
  if (!dir || files.length === 0) return { problem: 'Docker has no container of the shop that says where it was made' };
  const missing = [dir, ...files].find((f) => !deps.fs.existsSync(pathFor(deps.platform).isAbsolute(f) ? f : pathFor(deps.platform).join(dir, f)));
  if (missing !== undefined) return { problem: `the folder the Docker copy was made from is not on this PC any more (${missing})` };
  return { dir, files };
}

/** The `docker compose` words for the copy, with its own files and this PC's settings. */
export const madeFromCompose = (L, made) => ['compose', '-p', PROJECT, ...made.files.flatMap((f) => ['-f', f]), '--env-file', L.settings];

const said = (r) => lines(`${r.stdout ?? ''}\n${r.stderr ?? ''}`).slice(-3).join(' / ');

/** Move the Docker copy onto the Windows services. 0 done · 1 not done (the shop is put back as it was) · 2 refused. */
export async function adoptDockerCopy(deps, opts) {
  const { say, fs } = deps;
  const p = pathFor(deps.platform);
  const ctx = ready(deps);
  if (ctx.code !== undefined) return ctx.code;
  const L = ctx.L;
  say('This PC\'s shop runs in Docker. It is moved onto Windows services now, with every record, setting and person kept.');

  // 1 — Docker running; never the demo.
  const docker = dockerProblem(deps);
  if (docker !== undefined) { say(`REFUSED — ${docker.what} Docker is needed once more, to take the shop's data out of it. Nothing was changed.`); say(`  What to do: ${docker.fix}`); return 2; }
  const demo = lines(deps.spawn('docker', ['ps', '-a', '--filter', `label=com.docker.compose.project=${DEMO_PROJECT}`, '--format', '{{.Names}}'], {}).stdout);
  if (demo.length > 0) { say(`REFUSED — the demo's containers (project ${DEMO_PROJECT}) are on this computer (gate G4). Nothing was changed.`); return 2; }
  // Docker is spoken to with the copy's OWN compose files, from the folder it was made in — found before anything stops.
  const made = dockerCopyMadeFrom(deps);
  if (made.problem !== undefined) { say(`REFUSED — ${made.problem}. Nothing was changed; the till and the shop run as before. Send me a photo of this screen.`); return 2; }
  say(`The Docker copy was made from ${made.dir}; it is spoken to with its own files.`);
  const base = madeFromCompose(L, made);
  const compose = (args) => deps.spawn('docker', [...base, ...args], { cwd: made.dir, env: composeEnv(deps.env, ctx.settings) });
  const dctx = { ...ctx, compose: { base, dir: made.dir } };

  // 2 — Nothing writes any more: the till first, then the office.
  const till = runningTill(deps, L);
  if (till !== undefined) { deps.killProcess(till.pid); say(`The till started at sign-in (process ${till.pid}) is stopped for the move; the till service takes its place.`); }
  // A move that stops before Docker is stopped gives the till back: the sign-in start runs again (the old release is
  // still the live one), or the person is told to restart.
  const tillBack = () => {
    if (till === undefined) return;
    const tasks = tasksFor(deps, L);
    const ran = tasks?.run !== undefined && tasks.exists(TASKS.start) ? tasks.run(TASKS.start) : undefined;
    say(ran?.ok ? '  The till is started again, as it was.' : '  Restart the computer to bring the till back (the sign-in start is still there).');
  };
  const db = compose(['up', '-d', '--wait', 'db']);
  if (db.error !== undefined || db.status !== 0) { say(`NOT DONE — the Docker copy's database did not start: ${said(db)}. Nothing was changed.`); tillBack(); say('  Send me a photo of this screen.'); return 1; }
  compose(['stop', 'api']);

  // 3 — One snapshot, counted: the hourly backup's own method.
  const work = p.join(L.scratchDir, `move-from-docker-${stampOf(deps.now())}`);
  fs.mkdirSync(work, { recursive: true });
  const dump = p.join(work, 'database.dump');
  const fd = fs.openSync(dump, 'wx', 0o600);
  let r;
  try { r = dbSpawn(deps, dctx, 'psql', psqlArgs(ctx.user, ctx.database), { input: backupScript({ user: ctx.user, database: ctx.database }), stdio: ['pipe', fd, 'pipe'] }); } finally { fs.closeSync(fd); }
  const expected = parseTotals(r.stderr ?? '');
  if (r.status !== 0 || expected.dumpExit !== 0 || !expected.done || !startsWithMagic(fs, dump)) {
    say(`NOT DONE — the shop's data could not be taken out of Docker: ${expected.other.slice(-2).join(' / ') || said(r) || 'no reason given'}. Nothing was changed.`);
    compose(['up', '-d', 'api']);
    tillBack();
    return 1;
  }
  const rows = Object.values(expected.rowCounts).reduce((a, b) => a + b, 0);
  say(`The shop's data is taken out of Docker in one snapshot: ${Object.keys(expected.rowCounts).length} tables, ${rows} rows, newest event number ${expected.maxEventSeq ?? 0}.`);

  // 4 — The Docker copy is stopped. Its storage stays.
  const stopped = compose(['stop']);
  if (stopped.error !== undefined || stopped.status !== 0) { say(`NOT DONE — the Docker copy would not stop: ${said(stopped)}. Nothing else was changed.`); compose(['up', '-d', 'db', 'api']); tillBack(); return 1; }
  say(`The Docker copy is stopped. Its storage (${PROJECT}_db-data) is KEPT on this PC, untouched — it is the way back.`);

  // A database folder left by an earlier move that did not finish is moved aside, never deleted.
  const dbDir = p.join(L.dataRoot, 'database');
  if (fs.existsSync(dbDir) && fs.readdirSync(dbDir).length > 0) {
    const aside = `${dbDir}-unfinished-${stampOf(deps.now())}`;
    fs.renameSync(dbDir, aside);
    say(`An earlier, unfinished move left ${dbDir}; it is moved aside to ${aside} (kept).`);
  }

  // 5 — The services, with the snapshot restored and counted before the office starts.
  const restoreAndCount = async (native) => {
    const nctx = { ...ctx, native };
    const dfd = fs.openSync(dump, 'r');
    let restored;
    try { restored = dbSpawn(deps, nctx, 'pg_restore', ['-U', ctx.user, '-d', ctx.database, '--exit-on-error', '--single-transaction'], { stdio: [dfd, 'pipe', 'pipe'] }); } finally { fs.closeSync(dfd); }
    if (restored.error !== undefined || restored.status !== 0) { say(`NOT DONE — the shop's data could not be put into the new database: ${said(restored)}`); return 1; }
    const counted = dbSpawn(deps, nctx, 'psql', psqlArgs(ctx.user, ctx.database), { input: `${totalsScript().join('\n')}\n` });
    const got = parseTotals(counted.stdout ?? '');
    const differences = counted.status === 0 ? reconcile(expected, got) : ['the new database could not be counted'];
    if (differences.length > 0) {
      say('NOT DONE — the new database does not match the Docker copy:');
      for (const d of differences.slice(0, 10)) say(`  ${d}`);
      return 1;
    }
    say(`MATCHED — the new database holds exactly what the Docker copy held: every table's rows, the money in every kind of event, newest event number ${got.maxEventSeq ?? 0}.`);
    return 0;
  };
  const installed = await installServices(deps, { pgBin: opts.pgBin, serviceHost: opts.serviceHost, afterDatabase: restoreAndCount });
  if (installed !== 0) {
    say('PUTTING THE SHOP BACK AS IT WAS — the services are removed, the new database folder is moved aside (kept), and the Docker copy is started again.');
    await removeServices(deps);
    if (fs.existsSync(dbDir)) { const aside = `${dbDir}-unfinished-${stampOf(deps.now())}`; try { fs.renameSync(dbDir, aside); say(`  The new database folder is kept at ${aside}.`); } catch { say(`  The new database folder ${dbDir} could not be moved aside; it is kept where it is.`); } }
    try { fs.rmSync(p.join(L.dataRoot, 'run', 'services', 'database.json'), { force: true }); } catch { /* the marker is rewritten by the next install */ }
    const back = compose(['up', '-d', 'db', 'migrate', 'api']);
    if (back.status === 0) { say('  The Docker copy is running again.'); tillBack(); } else say(`  The Docker copy did not start again: ${said(back)}. Open Docker Desktop and restart the computer.`);
    say(`  The snapshot taken for the move is kept at ${dump} (this PC only; the data folder is locked). Send me a photo of this screen.`);
    return 1;
  }

  // 6 — Recorded; the old sign-in start removed; the plain snapshot deleted.
  fs.writeFileSync(adoptedMarkerPath(deps.platform, L.dataRoot), `${JSON.stringify({ kind: 'sre-moved-from-docker', version: 1, movedAt: deps.now().toISOString(), from: `${PROJECT} (Docker)`, keptDockerStorage: `${PROJECT}_db-data`, tables: Object.keys(expected.rowCounts).length, rows, maxEventSeq: expected.maxEventSeq ?? 0 }, null, 2)}\n`, 'utf8');
  const tasks = tasksFor(deps, L);
  if (tasks !== undefined && tasks.exists(TASKS.start)) {
    const t = tasks.remove(TASKS.start);
    say(t.ok ? `The old sign-in start "${TASKS.start}" is removed: Windows starts the services now, before anyone signs in.` : `The old sign-in start "${TASKS.start}" could not be removed (${t.said}); it now only says there is nothing to start.`);
  }
  fs.rmSync(work, { recursive: true, force: true });
  say('MOVED — the shop runs as Windows services, with everything it had. Docker Desktop is no longer used; its copy is kept, stopped.');
  return 0;
}
