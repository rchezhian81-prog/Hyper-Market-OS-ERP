// QG-03 SAST (OB-288 gates lane): pick the SECURITY rules for this codebase's languages out of a checkout of the
// open-source Semgrep rules repository, pinned to one commit in .github/workflows/ci.yml.
//
//   node scripts/select-sast-rules.mjs <semgrep-rules checkout> <out dir>
//
// Every rule under javascript/ and typescript/ whose metadata says `category: security` is copied to <out dir>,
// keeping its path (the rule id stays recognisable). Style and portability rules (i18n key formats, useless
// template strings) are left out: they are not security findings, and 4,000 of them would bury the ones that are.
// The script prints how many rules it took and fails if it took none — an empty rule set is a scan that cannot
// find anything, which is not a clean scan (P-08).

import { readdirSync, readFileSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';

const [root, out] = process.argv.slice(2);
if (root === undefined || out === undefined) {
  console.error('usage: node scripts/select-sast-rules.mjs <semgrep-rules checkout> <out dir>');
  process.exit(2);
}

const LANGUAGES = ['javascript', 'typescript'];
const SECURITY = /^\s+category:\s*security\s*$/m;

function* yamlFiles(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* yamlFiles(path);
    else if ((name.endsWith('.yaml') || name.endsWith('.yml')) && !name.includes('.test.')) yield path;
  }
}

let taken = 0;
for (const lang of LANGUAGES) {
  const base = join(root, lang);
  for (const file of yamlFiles(base)) {
    if (!SECURITY.test(readFileSync(file, 'utf8'))) continue;
    const target = join(out, relative(root, file));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(file, target);
    taken += 1;
  }
}
if (taken === 0) {
  console.error(`::error::no security rules found under ${root} — the SAST scan would find nothing because it looked for nothing`);
  process.exit(2);
}
console.log(`SAST rules: ${taken} security rule file(s) for ${LANGUAGES.join(' + ')} copied to ${out}`);
