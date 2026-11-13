import { describe, it, expect } from 'vitest';
import { createOldSystemSession, readDeltaCsv, oldSystemWords, OLD_SYSTEM_COPY, MIGRATION_STEPS } from '../../apps/web-erp/src/old-system-session';

/**
 * **MG-09 — the delta LOAD as its own step on the Old system checks page (U6 · §27 Migration "delta load" · hard rules
 * #6, #7, #10).**
 *
 * The audit (lane 4) found trial load, delta load and source profiling "not found as their own steps": the page captured
 * the delta (two exports compared) but nothing on any screen LOADED the changes made after the final extract. This pins
 * the session's rules before the page does: the changes come from a CSV whose columns are the route's own fields (never a
 * format invented here); a row that cannot be read is refused by name and the file is not sent; the extract cutoff is
 * required; the act is gated on `migration.delta.apply`; the request carries exactly the changes and the cutoff; and the
 * steps ladder names every control MG-01…MG-12 in both languages.
 */

const OWNER = { userId: 'u-owner', permissions: ['migration.delta.apply', 'migration.cleaning.read'] };
const READER = { userId: 'u-reader', permissions: ['migration.cleaning.read'] };

const CSV = [
  'changeKey,entity,legacyId,operation,changedAt,deltaQty,locationId,uom,unitCostMinor,deltaMinor,netMinor,cgstMinor,sgstMinor,tender',
  'd-in,stock,P-DAL,update,2026-10-09T08:00:00.000Z,20,S1,ea,12000,,,,,',
  'd-out,stock,P-DAL,update,2026-10-09T09:00:00.000Z,-5,S1,ea,,,,,,',
  'd-sale,sale,B-77,insert,2026-10-09T09:30:00.000Z,,,,,11800,10000,900,900,cash',
].join('\n');

