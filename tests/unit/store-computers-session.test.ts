import { describe, it, expect } from 'vitest';
import {
  createStoreComputersSession, STORE_COMPUTERS_COPY, wordsFor, outcomeWords, summarise, requestWords, orderedBindings, findingKindWords, unusedNumbersWords, acknowledgeable,
  type Board, type Finding, type ReplacementRequest,
} from '../../apps/web-erp/src/store-computers-session';
import { APPROVAL_KINDS } from '../../services/identity/src/approval-requests';
import { STORE_COMPUTER_REPLACED_KIND, STORE_COMPUTER_REPLACEMENTS_PATH, PREFIX_BINDINGS_PATH, NOT_CHECKED_ACKNOWLEDGEMENTS_PATH, REFUSAL_ACKNOWLEDGEMENTS_PATH, UNUSED_RECEIVED_ACKNOWLEDGEMENTS_PATH } from '../../services/platform/src/box-health';
import { BINDINGS_PATH, REPLACE_PATH, REFUSAL_ACK_PATH, NOT_CHECKED_ACK_PATH, UNUSED_RECEIVED_ACK_PATH, KIND } from '../../apps/web-erp/src/store-computers-session';

/**
 * **Round 26 · OB-99 "A" — the Store computers page's session (DOM-free).** It reads head office's bindings, its observed
 * findings and this person's own requests without writing; what the person may do is head office's own answer (`you`), never
 * the page's guess; the "replaced" act is asked on the approvals engine with EXACTLY the details it will later send, and sent
 * with that approval under a key made from it (a retried click is the same act); acknowledgements go to head office's own
 * routes; a blank field or a short reason sends nothing; a refusal comes back in head office's words; nobody named sends
 * nothing; every word has a Tamil twin.
 */

interface Sent { method: string; path: string; key: string | undefined; body: unknown }
function fakeHeadOffice(answer: (s: Sent) => { status: number; body: unknown } = () => ({ status: 200, body: {} })) {
  const sent: Sent[] = [];
  const fetch = (async (path: string, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const s: Sent = { method: init.method ?? 'GET', path, key: headers['idempotency-key'], body: init.body === undefined ? undefined : JSON.parse(String(init.body)) };
    sent.push(s);
    const a = answer(s);
    return new Response(JSON.stringify(a.body), { status: a.status });
  }) as unknown as typeof globalThis.fetch;
  return { sent, fetch };
}
const HO = { userId: 'u-ho', permissions: ['platform.health.read', 'platform.alert.manage', 'store.computer.replace'] };
let n = 0;
const keys = { newKey: () => `key-${++n}` };
const DETAILS = { storeId: 'S1', prefix: 'S1L1-', fromComputer: 'u-box', toComputer: 'u-box-new', reason: 'old disk failed' };
const REQ: ReplacementRequest = { requestId: 'areq-1', status: 'approved', details: DETAILS, requestedAt: '2026-10-13T09:00:00.000Z', decidedBy: 'u-owner' };

