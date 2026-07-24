/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import { AvgLastNItems } from './avg_last_n_items.js';

export class TsQueue {
  elementsList: any[];
  totalDiscarded: number;
  // Decode-queue timestamps, in decode order. Length is derived from the
  // timestamp span instead of a per-chunk duration.
  ptsQueue: number[];
  // Rolling average of recent inter-item timestamp deltas (in timebase ticks),
  // used to estimate one item's duration when fewer than two are queued.
  avgItemDur: AvgLastNItems;
  lastItemTs: number | undefined;

  constructor() {
    this.elementsList = [];
    this.totalDiscarded = 0;
    this.ptsQueue = [];
    this.avgItemDur = new AvgLastNItems();
    this.lastItemTs = undefined;
  }

  clear() {
    this.ptsQueue = [];
    this.avgItemDur.Clear();
    this.lastItemTs = undefined;
  }

  addToPtsQueue(ts: number) {
    this.ptsQueue.push(ts);
    // Feed the inter-item delta (positive only) to the rolling average so a lone
    // queued item can be sized later.
    if (this.lastItemTs !== undefined) {
      const delta = ts - this.lastItemTs;
      if (delta > 0) {
        this.avgItemDur.Add(delta);
      }
    }
    this.lastItemTs = ts;
  }

  shiftPtsQueue(numElements = 1) {
    this.ptsQueue = this.ptsQueue.slice(numElements);
  }

  removeUntil(length: number) {
    const removeSize = Math.max(this.ptsQueue.length - length, 0);
    if (removeSize > 0) {
      this.shiftPtsQueue(removeSize);
    }
  }

  // Queue length in seconds. `timebase` is the per-track MoQ-MI timebase (ticks
  // per second) the queued timestamps are in; it is mandatory (no default).
  //  - empty  -> 0 (nothing queued)
  //  - 1 item -> the average item duration (a single item has no span)
  //  - >=2    -> the span (last - first) / timebase
  getPtsQueueLengthInfoInSecs(timebase: number) {
    if (!(timebase > 0)) {
      throw new Error('getPtsQueueLengthInfoInSecs requires a per-track timebase (ticks/sec)');
    }
    const size = this.ptsQueue.length;
    if (size <= 0) {
      return { lengthSec: 0, size };
    }
    const lengthSec =
      size < 2
        ? this.avgItemDur.avg / timebase
        : (this.ptsQueue[size - 1] - this.ptsQueue[0]) / timebase;
    return { lengthSec, size };
  }
}
