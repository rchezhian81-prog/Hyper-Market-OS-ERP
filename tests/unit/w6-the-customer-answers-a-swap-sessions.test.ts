import { describe, it, expect } from 'vitest';
import { createDeskSession, DESK_COPY, SECTION_WORDS } from '../../apps/web-erp/src/customer-desk-sections-session';
import { swapsFromOrders, waitingSwaps, answerKey, answerBody } from '../../apps/customer-app/src/substitution-answers';
import {
  proposalStanding, waitInForce, lineRuleOf, answerForPhone, proposalView, checkAnswer, REASON_WORDS, PROPOSAL_REASONS,
  type SubstitutionProposal, type ConsentFact, type SubstitutionProposalDeps,
} from '../../services/fulfilment/src/substitution-proposals';
import { readAssignmentsFeed } from '../../edge/sync-agent/src/assignments-feed';
import { ROLE_CATALOGUE } from '../../services/api/src/roles';
import { ApiError } from '../../services/kernel/src/index';

/**
 * **W6 · OB-687 (owner, 4 Nov 2026) · FUL-14 · M19-FR-02 — the rules behind a swap the customer answers**: where a proposal
 * stands (head office), what the store computer accepts on the wave, what the customer app reads and sends, and the Online
 * orders desk's two sections (the staff-recorded answer; the owner's wait, "not set" until he sets it).
 */

const T0 = '2026-11-04T10:00:00.000Z';
const at = (m: number) => new Date(Date.parse(T0) + m * 60_000).toISOString();
const P: SubstitutionProposal = {
  proposalId: 'W-1:L1:MILK-ORG', waveId: 'W-1', lineId: 'L1', orderId: 'ORD-1', orderedProductId: 'MILK', orderedName: 'Milk 1L',
  substituteProductId: 'MILK-ORG', substituteName: 'Organic milk 1L', substituteUnitPriceMinor: 75_00, quantityMinor: 2, uom: 'ea', why: 'out_of_stock',
  proposedBy: 'u-picker', relayedBy: 'u-box', proposedAt: T0, receivedAt: at(1), waitMinutes: 15, answerBy: at(15), eligibility: 'needs_confirmation', refusedBecause: null, governanceFlags: [],
};
const yes = (when: string, given: ConsentFact['given'] = 'customer'): ConsentFact => ({ orderId: 'ORD-1', lineId: 'L1', substituteProductId: 'MILK-ORG', decision: 'confirmed', acceptsHigherPrice: false, given, by: 'c-1', at: when, ...(given === 'staff_contact' ? { contact: { method: 'phone', reference: 'CALL-1' } } : {}) });

describe('W6 · OB-687 — where a swap put to the customer stands (head office)', () => {
  it('waits until the owner\'s time; the first yes or no after it was received is the answer; then too late', () => {
    expect(proposalStanding(P, [], undefined, at(5)).state).toBe('waiting');
    expect(proposalStanding(P, [yes(at(0))], undefined, at(5)).state).toBe('waiting'); // a yes older than the proposal is not its answer
    expect(proposalStanding(P, [yes(at(4))], undefined, at(5))).toMatchObject({ state: 'yes', answer: { at: at(4) } });
    expect(proposalStanding(P, [{ ...yes(at(4)), decision: 'declined' }, yes(at(6))], undefined, at(7)).state).toBe('no'); // answered once
    expect(proposalStanding(P, [], undefined, at(16)).state).toBe('too_late');
    expect(proposalStanding({ ...P, eligibility: 'refused', refusedBecause: 'blocked brand' }, [yes(at(4))], undefined, at(5)).state).toBe('refused');
    expect(proposalStanding({ ...P, answerBy: null, waitMinutes: null }, [], undefined, at(2)).state).toBe('closed');
    expect(proposalStanding(P, [], { proposalId: P.proposalId, orderId: 'ORD-1', lineId: 'L1', packed: 'picked_as_ordered', decision: null, onOrder: false, refusal: null, at: at(3) }, at(4)).state).toBe('closed');
  });

  it('the owner\'s wait is "not set" until he sets it — never a default; the phone carries the customer\'s rule, never the customer', () => {
    expect(waitInForce([])).toEqual({ minutes: null, state: 'not_set', setBy: null, setAt: null });
    expect(waitInForce([{ version: 1, minutes: 10, reason: null, setBy: 'u-owner', setAt: T0 }, { version: 2, minutes: 20, reason: null, setBy: 'u-owner', setAt: at(1) }])).toMatchObject({ minutes: 20, state: 'set' });
    expect(lineRuleOf({ preference: 'contact_me' })).toBe('ask_first');
    expect(lineRuleOf({ preference: 'no_substitution' })).toBe('never');
    expect(lineRuleOf({ preference: 'best_match' })).toBe('best_match');
    expect(lineRuleOf(undefined)).toBeUndefined();
  });

  it('the phone\'s read-back says how the yes was given; the customer\'s view says what, the price and why — in both languages', () => {
    expect(answerForPhone(P, proposalStanding(P, [yes(at(4), 'staff_contact')], undefined, at(5)))).toMatchObject({ state: 'yes', via: 'staff', reference: 'phone: CALL-1', substituteUnitPriceMinor: 75_00, answerBy: at(15) });
    expect(proposalView(P, { state: 'waiting' }, undefined)).toMatchObject({ substituteName: 'Organic milk 1L', substituteUnitPriceMinor: 75_00, whySay: REASON_WORDS.out_of_stock, state: 'waiting' });
    for (const r of PROPOSAL_REASONS) { expect(REASON_WORDS[r].en).not.toBe(''); expect(REASON_WORDS[r].ta).not.toBe(REASON_WORDS[r].en); }
  });

  it('an answer is checked against the proposal: none on the line, the same answer again, open — or refused by name', async () => {
    let consents: ConsentFact[] = [];
    let now = at(5);
    const deps = { proposalsOfOrder: async () => [P], consents: async () => consents, settlements: async () => [], now: () => now } as unknown as SubstitutionProposalDeps;
    expect(await checkAnswer(deps, 't', 'ORD-1', 'L9', 'MILK-ORG', 'confirmed')).toEqual({ kind: 'none' });
    expect((await checkAnswer(deps, 't', 'ORD-1', 'L1', 'MILK-ORG', 'confirmed')).kind).toBe('open');
    const refused = async (sub: string, d: 'confirmed' | 'declined') => { try { await checkAnswer(deps, 't', 'ORD-1', 'L1', sub, d); return 'accepted'; } catch (e) { return (e as ApiError).body.code; } };
    expect(await refused('MILK', 'confirmed')).toBe('not_the_proposed_substitute');
    consents = [yes(at(4))];
    expect((await checkAnswer(deps, 't', 'ORD-1', 'L1', 'MILK-ORG', 'confirmed')).kind).toBe('already');
    expect(await refused('MILK-ORG', 'declined')).toBe('already_answered');
    consents = []; now = at(16);
    expect(await refused('MILK-ORG', 'confirmed')).toBe('answer_too_late');
  });

  it('the owner holds the wait\'s own permission; the store manager and the store computer do not', () => {
    const holds = (role: string) => ROLE_CATALOGUE.find((r) => r.id === role)?.permissions.includes('fulfilment.substitution_wait.set') === true;
    expect(holds('owner')).toBe(true);
    expect(holds('store_manager')).toBe(false);
    expect(holds('store_computer')).toBe(false);
  });
});

