import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { STORE_EDGE_CONFIG, CLOUD_API_CONFIG } from '../../services/kernel/src/config';

/**
 * **Round 32 · owner decision OB-116 "A" (14 Oct 2026, in writing, "New head-office secret"; verifier r31 NEW-2) — the secret
 * the store computers' saved history is sealed under (BOX_HISTORY_SEAL_KEY) is head office's ALONE.**
 *
 *   • the API requires it (no default), at least 32 characters; the store edge's configuration does not know it;
 *   • nothing under edge/ (the store computer, its sync agent, the till box) reads it, and the install script that writes a
 *     till's settings never copies it;
 *   • the compose file gives it to the `api` service only — never to `edge`; the example settings file holds a placeholder,
 *     never a value; the CI stack job generates one at run time;
 *   • (round 32, verifier r31) the API process makes ONE snapshot store, shared by its routes and the alert worker, so the saved
 *     history's background build runs once per shop per process.
 */

const NAME = 'BOX_HISTORY_SEAL_KEY';
const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  if (f === 'node_modules' || f === 'dist') return [];
  return statSync(p).isDirectory() ? files(p) : [p];
});

describe('round 32 · OB-116: the saved-history seal secret is head office\'s alone', () => {
  it('the API requires it (a secret, at least 32 characters); the store edge\'s configuration does not know it', () => {
    expect(CLOUD_API_CONFIG.find((s) => s.key === NAME)).toEqual({ key: NAME, secret: true, minLength: 32 });
    expect(STORE_EDGE_CONFIG.some((s) => s.key === NAME)).toBe(false);
  });

  it('nothing under edge/ reads it, and the till install script never copies it', () => {
    const readers = files('edge').filter((f) => /\.(ts|mjs|js|json|sh)$/.test(f) && readFileSync(f, 'utf8').includes(NAME));
    expect(readers).toEqual([]);
    expect(readFileSync('scripts/install-till.mjs', 'utf8')).not.toContain(NAME);
  });

  it('compose gives it to the api service only — never to the edge; the example holds a placeholder; CI generates one at run time', () => {
    const compose = readFileSync('infra/compose/docker-compose.yml', 'utf8');
    const service = (name: string): string => {
      const start = compose.indexOf(`\n  ${name}:\n`);
      const rest = compose.slice(start + 1);
      const next = rest.slice(1).search(/\n {2}[a-z][a-z-]*:\n/);
      return next === -1 ? rest : rest.slice(0, next + 1);
    };
    expect(service('api')).toContain(`${NAME}: \${${NAME}}`);
    expect(service('edge')).not.toContain(NAME);
    for (const overlay of ['infra/compose/docker-compose.pilot.yml']) {
      const text = readFileSync(overlay, 'utf8');
      // The pilot overlay never hands it to a store computer (it adds nothing for it at all).
      expect(text.includes(NAME), overlay).toBe(false);
    }
    for (const example of ['infra/compose/.env.example', 'infra/compose/.env.pilot.example']) {
      expect(readFileSync(example, 'utf8'), example).toMatch(new RegExp(`^${NAME}=REPLACE_WITH_A_GENERATED_VALUE$`, 'm'));
    }
    const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
    expect(ci).toContain(`echo "${NAME}=$(openssl rand -base64 48)"`);
    expect(ci).toContain(`grep -q "${NAME} is not set"`);
  });

  it('the API process makes ONE snapshot store, shared by its routes and the alert worker (one background build per shop)', () => {
    const main = readFileSync('services/api/src/main.ts', 'utf8');
    expect(main.match(/new SqlSnapshotStore\(/g)).toHaveLength(1);
    const startApi = main.slice(main.indexOf('export async function startApi('));
    // Both the surface and the ops-alert worker are handed that same `snapshots`.
    expect(startApi.match(/^\s+snapshots,$/gm)?.length).toBe(2);
    expect(startApi).toContain(`boxHistorySealKey: boxHistorySealKey(settings['${NAME}']!)`);
    expect(startApi).toContain(`boxHistorySealSecret: settings['${NAME}']!`);
    expect(startApi).not.toMatch(/boxHistorySealKey\(settings\['PACK_SIGNING_KEY'\]/);
  });
});
