import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { main, type Deps } from '../../scripts/lib/store-computer.mjs';
import { readyPc } from '../support/store-pc-windows';

// CR-01 step 2c, found on the owner's PC with release 1.0.2009 (11 Nov 2026): the move took its snapshot, stopped Docker,
// then "NOT INSTALLED — the shop database could not be made." with no reason, and put the shop back (Docker and the till
// running again). Double-clicking initdb.exe there said "VCRUNTIME140.dll was not found" and "MSVCP140.dll was not found":
// PostgreSQL's programs need Microsoft's Visual C++ runtime, which that PC never had. GitHub's Windows machines always
// have it, so no test saw it.
//   1. SRE-Setup.exe brings Microsoft's own installer (signed by Microsoft, checked in CI) and runs it when the runtime
//      is missing, before anything of the shop is touched;
//   2. a program that cannot even start says why — the database step no longer ends in silence.

const SETUP = ['install-services', '--pg-bin', 'C:\\pgsql\\bin', '--service-host', 'C:\\tools\\WinSW-x64.exe'];

describe('a program that cannot start says why (store-computer-services.mjs)', () => {
  const failingInitdb = (d: Deps, result: { status: number | null; error?: Error }): Deps => ({
    ...d,
    spawn: (cmd, args, o) => (String(cmd).endsWith('initdb.exe') ? { stdout: '', stderr: '', ...result } : d.spawn(cmd, args, o)),
  });

  it('Windows\' "a DLL is missing" (0xC0000135, as on the owner\'s PC): named as the Visual C++ runtime, with what to do', async () => {
    const { w, d } = await readyPc();
    expect(await main(SETUP, failingInitdb(d, { status: 3221225781 }))).toBe(1);
    expect(w.said.join('\n')).toMatch(/^NOT INSTALLED — the shop database could not be made\. it could not start: a part of Windows it needs is missing \(Microsoft Visual C\+\+ runtime — run SRE-Setup\.exe again, which installs it\)$/m);
  });

  it('any other silent end says its code; a program that could not be started at all says so', async () => {
    const a = await readyPc();
    expect(await main(SETUP, failingInitdb(a.d, { status: 7 }))).toBe(1);
    expect(a.w.said.join('\n')).toMatch(/the shop database could not be made\. it ended with code 7 and said nothing$/m);
    const b = await readyPc();
    expect(await main(SETUP, failingInitdb(b.d, { status: null, error: Object.assign(new Error('spawn EPERM'), { code: 'EPERM' }) }))).toBe(1);
    expect(b.w.said.join('\n')).toMatch(/the shop database could not be made\. it could not be started \(EPERM\)$/m);
  });
});

describe('SRE-Setup.exe installs Microsoft\'s Visual C++ runtime when the PC has none (infra/windows/sre-setup.iss)', () => {
  const iss = readFileSync('infra/windows/sre-setup.iss', 'utf8');
  const post = iss.slice(iss.indexOf('procedure CurStepChanged'));

  it('checks the three runtime files in Windows\' own folder; runs the installer the release brings, quietly, when one is missing', () => {
    for (const dll of ['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll']) expect(iss).toContain(`ExpandConstant('{sys}\\${dll}')`);
    expect(iss).toContain("Installer := ExpandConstant('{app}\\runtime\\vcredist\\vc_redist.x64.exe');");
    expect(iss).toContain("Exec(Installer, '/install /quiet /norestart', '', SW_HIDE, ewWaitUntilTerminated, Code)");
    // Done, newer already there, done-restart-later: fine; and only if the files are then really there.
    expect(iss).toContain('Result := ((Code = 0) or (Code = 1638) or (Code = 3010)) and not VcRuntimeMissing();');
    expect(iss).toContain("ExpandConstant('{param:FORCEVCREDIST|0}') <> '1'");
  });

  it('runs FIRST, before the setup screens or the silent setup; if it fails, nothing of the shop is touched and the person is told', () => {
    const ensure = post.indexOf('if not EnsureVcRuntime() then');
    expect(ensure).toBeGreaterThan(-1);
    expect(ensure).toBeLessThan(post.indexOf("Shortcut := ExpandConstant('{userdesktop}\\Finish SRE setup.url');")); // the setup screens
    expect(ensure).toBeLessThan(post.indexOf("setup' + DataDriveArg()")); // the silent setup
    const failed = post.slice(ensure, post.indexOf('exit;', ensure));
    expect(failed).toContain('SetupResult := 3;');
    expect(failed).toContain('Microsoft Visual C++ runtime could not be installed');
  });
});

describe('the release carries Microsoft\'s installer, checked by Microsoft\'s signature (build and CI)', () => {
  it('the release build copies it to runtime\\vcredist when given', () => {
    const build = readFileSync('scripts/build-store-pc-release.mjs', 'utf8');
    expect(build).toContain("const vcredist = arg(argv, '--vcredist');");
    expect(build).toContain("cpSync(vcredist, join(out, 'runtime', 'vcredist', 'vc_redist.x64.exe'));");
  });

  it('CI fetches it from Microsoft, refuses it unless validly signed by Microsoft, ships it, and runs it on the clean Windows machine', () => {
    const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
    expect(ci).toContain("Invoke-WebRequest -Uri 'https://aka.ms/vs/17/release/vc_redist.x64.exe'");
    expect(ci).toContain("if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') { throw");
    expect(ci).toContain('--vcredist $vc');
    expect(ci).toContain("'/FORCEVCREDIST=1'");
    expect(ci).toContain("-Pattern 'Microsoft Visual C\\+\\+ runtime installer ended with (0|1638|3010)$'");
  });
});
