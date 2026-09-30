import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// D2 / hard rule 1: money is BigInt kobo in DB and a decimal string in JSON.
// Float parsing anywhere in source is the bug class these rules exist to stop.
const moneyBans = [
  {
    selector: "CallExpression[callee.name='Number']",
    message: 'Money must be BigInt kobo or a decimal string. Use packages/shared/src/money.ts.',
  },
  {
    selector: "CallExpression[callee.name='parseFloat']",
    message: 'parseFloat is banned: floats cannot hold kobo amounts safely.',
  },
  {
    selector: "MemberExpression[property.name='toFixed']",
    message: 'toFixed on money is banned: format through the shared money helper.',
  },
];

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/.expo/**', 'apps/mobile/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['apps/api/src/**/*.ts', 'packages/shared/src/**/*.ts'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module' },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      'no-restricted-syntax': ['error', ...moneyBans],
      'no-restricted-globals': ['error', 'parseFloat', 'isNaN'],
    },
  },
  {
    files: ['**/*.test.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
);
