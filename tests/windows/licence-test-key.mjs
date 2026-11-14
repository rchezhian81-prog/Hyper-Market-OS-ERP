#!/usr/bin/env node
// CR-01 step 5 (OI-10) — a THROWAWAY seller key for the clean-Windows first-run job, made by the owner's own tool
// (scripts/lib/licence-desk.mjs make-key) in the job's temporary folder, before anything is installed. Its passphrase is
// the job's own random one (LICENCE_TEST_PASSPHRASE), never a secret of the shop or the owner. A test build carries its
// PUBLIC half (build-store-pc-release --licence-public-key); the real key is never on a test machine.
//
//   node tests/windows/licence-test-key.mjs <folder>

import * as fs from 'node:fs';
import * as path from 'node:path';
import { makeKeyCommand } from '../../scripts/lib/licence-desk.mjs';

const folder = process.argv[2];
const passphrase = process.env.LICENCE_TEST_PASSPHRASE ?? '';
process.exitCode = await makeKeyCommand({
  fs, path, env: process.env, platform: process.platform, now: () => new Date(),
  say: (l) => { process.stdout.write(`${l}\n`); },
  ask: async () => passphrase,
}, { folder });
