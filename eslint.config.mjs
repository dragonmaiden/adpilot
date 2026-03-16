import js from '@eslint/js';
import globals from 'globals';

const commonRules = {
  'no-console': 'off',
};

export default [
  {
    ignores: [
      'node_modules/**',
      'server/data/**',
      'docs/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['server/**/*.js', 'test/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      ...commonRules,
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
    },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: {
        ...globals.browser,
        Chart: 'readonly',
        lucide: 'readonly',
        flatpickr: 'readonly',
      },
    },
    rules: {
      ...commonRules,
      'no-undef': 'off',
      'no-unused-vars': 'off',
    },
  },
];
