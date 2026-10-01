import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { TEST_IDP } from '../support/api-harness';
import { startRealCloud, type RealCloud } from '../support/real-store';
import { runSmoke, castFor, rolesFor } from '../../scripts/demo-smoke';

/**
 * **The deployed-workflow smoke script passes against the production API assembly on real PostgreSQL — so when the
 * administrator runs it on the demo box, a FAIL means the box, not the script (owner direction, 1 Oct 2026).**
 *
 * `scripts/demo-smoke.ts` is what proves, on the box, that purchase → receiving / QC → back store → floor indent, issue
 * and independent receipt → sale → resale return → till close → books run connected on the API actually deployed there,
 * with stock falling on the sale and returning on the return, cash reconciling and the day book balancing. This runs the
 * same function here, against `startRealCloud` (the same code the container runs, as the application role over a real
 * database), with the synthetic cast provisioned the way the box's bootstrap provisions them. Needs DATABASE_URL; SKIPS
 * without it (the CI shell check refuses a run where the database tests silently skipped).
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const describeOrSkip = DATABASE_URL ? describe : describe.skip;
const KEY = ['demo', 'smoke', 'script', 'signing', 'key'].join('-').padEnd(48, '0');
const RUN = 'r1';

describeOrSkip('scripts/demo-smoke.ts — the deployed-workflow smoke on the real stack', () => {
  let cloud: RealCloud;
  const cast = castFor(RUN);

  beforeAll(async () => {
    cloud = await startRealCloud({ databaseUrl: DATABASE_URL!, tenantId: randomUUID(), owner: cast.owner, packSigningKey: KEY });
    for (const { userId, roleId } of rolesFor(cast)) await cloud.grant(userId, roleId);
  }, 60_000);
  afterAll(async () => { await cloud?.stop(); });

  it('every step passes: the loop runs connected, stock falls on the sale and returns on the resale return, cash and the books reconcile', async () => {
    const lines: string[] = [];
    const report = await runSmoke({ apiBaseUrl: cloud.baseUrl, policy: TEST_IDP.policy(), packSigningKey: KEY, tenantId: cloud.tenantId, run: RUN, say: (l) => lines.push(l) });
    const failed = report.steps.filter((s) => !s.ok);
    expect(failed, `failed steps:\n${failed.map((s) => `  ${s.name}: ${s.detail}`).join('\n')}\n\n${lines.join('\n')}`).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.steps.map((s) => s.name)).toEqual([
      'the API answers and is ready',
      'store setup: the shop\'s time zone and the receiving tolerances',
      'the places: company, store (floor) and back store',
      'head office publishes the catalogue: tax rate, product, store price, barcode, signed pack',
      'supplier proposed by the buyer, approved by a second person; self-approval refused',
      'purchase order proposed by the buyer, issued by a second person; the commitment shows',
      'delivery received at the back store: 10 good on hand, 2 damaged quarantined, the order folded',
      'QC: a second person sends the damaged tins back; the receiver cannot decide it',
      'floor indent: requested → approved against real stock → issued (in transit, not received) → received independently',
      'the store box pulls head office\'s pack and the till is built from it',
      'the cashier takes the float and SELLS one by barcode; the sale is on the box\'s disk, then banks, and the shelf falls by ONE',
      'an eligible RESALE return (manager-approved) refunds the cash and puts the unit back on the shelf',
      'pickup and blind till close: the cash office sees the chain and no over/short',
      'the supplier invoice is captured and matched by a second person; the debit note; the account owes the net',
      'the books: payables and the day book post balanced; the ledger agrees with the register; the dashboard shows the day',
      'the same sale re-sent to head office banks once and moves no stock',
    ]);
    expect(report.tenantId).toBe(cloud.tenantId);
    // A second run in the SAME tenant under another label collides with nothing — what a re-run on the box relies on.
    const again = await runSmoke({ apiBaseUrl: cloud.baseUrl, policy: TEST_IDP.policy(), packSigningKey: KEY, tenantId: cloud.tenantId, run: 'r2' });
    // r2's people are not provisioned: the first authenticated write is refused, and the report SAYS so instead of passing.
    expect(again.ok).toBe(false);
    expect(again.steps.find((s) => !s.ok)?.name).toBe('store setup: the shop\'s time zone and the receiving tolerances');
  }, 180_000);
});
