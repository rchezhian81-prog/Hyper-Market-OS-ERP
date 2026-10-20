#!/usr/bin/env node
// The owner's guided store-computer setup (OB-240 · OB-244 · OB-245 · OB-246). A thin shell: everything that decides something is in
// scripts/lib/store-computer.mjs, where the tests drive it with injected files, programs and network.
//
//   pnpm run store-computer -- doctor
//   pnpm run store-computer -- prepare
//   pnpm run store-computer -- up
//   pnpm run store-computer -- check --by "<your name>" [--offline-confirmed] [--demo-fingerprints <file>] [--backup-record <file>] [--out <folder>]
//   pnpm run store-computer -- fingerprints [--settings <file>] [--out <folder>]     (also on the demo box: node scripts/store-computer.mjs fingerprints)
//   pnpm run store-computer -- backup --to <folder on the backup drive>
//   pnpm run store-computer -- restore-check --from <backup manifest or file>
//   pnpm run store-computer -- drill --by "<your name>" --to <folder> --previous <previous release folder> [--run]
//
// Works the same in Windows PowerShell and on Linux: Node built-ins only, no shell. It never prints a secret.
// The step-by-step guide: docs/runbooks/store-computer-owner-guide-windows.md

import { defaultDeps, main } from './lib/store-computer.mjs';

process.exitCode = await main(process.argv.slice(2), defaultDeps());
