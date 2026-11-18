// QG-03 (container images): the API and store-edge images ship only what the running service loads.
//
// On 18 Nov 2026 the image scan failed on a HIGH in picomatch (CVE-2026-112366, no fix released) that reached the
// images only because they carried the whole development install — eslint, vite, vitest, esbuild. The running
// bundle keeps exactly one npm dependency external (`pg`, `packages: 'external'` in scripts/build-service.mjs), so
// the images now install production dependencies only and copy the built bundle from a separate build stage.
// This guardrail keeps it that way: build tooling never comes back into a shipped image.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/** The text of one named stage of a Dockerfile, from its FROM line to the next FROM. */
function stage(dockerfile: string, name: string): string {
  const parts = dockerfile.split(/^(?=FROM )/m);
  const found = parts.find((p) => new RegExp(`^FROM \\S+ AS ${name}\\b`, 'm').test(p));
  if (found === undefined) throw new Error(`no stage named ${name}`);
  return found;
}

describe('the shipped images carry no build tooling', () => {
  it('the one run-time npm dependency, pg, is a production dependency; everything else is development only', () => {
    const pkg = JSON.parse(read('package.json')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(['pg']);
    expect(pkg.devDependencies?.pg).toBeUndefined();
    for (const tool of ['esbuild', 'eslint', 'vitest', 'typescript']) expect(pkg.devDependencies?.[tool]).toBeDefined();
  });

  for (const [image, outdir] of [['api', 'services/api/dist'], ['edge', 'edge/store-edge/dist']] as const) {
    it(`${image}: production dependencies only, and the bundle is built in its own stage`, () => {
      const file = read(`infra/docker/${image}.Dockerfile`);
      expect(stage(file, 'prod-deps')).toMatch(/pnpm install --frozen-lockfile --prod\b/);
      const runtime = stage(file, 'runtime');
      expect(runtime).toContain('COPY --from=prod-deps /app/node_modules ./node_modules');
      expect(runtime).not.toMatch(/COPY --from=deps\b/);
      expect(runtime).not.toMatch(/RUN node scripts\/build-service\.mjs/);
      expect(runtime).toContain(`COPY --from=build /app/${outdir} ./${outdir}`);
      expect(stage(file, 'build')).toMatch(new RegExp(`RUN node scripts/build-service\\.mjs ${image}\\b`));
    });
  }
});
