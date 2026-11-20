import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TEST_IDP } from '../support/api-harness';
import { backingsFor, headOffice, linkBoxTo, TEST_PACK_KEY } from '../support/till-bill-world';
import { startEdge } from '../../edge/store-edge/src/main';
import { bootPos, laneDurable, laneCashMovement, laneShiftClose, laneTillCash } from '../../apps/pos/src/browser-entry';
import { prepareTillBox, holdSignedInAt } from '../support/till-operator';
import { readLog } from '../../edge/store-edge/src/file-log';
import { readTillCashRecord } from '../../edge/store-edge/src/till-cash';

/**
 * **Batch 20a · T1 (M14-FR-01 · M14-FR-02 · P-01) — a CASH LOAN (change added to the drawer) and a SAFE DROP are taken at
 * the till with the internet OFF, recorded on the store computer's own cash log before the cashier is told, counted into the
 * blind close, and reach head office's cash office by kind — on the in-memory store AND real PostgreSQL (cold restart).**
 *
 * The till sends only what a cashier knows; the store computer judges each movement with the one-custodian, no-overdraw guard
 * (a safe drop of more than the drawer holds is refused in words, nothing written). The close is still blind: only once the
 * count is made does the answer say the shift's float, loans, pickups and safe drops. Synthetic data only.
 */

const { backings, open, close } = backingsFor(process.env['DATABASE_URL']);
beforeAll(open);
afterAll(close);

const KEY = TEST_PACK_KEY; // head office checks the box's seal with the same key (ADR-0023)
const DAY = '2026-11-20';
const at = (hhmm: string): string => `${DAY}T${hhmm}:00.000Z`;

