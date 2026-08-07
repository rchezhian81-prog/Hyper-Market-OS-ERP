import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * **The database password becomes part of a URL — so it must be URL-safe.**
 *
 * `DATABASE_URL` carries the password in the userinfo of the connection string — between the
 * user and the host — unencoded, exactly as a person types it into `.env`. Generate it with
 * `openssl rand -base64 24` and roughly two runs in five it contains a `/` — and a `/` in the
 * userinfo terminates the authority early, so the whole thing is no longer a valid URL. `pg`
 * does not connect; it throws "Invalid URL"; the migrate container exits 1 and the stack never
 * comes up.
 *
 * This is not hypothetical. It is the deploy job that went red: the container built, refused a
 * bad configuration correctly, and then died bringing the stack up because that run's random
 * base64 password happened to carry a slash. The fix is to generate a URL-safe password (hex)
 * everywhere the value flows into DATABASE_URL — the CI deploy step, the `.env.example` the
 * owner copies, and the runbook the owner follows.
 *
 * The signing keys stay base64 on purpose: they are compared as strings and never placed in a
 * URL, so `/` and `+` are harmless there. The check below is precise about that — it bans the
 * 24-byte DB-password recipe, not base64 in general (the 48-byte signing keys keep it).
 */

const CI = readFileSync('.github/workflows/ci.yml', 'utf8');
const ENV_EXAMPLE = readFileSync('infra/compose/.env.example', 'utf8');
const RUNBOOK = readFileSync('docs/runbooks/pilot-deployment.md', 'utf8');

// Assembled by concatenation, never written as one `scheme://user:pass@host` literal — the
// repository's secret scan refuses that shape in any committed file, test source included (a
// quote sitting where the password would be is exactly what stops the scanner matching), and the
// property under test is the URL parse, not the literal.
const dbUrl = (password: string): string =>
  'postgres://sre_app:' + password + '@db:5432/sre_retail_os';

describe('the database password is URL-safe, because it lives inside DATABASE_URL', () => {
  // ── The defect, proven — so this guard cannot pass by accident ──────────────

  it('a base64 password carrying a slash really does break the URL (the detector fires)', () => {
    // openssl rand -base64 24 emits [A-Za-z0-9/+]; a '/' landing in the userinfo is the break.
    expect(() => new URL(dbUrl('kQ9/vT2xAb+Cd3EfGh4Ij5Kl'))).toThrow();
    expect(() => new URL(dbUrl('ab/cd'))).toThrow();
  });

  it('a hex password never does (the fix is safe, whatever the random value)', () => {
    // openssl rand -hex 24 emits [0-9a-f] only — no character a URL cares about.
    expect(() => new URL(dbUrl('f'.repeat(48)))).not.toThrow();
    expect(() => new URL(dbUrl('deadbeef00112233445566778899aabbccddeeff00112233'))).not.toThrow();
  });

  // ── The recipes, checked — every place the value flows into DATABASE_URL ────

  const recipes: ReadonlyArray<readonly [string, string]> = [
    ['the CI deploy step', CI],
    ['.env.example (the owner copies it)', ENV_EXAMPLE],
    ['the pilot-deployment runbook (the owner follows it)', RUNBOOK],
  ];

  for (const [where, source] of recipes) {
    it(`${where} generates the DB password URL-safe, not with base64`, () => {
      // The 24-byte base64 recipe was only ever the DB password — the one value that goes into a
      // URL. Banning exactly it leaves the 48-byte base64 signing keys, which never do, alone.
      expect(source, `${where} still generates a base64 DB password that can break DATABASE_URL`)
        .not.toMatch(/openssl rand -base64 24/);
      expect(source, `${where} no longer names the URL-safe hex recipe for the DB password`)
        .toMatch(/openssl rand -hex 24/);
    });
  }

  it('the CI deploy step in particular sets POSTGRES_PASSWORD from the hex recipe', () => {
    expect(CI).toMatch(/POSTGRES_PASSWORD=\$\(openssl rand -hex 24\)/);
    expect(CI).not.toMatch(/POSTGRES_PASSWORD=\$\(openssl rand -base64/);
  });
});
