import { describe, it, expect } from 'vitest';
import { createDayEvidenceSession, openDayEvidencePorts, DAY_EVIDENCE_COPY, type DayEvidencePorts } from '../../apps/web-erp/src/day-evidence-session';

/**
 * **M14-FR-04 — the day-book screen's evidence-pack model.** It lists the chosen day's closes (locked, or reopened — not
 * final), hands the shell a CSV or JSON file named with the seal, says NOT FINAL for a reopened day, and refuses before any
 * read without `till.dayclose.read`; a lost link and a refusal are each said, never shown as an empty day. English and
 * Tamil carry the same words. Synthetic data only.
 */

const ROWS = [
  { dayCloseId: 'dc-2', storeId: 'S2', tradingDay: '2026-10-20', locked: false, reopened: true },
  { dayCloseId: 'dc-1', storeId: 'S1', tradingDay: '2026-10-20', locked: true, reopened: false },
  { dayCloseId: 'dc-0', storeId: 'S1', tradingDay: '2026-10-19', locked: true, reopened: false },
];
const reply = (final: boolean) => ({ pack: { final, contentHash: 'ab'.repeat(32) }, csv: 'section,item\r\n', fileName: 'day-evidence-S1-2026-10-20-abababababab', said: '' });
const ports = (over: Partial<DayEvidencePorts> = {}): DayEvidencePorts => ({
  mayRead: () => true,
  closes: async () => ({ kind: 'ok', value: ROWS }),
  pack: async (id) => ({ kind: 'ok', value: reply(id === 'dc-1') }),
  ...over,
});

describe('M14-FR-04 — the day book offers each close\'s evidence pack', () => {
  it('the day\'s closes, store order, locked vs reopened; the files; NOT FINAL said', async () => {
    const s = createDayEvidenceSession(ports());
    const { rows, status } = await s.rows('en', '2026-10-20');
    expect(status).toBeNull();
    expect(rows.map((r) => [r.dayCloseId, r.storeLabel, r.status.label, r.status.tone])).toEqual([
      ['dc-1', 'Store S1 · dc-1', 'Closed and locked', 'ok'], ['dc-2', 'Store S2 · dc-2', 'Reopened — not final', 'degraded'],
    ]);
    const csv = await s.download('en', 'dc-1', 'csv');
    expect(csv.file).toEqual({ fileName: 'day-evidence-S1-2026-10-20-abababababab.csv', mime: 'text/csv;charset=utf-8', content: 'section,item\r\n' });
    expect(csv.status).toMatchObject({ tone: 'ok', label: 'Downloaded: day-evidence-S1-2026-10-20-abababababab.csv · Seal abababababab…' });
    const json = await s.download('ta', 'dc-2', 'json');
    expect(JSON.parse(json.file!.content)).toEqual(reply(false).pack);
    expect(json.status.label).toContain(DAY_EVIDENCE_COPY.ta.notFinal);
    expect((await s.rows('en', '2026-10-21')).status?.label).toBe(DAY_EVIDENCE_COPY.en.none);
  });

  it('no permission: refused before any read; a lost link and a refusal each said; nothing to save', async () => {
    let reads = 0;
    const counted = ports({ mayRead: () => false, closes: async () => { reads += 1; return { kind: 'ok', value: ROWS }; }, pack: async () => { reads += 1; return { kind: 'ok', value: reply(true) }; } });
    const no = createDayEvidenceSession(counted);
    expect((await no.rows('en', '2026-10-20')).status?.label).toBe(DAY_EVIDENCE_COPY.en.notPermitted);
    expect((await no.download('en', 'dc-1', 'csv')).file).toBeNull();
    expect(reads).toBe(0);
    const lost = createDayEvidenceSession(ports({ closes: async () => ({ kind: 'lost_link' }), pack: async () => ({ kind: 'refused', status: 403 }) }));
    expect((await lost.rows('en', '2026-10-20')).status).toMatchObject({ tone: 'degraded', label: DAY_EVIDENCE_COPY.en.lostLink });
    expect(await lost.download('en', 'dc-1', 'csv')).toMatchObject({ file: null, status: { tone: 'error', label: DAY_EVIDENCE_COPY.en.refused } });
    expect(Object.keys(DAY_EVIDENCE_COPY.ta).sort()).toEqual(Object.keys(DAY_EVIDENCE_COPY.en).sort());
  });

  it('the live ports read head office in the viewer\'s own session; a thrown fetch is a lost link', async () => {
    const asked: string[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      asked.push(`${init.method} ${url} ${init.credentials}`);
      if (url.endsWith('/evidence-pack')) return new Response(JSON.stringify({ error: { code: 'forbidden' } }), { status: 403 });
      return new Response(JSON.stringify({ dayCloses: ROWS }), { status: 200 });
    }) as unknown as typeof fetch;
    const live = openDayEvidencePorts(['till.dayclose.read'], fetchFn);
    expect(live.mayRead()).toBe(true);
    expect(await live.closes()).toEqual({ kind: 'ok', value: ROWS });
    expect(await live.pack('dc 1')).toEqual({ kind: 'refused', status: 403 });
    expect(asked).toEqual(['GET /v1/pos/day-close same-origin', 'GET /v1/pos/day-close/dc%201/evidence-pack same-origin']);
    expect(openDayEvidencePorts(undefined, fetchFn).mayRead()).toBe(false);
    expect(await openDayEvidencePorts([], (async () => { throw new Error('offline'); }) as unknown as typeof fetch).closes()).toEqual({ kind: 'lost_link' });
  });
});