describe.each(backings)('Batch 20a · T1 — a cash loan and a safe drop, offline at the till, to the cash office — on $name', (backing) => {
  it('loan + safe drop on the box with the cable out; the close keeps them by kind; head office records them; a too-big drop is refused', async () => {
    const ho = await headOffice(backing, [{ userId: 'u-meena', role: 'cashier' }, { userId: 'u-box', role: 'store_computer', stores: ['store-1'] }, { userId: 'u-mgr', role: 'store_manager' }]);
    const link = linkBoxTo(ho, 'u-box', 'store-1');
    const dir = await mkdtemp(join(tmpdir(), 'sre-b20a-t1-'));
    try {
      const env = {
        EDGE_DATA_DIR: dir, EDGE_TENANT_ID: ho.tenantId, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
        CLOUD_API_URL: 'https://cloud.example.test', CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-box', tenantId: ho.tenantId, branchId: 'store-1' }),
        ...await prepareTillBox({
          dir, key: KEY, people: [{ userId: 'u-meena', displayName: 'Meena' }],
          pack: { policies: { storeId: 'store-1', branchId: 'store-1', branchName: 'Main', tradingDayCutoff: '02:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, cashVarianceToleranceMinor: 10_000, privacySlaDays: 15, warehouseId: 'wh-1' }, lossPreventionRules: [] },
        }),
      };
      link.online = false; // the internet is OFF for the whole shift (P-01)
      const edge = (await startEdge(env, () => {}))!;
      const port = edge.lane!.port;
      const till = bootPos({ laneId: 'lane-1', taxPercent: 0, lanePort: port, durable: laneDurable(port), cashMovement: laneCashMovement(port), shiftClose: laneShiftClose(port), tillCash: laneTillCash(port) });
      await holdSignedInAt(port, 'u-meena');
      till.signIn('u-meena');

      expect(await till.till.moveCash({ kind: 'float_issue', amountMinor: 200_000, at: at('03:30'), movementId: 'cm-float' })).toMatchObject({ committed: true });
      expect(await till.till.moveCash({ kind: 'loan', amountMinor: 50_000, at: at('05:00'), movementId: 'cm-loan' })).toMatchObject({ committed: true, kind: 'loan' });
      // The same loan sent again after a lost reply is ONE loan.
      expect(await till.till.moveCash({ kind: 'loan', amountMinor: 50_000, at: at('05:00'), movementId: 'cm-loan' })).toMatchObject({ committed: true, alreadyRecorded: true });
      // A safe drop of more than the drawer holds: refused in the cashier's words, nothing written.
      const tooMuch = await till.till.moveCash({ kind: 'safe_drop', amountMinor: 900_000, at: at('06:00'), movementId: 'cm-drop-big' });
      expect(tooMuch).toMatchObject({ committed: false, refusedBecause: 'insufficient_till_cash' });
      expect(await till.till.moveCash({ kind: 'safe_drop', amountMinor: 100_000, at: at('07:00'), movementId: 'cm-drop' })).toMatchObject({ committed: true, kind: 'safe_drop' });
      expect(await till.till.moveCash({ kind: 'pickup', amountMinor: 30_000, at: at('08:00'), movementId: 'cm-pick' })).toMatchObject({ committed: true });

      // Expected: 2,000 + 500 − 1,000 − 300 = ₹1,200. Counted ₹1,000: short ₹200, beyond the ₹100 tolerance → a reason.
      const first = await till.till.close({ shiftId: 'sh-b20a', closedAt: at('14:00'), countedMinor: 100_000 });
      expect(first).toMatchObject({ closed: false, refusedBecause: 'material_variance_needs_a_reason', varianceMinor: -20_000 });
      expect('drawer' in first).toBe(false); // never before the count is accepted
      const closed = await till.till.close({ shiftId: 'sh-b20a', closedAt: at('14:00'), countedMinor: 100_000, reasonCode: 'miscount' });
      expect(closed).toMatchObject({ closed: true, varianceMinor: -20_000, exceptionRaised: true, drawer: { floatMinor: 200_000, loansMinor: 50_000, pickupsMinor: 30_000, safeDropsMinor: 100_000 } });

      // On the box's own append-only log: four movements (each kind once) and the close with the loans and drops by kind.
      const log = (await readLog(edge.tillCashLog.path)).flatMap((r) => (r.ok ? [readTillCashRecord(JSON.parse(r.record))] : []));
      expect(log.map((r) => (r?.kind === 'movement' ? r.movementKind : r?.kind))).toEqual(['float_issue', 'loan', 'safe_drop', 'pickup', 'close']);
      expect(log.at(-1)).toMatchObject({ kind: 'close', openingFloatMinor: 250_000, pickupsMinor: 130_000, expectedMinor: 120_000, loansMinor: 50_000, safeDropsMinor: 100_000 });
      // The retry of the close is the same close, with the same figures.
      expect(await till.till.close({ shiftId: 'sh-b20a', closedAt: at('14:00'), countedMinor: 100_000, reasonCode: 'miscount' })).toMatchObject({ closed: true, alreadyClosed: true, drawer: { loansMinor: 50_000, safeDropsMinor: 100_000 } });

      // The internet comes back: everything reaches head office once.
      link.online = true;
      expect((await edge.syncOnce!()).dead).toBe(0);
      expect(edge.tillCashAgent?.health().unsentCount).toBe(0);
      await edge.stop();

      ho.restartCold();
      // Head office's chain for the till: float + loan − safe drop − pickup, nothing flagged (each kind re-judged there too).
      expect(await ho.ok('GET', '/v1/tills/lane-1/cash', 'u-owner')).toMatchObject({ custodian: 'u-meena', balanceMinor: 120_000, flagged: [] });
      const os = await ho.ok('GET', '/v1/shifts/over-short', 'u-owner');
      expect((os['overShort'] as Record<string, unknown>[]).find((r) => r['shiftId'] === 'sh-b20a')).toMatchObject({ varianceMinor: -20_000, loansMinor: 50_000, safeDropsMinor: 100_000, flags: [] });
    } finally {
      link.restore();
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
