/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import { JitterBuffer } from '../src/utils/jitter_buffer.js';

// A minimal chunk stand-in. `duration` is in microseconds (as WebCodecs chunks
// are); the buffer converts it to ms via duration/1000.
function mkChunk(durationUs = 2000) {
  return { duration: durationUs };
}

// Play a sequence of objects through a buffer that releases with a one-item
// delay (bufferSizeMs = 2 vs 1ms per item). The delay matters because the MoQ
// end-of-group signal is retroactive: `last: true` calls MarkEndOfGroup right
// after the object is added, which is only observable while it is still buffered
// -- exactly how it works at runtime (the signal trails by microseconds, the
// object sits in the buffer for bufferSizeMs). Returns every released object; the
// last object added stays buffered, so add a trailing object to observe a
// boundary.
// `inline: true` passes isLastInGroup=true to AddItem (the datagram path, no
// MarkEndOfGroup call). `last: true` calls MarkEndOfGroup afterwards (the
// retroactive subgroup path).
function play(events: Array<{ g: number; o: number; last?: boolean; inline?: boolean }>) {
  const jb = new JitterBuffer(2);
  const released: any[] = [];
  for (const ev of events) {
    released.push(...jb.AddItem(mkChunk(1000), ev.g, ev.o, undefined, ev.inline === true));
    if (ev.last) {
      jb.MarkEndOfGroup(ev.g, ev.o);
    }
  }
  const find = (g: number, o: number) =>
    released.find((r) => r.groupId === g && r.objId === o);
  return { jb, released, find };
}

describe('JitterBuffer discontinuity detection', () => {
  it('flags no discontinuity for objects contiguous within a group', () => {
    const { jb, find } = play([
      { g: 0, o: 0 },
      { g: 0, o: 1 },
      { g: 0, o: 2 },
      { g: 0, o: 3 }, // trailing, to flush (0,2)
    ]);
    expect(find(0, 0).isDisco).toBe(false);
    expect(find(0, 1).isDisco).toBe(false);
    expect(find(0, 2).isDisco).toBe(false);
    expect(jb.GetStats().numTotalGaps).toBe(0);
    expect(jb.GetStats().numTotalLostStreams).toBe(0);
  });

  it('flags a gap for a missing object within a group', () => {
    const { jb, find } = play([
      { g: 0, o: 0 },
      { g: 0, o: 3 }, // objects 1 and 2 missing
      { g: 0, o: 4 }, // trailing, to flush (0,3)
    ]);
    expect(find(0, 3).isDisco).toBe(true);
    expect(jb.GetStats().numTotalGaps).toBe(1);
    expect(jb.GetStats().numTotalLostStreams).toBe(3); // objId delta 3 - 0
  });

  it('does not flag a clean group boundary once end-of-group is known', () => {
    const { jb, find } = play([
      { g: 0, o: 0 },
      { g: 0, o: 1, last: true }, // group 0 ended at object 1
      { g: 1, o: 0 },
      { g: 1, o: 1 }, // trailing, to flush (1,0)
    ]);
    expect(find(0, 1).isDisco).toBe(false);
    expect(find(1, 0).isDisco).toBe(false);
    expect(jb.GetStats().numTotalGaps).toBe(0);
  });

  it('flags a group boundary when the end-of-group never arrived', () => {
    // No `last` on (0,1): the buffer expects (0,2) next, so the (1,0) restart is
    // a discontinuity (a missing end-of-group is treated as one).
    const { jb, find } = play([
      { g: 0, o: 0 },
      { g: 0, o: 1 },
      { g: 1, o: 0 },
      { g: 1, o: 1 }, // trailing, to flush (1,0)
    ]);
    expect(find(1, 0).isDisco).toBe(true);
    expect(jb.GetStats().numTotalGaps).toBe(1);
  });

  it('flags whole skipped groups even when the previous group ended cleanly', () => {
    const { jb, find } = play([
      { g: 0, o: 0, last: true }, // group 0 complete
      { g: 3, o: 0 }, // groups 1 and 2 skipped
      { g: 3, o: 1 }, // trailing, to flush (3,0)
    ]);
    expect(find(3, 0).isDisco).toBe(true);
    expect(jb.GetStats().numTotalGaps).toBe(1);
  });

  it('marks repeated/backwards keys and does not advance the cursor', () => {
    // Immediate-drain buffer: each AddItem releases its own object.
    const jb = new JitterBuffer(1);
    jb.AddItem(mkChunk(), 0, 1, undefined);
    const r = jb.AddItem(mkChunk(), 0, 1, undefined); // repeat
    expect(r[0].repeatedOrBackwards).toBe(true);
    expect(r[0].isDisco).toBe(true);
    // Cursor stayed at (0,1) rather than moving backwards.
    expect(jb.lastCorrectObjId).toBe(1);
  });

  it('treats the inline isLastInGroup flag (datagrams) as a clean group boundary', () => {
    // Datagrams are one object per group and pass isLastInGroup inline, so no
    // MarkEndOfGroup call is needed.
    const { jb, find } = play([
      { g: 0, o: 0, inline: true },
      { g: 1, o: 0, inline: true },
      { g: 2, o: 0, inline: true }, // trailing, to flush (1,0)
    ]);
    expect(find(0, 0).isDisco).toBe(false);
    expect(find(1, 0).isDisco).toBe(false);
    expect(jb.GetStats().numTotalGaps).toBe(0);
  });

  it('applies a late end-of-group marker to the already-released last object', () => {
    // Immediate-drain buffer: (0,0) is released before its end-of-group arrives.
    const jb = new JitterBuffer(1);
    jb.AddItem(mkChunk(), 0, 0, undefined); // released now
    jb.MarkEndOfGroup(0, 0); // late: object already gone, matches release cursor
    const r = jb.AddItem(mkChunk(), 1, 0, undefined); // first object of next group
    expect(r[0].isDisco).toBe(false);
    expect(jb.GetStats().numTotalGaps).toBe(0);
  });

  it('flags the next group when a released object never got its end-of-group', () => {
    // Same as above but without the marker: the boundary is a discontinuity.
    const jb = new JitterBuffer(1);
    jb.AddItem(mkChunk(), 0, 0, undefined);
    const r = jb.AddItem(mkChunk(), 1, 0, undefined);
    expect(r[0].isDisco).toBe(true);
    expect(jb.GetStats().numTotalGaps).toBe(1);
  });

  it('ignores end-of-group markers for objects not buffered', () => {
    const jb = new JitterBuffer(2);
    jb.AddItem(mkChunk(1000), 0, 0, undefined);
    jb.MarkEndOfGroup(5, 5); // no such object buffered
    expect(jb.elementsList[0].isLastInGroup).toBe(false);
  });

  it('resets all state on Clear', () => {
    const jb = new JitterBuffer(2);
    jb.AddItem(mkChunk(1000), 0, 0, undefined);
    jb.MarkEndOfGroup(0, 0);
    jb.Clear();
    expect(jb.elementsList.length).toBe(0);
    expect(jb.GetStats().numTotalGaps).toBe(0);
    expect(jb.lastCorrectGroupId).toBeUndefined();
    expect(jb.lastWasLastInGroup).toBe(false);
  });
});
