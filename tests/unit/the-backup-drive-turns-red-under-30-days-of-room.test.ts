import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepare, resolveLayout } from '../../scripts/lib/store-computer.mjs';
import { ALERT_RULES, backupRoom, collectStatus, status } from '../../scripts/lib/store-computer-status.mjs';
import { backupStatus, scheduleBackup } from '../../scripts/lib/store-computer-schedule.mjs';
import { recordBackupOutcome } from '../../scripts/lib/store-computer-recovery.mjs';
import { judgeStoreComputerStatus } from '../../edge/store-edge/src/store-computer-status-file';
import { world, type World } from '../support/store-computer-world';

/**
 * OB-268 (owner, 20 Oct 2026, "Under 30 days left") — the OB-262 follow-up. Nothing is ever deleted, so the backup drive
 * that stays plugged in fills; `store-computer status` and `backup-status` turn RED when it has room for fewer than about
 * 30 more days of backups AT THE CURRENT RATE: the last good backup's size × the backups a day the schedule takes. The red
 * line reaches the status file the till's box reads, and from there the office screen's banner, in English and Tamil.
 * When the rate cannot be worked out yet — no backup taken, the drive or its free space unreadable, no schedule — it says
 * "not known" (neither OK nor red), never a number it does not have (P-08).
 */

const GiB = 1024 ** 3;
const WIN_ENV = { USERNAME: 'owner', USERDOMAIN: 'SRE-STORE-PC', SystemRoot: 'C:\\Windows' };

/** A store computer with automatic backup every 60 minutes to `drive`, whose free space is `driveFree`, and its last good backup `lastBytes` big. */
async function scheduled(driveFree: number | undefined, lastBytes: number): Promise<World & { drive: string }> {
  const w = world();
  w.deps = { ...w.deps, env: { ...WIN_ENV } };
  expect(await prepare(w.deps)).toBe(0);
  const drive = mkdtempSync(join(tmpdir(), 'sre-ob268-drive-'));
  expect(await scheduleBackup(w.deps, { to: drive, every: '60' })).toBe(0);
  const data = w.deps.diskSpace!;
  w.deps = {
    ...w.deps,
    diskSpace: (where: string) => {
      if (!where.startsWith(drive)) return data(where);
      if (driveFree === undefined) throw new Error('EIO');
      return { free: driveFree, total: 2000 * GiB };
    },
  };
  // The newest good backup, as the backup records it (the parts' sizes).
  recordBackupOutcome(w.deps, resolveLayout(w.deps), {
    kind: 'automatic', to: drive, ok: true, manifestPath: join(drive, 'm.json'),
    manifest: { backupId: 'sre-real-backup-big', timeTakenMs: 1000, parts: { database: { sizeBytes: lastBytes - 2 }, files: { sizeBytes: 1 }, settings: { sizeBytes: 1 } } },
  });
  w.said.length = 0;
  return Object.assign(w, { drive });
}

