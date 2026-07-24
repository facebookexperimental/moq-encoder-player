/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import { AvgLastNItems } from '../utils/avg_last_n_items.js';

const MAX_ELEMENTS_RENDERER = 60;

export class VideoRenderBuffer {
  timebase: number;
  elementsList: any[];
  totalDiscarded: number;
  // Rolling average of recent inter-frame timestamp deltas (in timebase ticks),
  // used to estimate one frame's duration when fewer than two are buffered.
  avgItemDur: AvgLastNItems;
  lastItemTs: number | undefined;

  // `timebase` is the per-track MoQ-MI timebase (ticks per second) the video
  // timestamps are expressed in. Mandatory -- there is no safe default.
  constructor(timebase: number) {
    if (!(timebase > 0)) {
      throw new Error('VideoRenderBuffer requires a per-track timebase (ticks/sec) from the MoQ track');
    }
    this.timebase = timebase;
    this.elementsList = [];
    this.totalDiscarded = 0;
    this.avgItemDur = new AvgLastNItems();
    this.lastItemTs = undefined;
  }

  // Buffered span in ms, derived from the held frames' timestamps instead of a
  // per-frame duration. Timestamps are in `timebase` ticks per second, so
  // tsMs = ts * 1000 / timebase. elementsList is ordered by timestamp, so the span
  // is last - first. With fewer than two frames there is no span to measure, so
  // fall back to the average item duration (one frame's worth) instead of 0.
  private bufferedSpanMs(): number {
    const n = this.elementsList.length;
    if (n <= 0) {
      return 0;
    }
    if (n < 2) {
      // A single buffered frame has no span; estimate it as one average duration.
      return (this.avgItemDur.avg * 1000) / this.timebase;
    }
    return (
      ((this.elementsList[n - 1].timestamp - this.elementsList[0].timestamp) * 1000) /
      this.timebase
    );
  }

  AddItem(vFrame: any) {
    // When full, evict the OLDEST frame so the buffer always holds the most recent
    // frames. This matters when the rAF render loop is paused (e.g. the page is
    // hidden) while the decoder keeps producing: keeping the newest frames means the
    // buffered content stays aligned with the advancing audio clock instead of
    // getting stuck on a backlog of stale frames.
    if (this.elementsList.length >= MAX_ELEMENTS_RENDERER) {
      const oldFrame = this.elementsList.shift();
      this.totalDiscarded++;
      oldFrame.close();
    }
    // Add at the end (ordered by timestamp)
    this.elementsList.push(vFrame);
    // Feed the inter-frame delta (positive only) to the rolling average so a lone
    // buffered frame can be sized later.
    if (this.lastItemTs !== undefined) {
      const delta = vFrame.timestamp - this.lastItemTs;
      if (delta > 0) {
        this.avgItemDur.Add(delta);
      }
    }
    this.lastItemTs = vFrame.timestamp;
    return true;
  }

  GetFirstElement() {
    const ret: any = {
      vFrame: null,
      discarded: 0,
      totalDiscarded: 0,
      queueSize: this.elementsList.length,
      queueLengthMs: this.bufferedSpanMs(),
    };
    if (this.elementsList.length > 0) {
      ret.vFrame = this.elementsList.shift();
      ret.queueSize = this.elementsList.length;
      ret.queueLengthMs = this.bufferedSpanMs();
    }

    return ret;
  }

  GetItemByTs(ts: number) {
    const ret: any = {
      vFrame: null,
      discarded: 0,
      totalDiscarded: this.totalDiscarded,
      queueSize: this.elementsList.length,
      queueLengthMs: this.bufferedSpanMs(),
    };

    if (this.elementsList.length <= 0 || ts < this.elementsList[0].timestamp) {
      return ret;
    }

    let exit = false;
    let lastFrameInThePastIndex = 0;
    while (lastFrameInThePastIndex < this.elementsList.length && exit === false) {
      if (this.elementsList[lastFrameInThePastIndex].timestamp >= ts) {
        exit = true;
      } else {
        lastFrameInThePastIndex++;
      }
    }

    // Remove items from 0..(lastFrameInThePastIndex-1)
    for (let n = 0; n < lastFrameInThePastIndex - 1; n++) {
      const vFrame = this.elementsList.shift();
      ret.discarded++;
      vFrame.close();
    }

    if (this.elementsList.length > 0) {
      ret.vFrame = this.elementsList.shift();
    }

    this.totalDiscarded += ret.discarded;
    ret.totalDiscarded = this.totalDiscarded;
    ret.queueSize = this.elementsList.length;
    ret.queueLengthMs = this.bufferedSpanMs();

    return ret;
  }

  Clear() {
    while (this.elementsList.length > 0) {
      const vFrame = this.elementsList.shift();
      vFrame.close();
    }
    this.totalDiscarded = 0;
    this.avgItemDur.Clear();
    this.lastItemTs = undefined;
  }
}
