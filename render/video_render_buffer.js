/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

// Reduced from 60 to 30 to prevent excessive buffering
// This matches the frame dropping threshold in index.html
const MAX_ELEMENTS_RENDERER = 30

export class VideoRenderBuffer {
  constructor () {
    this.elementsList = []
    this.totalDiscarded = 0

    this.totalLengthMs = 0
  }

  AddItem (vFrame) {
    let r = true
    if (this.elementsList.length < MAX_ELEMENTS_RENDERER) {
      // Add at the end (ordered by timestamp)
      this.elementsList.push(vFrame)

      this.totalLengthMs += vFrame.duration / 1000
    } else {
      r = false
    }
    return r
  }

  GetFirstElement () {
    const ret = { vFrame: null, discarded: 0, totalDiscarded: 0, queueSize: this.elementsList.length, queueLengthMs: this.totalLengthMs }
    if (this.elementsList.length > 0) {
      ret.vFrame = this.elementsList.shift()
      this.totalLengthMs -= ret.vFrame.duration / 1000
      ret.queueSize = this.elementsList.length
      ret.queueLengthMs = this.totalLengthMs
    }

    return ret
  }

  GetItemByTs (ts) {
    const ret = { vFrame: null, discarded: 0, totalDiscarded: this.totalDiscarded, queueSize: this.elementsList.length, queueLengthMs: this.totalLengthMs }
    
    if (this.elementsList.length <= 0 || ts < this.elementsList[0].timestamp) {
      return ret
    }
    
    let exit = false
    let lastFrameInThePastIndex = 0
    while ((lastFrameInThePastIndex < this.elementsList.length) && (exit === false)) {
      if (this.elementsList[lastFrameInThePastIndex].timestamp >= ts) {
        exit = true
      } else {
        lastFrameInThePastIndex++
      }
    }

    // Remove items from 0..(lastFrameInThePastIndex-1)
    for (let n = 0; n < (lastFrameInThePastIndex - 1); n++) {
      const vFrame = this.elementsList.shift()
      ret.discarded++
      this.totalLengthMs -= vFrame.duration / 1000
      vFrame.close()
    }

    if (this.elementsList.length > 0) {
      ret.vFrame = this.elementsList.shift()
      this.totalLengthMs -= ret.vFrame.duration / 1000
    }

    this.totalDiscarded += ret.discarded
    ret.totalDiscarded = this.totalDiscarded
    ret.queueSize = this.elementsList.length
    ret.queueLengthMs = this.totalLengthMs
    
    return ret
  }

  Clear () {
    while (this.elementsList.length > 0) {
      const vFrame = this.elementsList.shift()
      vFrame.close()
    }
    this.totalLengthMs = 0
    this.totalDiscarded = 0
  }
}
