import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// M23 · API-09 · P-08 (no silent failure): a journal body that is empty or incomplete is refused 400
// `not_readable_as_a_journal`, naming every field that is missing or not the right kind — never a 500 `unhandled`
// (which says "wasItSaved: unknown" about a request that plainly saved nothing). Found by probing every write with `{}`.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
type Err = { error?: { code?: string; whatHappened?: string; wasItSaved?: string } };

async function owner(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  return h;
}
const post = (h: ApiHarness, path: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path, userId: 'u-owner', tenantId: A, idempotencyKey: key, body });

const good = {
  entryId: 'je-1', period: '2026-08', documentDate: '2026-08-14', narrative: 'Bank charges for August',
  lines: [{ accountCode: 'bank-charges', debitMinor: 500, creditMinor: 0 }, { accountCode: 'bank', debitMinor: 0, creditMinor: 500 }],
};

describe('POST /v1/finance/journals reads its body or refuses it by name', () => {
  it('refuses an empty body 400 not_readable_as_a_journal, naming all five missing fields', async () => {
    const h = await owner();
    const r = await post(h, '/v1/finance/journals', {}, 'j-empty');
    expect(r.status).toBe(400);
    const e = (r.body as Err).error!;
    expect(e.code).toBe('not_readable_as_a_journal');
    expect(e.wasItSaved).toBe('not_saved');
    for (const f of ['entryId', 'period', 'documentDate', 'narrative', 'lines']) expect(e.whatHappened).toContain(f);
  });

  it('names only what is wrong in an incomplete body', async () => {
    const h = await owner();
    const rest: Record<string, unknown> = { ...good };
    delete rest['narrative'];
    delete rest['lines'];
    const e = ((await post(h, '/v1/finance/journals', rest, 'j-part')).body as Err).error!;
    expect(e.code).toBe('not_readable_as_a_journal');
    expect(e.whatHappened).toContain('narrative');
    expect(e.whatHappened).toContain('lines');
    expect(e.whatHappened).not.toContain('entryId');
  });

  it.each([
    ['lines that is not a list', { ...good, lines: 'x' }, 'lines'],
    ['a line that is not an object', { ...good, lines: [null, good.lines[1]] }, 'lines[0]'],
    ['a line with no amounts', { ...good, lines: [{ accountCode: 'bank' }, good.lines[1]] }, 'lines[0]'],
    ['a narrative that is not text', { ...good, narrative: 42 }, 'narrative'],
    ['a body that is not an object', [good], 'entryId'],
  ])('refuses %s by name, not 500', async (_label, body, named) => {
    const h = await owner();
    const r = await post(h, '/v1/finance/journals', body, `j-${_label}`);
    expect(r.status).toBe(400);
    expect((r.body as Err).error?.code).toBe('not_readable_as_a_journal');
    expect((r.body as Err).error?.whatHappened).toContain(named);
  });

  it('still posts a complete, balanced journal (201) — the check refuses nothing it should accept', async () => {
    const h = await owner();
    const r = await post(h, '/v1/finance/journals', good, 'j-good');
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ entryId: 'je-1', postedTo: '2026-08' });
  });

  it('the period close already refuses an empty body by name (422, not 500) — it has no required field', async () => {
    const h = await owner();
    const r = await post(h, '/v1/finance/periods/2026-08/close', {}, 'c-empty');
    expect(r.status).toBe(422);
    expect((r.body as Err).error?.code).toBe('nothing_was_checked');
  });
});
