/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

module.exports = {
  root: true,
  env: {
    browser: true,
    es2022: true,
    worker: true,
    node: true,
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'prettier',
  ],
  rules: {
    // This is a gradual TypeScript migration of an existing JavaScript code
    // base, so a few of the stricter defaults are relaxed.
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-unused-vars': [
      'warn',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    'no-unused-vars': 'off',
    // TypeScript performs its own undefined-symbol checking, and it is aware of
    // browser/WebCodecs/AudioWorklet globals that ESLint's env lists are not.
    'no-undef': 'off',
    'no-constant-condition': ['error', { checkLoops: false }],
    'no-empty': ['error', { allowEmptyCatch: true }],
  },
  ignorePatterns: ['dist/', 'node_modules/', 'demo/'],
};
