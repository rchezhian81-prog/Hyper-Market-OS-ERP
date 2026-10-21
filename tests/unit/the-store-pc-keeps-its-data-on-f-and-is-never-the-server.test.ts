import { describe, it, expect } from 'vitest';
import * as nodeFs from 'node:fs';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  backupVerdict, dataRootOnDrive, defaultDataRoot, doctorRows, main, resolveDataFolder, THRESHOLDS, type Deps, type DoctorRow,
} from '../../scripts/lib/store-computer.mjs';
import { folderRefusal } from '../../scripts/lib/store-computer-recovery.mjs';
import { autostart } from '../../scripts/lib/store-computer-schedule.mjs';
import { update } from '../../scripts/lib/store-computer-data.mjs';
import {
  administratorsRow, backupDriveProblem, dataLockRow, dockerDiskRow, driveKind, powershellPath, SCRIPTS, windowsEdition,
} from '../../scripts/lib/store-computer-windows.mjs';
import { layout } from '../../scripts/lib/store-computer.mjs';
import { OWNER_SID, settingsOf, world, type World } from '../support/store-computer-world';

/**
 * The owner's real pilot PC, from his Part 1 photos (21 Oct 2026): Windows 11 Pro 25H2, i3-14100, 8 GB, virtualisation on;
 * C: 41.9 GB free of 115 GB; F: an internal disk with 357 GB free; a shared office PC with a purchase-staff account. The
 * shop's other machine is a Windows Server 2022 running the old ERP.
 *
 *   OB-282 — doctor, prepare, up, autostart and update REFUSE on a Windows Server, asked read-only; nothing is changed.
 *   OB-283 — the data folder on F: (--data-drive F: → F:\SRE-data), RECORDED so every command finds it; the free space
 *            read on BOTH drives; Docker's disk image on the data drive (or NEEDS-YOU when it cannot be read).
 *   OB-281 — a backup goes ONLY to a USB or removable drive: every disk inside the PC is refused (F: too), a network
 *            folder is refused, and a drive whose kind is not known is refused.
 *   OB-284 — who is an administrator, and who can read the data folder: read-only checks.
 *
 * Driven with a pretend PowerShell (tests/support/store-computer-world.ts) and Windows paths mapped onto temporary
 * folders. NOTHING HERE RAN ON REAL WINDOWS.
 */

const GB = 1024 ** 3;
const said = (w: World): string => w.said.join('\n');

/**
 * The pilot PC: Windows paths mapped onto temporary folders — C:\SRE is the world's release folder; every other
 * X:\… is <tmp>/drive-x/…; C:\ProgramData, C:\Users and C:\SRE-data live on drive-c. Free space per drive as photographed.
 */
function pilotPc(w: World, free: Record<string, number> = { C: 41.9 * GB, F: 357 * GB, E: 900 * GB, G: 900 * GB }, over: Partial<Deps> = {}): Deps & { drives: string } {
  const drives = `${w.root}-drives`;
  for (const l of ['c', 'e', 'f', 'g', 'h']) mkdirSync(join(drives, `drive-${l}`), { recursive: true });
  const map = (p: unknown): unknown => {
    if (typeof p !== 'string' || !/^[A-Za-z]:(\\|$)/.test(p)) return p;
    if (/^C:\\SRE(\\|$)/i.test(p)) return w.root + p.slice(6).replace(/\\/g, '/');
    return join(drives, `drive-${p[0]!.toLowerCase()}`, p.slice(3).replace(/\\/g, '/'));
  };
  const fs = new Proxy(nodeFs, { get: (t, k) => { const f = (t as Record<string | symbol, unknown>)[k]; return typeof f === 'function' ? (...a: unknown[]) => (f as (...x: unknown[]) => unknown).apply(t, a.map(map)) : f; } });
  return {
    ...w.deps,
    platform: 'win32',
    repoRoot: 'C:\\SRE',
    dataRoot: 'C:\\SRE-data',
    dataPointer: 'C:\\ProgramData\\SRE\\data-folder.json',
    env: { SystemDrive: 'C:', SystemRoot: 'C:\\Windows', ProgramData: 'C:\\ProgramData', APPDATA: 'C:\\Users\\owner\\AppData\\Roaming', USERNAME: 'owner', USERDOMAIN: 'SHOP-PC', npm_config_user_agent: 'pnpm/10.33.0 npm/? node/v22.11.0 win32 x64' },
    os: { totalmem: () => 7.8 * GB, release: () => '10.0.26200', version: () => 'Windows 10 Pro' },
    freeDiskBytes: (dir: string) => { const v = free[String(dir)[0]!.toUpperCase()]; if (v === undefined) throw new Error('no drive'); return v; },
    fs: fs as Deps['fs'],
    ...over,
    drives,
  };
}
const onDrive = (d: { drives: string }, letter: string, ...rest: string[]): string => join(d.drives, `drive-${letter.toLowerCase()}`, ...rest);
const rowsOf = (deps: Deps): Record<string, DoctorRow> => Object.fromEntries(doctorRows(deps).map((r) => [r.name, r]));

