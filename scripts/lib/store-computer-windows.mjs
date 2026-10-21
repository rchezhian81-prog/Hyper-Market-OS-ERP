// What the store-computer tool asks WINDOWS itself, read-only — OB-281 (backups only to USB or removable drives),
// OB-282 (never on the shop's Windows Server), OB-283 (the shop's data and Docker's disk image on the data drive F:),
// OB-284 (a shared office PC: only the owner's admin account and SYSTEM may read the data).
//
//   windowsEdition      Win32_OperatingSystem: ProductType (1 = a workstation; 2 and 3 = a server) and the caption
//   driveKind           Win32_LogicalDisk.DriveType (2 removable · 3 fixed · 4 network · 5 CD · 6 RAM disk) and the
//                       disk's BusType (Get-Partition | Get-Disk): a USB hard disk reports DriveType 3, so the bus decides
//   localAdministrators the members of the local Administrators group (SID S-1-5-32-544, the same in every language)
//   folderReaders       who may READ a folder or file (Get-Acl), by SID, so the answer does not depend on Windows' language
//   dockerDiskImage     where Docker Desktop keeps its disk image (its own settings file, read as a file)
//
// Every question is ONE fixed PowerShell script, started through `deps.spawn` with an argument array and no shell. Nothing
// the owner typed is ever put inside a script: a drive letter or a path is handed over in an environment variable that
// the script reads (a drive letter is checked to be one letter first). The scripts only read; none changes anything.
// Any answer that cannot be read is "not known" — never taken as a yes (P-08): a backup drive whose kind is not known
// is refused, and a check that cannot be made says NEEDS-YOU with what to look at by eye.
//
// NONE OF THIS HAS RUN ON REAL WINDOWS YET. The scripts follow Windows' documented classes and cmdlets; the tests drive
// the logic with a pretend PowerShell (tests/support/store-computer-world.ts).

import { lines, pathFor } from './store-computer.mjs';

// ── Running one fixed script ──────────────────────────────────────────────────────────────────────────────────────

/** Windows PowerShell 5.1 by its full path (never whatever "powershell" is first on PATH). */
export const powershellPath = (env) => pathFor('win32').join(String(env?.SystemRoot || env?.windir || 'C:\\Windows'), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

/** Every script starts with this: answers in UTF-8, so an account name in Tamil arrives as typed. */
const UTF8 = '[Console]::OutputEncoding = [Text.Encoding]::UTF8';

/**
 * The scripts. Each is a fixed text with NO double quote in it (so no command-line quoting can change it) and reads its
 * one input from an environment variable. Exported so a test can prove both.
 */
export const SCRIPTS = Object.freeze({
  edition: [
    UTF8,
    '$o = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop',
    "[Console]::Out.WriteLine('EDITION|' + [string]$o.ProductType + '|' + [string]$o.Caption)",
  ].join('; '),
  drive: [
    UTF8,
    '$l = [string]$env:SRE_DRIVE_LETTER',
    "if ($l -cnotmatch '^[A-Z]$') { exit 3 }",
    "$d = Get-CimInstance -ClassName Win32_LogicalDisk -Filter ('DeviceID=''' + $l + ':''') -ErrorAction Stop",
    "if ($null -eq $d) { [Console]::Out.WriteLine('DRIVE|none|'); exit 0 }",
    "$b = ''",
    "try { $b = [string]((Get-Partition -DriveLetter $l -ErrorAction Stop | Get-Disk -ErrorAction Stop).BusType) } catch { $b = '' }",
    "[Console]::Out.WriteLine('DRIVE|' + [string]$d.DriveType + '|' + $b)",
  ].join('; '),
  admins: [
    UTF8,
    '$me = [Security.Principal.WindowsIdentity]::GetCurrent()',
    "[Console]::Out.WriteLine('ME|' + $me.User.Value + '|' + $me.Name)",
    "$g = Get-CimInstance -ClassName Win32_Group -Filter 'SID=''S-1-5-32-544''' -ErrorAction Stop",
    "foreach ($m in @(Get-CimAssociatedInstance -InputObject $g -Association Win32_GroupUser -ErrorAction Stop)) { [Console]::Out.WriteLine('MEMBER|' + [string]$m.SID + '|' + [string]$m.Domain + '\\' + [string]$m.Name + '|' + [string]$m.CimClass.CimClassName + '|' + [string]$m.Disabled) }",
  ].join('; '),
  acl: [
    UTF8,
    '$me = [Security.Principal.WindowsIdentity]::GetCurrent()',
    "[Console]::Out.WriteLine('ME|' + $me.User.Value + '|' + $me.Name)",
    '$a = Get-Acl -LiteralPath $env:SRE_ACL_PATH -ErrorAction Stop',
    "foreach ($r in @($a.Access)) { $sid = ''; try { $sid = $r.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } catch { $sid = [string]$r.IdentityReference }; [Console]::Out.WriteLine('ACE|' + $sid + '|' + [string]$r.IdentityReference + '|' + [string]$r.AccessControlType + '|' + [string][int]$r.FileSystemRights) }",
  ].join('; '),
});

/** Run one script. Returns its answer lines split on '|', or undefined when Windows did not answer. */
export function ask(deps, script, vars = {}) {
  const r = deps.spawn(powershellPath(deps.env), ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...deps.env, ...vars } });
  if (r === undefined || r.error !== undefined || r.status !== 0) return undefined;
  return lines(r.stdout).map((l) => l.split('|'));
}

