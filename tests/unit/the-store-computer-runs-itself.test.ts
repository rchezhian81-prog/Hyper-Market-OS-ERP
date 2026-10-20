import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, prepare, type Deps } from '../../scripts/lib/store-computer.mjs';
import {
  autostart, backupStatus, LAUNCHER_SOURCE, scheduleBackup, scheduledBackup, startAtSignIn, TASKS, taskXml, unscheduleBackup, windowsTasks,
} from '../../scripts/lib/store-computer-schedule.mjs';
import { world, type World } from '../support/store-computer-world';

/**
 * OB-249 (automatic hourly ENCRYPTED backup to a drive that stays plugged in) and audit row 5 / C-11 (nothing restarted
 * after a reboot). Windows Task Scheduler jobs, registered from XML through `schtasks` argument arrays (no shell): the
 * backup every N minutes and a 15-minute check (the red banner), and a sign-in task that waits for Docker Desktop
 * (starting it if needed), starts this copy and the till, then checks. They run as the owner, only while he is signed in
 * (InteractiveToken — no password stored). The passphrase is typed ONCE; the hourly run never asks for anything. Nothing
 * is ever deleted, and backup-status says how much room is left. Driven here with a pretend Task Scheduler and Docker.
 */

const MIN = 60_000;
const WIN_ENV = { USERNAME: 'owner', USERDOMAIN: 'SRE-STORE-PC', SystemRoot: 'C:\\Windows' };
const driveOf = (): string => mkdtempSync(join(tmpdir(), 'sre-auto-drive-'));
const said = (w: World): string => w.said.join('\n');

async function prepared(): Promise<World> {
  const w = world();
  w.deps = { ...w.deps, env: { ...WIN_ENV } };
  expect(await prepare(w.deps)).toBe(0);
  w.said.length = 0;
  w.calls.length = 0;
  return w;
}

