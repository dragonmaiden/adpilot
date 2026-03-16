import js from '@eslint/js';
import globals from 'globals';
import n from 'eslint-plugin-n';

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
    plugins: {
      n,
    },
  },
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
      'n/no-deprecated-api': 'warn',
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
