import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

// Minimal, robust flat config. Lints TypeScript and JavaScript across the repo.
// Kept deliberately light during setup so the safety net is green and honest;
// rules are tightened as real application code lands.
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/.turbo/**',
      // Build artifacts from `pnpm build:pos|owner|erp`. They are git-ignored, machine-written and
      // never edited by hand, so linting them reports on esbuild's output rather than on anybody's
      // code — and a tree-shaken export that nothing in the bundle happens to call is not a finding.
      // Worse, it makes `pnpm check` pass or fail depending on whether somebody has run a build.
      'apps/*/web/*.bundle.js',
      'apps/*/web/*.bundle.js.map',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,js,mjs,cjs}'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // App front-ends run in the browser (and, for a service worker, in the SW
    // scope) — not in Node. Give those files the right globals.
    files: ['apps/**/web/**/*.js'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.serviceworker },
    },
  },
);
