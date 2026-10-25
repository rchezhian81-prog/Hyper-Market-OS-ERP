import { describe, it, expect } from 'vitest';
import { useRestartableBackings } from '../support/p3-backings';
import { fulfilmentShop, codeOf, OWNER, DISPATCHER, CASHIER, STORE_ID, DOORS } from '../support/fulfilment-shop';

// OB-369 (owner, 24–25 Oct 2026, in writing): "the delivery desk may enter it after the customer phones or after a set
// wait, with the reason recorded". An APP customer's till delivery (OB-352) waits for them to choose in the app; through the
// production routes, in memory and — with DATABASE_URL — on real PostgreSQL, with a cold restart:
//
//   • the desk still cannot simply type it — refused by name, and told the two ways;
//   • the customer PHONED: the desk enters it with a note of the call — booked, the reason recorded on the job and on the
//     audit trail; a phone call with no note is refused;
//   • the owner's WAIT is "not set" until he enters it — "after the wait" is then refused by name; once he sets it (his
//     delivery numbers, owner only), a job inside the wait is refused (with when it ends) and one past it is entered;
//   • the list says, per app job, that the desk may enter it after a call, and whether the wait has passed;
//   • a restart reads it all back. A cashier is refused (403).

const backings = useRestartableBackings();
type Res = { status: number; body: unknown };

