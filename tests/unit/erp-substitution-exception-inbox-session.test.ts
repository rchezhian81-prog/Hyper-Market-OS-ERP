// The delivery-substitution exception inbox session (M19-FR-01 · Item 2 · P-03 · §28): what the queue member
// sees — every unresolved exception worst-first, who holds it, its SLA — and the three acts, each refused
// locally before any POST when the user may not, or the row is not in the state the act needs.
import { describe, it, expect } from 'vitest';
import {
  createSubExceptionInboxSession, SUB_EXCEPTION_INBOX_COPY, COPY_KEYS,
  type SubExceptionInboxPorts, type SubExceptionView, type SubExceptionWorklistData, type SubExceptionActionPort,
} from '../../apps/web-erp/src/substitution-exception-inbox-session';

const exception = (over: Partial<SubExceptionView> & Pick<SubExceptionView, 'exceptionId'>): SubExceptionView => ({
  orderId: 'ord-77', lineId: 'line-2', kind: 'refund_due', amountMinor: 12500, detail: 'substitute cheaper than ordered — refund due',
  owner: 'finance_recon_queue', state: 'open', reasonCode: 'SUB-REFUND-DUE', raisedAt: '2026-09-29T08:00:00.000Z',
  sla: { ageMinutes: 45, dueAt: '2026-09-29T10:00:00.000Z', breached: false }, ...over,
});

const WORKLIST: SubExceptionWorklistData = {
  exceptions: [
    exception({ exceptionId: 'ord-77:line-2:refund_due' }),
    exception({ exceptionId: 'ord-78:line-1:policy_short_pick', orderId: 'ord-78', lineId: 'line-1', kind: 'policy_short_pick', amountMinor: 8000, owner: 'customer_service_desk', state: 'in_progress', assignedTo: 'u-desk', proposedBy: 'u-picker', sla: { ageMinutes: 50, dueAt: '2026-09-29T08:30:00.000Z', breached: true } }),
    exception({ exceptionId: 'ord-79:line-3:above_cap_charge', orderId: 'ord-79', lineId: 'line-3', kind: 'above_cap_charge', amountMinor: 3000, state: 'in_progress', assignedTo: 'u-other' }),
    exception({ exceptionId: 'ord-80:line-1:collect_adjustment', orderId: 'ord-80', lineId: 'line-1', kind: 'collect_adjustment', amountMinor: 1000, state: 'resolved', assignedTo: 'u-desk' }),
  ],
  count: 4, atRiskMinor: 24500,
  open: { count: 3, atRiskMinor: 23500, breached: 1 },
  queues: { fulfilment_supervisor: 0, customer_service_desk: 1, finance_recon_queue: 2, duty_manager: 0 },
};

function harness(over: Partial<SubExceptionInboxPorts> = {}, userId: string | null = 'u-desk') {
  const posts: unknown[] = [];
  const port: SubExceptionActionPort = { post: async (input) => { posts.push(input); return 'done'; } };
  const session = createSubExceptionInboxSession({ userId }, {
    worklist: () => WORKLIST, mayRead: () => true, mayWork: () => true, actionPort: () => port, ...over,
  });
  return { session, posts };
}

describe('the view — every unresolved exception, worst first, with who holds it and its SLA', () => {
  it('drops resolved items, keeps the cloud order, formats money, labels kind and queue, marks breached as error', () => {
    const view = harness().session.view('en');
    expect(view.rows.map((r) => r.exceptionId)).toEqual(['ord-77:line-2:refund_due', 'ord-78:line-1:policy_short_pick', 'ord-79:line-3:above_cap_charge']);
    expect(view.openCount).toBe(3);
    expect(view.breachedCount).toBe(1);
    expect(view.atRisk).toBe('₹235.00');
    expect(view.queues).toEqual([
      { queue: 'customer_service_desk', label: 'Customer service desk', count: 1 },
      { queue: 'finance_recon_queue', label: 'Finance reconciliation', count: 2 },
    ]);
    const [open, breached, others] = view.rows;
    expect(open).toMatchObject({ kindLabel: 'Refund due', amount: '₹125.00', queueLabel: 'Finance reconciliation', heldBy: null, mine: false, state: 'open', offer: 'claim' });
    expect(open!.status).toMatchObject({ tone: 'degraded', label: 'Open' });
    expect(open!.status.icon.trim().length).toBeGreaterThan(0);
    expect(breached).toMatchObject({ kindLabel: 'Short-picked line', heldBy: 'u-desk', mine: true, proposedBy: 'u-picker', breached: true, offer: 'work' });
    expect(breached!.status).toMatchObject({ tone: 'error', label: 'SLA breached', needsAttention: true });
    expect(others).toMatchObject({ heldBy: 'u-other', mine: false, state: 'in_progress', offer: 'none' });
    expect(others!.status).toMatchObject({ tone: 'degraded', label: 'Being worked' });
    expect(view.held.map((r) => r.exceptionId)).toEqual(['ord-78:line-1:policy_short_pick']);
    expect(view.screenState.tone).not.toBe('error');
  });

  it('is bilingual — the same view in Tamil carries Tamil labels, and every key has both languages', () => {
    const ta = harness().session.view('ta');
    expect(ta.rows[0]!.kindLabel).toBe('திருப்பித் தர வேண்டியது');
    expect(ta.rows[1]!.status.label).toBe('SLA மீறப்பட்டது');
    for (const key of COPY_KEYS) {
      expect(SUB_EXCEPTION_INBOX_COPY.en[key].length, `en ${key}`).toBeGreaterThan(0);
      expect(SUB_EXCEPTION_INBOX_COPY.ta[key].length, `ta ${key}`).toBeGreaterThan(0);
    }
  });

  it('without order.read the screen is an error state with no rows; without the work permission nothing is offered', () => {
    const noRead = harness({ mayRead: () => false }).session.view('en');
    expect(noRead.screenState.tone).toBe('error');
    expect(noRead.rows).toEqual([]);
    const noWork = harness({ mayWork: () => false }).session.view('en');
    expect(noWork.mayWork).toBe(false);
    expect(noWork.rows.every((r) => r.offer === 'none')).toBe(true);
    expect(harness({}, null).session.view('en').nobodyNamed).toBe(true);
    const empty = harness({ worklist: () => ({ ...WORKLIST, exceptions: WORKLIST.exceptions.filter((e) => e.state === 'resolved') }) }).session.view('en');
    expect(empty.rows).toEqual([]);
    expect(empty.screenState.label).toMatch(/nothing outstanding/);
  });
});

