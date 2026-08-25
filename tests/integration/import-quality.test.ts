import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Import job history & supplier data-quality scoring, end to end (M30-FR-04, API-03 Purchase). The failure
// this closes is quiet and expensive: a supplier's file arriving with 12% of rows rejected every week for a
// year, where the operator fixes the dozen rows by hand and the import succeeds — so no alert ever fires. The
// cost is only visible as a TREND, and only if somebody kept the history. So: a job is recorded whether it
// SUCCEEDED or not (hard rule #6); the score belongs to the SOURCE, not the operator; direction is reported
// beside the level; and the comparison is a LIST OF PEOPLE TO TALK TO, not a league table. Gated
// purchase.import.record (write) / .read (reports).

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const err = (column: string, kind = 'missing_required', line = 5) => ({ line, column, kind, message: `${column} ${kind}` });
const job = (h: ApiHarness, u: string, id: string, body: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: `/v1/purchase/import-jobs/${id}`, userId: u, tenantId: A, idempotencyKey: key ?? `job-${id}`, body });
const history = (h: ApiHarness, u: string, query?: Record<string, string>) =>
  h.request({ method: 'GET', path: '/v1/purchase/import-jobs', userId: u, tenantId: A, ...(query ? { query } : {}) });
const score = (h: ApiHarness, u: string, sourceId: string, query?: Record<string, string>) =>
  h.request({ method: 'GET', path: `/v1/purchase/import-quality/${sourceId}`, userId: u, tenantId: A, ...(query ? { query } : {}) });
const compare = (h: ApiHarness, u: string, query?: Record<string, string>) =>
  h.request({ method: 'GET', path: '/v1/purchase/import-quality', userId: u, tenantId: A, ...(query ? { query } : {}) });

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

// A whole supplier file's outcome in one object — the summary the importer already computed.
const fileOutcome = (over: Record<string, unknown>) => ({
  sourceId: 'acme', templateId: 'supplier-price-v1', fileName: 'acme-prices.csv',
  outcome: 'committed', totalRows: 1000, validRows: 1000, errorRows: 0, duplicatesForReview: 0, errors: [],
  uploadedAt: '2026-08-20T10:00:00Z', ...over,
});

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager'); // purchase.import.record + read
  await h.provisionRole(A, 'u-book', 'accountant');   // purchase.import.read only
  await h.provisionRole(A, 'u-cash', 'cashier');       // neither
  return h;
}