describe('OB-268 — the backup drive turns red under about 30 days of room at the current rate', () => {
  it('the rule is the owner\'s: 30 days', () => {
    expect(ALERT_RULES.backupDriveMinDays).toBe(30);
  });

  it('1 GiB a backup, 24 a day, 500 GiB free → about 20 days: RED, in both languages, in the status file and on the office banner', async () => {
    const w = await scheduled(500 * GiB, GiB);
    const room = backupRoom(w.deps, resolveLayout(w.deps));
    expect(room).toMatchObject({ known: true, days: 20 });
    const s = await collectStatus(w.deps);
    expect(s.overall).toBe('red');
    const alert = s.alerts.find((a) => a.code === 'backup_drive_filling')!;
    expect(alert.en).toBe('The backup drive has room for about 20 more day(s) of backups at the current rate — under 30 days. Nothing is ever deleted: decide what to keep, or plug in a bigger drive.');
    expect(alert.ta).toMatch(/சுமார் 20 நாள்\(கள்\)/);
    expect(s.checks.find((c) => c.name === 'Drive room')).toMatchObject({ ok: false, detail: expect.stringMatching(/^room for about 20 more day\(s\) of backups \(500\.0 GB free, 24576\.0 MB a day\) — under 30 days$/) });

    // The command prints it and writes the file; the till's box reads that file and the office screen draws the banner.
    expect(await status(w.deps)).toBe(1);
    expect(w.said.join('\n')).toMatch(/RED {2}Drive room room for about 20 more day\(s\)/);
    const file = readFileSync(join(w.data, 'status', 'store-computer-status.json'), 'utf8');
    const banner = judgeStoreComputerStatus(file, w.deps.now().getTime());
    expect(banner.overall).toBe('red');
    expect(banner.alerts).toContainEqual({ code: 'backup_drive_filling', en: alert.en, ta: alert.ta });

    // backup-status says the same and exits 1, even with the last backup fresh.
    w.said.length = 0;
    expect(await backupStatus(w.deps)).toBe(1);
    const out = w.said.join('\n');
    expect(out).toMatch(/room for about 20 more day\(s\) at the current rate \(RED: under 30 days\)/);
    expect(out).toMatch(/^OK — the last good backup is less than 2 hours old\.$/m);
    expect(out).toMatch(/^RED — the backup drive has room for about 20 more day\(s\) of backups at the current rate, under 30\. Nothing is ever deleted/m);
  });

  it('exactly 30 days is not red; 29 is — "fewer than about 30"', async () => {
    const at30 = await scheduled(30 * 24 * GiB, GiB);
    expect(backupRoom(at30.deps, resolveLayout(at30.deps))).toMatchObject({ known: true, days: 30 });
    expect((await collectStatus(at30.deps)).alerts.map((a) => a.code)).not.toContain('backup_drive_filling');
    expect((await collectStatus(at30.deps)).checks.find((c) => c.name === 'Drive room')?.ok).toBe(true);
    expect(await backupStatus(at30.deps)).toBe(0);
    const at29 = await scheduled(30 * 24 * GiB - 1, GiB);
    expect(backupRoom(at29.deps, resolveLayout(at29.deps))).toMatchObject({ known: true, days: 29 });
    expect((await collectStatus(at29.deps)).alerts.map((a) => a.code)).toContain('backup_drive_filling');
  });

  it('the CURRENT rate is the newest backup, not the average: a shop that grew is measured as it is now', async () => {
    // Small backups on the drive (the first one schedule-backup took), but the newest is 2 GiB: 48 GiB a day.
    const w = await scheduled(1000 * GiB, 2 * GiB);
    expect(backupRoom(w.deps, resolveLayout(w.deps))).toMatchObject({ known: true, days: 20 });
  });

  it('"not known" — no schedule, the drive unreadable, its free space unreadable, no backup yet — never red, never a number', async () => {
    // No schedule.
    const none = world();
    expect(await prepare(none.deps)).toBe(0);
    const L0 = resolveLayout(none.deps);
    expect(backupRoom(none.deps, L0)).toMatchObject({ known: false, why: { en: 'automatic backup is not set up, so there is no backup drive to measure' } });
    const s0 = await collectStatus(none.deps);
    expect(s0.checks.find((c) => c.name === 'Drive room')).toEqual({ name: 'Drive room', ok: null, detail: 'not known — automatic backup is not set up, so there is no backup drive to measure' });
    expect(s0.alerts.map((a) => a.code)).not.toContain('backup_drive_filling');
    none.said.length = 0;
    await status(none.deps);
    expect(none.said.join('\n')).toMatch(/ {3}\? {3}Drive room not known — automatic backup is not set up/);

    // A schedule to a drive that is not plugged in.
    const gone = await scheduled(500 * GiB, GiB);
    const L = resolveLayout(gone.deps);
    writeFileSync(join(L.backupDir!, 'schedule.json'), JSON.stringify({ to: join(gone.drive, 'not-there'), everyMinutes: 60, setAt: '2026-10-20T04:30:00.000Z' }));
    expect(backupRoom(gone.deps, L)).toMatchObject({ known: false, why: { en: expect.stringMatching(/cannot be read — is the drive plugged in\?$/) } });
    expect((await collectStatus(gone.deps)).checks.find((c) => c.name === 'Drive room')?.ok).toBeNull();
    gone.said.length = 0;
    await backupStatus(gone.deps);
    expect(gone.said.join('\n')).toMatch(/Room left: NOT KNOWN\./);

    // The drive's free space cannot be read.
    const blind = await scheduled(undefined, GiB);
    expect(backupRoom(blind.deps, resolveLayout(blind.deps))).toMatchObject({ known: false, why: { en: 'the free space on the backup drive could not be read' } });

    // A schedule written, but no backup taken yet: nothing to measure the rate by.
    const fresh = world();
    fresh.deps = { ...fresh.deps, env: { ...WIN_ENV } };
    expect(await prepare(fresh.deps)).toBe(0);
    const LF = resolveLayout(fresh.deps);
    const empty = mkdtempSync(join(tmpdir(), 'sre-ob268-empty-'));
    mkdirSync(LF.backupDir!, { recursive: true });
    writeFileSync(join(LF.backupDir!, 'schedule.json'), JSON.stringify({ to: empty, everyMinutes: 60, setAt: '2026-10-20T04:30:00.000Z' }));
    const room = backupRoom(fresh.deps, LF);
    expect(room).toMatchObject({ known: false, why: { en: 'no backup has been taken yet, so the rate the drive fills at is not known yet' } });
    expect(JSON.stringify(room)).not.toMatch(/"days"/);
    expect((await collectStatus(fresh.deps)).alerts.map((a) => a.code)).not.toContain('backup_drive_filling');
    fresh.said.length = 0;
    await backupStatus(fresh.deps);
    expect(fresh.said.join('\n')).toMatch(/room left: NOT KNOWN yet \(no backup has been taken yet/);
  });
});
