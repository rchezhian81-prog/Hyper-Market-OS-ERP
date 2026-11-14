#!/usr/bin/env node
// Build the STORE PC RELEASE FOLDER — everything SRE-Setup.exe installs (CR-01 step 2, OI-01 · ADR-0032).
//
//   node scripts/build-store-pc-release.mjs --out <folder> --pgsql <PostgreSQL 16 'pgsql' folder> --winsw <WinSW-x64.exe>
//                                           [--vcredist <vc_redist.x64.exe>]
//        [--node-exe <node.exe>] [--version <v>] [--commit <sha>] [--public-key <pub>] [--licence-public-key <pub>] [--skip-build]
//
// The folder holds, and nothing more:
//   • the built programs — the office API and the till (services/api/dist, edge/store-edge/dist), the operator tools
//     (scripts/dist), every app's screens (apps/<app>/web);
//   • the store-computer tool and what it runs (scripts/*.mjs, scripts/lib/*.mjs, the import page), the database
//     migrations (db/migrations) and the settings example (infra/compose/.env.example — placeholders only);
//   • node_modules with the ONE library the shop PC needs at run time: pg, at the version the lockfile names;
//   • runtime\node\node.exe, runtime\pgsql\{bin,lib,share} (PostgreSQL 16, without pgAdmin or StackBuilder) and
//     runtime\winsw\WinSW-x64.exe — so nothing is downloaded on the shop's PC;
//   • runtime\vcredist\vc_redist.x64.exe when given: Microsoft's Visual C++ runtime, which PostgreSQL's programs need
//     (the owner's PC had none, 11 Nov 2026: "VCRUNTIME140.dll was not found"); SRE-Setup.exe installs it when missing;
//   • release.json — the version and commit, which the setup reads;
//   • release-signing.pub — the PUBLIC release signing key, when one is committed at infra/deploy/release-signing.pub:
//     the key this PC checks the NEXT release's signature with (CR-01 step 3a · OB-717). Not a secret.
//   • licence-signing.pub — the seller's PUBLIC licence key, when one is committed at infra/licence/licence-signing.pub:
//     the key this PC checks the shop's LICENCE with, offline (CR-01 step 5 · OI-10 · OB-710). Not a secret. Without it,
//     licensing is not switched on in this release (nothing is limited). A test build may pass --licence-public-key.
// Never: tests, documents, seed data, any settings file but the example, TypeScript sources, build tools.