describe('import quality: which supplier files cost hours a year, and it kept the refusals (M30-FR-04)', () => {
  it('records jobs (successes AND refusals) and reads the history newest-first, surviving a restart', async () => {
    const h = await cast();
    expect((await job(h, 'u-mgr', 'j1', fileOutcome({ uploadedAt: '2026-08-18T09:00:00Z', validRows: 990, errorRows: 10, errors: [err('hsn_code')] }))).status).toBe(201);
    // The same file came back wrong the next day and was refused — recorded too (hard rule #6).
    expect((await job(h, 'u-mgr', 'j2', fileOutcome({ uploadedAt: '2026-08-19T09:00:00Z', outcome: 'refused', validRows: 880, errorRows: 120, refusalReason: 'control total mismatch', errors: [err('hsn_code')] }))).status).toBe(201);

    const rows = (await history(h, 'u-owner')).body as { jobs: { jobId: string; outcome: string; detail: string }[]; count: number };
    expect(rows.count).toBe(2);
    expect(rows.jobs[0]?.jobId).toBe('j2'); // newest first
    expect(rows.jobs[0]?.outcome).toBe('refused');
    expect(rows.jobs[0]?.detail).toContain('control total mismatch'); // the refusal is the evidence the file was wrong

    // Event-sourced — the history is identical after a cold restart.
    const restarted = apiHarness({ store: h.store });
    expect(((await history(restarted, 'u-owner')).body as { count: number }).count).toBe(2);
  });

  it('scores a source by its data quality, blames the column not the operator, and shows direction', async () => {
    const h = await cast();
    // Previous week: 20% rejected (unusable). This week: 4% rejected (acceptable) — the supplier is improving.
    await job(h, 'u-mgr', 'prev', fileOutcome({ uploadedAt: '2026-08-14T09:00:00Z', validRows: 800, errorRows: 200, errors: [err('hsn_code')] }));
    await job(h, 'u-mgr', 'cur', fileOutcome({ uploadedAt: '2026-08-20T09:00:00Z', validRows: 960, errorRows: 40, errors: [err('hsn_code'), err('hsn_code'), err('mrp', 'not_an_amount')] }));

    const s = (await score(h, 'u-owner', 'acme', { from: '2026-08-18', to: '2026-08-24', previousFrom: '2026-08-11', previousTo: '2026-08-17' })).body as {
      band: string; direction: string; acceptedBps: number; annualFixHours: number; topReasons: { column: string; count: number }[]; detail: string;
    };
    expect(s.acceptedBps).toBe(9600);       // 960/1000
    expect(s.band).toBe('acceptable');
    expect(s.direction).toBe('improving');  // 96% now vs 80% before
    expect(s.topReasons[0]?.column).toBe('hsn_code'); // the worst reason, ranked — an email, not a dashboard
    expect(s.annualFixHours).toBeGreaterThan(0);
    expect(s.detail).toContain('hsn_code');
  });

  it('compares sources and names the ones worth a conversation, leaving the clean ones alone', async () => {
    const h = await cast();
    // A bad source and a clean one, both in the same recent week.
    await job(h, 'u-mgr', 'bad', fileOutcome({ sourceId: 'acme', validRows: 880, errorRows: 120, errors: [err('hsn_code')] }));
    await job(h, 'u-mgr', 'clean', fileOutcome({ sourceId: 'tidy-co', fileName: 'tidy.csv', totalRows: 500, validRows: 500, errorRows: 0, errors: [] }));

    const c = (await compare(h, 'u-owner', { from: '2026-08-18', to: '2026-08-24' })).body as {
      sources: { sourceId: string }[]; worthAConversation: string[]; totalAnnualFixHours: number; detail: string;
    };
    expect(c.worthAConversation).toContain('acme');       // costs real hours a year
    expect(c.worthAConversation).not.toContain('tidy-co'); // clean — nothing to chase
    expect(c.sources[0]?.sourceId).toBe('acme');           // worst first
    expect(c.totalAnnualFixHours).toBeGreaterThan(0);
  });

  it('refuses too little data to score, is gated, and rejects a malformed job', async () => {
    const h = await cast();
    // A handful of rows is noise, not quality.
    await job(h, 'u-mgr', 'tiny', fileOutcome({ sourceId: 'newbie', totalRows: 50, validRows: 45, errorRows: 5, errors: [err('hsn_code')] }));
    const s = (await score(h, 'u-owner', 'newbie', { from: '2026-08-18', to: '2026-08-24' })).body as { acceptedBps: unknown; band: string };
    expect(s.acceptedBps).toBe('not_enough_data');
    expect(s.band).toBe('not_enough_data');

    // An accountant may READ the quality but not RECORD a job; a cashier can do neither.
    expect((await score(h, 'u-book', 'acme', { from: '2026-08-18', to: '2026-08-24' })).status).toBe(200);
    expect((await job(h, 'u-book', 'x', fileOutcome({}))).status).toBe(403);
    expect((await job(h, 'u-cash', 'x', fileOutcome({}))).status).toBe(403);
    expect((await history(h, 'u-cash')).status).toBe(403);
    expect((await compare(h, 'u-cash')).status).toBe(403);

    // A job that is not readable as an import outcome is refused, nothing saved.
    expect(codeOf(await job(h, 'u-mgr', 'bad-body', { sourceId: 'acme', outcome: 'committed' }, 'bad-body'))).toBe('not_readable_as_an_import_job');
  });
});