// ── OB-282: never on a Windows Server ─────────────────────────────────────────────────────────────────────────────

/**
 * Is this a Windows Server? `server` is true when Windows says ProductType 2 or 3, or its caption — or Node's own reading
 * of the product name — says "Server". `known` is false only when Windows could not be asked AND nothing says "Server".
 */
export function windowsEdition(deps) {
  if (deps.platform !== 'win32') return { applies: false, known: true, server: false };
  const nodeSays = (() => { try { return String(deps.os?.version?.() ?? ''); } catch { return ''; } })();
  const row = (ask(deps, SCRIPTS.edition) ?? []).find((x) => x[0] === 'EDITION');
  const productType = row === undefined ? undefined : Number(row[1]);
  const caption = row?.[2]?.trim() || nodeSays;
  const typeKnown = Number.isInteger(productType) && productType >= 1 && productType <= 3;
  const server = (typeKnown && productType !== 1) || /server/i.test(caption) || /server/i.test(nodeSays);
  return { applies: true, known: typeKnown || server, server, productType: typeKnown ? productType : undefined, caption };
}

/** The refusal on a Windows Server (OB-282), said; true when refused. `edition` may be passed in (the doctor asks once). */
export function refusedOnServer(deps, edition = windowsEdition(deps)) {
  if (!edition.server) return false;
  deps.say(`REFUSED — this computer is a Windows Server ("${edition.caption || 'Windows Server'}"). That is the shop's server, which runs the old ERP — your legal billing system during the pilot.`);
  deps.say('  Nothing of the new system is ever installed, started or backed up on it (OB-282). Nothing was changed.');
  deps.say('  Go to the Windows 11 PC and run this there (guide Part 1).');
  return true;
}

// ── OB-281 · OB-283: what kind of drive a folder is on ────────────────────────────────────────────────────────────

/** MSFT_Disk BusType numbers, for a Windows that answers with the number instead of the name. */
const BUS_NAMES = Object.freeze({ 0: 'Unknown', 1: 'SCSI', 2: 'ATAPI', 3: 'ATA', 4: '1394', 5: 'SSA', 6: 'Fibre Channel', 7: 'USB', 8: 'RAID', 9: 'iSCSI', 10: 'SAS', 11: 'SATA', 12: 'SD', 13: 'MMC', 14: 'Virtual', 15: 'File Backed Virtual', 16: 'Storage Spaces', 17: 'NVMe', 18: 'SCM', 19: 'UFS' });
/** Buses of a disk inside the PC (or a disk made from one: a mounted virtual disk, a storage space). */
const INSIDE_BUSES = new Set(['SCSI', 'ATAPI', 'ATA', 'SSA', 'RAID', 'SAS', 'SATA', 'Virtual', 'File Backed Virtual', 'Storage Spaces', 'NVMe', 'SCM', 'UFS']);

/** The drive letter of a Windows path ("F:\SRE-data" → "F"), or undefined (a network path such as \\server\share). */
export function driveLetterOf(dir) {
  const m = /^([A-Za-z]):/.exec(String(dir ?? '').trim());
  return m === null ? undefined : m[1].toUpperCase();
}

/**
 * What kind of drive this letter is: 'removable' · 'usb' · 'internal' · 'network' · 'optical' · 'ram' · 'none' (no such
 * drive) · 'unknown' (Windows did not say). `bus` is the disk's bus as Windows names it, when it said.
 */
