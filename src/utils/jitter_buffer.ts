/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

const DEFAULT_BUFFER_SIZE_MS = 200;

// Ordering key: MoQ transport-native (groupId, objId). groupId increments per
// group; objId increments within a group (0-based). Lexicographic comparison of
// the pair reproduces the publisher's total send order.
function keyCmp(aGroup: number, aObj: number, bGroup: number, bObj: number): number {
  if (aGroup !== bGroup) {
    return aGroup - bGroup;
  }
  return aObj - bObj;
}

export class JitterBuffer {
  bufferSizeMs: number;
  elementsList: any[];
  droppedCallback: ((info: any) => void) | undefined;
  totalLengthMs: number;
  numTotalGaps: number;
  numTotalLostStreams: number;
  lastCorrectGroupId: number | undefined;
  lastCorrectObjId: number | undefined;

  constructor(maxSizeMs?: number, droppedCallback?: (info: any) => void) {
    this.bufferSizeMs = DEFAULT_BUFFER_SIZE_MS;
    if (maxSizeMs !== undefined && maxSizeMs > 0) {
      this.bufferSizeMs = maxSizeMs;
    }
    this.elementsList = [];

    this.droppedCallback = droppedCallback;
    this.totalLengthMs = 0;
    this.numTotalGaps = 0;
    this.numTotalLostStreams = 0;
    this.lastCorrectGroupId = undefined;
    this.lastCorrectObjId = undefined;
  }

  AddItem(chunk: any, groupId: number, objId: number, extraData: any) {
    let r;
    // Order by (groupId, objId)
    if (this.elementsList.length <= 0) {
      this.elementsList.push({ chunk, groupId, objId, extraData });
      this.totalLengthMs += chunk.duration / 1000;
    } else {
      const head = this.elementsList[0];
      // Anything at or before the head has arrived too late -> drop
      if (keyCmp(groupId, objId, head.groupId, head.objId) <= 0) {
        if (this.droppedCallback !== undefined) {
          this.droppedCallback({
            groupId,
            objId,
            firstBufferGroupId: head.groupId,
            firstBufferObjId: head.objId,
          });
        }
      } else {
        let n = 0;
        let exit = false;
        while (n < this.elementsList.length && !exit) {
          const el = this.elementsList[n];
          if (keyCmp(groupId, objId, el.groupId, el.objId) < 0) {
            this.elementsList.splice(n, 0, { chunk, groupId, objId, extraData });
            exit = true;
          }
          n++;
        }
        if (exit === false) {
          this.elementsList.push({ chunk, groupId, objId, extraData });
        }
        this.totalLengthMs += chunk.duration / 1000;
      }
    }

    // Get 1st element if jitter buffer full
    if (this.totalLengthMs >= this.bufferSizeMs) {
      r = this.elementsList.shift();

      // Check for discontinuities in the stream
      r.isDisco = false;
      r.repeatedOrBackwards = false;
      if (this.lastCorrectGroupId !== undefined && this.lastCorrectObjId !== undefined) {
        const lastG = this.lastCorrectGroupId;
        const lastO = this.lastCorrectObjId;
        // Contiguous: next object in the same group, or the first object of the
        // next group (a new group always restarts objId at 0).
        const contiguous =
          (r.groupId === lastG && r.objId === lastO + 1) ||
          (r.groupId === lastG + 1 && r.objId === 0);
        if (!contiguous) {
          r.isDisco = true;
          this.numTotalGaps++;
          // Approximate loss: object gaps within a group are exact; across group
          // boundaries the previous group's tail count is unknown, so a whole
          // skipped group counts as a single lost unit.
          if (r.groupId === lastG) {
            this.numTotalLostStreams += Math.abs(r.objId - lastO);
          } else {
            this.numTotalLostStreams += Math.abs(r.groupId - lastG);
          }

          // Check for repeated and backwards keys
          if (keyCmp(r.groupId, r.objId, lastG, lastO) <= 0) {
            r.repeatedOrBackwards = true;
          } else {
            this.lastCorrectGroupId = r.groupId;
            this.lastCorrectObjId = r.objId;
          }
        } else {
          this.lastCorrectGroupId = r.groupId;
          this.lastCorrectObjId = r.objId;
        }
      } else {
        this.lastCorrectGroupId = r.groupId;
        this.lastCorrectObjId = r.objId;
      }
      this.totalLengthMs -= r.chunk.duration / 1000;
    }
    return r;
  }

  GetStats() {
    return {
      numTotalGaps: this.numTotalGaps,
      numTotalLostStreams: this.numTotalLostStreams,
      totalLengthMs: this.totalLengthMs,
      size: this.elementsList.length,
      currentMaSizeMs: this.bufferSizeMs,
    };
  }

  Clear() {
    this.elementsList = [];
    this.totalLengthMs = 0;
    this.numTotalGaps = 0;
    this.numTotalLostStreams = 0;
    this.lastCorrectGroupId = undefined;
    this.lastCorrectObjId = undefined;
  }

  UpdateMaxSize(bufferSizeMs: number) {
    if (bufferSizeMs > 0) {
      this.bufferSizeMs = bufferSizeMs;
    }
  }
}
