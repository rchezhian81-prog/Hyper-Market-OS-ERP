import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { main } from '../../scripts/lib/store-computer.mjs';
import { MADE_AS_SERVICES_MARKER, dockerCopyState } from '../../scripts/lib/store-computer-adopt.mjs';
import { layout } from '../../scripts/lib/store-computer.mjs';
import { world } from '../support/store-computer-world';
import { storePc } from '../support/store-pc-windows';
import type { Deps } from '../../scripts/lib/store-computer.mjs';
import { backupDriveProblem } from '../../scripts/lib/store-computer-windows.mjs';
import { updateApiBase } from '../../scripts/lib/store-pc-updater.mjs';

/**
 * **CR-01 step 3f · OI-05: the update, a broken update put back, and the G9 drill — proven on a clean Windows machine.**
 *
 *   The CI job `store-pc-update` builds three releases of the commit (1.0.1; 1.0.2; 1.0.3 broken on purpose), signed with
 *   a throwaway key made in the job, installs 1.0.1, and runs the real updater twice (UPDATED, then PUT BACK) and the real
 *   drill (G9 PASSED). It needs two stand-ins that a shop's PC must NEVER accept, each allowed only on GitHub's own
 *   throw-away test machine (hostedTestMachine — all three of GITHUB_ACTIONS, RUNNER_ENVIRONMENT=github-hosted and
 *   SRE_TEST_ON_HOSTED_RUNNER): a release source on 127.0.0.1 instead of GitHub, and a mounted virtual disk as the backup
 *   drive. These tests pin that a shop's PC gets neither, and that publishing waits for the job.
 */

const HOSTED = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', SRE_TEST_ON_HOSTED_RUNNER: '1' };
const withEnv = (env: Record<string, string>): Deps => ({ env, platform: 'win32' } as unknown as Deps);
/** A PC whose PowerShell says drive V: is a fixed disk on the given bus (7 USB, 11 SATA, 15 a file-backed virtual disk). */
const driveOn = (bus: number, env: Record<string, string>): Deps => ({
  env, platform: 'win32',
  spawn: () => ({ status: 0, stdout: `DRIVE|3|${bus}\r\n` }),
} as unknown as Deps);

describe('the release source: GitHub, except a stand-in on GitHub\'s own test machine', () => {
  it('a shop\'s PC always asks GitHub — whatever SRE_UPDATE_API_BASE says', () => {
    expect(updateApiBase(withEnv({}))).toBe('https://api.github.com');
    expect(updateApiBase(withEnv({ SRE_UPDATE_API_BASE: 'http://127.0.0.1:8765' }))).toBe('https://api.github.com');
    expect(updateApiBase(withEnv({ SRE_UPDATE_API_BASE: 'http://127.0.0.1:8765', GITHUB_ACTIONS: 'true', SRE_TEST_ON_HOSTED_RUNNER: '1' }))).toBe('https://api.github.com'); // a self-hosted runner
  });
  it('the test machine may name a stand-in — on 127.0.0.1 only, never another host', () => {
    expect(updateApiBase(withEnv({ ...HOSTED, SRE_UPDATE_API_BASE: 'http://127.0.0.1:8765' }))).toBe('http://127.0.0.1:8765');
    for (const elsewhere of ['http://evil.example:8765', 'https://127.0.0.1:8765', 'http://127.0.0.1.example.com:80', 'http://10.0.0.5:8765']) {
      expect(updateApiBase(withEnv({ ...HOSTED, SRE_UPDATE_API_BASE: elsewhere }))).toBe('https://api.github.com');
    }
  });
});

describe('the backup drive: a USB drive, except a virtual disk on GitHub\'s own test machine', () => {
  it('a shop\'s PC refuses a mounted virtual disk (it is inside the PC) and accepts a USB drive', () => {
    expect(backupDriveProblem(driveOn(15, {}), 'V:\\sre-backup')).toMatch(/is on V:, a disk inside this computer \(File Backed Virtual\)/);
    expect(backupDriveProblem(driveOn(7, {}), 'V:\\sre-backup')).toBeUndefined();
  });
  it('the test machine accepts the virtual disk — and still refuses a real internal disk', () => {
    expect(backupDriveProblem(driveOn(15, HOSTED), 'V:\\sre-backup')).toBeUndefined();
    expect(backupDriveProblem(driveOn(11, HOSTED), 'D:\\sre-backup')).toMatch(/a disk inside this computer \(SATA\)/);
  });
});