describe('W6 · OB-687 — the store computer takes the wave\'s substitution facts strictly (the phone packs by them)', () => {
  const feed = (wave: Record<string, unknown>) => ({ asAt: T0, storeId: 's1', routes: [], waves: [{ waveId: 'W-1', pickerId: 'u-picker', assignedBy: 'u-owner', assignedAt: T0, lines: [{ lineId: 'L1', orderRef: 'ORD-1', productId: 'MILK', description: 'Milk', bin: 'C-01', requiredQty: 2, uom: 'each', unitPriceMinor: 60_00, substitution: 'ask_first' }], ...wave }] });
  it('accepts the rule, the wait (or "not set") and the answers; refuses anything it cannot read', () => {
    expect(readAssignmentsFeed(feed({ substitutionWaitMinutes: 15, substitutionAnswers: [{ proposalId: 'p', lineId: 'L1', state: 'yes', substituteUnitPriceMinor: 75_00 }] }))?.waves[0]).toMatchObject({ substitutionWaitMinutes: 15 });
    expect(readAssignmentsFeed(feed({ substitutionWaitMinutes: null, substitutionAnswers: [] }))).toBeDefined();
    expect(readAssignmentsFeed(feed({}))).toBeDefined(); // a head office before OB-687
    expect(readAssignmentsFeed(feed({ substitutionWaitMinutes: 0 }))).toBeUndefined();
    expect(readAssignmentsFeed(feed({ substitutionAnswers: [{ proposalId: 'p', lineId: 'L1', state: 'perhaps' }] }))).toBeUndefined();
    const bad = feed({}); (bad.waves[0]!.lines[0] as Record<string, unknown>)['substitution'] = 'whatever';
    expect(readAssignmentsFeed(bad)).toBeUndefined();
  });
});

