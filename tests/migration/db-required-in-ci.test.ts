import { describe, it, expect } from 'vitest';
import { Client } from 'pg';

// The guard on the guard — hard rule #9 (nothing is done without tests that PROVE it), P-08.
//
// The database-backed suites (every `describe.skipIf(!DATABASE_URL)` across tests/integration and
// tests/migration) skip themselves when no database is configured. That is right for a laptop, and
// exactly wrong for CI: a required job that runs with no DATABASE_URL would skip all of them and go
// GREEN having verified nothing about the schema, the append-only guards or the migrations. That
// false assurance is the precise gap this file closes — the audit that prompted it found six real
// migration tests that had never once run against a database in CI.
//
// So the mandatory database CI sets `DB_TESTS_REQUIRED=1`, and when it does this test refuses to let
// the suite skip silently: DATABASE_URL must be set AND the database must actually answer. A missing
// or unreachable database fails here, loudly and by name, instead of turning into a quiet green.
//
// Locally (the flag unset) this asserts nothing and passes — a developer without a database is still
// free to run the suite; only the required CI job is held to the higher bar.

const REQUIRED = process.env['DB_TESTS_REQUIRED'] === '1' || process.env['DB_TESTS_REQUIRED'] === 'true';

describe('the required database suites are not allowed to silently skip', () => {
  it('has a real, reachable database whenever DB_TESTS_REQUIRED is set', async () => {
    if (!REQUIRED) {
      // Local dev: the DB blocks may skip, and that is allowed. Nothing to prove here.
      expect(REQUIRED).toBe(false);
      return;
    }

    const url = process.env['DATABASE_URL'];
    expect(
      url,
      'DB_TESTS_REQUIRED=1 but DATABASE_URL is not set — the required database tests would skip and the job would pass having verified nothing',
    ).toBeTruthy();

    // Set is not enough: it must ANSWER. A URL pointing at nothing would let the skipIf blocks run
    // and fail one-by-one with connection errors, or (worse, on a misconfiguration) skip — so prove
    // the connection here, once, plainly.
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      const res = await client.query<{ ok: number }>('SELECT 1 AS ok');
      expect(res.rows[0]?.ok).toBe(1);
    } finally {
      await client.end();
    }
  });
});
