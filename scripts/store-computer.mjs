#!/usr/bin/env node
// The owner's guided store-computer setup (OB-240 · OB-244). A thin shell: everything that decides something is in
// scripts/lib/store-computer.mjs, where the tests drive it with injected files, programs and network.
//
//   pnpm run store-computer -- doctor
//   pnpm run store-computer -- prepare
//   pnpm run store-computer -- up
//   pnpm run store-computer -- check --by "<your name>" [--offline-confirmed] [--backup-record <file>] [--out <folder>]
//
// Works the same in Windows PowerShell and on Linux: Node built-ins only, no shell. It never prints a secret.
// The step-by-step guide: docs/runbooks/store-computer-owner-guide-windows.md

import { defaultDeps, main } from './lib/store-computer.mjs';

process.exitCode = await main(process.argv.slice(2), defaultDeps());