export function driveKind(deps, letter) {
  if (!/^[A-Z]$/.test(String(letter ?? ''))) return { kind: 'unknown' };
  const row = (ask(deps, SCRIPTS.drive, { SRE_DRIVE_LETTER: letter }) ?? []).find((x) => x[0] === 'DRIVE');
  if (row === undefined) return { kind: 'unknown' };
  if (row[1] === 'none') return { kind: 'none' };
  const type = Number(row[1]);
  const rawBus = String(row[2] ?? '').trim();
  const bus = /^\d+$/.test(rawBus) ? BUS_NAMES[Number(rawBus)] ?? rawBus : rawBus;
  if (type === 2) return { kind: 'removable', bus };
  if (type === 4) return { kind: 'network', bus };
  if (type === 5) return { kind: 'optical', bus };
  if (type === 6) return { kind: 'ram', bus };
  if (type === 3) {
    if (bus === 'USB') return { kind: 'usb', bus };
    if (bus === 'iSCSI' || bus === 'Fibre Channel') return { kind: 'network', bus };
    if (INSIDE_BUSES.has(bus)) return { kind: 'internal', bus };
    return { kind: 'unknown', bus, fixed: true };
  }
  return { kind: 'unknown', bus };
}

/**
 * OB-281 · OB-283: a backup goes ONLY to a USB or removable drive. Every disk inside this PC is refused — not only C: and
 * the release's drive: F: is inside the same PC, so a fire, a theft or a dead power supply takes it with the data. A
 * network folder is refused too (it could be the shop's server, OB-282). A drive whose kind is not known is refused.
 * Returns the problem in plain words, or undefined. Windows only (elsewhere: undefined — the folder checks still apply).
 */
export function backupDriveProblem(deps, dir) {
  if (deps.platform !== 'win32') return undefined;
  const letter = driveLetterOf(dir);
  if (letter === undefined) return `${dir} is a network folder. A backup goes only to one of your USB backup drives (OB-281) — never to another computer, and never to the shop's server (OB-282)`;
  const k = driveKind(deps, letter);
  if (k.kind === 'removable' || k.kind === 'usb') return undefined;
  if (k.kind === 'internal') return `${dir} is on ${letter}:, a disk inside this computer${k.bus ? ` (${k.bus})` : ''}. A disk inside this PC is never a backup: a theft, a fire or a dead power supply takes it together with the data (OB-281, OB-283)`;
  if (k.kind === 'network') return `${dir} is on ${letter}:, a network drive. A backup goes only to one of your USB backup drives (OB-281) — never to another computer, and never to the shop's server (OB-282)`;
  if (k.kind === 'optical' || k.kind === 'ram') return `${dir} is on ${letter}:, which is ${k.kind === 'optical' ? 'a CD/DVD drive' : 'a RAM disk'}, not a backup drive`;
  if (k.kind === 'none') return `there is no drive ${letter}: on this computer. Is the USB backup drive plugged in, and is ${letter}: its letter (File Explorer → This PC)?`;
  return `Windows did not say what kind of drive ${letter}: is, so it is not accepted — a backup goes only to a USB or removable drive (OB-281). Unplug the drive, plug it in again and run this again; if it says this again, send me a photo of this screen`;
}

/**
 * OB-283: the shop's data goes on a disk INSIDE this PC (any internal drive: F: on the pilot PC) — never on a USB or
 * removable drive (those are the backup drives, and one is taken home), a network drive, a CD or a RAM disk. A fixed
 * drive whose bus Windows did not name is accepted as inside the PC, and said so (Part 1's photo is the eye check).
 * Returns { problem } or { note } (both may be absent). Windows only.
 */
export function dataDriveProblem(deps, letter) {
  if (deps.platform !== 'win32') return {};
  const k = driveKind(deps, letter);
  if (k.kind === 'internal') return { note: `${letter}: is a disk inside this computer${k.bus ? ` (${k.bus})` : ''}` };
  if (k.kind === 'unknown' && k.fixed === true) return { note: `${letter}: is a fixed disk (Windows did not name its connection; File Explorer's "This PC" should show it as a Local Disk)` };
  if (k.kind === 'removable' || k.kind === 'usb') return { problem: `${letter}: is a USB or removable drive. The shop's data goes on a disk INSIDE this computer (OB-283); USB drives are for the backups (OB-281)` };
  if (k.kind === 'network') return { problem: `${letter}: is a network drive. The shop's data stays on a disk inside this computer (OB-283) — never on another computer or the shop's server (OB-282)` };
  if (k.kind === 'optical' || k.kind === 'ram') return { problem: `${letter}: is ${k.kind === 'optical' ? 'a CD/DVD drive' : 'a RAM disk'}, not a place for the shop's data` };
  if (k.kind === 'none') return { problem: `there is no drive ${letter}: on this computer (File Explorer → This PC shows the letters)` };
  return { problem: `Windows did not say what kind of drive ${letter}: is, so it is not used for the shop's data. Send me a photo of this screen and of File Explorer → This PC` };
}