import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path, { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The apps whose screens ship: every app with a browser entry (they are served by the till's store edge). */
export function shippedApps(root = ROOT) {
  return readdirSync(join(root, 'apps')).filter((a) => existsSync(join(root, 'apps', a, 'web'))).sort();
}

/** The one run-time library, at the lockfile's version. */
export function pgVersion(root = ROOT) {
  const m = /\n {2}pg@(\d+\.\d+\.\d+):/.exec(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'));
  if (m === null) throw new Error('pnpm-lock.yaml names no pg version');
  return m[1];
}

/** Is this file part of the shipped scripts? Only the runnable tool and its page — never TypeScript sources. */
export function shipsScript(rel) {
  const r = rel.replace(/\\/g, '/');
  if (['scripts', 'scripts/lib', 'scripts/dist', 'scripts/import-page', 'scripts/setup-page'].includes(r)) return true;
  if (r.startsWith('scripts/dist/') || r.startsWith('scripts/import-page/') || r.startsWith('scripts/setup-page/')) return true;
  return /^scripts\/(lib\/)?[^/]+\.mjs$/.test(r);
}

/** What is copied, from the repository into the release folder. Pure: the test reads it. */
export function releasePlan(root = ROOT) {
  return [
    { from: 'scripts', to: 'scripts', filter: (rel) => shipsScript(rel) },
    { from: join('services', 'api', 'dist'), to: join('services', 'api', 'dist') },
    { from: join('edge', 'store-edge', 'dist'), to: join('edge', 'store-edge', 'dist') },
    { from: join('db', 'migrations'), to: join('db', 'migrations') },
    { from: join('infra', 'compose', '.env.example'), to: join('infra', 'compose', '.env.example') },
    ...shippedApps(root).map((a) => ({ from: join('apps', a, 'web'), to: join('apps', a, 'web') })),
  ];
}

/** The release's package.json: an ES module package with exactly one dependency. */
export function releasePackageJson(root = ROOT) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  return { name: 'sre-retail-os-store-pc', version: pkg.version ?? '0.0.0', private: true, type: 'module', dependencies: { pg: pgVersion(root) } };
}

/** The committed PUBLIC licence key (the seller's), if any — the shop's licence is checked with it (CR-01 step 5). */
export function licencePublicKey(root = ROOT) {
  const p = join(root, 'infra', 'licence', 'licence-signing.pub');
  return existsSync(p) ? p : undefined;
}

/** The committed PUBLIC release signing key, if any — the next release's signature is checked with it. */
export function releasePublicKey(root = ROOT) {
  const p = join(root, 'infra', 'deploy', 'release-signing.pub');
  return existsSync(p) ? p : undefined;
}

function arg(argv, name) { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; }

async function main(argv) {
  const out = arg(argv, '--out');
  const pgsql = arg(argv, '--pgsql');
  const winsw = arg(argv, '--winsw');
  const nodeExe = arg(argv, '--node-exe') ?? process.execPath;
  if (out === undefined || pgsql === undefined || winsw === undefined) {
    process.stderr.write('Usage: node scripts/build-store-pc-release.mjs --out <folder> --pgsql <pgsql folder> --winsw <WinSW-x64.exe> [--vcredist <vc_redist.x64.exe>] [--node-exe <node.exe>] [--version v] [--commit sha] [--public-key <release-signing.pub>] [--licence-public-key <licence-signing.pub>] [--skip-build]\n');
    return 2;
  }
  const vcredist = arg(argv, '--vcredist');
  for (const [what, p] of [['PostgreSQL bin', join(pgsql, 'bin', 'postgres.exe')], ['WinSW', winsw], ['node', nodeExe], ...(vcredist === undefined ? [] : [['the Visual C++ runtime installer', vcredist]])]) {
    if (!existsSync(p)) { process.stderr.write(`${what} not found at ${p}\n`); return 2; }
  }
  const node = process.execPath;
  if (!argv.includes('--skip-build')) {
    const run = (a) => { const r = spawnSync(node, a, { cwd: ROOT, stdio: 'inherit' }); if (r.status !== 0) throw new Error(`build failed: ${a.join(' ')}`); };
    run(['scripts/build-service.mjs', 'api', '--quiet']);
    run(['scripts/build-service.mjs', 'edge', '--quiet']);
    run(['scripts/build-service.mjs', 'tools', '--quiet']);
    for (const app of shippedApps()) if (existsSync(join(ROOT, 'apps', app, 'src', 'browser-entry.ts'))) run(['scripts/build-app.mjs', app]);
  }

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const step of releasePlan()) {
    const src = join(ROOT, step.from);
    if (!existsSync(src)) { process.stderr.write(`missing from the build: ${step.from}\n`); return 1; }
    cpSync(src, join(out, step.to), { recursive: true, filter: step.filter === undefined ? undefined : (s) => step.filter(path.relative(ROOT, s)) });
  }
  writeFileSync(join(out, 'package.json'), `${JSON.stringify(releasePackageJson(), null, 2)}\n`);
  // The one library, flat (no links), its own install scripts not run.
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  execFileSync(npm, ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock'], { cwd: out, stdio: 'inherit', shell: process.platform === 'win32' });

  mkdirSync(join(out, 'runtime', 'node'), { recursive: true });
  cpSync(nodeExe, join(out, 'runtime', 'node', process.platform === 'win32' ? 'node.exe' : path.basename(nodeExe)));
  for (const sub of ['bin', 'lib', 'share']) cpSync(join(pgsql, sub), join(out, 'runtime', 'pgsql', sub), { recursive: true });
  mkdirSync(join(out, 'runtime', 'winsw'), { recursive: true });
  cpSync(winsw, join(out, 'runtime', 'winsw', 'WinSW-x64.exe'));
  if (vcredist !== undefined) {
    mkdirSync(join(out, 'runtime', 'vcredist'), { recursive: true });
    cpSync(vcredist, join(out, 'runtime', 'vcredist', 'vc_redist.x64.exe'));
  }

  // CR-01 step 3f: a test build may carry a throwaway test key instead (the clean-Windows update job); never a private key.
  const pub = arg(argv, '--public-key') ?? releasePublicKey();
  if (pub !== undefined) cpSync(pub, join(out, 'release-signing.pub'));
  // CR-01 step 5: the seller's PUBLIC licence key (a test build may carry a throwaway one — never a private key).
  const licencePub = arg(argv, '--licence-public-key') ?? licencePublicKey();
  if (licencePub !== undefined) {
    if (!readFileSync(licencePub, 'utf8').includes('BEGIN PUBLIC KEY')) { process.stderr.write(`${licencePub} is not a PUBLIC key; a release never carries a private key\n`); return 1; }
    cpSync(licencePub, join(out, 'licence-signing.pub'));
  }

  const commit = arg(argv, '--commit') ?? (() => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { return undefined; } })();
  const release = { kind: 'sre-store-pc-release', version: arg(argv, '--version') ?? releasePackageJson().version, commit, builtAt: new Date().toISOString(), node: process.version, postgresql: 16, updatesChecked: pub !== undefined, licensing: licencePub !== undefined };
  writeFileSync(join(out, 'release.json'), `${JSON.stringify(release, null, 2)}\n`);
  process.stdout.write(`store PC release written to ${out} (version ${release.version}${commit ? `, commit ${commit.slice(0, 8)}` : ''}; ${pub === undefined ? 'NO release public key — this PC will refuse every update until one is committed' : 'release public key included'}; ${licencePub === undefined ? 'no licence key — licensing not switched on' : 'licence public key included'})\n`);
  return 0;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