describe('OB-282 — never on a Windows Server: asked read-only, and every installing command refuses', () => {
  const server = (w: World): void => { w.windows.edition = { productType: 3, caption: 'Microsoft Windows Server 2022 Standard' }; };

  it('doctor, prepare, up, autostart and update each refuse, say it is the old ERP\'s server, and change nothing', async () => {
    for (const run of [
      (d: Deps) => main(['doctor'], d),
      (d: Deps) => main(['prepare', '--data-drive', 'F:'], d),
      (d: Deps) => main(['up'], d),
      (d: Deps) => autostart(d, {}),
      (d: Deps) => update(d, { from: 'C:\\SRE-2026-11' }),
    ]) {
      const w = world();
      server(w);
      const d = pilotPc(w);
      expect(await run(d)).toBe(2);
      expect(said(w)).toMatch(/REFUSED — this computer is a Windows Server \("Microsoft Windows Server 2022 Standard"\)\. That is the shop's server, which runs the old ERP/);
      expect(said(w)).toMatch(/OB-282/);
      // Nothing was written, started or registered: no settings, no note, no Docker call, no Windows task.
      expect(existsSync(onDrive(d, 'F', 'SRE-data'))).toBe(false);
      expect(existsSync(onDrive(d, 'C', 'ProgramData'))).toBe(false);
      expect(w.calls.filter((c) => c.cmd === 'docker')).toEqual([]);
      expect(w.tasks.registered.size).toBe(0);
    }
  });

  it('ProductType 2 (a domain controller), or "Server" in the caption, or in Node\'s own reading when PowerShell does not answer', () => {
    const w = world();
    const d = pilotPc(w);
    w.windows.edition = { productType: 2, caption: 'Microsoft Windows Server 2019' };
    expect(windowsEdition(d)).toMatchObject({ server: true, known: true });
    w.windows.edition = { productType: 1, caption: 'Microsoft Windows Server 2022 Standard Evaluation' };
    expect(windowsEdition(d).server).toBe(true);
    w.windows.edition = 'fail';
    expect(windowsEdition({ ...d, os: { ...d.os, version: () => 'Windows Server 2022 Standard' } })).toMatchObject({ server: true, known: true });
    // The owner's PC: a workstation.
    w.windows.edition = { productType: 1, caption: 'Microsoft Windows 11 Pro' };
    expect(windowsEdition(d)).toEqual({ applies: true, known: true, server: false, productType: 1, caption: 'Microsoft Windows 11 Pro' });
  });

  it('when Windows does not answer and nothing says Server, doctor says NEEDS-YOU (never OK) and the setup is not blocked', async () => {
    const w = world();
    w.windows.edition = 'fail';
    const d = pilotPc(w);
    expect(rowsOf(d)['Edition']).toMatchObject({ status: 'NEEDS-YOU', fix: expect.stringMatching(/never "Windows Server".*OB-282/) });
    expect(await main(['prepare', '--data-drive', 'F:'], d)).toBe(0);
  });

  it('each question is one fixed script with no double quote, run by its full path with an argument array; inputs go in variables', () => {
    for (const s of Object.values(SCRIPTS)) expect(s).not.toContain('"');
    const w = world();
    const d = pilotPc(w);
    driveKind(d, 'F');
    const call = w.calls.find((c) => c.cmd.endsWith('powershell.exe'))!;
    expect(call.cmd).toBe(powershellPath(d.env));
    expect(call.cmd).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(call.args).toEqual(['-NoProfile', '-NonInteractive', '-Command', SCRIPTS.drive]);
    expect(call.env?.['SRE_DRIVE_LETTER']).toBe('F');
    // A drive "letter" that is not one letter never reaches Windows.
    w.calls.length = 0;
    expect(driveKind(d, 'F:\\x; Remove-Item')).toEqual({ kind: 'unknown' });
    expect(w.calls).toEqual([]);
  });
});

describe('OB-283 — the shop\'s data on F:, recorded so every command finds it', () => {
  it('--data-drive F: gives F:\\SRE-data; a USB drive, a missing drive or a path is refused', () => {
    const w = world();
    const d = pilotPc(w);
    expect(dataRootOnDrive(d, 'F:')).toMatchObject({ dataRoot: 'F:\\SRE-data', note: expect.stringMatching(/F: is a disk inside this computer \(SATA\)/) });
    expect(dataRootOnDrive(d, 'f:\\')).toMatchObject({ dataRoot: 'F:\\SRE-data' });
    expect(dataRootOnDrive(d, 'E:').problem).toMatch(/E: is a USB or removable drive.*OB-283.*OB-281/);
    expect(dataRootOnDrive(d, 'Q:').problem).toMatch(/there is no drive Q:/);
    expect(dataRootOnDrive(d, 'F:\\SRE-data').problem).toMatch(/takes a drive letter, for example --data-drive F:/);
    w.windows.drives['H'] = 'fail';
    expect(dataRootOnDrive(d, 'H:').problem).toMatch(/Windows did not say what kind of drive H: is/);
  });

  it('prepare --data-drive F: writes the settings in F:\\SRE-data and records it; every later command finds it there', async () => {
    const w = world();
    const d = pilotPc(w);
    expect(await main(['prepare', '--data-drive', 'F:'], d)).toBe(0);
    expect(said(w)).toMatch(/Settings file written: F:\\SRE-data\\\.env\.real/);
    expect(said(w)).toMatch(/recorded in C:\\ProgramData\\SRE\\data-folder\.json/);
    expect(said(w)).toMatch(/lock the data folder NOW.*Part 26c/);
    expect(existsSync(onDrive(d, 'F', 'SRE-data', '.env.real'))).toBe(true);
    expect(existsSync(onDrive(d, 'C', 'SRE-data'))).toBe(false);
    const note = JSON.parse(readFileSync(onDrive(d, 'C', 'ProgramData', 'SRE', 'data-folder.json'), 'utf8')) as Record<string, unknown>;
    expect(note).toMatchObject({ kind: 'sre-data-folder', version: 1, dataRoot: 'F:\\SRE-data', setBy: 'store-computer prepare' });
    // The note holds no secret.
    const s = readFileSync(onDrive(d, 'F', 'SRE-data', '.env.real'), 'utf8');
    for (const line of s.split('\n').filter((l) => /^(POSTGRES_PASSWORD|PACK_SIGNING_KEY|IDP_SIGNING_KEY)=/.test(l))) expect(JSON.stringify(note)).not.toContain(line.split('=')[1]);

    // A new command starts with only the fall-back (C:\SRE-data) — and finds F: from the note.
    expect(resolveDataFolder(d).deps?.dataRoot).toBe('F:\\SRE-data');
    w.said.length = 0;
    expect(await main(['up'], d)).toBe(0);
    const up = w.calls.find((c) => c.cmd === 'docker' && c.args.includes('up'))!;
    expect(up.args.slice(0, 7)).toEqual(['compose', '-p', 'sre-real', '-f', 'docker-compose.yml', '--env-file', 'F:\\SRE-data\\.env.real']);
    // till:pin and every other script read the same note (defaultDataRoot).
    expect(defaultDataRoot('C:\\SRE', 'win32', d.env, d.fs)).toBe('F:\\SRE-data');
    // A second prepare refuses: the file is never overwritten.
    w.said.length = 0;
    expect(await main(['prepare'], d)).toBe(2);
    expect(said(w)).toMatch(/REFUSED — F:\\SRE-data\\\.env\.real already exists/);
  });

  it('a copy already set up in C:\\SRE-data is never set up again on F: — prepare points to migrate-data-folder', async () => {
    const w = world();
    const d = pilotPc(w, undefined, { dataPointer: undefined });
    expect(await main(['prepare'], d)).toBe(0);
    w.said.length = 0;
    expect(await main(['prepare', '--data-drive', 'F:'], d)).toBe(2);
    expect(said(w)).toMatch(/already set up: its settings are in C:\\SRE-data\\\.env\.real.*\n.*migrate-data-folder --data-drive F:/);
    expect(existsSync(onDrive(d, 'F', 'SRE-data'))).toBe(false);
  });

  it('a note that cannot be read, that names a folder no longer there, or that SRE_DATA_DIR contradicts stops every command', async () => {
    const w = world();
    const d = pilotPc(w);
    const note = onDrive(d, 'C', 'ProgramData', 'SRE', 'data-folder.json');
    mkdirSync(join(note, '..'), { recursive: true });
    writeFileSync(note, '{ not json');
    expect(await main(['status'], d)).toBe(2);
    expect(said(w)).toMatch(/REFUSED — the note that says where the shop's data folder is .* cannot be read/);
    writeFileSync(note, JSON.stringify({ kind: 'sre-data-folder', version: 1, dataRoot: 'F:\\SRE-data' }));
    w.said.length = 0;
    // F:\SRE-data is not there (a drive missing, or its letter changed): never a quiet fall-back to C:\SRE-data.
    expect(await main(['prepare'], d)).toBe(2);
    expect(said(w)).toMatch(/recorded as F:\\SRE-data, but it is not there\. Is drive F: missing/);
    expect(existsSync(onDrive(d, 'C', 'SRE-data'))).toBe(false);
    mkdirSync(onDrive(d, 'F', 'SRE-data'));
    expect(resolveDataFolder({ ...d, env: { ...d.env, SRE_DATA_DIR: 'C:\\SRE-data' } }).problem).toMatch(/SRE_DATA_DIR=C:\\SRE-data, but this computer's data folder is recorded as F:\\SRE-data/);
    expect(resolveDataFolder(d).deps?.dataRoot).toBe('F:\\SRE-data');
  });

  it('doctor reads the free space on BOTH drives and says which is which: F: ≥ 50 GB for the data, C: ≥ 15 GB for the programs', () => {
    expect(THRESHOLDS.systemDriveBytes).toBe(15 * GB);
    const w = world();
    const onF = { dataRoot: 'F:\\SRE-data' };
    const r = rowsOf(pilotPc(w, undefined, onF));
    expect(r['Data drive']).toMatchObject({ status: 'OK', detail: expect.stringMatching(/357\.0 GB free on F:, the drive that holds the shop's data \(F:\\SRE-data\) and Docker's disk image/) });
    expect(r['C: drive']).toMatchObject({ status: 'OK', detail: expect.stringMatching(/41\.9 GB free on C:, which keeps the system's folders \(C:\\SRE\) and the programs/) });
    expect(r['Data disk']).toMatchObject({ status: 'OK', detail: expect.stringMatching(/F: is a disk inside this computer/) });
    expect(r['Free disk']).toBeUndefined();
    expect(rowsOf(pilotPc(w, { C: 14.9 * GB, F: 357 * GB }, onF))['C: drive']).toMatchObject({ status: 'FIX', fix: expect.stringMatching(/at least 15 GB free/) });
    expect(rowsOf(pilotPc(w, { C: 41.9 * GB, F: 49 * GB }, onF))['Data drive']).toMatchObject({ status: 'FIX', fix: expect.stringMatching(/F: has at least 50 GB free/) });
    expect(rowsOf(pilotPc(w, { C: 41.9 * GB }, onF))['Data drive']).toMatchObject({ status: 'FIX', detail: 'could not read the free space on F:' });
    // The photographed PC with the data on C: — 41.9 GB is under 50 GB: FIX, and the fix names the F: way.
    expect(rowsOf(pilotPc(w))['Free disk']).toMatchObject({ status: 'FIX', detail: expect.stringMatching(/41\.9 GB free on C:/), fix: expect.stringMatching(/doctor --data-drive F:/) });
    // The data on a USB drive is a FIX.
    expect(rowsOf(pilotPc(w, { C: 41.9 * GB, E: 900 * GB }, { dataRoot: 'E:\\SRE-data' }))['Data disk']).toMatchObject({ status: 'FIX', detail: expect.stringMatching(/E: is a USB or removable drive/) });
  });

  it('doctor --data-drive F: checks the photographed PC as it will be set up, and names prepare --data-drive F: next', async () => {
    const w = world();
    const d = pilotPc(w);
    mkdirSync(join(onDrive(d, 'C', 'Users', 'owner', 'AppData', 'Roaming', 'Docker')), { recursive: true });
    writeFileSync(onDrive(d, 'C', 'Users', 'owner', 'AppData', 'Roaming', 'Docker', 'settings-store.json'), JSON.stringify({ DataFolder: 'F:\\DockerData', MemoryMiB: 4096 }));
    expect(await main(['doctor', '--data-drive', 'F:'], d)).toBe(0);
    const text = said(w);
    expect(text).toMatch(/OK\s+Data drive\s+357\.0 GB free on F:/);
    expect(text).toMatch(/OK\s+C: drive\s+41\.9 GB free on C:/);
    expect(text).toMatch(/OK\s+Docker disk\s+Docker Desktop keeps its disk image in F:\\DockerData — on F:, the data drive/);
    expect(text).toMatch(/OK\s+Admins\s+only you \(SHOP-PC\\owner\) are an administrator \(SHOP-PC\\Administrator: switched off\)/);
    expect(text).toMatch(/NEEDS-YOU\s+Data lock\s+the shop's data folder is not made yet/);
    expect(text).toMatch(/No FIX\. 1 line\(s\) say NEEDS-YOU.*Next: pnpm run store-computer -- prepare --data-drive F:/);
    // doctor only reads: nothing was made.
    expect(existsSync(onDrive(d, 'F', 'SRE-data'))).toBe(false);
    expect(existsSync(onDrive(d, 'C', 'ProgramData'))).toBe(false);
  });

  it('Docker\'s disk image: on F: is OK; on C: is a FIX with the exact Settings path; not readable is NEEDS-YOU, never OK', () => {
    const w = world();
    const d = pilotPc(w);
    const dir = onDrive(d, 'C', 'Users', 'owner', 'AppData', 'Roaming', 'Docker');
    expect(dockerDiskRow(d, 'F:\\SRE-data')).toMatchObject({ status: 'NEEDS-YOU', fix: expect.stringMatching(/Settings → Resources → Advanced → "Disk image location" → F:\\DockerData → Apply & restart/) });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ dataFolder: 'C:\\Users\\owner\\AppData\\Local\\Docker\\wsl' }));
    expect(dockerDiskRow(d, 'F:\\SRE-data')).toMatchObject({ status: 'FIX', detail: expect.stringMatching(/in C:\\Users\\owner\\AppData\\Local\\Docker\\wsl, on C: — not on F:/), fix: expect.stringMatching(/"Disk image location" → F:\\DockerData → Apply & restart/) });
    // The newer settings file wins over the older one.
    writeFileSync(join(dir, 'settings-store.json'), JSON.stringify({ DataFolder: 'F:\\DockerData' }));
    expect(dockerDiskRow(d, 'F:\\SRE-data').status).toBe('OK');
    writeFileSync(join(dir, 'settings-store.json'), JSON.stringify({ SomethingElse: 1 }));
    writeFileSync(join(dir, 'settings.json'), 'not json');
    expect(dockerDiskRow(d, 'F:\\SRE-data').status).toBe('NEEDS-YOU');
  });
});

describe('OB-281 · OB-283 — a backup goes only to a USB or removable drive; every disk inside this PC is refused', () => {
  it('USB hard disk and removable drive accepted; F: (inside), a second inside disk, a network drive, an unknown kind refused', () => {
    const w = world();
    const d = pilotPc(w, undefined, { dataRoot: 'F:\\SRE-data' });
    w.windows.drives['H'] = { driveType: 3, bus: 'NVMe' };
    w.windows.drives['N'] = { driveType: 4, bus: '' };
    w.windows.drives['U'] = { driveType: 3, bus: '' };
    w.windows.drives['V'] = 'fail';
    w.windows.drives['K'] = { driveType: 3, bus: '7' };
    w.windows.drives['L'] = { driveType: 3, bus: '11' };
    expect(backupDriveProblem(d, 'E:\\sre-real')).toBeUndefined(); // a USB hard disk reports "fixed": its bus decides
    expect(backupDriveProblem(d, 'G:\\sre-auto')).toBeUndefined(); // a removable drive
    expect(backupDriveProblem(d, 'K:\\sre')).toBeUndefined(); // the bus as a number (7 = USB)
    expect(backupDriveProblem(d, 'F:\\backup')).toMatch(/F:, a disk inside this computer \(SATA\)\. A disk inside this PC is never a backup.*OB-281, OB-283/);
    expect(backupDriveProblem(d, 'H:\\backup')).toMatch(/H:, a disk inside this computer \(NVMe\)/);
    expect(backupDriveProblem(d, 'L:\\backup')).toMatch(/L:, a disk inside this computer \(SATA\)/);
    expect(backupDriveProblem(d, 'N:\\backup')).toMatch(/a network drive.*OB-282/);
    expect(backupDriveProblem(d, '\\\\SERVER\\backups')).toMatch(/is a network folder.*never to the shop's server \(OB-282\)/);
    expect(backupDriveProblem(d, 'U:\\backup')).toMatch(/Windows did not say what kind of drive U: is, so it is not accepted/);
    expect(backupDriveProblem(d, 'V:\\backup')).toMatch(/Windows did not say what kind of drive V: is/);
    expect(backupDriveProblem(d, 'Q:\\backup')).toMatch(/there is no drive Q: on this computer\. Is the USB backup drive plugged in/);
    // The folder check every backup command uses: F: is refused even outside the data folder (it is the data's drive).
    expect(folderRefusal(d, 'F:\\backup')).toMatch(/F:\\backup is on this computer's own drive \(F:\)/);
    expect(folderRefusal(d, 'H:\\backup')).toMatch(/a disk inside this computer.*never onto a disk inside this computer/);
    expect(folderRefusal(d, 'E:\\sre-real')).toBeUndefined();
  });

  it('backup --to and schedule-backup --to refuse an inside disk before anything is written; check 10 fails on one', async () => {
    const w = world();
    const d = pilotPc(w);
    expect(await main(['prepare', '--data-drive', 'F:'], d)).toBe(0);
    w.windows.drives['H'] = { driveType: 3, bus: 'SATA' };
    w.said.length = 0;
    expect(await main(['backup', '--to', 'H:\\sre-real'], d)).toBe(2);
    expect(said(w)).toMatch(/REFUSED — H:\\sre-real is on H:, a disk inside this computer \(SATA\)/);
    expect(await main(['backup', '--to', 'F:\\sre-real'], d)).toBe(2);
    expect(said(w)).toMatch(/REFUSED — F:\\sre-real is on this computer's own drive \(F:\)/);
    expect(await main(['schedule-backup', '--to', 'H:\\sre-auto', '--every', '60'], d)).toBe(2);
    expect(existsSync(onDrive(d, 'H', 'sre-real'))).toBe(false);
    expect(existsSync(onDrive(d, 'H', 'sre-auto'))).toBe(false);
    expect(w.calls.filter((c) => c.cmd === 'docker' && c.args.includes('exec'))).toEqual([]);
    expect(w.tasks.registered.size).toBe(0);
    // Check 10 on a record whose folder is on an inside disk: FAIL, even though it restored.
    const where = { platform: 'win32', repoRoot: 'C:\\SRE', systemDrive: 'C:', dataRoot: 'F:\\SRE-data', driveProblem: (x: string) => backupDriveProblem(d, x) };
    expect(backupVerdict({ outcome: 'restored_and_reconciled', offsiteDir: 'H:\\sre-real' }, where)).toMatchObject({ status: 'FAIL', detail: expect.stringMatching(/not accepted as a backup drive: H:\\sre-real is on H:, a disk inside this computer/) });
    expect(backupVerdict({ outcome: 'restored_and_reconciled', offsiteDir: 'E:\\sre-real' }, where).status).toBe('PASS');
  });

  it('a backup to the USB drive E: still works end to end on the pilot PC, with the data on F:', async () => {
    const w = world();
    const d = pilotPc(w);
    expect(await main(['prepare', '--data-drive', 'F:'], d)).toBe(0);
    w.said.length = 0;
    expect(await main(['backup', '--to', 'E:\\sre-real'], d)).toBe(0);
    expect(said(w)).toMatch(/BACKUP DONE/);
    expect(existsSync(onDrive(d, 'F', 'SRE-data', 'backup', 'backup-key.json'))).toBe(true);
  });
});

describe('OB-284 — a shared office PC: who is an administrator, and who can read the data (read-only)', () => {
  it('only the owner: OK; the purchase account an administrator: FIX naming it; signed in as someone else: FIX; no answer: NEEDS-YOU', () => {
    const w = world();
    const d = pilotPc(w);
    expect(administratorsRow(d)).toMatchObject({ status: 'OK' });
    w.windows.admins = [{ sid: OWNER_SID, name: 'SHOP-PC\\owner' }, { sid: 'S-1-5-21-1111-2222-3333-1002', name: 'SHOP-PC\\purchase' }];
    expect(administratorsRow(d)).toMatchObject({ status: 'FIX', detail: 'administrators of this PC: you (SHOP-PC\\owner) and also SHOP-PC\\purchase', fix: expect.stringMatching(/must be Standard Users.*send me a photo.*Part 26a/) });
    w.windows.admins = [{ sid: 'S-1-5-21-1111-2222-3333-1002', name: 'SHOP-PC\\purchase' }];
    w.windows.me = { sid: 'S-1-5-21-1111-2222-3333-1003', name: 'SHOP-PC\\Till' };
    expect(administratorsRow(d)).toMatchObject({ status: 'FIX', detail: expect.stringMatching(/signed in as SHOP-PC\\Till, which is not an administrator/), fix: expect.stringMatching(/YOUR OWN administrator account \(OB-284\)/) });
    w.windows.admins = 'fail';
    expect(administratorsRow(d)).toMatchObject({ status: 'NEEDS-YOU', fix: expect.stringMatching(/net localgroup Administrators/) });
  });

  it('the data folder locked to the owner and SYSTEM: OK; Users or the purchase account can read it: FIX; no answer: NEEDS-YOU', async () => {
    const w = world();
    const d = pilotPc(w);
    expect(await main(['prepare', '--data-drive', 'F:'], d)).toBe(0);
    const L = layout('C:\\SRE', 'win32', 'F:\\SRE-data');
    expect(dataLockRow(d, L, d.dataPointer)).toMatchObject({ status: 'OK', detail: expect.stringMatching(/only you and Windows itself \(SYSTEM\) can read F:\\SRE-data, F:\\SRE-data\\\.env\.real, C:\\ProgramData\\SRE/) });
    // Windows' default: every account on the PC may read a new folder.
    w.windows.acl['f:\\sre-data'] = [...w.windows.aclDefault as never[], { sid: 'S-1-5-32-545', name: 'BUILTIN\\Users', rights: 1179817 }];
    expect(dataLockRow(d, L, d.dataPointer)).toMatchObject({ status: 'FIX', detail: expect.stringMatching(/others can read the shop's data: Users \(every account on this PC\) \(F:\\SRE-data\)/), fix: expect.stringMatching(/Part 26c, step 1/) });
    // GENERIC_READ (the high bit, printed as a negative number) counts; a Deny entry is not a reader.
    w.windows.acl['f:\\sre-data'] = [...w.windows.aclDefault as never[], { sid: 'S-1-5-21-1111-2222-3333-1002', name: 'SHOP-PC\\purchase', rights: -2147483648 }, { sid: 'S-1-5-32-546', name: 'BUILTIN\\Guests', type: 'Deny', rights: 2032127 }];
    expect(dataLockRow(d, L, d.dataPointer).detail).toBe("others can read the shop's data: SHOP-PC\\purchase (F:\\SRE-data)");
    // Administrators as a group is "someone else" too: only the owner's own account and SYSTEM (OB-284).
    w.windows.acl['f:\\sre-data'] = [...w.windows.aclDefault as never[], { sid: 'S-1-5-32-544', name: 'BUILTIN\\Administrators', rights: 2032127 }];
    expect(dataLockRow(d, L, d.dataPointer).status).toBe('FIX');
    w.windows.acl['f:\\sre-data\\.env.real'] = 'fail';
    expect(dataLockRow(d, L, d.dataPointer)).toMatchObject({ status: 'NEEDS-YOU', fix: expect.stringMatching(/icacls F:\\SRE-data\\\.env\.real/) });
    // Only reading: no script that changes a permission was run.
    expect(w.windows.asked.every((a) => !/Set-Acl|icacls|Add-LocalGroupMember/i.test(a.script))).toBe(true);
  });
});

describe('migrate-data-folder --data-drive — a data folder already set up moves WHOLE to the data drive', () => {
  /** A Linux-shaped world (the logic is the same): the "data drive" is a temporary folder; the note is recorded. */
  function setUp(): { w: World; deps: Deps; drive: string; note: string } {
    const w = world();
    const drive = `${w.root}-drive-f`;
    mkdirSync(drive);
    const note = `${w.root}-programdata/SRE/data-folder.json`;
    return { w, drive, note, deps: { ...w.deps, dataPointer: note } };
  }

  it('every file copied and checked, the till\'s settings pointed at the new place, the place recorded, the old folder kept', async () => {
    const { w, deps, drive, note } = setUp();
    expect(await main(['prepare'], deps)).toBe(0);
    const tillDir = join(w.data, 'till');
    mkdirSync(join(tillDir, 'edge-data'), { recursive: true });
    writeFileSync(join(tillDir, 'edge-data', 'sales.log'), 'sale 1\n');
    writeFileSync(join(tillDir, 'till.env'), `EDGE_DATA_DIR=${join(tillDir, 'edge-data')}\nEDGE_WITNESS_DIR=${join(tillDir, 'edge-witness')}\nEDGE_LANE_PORT=8090\n`);
    mkdirSync(join(w.data, 'records'));
    writeFileSync(join(w.data, 'records', 'g4-check-1.json'), '{}\n');
    const before = settingsOf(w);
    w.said.length = 0;
    expect(await main(['migrate-data-folder', '--data-drive', drive], deps)).toBe(0);
    const to = join(drive, 'SRE-data');
    expect(said(w)).toMatch(new RegExp(`MOVED — this copy's data is now in ${to.replace(/[/\\]/g, '.')}`));
    expect(readFileSync(join(to, 'till', 'edge-data', 'sales.log'), 'utf8')).toBe('sale 1\n');
    expect(existsSync(join(to, 'records', 'g4-check-1.json'))).toBe(true);
    const tillEnv = readFileSync(join(to, 'till', 'till.env'), 'utf8');
    expect(tillEnv).toContain(`EDGE_DATA_DIR=${join(to, 'till', 'edge-data')}`);
    expect(tillEnv).toContain(`EDGE_STORE_COMPUTER_STATUS_FILE=${join(to, 'status', 'store-computer-status.json')}`);
    expect(JSON.parse(readFileSync(note, 'utf8'))).toMatchObject({ dataRoot: to, setBy: 'store-computer migrate-data-folder' });
    // The old folder is renamed, never deleted; the settings in the new place are byte for byte the old ones.
    expect(existsSync(w.data)).toBe(false);
    const kept = nodeFs.readdirSync(join(w.data, '..')).filter((n) => n.startsWith(`${w.data.split('/').pop()}.moved-to-`));
    expect(kept).toHaveLength(1);
    expect(readFileSync(join(to, '.env.real'), 'utf8')).toBe(readFileSync(join(w.data, '..', kept[0]!, '.env.real'), 'utf8'));
    expect(Object.keys(before)).toContain('EDGE_TENANT_ID');
    // The next command finds the new place.
    expect(resolveDataFolder(deps).deps?.dataRoot).toBe(to);
    // And again: nothing to move.
    w.said.length = 0;
    expect(await main(['migrate-data-folder', '--data-drive', drive], deps)).toBe(0);
    expect(said(w)).toMatch(/Nothing to move/);
  });

  it('refused while the Windows tasks run from the old folder, or the till runs — nothing is copied', async () => {
    const { w, deps, drive } = setUp();
    expect(await main(['prepare'], deps)).toBe(0);
    w.tasks.registered.set('SRE\\Automatic backup', '<xml/>');
    expect(await main(['migrate-data-folder', '--data-drive', drive], deps)).toBe(2);
    expect(said(w)).toMatch(/the Windows tasks "SRE\\Automatic backup" run from .*\n.*unschedule-backup.*autostart --off/);
    w.tasks.registered.clear();
    mkdirSync(join(w.data, 'till'), { recursive: true });
    writeFileSync(join(w.data, 'till', 'till.env'), 'EDGE_LANE_PORT=8090\n');
    w.ports.add(8090);
    w.said.length = 0;
    expect(await main(['migrate-data-folder', '--data-drive', drive], deps)).toBe(2);
    expect(said(w)).toMatch(/REFUSED — the till is running/);
    expect(existsSync(join(drive, 'SRE-data'))).toBe(false);
    expect(existsSync(join(w.data, '.env.real'))).toBe(true);
  });

  it('--data-drive goes with doctor, prepare and migrate-data-folder only', async () => {
    const { w, deps, drive } = setUp();
    expect(await main(['status', '--data-drive', drive], deps)).toBe(2);
    expect(said(w)).toMatch(/--data-drive goes with doctor, prepare and migrate-data-folder only/);
  });
});