describe('the store computers session', () => {
  it('reads without writing: bindings, findings that need a person, and only this person\'s store computer requests', async () => {
    const ho = fakeHeadOffice((s) => ({
      status: 200,
      body: s.path === BINDINGS_PATH
        ? { bindings: [{ storeId: 'S2', prefix: 'S2L1-', computer: 'u-b2', since: 'x', via: 'first_report' }, { storeId: 'S1', prefix: 'S1L1-', computer: 'u-box', since: 'x', via: 'first_report' }], replacements: [], you: { mayReplace: true, mayAcknowledge: true } }
        : s.path === '/v1/platform/operational-health/observed'
        ? { observed: { boxes: [{ storeId: 'S1', billNumberFindings: [{ kind: 'report_refused', prefix: 'S1L1-', through: 110, since: 'x', detail: 'refused' }, { kind: 'issued_never_received', prefix: 'S1L1-', since: 'x', detail: 'lost' }, { kind: 'at_risk_not_checked', prefix: 'S1L1-', count: 400, ranges: [[101, 500]], since: 'x', detail: 'not checked' }] }] } }
        : { mine: [{ ...REQ, kind: KIND }, { requestId: 'areq-2', kind: 'price_change', status: 'waiting', details: {}, requestedAt: 'y' }] },
    }));
    const s = createStoreComputersSession({ viewer: HO, fetch: ho.fetch, ...keys });
    expect(s.may).toEqual({ named: true, read: true });
    const out = await s.load();
    expect(out.result).toBe('ok');
    const b = (out as { value: Board }).value;
    expect(b.bindings.map((x) => x.storeId)).toEqual(['S1', 'S2']);
    expect(b.findings.map((f) => [f.storeId, f.kind])).toEqual([['S1', 'report_refused'], ['S1', 'at_risk_not_checked']]); // never "never received" — that is not cleared here
    expect(b.requests.map((r) => r.requestId)).toEqual(['areq-1']);
    expect(b.you).toEqual({ mayReplace: true, mayAcknowledge: true });
    expect(ho.sent.map((x) => `${x.method} ${x.path}`)).toEqual([`GET ${BINDINGS_PATH}`, 'GET /v1/platform/operational-health/observed', 'GET /v1/approvals/requests']);
    expect(ho.sent.every((x) => x.key === undefined)).toBe(true);
  });

  it('round 27 · OB-100: numbers taken and never used are read per store, till and day; round 28 · OB-103: "said unused, but held" is acknowledged by its count, with the reason', async () => {
    const ho = fakeHeadOffice((s) => ({
      status: 200,
      body: s.path === BINDINGS_PATH ? { bindings: [], replacements: [], you: { mayReplace: true, mayAcknowledge: true } }
        : s.path === '/v1/platform/operational-health/observed'
        ? { observed: { boxes: [
          { storeId: 'S1', billNumberFindings: [{ kind: 'unused_number_received', prefix: 'S1L1-', ranges: [[105, 105]], count: 1, since: 'x', detail: 'does not fit' }],
            unusedNumbers: [{ prefix: 'S1L1-', day: '2026-10-12', count: 2, ranges: [[105, 105], [110, 110]], moreRanges: 0 }, { prefix: 'S1L1-', day: '2026-10-13', count: 1, ranges: [[120, 120]], moreRanges: 3 }] },
          { storeId: 'S2', unusedNumbers: [{ prefix: 'S2L1-', day: '2026-10-13', count: 5, ranges: [[1, 5]], moreRanges: 0 }, { prefix: 7, day: 'bad' }] },
        ] } }
        : { mine: [] },
    }));
    const s = createStoreComputersSession({ viewer: HO, fetch: ho.fetch, ...keys });
    const b = ((await s.load()) as { value: Board }).value;
    expect(b.unused.map((u) => [u.day, u.storeId, u.prefix, u.count])).toEqual([['2026-10-13', 'S1', 'S1L1-', 1], ['2026-10-13', 'S2', 'S2L1-', 5], ['2026-10-12', 'S1', 'S1L1-', 2]]);
    expect(summarise(b).unused).toBe(8);
    expect(unusedNumbersWords('en', b.unused[2]!)).toBe('S1L1-000105, S1L1-000110');
    expect(unusedNumbersWords('en', b.unused[0]!)).toBe('S1L1-000120 and 3 more');
    expect(unusedNumbersWords('ta', b.unused[0]!)).toBe('S1L1-000120 மேலும் 3');
    const held = b.findings.find((f) => f.kind === 'unused_number_received')!;
    expect(findingKindWords('en', held)).toBe('Said unused, but head office has the bill');
    expect(acknowledgeable(held)).toBe(true);
    const before = ho.sent.length;
    expect(await s.acknowledge(held, 'no')).toEqual({ result: 'invalid', why: 'shortReason' });
    expect(ho.sent.length).toBe(before); // nothing sent for a short reason
    await s.acknowledge(held, ' support checked the store computer ');
    expect(ho.sent.slice(before).map((x) => [x.method, x.path, x.body])).toEqual([
      ['POST', UNUSED_RECEIVED_ACK_PATH, { storeId: 'S1', prefix: 'S1L1-', count: 1, reason: 'support checked the store computer' }],
    ]);
    // A kind this page does not know is never sent anywhere.
    expect(await s.acknowledge({ ...held, kind: 'issued_never_received' as never }, 'support checked it')).toEqual({ result: 'invalid', why: 'notAcknowledgeable' });
  });

  it('what a person may do is head office\'s answer: no `you`, or a refusal of the read, offers nothing', async () => {
    const quiet = fakeHeadOffice((s) => ({ status: 200, body: s.path === BINDINGS_PATH ? { bindings: [], replacements: [] } : {} }));
    const b = await createStoreComputersSession({ viewer: { userId: 'u-it', permissions: ['platform.health.read', 'platform.alert.manage'] }, fetch: quiet.fetch }).load();
    expect((b as { value: Board }).value.you).toEqual({ mayReplace: false, mayAcknowledge: false });
    const refused = fakeHeadOffice(() => ({ status: 403, body: { error: { code: 'forbidden', whatHappened: 'not yours' } } }));
    const r = await createStoreComputersSession({ viewer: { userId: 'u-cash', permissions: [] }, fetch: refused.fetch }).load();
    expect(r).toEqual({ result: 'refused', status: 403, code: 'forbidden', whatHappened: 'not yours' });
    expect(refused.sent).toHaveLength(1); // nothing else is asked once the read is refused
    expect(createStoreComputersSession({ viewer: { userId: 'u-cash', permissions: [] } }).may).toEqual({ named: true, read: false });
  });

  it('asks the owner\'s approval with exactly the details the act will send, then sends the act with that approval under its own key', async () => {
    const ho = fakeHeadOffice((s) => ({ status: s.path === '/v1/approvals/requests' ? 201 : 201, body: s.path === '/v1/approvals/requests' ? { requestId: 'areq-9' } : { replacement: { replacementId: 'scr-areq-9' } } }));
    const s = createStoreComputersSession({ viewer: HO, fetch: ho.fetch, ...keys });
    const asked = await s.ask({ storeId: ' S1 ', prefix: 'S1L1-', fromComputer: 'u-box', toComputer: 'u-box-new ', reason: ' old disk failed ' });
    expect(asked).toEqual({ result: 'ok', value: { requestId: 'areq-9' } });
    expect(ho.sent[0]).toMatchObject({ method: 'POST', path: '/v1/approvals/requests', body: { kind: 'store_computer_replaced', subjectRef: 'S1/S1L1-', details: DETAILS, reason: 'old disk failed' } });
    expect(ho.sent[0]!.key).toMatch(/^key-/);
    await s.send({ ...REQ, requestId: 'areq-9' });
    await s.send({ ...REQ, requestId: 'areq-9' });
    expect(ho.sent.slice(1).map((x) => [x.path, x.key, x.body])).toEqual([
      [REPLACE_PATH, 'scr-areq-9', { ...DETAILS, approvalId: 'areq-9' }],
      [REPLACE_PATH, 'scr-areq-9', { ...DETAILS, approvalId: 'areq-9' }], // a retried click is the same act
    ]);
  });

  it('acknowledges a refused report by its count and a not-checked line by its count, each with the reason', async () => {
    const ho = fakeHeadOffice(() => ({ status: 201, body: {} }));
    const s = createStoreComputersSession({ viewer: HO, fetch: ho.fetch, ...keys });
    const refused: Finding = { storeId: 'S1', kind: 'report_refused', prefix: 'S1L1-', through: 110, since: 'x', detail: 'd' };
    const notChecked: Finding = { storeId: 'S1', kind: 'at_risk_not_checked', prefix: 'S1L1-', count: 400, since: 'x', detail: 'd' };
    await s.acknowledge(refused, ' stand-by box switched off ');
    await s.acknowledge(notChecked, 'support compared the restore record');
    expect(ho.sent.map((x) => [x.path, x.body])).toEqual([
      [REFUSAL_ACK_PATH, { storeId: 'S1', prefix: 'S1L1-', through: 110, reason: 'stand-by box switched off' }],
      [NOT_CHECKED_ACK_PATH, { storeId: 'S1', prefix: 'S1L1-', count: 400, reason: 'support compared the restore record' }],
    ]);
  });

  it('sends nothing for a blank field, a short reason, the same computer twice, or nobody named; a refusal is head office\'s words', async () => {
    const ho = fakeHeadOffice(() => ({ status: 422, body: { error: { code: 'not_a_store_computer_of_this_store', whatHappened: 'u-x is not a store computer of store S1' } } }));
    const s = createStoreComputersSession({ viewer: HO, fetch: ho.fetch, ...keys });
    expect(await s.ask({ ...DETAILS, toComputer: ' ' })).toEqual({ result: 'invalid', why: 'needAll' });
    expect(await s.ask({ ...DETAILS, reason: 'ok' })).toEqual({ result: 'invalid', why: 'shortReason' });
    expect(await s.ask({ ...DETAILS, toComputer: 'u-box' })).toEqual({ result: 'invalid', why: 'sameComputer' });
    expect(await s.acknowledge({ storeId: 'S1', kind: 'report_refused', prefix: 'P', through: 1, since: 'x', detail: 'd' }, 'no')).toEqual({ result: 'invalid', why: 'shortReason' });
    expect(ho.sent).toEqual([]);
    const out = await s.ask({ ...DETAILS, toComputer: 'u-x' });
    expect(outcomeWords('en', out)).toBe('Head office refused: u-x is not a store computer of store S1');
    const nobody = createStoreComputersSession({ viewer: undefined, fetch: ho.fetch });
    expect(nobody.may).toEqual({ named: false, read: false });
    expect(await nobody.load()).toEqual({ result: 'invalid', why: 'nobody' });
    expect(await nobody.send(REQ)).toEqual({ result: 'invalid', why: 'nobody' });
    expect(ho.sent).toHaveLength(1);
    const lost = createStoreComputersSession({ viewer: HO, fetch: (async () => { throw new Error('down'); }) as unknown as typeof fetch });
    expect(outcomeWords('ta', await lost.load())).toBe(STORE_COMPUTERS_COPY.ta.unreachable);
  });

  it('says how each request stands and sums the page, in both languages', () => {
    expect(requestWords('en', REQ)).toBe('Approved by u-owner — ready to send');
    expect(requestWords('en', { ...REQ, status: 'rejected', decisionReason: 'wrong box' })).toBe('Rejected by u-owner: wrong box');
    expect(requestWords('en', { ...REQ, status: 'waiting' })).toBe('Waiting for the owner');
    expect(requestWords('ta', { ...REQ, status: 'used' })).toBe(STORE_COMPUTERS_COPY.ta.stUsed);
    expect(findingKindWords('en', { storeId: 'S1', kind: 'at_risk_not_checked', prefix: 'P', since: 'x', detail: 'd' })).toBe('Numbers not checked');
    expect(wordsFor('en', 'sent', { prefix: 'S1L1-', to: 'u-box-new' })).toBe('Moved — head office now takes S1L1-\'s bill numbers from u-box-new.');
    expect(summarise(null)).toEqual({ bindings: null, replaced: null, needs: null, waiting: null, unused: null });
    expect(summarise({
      bindings: orderedBindings([{ storeId: 'S1', prefix: 'A', computer: 'x', since: 's', via: 'replacement' }, { storeId: 'S1', prefix: 'B', computer: 'y', since: 's', via: 'first_report' }]),
      unused: [{ storeId: 'S1', prefix: 'A', day: '2026-10-13', count: 3, ranges: [[1, 3]], moreRanges: 0 }],
      replacements: [], findings: [{ storeId: 'S1', kind: 'report_refused', prefix: 'A', since: 's', detail: 'd' }],
      requests: [REQ, { ...REQ, status: 'waiting' }, { ...REQ, status: 'used' }], you: { mayReplace: true, mayAcknowledge: true },
    })).toEqual({ bindings: 2, replaced: 1, needs: 1, waiting: 2, unused: 3 });
  });

  it('every English word has a Tamil twin in Tamil script; the page\'s paths and kind are head office\'s own', () => {
    const en = Object.keys(STORE_COMPUTERS_COPY.en).sort();
    expect(Object.keys(STORE_COMPUTERS_COPY.ta).sort()).toEqual(en);
    for (const k of en) if (k !== 'lang') expect(STORE_COMPUTERS_COPY.ta[k as keyof typeof STORE_COMPUTERS_COPY.ta], k).toMatch(/[஀-௿]/);
    expect([BINDINGS_PATH, REPLACE_PATH, REFUSAL_ACK_PATH, NOT_CHECKED_ACK_PATH, UNUSED_RECEIVED_ACK_PATH, KIND]).toEqual([PREFIX_BINDINGS_PATH, STORE_COMPUTER_REPLACEMENTS_PATH, REFUSAL_ACKNOWLEDGEMENTS_PATH, NOT_CHECKED_ACKNOWLEDGEMENTS_PATH, UNUSED_RECEIVED_ACKNOWLEDGEMENTS_PATH, STORE_COMPUTER_REPLACED_KIND]);
    expect(APPROVAL_KINDS[KIND]).toBeDefined();
  });
});
