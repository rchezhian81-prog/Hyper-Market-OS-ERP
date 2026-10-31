// Operator entry point for the demo people's till PINs (see till-pins.ts). Bundled and run by `scripts/demo-till-pins.mjs`.
// For each person it says whose turn it is, then hands this terminal's keyboard to the box's own PIN command: that person
// types their new PIN twice, hidden. Nothing here reads, prints or keeps a PIN.

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { demoTillPinPlan } from './till-pins';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};

function settingOf(text: string, name: string): string | undefined {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith(`${name}=`));
  return line === undefined ? undefined : line.slice(name.length + 1).trim();
}

const composeDir = arg('compose-dir') ?? 'infra/compose';
const envFile = arg('env-file') ?? '.env.pilot';
const settings = readFileSync(`${composeDir}/${envFile}`, 'utf8');
const kind = settingOf(settings, 'MIGRATION_TARGET_KIND');
const user = arg('user');
const plan = demoTillPinPlan({
  tenantId: settingOf(settings, 'EDGE_TENANT_ID') ?? '', by: arg('by') ?? '', project: arg('project') ?? 'sre-pilot', envFile,
  ...(kind === undefined ? {} : { migrationTargetKind: kind }), ...(user === undefined ? {} : { user }),
});
if (!plan.ok) {
  for (const r of plan.refusals) console.error(`REFUSED — ${r}`);
  console.error('Usage: pnpm run demo:till-pins -- --by "<your name>" [--user <demo person>]');
  process.exit(2);
}
let failed = 0;
for (const command of plan.commands) {
  const who = command[command.indexOf('--user') + 1];
  console.log(`\nTill PIN for ${who}: hand the keyboard to ${who} and look away. They type their own new PIN twice; it never shows.`);
  const r = spawnSync(command[0]!, command.slice(1), { cwd: composeDir, stdio: 'inherit', shell: false });
  if (r.status !== 0) { failed += 1; console.error(`✗ ${who}: no PIN was set (nothing changed for them). Run again with --user ${who}.`); }
}
process.exit(failed === 0 ? 0 : 1);