describe('schedule-backup --to <drive> --every 60', () => {
  it('registers the backup every 60 minutes and the 15-minute check, asks the passphrase once, and takes the first backup at once', async () => {
    const w = await prepared();
    const drive = driveOf();
    expect(await main(['--', 'schedule-backup', '--to', drive, '--every', '60'], w.deps)).toBe(0);
    expect([...w.tasks.registered.keys()]).toEqual([TASKS.backup, TASKS.status]);
    const xml = w.tasks.registered.get(TASKS.backup)!;
    expect(xml).toContain('<Interval>PT60M</Interval>');
    expect(xml).toContain('<UserId>SRE-STORE-PC\\owner</UserId>');
    expect(xml).toContain('<LogonType>InteractiveToken</LogonType>');
    expect(xml).toContain('<RunLevel>LeastPrivilege</RunLevel>');
    expect(xml).toContain('<StartWhenAvailable>true</StartWhenAvailable>');
    expect(xml).toContain('<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>');
    expect(xml).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>');
    expect(xml).toContain('<Command>C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe</Command>');
    expect(xml).toContain(`-WindowStyle Hidden -Command &quot;&amp; '${process.execPath}' '${join(w.data, 'run', 'launch.mjs')}' scheduled-backup; exit $LASTEXITCODE&quot;`);
    expect(w.tasks.registered.get(TASKS.status)).toContain('<Interval>PT15M</Interval>');
    expect(w.tasks.registered.get(TASKS.status)).toContain("' status --quiet;");
    // The launcher and which release it runs.
    expect(readFileSync(join(w.data, 'run', 'launch.mjs'), 'utf8')).toBe(LAUNCHER_SOURCE);
    expect(JSON.parse(readFileSync(join(w.data, 'run', 'current-release.json'), 'utf8'))).toMatchObject({ folder: w.root });
    expect(JSON.parse(readFileSync(join(w.data, 'backup', 'schedule.json'), 'utf8'))).toMatchObject({ to: drive, everyMinutes: 60, setBy: 'SRE-STORE-PC\\owner' });
    // The passphrase: chosen once (typed twice), never shown.
    expect(w.asked).toHaveLength(2);
    const out = said(w);
    expect(out).toMatch(/^AUTOMATIC BACKUP ON — every 60 minutes to .*, encrypted to backup key [0-9a-f]{16}, while you are signed in to Windows\.$/m);
    expect(out).toMatch(/^BACKUP DONE — sre-real-backup-/m);
    expect(out).toMatch(/NOTHING IS EVER DELETED/);
    expect(out).toMatch(/room for about \d+ more day\(s\) at the current rate/);
    expect(readdirSync(drive).filter((f) => f.endsWith('.manifest.json'))).toHaveLength(1);
    // The check ran too: the status file is there for the office screen.
    expect(existsSync(join(w.data, 'status', 'store-computer-status.json'))).toBe(true);
  });

  it('refuses: no --to; --every outside 15–60 (OB-249 says hourly); the system drive or the data folder; off Windows; a task Windows refuses', async () => {
    const w = await prepared();
    expect(await scheduleBackup(w.deps, {})).toBe(2);
    expect(await scheduleBackup(w.deps, { to: driveOf(), every: '90' })).toBe(2);
    expect(said(w)).toMatch(/--every must be a whole number of minutes from 15 to 60\. OB-249 says hourly/);
    expect(await scheduleBackup(w.deps, { to: driveOf(), every: '5' })).toBe(2);
    expect(await scheduleBackup(w.deps, { to: join(w.data, 'backups'), every: '60' })).toBe(2);
    expect(said(w)).toMatch(/is inside the shop's data folder/);
    expect(w.tasks.registered.size).toBe(0);
    const linux = { ...w.deps } as Partial<Deps>;
    delete (linux as { tasks?: unknown }).tasks;
    expect(await scheduleBackup(linux as Deps, { to: driveOf(), every: '60' })).toBe(2);
    expect(said(w)).toMatch(/this computer is not Windows/);
    w.tasks.refuse = 'ERROR: Access is denied.';
    expect(await scheduleBackup(w.deps, { to: driveOf(), every: '60' })).toBe(1);
    expect(said(w)).toMatch(/In Windows' own words: ERROR: Access is denied\./);
    expect(said(w)).toMatch(/Run as administrator/);
  });
});

describe('scheduled-backup — what the hourly task runs', () => {
  it('backs up with the public key and asks NOTHING; writes how it went, logs its lines, and refreshes the red light', async () => {
    const w = await prepared();
    const drive = driveOf();
    expect(await scheduleBackup(w.deps, { to: drive, every: '60' })).toBe(0);
    const asked = w.asked.length;
    w.deps = { ...w.deps, now: () => new Date(Date.parse('2026-10-20T05:30:00Z')) };
    expect(await scheduledBackup(w.deps)).toBe(0);
    expect(w.asked).toHaveLength(asked);
    expect(readdirSync(drive).filter((f) => f.endsWith('.manifest.json'))).toHaveLength(2);
    const last = JSON.parse(readFileSync(join(w.data, 'backup', 'last-backup.json'), 'utf8')) as { lastSuccess: { at: string; kind: string } };
    expect(last.lastSuccess).toMatchObject({ at: '2026-10-20T05:30:00.000Z', kind: 'automatic' });
    expect(readFileSync(join(w.data, 'run', 'automatic-backup.log'), 'utf8')).toMatch(/BACKUP DONE — sre-real-backup-2026-10-20T05-30-00-000Z/);
    expect(existsSync(join(w.data, 'run', 'backup.lock'))).toBe(false);
  });

  it('a drive that is unplugged: NOT DONE, the failure recorded (append-only), and two hours later the light is red', async () => {
    const w = await prepared();
    const drive = driveOf();
    expect(await scheduleBackup(w.deps, { to: drive, every: '60' })).toBe(0);
    const schedule = JSON.parse(readFileSync(join(w.data, 'backup', 'schedule.json'), 'utf8')) as Record<string, unknown>;
    const blocked = join(driveOf(), 'not-a-folder');
    writeFileSync(blocked, 'x');
    writeFileSync(join(w.data, 'backup', 'schedule.json'), JSON.stringify({ ...schedule, to: join(blocked, 'sub') }));
    const base = w.deps.now().getTime();
    w.deps = { ...w.deps, now: () => new Date(base + 121 * MIN) };
    expect(await scheduledBackup(w.deps)).toBe(1);
    const log = readFileSync(join(w.data, 'backup', 'backup-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { ok?: boolean; kind: string; problem?: string });
    expect(log.map((l) => l.kind)).toEqual(['schedule-on', 'first-automatic', 'automatic']);
    expect(log.at(-1)).toMatchObject({ ok: false, problem: expect.stringMatching(/Is your backup drive plugged in/) });
    const st = JSON.parse(readFileSync(join(w.data, 'status', 'store-computer-status.json'), 'utf8')) as { alerts: { code: string }[] };
    expect(st.alerts.map((a) => a.code)).toContain('backup_old');
  });

  it('a backup still running is never started twice (a lock); an old lock from a run that was cut off is taken over', async () => {
    const w = await prepared();
    expect(await scheduleBackup(w.deps, { to: driveOf(), every: '60' })).toBe(0);
    writeFileSync(join(w.data, 'run', 'backup.lock'), `${w.deps.now().toISOString()}\n`);
    expect(await scheduledBackup(w.deps)).toBe(0);
    expect(said(w)).toMatch(/SKIPPED — another backup is still running\./);
    writeFileSync(join(w.data, 'run', 'backup.lock'), '2026-10-20T00:00:00.000Z\n');
    w.said.length = 0;
    expect(await scheduledBackup(w.deps)).toBe(0);
    expect(said(w)).toMatch(/BACKUP DONE/);
  });
});

describe('unschedule-backup · backup-status', () => {
  it('unschedule removes both tasks and keeps every backup and the key; backup-status then says OFF', async () => {
    const w = await prepared();
    const drive = driveOf();
    expect(await scheduleBackup(w.deps, { to: drive, every: '60' })).toBe(0);
    const before = readdirSync(drive).sort();
    expect(await unscheduleBackup(w.deps)).toBe(0);
    expect(w.tasks.removed).toEqual([TASKS.backup, TASKS.status]);
    expect(readdirSync(drive).sort()).toEqual(before);
    expect(existsSync(join(w.data, 'backup', 'backup-key.json'))).toBe(true);
    expect(said(w)).toMatch(/Every backup already on the drives is kept, and so is the backup key\. Nothing was deleted\./);
    w.said.length = 0;
    expect(await backupStatus(w.deps)).toBe(0);
    expect(said(w)).toMatch(/Automatic: {6}OFF — set it up/);
  });

  it('backup-status: the key, the schedule, the last good backup, the room left — and RED when it is over two hours old', async () => {
    const w = await prepared();
    const drive = driveOf();
    expect(await scheduleBackup(w.deps, { to: drive, every: '60' })).toBe(0);
    w.said.length = 0;
    expect(await backupStatus(w.deps)).toBe(0);
    let out = said(w);
    expect(out).toMatch(/Backup key: {5}[0-9a-f]{16} \(made .*\); the passphrase that opens it is kept nowhere on this computer/);
    expect(out).toMatch(/Automatic: {6}every 60 minutes to /);
    expect(out).toMatch(/Last good: {6}2026-10-20T04:30:00\.000Z — 0 min ago/);
    expect(out).toMatch(/On the drive: 1 backup\(s\), .* in all; .* free — room for about \d+ more day\(s\) at the current rate\./);
    expect(out).toMatch(/^OK — the last good backup is less than 2 hours old\.$/m);
    w.tasks.registered.delete(TASKS.backup);
    const base = w.deps.now().getTime();
    w.deps = { ...w.deps, now: () => new Date(base + 3 * 60 * MIN) };
    w.said.length = 0;
    expect(await backupStatus(w.deps)).toBe(1);
    out = said(w);
    expect(out).toMatch(/BUT THE WINDOWS TASK IS MISSING: run schedule-backup again/);
    expect(out).toMatch(/^RED — the last good backup is more than 2 hours old/m);
  });
});

describe('autostart · start-at-sign-in (audit row 5 · C-11)', () => {
  /** A till installed in the data folder, and its built box in this release. */
  function withTill(w: World): void {
    const till = join(w.data, 'till');
    mkdirSync(join(till, 'edge-data'), { recursive: true });
    writeFileSync(join(till, 'till.env'), `EDGE_DATA_DIR=${join(till, 'edge-data')}\nEDGE_LANE_PORT=8090\nEDGE_APPS_DIR=/old/release/apps\n`);
    mkdirSync(join(w.root, 'edge', 'store-edge', 'dist'), { recursive: true });
    writeFileSync(join(w.root, 'edge', 'store-edge', 'dist', 'start.js'), '');
    // The pretend till answers on its lane port once it has been started.
    const start = w.deps.spawnDetached!;
    w.deps = { ...w.deps, spawnDetached: (cmd, args, o) => { const r = start(cmd, args, o); if (String(args[0]).endsWith('start.js')) w.ports.add(8090); return r; } };
  }

  it('registers a sign-in task for the owner and tells the truth about Windows', async () => {
    const w = await prepared();
    withTill(w);
    expect(await autostart(w.deps)).toBe(0);
    const xml = w.tasks.registered.get(TASKS.start)!;
    expect(xml).toMatch(/<LogonTrigger>\s*<Enabled>true<\/Enabled>\s*<UserId>SRE-STORE-PC\\owner<\/UserId>\s*<Delay>PT30S<\/Delay>/);
    expect(xml).toContain("' start-at-sign-in;");
    const out = said(w);
    expect(out).toMatch(/wait for Docker Desktop, and start it if it is not running \(so nothing in Docker Desktop needs ticking\)/);
    expect(out).toMatch(/THE TRUTH ABOUT WINDOWS: Docker Desktop runs only while you are signed in/);
    expect(out).toMatch(/NOTHING runs/);
    expect(out).toMatch(/do NOT also double-click start-till\.cmd/);
    expect(await autostart(w.deps, { off: true })).toBe(0);
    expect(w.tasks.registered.has(TASKS.start)).toBe(false);
  });

  it('at sign-in: this copy up, the till started in the background from THIS release on the data folder\'s settings, then the check', async () => {
    const w = await prepared();
    withTill(w);
    expect(await startAtSignIn(w.deps)).toBe(0);
    const up = w.calls.find((c) => c.args.includes('up'))!;
    expect(up.args).toEqual(['compose', '-p', 'sre-real', '-f', 'docker-compose.yml', '--env-file', join(w.data, '.env.real'), 'up', '-d', 'db', 'migrate', 'api']);
    expect(w.detached).toHaveLength(1);
    expect(w.detached[0]!.args).toEqual([join(w.root, 'edge', 'store-edge', 'dist', 'start.js')]);
    expect(w.detached[0]!.env).toMatchObject({ EDGE_DATA_DIR: join(w.data, 'till', 'edge-data'), EDGE_APPS_DIR: join(w.root, 'apps') });
    expect(JSON.parse(readFileSync(join(w.data, 'run', 'till.json'), 'utf8'))).toMatchObject({ pid: 4242, release: w.root });
    expect(readFileSync(join(w.data, 'run', 'start-at-sign-in.log'), 'utf8')).toMatch(/READY — sre-real is up\./);
    expect(existsSync(join(w.data, 'status', 'store-computer-status.json'))).toBe(true);
  });

  it('a till already running is never started twice; Docker that never comes up is said — and the till still starts (it sells without the books)', async () => {
    const w = await prepared();
    withTill(w);
    w.ports.add(8090);
    expect(await startAtSignIn(w.deps)).toBe(0);
    expect(w.detached).toEqual([]);
    expect(said(w)).toMatch(/the till is already running \(port 8090 answers\) — not started twice/);
    const v = await prepared();
    withTill(v);
    v.docker.running = false;
    expect(await startAtSignIn(v.deps)).toBe(1);
    expect(said(v)).toMatch(/NOT STARTED — Docker Desktop did not start within 10 minutes\./);
    expect(v.detached).toHaveLength(1);
  });
});

describe('Windows Task Scheduler itself (schtasks, argument arrays, UTF-16 XML)', () => {
  it('registers with /Create /TN /XML /F, removes with /Delete /F, asks with /Query — no shell, the XML written UTF-16 with its mark', () => {
    const files = new Map<string, Buffer>();
    const calls: { cmd: string; args: readonly string[] }[] = [];
    const deps = {
      platform: 'win32',
      fs: { writeFileSync: (p: string, b: Buffer) => { files.set(p, b); } },
      spawn: (cmd: string, args: readonly string[]) => { calls.push({ cmd, args }); return { status: 0, stdout: '' }; },
    } as unknown as Deps;
    const t = windowsTasks(deps, 'C:\\SRE-data\\run');
    const xml = taskXml({ description: 'd & e', userId: 'PC\\owner', trigger: { kind: 'repeat', everyMinutes: 60, start: '2026-10-20T10:02:00' }, command: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', args: '-Command "x"', workingDir: 'C:\\SRE-data\\run', timeLimit: 'PT50M' });
    expect(t.register(TASKS.backup, xml)).toEqual({ ok: true });
    expect(calls[0]).toEqual({ cmd: 'schtasks', args: ['/Create', '/TN', 'SRE\\Automatic backup', '/XML', 'C:\\SRE-data\\run\\automatic-backup.xml', '/F'] });
    const written = files.get('C:\\SRE-data\\run\\automatic-backup.xml')!;
    expect([...written.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    expect(written.toString('utf16le')).toContain('<Description>d &amp; e</Description>');
    expect(written.toString('utf16le')).toContain('<Arguments>-Command &quot;x&quot;</Arguments>');
    t.remove(TASKS.backup);
    t.exists(TASKS.backup);
    expect(calls.slice(1)).toEqual([{ cmd: 'schtasks', args: ['/Delete', '/TN', 'SRE\\Automatic backup', '/F'] }, { cmd: 'schtasks', args: ['/Query', '/TN', 'SRE\\Automatic backup'] }]);
  });
});

describe('seal · parallel-policy — the two owner steps of the migration (audit row 8)', () => {
  it('build the slice tool, then run it IN THIS WINDOW (it asks the person\'s own till PIN, OB-257) on THIS copy\'s settings and the till\'s', async () => {
    const seen: (readonly string[])[] = [];
    const w = world({}, { sliceStdout: (args) => { seen.push(args); return { status: 0, stdout: '' }; } });
    expect(await prepare(w.deps)).toBe(0);
    w.said.length = 0;
    const slice = mkdtempSync(join(tmpdir(), 'sre-slice-'));
    expect(await main(['seal', '--dir', slice, '--as', 'u-owner', '--backup-restored-on', '2026-10-19'], w.deps)).toBe(0);
    expect(w.calls[0]!.args).toEqual([join('scripts', 'build-service.mjs'), 'tools', '--quiet']);
    expect(seen[0]).toEqual([join('scripts', 'dist', 'migration-slice.js'), '--dir', slice, '--seal', '--as', 'u-owner', '--backup-restored-on', '2026-10-19', '--settings', join(w.data, '.env.real')]);
    // Run with the keyboard and the screen handed over — never captured — so the PIN is typed by the person, hidden.
    expect(w.calls.at(-1)!.stdio).toBe('inherit');
    expect(await main(['parallel-policy', '--as', 'u-owner', '--cutover', 'CUT-1', '--reconciler', 'u-recon', '--clean-days', '3', '--max-days', '14', '--start', '2026-10-21'], w.deps)).toBe(0);
    expect(seen[1]).toEqual([join('scripts', 'dist', 'migration-slice.js'), '--parallel-policy', '--as', 'u-owner', '--cutover', 'CUT-1', '--reconciler', 'u-recon', '--clean-days', '3', '--max-days', '14', '--start', '2026-10-21', '--settings', join(w.data, '.env.real')]);
    expect(w.calls.at(-1)!.stdio).toBe('inherit');
    // With the till installed, its settings go too: the PIN is checked against the till's own verifiers.
    mkdirSync(join(w.data, 'till'), { recursive: true });
    writeFileSync(join(w.data, 'till', 'till.env'), 'EDGE_DATA_DIR=x\n');
    expect(await main(['parallel-policy', '--as', 'u-owner', '--cutover', 'CUT-1', '--reconciler', 'u-recon', '--clean-days', '3', '--max-days', '14', '--start', '2026-10-21'], w.deps)).toBe(0);
    expect(seen[2]!.slice(-2)).toEqual(['--till-settings', join(w.data, 'till', 'till.env')]);
    expect(await main(['seal', '--as', 'u-owner'], w.deps)).toBe(2);
    expect(said(w)).toMatch(/REFUSED — name the slice folder/);
  });
});
