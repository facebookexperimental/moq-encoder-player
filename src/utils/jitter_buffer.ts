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

// A reordering jitter buffer that runs at the lowest possible latency: on every
// input it releases the whole contiguous run starting at the current playback
// cursor, so when there is no loss nothing is ever held (buffer stays at ~0). It
// only holds objects back when the next expected object is missing, and then for
// at most bufferSizeMs of buffered media -- after which it gives up waiting,
// releases across the gap (flagged as a discontinuity), and resumes.
export class JitterBuffer {
  bufferSizeMs: number;
  elementsList: any[];
  droppedCallback: ((info: any) => void) | undefined;
  totalLengthMs: number;
  numTotalGaps: number;
  numTotalLostStreams: number;
  // Playback cursor: the last released object, and whether it was the last of its
  // group (which decides what the next contiguous object must be).
  lastCorrectGroupId: number | undefined;
  lastCorrectObjId: number | undefined;
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

  // Add one object and return every object that becomes releasable as a result
  // (the contiguous run from the cursor, plus any objects released to keep the
  // wait under bufferSizeMs). Empty when the object only fills, or waits behind,
  // a gap.
  AddItem(
    chunk: any,
    groupId: number,
    objId: number,
    extraData: any,
    isLastInGroup = false,
  ): any[] {
    // Drop anything at or before the cursor: already released, too late to use.
    if (
      this.lastCorrectGroupId !== undefined &&
      this.lastCorrectObjId !== undefined &&
      keyCmp(groupId, objId, this.lastCorrectGroupId, this.lastCorrectObjId) <= 0
    ) {
      this.droppedCallback?.({
        groupId,
        objId,
        firstBufferGroupId: this.lastCorrectGroupId,
        firstBufferObjId: this.lastCorrectObjId,
      });
      return [];
    }

    // Insert in (groupId, objId) order, ignoring exact duplicates already held.
    let inserted = false;
    for (let n = 0; n < this.elementsList.length; n++) {
      const cmp = keyCmp(groupId, objId, this.elementsList[n].groupId, this.elementsList[n].objId);
      if (cmp === 0) {
        this.droppedCallback?.({
          groupId,
          objId,
          firstBufferGroupId: this.elementsList[n].groupId,
          firstBufferObjId: this.elementsList[n].objId,
        });
        return [];
      }
      if (cmp < 0) {
        this.elementsList.splice(n, 0, { chunk, groupId, objId, extraData, isLastInGroup });
        inserted = true;
        break;
      }
    }
    if (!inserted) {
      this.elementsList.push({ chunk, groupId, objId, extraData, isLastInGroup });
    }
    this.totalLengthMs += chunk.duration / 1000;

    return this.drain();
  }

  // Flag the object (groupId, lastObjId) as the last of its group (MoQ
  // end-of-group). For subgroup streams this arrives retroactively -- after the
  // object was added, sometimes after it was released -- so it can unblock a
  // group boundary that was waiting. Returns any objects that become releasable.
  // (Datagrams carry the flag inline via AddItem's isLastInGroup instead.)
  MarkEndOfGroup(groupId: number, lastObjId: number): any[] {
    for (const el of this.elementsList) {
      if (el.groupId === groupId && el.objId === lastObjId) {
        el.isLastInGroup = true;
        return this.drain();
      }
    }
    // The object already left the buffer. If it is the cursor, record that its
    // group ended so the next group's first object counts as contiguous.
    if (groupId === this.lastCorrectGroupId && lastObjId === this.lastCorrectObjId) {
      this.lastWasLastInGroup = true;
      return this.drain();
    }
    return [];
  }

  // Release the contiguous run from the head. Stop at the first discontinuity,
  // unless the buffered media has reached bufferSizeMs -- then stop waiting for
  // the missing object(s), release across the gap (flagged discontinuous), and
  // continue.
  private drain(): any[] {
    const released: any[] = [];
    while (this.elementsList.length > 0) {
      const head = this.elementsList[0];
      if (this.isContiguous(head)) {
        this.releaseHead(false, released);
      } else if (this.totalLengthMs >= this.bufferSizeMs) {
        this.numTotalGaps++;
        this.numTotalLostStreams += this.estimateLoss(head);
        this.releaseHead(true, released);
      } else {
        break;
      }
    }
    return released;
  }

  // Whether `head` is the object expected right after the cursor: the first
  // object of the next group if the cursor ended its group, otherwise the next
  // object in the same group. The very first object (no cursor yet) is contiguous
  // by definition.
  private isContiguous(head: any): boolean {
    if (this.lastCorrectGroupId === undefined || this.lastCorrectObjId === undefined) {
      return true;
    }
    if (this.lastWasLastInGroup) {
      return head.groupId === this.lastCorrectGroupId + 1 && head.objId === 0;
    }
    return head.groupId === this.lastCorrectGroupId && head.objId === this.lastCorrectObjId + 1;
  }

  // Rough loss estimate for the stats UI: object delta within a group, group
  // delta across groups.
  private estimateLoss(head: any): number {
    if (this.lastCorrectGroupId === undefined || this.lastCorrectObjId === undefined) {
      return 0;
    }
    if (head.groupId === this.lastCorrectGroupId) {
      return Math.abs(head.objId - this.lastCorrectObjId);
    }
    return Math.abs(head.groupId - this.lastCorrectGroupId);
  }

  private releaseHead(isDisco: boolean, released: any[]): void {
    const r = this.elementsList.shift();
    r.isDisco = isDisco;
    // Backwards/duplicate keys are dropped on insert, so a released object is
    // never one; keep the field for consumers that check it.
    r.repeatedOrBackwards = false;
    this.lastCorrectGroupId = r.groupId;
    this.lastCorrectObjId = r.objId;
    this.lastWasLastInGroup = r.isLastInGroup === true;
    this.totalLengthMs -= r.chunk.duration / 1000;
    released.push(r);
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
