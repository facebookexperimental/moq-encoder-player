/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
const prettier = require('eslint-config-prettier');
const globals = require('globals');

module.exports = tseslint.config(
  {
    // Replaces the old `ignorePatterns` from .eslintrc.js.
    ignores: ['dist/', 'node_modules/', 'demo/'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.worker,
        ...globals.node,
      },
    },
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
  }
);
