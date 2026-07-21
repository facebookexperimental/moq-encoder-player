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
  // Whether the last released object was the last of its group (its end-of-group
  // was signaled). Decides what the next object must be to stay contiguous.
  lastWasLastInGroup: boolean;

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
    this.lastWasLastInGroup = false;
  }

  // Flag the object (groupId, lastObjId) as the last of its group. The MoQ
  // end-of-group signal for subgroup streams (a MOQ_OBJ_STATUS_END_OF_GROUP
  // status object) is retroactive -- it names the group's last object after that
  // object was already handed to AddItem -- so the flag is set out of band here.
  // (Datagrams carry the flag inline via AddItem's isLastInGroup, so they never
  // call this.) The object is normally still buffered when the signal arrives;
  // if it was already released, record it on the release cursor so the next
  // object (the first of the following group) is not flagged as a discontinuity.
  MarkEndOfGroup(groupId: number, lastObjId: number) {
    for (const el of this.elementsList) {
      if (el.groupId === groupId && el.objId === lastObjId) {
        el.isLastInGroup = true;
        return;
      }
    }
    if (groupId === this.lastCorrectGroupId && lastObjId === this.lastCorrectObjId) {
      this.lastWasLastInGroup = true;
    }
  }

  AddItem(
    chunk: any,
    groupId: number,
    objId: number,
    extraData: any,
    isLastInGroup = false,
  ): any[] {
    // Order by (groupId, objId)
    if (this.elementsList.length <= 0) {
      this.elementsList.push({ chunk, groupId, objId, extraData, isLastInGroup });
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
            this.elementsList.splice(n, 0, { chunk, groupId, objId, extraData, isLastInGroup });
            exit = true;
          }
          n++;
        }
        if (exit === false) {
          this.elementsList.push({ chunk, groupId, objId, extraData, isLastInGroup });
        }
        this.totalLengthMs += chunk.duration / 1000;
      }
    }

    // Release every element that overflows the target size, not just one. A
    // single `if` only drains one element per arrival, so in steady state the
    // buffer stays one-in/one-out and a lowered `bufferSizeMs` (e.g. via
    // UpdateMaxSize) could never shrink the already-accumulated backlog. The
    // `while` drains the excess in one pass so latency drops immediately.
    const released: any[] = [];
    while (this.totalLengthMs >= this.bufferSizeMs && this.elementsList.length > 0) {
      const r = this.elementsList.shift();

      // Flag discontinuities. Given the previous released object, the next one is
      // contiguous when: it opens the next group (objId 0) if that previous object
      // was its group's last; otherwise it is the next object in the same group.
      // Anything else is a discontinuity -- a gap, or an end-of-group that never
      // arrived.
      r.isDisco = false;
      r.repeatedOrBackwards = false;
      if (this.lastCorrectGroupId !== undefined && this.lastCorrectObjId !== undefined) {
        const lastG = this.lastCorrectGroupId;
        const lastO = this.lastCorrectObjId;
        const contiguous = this.lastWasLastInGroup
          ? r.groupId === lastG + 1 && r.objId === 0
          : r.groupId === lastG && r.objId === lastO + 1;
        if (!contiguous) {
          r.isDisco = true;
          this.numTotalGaps++;
          // Rough loss estimate for the stats UI: object delta within a group,
          // group delta across groups.
          if (r.groupId === lastG) {
            this.numTotalLostStreams += Math.abs(r.objId - lastO);
          } else {
            this.numTotalLostStreams += Math.abs(r.groupId - lastG);
          }
          // Repeated or backwards key: do not let it move the cursor backwards.
          if (keyCmp(r.groupId, r.objId, lastG, lastO) <= 0) {
            r.repeatedOrBackwards = true;
          }
        }
      }
      if (!r.repeatedOrBackwards) {
        this.lastCorrectGroupId = r.groupId;
        this.lastCorrectObjId = r.objId;
        this.lastWasLastInGroup = r.isLastInGroup === true;
      }
      this.totalLengthMs -= r.chunk.duration / 1000;
      released.push(r);
    }
    return released;
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
    this.lastWasLastInGroup = false;
  }

  UpdateMaxSize(bufferSizeMs: number) {
    if (bufferSizeMs > 0) {
      this.bufferSizeMs = bufferSizeMs;
    }
  }
}
