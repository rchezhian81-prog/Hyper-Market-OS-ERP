import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  SCALES_COPY, createScalesSession, bodyOf, orderedScales, summarise, outcomeWords, stampWords, formOf, APPROVAL_KIND, SCALES_PATH,
  type ScaleRow, type ScaleForm,
} from '../../apps/web-erp/src/scales-session';
import { ERP_NAVIGATION } from '../../apps/web-erp/src/navigation';

/**
 * **OB-154 "A" — the Weighing scales screen is usable, bilingual and governed (roadmap v2.1 B6 · B7 · L2 · P-04 · P-05 ·
 * P-07 · P-08).**
 *
 * Pins what this screen exists to guarantee: every word has a Tamil twin; a scale whose stamp has run out reads first and
 * in words, never colour alone; only the owner and the store manager (`facilities.asset.manage`) are offered "add or
 * update" and the session refuses anyone else before a POST; nothing is written on open — the only writes are the save,
 * the approval request and the approved save, each from an explicit click; a later stamp date is sent as an approval
 * request with EXACTLY the change the save sends (the engine fingerprints it), and the approved save sends that very body
 * with its approval, keyed on the approval so a retried click is the same act.
 */

const day = (o: number): string => new Date(Date.now() + o * 86_400_000).toISOString().slice(0, 10);
const row = (assetId: string, level: ScaleRow['verification']['level'], due: string): ScaleRow => ({
  assetId, storeId: 'S1', laneIds: ['lane-1'], approvalNo: 'LM/APP/1', capacityGrams: 30_000, lastStampedOn: day(-300), reverificationDueOn: due,
  certificateRef: 'LM/VC/1', version: 1, setBy: 'u-mgr', setAt: '2026-10-01T00:00:00Z', verification: { level, tradingBlocked: level === 'expired', daysRemaining: 0 },
});
const FORM: ScaleForm = { assetId: 'SCALE-1', storeId: 'S1', lanes: 'lane-1, lane-2, lane-1', approvalNo: 'LM/APP/1', capacityGrams: '30000', lastStampedOn: day(0), reverificationDueOn: day(365), certificateRef: 'LM/VC/2026/0107' };

