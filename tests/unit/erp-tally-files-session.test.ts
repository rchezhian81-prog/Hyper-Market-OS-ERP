import { describe, it, expect } from 'vitest';
import { createTallyFilesSession, rupees, tallyFilesWords, tallyFilesOutcomeWords, familyWords, TALLY_FILES_COPY, type OutboxRead } from '../../apps/web-erp/src/tally-files-session';

// OB-288 P5 (OB-293): the Tally files page's session — who may do what, the calls it makes (and the ones it refuses to
// make), money in paise shown as rupees, and every word in English and Tamil.

const ACC = { userId: 'u-acc', permissions: ['finance.period.read', 'finance.posting.configure'] };
const READER = { userId: 'u-read', permissions: ['finance.period.read'] };

function recorder(reply: (url: string, init: RequestInit) => { status: number; body: unknown }) {
  const calls: { url: string; method: string; key: string | null; body: unknown }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const h = (init.headers ?? {}) as Record<string, string>;
    calls.push({ url, method: init.method ?? 'GET', key: h['idempotency-key'] ?? null, body: init.body === undefined ? undefined : JSON.parse(String(init.body)) });
    const r = reply(url, init);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

describe('the Tally files session (OB-293)', () => {
  it('reads the outbox, makes the files, requeues with a reason and downloads — each a call head office checks', async () => {
    const r = recorder((url) => (url.endsWith('/run') ? { status: 200, body: { queued: ['tally-day:2026-10-20:1'], posted: ['tally-day:2026-10-20:1'], retrying: [], deadLettered: [], notYetDue: [] } }
      : url.includes('/requeue') ? { status: 201, body: { requeued: true, posting: { postingId: 'tally-day:2026-10-19:1:r1' } } }
        : url.includes('/files/') ? { status: 200, body: { fileName: 'sre-tally-2026-10-20-01.xml', xml: '<ENVELOPE/>', sha256: 'sha256:x', downloadedBefore: [] } }
          : { status: 200, body: { postings: [], deadLetters: [], counts: { posted: 0, queued: 0, deadLettered: 0 }, ledgerNames: null, waitingFor: 'ledger_names', families: [], asAt: 'now' } }));
    let n = 0;
    const s = createTallyFilesSession({ viewer: ACC, fetch: r.fetch, newKey: () => `k${++n}` });
    expect(s.may).toEqual({ named: true, read: true, configure: true });
    expect((await s.read()).result).toBe('ok');
    expect(await s.run()).toEqual({ result: 'ok', value: { queued: 1, posted: 1, deadLettered: 0 } });
    expect(await s.requeue('tally-day:2026-10-19:1', '  ')).toEqual({ result: 'invalid', why: 'needReason' });
    expect((await s.requeue('tally-day:2026-10-19:1', ' named the card ledger ')).result).toBe('ok');
    expect((await s.download('tally-day:2026-10-20:1')).result).toBe('ok');
    expect(await s.trialBalance('2026-13')).toEqual({ result: 'invalid', why: 'badMonth' });
    expect((await s.trialBalance('2026-10')).result).toBe('ok');
    expect(r.calls.map((c) => `${c.method} ${c.url} ${c.key ?? '-'}`)).toEqual([
      'GET /v1/finance/tally/outbox -',
      'POST /v1/finance/tally/outbox/run k1',
      'POST /v1/finance/tally/outbox/tally-day%3A2026-10-19%3A1/requeue k2',
      'GET /v1/finance/tally/files/tally-day%3A2026-10-20%3A1 -',
      'GET /v1/finance/periods/2026-10/trial-balance -',
    ]);
    expect(r.calls[2]!.body).toEqual({ reason: 'named the card ledger' });
  });

  it('a reader can read and download but never make or requeue; nobody signed in reads nothing; a refusal is shown in words', async () => {
    const r = recorder(() => ({ status: 403, body: { error: { code: 'permission_denied', whatHappened: 'This account does not hold "finance.period.read".' } } }));
    const reader = createTallyFilesSession({ viewer: READER, fetch: r.fetch });
    expect(reader.may).toEqual({ named: true, read: true, configure: false });
    expect(await reader.run()).toEqual({ result: 'invalid', why: 'cannotConfigure' });
    expect(await reader.requeue('x', 'fixed')).toEqual({ result: 'invalid', why: 'cannotConfigure' });
    const refused = await reader.read();
    expect(tallyFilesOutcomeWords('en', refused)).toBe('Head office refused: This account does not hold "finance.period.read".');
    const nobody = createTallyFilesSession({ viewer: undefined, fetch: r.fetch });
    expect(await nobody.read()).toEqual({ result: 'invalid', why: 'nobody' });
    expect(r.calls.length).toBe(1);
    const lost = createTallyFilesSession({ viewer: READER, fetch: (async () => { throw new Error('offline'); }) as unknown as typeof globalThis.fetch });
    expect(tallyFilesOutcomeWords('ta', await lost.read())).toBe(TALLY_FILES_COPY.ta.unreachable);
  });

  it('shows paise as rupees exactly, family words from head office, and has a Tamil twin for every word', () => {
    expect(rupees(0)).toBe('₹0.00');
    expect(rupees(12_345_678)).toBe('₹1,23,456.78');
    expect(rupees(-5)).toBe('-₹0.05');
    const read = { families: [{ family: 'sales', words: { en: 'Sales', ta: 'விற்பனை' } }] } as unknown as OutboxRead;
    expect(familyWords(read, 'ta', 'sales')).toBe('விற்பனை');
    expect(familyWords(read, 'en', 'unknown_family')).toBe('unknown_family');
    expect(Object.keys(TALLY_FILES_COPY.ta).sort()).toEqual(Object.keys(TALLY_FILES_COPY.en).sort());
    for (const k of Object.keys(TALLY_FILES_COPY.en)) expect(tallyFilesWords('ta', k), k).not.toBe(tallyFilesWords('en', k));
  });
});
