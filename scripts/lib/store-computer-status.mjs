// The store computer's own red light — audit row 6 (lane B M1 · lane C C-19 · P-08 "no silent failure" · P-03 "control by
// exception"): an alert the owner SEES on the store PC with no internet and no message provider (OB-222 keeps those off).
//
//   status   checks four things, prints one line each and a RED banner when any is wrong, and writes the answer to the
//            data folder's status file. The till's box reads that file and the office screens show the same red banner
//            (edge/store-edge/src/store-computer-status-file.ts → GET /lane/sync-status → apps/web-erp/web/sre-chrome.js).
//
// It runs every 15 minutes by itself once `schedule-backup` has set the automatic backup up (Task Scheduler), after every
// automatic backup, and at sign-in (`autostart`); the owner can run it any time. A status file older than 30 minutes is
// itself shown red by the office screen: a check that stopped running is a failure too, never an all-clear.
//
// ── The rules, and where each number comes from (nothing here is a guess) ─────────────────────────────────────────
//   backup older than 2 hours          OB-249: automatic hourly backup, "a dead disk loses at most about an hour"; one
//                                      missed hour is tolerated, two are not (the brief for this change: "older than 2 h")
//   unsent for more than 15 minutes    roadmap §32 cloud RPO ≤ 15 min; packages/ops/src/health.ts DEFAULT_THRESHOLDS
//                                      syncLagWarnSeconds 900 — items waiting with nothing sent for 15 minutes
//   any dead letter                    docs/pilot/MONITORING-AND-ALERTS.md: "Dead-letter depth — any dead letter"
//   disk 85% full                      docs/pilot/MONITORING-AND-ALERTS.md: "Disk — alert when ≥ 85%"
//   a container down                   the database and the API must both run (`up` starts exactly these)
//   status file older than 30 minutes  two missed 15-minute checks
//   the till's mirror settings         OB-248 · OB-252 · OB-256: the store computer's real copy (its data folder) runs
//                                      the mirror pilot with guest sales only, so till.env must say BOTH
//                                      EDGE_MIRROR_PILOT=1 and EDGE_GUEST_SALES_ONLY=1 (till:install writes both); red
//                                      when it does not, "not known" before the till is installed
//   backup drive under 30 days of room OB-268 (owner, 20 Oct 2026, "Under 30 days left"): red when the drive that stays
//                                      plugged in has room for fewer than about 30 more days of backups at the current
//                                      rate — the last good backup's size × the backups a day the schedule takes.
//                                      Nothing is ever deleted (OB-262). Before the rate can be worked out (no backup
//                                      yet, the drive or its free space cannot be read, no schedule) it says "not known"
//                                      — never a number it does not have (P-08).
//
// Every message is in English and Tamil. Nothing here reads or shows a secret.

import { dockerProblem, lines, PROJECT, resolveLayout, pathFor } from './store-computer.mjs';
import { readLastBackup, tillFolders } from './store-computer-recovery.mjs';

export const ALERT_RULES = Object.freeze({
  backupMaxAgeMinutes: 120,
  unsentStuckMinutes: 15,
  diskMaxUsedFraction: 0.85,
  statusStaleMinutes: 30,
  checkEveryMinutes: 15,
  backupDriveMinDays: 30,
});
export const STATUS_KIND = 'sre-store-computer-status';
export const SCHEDULE_FILE = 'schedule.json';

const minutesBetween = (a, b) => Math.floor((b - a) / 60_000);
/** "3 h 10 min" / "3 மணி 10 நிமிடம்" — both languages from one number of minutes. */
export function ageWords(totalMinutes) {
  const m = Math.max(0, Math.round(totalMinutes));
  const h = Math.floor(m / 60);
  const r = m % 60;
  return {
    en: h === 0 ? `${r} min` : `${h} h ${r} min`,
    ta: h === 0 ? `${r} நிமிடம்` : `${h} மணி ${r} நிமிடம்`,
  };
}
const gb = (b) => `${(b / 1024 ** 3).toFixed(1)} GB`;

/** The owner's automatic-backup choice, or undefined when none is set. */
export function readSchedule(deps, L) {
  if (L.mode !== 'data-folder') return undefined;
  let s;
  try { s = JSON.parse(deps.fs.readFileSync(pathFor(deps.platform).join(L.backupDir, SCHEDULE_FILE), 'utf8')); } catch { return undefined; }
  // `unschedule-backup` keeps what the schedule was, marked off: off is no schedule.
  return s?.off === true || typeof s?.to !== 'string' ? undefined : s;
}

