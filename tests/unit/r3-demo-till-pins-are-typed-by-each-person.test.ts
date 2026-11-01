// Round 3 (screen gap audit, Round C): the demo issues its people's till PINs through the store box's OWN audited PIN
// command, inside the demo's edge container — each person types their own; nothing here holds, makes or shows a PIN.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { demoTillPinPlan } from '../../db/seed/pilot/till-pins';
import { PILOT_DEMO_TENANT, PILOT_DEMO_TILL_PIN_HOLDERS } from '../../db/seed/pilot/dataset';

const BASE = { tenantId: PILOT_DEMO_TENANT, by: 'Mr Demo Operator', project: 'sre-pilot', envFile: '.env.pilot' } as const;

describe('the demo till PINs', () => {
  it('one command per demo person who closes the day, sells or approves at the till — the box\'s own till-pin command, typed by the person', () => {
    const plan = demoTillPinPlan(BASE);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.commands.map((c) => c[c.indexOf('--user') + 1])).toEqual([...PILOT_DEMO_TILL_PIN_HOLDERS]);
    expect(PILOT_DEMO_TILL_PIN_HOLDERS).toEqual(expect.arrayContaining(['pilot-manager', 'pilot-cashier']));
    for (const c of plan.commands) {
      expect(c.slice(-6, -3)).toEqual(['edge/store-edge/dist/start.js', 'till-pin', '--user']);
      expect(c).toEqual(expect.arrayContaining(['exec', 'edge', '--by', 'Mr Demo Operator']));
      expect(c).not.toContain('--generate-and-show');
      expect(c.join(' ')).not.toMatch(/\b\d{6}\b/); // no PIN anywhere in what is run
    }
  });
  it('refuses a box that is not the demo, a production mark, no --by, or a person who is not one of the demo\'s', () => {
    const refusals = (f: Parameters<typeof demoTillPinPlan>[0]): string => { const p = demoTillPinPlan(f); return p.ok ? '' : p.refusals.join(' '); };
    expect(refusals({ ...BASE, tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })).toMatch(/not the synthetic demo tenant/);
    expect(refusals({ ...BASE, migrationTargetKind: 'production' })).toMatch(/production/);
    expect(refusals({ ...BASE, by: '' })).toMatch(/no --by/);
    expect(refusals({ ...BASE, user: 'pilot-owner2' })).toMatch(/not one of the demo people/);
    expect(demoTillPinPlan({ ...BASE, user: 'pilot-manager' })).toMatchObject({ ok: true, commands: [expect.arrayContaining(['pilot-manager'])] });
  });
  it('no PIN is written anywhere in the demo seed or its tools', () => {
    for (const f of ['db/seed/pilot/dataset.ts', 'db/seed/pilot/till-pins.ts', 'db/seed/pilot/run-till-pins.ts', 'scripts/demo-till-pins.mjs']) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/\bpin\s*[:=]\s*['"]?\d{4,}/i);
    }
  });
});
