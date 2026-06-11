/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

// Web Worker entry point for the MoQ subscriber (player downloader). All logic
// lives in the MoqReceiver class (see ./moq/moq_receiver_internals.ts); this
// file just wires worker `message` events into it.

import { MoqReceiver } from './moq/moq_receiver_internals.js';

const receiver = new MoqReceiver();

self.addEventListener('message', (e) => {
  receiver.onMessage(e);
});