/** The backup check: red when the last good backup is more than 2 hours old, or there has never been one. */
export function backupCheck(deps, L, nowMs) {
  const last = readLastBackup(deps, L);
  const schedule = readSchedule(deps, L);
  const okAt = last?.lastSuccess?.at === undefined ? undefined : Date.parse(last.lastSuccess.at);
  const failed = last?.lastAttempt?.ok === false ? last.lastAttempt : undefined;
  const why = failed === undefined ? undefined : String(failed.problem ?? '').slice(0, 160);
  const auto = schedule === undefined ? 'automatic backup is NOT set up' : `automatic every ${schedule.everyMinutes} minutes to ${schedule.to}`;
  if (okAt === undefined) {
    return {
      name: 'Backup', ok: false, detail: `no backup has been taken yet; ${auto}`,
      alert: { code: 'backup_never', en: 'No backup has been taken on this computer yet.', ta: 'இந்தக் கணினியில் இதுவரை காப்புப் பிரதி எடுக்கப்படவில்லை.' },
    };
  }
  const age = minutesBetween(okAt, nowMs);
  const words = ageWords(age);
  if (age > ALERT_RULES.backupMaxAgeMinutes) {
    return {
      name: 'Backup', ok: false, detail: `the last good backup was ${words.en} ago — more than 2 hours; ${auto}${why === undefined ? '' : `; the last try failed: ${why}`}`,
      alert: {
        code: 'backup_old',
        en: `The last backup was ${words.en} ago — more than 2 hours. ${schedule === undefined ? 'Automatic backup is not set up.' : 'Check the backup drive is plugged in.'}`,
        ta: `கடைசி காப்புப் பிரதி ${words.ta} முன்பு — 2 மணி நேரத்துக்கு மேல். ${schedule === undefined ? 'தானியங்கி காப்புப் பிரதி அமைக்கப்படவில்லை.' : 'காப்புப் பிரதி டிரைவ் இணைக்கப்பட்டுள்ளதா எனப் பாருங்கள்.'}`,
      },
    };
  }
  return { name: 'Backup', ok: true, detail: `last good backup ${words.en} ago (${last.lastSuccess.to}); ${auto}${why === undefined ? '' : `; the last try failed: ${why}`}` };
}

/** How many backups a drive folder holds, their total size, and the drive's free space. Read-only. */
export function driveTally(deps, dir) {
  const p = pathFor(deps.platform);
  let names = [];
  try { names = deps.fs.readdirSync(dir).map(String); } catch { return { readable: false }; }
  const backups = names.filter((n) => n.startsWith(`${PROJECT}-backup-`) && n.endsWith('.manifest.json'));
  let bytes = 0;
  for (const n of names.filter((x) => x.startsWith(`${PROJECT}-backup-`))) { try { bytes += deps.fs.statSync(p.join(dir, n)).size; } catch { /* a file that vanished is simply not counted */ } }
  let space;
  try { space = deps.diskSpace(dir); } catch { space = undefined; }
  return { readable: true, backups: backups.length, bytes, free: space?.free, total: space?.total };
}

/** About how many days of backups still fit, at the average backup's size and this many per day. Undefined if not known. */
export function daysOfRoom(tally, everyMinutes) {
  if (!tally.readable || tally.backups === 0 || tally.free === undefined) return undefined;
  const perDay = (tally.bytes / tally.backups) * (1440 / everyMinutes);
  return perDay <= 0 ? undefined : Math.floor(tally.free / perDay);
}

/**
 * OB-268 — the room left on the backup drive, in days at the CURRENT rate: the last good backup's size (the newest, so a
 * shop whose data grows is measured as it is now; the drive's average backup only when that size is not recorded) times
 * the backups a day the schedule takes. `known: false` with the reason, in both languages, whenever the rate or the room
 * cannot be worked out yet — never a guessed number (P-08).
 */