function fakeHttp(answers: Record<string, { status: number; body: unknown }>) {
  const sent: { method: string; path: string; body?: unknown; key?: string }[] = [];
  const fetch = (async (path: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    sent.push({ method: init.method, path, ...(init.body === undefined ? {} : { body: JSON.parse(init.body) as unknown }), ...(init.headers['idempotency-key'] === undefined ? {} : { key: init.headers['idempotency-key'] }) });
    const a = answers[`${init.method} ${path}`] ?? { status: 200, body: {} };
    return { ok: a.status < 400, status: a.status, json: async () => a.body };
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent };
}
const OWNER = { userId: 'u-owner', permissions: ['facilities.asset.read', 'facilities.asset.manage'] };

describe('the copy is complete in both languages', () => {
  it('every English key has a Tamil word, and none is empty', () => {
    const en = Object.keys(SCALES_COPY.en).sort();
    expect(Object.keys(SCALES_COPY.ta).sort()).toEqual(en);
    for (const k of en) expect((SCALES_COPY.ta as Record<string, string>)[k]!.trim(), k).not.toBe('');
  });
});

describe('worst first, in words', () => {
  it('run out, then due soon, then current; each says what it means for the tills', () => {
    const ordered = orderedScales([row('C', 'current', day(300)), row('B', 'due_soon', day(10)), row('A', 'expired', day(-2))]);
    expect(ordered.map((s) => s.assetId)).toEqual(['A', 'B', 'C']);
    expect(stampWords('en', ordered[0]!)).toBe('Run out — its tills cannot sell by weight');
    expect(stampWords('ta', ordered[0]!)).toMatch(/காலாவதி/);
    expect(summarise({ asOf: day(0), scales: ordered, requests: [] })).toEqual({ scales: 3, lapsed: 1, soon: 1, waiting: 0 });
  });
});

describe('the form is read, never guessed', () => {
  it('a blank field, a date that is not a date, or grams that are not whole are refused before a POST', () => {
    expect(bodyOf({ ...FORM, certificateRef: ' ' })).toEqual({ ok: false, why: 'needAll' });
    expect(bodyOf({ ...FORM, reverificationDueOn: '16/10/2027' })).toEqual({ ok: false, why: 'notDate' });
    expect(bodyOf({ ...FORM, capacityGrams: '30.5' })).toEqual({ ok: false, why: 'notGrams' });
    expect(bodyOf(FORM)).toEqual({ ok: true, assetId: 'SCALE-1', body: { storeId: 'S1', laneIds: ['lane-1', 'lane-2'], approvalNo: 'LM/APP/1', capacityGrams: 30_000, lastStampedOn: day(0), reverificationDueOn: day(365), certificateRef: 'LM/VC/2026/0107' } });
    expect(formOf(row('A', 'current', day(10)))).toMatchObject({ assetId: 'A', lanes: 'lane-1', capacityGrams: '30000', certificateRef: 'LM/VC/1' });
  });
});

describe('only what the person may do is offered, and the session holds the line too', () => {
  it('nobody named reads nothing; a reader without manage cannot save or ask; nothing is sent for them', async () => {
    const h = fakeHttp({});
    expect(await createScalesSession({ viewer: undefined, fetch: h.fetch }).load()).toEqual({ result: 'invalid', why: 'nobody' });
    const reader = createScalesSession({ viewer: { userId: 'u-it', permissions: ['facilities.asset.read'] }, fetch: h.fetch });
    expect(reader.may).toEqual({ named: true, read: true, manage: false });
    expect(await reader.save(FORM)).toEqual({ result: 'invalid', why: 'readOnly' });
    expect(await reader.ask(FORM)).toEqual({ result: 'invalid', why: 'readOnly' });
    expect(await createScalesSession({ viewer: { userId: 'u-cash', permissions: [] }, fetch: h.fetch }).load()).toEqual({ result: 'invalid', why: 'cannotRead' });
    expect(h.sent.filter((s) => s.method === 'POST')).toEqual([]);
  });
});

describe('a later stamp date goes to a second person with exactly the change, and the approved save sends that very body', () => {
  it('save → refused "needs approval" (in words) → ask with the same body → approved save keyed on the approval', async () => {
    const h = fakeHttp({
      [`POST ${SCALES_PATH}/SCALE-1`]: { status: 422, body: { error: { code: 'scale_stamp_change_needs_approval', whatHappened: 'Extending the stamp…' } } },
      'POST /v1/approvals/requests': { status: 201, body: { requestId: 'areq-1' } },
    });
    const s = createScalesSession({ viewer: OWNER, fetch: h.fetch });
    const saved = await s.save(FORM);
    expect(saved).toMatchObject({ result: 'refused', code: 'scale_stamp_change_needs_approval' });
    expect(outcomeWords('en', saved)).toBe('A later stamp date needs a second person. Ask for approval with exactly this change.');
    expect(await s.ask(FORM)).toEqual({ result: 'ok', value: { requestId: 'areq-1' } });
    const [save, ask] = h.sent;
    expect(ask).toMatchObject({ method: 'POST', path: '/v1/approvals/requests', body: { kind: APPROVAL_KIND, subjectRef: 'SCALE-1', valueMinor: null, details: { ...(save!.body as object), assetId: 'SCALE-1' } } });
    await s.saveApproved({ requestId: 'areq-1', status: 'approved', subjectRef: 'SCALE-1', details: (ask!.body as { details: never }).details, requestedAt: '2026-10-16T00:00:00Z', decidedBy: 'u-owner' });
    const approved = h.sent.at(-1)!;
    expect(approved).toEqual({ method: 'POST', path: `${SCALES_PATH}/SCALE-1`, body: { ...(save!.body as object), approvalId: 'areq-1' }, key: 'scl-approved-areq-1' });
  });

  it('load reads the register and only this person\'s stamp-change requests — two GETs, nothing written', async () => {
    const h = fakeHttp({
      [`GET ${SCALES_PATH}`]: { status: 200, body: { asOf: day(0), scales: [row('B', 'current', day(300)), row('A', 'expired', day(-1))] } },
      'GET /v1/approvals/requests': { status: 200, body: { mine: [{ requestId: 'r1', kind: APPROVAL_KIND, status: 'waiting', requestedAt: '2026-10-16T00:00:00Z' }, { requestId: 'r2', kind: 'price_change', status: 'waiting', requestedAt: '2026-10-16T00:00:00Z' }] } },
    });
    const out = await createScalesSession({ viewer: OWNER, fetch: h.fetch }).load();
    expect(out.result).toBe('ok');
    if (out.result !== 'ok') return;
    expect(out.value.scales.map((x) => x.assetId)).toEqual(['A', 'B']);
    expect(out.value.requests.map((r) => r.requestId)).toEqual(['r1']);
    expect(h.sent.map((x) => x.method)).toEqual(['GET', 'GET']);
  });
});

describe('the view defers to the session, uses no browser dialogs, and writes only on an explicit click', () => {
  const RAW = readFileSync('apps/web-erp/web/scales.js', 'utf8');
  const VIEW = RAW.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  const HTML = readFileSync('apps/web-erp/web/scales.html', 'utf8');

  it('never calls alert / confirm / prompt, and renders from the bundled session', () => {
    expect(/\b(alert|confirm|prompt)\s*\(/.test(VIEW)).toBe(false);
    expect(VIEW).toMatch(/window\.scales/);
    expect(VIEW).not.toMatch(/fetch\(/); // every call is the session's
  });

  it('every write runs inside a click handler, never at load', () => {
    const firstClick = VIEW.indexOf("addEventListener('click'");
    for (const call of ['session.save(', 'session.ask(', 'session.saveApproved(']) {
      const at = VIEW.indexOf(call);
      expect(at, `${call} is not present`).toBeGreaterThan(-1);
      expect(at, `${call} runs outside a click handler`).toBeGreaterThan(firstClick);
    }
    expect(VIEW.slice(VIEW.lastIndexOf('paintAll();'))).not.toMatch(/session\.(save|ask|saveApproved)\(/);
  });

  it('a stamp is said in words with its colour, and there is no box to type a second person\'s name', () => {
    expect(VIEW).toMatch(/api\.stampWords\(lang, s\)/);
    expect(HTML).not.toMatch(/approvedBy|approver/i);
  });

  it('the shell loads the shared bundle, carries the data marker, labels the toggle, and the menu names it for the owner and manager', () => {
    expect(HTML).toMatch(/web-erp\.bundle\.js/);
    expect(HTML).toContain('<!--SCREEN-DATA-->');
    expect(HTML).toMatch(/id="lang"[^>]*aria-label=/);
    expect(ERP_NAVIGATION.find((i) => i.id === 'scales')).toMatchObject({ path: '/scales', requires: 'facilities.asset.read', served: 'unserved' });
  });
});
