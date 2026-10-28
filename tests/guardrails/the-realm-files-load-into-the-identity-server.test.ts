// The repository's realm files must LOAD into the identity server: Keycloak stores a client's, a role's or a scope's
// description in a 255-character column and refuses the whole realm ("Database operation failed") when one is longer.
// Found when the customer realm (OB-510) first met a real Keycloak in CI — its client description was 437 characters.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIR = 'infra/keycloak';
const LIMIT = 255;

/** Every `description` (and `name`) string anywhere in a realm document, with where it sits. */
function longFields(node: unknown, path: string, out: string[]): string[] {
  if (Array.isArray(node)) node.forEach((v, i) => longFields(v, `${path}[${i}]`, out));
  else if (node !== null && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if ((k === 'description' || k === 'name') && typeof v === 'string' && v.length > LIMIT) out.push(`${path}.${k} (${v.length} characters)`);
      longFields(v, `${path}.${k}`, out);
    }
  }
  return out;
}

describe('the repository realm files load into Keycloak', () => {
  const files = readdirSync(DIR).filter((f) => /^realm-.*\.json$/.test(f));

  it('there are realm files to check', () => {
    expect(files.length).toBeGreaterThanOrEqual(2);
  });

  it.each(files)('%s: no description or name longer than Keycloak stores (255 characters)', (file) => {
    const doc = JSON.parse(readFileSync(join(DIR, file), 'utf8')) as unknown;
    expect(longFields(doc, file, [])).toEqual([]);
  });
});