// ── OB-284: who is an administrator, and who can read the data ────────────────────────────────────────────────────

/** Well-known accounts by SID, in plain words (the SIDs are the same in every language of Windows). */
const PLAIN_SIDS = Object.freeze({
  'S-1-1-0': 'Everyone',
  'S-1-5-11': 'Authenticated Users (every account on this PC)',
  'S-1-5-32-545': 'Users (every account on this PC)',
  'S-1-5-32-544': 'Administrators (the group)',
  'S-1-5-32-546': 'Guests',
  'S-1-3-0': 'CREATOR OWNER',
  'S-1-5-4': 'INTERACTIVE (whoever is signed in)',
});
export const SYSTEM_SID = 'S-1-5-18';

/**
 * The local Administrators group: { known, me: { sid, name }, members: [{ sid, name, kind, disabled }] }. Read-only.
 */
export function localAdministrators(deps) {
  const rows = ask(deps, SCRIPTS.admins);
  const me = rows?.find((x) => x[0] === 'ME');
  if (rows === undefined || me === undefined) return { known: false };
  const members = rows.filter((x) => x[0] === 'MEMBER').map((x) => ({
    sid: String(x[1] ?? ''), name: String(x[2] ?? ''), kind: /group/i.test(String(x[3] ?? '')) ? 'group' : 'user', disabled: /^true$/i.test(String(x[4] ?? '').trim()),
  }));
  return { known: true, me: { sid: String(me[1] ?? ''), name: String(me[2] ?? '') }, members };
}

/** The doctor's row on the Administrators group (OB-251 · OB-284). */
export function administratorsRow(deps) {
  const a = localAdministrators(deps);
  if (!a.known) return { name: 'Admins', status: 'NEEDS-YOU', detail: 'Windows did not say who the administrators are', fix: 'Check it by eye: type  net localgroup Administrators  — only your own account may be listed (and a built-in "Administrator" that Windows keeps switched off) (guide Part 26a).' };
  const iAmAdmin = a.members.some((m) => m.sid === a.me.sid);
  const others = a.members.filter((m) => m.sid !== a.me.sid && !(m.kind === 'user' && m.disabled));
  const names = (list) => list.map((m) => `${m.name}${m.kind === 'group' ? ' (a group)' : ''}`).join(', ');
  if (!iAmAdmin) {
    return { name: 'Admins', status: 'FIX', detail: `you are signed in as ${a.me.name}, which is not an administrator of this PC`, fix: "The shop system runs under YOUR OWN administrator account (OB-284) — never the purchase staff's account or the Till account. Sign out of this account, sign in as yourself, and run this again." };
  }
  if (others.length > 0) {
    return { name: 'Admins', status: 'FIX', detail: `administrators of this PC: you (${a.me.name}) and also ${names(others)}`, fix: 'Only your own account may be an administrator (OB-251, OB-284): the purchase staff\'s account and the Till account must be Standard Users. Do not change any account yet — send me a photo of this screen (guide Part 26a).' };
  }
  const off = a.members.filter((m) => m.sid !== a.me.sid);
  return { name: 'Admins', status: 'OK', detail: `only you (${a.me.name}) are an administrator${off.length > 0 ? ` (${names(off)}: switched off)` : ''}` };
}

const READ_BITS = [0x1, 0x10000000, 0x80000000];
const canRead = (rights) => { const r = Number(rights) >>> 0; return READ_BITS.some((b) => ((r & b) >>> 0) !== 0); };

/**
 * Who, other than this account and SYSTEM, may READ this folder or file: { known, me, others: [{ sid, name }] }. A
 * "Deny" entry is not subtracted (Windows weighs those per file); an allowed reader is always named — the safe side.
 */
export function folderReaders(deps, target) {
  const rows = ask(deps, SCRIPTS.acl, { SRE_ACL_PATH: target });
  const me = rows?.find((x) => x[0] === 'ME');
  if (rows === undefined || me === undefined) return { known: false };
  const others = new Map();
  for (const x of rows.filter((r) => r[0] === 'ACE')) {
    const [, sid, name, type, rights] = x;
    if (!/^allow$/i.test(String(type ?? '').trim()) || !canRead(rights)) continue;
    if (sid === me[1] || sid === SYSTEM_SID) continue;
    if (!others.has(sid)) others.set(sid, { sid, name: PLAIN_SIDS[sid] ?? String(name ?? sid) });
  }
  return { known: true, me: { sid: String(me[1] ?? ''), name: String(me[2] ?? '') }, others: [...others.values()] };
}