export function backupRoom(deps, L, schedule = readSchedule(deps, L)) {
  if (schedule === undefined) {
    return { known: false, why: { en: 'automatic backup is not set up, so there is no backup drive to measure', ta: 'தானியங்கி காப்புப் பிரதி அமைக்கப்படவில்லை, எனவே அளக்க காப்புப் பிரதி டிரைவ் இல்லை' } };
  }
  const tally = driveTally(deps, schedule.to);
  if (!tally.readable) return { known: false, tally, why: { en: `the backup drive folder ${schedule.to} cannot be read — is the drive plugged in?`, ta: `காப்புப் பிரதி டிரைவ் கோப்புறை ${schedule.to} படிக்க முடியவில்லை — டிரைவ் இணைக்கப்பட்டுள்ளதா?` } };
  if (!(tally.free >= 0)) return { known: false, tally, why: { en: 'the free space on the backup drive could not be read', ta: 'காப்புப் பிரதி டிரைவில் உள்ள காலி இடத்தைப் படிக்க முடியவில்லை' } };
  const last = readLastBackup(deps, L);
  const lastBytes = last?.lastSuccess?.bytes;
  const perBackup = Number.isFinite(lastBytes) && lastBytes > 0 ? lastBytes
    : tally.backups > 0 && tally.bytes > 0 ? tally.bytes / tally.backups : undefined;
  if (perBackup === undefined) {
    return { known: false, tally, why: { en: 'no backup has been taken yet, so the rate the drive fills at is not known yet', ta: 'இதுவரை காப்புப் பிரதி எடுக்கப்படவில்லை, எனவே டிரைவ் நிரம்பும் வேகம் இன்னும் தெரியவில்லை' } };
  }
  const perDay = perBackup * (1440 / schedule.everyMinutes);
  return { known: true, tally, perDay, days: Math.floor(tally.free / perDay) };
}

/** OB-268: the backup drive check — red under about 30 days of room at the current rate; "not known" said, never red. */
export function backupDriveCheck(deps, L) {
  const room = backupRoom(deps, L);
  if (!room.known) return { name: 'Drive room', ok: null, detail: `not known — ${room.why.en}` };
  const free = gb(room.tally.free);
  const perDay = `${(room.perDay / 1024 ** 2).toFixed(1)} MB a day`;
  if (room.days < ALERT_RULES.backupDriveMinDays) {
    return {
      name: 'Drive room', ok: false, detail: `room for about ${room.days} more day(s) of backups (${free} free, ${perDay}) — under ${ALERT_RULES.backupDriveMinDays} days`,
      alert: {
        code: 'backup_drive_filling',
        en: `The backup drive has room for about ${room.days} more day(s) of backups at the current rate — under ${ALERT_RULES.backupDriveMinDays} days. Nothing is ever deleted: decide what to keep, or plug in a bigger drive.`,
        ta: `தற்போதைய வேகத்தில் காப்புப் பிரதி டிரைவில் இன்னும் சுமார் ${room.days} நாள்(கள்) காப்புப் பிரதிகளுக்கு மட்டுமே இடம் உள்ளது — ${ALERT_RULES.backupDriveMinDays} நாட்களுக்குக் குறைவு. எதுவும் ஒருபோதும் நீக்கப்படுவதில்லை: எதை வைத்திருப்பது என்று முடிவு செய்யுங்கள், அல்லது பெரிய டிரைவை இணைக்கவும்.`,
      },
    };
  }
  return { name: 'Drive room', ok: true, detail: `room for about ${room.days} more day(s) of backups (${free} free, ${perDay})` };
}

/**
 * OB-248 · OB-252 · OB-256: the till's two mirror-pilot settings, read from its own till.env (no secret is read or shown:
 * only these two names and their 1/0). The real copy (the data folder) must say both; red, with what to do, if not.
 */
export function mirrorCheck(deps, L) {
  if (L.mode !== 'data-folder') return { name: 'Mirror', ok: null, detail: "not known — this copy's data is not in the shop's data folder yet" };
  const till = tillFolders(deps, L);
  if (!till.installed) return { name: 'Mirror', ok: null, detail: 'not known — no till is installed on this computer yet' };
  const said = (k) => String(till.env?.[k] ?? '').trim();
  const mirror = said('EDGE_MIRROR_PILOT') === '1';
  const guest = said('EDGE_GUEST_SALES_ONLY') === '1';
  const words = `EDGE_MIRROR_PILOT=${said('EDGE_MIRROR_PILOT') || '(not set)'}, EDGE_GUEST_SALES_ONLY=${said('EDGE_GUEST_SALES_ONLY') || '(not set)'}`;
  if (mirror && guest) return { name: 'Mirror', ok: true, detail: `the till runs the mirror pilot with guest sales only (${words})` };
  return {
    name: 'Mirror', ok: false, detail: `the till's settings do not say the mirror pilot with guest sales only (${words})`,
    alert: {
      code: 'mirror_settings_off',
      en: "The till's settings do not say the mirror pilot with guest sales only. Ring nothing more on the new till, and install the till again (owner guide Part 13).",
      ta: 'கல்லாவின் அமைப்புகள் "விருந்தினர் விற்பனை மட்டும்" உடன் மிரர் பைலட் என்று சொல்லவில்லை. புதிய கல்லாவில் மேலும் எதையும் பதிவு செய்ய வேண்டாம்; கல்லாவை மீண்டும் நிறுவவும் (உரிமையாளர் வழிகாட்டி பகுதி 13).',
    },
  };
}

