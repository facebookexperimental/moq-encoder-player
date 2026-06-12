/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

// Web Worker entry point for the MoQ publisher. All logic lives in the
// MoqSender class (see ./moq/moq_sender_internals.ts); this file just
// wires worker `message` events into it.

import { MoqSender } from './moq/moq_sender_internals.js';

const sender = new MoqSender();

self.addEventListener('message', (e) => {
  sender.onMessage(e);
});