/** The doctor's row on the lock of the shop's data folder, its settings file and the note that points at it (Part 26c). */
export function dataLockRow(deps, L, pointer) {
  if (L.mode !== 'data-folder' || !deps.fs.existsSync(L.dataRoot)) {
    return { name: 'Data lock', status: 'NEEDS-YOU', detail: "the shop's data folder is not made yet", fix: `Straight after prepare, lock it so only you and Windows itself can read it — guide Part 26c, step 1 — before the purchase staff next sign in (OB-284).` };
  }
  const p = pathFor(deps.platform);
  const targets = [L.dataRoot, L.settings, ...(pointer === undefined ? [] : [p.dirname(pointer)])].filter((t) => deps.fs.existsSync(t));
  const found = new Map();
  for (const t of targets) {
    const r = folderReaders(deps, t);
    if (!r.known) return { name: 'Data lock', status: 'NEEDS-YOU', detail: `Windows did not say who can read ${t}`, fix: `Check it by eye: type  icacls ${L.settings}  — it must show only your account and NT AUTHORITY\\SYSTEM (guide Part 26c, step 2).` };
    for (const o of r.others) found.set(o.sid, { ...o, where: [...(found.get(o.sid)?.where ?? []), t] });
  }
  if (found.size > 0) {
    const who = [...found.values()].map((o) => `${o.name} (${o.where.join(', ')})`).join('; ');
    return { name: 'Data lock', status: 'FIX', detail: `others can read the shop's data: ${who}`, fix: "Lock it now — guide Part 26c, step 1 (the icacls lines). Until then the purchase staff's account and the Till account could read this copy's secrets (OB-284)." };
  }
  return { name: 'Data lock', status: 'OK', detail: `only you and Windows itself (SYSTEM) can read ${targets.join(', ')}` };
}

// ── OB-283: Docker Desktop's disk image on the data drive ─────────────────────────────────────────────────────────

/**
 * Where Docker Desktop keeps its disk image (the Linux disk holding the database), read from Docker Desktop's own
 * settings file in the owner's profile: %APPDATA%\Docker\settings-store.json (Docker Desktop 4.34 and later) or
 * settings.json (earlier), key "DataFolder"/"dataFolder" — the folder "Settings → Resources → Advanced → Disk image
 * location" shows. Read as a file; nothing is changed. { known: false } when the file or the key is not there.
 */
export function dockerDiskImage(deps) {
  const appData = String(deps.env?.APPDATA ?? '').trim();
  if (appData === '') return { known: false, why: 'Windows did not say where your profile\'s settings are (APPDATA)' };
  const p = pathFor('win32');
  for (const name of ['settings-store.json', 'settings.json']) {
    const file = p.join(appData, 'Docker', name);
    let parsed;
    try { parsed = JSON.parse(deps.fs.readFileSync(file, 'utf8')); } catch { continue; }
    if (parsed === null || typeof parsed !== 'object') continue;
    const key = Object.keys(parsed).find((k) => k.toLowerCase() === 'datafolder');
    const v = key === undefined ? undefined : parsed[key];
    if (typeof v === 'string' && v.trim() !== '') return { known: true, folder: v.trim(), file };
  }
  return { known: false, why: "Docker Desktop's settings file does not say (Docker Desktop may not be installed yet, or this version keeps it elsewhere)" };
}

/** The doctor's row on Docker's disk image: on the same drive as the shop's data. */
export function dockerDiskRow(deps, dataRoot) {
  const want = driveLetterOf(dataRoot);
  const target = `${want ?? 'F'}:\\DockerData`;
  const how = `Docker Desktop → Settings → Resources → Advanced → "Disk image location" → ${target} → Apply & restart (guide Part 2)`;
  const d = dockerDiskImage(deps);
  if (!d.known) return { name: 'Docker disk', status: 'NEEDS-YOU', detail: `not known where Docker Desktop keeps its disk image — ${d.why}`, fix: `Check it by eye: ${how}. It must say ${target}.` };
  const at = driveLetterOf(d.folder);
  if (want !== undefined && at === want) return { name: 'Docker disk', status: 'OK', detail: `Docker Desktop keeps its disk image in ${d.folder} — on ${want}:, the data drive` };
  return { name: 'Docker disk', status: 'FIX', detail: `Docker Desktop keeps its disk image in ${d.folder}${at === undefined ? '' : `, on ${at}:`} — not on ${want}:, where the shop's data is`, fix: `${how}. Then run this again.` };
}
