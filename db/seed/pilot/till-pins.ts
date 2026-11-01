// The demo people's TILL PINs on the hosted demo box (Round 3 of the screen gap audit, 31 Oct 2026: "close-day needs a
// till PIN the demo never issues").
//
// No PIN is data, and none is made here. The store box's own PIN command issues each one (edge/store-edge/src/
// till-pin-command.ts, ADR-0020 §2 · round 4): the person whose PIN it is types their own six digits twice, hidden, at the
// box's keyboard; only a fingerprint is kept, on the box's disk, appended with who issued it. This file only says WHICH
// demo people need one and builds the command that runs that existing command inside the demo's edge container — the same
// line the in-store install runbook gives for the hosted copy (Step 2b). It refuses anything that is not the demo, and
// never builds the old `--generate-and-show` (a PIN shown on the screen).

import { PILOT_DEMO_TENANT, PILOT_DEMO_TILL_PIN_HOLDERS } from './dataset';

export interface DemoTillPinFacts {
  /** `EDGE_TENANT_ID` from the box's settings file. */
  readonly tenantId: string;
  readonly migrationTargetKind?: string;
  /** The person running it — recorded on each PIN as who issued it. */
  readonly by: string;
  /** One demo person only (`--user`), or every demo person who needs one. */
  readonly user?: string;
  /** The compose project, files and env file of the demo stack. */
  readonly project: string;
  readonly envFile: string;
}

export type DemoTillPinPlan =
  | { readonly ok: true; readonly commands: readonly (readonly string[])[] }
  | { readonly ok: false; readonly refusals: readonly string[] };

/** The commands to run, one per person, or why not. Never a PIN, never `--generate-and-show`. */
export function demoTillPinPlan(f: DemoTillPinFacts): DemoTillPinPlan {
  const refusals: string[] = [];
  if (f.tenantId !== PILOT_DEMO_TENANT) refusals.push(`the settings name tenant "${f.tenantId}", not the synthetic demo tenant — this tool only issues the DEMO people's PINs`);
  if (f.migrationTargetKind === 'production') refusals.push('MIGRATION_TARGET_KIND is "production" — never on a production-marked box (hard rule #7)');
  if (f.by.trim() === '') refusals.push('no --by name — each PIN records the person who issued it');
  if (f.user !== undefined && !PILOT_DEMO_TILL_PIN_HOLDERS.includes(f.user)) {
    refusals.push(`${f.user} is not one of the demo people who need a till PIN (${PILOT_DEMO_TILL_PIN_HOLDERS.join(', ')})`);
  }
  if (refusals.length > 0) return { ok: false, refusals };
  const people = f.user === undefined ? PILOT_DEMO_TILL_PIN_HOLDERS : [f.user];
  return {
    ok: true,
    commands: people.map((userId) => [
      'docker', 'compose', '-p', f.project, '-f', 'docker-compose.yml', '-f', 'docker-compose.pilot.yml', '--env-file', f.envFile,
      'exec', 'edge', 'node', 'edge/store-edge/dist/start.js', 'till-pin', '--user', userId, '--by', f.by.trim(),
    ]),
  };
}
