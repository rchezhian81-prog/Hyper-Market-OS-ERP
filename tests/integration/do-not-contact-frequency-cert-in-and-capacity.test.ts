import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { recordingTransport } from '../../packages/notifications/src/index';
import { opsMessagingSweep } from '../../services/api/src/ops-messaging-adapters';

// OB-288 P5 — messaging and operations controls, through the real routes (synthetic data):
//   • M31-FR-04: the STORED do-not-contact register — added and lifted with a reason (append-only), read by the send guard
//     (a caller's "not suppressed" cannot clear it), refused at enqueue, WITHHELD at send when added after queuing, and
//     excluded by name from a campaign;
//   • M31-FR-03: the owner's frequency cap checked at ENQUEUE and again at SEND (a lowered cap holds what waits);
//   • M35-FR-04: the CERT-In six-hour clock on a security incident — classified by a named person with the reason, due,
//     OVERDUE raised to the owners once, reported (in time or late) — and the capacity report against §32 (2× the measured
//     peak with 12 months' growth), "not set" until a person enters the growth and what is provisioned.
// In memory and — with DATABASE_URL — on real PostgreSQL, with a cold restart.

const backings = useRestartableBackings();
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

describe.each(backings)('do-not-contact, frequency cap, CERT-In clock and capacity (M31-FR-03/04 · M35-FR-04) — on $name', ({ harness }) => {
  it('the register is stored and absolute; the cap holds at enqueue and at send; a restart reads the same', async () => {
    const base = harness();
    const transport = recordingTransport();
    const h: ApiHarness = apiHarness({ store: base.store, notificationTransport: transport });
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-cash', 'cashier');
    const req = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown) =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }) });
    expect((await req('POST', '/v1/notifications/templates/offer', 'u-owner', { purpose: 'marketing', channel: 'sms', body: 'Hello {name}, offers this week.' })).status).toBe(201);
    expect((await req('POST', '/v1/notifications/templates/offer/approval', 'u-mgr', { version: 1 })).status).toBe(200);
    expect((await req('POST', '/v1/notifications/budget', 'u-owner', { capMinor: 100_000, costMinorByChannel: { sms: 25 } })).status).toBe(201);
    for (const c of ['C-1', 'C-2', 'C-3']) expect((await req('POST', `/v1/customers/${c}/consent`, 'u-owner', { purpose: 'marketing', channel: 'sms', given: true, evidence: 'ticked the box at the desk' })).status).toBeLessThan(300);
    const enqueue = (id: string, customerId: string) => req('POST', `/v1/notifications/queue/${id}`, 'u-owner', { customerId, purpose: 'marketing', channel: 'sms', templateId: 'offer', values: { name: 'Meena' } });

    // ── M31-FR-03: no cap set → marketing is refused at enqueue; with a cap of one a week, the second is refused.
    expect(codeOf(await enqueue('m-0', 'C-1'))).toBe('frequency_cap_not_set');
    expect((await req('PUT', '/v1/service/campaigns/frequency-policy', 'u-owner', { capPerWindow: 2, windowDays: 7 })).status).toBe(200);
    expect((await enqueue('m-1', 'C-1')).status).toBe(201);
    expect((await enqueue('m-2', 'C-1')).status).toBe(201);
    expect(codeOf(await enqueue('m-3', 'C-1'))).toBe('frequency_cap_reached');
    // … and at SEND: the owner lowers the cap to one — the second waiting message is HELD (kept, pending, with the reason).
    expect((await req('PUT', '/v1/service/campaigns/frequency-policy', 'u-owner', { capPerWindow: 1, windowDays: 7 })).status).toBe(200);

    // ── M31-FR-04: the register. A cashier cannot add; a reason and a source are needed; the store manager adds it.
    expect((await req('POST', '/v1/notifications/suppressions/C-2', 'u-cash', { channel: 'sms', reason: 'asked at the desk', source: 'customer_request' })).status).toBe(403);
    expect(codeOf(await req('POST', '/v1/notifications/suppressions/C-2', 'u-mgr', { channel: 'sms' }))).toBe('not_readable_as_a_suppression');
    expect((await enqueue('m-c2', 'C-2')).status).toBe(201); // queued BEFORE the customer asked
    expect((await req('POST', '/v1/notifications/suppressions/C-2', 'u-mgr', { channel: 'all', reason: 'asked never to be contacted', source: 'customer_request' })).status).toBe(201);
    expect(codeOf(await enqueue('m-c2b', 'C-2'))).toBe('customer_suppressed');
    // The send guard reads the register: a caller saying "not suppressed" cannot clear it.
    const guard = await req('POST', '/v1/notifications/can-send', 'u-owner', { customerId: 'C-2', purpose: 'marketing', channel: 'sms', templateApproved: true, suppressed: false, consent: { grants: [{ purpose: 'marketing', channel: 'sms', grantedAt: '2026-01-01T00:00:00Z' }] } });
    expect(guard.body).toMatchObject({ allowed: false, reason: 'suppressed', suppressionFrom: 'the do-not-contact register' });

    // The send: C-1's first goes, its second is held by the lowered cap, C-2's (queued before) is WITHHELD — never sent.
    const pass = (await req('POST', '/v1/notifications/queue/drain', 'u-owner', {})).body as { outcome: { id: string; result: string; detail: string }[] };
    const result = Object.fromEntries(pass.outcome.map((o) => [o.id, o.result]));
    expect(result).toEqual({ 'm-1': 'delivered', 'm-2': 'held', 'm-c2': 'withheld' });
    expect(pass.outcome.find((o) => o.id === 'm-2')!.detail).toMatch(/frequency_cap/);
    expect(transport.sent.map((m) => m.messageId)).toEqual(['m-1']);

    // A campaign excludes the suppressed recipient by name.
    const plan = await req('POST', '/v1/service/campaigns/cmp-1/plan', 'u-owner', { purpose: 'marketing', channel: 'sms', templateId: 'offer', templateApproved: true, containsPromotion: true, audience: ['C-2', 'C-3'] });
    expect(plan.body).toMatchObject({ excludedByReason: { do_not_contact: 1 } });

    // Lifted only with a reason; the entry stays on the record.
    expect(codeOf(await req('POST', '/v1/notifications/suppressions/C-3/lift', 'u-mgr', { channel: 'sms', reason: 'x' }))).toBe('not_suppressed');
    expect((await req('POST', '/v1/notifications/suppressions/C-2/lift', 'u-mgr', { channel: 'all', reason: 'the customer asked to hear about offers again, in writing' })).status).toBe(200);
    const reg = (await harness(h).request({ method: 'GET', path: '/v1/notifications/suppressions', userId: 'u-owner', tenantId: T })).body as { suppressed: unknown[]; facts: { change: string }[] };
    expect(reg.suppressed).toEqual([]);
    expect(reg.facts.map((f) => f.change)).toEqual(['suppressed', 'lifted']);
  }, 120_000);

  it('the CERT-In clock runs six hours from when the incident was noticed; overdue is raised once; the capacity report says what is not set', async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    const req = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown) =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }) });
    const now = Date.now();
    const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
    for (const id of ['INC-1', 'INC-2', 'INC-3']) expect((await req('POST', `/v1/platform/incidents/${id}`, 'u-owner', { title: `Synthetic ${id}`, severity: 'sev1', summary: 'unauthorised sign-in attempts on the office PC (synthetic)', alertIds: [] })).status).toBe(201);
    const classify = (id: string, body: Record<string, unknown>, who = 'u-owner') => req('POST', `/v1/platform/incidents/${id}/cert-in`, who, body);
    expect((await classify('INC-1', { reportable: true, category: 'unauthorised access', reason: 'x', noticedAt: iso(0) }, 'u-mgr')).status).toBe(403);
    expect(codeOf(await classify('INC-9', { reportable: true, category: 'c', reason: 'r', noticedAt: iso(0) }))).toBe('not_found');
    expect(codeOf(await classify('INC-1', { reportable: true, category: 'c', reason: 'r', noticedAt: new Date(now + 3_600_000).toISOString() }))).toBe('noticed_in_the_future');
    // INC-1 noticed 7 hours ago: OVERDUE. INC-2 noticed 1 hour ago: due. INC-3 is not reportable, with the reason.
    expect((await classify('INC-1', { reportable: true, category: 'unauthorised access to a system', reason: 'a staff password was used from outside', noticedAt: iso(7 * 3_600_000) })).status).toBe(201);
    expect((await classify('INC-2', { reportable: true, category: 'malicious code', reason: 'the antivirus quarantined a file', noticedAt: iso(3_600_000) })).status).toBe(201);
    expect((await classify('INC-3', { reportable: false, category: 'lost badge', reason: 'no system or data was touched', noticedAt: iso(3_600_000) })).status).toBe(201);
    expect(codeOf(await classify('INC-3', { reportable: true, category: 'lost badge', reason: 'changed my mind', noticedAt: iso(3_600_000) }))).toBe('cert_in_already_classified');
    const board = (await req('GET', '/v1/platform/cert-in', 'u-mgr')).body as { clocks: { incidentId: string; state: string; minutesLeft: number | null }[]; overdue: number; due: number };
    expect(Object.fromEntries(board.clocks.map((c) => [c.incidentId, c.state]))).toEqual({ 'INC-1': 'overdue', 'INC-2': 'due', 'INC-3': 'not_reportable' });
    expect(board.clocks.find((c) => c.incidentId === 'INC-2')!.minutesLeft).toBeGreaterThan(290);
    // The alert worker's pass raises the overdue one to the owners — once.
    const sweep = opsMessagingSweep({ store: h.store, now: () => new Date().toISOString() });
    expect(await sweep(T, new Date().toISOString())).toBe(1);
    expect(await sweep(T, new Date().toISOString())).toBe(0);
    expect(JSON.stringify((await req('GET', '/v1/platform/alerts', 'u-owner')).body)).toContain('cert-in-overdue:INC-1');
    // Reported: INC-1 late, INC-2 in time; a not-reportable one cannot be "reported".
    expect((await req('POST', '/v1/platform/incidents/INC-1/cert-in/report', 'u-owner', { reportedAt: iso(0), reference: 'CERTIN-SYN-1', channel: 'email' })).body).toMatchObject({ clock: { state: 'reported_late' } });
    expect((await req('POST', '/v1/platform/incidents/INC-2/cert-in/report', 'u-owner', { reportedAt: iso(0), reference: 'CERTIN-SYN-2', channel: 'email' })).body).toMatchObject({ clock: { state: 'reported_in_time' } });
    expect(codeOf(await req('POST', '/v1/platform/incidents/INC-3/cert-in/report', 'u-owner', { reportedAt: iso(0), reference: 'X', channel: 'email' }))).toBe('cert_in_not_reportable');

    // ── Capacity: measured from the shop's own records; nothing traded → not known; the plan's numbers "not set".
    const cap = (await req('GET', '/v1/platform/capacity-report', 'u-mgr')).body as { rows: { measure: string; measuredPeak: number | null; verdict: string; why: string }[]; notKnown: string[] };
    expect(cap.rows.find((r) => r.measure === 'bills_per_day')).toMatchObject({ measuredPeak: null, verdict: 'not_known' });
    expect(cap.rows.find((r) => r.measure === 'people_with_access')!.measuredPeak).toBe(2);
    // Two bills on one day, one the next → busiest day is 2; twice that is 4; 20% growth → 5 (rounded up); provisioned 4 → SHORT.
    for (const [id, day, at] of [['S1', '2026-10-20', '2026-10-20T04:00:00.000Z'], ['S2', '2026-10-20', '2026-10-20T04:10:00.000Z'], ['S3', '2026-10-21', '2026-10-21T05:00:00.000Z']] as const) {
      const sale = { saleId: id, receiptNumber: `R-${id}`, laneId: 'lane-1', cashierId: 'u-owner', tradingDay: day, committedAt: at, totalMinor: 100, currency: 'INR', packVersion: 1, lines: [{ productId: 'P1', quantityMinor: 1, uom: 'each', unitPriceMinor: 100, lineTotalMinor: 100, taxRateBps: 0 }], tenders: [{ kind: 'cash', amountMinor: 100 }] };
      expect((await req('POST', '/v1/sales', 'u-owner', sale)).status).toBe(202);
    }
    expect((await req('PUT', '/v1/platform/capacity-plan', 'u-mgr', { growthPercentPerYear: 20, provisioned: {} })).status).toBe(403);
    expect(codeOf(await req('PUT', '/v1/platform/capacity-plan', 'u-owner', { growthPercentPerYear: -5, provisioned: {} }))).toBe('not_readable_as_a_capacity_plan');
    expect((await req('PUT', '/v1/platform/capacity-plan', 'u-owner', { growthPercentPerYear: 20, provisioned: { bills_per_day: 4, lanes: 10 } })).status).toBe(200);
    const after = (await harness(h).request({ method: 'GET', path: '/v1/platform/capacity-report', userId: 'u-owner', tenantId: T })).body as { rows: { measure: string; measuredPeak: number | null; twicePeak: number | null; target12Months: number | null; verdict: string }[]; short: string[] };
    expect(after.rows.find((r) => r.measure === 'bills_per_day')).toMatchObject({ measuredPeak: 2, twicePeak: 4, target12Months: 5, verdict: 'short' });
    expect(after.rows.find((r) => r.measure === 'lanes')).toMatchObject({ measuredPeak: 1, target12Months: 3, verdict: 'ok' });
    expect(after.rows.find((r) => r.measure === 'bills_per_peak_hour')).toMatchObject({ measuredPeak: 2, verdict: 'not_known' }); // provisioned not set
    expect(after.short).toEqual(['bills_per_day']);
  }, 120_000);
});