describe('the acts — refused locally before any POST unless permitted and in the right state', () => {
  it('claim reaches the port only for an OPEN exception', async () => {
    const h = harness();
    expect(await h.session.claim('ord-77:line-2:refund_due')).toBe('done');
    expect(h.posts).toEqual([{ action: 'claim', exceptionId: 'ord-77:line-2:refund_due' }]);
    expect(await h.session.claim('ord-78:line-1:policy_short_pick')).toBe('refused'); // being worked
    expect(await h.session.claim('ord-80:line-1:collect_adjustment')).toBe('refused'); // resolved
    expect(await h.session.claim('nope')).toBe('refused');
    expect(await harness({ mayWork: () => false }).session.claim('ord-77:line-2:refund_due')).toBe('refused');
    expect(h.posts).toHaveLength(1);
  });

  it('release reaches the port only for an exception being worked; the reason rides along when given', async () => {
    const h = harness();
    expect(await h.session.release('ord-78:line-1:policy_short_pick', '  back to queue — end of shift ')).toBe('done');
    expect(await h.session.release('ord-79:line-3:above_cap_charge', '')).toBe('done');
    expect(h.posts).toEqual([
      { action: 'release', exceptionId: 'ord-78:line-1:policy_short_pick', body: { reasonCode: 'back to queue — end of shift' } },
      { action: 'release', exceptionId: 'ord-79:line-3:above_cap_charge' },
    ]);
    expect(await h.session.release('ord-77:line-2:refund_due', 'x')).toBe('refused'); // open, not held
    expect(await h.session.release('ord-80:line-1:collect_adjustment', 'x')).toBe('refused'); // resolved
  });

  it('resolve needs a reason code AND the words, and an unresolved exception; the trimmed record reaches the port', async () => {
    const h = harness();
    expect(await h.session.resolve('ord-78:line-1:policy_short_pick', '', 'told the customer')).toBe('refused');
    expect(await h.session.resolve('ord-78:line-1:policy_short_pick', 'CUSTOMER-INFORMED', '   ')).toBe('refused');
    expect(await h.session.resolve('ord-80:line-1:collect_adjustment', 'COLLECTED', 'collected at the door')).toBe('refused');
    expect(h.posts).toEqual([]);
    expect(await h.session.resolve('ord-78:line-1:policy_short_pick', ' CUSTOMER-INFORMED ', ' called the customer, short line agreed and refunded ')).toBe('done');
    expect(h.posts).toEqual([{ action: 'resolve', exceptionId: 'ord-78:line-1:policy_short_pick', body: { reasonCode: 'CUSTOMER-INFORMED', detail: 'called the customer, short line agreed and refunded' } }]);
    expect(await harness({ mayWork: () => false }).session.resolve('ord-78:line-1:policy_short_pick', 'X', 'y')).toBe('refused');
  });

  it('the server\'s answer is presented with a tone, an icon and words — never colour alone', async () => {
    const refused = harness({ actionPort: () => ({ post: async () => 'refused' }) });
    expect(await refused.session.claim('ord-77:line-2:refund_due')).toBe('refused');
    const s = refused.session;
    expect(s.presentActionResult('en', 'claim', 'done')).toMatchObject({ tone: 'ok', label: 'Claimed — it is yours.', needsAttention: false });
    expect(s.presentActionResult('en', 'release', 'done').label).toBe('Released back to the queue.');
    expect(s.presentActionResult('ta', 'resolve', 'done').label).toBe('தீர்க்கப்பட்டது.');
    expect(s.presentActionResult('en', 'resolve', 'refused')).toMatchObject({ tone: 'error', needsAttention: true });
    expect(s.presentActionResult('en', 'resolve', 'lost_link')).toMatchObject({ tone: 'degraded', label: 'No connection — not saved. Try again.' });
    for (const p of [s.presentActionResult('en', 'claim', 'done'), s.presentActionResult('en', 'claim', 'refused'), s.presentActionResult('en', 'claim', 'lost_link')]) {
      expect(p.icon.trim().length).toBeGreaterThan(0);
      expect(p.label.length).toBeGreaterThan(0);
    }
  });
});
