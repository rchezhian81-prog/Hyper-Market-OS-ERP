import { describe, it, expect, beforeAll } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  argValue, loggedSay, removeHandoff, screensUrl, shortcutText, urlInShortcut, writeHandoff,
} from '../../scripts/lib/setup-handoff.mjs';

// CR-01 step 2b (OI-02), fixed after the owner's first real install on the store PC (2026-11-09):
//   1. the browser never opened — SRE-Setup.exe runs as administrator, and the screens' server it started asked Windows
//      to open the browser itself, hidden, as administrator;
//   2. there was no way back to the screens — the one-time key was only in that lost address, and the server's own
//      words were kept nowhere;
//   3. running SRE-Setup.exe again was refused ("DeleteFile failed; code 5") — the screens' server still held node.exe.
// The Windows half of each fix is proved on a clean Windows machine by the store-pc-setup and store-pc-first-run jobs.

const wait = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });
async function until(check: () => boolean, ms = 15_000): Promise<boolean> {
  for (let t = 0; t < ms; t += 100) { if (check()) return true; await wait(100); }
  return check();
}

describe('the hand-off: the screens\' address goes into one shortcut, never into the log', () => {
  it('the shortcut opens the screens\' address on this PC only, the key after #', () => {
    const url = screensUrl(8099, 'k3y_-ABC');
    expect(url).toBe('http://127.0.0.1:8099/setup/#key=k3y_-ABC');
    expect(shortcutText(url)).toBe('[InternetShortcut]\r\nURL=http://127.0.0.1:8099/setup/#key=k3y_-ABC\r\n');
    expect(urlInShortcut(shortcutText(url))).toBe(url);
    expect(urlInShortcut('[InternetShortcut]\r\n')).toBeUndefined();
  });

  it('written, replaced, and removed; a shortcut that cannot be written is said, not hidden', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sre-handoff-'));
    const file = join(dir, 'Finish SRE setup.url');
    const fs = { writeFileSync: (f: string, d: string) => { writeFileSync(f, d, 'utf8'); }, existsSync, unlinkSync: (f: string) => { rmSync(f); }, appendFileSync: () => {} };
    expect(writeHandoff(fs, file, 'http://127.0.0.1:8099/setup/#key=one')).toBe(true);
    expect(writeHandoff(fs, file, 'http://127.0.0.1:8099/setup/#key=two')).toBe(true);
    expect(urlInShortcut(readFileSync(file, 'utf8'))).toBe('http://127.0.0.1:8099/setup/#key=two');
    removeHandoff(fs, file);
    expect(existsSync(file)).toBe(false);
    removeHandoff(fs, file); // already gone: nothing happens
    expect(writeHandoff({ ...fs, writeFileSync: () => { throw new Error('denied'); } }, file, 'x')).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('every line said is also kept in the setup log; a log that cannot be written never stops the screens', () => {
    const kept: string[] = [];
    const said: string[] = [];
    const fs = { writeFileSync: () => {}, existsSync: () => false, unlinkSync: () => {}, appendFileSync: (_f: string, d: string) => { kept.push(d); } };
    loggedSay(fs, 'C:\\ProgramData\\SRE\\setup.log', (l) => { said.push(l); }, () => new Date('2026-11-10T09:00:00Z'))('The setup screens are open on this PC only');
    expect(said).toEqual(['The setup screens are open on this PC only']);
    expect(kept).toEqual(['2026-11-10T09:00:00.000Z  [screens] The setup screens are open on this PC only\n']);
    const broken = { ...fs, appendFileSync: () => { throw new Error('denied'); } };
    expect(() => { loggedSay(broken, 'x.log', (l) => { said.push(l); })('still said'); }).not.toThrow();
    expect(said).toContain('still said');
  });

  it('reads its flags', () => {
    expect(argValue(['--port', '8099', '--shortcut', 'C:\\Users\\a\\Desktop\\Finish SRE setup.url'], '--shortcut')).toBe('C:\\Users\\a\\Desktop\\Finish SRE setup.url');
    expect(argValue(['--port'], '--port')).toBeUndefined();
    expect(argValue([], '--log')).toBeUndefined();
  });
});

describe('the screens\' server, run as SRE-Setup.exe runs it (--shortcut, --log)', () => {
  beforeAll(() => {
    const b = spawnSync(process.execPath, ['scripts/build-service.mjs', 'tools', '--quiet'], { encoding: 'utf8' });
    expect(b.status, b.stderr).toBe(0);
  }, 120_000);

  const start = (args: string[]): ChildProcess => spawn(process.execPath, ['scripts/dist/setup-server.js', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });

  it('opens no browser itself: writes the shortcut, answers the page, keeps its words in the log without the key, and removes the shortcut when it stops', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sre-screens-'));
    const shortcut = join(dir, 'Finish SRE setup.url');
    const log = join(dir, 'setup.log');
    const server = start(['--port', '18471', '--shortcut', shortcut, '--log', log]);
    let printed = '';
    server.stdout?.on('data', (c: Buffer) => { printed += c.toString(); });
    try {
      expect(await until(() => existsSync(shortcut))).toBe(true);
      const url = urlInShortcut(readFileSync(shortcut, 'utf8'));
      const key = /^http:\/\/127\.0\.0\.1:18471\/setup\/#key=([A-Za-z0-9_-]{20,})$/.exec(url ?? '')?.[1];
      expect(key, url).toBeDefined();
      expect((await fetch('http://127.0.0.1:18471/setup/')).status).toBe(200);
      expect((await fetch('http://127.0.0.1:18471/setup/api/state', { headers: { 'x-setup-key': 'wrong' } })).status).toBe(403);
      const logged = readFileSync(log, 'utf8');
      expect(logged).toContain('[screens] The setup screens are open on this PC only: http://127.0.0.1:18471/setup/');
      expect(logged).toContain('double-click it if the browser did not open');
      expect(logged).not.toContain(key!);
      expect(printed).not.toContain(key!); // with a shortcut, the key is never printed either
    } finally {
      server.kill('SIGTERM');
    }
    expect(await until(() => !existsSync(shortcut))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  it('a port already taken (an earlier run\'s screens still open): it says so in plain words, in the log too, and stops', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sre-screens-'));
    const first = start(['--port', '18472', '--shortcut', join(dir, 'first.url')]);
    try {
      expect(await until(() => existsSync(join(dir, 'first.url')))).toBe(true);
      const second = spawnSync(process.execPath, ['scripts/dist/setup-server.js', '--port', '18472', '--shortcut', join(dir, 'second.url'), '--log', join(dir, 'setup.log')], { encoding: 'utf8', timeout: 20_000 });
      expect(second.status).toBe(1);
      expect(second.stdout).toContain('port 18472 is already in use on this PC');
      expect(readFileSync(join(dir, 'setup.log'), 'utf8')).toContain('restart the PC and run SRE-Setup.exe again');
      expect(existsSync(join(dir, 'second.url'))).toBe(false);
    } finally {
      first.kill('SIGTERM');
    }
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);
});

describe('SRE-Setup.exe opens the screens as the person, and clears an earlier run first (infra/windows/sre-setup.iss)', () => {
  const iss = readFileSync('infra/windows/sre-setup.iss', 'utf8');
  const server = readFileSync('scripts/setup-server.ts', 'utf8');

  it('starts the screens\' server with the desktop shortcut and the setup log, then opens the address as the original user', () => {
    expect(iss).toContain("ExpandConstant('{userdesktop}\\Finish SRE setup.url')");
    expect(iss).toContain("'\" --shortcut \"' + Shortcut + '\" --log \"' + ExpandConstant('{commonappdata}\\SRE\\setup.log') + '\"'");
    expect(iss).toContain("ShellExecAsOriginalUser('open', Address, '', '', SW_SHOWNORMAL, ewNoWait, Code)");
    // An old shortcut (an earlier run's key) is removed before the server writes its own.
    expect(iss.indexOf('DeleteFile(Shortcut);')).toBeGreaterThan(-1);
    expect(iss.indexOf('DeleteFile(Shortcut);')).toBeLessThan(iss.indexOf('ScreensAddress(Shortcut)'));
    // Every way it can go wrong is said in a box, with what to do.
    expect(iss).toContain('Double-click "Finish SRE setup" on your desktop');
    expect(iss).toContain('Restart the PC and run SRE-Setup.exe again');
    expect(iss).toContain('FinishedLabelNoIcons=');
  });

  it('before copying: the three services, then ONLY this program\'s own node.exe — never another program\'s', () => {
    const prepare = iss.slice(iss.indexOf('function PrepareToInstall'), iss.indexOf('function ScreensAddress'));
    expect(prepare).toContain("NodeExe := ExpandConstant('{app}\\runtime\\node\\node.exe');");
    expect(prepare).toContain("Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq ''' + NodeExe + ''' } | Stop-Process -Force");
    expect(prepare.indexOf("'stop SRE-Database /y'")).toBeLessThan(prepare.indexOf('Get-Process node'));
    expect(prepare).not.toMatch(/taskkill|IM node\.exe/i);
  });

  it('the server never opens a hidden browser, and never one as administrator when started by the setup program', () => {
    expect(server).not.toContain('windowsHide: true }).unref()');
    const listen = server.slice(server.indexOf('server.listen('));
    expect(listen.indexOf('if (shortcut !== undefined)')).toBeLessThan(listen.indexOf("spawn('explorer.exe'"));
  });
});
