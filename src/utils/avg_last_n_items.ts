/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

const DEFAULT_WINDOW_SIZE = 10;

// Rolling average of the last N added values, whatever they represent. Keeps only
// the most recent N and exposes their mean in `avg` (0 when empty).
export class AvgLastNItems {
  private windowSize: number;
  private items: number[];
  avg: number;

  constructor(windowSize = DEFAULT_WINDOW_SIZE) {
    this.windowSize = windowSize;
    this.items = [];
    this.avg = 0;
  }

  Add(item: number): void {
    this.items.push(item);
    if (this.items.length > this.windowSize) {
      this.items.shift();
    }
    this.avg = this.items.reduce((acc, v) => acc + v, 0) / this.items.length;
  }

  Clear(): void {
    this.items = [];
    this.avg = 0;
  }
}