describe('the CI job that proves it, and that nothing is published without it', () => {
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
  const job = ci.slice(ci.indexOf('\n  store-pc-update:'), ci.indexOf('\n  store-pc-publish:'));
  it('builds three releases (one broken on purpose) with a throwaway test key, never the shop\'s', () => {
    expect(job).toContain("foreach ($v in '1.0.1','1.0.2','1.0.3')");
    expect(job).toContain('--public-key "$key\\release-signing.pub"');
    expect(job).toContain('broken on purpose');
    expect(job).not.toContain('secrets.RELEASE_SIGNING_KEY');
  });
  it('expects UPDATED, then PUT BACK on the previous version, then G9 PASSED', () => {
    expect(job).toContain('wait-update updated 30');
    expect(job).toContain('wait-update rolled-back 45');
    expect(job).toContain("-ne '1.0.2') { throw 'the program folder is not back on 1.0.2' }");
    expect(job).toContain('wait-drill 45');
  });
  it('a store PC release is published only after this job passed', () => {
    const publish = ci.slice(ci.indexOf('\n  store-pc-publish:'));
    expect(/needs: \[[^\]]*\bstore-pc-update\b[^\]]*\]/.test(publish.slice(0, 2000))).toBe(true);
  });
});

describe('found on the clean Windows machine (14 Nov 2026): a NEW shop with Docker installed but not running', () => {
  /** SRE-Setup.exe has just copied an installed release into C:\\SRE on a PC with Docker Desktop installed and stopped. */
  const freshPc = () => {
    const w = world();
    const { d } = storePc(w);
    const fs = d.fs;
    for (const dir of ['C:\\SRE\\runtime\\pgsql\\bin', 'C:\\SRE\\runtime\\winsw', 'C:\\SRE\\scripts', 'C:\\SRE\\services\\api\\dist', 'C:\\SRE\\edge\\store-edge\\dist']) fs.mkdirSync(dir, { recursive: true });
    for (const exe of ['initdb.exe', 'pg_ctl.exe', 'postgres.exe', 'psql.exe', 'pg_isready.exe']) fs.writeFileSync(`C:\\SRE\\runtime\\pgsql\\bin\\${exe}`, 'pretend');
    fs.writeFileSync('C:\\SRE\\runtime\\winsw\\WinSW-x64.exe', 'pretend');
    fs.writeFileSync('C:\\SRE\\scripts\\store-computer-service.mjs', '// launcher');
    fs.writeFileSync('C:\\SRE\\services\\api\\dist\\start.js', '// api');
    fs.writeFileSync('C:\\SRE\\edge\\store-edge\\dist\\start.js', '// edge');
    fs.writeFileSync('C:\\SRE\\release.json', JSON.stringify({ kind: 'sre-store-pc-release', version: '1.0.1' }));
    w.docker.running = false; // installed, not running: `docker volume ls` fails, `docker --version` answers
    return { w, d };
  };

  it('the setup program that MAKES the shop writes that it never lived in Docker; Docker is then never needed again', async () => {
    const { w, d } = freshPc();
    expect(await main(['setup', '--data-drive', 'F:'], d)).toBe(0);
    expect(JSON.parse(d.fs.readFileSync(`F:\\SRE-data\\run\\services\\${MADE_AS_SERVICES_MARKER}`, 'utf8'))).toMatchObject({ kind: 'sre-made-as-services' });
    expect(dockerCopyState(d, layout('C:\\SRE', 'win32', 'F:\\SRE-data'), true)).toBe('none');
    // Run again (a repair, or the new version's setup during an update): not refused for Docker.
    w.said.length = 0;
    expect(await main(['setup'], d)).toBe(0);
    expect(w.said.join('\n')).not.toMatch(/Docker Desktop is installed but not running/);
  });

  it('a shop that was set up BEFORE without the mark (the owner\'s Docker-era PC) is still asked about Docker — the guard stays', async () => {
    const { d } = freshPc();
    expect(await main(['setup', '--data-drive', 'F:'], d)).toBe(0);
    d.fs.rmSync(`F:\\SRE-data\\run\\services\\${MADE_AS_SERVICES_MARKER}`);
    expect(dockerCopyState(d, layout('C:\\SRE', 'win32', 'F:\\SRE-data'), true)).toMatchObject({ refuse: expect.stringMatching(/Docker Desktop is installed but not running/) });
  });
});