describe('W6 · OB-687 — the customer app reads my swaps and sends my answer once', () => {
  const body = { orders: [{ orderId: 'ORD-1', substitutions: [
    { orderId: 'ORD-1', lineId: 'L1', orderedName: 'Milk 1L', substituteProductId: 'MILK-ORG', substituteName: 'Organic milk 1L', substituteUnitPriceMinor: 75_00, quantityMinor: 2, whySay: REASON_WORDS.out_of_stock, state: 'waiting', answerBy: at(15) },
    { orderId: 'ORD-1', lineId: 'L2', orderedName: 'Rice', substituteProductId: 'RICE-2', substituteName: 'Rice 2', substituteUnitPriceMinor: 80_00, quantityMinor: 1, whySay: REASON_WORDS.not_found, state: 'yes', answerBy: at(10) },
    { orderId: 'ORD-1', lineId: 'L3', substituteProductId: 'X', quantityMinor: 1, state: 'nonsense' },
  ] }, { orderId: 'ORD-2' }] };
  it('reads strictly, and offers only what still waits for me', () => {
    const all = swapsFromOrders(body);
    expect(all.map((s) => [s.lineId, s.state])).toEqual([['L1', 'waiting'], ['L2', 'yes']]);
    expect(waitingSwaps(all).map((s) => s.lineId)).toEqual(['L1']);
    expect(all[0]!.whySay.ta).toBe(REASON_WORDS.out_of_stock.ta);
    expect(swapsFromOrders({ nope: true })).toEqual([]);
  });
  it('one key per order line and answer — a lost reply tapped again is the same answer, never a second one', () => {
    const s = swapsFromOrders(body)[0]!;
    expect(answerKey(s, true)).toBe(answerKey(s, true));
    expect(answerKey(s, true)).not.toBe(answerKey(s, false));
    expect(answerBody(s, true)).toEqual({ substituteProductId: 'MILK-ORG', decision: 'confirmed' });
    expect(answerBody(s, false)).toEqual({ substituteProductId: 'MILK-ORG', decision: 'declined' });
  });
});

describe('W6 · OB-687 — the Online orders desk: the answer told to staff, and the owner\'s wait', () => {
  type Sent = { method: string; path: string; body?: unknown };
  const fake = (reply: unknown = {}) => {
    const sent: Sent[] = [];
    const fetch = (async (url: string, init?: RequestInit) => {
      sent.push({ method: init?.method ?? 'GET', path: String(url), ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }) });
      return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof globalThis.fetch;
    return { fetch, sent };
  };
  const ALL = Object.values(SECTION_WORDS);

  it('every new word has a Tamil twin', () => {
    for (const k of ['swapsH', 'swapsLead', 'swapRecord', 's_waiting', 's_too_late', 'waitH', 'waitNotSet', 'waitSave', 'd_confirmed', 'd_declined']) {
      expect((DESK_COPY.ta as Record<string, string>)[k], k).toBeTruthy();
      expect((DESK_COPY.ta as Record<string, string>)[k]).not.toBe((DESK_COPY.en as Record<string, string>)[k]);
    }
  });

  it('reads the swaps on an order and records the customer\'s answer with how they were reached — refusing the cheap things first', async () => {
    const f = fake({ proposals: [{ lineId: 'L1', state: 'waiting' }] });
    const s = createDeskSession({ viewer: { userId: 'u-desk', permissions: ALL }, fetch: f.fetch, newKey: () => 'k' });
    expect(await s.swapProposals(' ')).toEqual({ result: 'invalid', why: 'needOrder' });
    expect(await s.swapProposals('ORD-1')).toEqual({ result: 'ok', value: [{ lineId: 'L1', state: 'waiting' }] });
    expect(await s.answerSwap('ORD-1', 'L1', { decision: 'confirmed', method: 'phone', reference: '' })).toEqual({ result: 'invalid', why: 'needText' });
    expect(await s.answerSwap('ORD-1', 'L1', { decision: 'maybe', method: 'phone', reference: 'CALL-1' })).toEqual({ result: 'invalid', why: 'needText' });
    await s.answerSwap('ORD-1', 'L1', { decision: 'declined', method: 'phone', reference: ' CALL-1 ' });
    expect(f.sent).toEqual([
      { method: 'GET', path: '/v1/orders/ORD-1/substitution-proposals' },
      { method: 'POST', path: '/v1/orders/ORD-1/substitution-proposals/L1/answer', body: { decision: 'declined', contact: { method: 'phone', reference: 'CALL-1' } } },
    ]);
    const reader = createDeskSession({ viewer: { userId: 'u-read', permissions: ['order.read'] }, fetch: fake().fetch });
    expect(await reader.answerSwap('ORD-1', 'L1', { decision: 'declined', method: 'phone', reference: 'CALL-1' })).toEqual({ result: 'invalid', why: 'cannot' });
  });

  it('the wait reads "not set" as head office says it, and only the owner\'s permission may set it — whole minutes 1 to 240, nothing suggested', async () => {
    const f = fake({ minutes: null, state: 'not_set' });
    const owner = createDeskSession({ viewer: { userId: 'u-owner', permissions: ALL }, fetch: f.fetch });
    expect(await owner.swapWait()).toEqual({ result: 'ok', value: { minutes: null, state: 'not_set', setBy: null, setAt: null } });
    for (const bad of ['', '0', '241', '1.5', 'ten']) expect(await owner.setSwapWait(bad, '')).toEqual({ result: 'invalid', why: 'needNumber' });
    await owner.setSwapWait('15', ' busy evenings ');
    expect(f.sent.at(-1)).toEqual({ method: 'POST', path: '/v1/fulfilment/substitution-wait', body: { minutes: 15, reason: 'busy evenings' } });
    const mgr = createDeskSession({ viewer: { userId: 'u-mgr', permissions: ALL.filter((p) => p !== 'fulfilment.substitution_wait.set') }, fetch: fake().fetch });
    expect(mgr.may.waitSet).toBe(false);
    expect(await mgr.setSwapWait('15', '')).toEqual({ result: 'invalid', why: 'cannot' });
  });
});
