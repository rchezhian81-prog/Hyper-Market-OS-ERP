// Audit observations from the 30 Sep 2026 store-workflow audit (see README.md in this folder).
//
// F12 is FIXED (SP-1): its case below is now the intended-behaviour REGRESSION — a kernel conflict is a
// visible rejected exception, never acknowledged as delivered. F11's two cases still assert the DEFECT
// (a pass confirms it) until SP-2 inverts them.
import { describe, expect, it } from 'vitest';
import { apiHarness } from '../support/api-harness';
import { httpTransport } from '../../edge/sync-agent/src/http-transport';
import { SyncAgent } from '../../edge/sync-agent/src/agent';
import { makeEvent } from '../../packages/contracts/src/event';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/ledger';
import { createManagerSession } from '../../apps/web-erp/src/manager-session';
import { bootManager } from '../../apps/web-erp/src/browser-entry';
import { requestApproval } from '../../packages/approvals/src/approvals';
import { makeTradingDayRule } from '../../packages/calendar/src/trading-day';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AT = '2026-08-07T10:00:00.000Z';

describe('audit observations: current sync and manager defects', () => {
  it('F12 FIXED — an event the real authenticated kernel refused as a conflicting request is a visible exception, never acknowledged', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    const token = h.idp.issue({ sub: 'u-owner', tenantId: TENANT });
    const body = { movementId: 'original', productId: 'P1', locationId: 'S1', kind: 'received', quantityMinor: 10, uom: 'EA', occurredAt: AT, enteredBy: 'u-owner' };
    const original = await h.raw({ method: 'POST', path: '/v1/inventory/movements', token, idempotencyKey: 'collision', body });
    expect(original.status).toBe(202);
    const observed: { status: number; body: unknown }[] = [];
    const fetchFn: typeof globalThis.fetch = async (url, init) => {
      const headers = new Headers(init?.headers);
      const response = await h.raw({
        method: 'POST', path: new URL(String(url)).pathname,
        token: headers.get('authorization')!.slice(7),
        idempotencyKey: headers.get('idempotency-key')!,
        body: JSON.parse(String(init?.body)),
      });
      observed.push(response);
      return new Response(JSON.stringify(response.body), { status: response.status });
    };
    const outbox = new SyncOutbox();
    outbox.enqueue(makeEvent({ id: 'different', type: 'InventoryMoved', source: 'edge', occurredAt: AT, idempotencyKey: 'collision', payload: { ...body, movementId: 'different', quantityMinor: 99 } }));
    const agent = new SyncAgent(outbox, httpTransport({ baseUrl: 'https://audit.test', token, fetch: fetchFn }));
    const result = await agent.drain({ at: AT });
    expect(observed[0]).toMatchObject({ status: 409, body: { error: { code: 'idempotency_key_reused', wasItSaved: 'not_saved' } } });
    // The repaired behaviour: nothing acknowledged, the conflicting event dead-lettered with a reason that
    // names the conflict, and the cloud's record untouched (the ORIGINAL 10 stands; the 99 never applied).
    expect(result.acknowledged).toBe(0);
    expect(result.deadLettered).toBe(1);
    expect(outbox.find('collision')?.state).toBe('dead_letter');
    expect(outbox.deadLetters()).toHaveLength(1);
    expect(outbox.deadLetters()[0]?.reason).toContain('idempotency_key_reused');
    expect(outbox.deadLetters()[0]?.reason).toMatch(/^conflict: /);
    const availability = await h.request({ method: 'GET', path: '/v1/inventory/availability', userId: 'u-owner', tenantId: TENANT });
    expect(availability.body).toMatchObject({ rows: [{ onHandMinor: 10 }] });
    // And the SAME payload sent again under the SAME key is the kernel's replay of the first answer — accepted once.
    const replay = new SyncOutbox();
    replay.enqueue(makeEvent({ id: 'same', type: 'InventoryMoved', source: 'edge', occurredAt: AT, idempotencyKey: 'collision', payload: body }));
    const again = await new SyncAgent(replay, httpTransport({ baseUrl: 'https://audit.test', token, fetch: fetchFn })).drain({ at: AT });
    expect(again.acknowledged).toBe(1);
    expect(observed[1]).toMatchObject({ status: 202 });
  });

  it('returns approved without changing the register, appending an audit record, or queuing any decision', () => {
    const request = requestApproval({ id: 'a1', subjectType: 'refund', subjectRef: 'r1', requestedBy: 'cashier', branchId: 'b1', value: { minor: 100, currency: 'INR' } });
    const ledger = new Ledger(new InMemoryLedgerStore());
    const outbox = new SyncOutbox();
    const session = createManagerSession({ storeId: 's1', branchId: 'b1', tradingDay: '2026-08-07', tradingDayRule: makeTradingDayRule('02:00'), manager: { userId: 'manager', branchScope: ['b1'], authorityLimit: null }, currency: 'INR', warehouseId: 's1', countApprovalThresholdMinor: 100_000 }, {
      approvals: () => ({ known: true, requests: [request] }),
      openExceptions: () => ({ known: true, items: [] }),
      unsentItems: () => ({ known: true, items: [] }),
      tasks: () => ({ known: true, items: [] }),
      productValue: () => ({ known: true, valuePerUnitMinor: 100 }),
    }, ledger, outbox);
    expect(session.decideApproval({ requestId: 'a1', decision: 'approved', reasonCode: 'within_policy', decidedAt: AT })).toMatchObject({ ok: true, request: { status: 'approved' } });
    expect(ledger.entries()).toHaveLength(0);
    expect(outbox.all()).toHaveLength(0);
    expect(request.status).toBe('pending');
    expect(session.floor().approvalsWaiting).toEqual({ known: true, count: 1 });
    expect(session.decideApproval({ requestId: 'a1', decision: 'rejected', reasonCode: 'against_policy', decidedAt: AT }).ok).toBe(true);
  });

  it('loses a manager receipt across browser boots and reports zero unsent even before the reboot', () => {
    const config = { managerId: 'manager', data: { products: [{ id: 'P1', valuePerUnitMinor: 100 }], unsentItems: [], openExceptions: [] } };
    const first = bootManager(config);
    first.receive({ grnId: 'grn-1', number: 'GRN-1', poId: null, receivedAt: AT, lines: [{ productId: 'P1', quantityMinor: 10, uom: 'EA' }] });
    expect(first.floor().unsent).toEqual({ known: true, count: 0 });
    const count = { countId: 'c1', productId: 'P1', locationId: 's1', uom: 'EA', countedMinor: 10, reasonCode: 'cycle_count', at: AT };
    expect(first.countStock(count)).toMatchObject({ counted: true, result: { expectedMinor: 10, varianceMinor: 0 } });
    const reloaded = bootManager(config);
    expect(reloaded.countStock({ ...count, countId: 'c2' })).toMatchObject({ counted: true, result: { expectedMinor: 0, varianceMinor: 10, adjusted: true } });
  });
});