describe.each(backings)('the desk enters an app customer\'s till delivery after a call or the owner\'s wait (OB-369) — on $name', ({ harness }) => {
  it('refused bare; after a phone call with its note; "wait not set" refused; inside the wait refused; past it entered; a restart', async () => {
    const h = harness();
    const shop = await fulfilmentShop(h);
    const slot = shop.slots[2]!;

    // A member whose membership is tied to c-1's app account (seen on the phone at the desk).
    const MOBILE = '98400' + '66666';
    const memberRef = (await shop.ok('POST', '/v1/loyalty/members', OWNER, { mobile: MOBILE, consent: true, verifiedHow: 'seen_on_phone' }))['memberRef'] as string;
    await shop.ok('POST', '/v1/loyalty/members/app-link', OWNER, { mobile: MOBILE, appCustomerRef: 'c-1', verifiedHow: 'seen_on_phone' });

    // Three bills for that member marked for delivery: two just now, one rung three hours ago.
    const bill = (saleId: string, committedAt: string) => ({
      saleId, receiptNumber: `L1-${saleId}`, laneId: 'lane-1', locationId: STORE_ID, cashierId: CASHIER, tradingDay: committedAt.slice(0, 10), committedAt,
      totalMinor: 80_00, currency: 'INR', packVersion: 1, lines: [{ productId: 'RICE', quantityMinor: 1, uom: 'ea', unitPriceMinor: 80_00, lineTotalMinor: 80_00 }],
      tenders: [{ kind: 'cash', amountMinor: 80_00 }], delivery: { requested: true, feeMinor: 0 }, customerRef: memberRef,
    });
    const now = new Date().toISOString();
    const earlier = new Date(Date.now() - 3 * 3_600_000).toISOString();
    for (const [id, at] of [['S-PHONE', now], ['S-SOON', now], ['S-LATE', earlier]] as const) {
      const sold = await shop.call('POST', '/v1/sales', CASHIER, bill(id, at));
      expect(sold.status, JSON.stringify(sold.body)).toBe(202);
    }
    const desk = (orderId: string, body: Record<string, unknown>, who = DISPATCHER): Promise<Res> =>
      shop.call('POST', `/v1/delivery/till-jobs/${orderId}/delivery`, who, { slotStartsAt: slot.startsAt, deliveryLocation: DOORS.mid, ...body });

    // ── The wait is "not set": the list says so; the desk may enter after a call, not after a wait.
    const list0 = await shop.ok('GET', '/v1/delivery/till-jobs', DISPATCHER, undefined, { storeId: STORE_ID, day: shop.runDate });
    expect(list0['appWait']).toMatchObject({ state: 'not_set' });
    const late0 = (list0['jobs'] as { orderId: string; status: string; deskMayEnter?: unknown }[]).find((j) => j.orderId === 'till-S-LATE')!;
    expect(late0).toMatchObject({ status: 'waiting_for_customer_app', deskMayEnter: { afterPhoneCall: true, afterWait: false, waitEndsAt: null } });

    // ── Bare: refused, as before. A call with no note, a reason that is not one, a cashier: refused. Nothing booked.
    expect(codeOf(await desk('till-S-PHONE', {}))).toBe('customer_chooses_in_the_app');
    expect(codeOf(await desk('till-S-PHONE', { appCustomer: { because: 'customer_phoned' } }))).toBe('not_readable_as_an_app_customer_reason');
    expect(codeOf(await desk('till-S-PHONE', { appCustomer: { because: 'felt_like_it', note: 'no reason at all' } }))).toBe('not_readable_as_an_app_customer_reason');
    expect((await desk('till-S-PHONE', { appCustomer: { because: 'customer_phoned', note: 'phoned at 11:05' } }, CASHIER)).status).toBe(403);
    expect(codeOf(await desk('till-S-LATE', { appCustomer: { because: 'wait_passed' } }))).toBe('app_choice_wait_not_set');

    // ── The customer phoned: entered, the reason recorded.
    const phoned = await desk('till-S-PHONE', { appCustomer: { because: 'customer_phoned', note: 'Customer phoned at 11:05, gave the address' }, landmark: 'near the school' });
    expect(phoned.status, JSON.stringify(phoned.body)).toBe(201);
    expect(phoned.body).toMatchObject({ job: { status: 'booked', given: { by: 'delivery_desk', personId: DISPATCHER, forAppCustomer: { because: 'customer_phoned', note: 'Customer phoned at 11:05, gave the address' } } } });
    // The customer's app shows it booked; they cannot choose it again.
    const mine = await shop.ok('GET', '/v1/me/till-deliveries', 'c-1');
    expect((mine['deliveries'] as { orderId: string; status: string }[]).find((d) => d.orderId === 'till-S-PHONE')).toMatchObject({ status: 'booked' });

    // ── The owner sets the wait (2 hours) — his number, not the dispatcher's.
    expect((await shop.call('POST', '/v1/delivery/controls', DISPATCHER, { appChoiceWaitHours: 2 })).status).toBe(403);
    expect((await shop.call('POST', '/v1/delivery/controls', OWNER, { appChoiceWaitHours: 0 })).status).toBe(400);
    const set = await shop.ok('POST', '/v1/delivery/controls', OWNER, { appChoiceWaitHours: 2 });
    expect((set['numbers'] as { key: string; value: unknown; state: string }[]).find((n) => n.key === 'appChoiceWaitHours')).toMatchObject({ value: 2, state: 'set' });
    const list1 = await shop.ok('GET', '/v1/delivery/till-jobs', DISPATCHER, undefined, { storeId: STORE_ID, day: shop.runDate });
    expect(list1['appWait']).toMatchObject({ state: 'set', hours: 2 });
    const byId = new Map((list1['jobs'] as { orderId: string; deskMayEnter?: { afterWait: boolean; waitEndsAt: string } }[]).map((j) => [j.orderId, j]));
    expect(byId.get('till-S-LATE')!.deskMayEnter).toMatchObject({ afterWait: true });
    expect(byId.get('till-S-SOON')!.deskMayEnter).toMatchObject({ afterWait: false });

    // Inside the wait: refused with when it ends. Past it: entered, the wait recorded.
    const soon = await desk('till-S-SOON', { appCustomer: { because: 'wait_passed' } });
    expect(codeOf(soon)).toBe('app_choice_wait_not_passed');
    expect(JSON.stringify(soon.body)).toContain(byId.get('till-S-SOON')!.deskMayEnter!.waitEndsAt);
    const late = await desk('till-S-LATE', { appCustomer: { because: 'wait_passed', note: 'no choice in the app' } });
    expect(late.status, JSON.stringify(late.body)).toBe(201);
    expect(late.body).toMatchObject({ job: { status: 'booked', given: { forAppCustomer: { because: 'wait_passed', waitHours: 2, note: 'no choice in the app' } } } });

    // A customer with no app is entered without a reason — and a reason for them is refused (it would say something untrue).
    const noApp = await shop.call('POST', '/v1/sales', CASHIER, { ...bill('S-NOAPP', now), customerRef: undefined });
    expect(noApp.status).toBe(202);
    expect(codeOf(await desk('till-S-NOAPP', { appCustomer: { because: 'customer_phoned', note: 'phoned at noon' } }))).toBe('not_an_app_customer');

    // ── COLD RESTART: the reasons read back from the records.
    const again = harness(h);
    const after = (await again.request({ method: 'GET', path: '/v1/delivery/till-jobs', userId: DISPATCHER, tenantId: shop.t, query: { storeId: STORE_ID } })).body as { jobs: { orderId: string; status: string; given: { forAppCustomer?: { because: string } } | null }[]; appWait: { state: string } };
    const reasons = Object.fromEntries(after.jobs.map((j) => [j.orderId, j.given?.forAppCustomer?.because ?? j.status]));
    expect(reasons).toMatchObject({ 'till-S-PHONE': 'customer_phoned', 'till-S-LATE': 'wait_passed', 'till-S-SOON': 'waiting_for_customer_app' });
    expect(after.appWait).toMatchObject({ state: 'set' });
  }, 120_000);
});
