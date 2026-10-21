#!/usr/bin/env node
// `pnpm run till:pin -- --user <staff id> --by "<your name>" [--revoke]` — set (or revoke) a person's till PIN on THIS
// store computer, with the till's own settings loaded (gap W-6, owner guide). The person whose PIN it is then types their
// own new PIN twice at this keyboard, hidden (round 4): the owner never sees it, and nothing prints or logs it.
//
// The till's PIN command lives in the built store edge (`edge/store-edge/dist/start.js till-pin`) and needs the till's
// settings — where its data is (EDGE_DATA_DIR) and the key its PIN checks are made with (PACK_SIGNING_KEY). Before this,
// the package script ran it with none of them, so it could not find the till's data. This finds the till's settings file
// the way the till itself is started — the shop's data folder first (C:\SRE-data\till\till.env, audit row 9), else this
// release's own till folder — loads it into the command's environment only, and runs the command with this window's own
// keyboard (`stdio: 'inherit'`, so the PIN command can hide what is typed). Nothing is printed here but the file's NAME.
//
// Windows first: Node built-ins only, the program started with an argument array and no shell.

import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultDataRoot, parseEnvText, pathFor } from './lib/store-computer.mjs';

/** Where the till's settings file is on this computer: the data folder's till.env, else this release's till\till.env. */
export function tillEnvPathFor({ repoRoot, platform, env, exists = existsSync }) {
  const p = pathFor(platform);
  const candidates = [p.join(defaultDataRoot(repoRoot, platform, env), 'till', 'till.env'), p.join(repoRoot, 'till', 'till.env')];
  return candidates.find((c) => exists(c));
}

/** The command line to hand on: a leading `--` (pnpm 10 passes it through) is not part of it. */
export const passedArgs = (argv) => { const a = [...argv]; while (a[0] === '--') a.shift(); return a; };

/** The environment the PIN command runs with: this window's, with the till's settings over it. */
export function pinCommandEnv(processEnv, tillEnvText) {
  return { ...processEnv, ...parseEnvText(tillEnvText) };
}

function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const file = tillEnvPathFor({ repoRoot, platform: process.platform, env: process.env });
  if (file === undefined) {
    process.stdout.write('The till is not installed on this computer yet (no till.env in the shop\'s data folder or in this folder\'s till folder). Install it first: pnpm run till:install (owner guide Part 13).\n');
    process.exit(2);
  }
  const entry = path.join(repoRoot, 'edge', 'store-edge', 'dist', 'start.js');
  if (!existsSync(entry)) {
    process.stdout.write('The till program is not built in this folder yet. Run the till install again (pnpm run till:install), then this.\n');
    process.exit(2);
  }
  process.stdout.write(`Using the till's settings in ${file} (never shown).\n`);
  const r = spawnSync(process.execPath, [entry, 'till-pin', ...passedArgs(process.argv.slice(2))], {
    cwd: repoRoot, env: pinCommandEnv(process.env, readFileSync(file, 'utf8')), stdio: 'inherit', windowsHide: false, shell: false,
  });
  process.exit(r.status ?? 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
