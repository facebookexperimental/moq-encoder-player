/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

export class TimeBufferChecker {
  constructor (mediaType, isVerbose) {
    this.mediaType = mediaType
    this.elementsList = []
    this.isVerbose = false
    if (isVerbose === true) {
      this.isVerbose = true
    }
  }

  AddItem (item) {
    if (('ts' in item) && ('clkms' in item)) {
      // Add at the end
      this.elementsList.push(item)
      if (this.isVerbose) {
        console.log(`TimeBufferChecker[${this.mediaType}] Added item: ${JSON.stringify(item)}, list: ${JSON.stringify(this.elementsList)}`)
      }
    }
  }

  GetItemByTs (ts, useExact) {
    let ret = { valid: false, ts: -1, compensatedTs: -1, estimatedDuration: -1, clkms: -1 }
    let i = 0
    let indexPastTs = -1
    let removedElements = 0

    // elementsList is sorted by arrival order
    while (i < this.elementsList.length) {
      if (useExact === true) {
        if (this.elementsList[i].ts === ts) {
          indexPastTs = i
        }
      } else {
        if (ts >= this.elementsList[i].ts) {
          indexPastTs = i
        } else if (ts < this.elementsList[i].ts) {
          break
        }
      }
      i++
    }
    if (indexPastTs >= 0) {
      ret = this.elementsList[indexPastTs]
      ret.valid = true
      removedElements = Math.min(indexPastTs + 1, this.elementsList.length)
      this.elementsList = this.elementsList.slice(indexPastTs + 1)
    }
    if (this.isVerbose) {
      console.log(`TimeBufferChecker[${this.mediaType}] removedElements: ${removedElements}, elements list: ${this.elementsList.length}, retTs: ${(ret === undefined) ? 'undefined' : JSON.stringify(ret)}, asked: ${ts}, list: ${JSON.stringify(this.elementsList)}`)
    }

    return ret
  }

  Clear () {
    this.elementsList = []
  }
}