/** The till's queue, from the till's own box (GET /lane/sync-status on this computer). */
export async function tillCheck(deps, L, nowMs) {
  const till = tillFolders(deps, L);
  if (!till.installed) {
    return { name: 'Till', ok: false, detail: 'no till is installed on this computer yet', alert: { code: 'till_not_installed', en: 'No till is installed on this computer yet.', ta: 'இந்தக் கணினியில் இன்னும் கல்லா நிறுவப்படவில்லை.' } };
  }
  let s;
  try {
    const res = await deps.fetch(`http://127.0.0.1:${till.lanePort}/lane/sync-status`);
    s = res.ok ? await res.json() : undefined;
  } catch { s = undefined; }
  if (s === undefined || s === null || typeof s.unsent !== 'number') {
    return { name: 'Till', ok: false, detail: `the till is not answering on this computer (port ${till.lanePort})`, alert: { code: 'till_not_running', en: 'The till program is not running on this computer.', ta: 'இந்தக் கணினியில் கல்லா நிரல் இயங்கவில்லை.' } };
  }
  const problems = [];
  const alerts = [];
  if (s.deadLettered > 0) {
    problems.push(`${s.deadLettered} item(s) refused by the books are waiting for a person`);
    alerts.push({ code: 'dead_letters', en: `${s.deadLettered} item(s) the books refused are waiting for a person to look at them.`, ta: `கணக்குகள் மறுத்த ${s.deadLettered} பதிவு(கள்) ஒருவர் பார்க்கக் காத்திருக்கின்றன.` });
  }
  if (s.unsent > 0) {
    const sentAt = s.lastSentAt === null || s.lastSentAt === undefined ? undefined : Date.parse(s.lastSentAt);
    const quiet = sentAt === undefined ? undefined : minutesBetween(sentAt, nowMs);
    if (sentAt === undefined || quiet > ALERT_RULES.unsentStuckMinutes) {
      const since = quiet === undefined ? undefined : ageWords(quiet);
      const link = s.cloud === 'not_configured' ? ' (the till has no link to the books set up)' : s.cloud === 'offline' ? ' (the till cannot reach the books)' : '';
      problems.push(`${s.unsent} item(s) not sent ${since === undefined ? '— nothing has ever been sent' : `and nothing sent for ${since.en}`}${link}`);
      alerts.push({
        code: 'unsent_stuck',
        en: `${s.unsent} sale item(s) are saved on the till but not sent ${since === undefined ? '— nothing has ever been sent' : `for ${since.en}`}${link}. They are safe; the books are behind.`,
        ta: `${s.unsent} விற்பனைப் பதிவு(கள்) கல்லாவில் சேமிக்கப்பட்டுள்ளன, ஆனால் ${since === undefined ? 'இதுவரை எதுவும் அனுப்பப்படவில்லை' : `${since.ta} அனுப்பப்படவில்லை`}. அவை பாதுகாப்பாக உள்ளன; கணக்குகள் பின்தங்கியுள்ளன.`,
      });
    }
  }
  if (problems.length > 0) return { name: 'Till', ok: false, detail: problems.join('; '), alerts };
  return { name: 'Till', ok: true, detail: s.unsent === 0 ? 'everything the till saved has been sent; no dead letters' : `${s.unsent} item(s) on their way (something was sent in the last ${ALERT_RULES.unsentStuckMinutes} minutes); no dead letters` };
}

/** Free disk on the drive that holds the shop's data (and, on Windows, Docker's disk). */
export function diskCheck(deps, L) {
  const where = L.dataRoot ?? deps.repoRoot;
  let space;
  try { space = deps.diskSpace(where); } catch { space = undefined; }
  if (space === undefined || !(space.total > 0)) {
    return { name: 'Disk', ok: false, detail: 'the free space could not be read', alert: { code: 'disk_not_known', en: 'The free space on this computer\'s disk could not be read.', ta: 'இந்தக் கணினியின் வட்டில் உள்ள காலி இடத்தைப் படிக்க முடியவில்லை.' } };
  }
  const used = 1 - space.free / space.total;
  const pct = Math.round(used * 100);
  if (used >= ALERT_RULES.diskMaxUsedFraction) {
    return { name: 'Disk', ok: false, detail: `${pct}% full — only ${gb(space.free)} free of ${gb(space.total)}`, alert: { code: 'disk_full', en: `This computer's disk is ${pct}% full (${gb(space.free)} free). Free some space before it fills.`, ta: `இந்தக் கணினியின் வட்டு ${pct}% நிரம்பியுள்ளது (${gb(space.free)} காலி). நிரம்பும் முன் இடத்தைக் காலி செய்யுங்கள்.` } };
  }
  return { name: 'Disk', ok: true, detail: `${gb(space.free)} free of ${gb(space.total)} (${pct}% full)` };
}

