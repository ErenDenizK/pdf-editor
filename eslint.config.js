// @ts-check
import js from '@eslint/js';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** Globals that exist in both Node and browsers (and plain ECMAScript builtins). */
const sharedGlobals = new Set([
  ...Object.keys(globals['shared-node-browser']),
  ...Object.keys(globals.es2025),
]);

/**
 * ADR-0007: the platform-agnostic core must not reach for DOM (or Node) APIs directly;
 * those arrive through injected adapters. Referencing any browser-only or Node-only global
 * in `packages/document-model` is an error.
 */
const platformGlobalsMessage =
  'packages/document-model is platform-agnostic (ADR-0007); inject an adapter instead.';
const restrictedPlatformGlobals = [
  ...Object.keys(globals.browser),
  ...Object.keys(globals.worker),
  ...Object.keys(globals.node),
]
  .filter((name, index, all) => !sharedGlobals.has(name) && all.indexOf(name) === index)
  .map((name) => ({ name, message: platformGlobalsMessage }));

/** Files executed by Node: tool configs, scripts, and Playwright specs. */
const nodeFiles = [
  '*.{js,ts}',
  '**/*.config.{js,ts}',
  'tooling/**/*.ts',
  'tools/**/*.{js,ts}',
  'apps/web/e2e/**/*.ts',
];

export default defineConfig(
  globalIgnores([
    '**/dist/',
    '**/build/',
    '**/coverage/',
    '**/node_modules/',
    '**/playwright-report/',
    '**/test-results/',
    '**/blob-report/',
    '.changeset/',
  ]),

  // Baseline for every file.
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      eqeqeq: ['error', 'smart'],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'object-shorthand': 'error',
      'prefer-const': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],
      '@typescript-eslint/no-confusing-void-expression': ['error', { ignoreArrowShorthand: true }],
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],
      // Off on purpose: capability detection (ADR-0007) and validation of untrusted input
      // deliberately test values that the DOM lib typings or signatures declare as always
      // present, and this rule would flag every such check.
      '@typescript-eslint/no-unnecessary-condition': 'off',
      // Off on purpose: flags legitimate single-use generics such as branded-id helpers.
      '@typescript-eslint/no-unnecessary-type-parameters': 'off',
      // Off on purpose: contradicts `no-non-null-assertion` from the strict preset.
      '@typescript-eslint/non-nullable-type-assertion-style': 'off',
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { considerDefaultExhaustiveForUnions: true },
      ],
    },
  },

  // Plain JavaScript files (root tool configs) have no TypeScript program.
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
  },

  // Tests: `noUncheckedIndexedAccess` makes `items[0]!` the clearest way to state an
  // expectation that a failing test would surface anyway.
  {
    files: ['**/*.test.{ts,tsx}', '**/__tests__/**/*.{ts,tsx}', 'apps/web/e2e/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  // Node-executed files.
  {
    files: nodeFiles,
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      'no-console': 'off',
    },
  },

  // Engine: runs in the browser main thread and in dedicated workers.
  {
    files: ['packages/engine/**/*.ts'],
    ignores: nodeFiles,
    languageOptions: {
      globals: { ...globals.browser, ...globals.worker },
    },
  },

  // Document model: platform-agnostic core (ADR-0007).
  {
    files: ['packages/document-model/**/*.ts'],
    ignores: nodeFiles,
    languageOptions: {
      globals: { ...globals.es2025 },
    },
    rules: {
      'no-restricted-globals': ['error', ...restrictedPlatformGlobals],
    },
  },

  // Web application: React (with the React Compiler) and accessibility.
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    ignores: nodeFiles,
    extends: [reactHooks.configs.flat['recommended-latest'], jsxA11y.flatConfigs.recommended],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      'react-hooks/exhaustive-deps': 'error',
    },
  },
);
