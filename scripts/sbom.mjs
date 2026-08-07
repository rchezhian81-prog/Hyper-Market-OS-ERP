// Generate a CycloneDX software bill of materials (QG-03 / M32-FR-03 / §23).
//
// You cannot answer "are we affected by this vulnerability?" without knowing exactly
// what is in the build. The answer has to be a file, produced by the build, not a
// memory of what somebody installed.
//
// This walks the real installed tree rather than re-reading package.json, so what it
// reports is what actually ships — including transitive dependencies nobody chose
// deliberately, which is where the risk usually lives.
//
// Usage: node scripts/sbom.mjs [--out docs/evidence/sbom.json]

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const out = argValue('--out') ?? 'docs/evidence/sbom.json';
const root = JSON.parse(readFileSync('package.json', 'utf8'));

const components = [];
const seen = new Set();

// `pnpm list` gives the resolved tree, which is the truth about what is installed.
let tree = {};
try {
  const raw = execFileSync('pnpm', ['list', '--depth', 'Infinity', '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  tree = JSON.parse(raw)[0] ?? {};
} catch {
  console.warn('  note: pnpm list unavailable; falling back to declared dependencies only');
}

collect(tree.dependencies ?? {}, 'required');
collect(tree.devDependencies ?? {}, 'optional');

// Declared-but-unresolved dependencies still belong in the SBOM: an absent component
// is worse than an imprecise one, because it reads as "we do not use that".
for (const [name, range] of Object.entries({
  ...(root.dependencies ?? {}),
  ...(root.devDependencies ?? {}),
})) {
  if (!seen.has(name)) {
    components.push(component(name, String(range).replace(/^[^\d]*/, ''), 'required', true));
    seen.add(name);
  }
}

const sbom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  version: 1,
  metadata: {
    // No timestamp: a build-to-build diff should show dependency changes, not clock ticks.
    component: {
      type: 'application',
      name: root.name ?? 'sre-retail-os',
      version: root.version ?? '0.0.0',
      description: 'SRE Retail OS — hybrid offline-first retail operating system',
    },
    tools: [{ name: 'scripts/sbom.mjs', vendor: 'SRE Retail OS' }],
  },
  components: components.sort((a, b) => a.name.localeCompare(b.name)),
};

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(sbom, null, 2)}\n`);

const direct = Object.keys({ ...(root.dependencies ?? {}), ...(root.devDependencies ?? {}) }).length;
console.log(`  components  ${components.length} (${direct} declared directly)`);
console.log(`  written     ${out}`);
console.log(`  digest      ${createHash('sha256').update(readFileSync(out)).digest('hex').slice(0, 16)}…`);

function collect(deps, scope) {
  for (const [name, info] of Object.entries(deps)) {
    if (!seen.has(name)) {
      seen.add(name);
      components.push(component(name, info?.version ?? 'unknown', scope, false));
    }
    if (info?.dependencies) collect(info.dependencies, scope);
  }
}

function component(name, version, scope, unresolved) {
  return {
    type: 'library',
    name,
    version,
    scope,
    purl: `pkg:npm/${name.replace('@', '%40')}@${version}`,
    ...(unresolved ? { properties: [{ name: 'sre:resolved', value: 'false' }] } : {}),
  };
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}
