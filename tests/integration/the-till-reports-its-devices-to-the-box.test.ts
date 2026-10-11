import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { GLOBAL_FOR } from '../../edge/store-edge/src/screen-data';
import { prepareTillBox, signInAtLane, operatorHeader } from '../support/till-operator';

/**
 * **D04-FR-05 · M12-FR-04 — the till's devices report to the store computer, and the manager's Today screen names what
 * has failed; no report is "not known", never "all fine".**
 *
 * A real store computer (lane socket, disk, screens socket). Before any till reports, the manager's Today figure for till
 * devices is not known, with why. A cashier signed in at the till sends what the device adapter says (the scanner fine,
 * the printer out of paper): it is on the box's disk, and the Today figure counts one device and names it. A report with
 * no signed-in person, or one the box cannot read, is refused and records nothing. A restart keeps the last report.
 */

const KEY = ['till', 'devices', 'box', 'key'].join('-').padEnd(48, '0');
const dirs: string[] = [];
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const PACK = { managerPolicy: { userId: 'u-mgr', approvalLimitMinor: 500_000 }, lossPreventionRules: [] };
const start = async (dir: string, ready: Record<string, string>): Promise<EdgeProcess> => {
  const edge = (await startEdge({
    EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
    EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', ...ready,
  }, () => {}))!;
  stops.push(() => edge.stop());
  return edge;
};
const today = async (edge: EdgeProcess): Promise<Record<string, { known: boolean; value?: number; note?: string; why?: string }>> => {
  const html = await (await fetch(`http://127.0.0.1:${edge.screens!.port}/manager`)).text();
  const m = new RegExp(`<script>window\\.${GLOBAL_FOR.manager} = ([\\s\\S]*?);</script>`).exec(html);
  return (JSON.parse(m![1]!) as { today: Record<string, { known: boolean; value?: number; note?: string; why?: string }> }).today;
};
const report = (edge: EdgeProcess, body: unknown, token?: string) => fetch(`http://127.0.0.1:${edge.lane!.port}/lane/peripherals`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(token === undefined ? {} : operatorHeader(token)) }, body: JSON.stringify(body),
}).then((r) => r.json() as Promise<Record<string, unknown>>);

describe('D04-FR-05 — the till reports its devices; the manager sees what failed', () => {
  it('not known before any report; a signed-in report is kept and named; refusals record nothing; a restart keeps it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-till-devices-'));
    dirs.push(dir);
    const ready = await prepareTillBox({ dir, key: KEY, people: [{ userId: 'u-lanecash', displayName: 'Lane Cashier' }, { userId: 'u-mgr', displayName: 'Manager', manager: true }], pack: PACK });
    let edge = await start(dir, ready);
    expect((await today(edge))['tillDevices']).toEqual({ known: false, why: 'no till has reported its scanner, printer, scale, drawer or card machine yet' });

    const devices = [{ kind: 'scanner', state: 'ok' }, { kind: 'printer', state: 'failed', detail: 'paper out' }, { kind: 'card_terminal', state: 'degraded', detail: 'slow to answer' }];
    // Nobody signed in: refused, nothing kept.
    expect(await report(edge, { devices })).toMatchObject({ recorded: false });
    const token = await signInAtLane(edge.lane!.port, 'u-lanecash');
    // A device the box does not know, or a state it cannot read: refused, nothing kept.
    expect(await report(edge, { devices: [{ kind: 'toaster', state: 'ok' }] }, token)).toMatchObject({ recorded: false, refusedBecause: 'devices_not_readable' });
    expect(await report(edge, { devices: [{ kind: 'printer', state: 'smoking' }] }, token)).toMatchObject({ recorded: false, refusedBecause: 'devices_not_readable' });
    expect((await today(edge))['tillDevices']).toMatchObject({ known: false });

    expect(await report(edge, { devices }, token)).toMatchObject({ recorded: true, report: { laneId: 'lane-1', reportedBy: 'u-lanecash', devices } });
    const fig = (await today(edge))['tillDevices']!;
    expect(fig).toMatchObject({ known: true, value: 2 });
    expect(fig.note).toBe('lane-1: printer has failed — paper out; lane-1: card terminal is not working properly — slow to answer');

    await edge.stop();
    stops.splice(0);
    edge = await start(dir, ready);
    expect((await today(edge))['tillDevices']).toMatchObject({ known: true, value: 2 });

    // The printer is fixed: the next report is what counts.
    const token2 = await signInAtLane(edge.lane!.port, 'u-lanecash');
    expect(await report(edge, { devices: [{ kind: 'scanner', state: 'ok' }, { kind: 'printer', state: 'ok' }, { kind: 'card_terminal', state: 'ok' }] }, token2)).toMatchObject({ recorded: true });
    expect((await today(edge))['tillDevices']).toMatchObject({ known: true, value: 0, note: expect.stringMatching(/^every device reported working/) });
  }, 60_000);
});
