import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ApiHarness } from '../support/api-harness';
import { TEST_IDP } from '../support/api-harness';
import { r3OpsBackings } from '../support/r3-ops-backings';
import { runOwnerSetup, type SetupClient } from '../../packages/migration/src/owner-steps-command';
import { buildPersonToken } from '../../scripts/lib/operator-env';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';
import type { StorePackEnvelope } from '../../services/platform/src/store-packs';
import { packPayloadOf } from '../../edge/store-edge/src/store-pack-held';
import { readPack } from '../../edge/store-edge/src/store-pack';
import { managerPayload, reportingPayload, expiryPayload, servicePayload, type ScreenInput } from '../../edge/store-edge/src/screen-data';

/**
 * D-3 (pilot-first audit, OB-739; fix round 1, OB-773) — the store's working rules, set by the owner's `store-rules`
 * command on the store PC, through head office's EXISTING route (POST /v1/stores/:storeId/rules) as the owner, on the
 * real API — in memory and on PostgreSQL, with a COLD RESTART before the store PC's till pulls its setup:
 *
 *   • before: the store's setup reaches the till WITHOUT the rules — Today's Tasks / Checklist / Expiring soon are
 *     "not known", and Reports and Expiry have nothing (the pages fall back to sample data);
 *   • the command: the checklist from the owner's text file, every limit in rupees, percent, days and minutes — saved as
 *     version 1, set by the owner; the same line again records nothing new (still version 1);
 *   • after: the setup the till pulls (as its own store-edge sign-in, exactly as edge/sync-agent/src/store-pack-feed.ts
 *     does) carries them, and the till's own reader and screens show real values — the checklist's items with the ones
 *     that hold the day close, "within 30 days", the reports' late/old minutes, the expiry window, the service limits.
 */

const backings = r3OpsBackings();
const OWNER = 'u-owner';
const MANAGER = 'u-manager';
const STORE = 'SRE-MAIN';
const GSTIN = '33AABCS1429B1Z1';
const CHECKLIST_FILE = 'C:\\Users\\owner\\Documents\\closing-checklist.txt';
const CHECKLIST = 'MUST: Cash counted\r\nMUST: Back store and safe locked\r\nFreezers checked\r\n';

/** The demo seed's own figures (db/seed/pilot/dataset.ts storeSetup.rules), as the owner types them. */
const RULES: Record<string, string> = {
  as: OWNER, store: STORE, checklist: CHECKLIST_FILE,
  'approval-limit-rupees': '5000', 'margin-floor-percent': '20', 'near-expiry-days': '30',
  'reports-late-after-minutes': '5', 'reports-old-after-minutes': '60',
  'return-window-days': '7', 'refund-approval-rupees': '2000', 'no-receipt-cap-rupees': '500', 'desk-authority-rupees': '50', 'compensation-cap-rupees': '500',
  'journal-takings': 'TK', 'journal-tax': 'TX', 'journal-refunds': 'RF', 'dormant-after-days': '60', 'ai-old-after-minutes': '60',
  'refill-below-percent': '50', 'shelf-count-old-after-minutes': '120', 'refill-role': 'store_manager', 'write-off-second-person-rupees': '500',
};

function personClient(get: () => ApiHarness): SetupClient {
  return {
    request: async (r) => get().raw({
      method: r.method, path: r.path, ...(r.body === undefined ? {} : { body: r.body }), ...(r.idempotencyKey === undefined ? {} : { idempotencyKey: r.idempotencyKey }),
      token: buildPersonToken({ sub: r.userId, tenantId: r.tenantId, ttlSeconds: 300, authTimeSec: Math.floor(Date.parse(r.signedInAt) / 1000) }, TEST_IDP.policy(), Date.now()),
    }),
  };
}

/** What the store PC's till does with its setup: pull it as store-edge, read it with its own reader, build its screens. */
async function tillScreens(h: ApiHarness, T: string) {
  const res = await h.request({ method: 'GET', path: `/v1/store-packs/${STORE}`, userId: 'store-edge', tenantId: T, branchId: STORE });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const env = res.body as StorePackEnvelope;
  const now = new Date().toISOString();
  const input = { pack: readPack(packPayloadOf(env), env.issuedAt), sales: [], unreadableRecords: 0, outbox: { pending: () => [] }, now, tradingDay: shopDateIn(now) } as unknown as ScreenInput;
  const manager = managerPayload(input);
  return { input, today: manager['today'] as Record<string, { known: boolean; value?: number; note?: string }>, tasks: manager['tasks'] as { id: string; what: string }[] | undefined, reporting: reportingPayload(input), expiry: expiryPayload(input), service: servicePayload(input) };
}

