/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

export class TsQueue {
  elementsList: any[];
  totalDiscarded: number;
  ptsQueue: Array<{ ts: number; d: number }>;

  constructor() {
    this.elementsList = [];
    this.totalDiscarded = 0;
    this.ptsQueue = [];
  }

  clear() {
    this.ptsQueue = [];
  }

  addToPtsQueue(ts: number, d: number) {
    this.ptsQueue.push({ ts, d });
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

  getPtsQueueLengthInfo() {
    const r = { lengthMs: 0, size: this.ptsQueue.length };
    this.ptsQueue.forEach((element) => {
      r.lengthMs += element.d / 1000;
    });
    return r;
  }
}
