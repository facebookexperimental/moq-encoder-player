/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  watchman: false,
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  // Source uses explicit ".js" extensions in import specifiers (so the emitted
  // ESM works in the browser). Map them back to the TypeScript sources for tests.
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: {
          module: 'commonjs',
          esModuleInterop: true,
          noImplicitAny: false,
          strictNullChecks: false,
          // Tests need the Jest (and Node) ambient globals.
          types: ['jest', 'node'],
        },
      },
    ],
  },
};
