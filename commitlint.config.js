// Conventional Commits with the project's scopes (ADR-0006).
/** @type {import('@commitlint/types').UserConfig} */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [
      2,
      'always',
      [
        'engine',
        'model',
        'ui',
        'light-table',
        'viewer',
        'export',
        'docs',
        'build',
        'ci',
        'deps',
        'fixtures',
      ],
    ],
  },
};
