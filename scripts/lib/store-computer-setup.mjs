// The store computer's FIRST RUN, as one step — CR-01 step 2 (OI-01, OI-03, OI-08) on ADR-0032.
//
//   setup [--data-drive D:] [--lane lane-1] [--pg-bin <folder>] [--service-host <WinSW.exe>]
//
// What the setup program (SRE-Setup.exe) runs once its files are copied, and what the first-run screens will run (2b):
//   1. this copy's settings — made once, with a NEW tenant id made here (OI-03), never typed; or, when this PC already has
//      them (the data folder recorded, or found on the drive named), KEPT exactly as they are (OI-08);
//   2. the till, in the data folder (its settings kept when already there);
//   3. the shop database, the office API and the till as Windows services (install-services, step 1).
// Running it again is safe: nothing that is there is replaced. Every line it says is also kept in
// <ProgramData>\SRE\setup.log, so a person can read later what the setup program did. It never says a secret.
//
// In an installed release (release.json beside scripts/) the PostgreSQL programs and the service host come with it, in
// runtime\pgsql\bin and runtime\winsw — nothing is downloaded on the shop's PC (ADR-0032).

import { installServices } from './store-computer-services.mjs';
import { loadSettings, pathFor, prepare, resolveDataFolder, resolveLayout, sameFolder } from './store-computer.mjs';
import { dataDriveProblem, refusedOnServer } from './store-computer-windows.mjs';

/** The marker an installed release carries (written by scripts/build-store-pc-release.mjs). */
export const RELEASE_MARKER = 'release.json';
export const SETUP_LOG = 'setup.log';

/** What this release brings with it, when it is an installed release: the PostgreSQL programs and the service host. */
export function bundledRuntime(deps) {
  const p = pathFor(deps.platform);
  if (!deps.fs.existsSync(p.join(deps.repoRoot, RELEASE_MARKER))) return {};
  const pgBin = p.join(deps.repoRoot, 'runtime', 'pgsql', 'bin');
  const serviceHost = p.join(deps.repoRoot, 'runtime', 'winsw', 'WinSW-x64.exe');
  return { pgBin: deps.fs.existsSync(pgBin) ? pgBin : undefined, serviceHost: deps.fs.existsSync(serviceHost) ? serviceHost : undefined };
}

/** The release's own words about itself (version, commit), or undefined off an installed release. */
export function releaseInfo(deps) {
  const file = pathFor(deps.platform).join(deps.repoRoot, RELEASE_MARKER);
  try { return JSON.parse(deps.fs.readFileSync(file, 'utf8')); } catch { return undefined; }
}

/** The system disk's letter (where Windows is), from SystemDrive — C unless Windows says otherwise. */
export const systemDriveLetter = (deps) => String(deps.env?.SystemDrive || 'C:').trim().charAt(0).toUpperCase() || 'C';

/**
 * OB-716 "A": a NEW shop's data goes on a disk inside this PC that is not the system disk — never C: (or wherever Windows
 * is). A PC with no second internal disk is refused, in plain words. Undefined when the drive may be used.
 */
export function newDataDriveRefusal(deps, dataDrive) {
  if (dataDrive === undefined || String(dataDrive).trim() === '') {
    return 'name the disk the shop\'s data will be kept on (--data-drive D:): a disk inside this PC that is not the one Windows is on (OB-716)';
  }
  const letter = String(dataDrive).trim().charAt(0).toUpperCase();
  if (letter === systemDriveLetter(deps)) {
    return `${letter}: is the disk Windows is on. The shop's data goes on a SECOND disk inside this PC, so it survives Windows being reinstalled (OB-716). If this PC has no second disk, one must be fitted first`;
  }
  return undefined;
}

/** Every drive letter on this PC, and whether a new shop's data may go there (the first-run screens' list). */
export function driveChoices(deps) {
  const out = [];
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    if (!deps.fs.existsSync(`${letter}:\\`)) continue;
    const system = newDataDriveRefusal(deps, `${letter}:`);
    if (system !== undefined) { out.push({ letter, ok: false, why: `${letter}: is the disk Windows is on; the shop's data goes on a second disk inside this PC.` }); continue; }
    const k = dataDriveProblem(deps, letter);
    out.push(k.problem !== undefined ? { letter, ok: false, why: `${k.problem}.` } : { letter, ok: true, ...(k.note === undefined ? {} : { note: k.note }) });
  }
  return out;
}

