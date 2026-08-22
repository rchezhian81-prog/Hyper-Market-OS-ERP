import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Service-desk cases & SLA clocks, end to end (M21-FR-04, API-06). Control by exception (P-03): a case
// breaching its SLA must surface. Two clocks matter and a single "SLA met" number hides the one customers
// feel — FIRST RESPONSE (how long before a human replied; does not pause for the customer) and RESOLUTION
// (pauses while the shop waits on the customer). Gated service.case.manage to act, service.case.read to see.
//
// The SLA *breach* numerics need a case older than its target — the engine's own unit tests cover that with
// injected clocks. Through the live API the clock is the real one, so this proves the WIRING: the
// lifecycle, both clocks returned, the within/met states of a fresh case, the guards, gating and restart.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const open = (h: ApiHarness, u: string, id: string, body: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: `/v1/service/cases/${id}`, userId: u, tenantId: A, idempotencyKey: key ?? `open-${id}`, body });
const respond = (h: ApiHarness, u: string, id: string, key?: string) =>
  h.request({ method: 'POST', path: `/v1/service/cases/${id}/first-response`, userId: u, tenantId: A, idempotencyKey: key ?? `resp-${id}`, body: {} });
const resolve = (h: ApiHarness, u: string, id: string, body: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: `/v1/service/cases/${id}/resolution`, userId: u, tenantId: A, idempotencyKey: key ?? `res-${id}`, body });
const sla = (h: ApiHarness, u: string, id: string) =>
  h.request({ method: 'GET', path: `/v1/service/cases/${id}/sla`, userId: u, tenantId: A });
const listCases = (h: ApiHarness, u: string, breached = false) =>
  h.request({ method: 'GET', path: '/v1/service/cases', userId: u, tenantId: A, ...(breached ? { query: { breached: 'true' } } : {}) });

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
type Sla = { status: string; targetMinutes: number; shouldEscalate: boolean };
type SlaBody = { state: string; firstResponse: Sla; resolution: Sla };

const CASE = { kind: 'complaint', customerRef: 'c1', priority: 'urgent', summary: 'delivery arrived damaged', assignedTo: 'u-agent' };

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager'); // service.case.manage + read
  await h.provisionRole(A, 'u-cash', 'cashier');       // neither
  return h;
}

describe('service desk: two SLA clocks over the case lifecycle (M21-FR-04)', () => {
  it('opens a case, records the first reply, resolves it — both clocks reported at each step', async () => {
    const h = await cast();
    expect((await open(h, 'u-mgr', 'k1', CASE)).status).toBe(201);

    // A fresh case is within both clocks, and the urgent first-response target is 30 min (the default).
    const s0 = (await sla(h, 'u-owner', 'k1')).body as SlaBody;
    expect(s0).toMatchObject({ state: 'open' });
    expect(s0.firstResponse).toMatchObject({ status: 'within', targetMinutes: 30, shouldEscalate: false });
    expect(s0.resolution).toMatchObject({ status: 'within', targetMinutes: 240 });

    // The human replies — the first-response clock is met (replied at once).
    const resp = await respond(h, 'u-mgr', 'k1');
    expect(resp.status).toBe(200);
    expect((resp.body as { sla: { firstResponse: Sla } }).sla.firstResponse.status).toBe('met');

    // Resolve it — the resolution clock is met; the paused customer minutes flow through.
    const res = await resolve(h, 'u-mgr', 'k1', { resolution: 'replacement dispatched', waitingOnCustomerMinutes: 90 });
    expect(res.status).toBe(200);
    expect((res.body as { state: string; sla: { resolution: Sla } })).toMatchObject({ state: 'resolved' });
    expect((res.body as { sla: { resolution: Sla } }).sla.resolution.status).toBe('met');
  });

  it('guards the lifecycle: no double-open, no double-reply, no double-resolve, and 404s the unknown', async () => {
    const h = await cast();
    await open(h, 'u-mgr', 'k1', CASE);
    expect(codeOf(await open(h, 'u-mgr', 'k1', CASE, 'open-k1-b'))).toBe('case_already_open');

    await respond(h, 'u-mgr', 'k1');
    expect(codeOf(await respond(h, 'u-mgr', 'k1', 'resp-k1-b'))).toBe('already_responded');

    await resolve(h, 'u-mgr', 'k1', { resolution: 'done' });
    expect(codeOf(await resolve(h, 'u-mgr', 'k1', { resolution: 'again' }, 'res-k1-b'))).toBe('already_resolved');

    // Acting on a case that does not exist is a 404, not a guess.
    expect((await respond(h, 'u-mgr', 'ghost')).status).toBe(404);
    expect((await resolve(h, 'u-mgr', 'ghost', { resolution: 'x' })).status).toBe(404);
    // Malformed open / resolution.
    expect(codeOf(await open(h, 'u-mgr', 'bad', { ...CASE, kind: 'nonsense' }))).toBe('not_readable_as_a_case');
    await open(h, 'u-mgr', 'k2', CASE);
    expect(codeOf(await resolve(h, 'u-mgr', 'k2', {}))).toBe('not_readable_as_a_resolution');
  });

  it('lists cases and, with ?breached=true, only those breaching a clock (none, while fresh)', async () => {
    const h = await cast();
    await open(h, 'u-mgr', 'k1', CASE);
    await open(h, 'u-mgr', 'k2', { ...CASE, priority: 'normal', customerRef: 'c2' });

    const all = (await listCases(h, 'u-owner')).body as { cases: { caseId: string }[]; count: number };
    expect(all.count).toBe(2);
    expect(all.cases.map((c) => c.caseId).sort()).toEqual(['k1', 'k2']);

    // Nothing is breaching yet — the exception queue is empty.
    expect(((await listCases(h, 'u-owner', true)).body as { count: number }).count).toBe(0);
  });

  it('is gated to service-desk staff, and the case survives a restart', async () => {
    const h = await cast();
    expect((await open(h, 'u-cash', 'x1', CASE)).status).toBe(403);
    expect((await listCases(h, 'u-cash')).status).toBe(403);

    await open(h, 'u-mgr', 'k3', CASE);
    await respond(h, 'u-mgr', 'k3');

    const restarted = apiHarness({ store: h.store });
    const s = (await sla(restarted, 'u-owner', 'k3')).body as SlaBody;
    expect(s.firstResponse.status).toBe('met'); // the reply survived the restart
  });
});
