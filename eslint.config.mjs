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