/** The database and the API containers of this copy must both be running. */
export function containersCheck(deps) {
  const docker = dockerProblem(deps);
  if (docker !== undefined) return { name: 'Containers', ok: false, detail: docker.what, alert: { code: 'docker_not_running', en: 'Docker Desktop is not running, so the database and the books are stopped.', ta: 'Docker Desktop இயங்கவில்லை, எனவே தரவுத்தளமும் கணக்குகளும் நின்றுவிட்டன.' } };
  const r = deps.spawn('docker', ['ps', '--filter', `label=com.docker.compose.project=${PROJECT}`, '--format', '{{.Label "com.docker.compose.service"}}'], {});
  const running = new Set(lines(r.stdout));
  const down = [['db', 'the database'], ['api', 'the API (the books)']].filter(([s]) => !running.has(s));
  if (r.status !== 0 || down.length > 0) {
    const named = (r.status !== 0 ? [['?', 'the database and the API']] : down).map(([, w]) => w).join(' and ');
    return { name: 'Containers', ok: false, detail: `not running: ${named}`, alert: { code: 'container_down', en: `Not running: ${named}. Run: pnpm run store-computer -- up`, ta: `இயங்கவில்லை: ${r.status !== 0 || down.length > 1 ? 'தரவுத்தளமும் API-யும்' : down[0][0] === 'db' ? 'தரவுத்தளம்' : 'API (கணக்குகள்)'}. இயக்கவும்: pnpm run store-computer -- up` } };
  }
  return { name: 'Containers', ok: true, detail: 'the database and the API are running' };
}

/** All six checks, and the one answer. */
export async function collectStatus(deps) {
  const L = resolveLayout(deps);
  const now = deps.now();
  const checks = [backupCheck(deps, L, now.getTime()), backupDriveCheck(deps, L), await tillCheck(deps, L, now.getTime()), mirrorCheck(deps, L), diskCheck(deps, L), containersCheck(deps)];
  const alerts = checks.flatMap((c) => c.alerts ?? (c.alert === undefined ? [] : [c.alert]));
  return {
    kind: STATUS_KIND, version: 1, checkedAt: now.toISOString(), staleAfterMinutes: ALERT_RULES.statusStaleMinutes,
    overall: alerts.length === 0 ? 'ok' : 'red',
    alerts,
    checks: checks.map((c) => ({ name: c.name, ok: c.ok, detail: c.detail })),
  };
}

/** Replace the status file whole: a temp file, then a rename, so the till's box never reads half of one. */
export function writeStatusFile(deps, L, status) {
  if (L.mode !== 'data-folder') return undefined;
  const p = pathFor(deps.platform);
  deps.fs.mkdirSync(L.statusDir, { recursive: true });
  const tmp = p.join(L.statusDir, 'store-computer-status.json.tmp');
  deps.fs.writeFileSync(tmp, `${JSON.stringify(status, null, 2)}\n`, 'utf8');
  deps.fs.renameSync(tmp, L.statusFile);
  return L.statusFile;
}

/** `status [--quiet]`: the four checks, the red banner when any is wrong, and the status file for the office screen. */
export async function status(deps, opts = {}) {
  const { say } = deps;
  const L = resolveLayout(deps);
  const s = await collectStatus(deps);
  const file = writeStatusFile(deps, L, s);
  if (opts.quiet === true) return s.overall === 'ok' ? 0 : 1;
  say(`Store computer check — ${s.checkedAt} (this computer's clock).`);
  // OK, RED, or "?" — a check that cannot say yet (OB-268's room before the first backup) is neither.
  for (const c of s.checks) say(`  ${c.ok === true ? 'OK ' : c.ok === false ? 'RED' : ' ? '}  ${c.name.padEnd(10)} ${c.detail}`);
  if (s.overall === 'ok') say('ALL OK — nothing needs you.');
  else {
    say('');
    say('████ RED — SOMETHING NEEDS YOU ████');
    for (const a of s.alerts) say(`  • ${a.en}`);
    say('The office screen shows the same red banner.');
  }
  if (file !== undefined) say(`Status written for the office screen: ${file}`);
  else say("The office screen's red banner needs the shop's data folder: run pnpm run store-computer -- migrate-data-folder");
  return s.overall === 'ok' ? 0 : 1;
}