describe.each(backings)('the owner sets the store\'s working rules on the store PC — on $name (D-3)', ({ harness, restart }) => {
  it('the rules land through the real route as the owner, and the till\'s Today, Reports and Expiry then show real values', async () => {
    let h: ApiHarness = harness();
    const T = randomUUID();
    await h.seedOwner(T, OWNER);
    await h.provisionRole(T, MANAGER, 'store_manager');
    await h.provisionRole(T, 'u-it', 'platform_admin');
    const client = personClient(() => h);
    const deps = { client, confirm: async () => true, askPin: async () => '123456', verifyPin: () => 'ok' as const, readText: (f: string) => (f === CHECKLIST_FILE ? CHECKLIST : undefined) };
    const run = (step: string, values: Record<string, string>) => runOwnerSetup({ step, tenantId: T, targetKind: 'rehearsal', demoTenantIds: ['pilot-demo'], values, today: shopDateIn(new Date().toISOString()), now: () => new Date().toISOString() }, deps);
    const expectDone = async (p: ReturnType<typeof run>) => { const o = await p; expect(o.exitCode, o.lines.join('\n')).toBe(0); return o; };

    await expectDone(run('shop', { as: 'u-it', approver: OWNER, company: 'SRE', 'legal-name': 'SRE Hyper Market Private Limited', gstin: GSTIN, store: STORE, 'store-name': 'SRE Hyper Market' }));
    await expectDone(run('store-settings', { as: OWNER, store: STORE, cutoff: '00:00', 'stale-after-minutes': '15', 'count-approval-rupees': '0', 'handover-tolerance-rupees': '0', 'cash-variance-rupees': '0' }));
    await expectDone(run('grant', { as: MANAGER, approver: OWNER, person: 'store-edge', role: 'store_computer', store: STORE, reason: 'the till on the store PC' }));

    // BEFORE — the store PC as the audit found it: no rules, so the tiles are "not known" and the pages have nothing.
    const before = await tillScreens(h, T);
    expect(before.today['checklistOpen']).toMatchObject({ known: false });
    expect(before.today['expiringSoon']).toMatchObject({ known: false });
    expect(before.tasks).toBeUndefined();
    expect(before.reporting).toBeNull();
    expect(before.expiry).toBeNull();

    // A refused line saves nothing: a percentage over 100 is named, and head office still holds no rules.
    const refused = await run('store-rules', { ...RULES, 'margin-floor-percent': '120' });
    expect(refused.exitCode).toBe(2);
    expect(refused.lines.join('\n')).toContain('--margin-floor-percent must be a percentage from 0 to 100');
    expect((await h.request({ method: 'GET', path: `/v1/stores/${STORE}/rules`, userId: OWNER, tenantId: T })).status).toBe(404);

    const first = await expectDone(run('store-rules', RULES));
    expect(first.lines.join('\n')).toContain(`store ${STORE}'s working rules saved as version 1`);
    // The same line again: nothing new recorded.
    const again = await expectDone(run('store-rules', RULES));
    expect(again.lines.join('\n')).toContain('already in force as version 1 — nothing new recorded');

    h = restart(h); // ── COLD RESTART ───────────────────────────────────────────────────────────────────────────
    const held = await h.request({ method: 'GET', path: `/v1/stores/${STORE}/rules`, userId: OWNER, tenantId: T });
    expect(held.status, JSON.stringify(held.body)).toBe(200);
    expect(held.body).toMatchObject({
      rules: {
        storeId: STORE, version: 1, setBy: OWNER, nearExpiryDays: 30, approvalLimitMinor: 500_000, marginFloorBps: 2_000,
        reporting: { laggingAfterMinutes: 5, staleAfterMinutes: 60 }, journalPrefixes: { takings: 'TK', tax: 'TX', refunds: 'RF' },
        service: { returnWindowDays: 7, approvalThresholdMinor: 200_000, noReceiptCapMinor: 50_000, agentAuthorityMinor: 5_000, compensationCapMinor: 50_000 },
        merchandising: { refillAtBp: 5_000, countStaleAfterMinutes: 120, refillRole: 'store_manager' }, writeOffMaterialThresholdMinor: 50_000,
        checklist: [
          { itemId: 'close-1', description: 'Cash counted', blocking: true },
          { itemId: 'close-2', description: 'Back store and safe locked', blocking: true },
          { itemId: 'close-3', description: 'Freezers checked', blocking: false },
        ],
      },
    });

    // AFTER — the till pulls its setup and its screens show real values, not "not known" or sample data.
    const after = await tillScreens(h, T);
    expect(after.today['checklistOpen']).toMatchObject({ known: true, value: 3, note: '2 must be done before the day closes' });
    expect(after.today['expiringSoon']).toMatchObject({ known: true, value: 0 });
    expect(after.today['expiringSoon']!.note).toMatch(/^within 30 days, of \d+ batches$/);
    expect(after.tasks?.map((t) => t.what)).toEqual(['Cash counted (the shop cannot close without this)', 'Back store and safe locked (the shop cannot close without this)', 'Freezers checked']);
    expect(after.reporting).toMatchObject({ storeId: STORE, laggingAfterMinutes: 5, staleAfterMinutes: 60 });
    expect(after.expiry).toMatchObject({ storeId: STORE, nearExpiryDays: 30 });
    expect(after.service).toMatchObject({ returnWindowDays: 7, approvalThresholdMinor: 200_000, noReceiptCapMinor: 50_000, agentAuthorityMinor: 5_000, compensationCapMinor: 50_000 });
    expect(after.input.pack.managerPolicy.known && after.input.pack.managerPolicy.value.approvalLimitMinor).toBe(500_000);
  }, 120_000);
});