type Sent = { method: string; path: string; body?: unknown };
function fakeFetch(answer: (s: Sent) => unknown) {
  const sent: Sent[] = [];
  const fetch = (async (path: string, init?: { method?: string; body?: string }) => {
    const s: Sent = { method: init?.method ?? 'GET', path, ...(init?.body === undefined ? {} : { body: JSON.parse(init.body) as unknown }) };
    sent.push(s);
    return { ok: true, status: 200, json: async () => answer(s) } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent };
}

describe('the delta load step (MG-09) on the Old system checks page', () => {
  it('reads a changes file whose columns are the route\'s own fields — numbers as numbers, blanks left out', () => {
    const read = readDeltaCsv(CSV);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.changes).toHaveLength(3);
    expect(read.changes[0]).toEqual({ changeKey: 'd-in', entity: 'stock', legacyId: 'P-DAL', operation: 'update', changedAt: '2026-10-09T08:00:00.000Z', deltaQty: 20, locationId: 'S1', uom: 'ea', unitCostMinor: 12000 });
    expect(read.changes[1]).toEqual({ changeKey: 'd-out', entity: 'stock', legacyId: 'P-DAL', operation: 'update', changedAt: '2026-10-09T09:00:00.000Z', deltaQty: -5, locationId: 'S1', uom: 'ea' });
    expect(read.changes[2]).toEqual({ changeKey: 'd-sale', entity: 'sale', legacyId: 'B-77', operation: 'insert', changedAt: '2026-10-09T09:30:00.000Z', deltaMinor: 11800, netMinor: 10000, cgstMinor: 900, sgstMinor: 900, tender: 'cash' });
  });

  it('refuses a file it cannot read, by row and by name, and sends nothing', () => {
    const noKey = readDeltaCsv('changeKey,entity,legacyId,operation,changedAt\n,stock,P-1,update,2026-10-09T08:00:00.000Z');
    expect(noKey).toEqual({ ok: false, why: 'deltaRowBad', row: 2, field: 'changeKey' });
    const badOp = readDeltaCsv('changeKey,entity,legacyId,operation,changedAt\nd-1,stock,P-1,upsert,2026-10-09T08:00:00.000Z');
    expect(badOp).toEqual({ ok: false, why: 'deltaRowBad', row: 2, field: 'operation' });
    const badQty = readDeltaCsv('changeKey,entity,legacyId,operation,changedAt,deltaQty\nd-1,stock,P-1,update,2026-10-09T08:00:00.000Z,twenty');
    expect(badQty).toEqual({ ok: false, why: 'deltaRowBad', row: 2, field: 'deltaQty' });
    expect(readDeltaCsv('')).toEqual({ ok: false, why: 'noDeltaFile' });
    expect(readDeltaCsv('entity,legacyId\nstock,P-1')).toEqual({ ok: false, why: 'deltaColumnsMissing', missing: ['changeKey', 'operation', 'changedAt'] });
    expect(readDeltaCsv('changeKey,entity,legacyId,operation,changedAt\n')).toEqual({ ok: false, why: 'noDeltaRows' });
  });

  it('sends exactly the changes and the cutoff, only for a person with the right; the cutoff is required', async () => {
    const f = fakeFetch(() => ({ ok: true, applied: 2, duplicatesIgnored: 0, refused: 1, lines: [], appliedKeys: ['d-in', 'd-out'], netValueMinor: 0, netQty: 15, detail: 'applied 2' }));
    const s = createOldSystemSession({ viewer: OWNER, fetch: f.fetch });
    expect(s.may.delta).toBe(true);
    expect(await s.applyDeltas({ extractCutoff: '', csv: CSV })).toEqual({ result: 'invalid', why: 'noCutoff' });
    expect(await s.applyDeltas({ extractCutoff: '2026-10-09', csv: '' })).toEqual({ result: 'invalid', why: 'noDeltaFile' });
    const out = await s.applyDeltas({ extractCutoff: '2026-10-09', csv: CSV });
    expect(out.result).toBe('ok');
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toMatchObject({ method: 'POST', path: '/v1/migration/deltas' });
    const body = f.sent[0]!.body as { changes: unknown[]; extractCutoff: string };
    expect(body.changes).toHaveLength(3);
    // the cutoff is the extract's moment at the shop: the day's start in Asia/Kolkata, sent as the instant head office compares with
    expect(body.extractCutoff).toBe('2026-10-08T18:30:00.000Z');
    const reader = createOldSystemSession({ viewer: READER, fetch: f.fetch });
    expect(reader.may.delta).toBe(false);
    expect(await reader.applyDeltas({ extractCutoff: '2026-10-09', csv: CSV })).toEqual({ result: 'invalid', why: 'notAllowed' });
    expect(f.sent).toHaveLength(1);
  });

  it('the steps ladder names MG-01 to MG-12 in order, each with both languages and a section on the page', () => {
    // thirteen steps for twelve controls: the delta's capture and its load are two steps of MG-09
    expect(MIGRATION_STEPS.map((s) => s.control)).toEqual(['MG-01', 'MG-02', 'MG-03', 'MG-04', 'MG-05', 'MG-06', 'MG-07', 'MG-08', 'MG-09', 'MG-09', 'MG-10', 'MG-11', 'MG-12']);
    for (const step of MIGRATION_STEPS) {
      expect(step.anchor, step.control).toMatch(/^#[a-z-]+$/);
      expect(oldSystemWords('en', step.word)).not.toBe(step.word);
      expect(oldSystemWords('ta', step.word)).not.toBe(step.word);
      expect(oldSystemWords('ta', step.word)).not.toBe(oldSystemWords('en', step.word));
    }
    // the delta's two halves are two steps: the capture (two exports compared) and the LOAD
    expect(MIGRATION_STEPS.filter((s) => s.control === 'MG-09').map((s) => s.anchor)).toEqual(['#diff', '#delta']);
    for (const k of ['deltaH', 'deltaLead', 'deltaCutoff', 'deltaFile', 'readDelta', 'loadDelta', 'deltaConfirmTitle', 'deltaConfirmDetail', 'noCutoff', 'noDeltaFile', 'noDeltaRows', 'deltaColumnsMissing', 'deltaRowBad', 'o_applied', 'o_already_applied', 'o_refused_before_cutoff', 'o_refused_production', 'o_refused_unsupported_entity', 'o_refused_incomplete']) {
      expect((OLD_SYSTEM_COPY.ta as Record<string, string>)[k], k).toBeTruthy();
      expect((OLD_SYSTEM_COPY.en as Record<string, string>)[k], k).toBeTruthy();
    }
  });
});
