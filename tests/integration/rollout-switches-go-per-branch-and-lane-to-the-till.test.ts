import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { backingsFor, headOffice, startBox, storePack, type Box, type HeadOffice } from '../support/till-bill-world';
import { askForApproval, decide } from '../support/approval-request';
import { actionDetails } from '../../services/identity/src/approval-requests';
import { posRolloutOf } from '../../apps/pos/src/lane-rollout';

/**
 * **R8-9 · OB-316 (owner, 23 Oct 2026, in writing) — a feature switched on per branch and per till lane, each change with
 * a reason, versioned and rolled back in one step; a high-impact switch needs the owner; the till reads its lane's switch
 * OFFLINE from the signed store pack.** On the in-memory store AND real PostgreSQL, head office restarted cold, the store
 * computer restarted cold with no head office anywhere. Synthetic data only.
 */

const { backings, open, close } = backingsFor(process.env['DATABASE_URL']);
beforeAll(open);
afterAll(close);
const boxes: Box[] = [];
afterEach(async () => { for (const b of boxes.splice(0)) { await b.stop(); await b.remove(); } });

type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;

async function shop(ho: HeadOffice): Promise<void> {
  await ho.ok('POST', '/v1/org/nodes/SRE', 'u-owner', { kind: 'company', name: 'SRE Hyper Market Private Limited' });
  for (const b of ['B1', 'B2']) await ho.ok('POST', `/v1/org/nodes/${b}`, 'u-owner', { kind: 'branch', name: `Store ${b}`, parentId: 'SRE', companyId: 'SRE' });
  await ho.ok('POST', '/v1/stores/B1/settings', 'u-owner', { tradingDayCutoff: '00:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 0, handoverToleranceMinor: 0, cashVarianceToleranceMinor: 0, privacySlaDays: 15 });
  for (const lane of ['lane-1', 'lane-7']) await ho.ok('POST', `/v1/platform/devices/${lane}/register`, 'u-owner', { branchId: 'B1', kind: 'pos_lane', label: lane });
}

describe.each(backings)('rollout switches per branch and per lane reach the till offline — on $name', (backing) => {
  it('reason, version, preview, rollback; refusals by name; owner approval when high-impact; the pack and the till', async () => {
    const ho = await headOffice(backing, [
      { userId: 'u-it', role: 'platform_admin' }, { userId: 'u-it-b2', role: 'platform_admin', stores: ['B2'] },
      { userId: 'u-cash', role: 'cashier' }, { userId: 'u-box', role: 'store_computer', stores: ['B1'] },
    ]);
    await shop(ho);
    const put = (who: string, key: string, body: Record<string, unknown>) => ho.call('PUT', `/v1/platform/rollout/${key}`, who, body);

    // Refusals, each by name, nothing recorded.
    expect(codeOf(await put('u-it', 'self_checkout', { branchId: 'B1', laneId: 'lane-7', enabled: true }))).toBe('reason_required');
    expect(codeOf(await put('u-it', 'Self Checkout', { branchId: 'B1', enabled: true, reason: 'trial' }))).toBe('not_a_switch_name');
    expect(codeOf(await put('u-it', 'self_checkout', { enabled: true, reason: 'trial' }))).toBe('rollout_place_not_given');
    expect(codeOf(await put('u-it', 'self_checkout', { branchId: 'B9', enabled: true, reason: 'trial' }))).toBe('unknown_branch');
    expect(codeOf(await put('u-it', 'self_checkout', { branchId: 'B1', laneId: 'lane-99', enabled: true, reason: 'trial' }))).toBe('unknown_lane');
    expect((await put('u-cash', 'self_checkout', { branchId: 'B1', laneId: 'lane-7', enabled: true, reason: 'trial' })).status).toBe(403);
    expect((await put('u-it-b2', 'self_checkout', { branchId: 'B1', laneId: 'lane-7', enabled: true, reason: 'trial' })).status).toBe(403); // B1 is outside their scope

    // Preview first: it changes lane 7 only, needs nobody else.
    const preview = await ho.ok('POST', '/v1/platform/rollout/self_checkout/preview', 'u-it', { branchId: 'B1', laneId: 'lane-7', enabled: true });
    expect(preview).toMatchObject({ current: null, currentVersion: 0, lanesReached: ['lane-7'], lanesThatChange: ['lane-7'], highImpact: false, needsSecondPerson: false });
    const branchPreview = await ho.ok('POST', '/v1/platform/rollout/digital_receipts/preview', 'u-it', { branchId: 'B1', enabled: true });
    expect(branchPreview).toMatchObject({ lanesReached: ['lane-1', 'lane-7'], lanesThatChange: ['lane-1', 'lane-7'] });

    // Self-checkout on lane 7 only (a lane switch, the branch never set); digital receipts on for the branch, off on lane 1.
    const on = await ho.ok('PUT', '/v1/platform/rollout/self_checkout', 'u-it', { branchId: 'B1', laneId: 'lane-7', enabled: true, reason: 'self-checkout trial on lane 7 (wave 1)' });
    expect(on).toMatchObject({ change: { version: 1, changedBy: 'u-it', laneId: 'lane-7' }, before: { on: false, source: 'never_set' }, now: { on: true, source: 'lane' } });
    await ho.ok('PUT', '/v1/platform/rollout/digital_receipts', 'u-it', { branchId: 'B1', enabled: true, reason: 'digital receipts trial in B1' });
    await ho.ok('PUT', '/v1/platform/rollout/digital_receipts', 'u-it', { branchId: 'B1', laneId: 'lane-1', enabled: false, reason: 'lane 1 has no receipt link yet' });
    await ho.ok('PUT', '/v1/platform/rollout/digital_receipts', 'u-it', { branchId: 'B1', enabled: false, reason: 'receipts slow — stop' });

    ho.restartCold(); // ── head office COLD ──
    // Rollback in one step: version 1's state restored as version 3, shown in the history as its own event.
    const back = await ho.ok('POST', '/v1/platform/rollout/digital_receipts/rollback', 'u-it', { branchId: 'B1', toVersion: 1, reason: 'firmware fixed — back on' });
    expect(back).toMatchObject({ change: { version: 3, enabled: true, rolledBackFrom: 1 } });
    expect(codeOf(await ho.call('POST', '/v1/platform/rollout/digital_receipts/rollback', 'u-it', { branchId: 'B1', toVersion: 9, reason: 'x' }))).toBe('not_found');
    const hist = await ho.ok('GET', '/v1/platform/rollout/digital_receipts/history', 'u-it', undefined, { branchId: 'B1' }) as { versions: { version: number; enabled: boolean; reason: string; rolledBackFrom?: number }[] };
    expect(hist.versions.map((v) => [v.version, v.enabled, v.rolledBackFrom ?? null])).toEqual([[1, true, null], [2, false, null], [3, true, 1]]);
    expect(await ho.ok('GET', '/v1/platform/rollout/digital_receipts/decision', 'u-it', undefined, { branchId: 'B1', laneId: 'lane-7' })).toMatchObject({ on: true, source: 'branch', version: 3 });
    expect(await ho.ok('GET', '/v1/platform/rollout/digital_receipts/decision', 'u-it', undefined, { branchId: 'B1', laneId: 'lane-1' })).toMatchObject({ on: false, source: 'lane' });
    expect(await ho.ok('GET', '/v1/platform/rollout/digital_receipts/decision', 'u-it', undefined, { branchId: 'B2' })).toMatchObject({ on: false, source: 'never_set' });
    const board = await ho.ok('GET', '/v1/platform/rollout', 'u-owner') as { switches: { key: string; laneId: string | null; enabled: boolean; version: number }[] };
    expect(board.switches.map((s) => [s.key, s.laneId, s.enabled, s.version])).toEqual([['digital_receipts', null, true, 3], ['digital_receipts', 'lane-1', false, 1], ['self_checkout', 'lane-7', true, 1]]);

    // A HIGH-IMPACT switch (offline limits): refused without the owner's approval; the maker cannot approve their own;
    // the owner's approval of exactly this change lets it through, named on the version.
    const hi = { branchId: 'B1', laneId: 'lane-7', enabled: true, reason: 'offline card limit trial on lane 7' };
    expect(codeOf(await put('u-it', 'offline.card_limit_trial', hi))).toBe('high_impact_change_needs_owner_approval');
    const ask = await askForApproval(ho.h, ho.tenantId, 'u-it', { kind: 'flag_change', subjectRef: 'rollout:offline.card_limit_trial:B1:lane-7', details: actionDetails(hi, { key: 'offline.card_limit_trial' }) });
    expect(ask.status, JSON.stringify(ask.body)).toBe(201);
    const requestId = (ask.body as { requestId: string }).requestId;
    expect((await decide(ho.h, ho.tenantId, 'u-it', requestId)).status).toBeGreaterThanOrEqual(400); // never the maker's own
    expect((await decide(ho.h, ho.tenantId, 'u-owner', requestId)).status).toBe(201);
    const approved = await ho.ok('PUT', '/v1/platform/rollout/offline.card_limit_trial', 'u-it', { ...hi, approvalId: requestId });
    expect(approved).toMatchObject({ highImpact: true, change: { approvedBy: 'u-owner', approvalId: requestId, version: 1 } });
    // One approval allows one action.
    expect((await put('u-it', 'offline.card_limit_trial', { ...hi, enabled: false, reason: 'again', approvalId: requestId })).status).toBeGreaterThanOrEqual(400);

    // ── The signed store pack carries B1's switches (and only B1's) ──
    const pack = await ho.call('GET', '/v1/store-packs/B1', 'u-box', undefined, undefined, 'B1');
    expect(pack.status, JSON.stringify(pack.body)).toBe(200);
    const rollout = (pack.body as { sections: { rollout: { format: string; branchId: string; switches: { key: string }[] } } }).sections.rollout;
    expect(rollout).toMatchObject({ format: 'sre-rollout/1', branchId: 'B1' });
    expect(rollout.switches.map((s) => s.key)).toEqual(['digital_receipts', 'offline.card_limit_trial', 'self_checkout']);

    // ── The store computer serves the till its lane's switches, with NO head office anywhere, across its cold restart ──
    const laneOf = async (box: Box): Promise<Record<string, unknown>> => {
      const html = await (await fetch(`http://127.0.0.1:${box.edge.screens!.port}/pos/`)).text();
      return JSON.parse(/<script>window\.posLane = ([\s\S]*?);<\/script>/.exec(html)![1]!) as Record<string, unknown>;
    };
    const lane7 = await startBox({ tenantId: ho.tenantId, people: [], pack: { ...storePack('B1'), rollout }, env: { EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_LANE_ID: 'lane-7' } });
    boxes.push(lane7);
    await lane7.restartCold();
    const at7 = posRolloutOf((await laneOf(lane7))['rollout']);
    expect([at7.known, at7.on, at7.isOn('self_checkout'), at7.isOn('digital_receipts'), at7.isOn('rfid')]).toEqual([true, ['digital_receipts', 'offline.card_limit_trial', 'self_checkout'], true, true, false]);
    const lane1 = await startBox({ tenantId: ho.tenantId, people: [], pack: { ...storePack('B1'), rollout }, env: { EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_LANE_ID: 'lane-1' } });
    boxes.push(lane1);
    const at1 = posRolloutOf((await laneOf(lane1))['rollout']);
    expect([at1.isOn('self_checkout'), at1.isOn('digital_receipts')]).toEqual([false, false]);
    // A pack built before rollout: the till is "not told" — every trial feature off, and the reason said.
    const old = await startBox({ tenantId: ho.tenantId, people: [], pack: storePack('B1'), env: { EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_LANE_ID: 'lane-7' } });
    boxes.push(old);
    const notTold = posRolloutOf((await laneOf(old))['rollout']);
    expect([notTold.known, notTold.isOn('self_checkout'), notTold.why]).toEqual([false, false, expect.stringContaining('no rollout switches')]);
  }, 120_000);
});