/** `say`, and the same line kept in the setup log (best effort: a log that cannot be written never stops the setup). */
function logged(deps) {
  const p = pathFor(deps.platform);
  const dir = deps.dataPointer === undefined ? undefined : p.dirname(deps.dataPointer);
  const file = dir === undefined ? undefined : p.join(dir, SETUP_LOG);
  return {
    ...deps,
    say: (line) => {
      deps.say(line);
      if (file === undefined) return;
      try { deps.fs.mkdirSync(dir, { recursive: true }); deps.fs.appendFileSync(file, `${deps.now().toISOString()}  ${line}\n`, 'utf8'); } catch { /* the screen still has it */ }
    },
  };
}

/** `setup`: settings (made or kept), the till, the three services. 0 done · 1 not done · 2 refused. */
export async function firstRun(given, opts = {}) {
  const deps = logged(given);
  const { say } = deps;
  const rel = releaseInfo(deps);
  say(`SRE Retail OS setup${rel?.version ? ` — release ${rel.version}${rel.commit ? ` (${String(rel.commit).slice(0, 8)})` : ''}` : ''}.`);
  if (deps.platform !== 'win32') { say('REFUSED — the setup is for the store computer (Windows 10 or 11).'); return 2; }
  if (refusedOnServer(deps)) return 2;

  // 1 — Settings: kept when this PC already has them; otherwise made once, with this shop's own new tenant id.
  let here = deps;
  let now = loadSettings(here);
  if (now.settings !== undefined) {
    say(`This PC is already set up: its settings in ${now.L.settings} are KEPT, with every secret and its tenant id.`);
    if (opts.dataDrive !== undefined && now.L.dataRoot !== undefined && !sameFolder(deps.platform, pathFor(deps.platform).parse(now.L.dataRoot).root, `${String(opts.dataDrive).replace(/[\\/]+$/, '')}\\`)) {
      say(`  Its shop data stays in ${now.L.dataRoot}; the drive asked for, ${opts.dataDrive}, is not used.`);
    }
  } else {
    const refusal = newDataDriveRefusal(deps, opts.dataDrive);
    if (refusal !== undefined) { say(`REFUSED — ${refusal}. Nothing was changed.`); return 2; }
    const made = await prepare(here, { dataDrive: opts.dataDrive });
    if (made !== 0) return made;
    // prepare recorded where the data folder is; every later step reads it from there (OB-283).
    const found = resolveDataFolder(here);
    if (found.problem !== undefined) { say(`NOT DONE — ${found.problem}`); return 1; }
    here = found.deps;
    now = loadSettings(here);
    if (now.settings === undefined) { say('NOT DONE — the settings were made but cannot be read back. Send me a photo of this screen.'); return 1; }
  }
  const L = resolveLayout(here);

  // 2 — The till, in the data folder (install-till keeps a till.env that is already there).
  if (!deps.fs.existsSync(L.tillEnv)) {
    const p = pathFor(deps.platform);
    const args = [p.join(deps.repoRoot, 'scripts', 'install-till.mjs'), '--settings', L.settings, '--lane', opts.lane ?? 'lane-1'];
    if (rel !== undefined) args.push('--skip-build'); // an installed release brings its screens built
    const till = deps.spawn(deps.nodePath, args, { cwd: deps.repoRoot, env: deps.env });
    if (till.error !== undefined || till.status !== 0) {
      say(`NOT DONE — the till could not be installed. ${String(till.stdout ?? '').split(/\r?\n/).filter(Boolean).slice(-2).join(' / ')}`);
      return 1;
    }
    say(`The till is installed in ${L.tillDir}.`);
  } else {
    say(`The till's settings in ${L.tillEnv} are KEPT.`);
  }

  // 3 — The three Windows services.
  const runtime = bundledRuntime(deps);
  const done = await installServices(here, { pgBin: opts.pgBin ?? runtime.pgBin, serviceHost: opts.serviceHost ?? runtime.serviceHost });
  if (done !== 0) return done;
  say(`This shop's tenant id: ${now.settings.EDGE_TENANT_ID}  (made by this setup on this PC; a name, not a secret).`);
  say('SETUP DONE.');
  return 0;
}
