/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import { JitterBuffer } from '../src/utils/jitter_buffer.js';

// Per-track timebase (ticks/sec) the test timestamps are expressed in (µs).
const TIMEBASE = 1_000_000;

// A minimal chunk stand-in. `timestamp` (PTS) is in microseconds (as WebCodecs
// chunks are); the buffer derives its buffered span from PTS via
// (last - first) / 1000. Ordering tests that never fill past a gap can leave the
// default; only the give-up test needs meaningful, increasing timestamps.
function mkChunk(timestampUs = 0) {
  return { timestamp: timestampUs };
}

const key = (r: any) => `${r.groupId}/${r.objId}`;

describe('JitterBuffer pull-through delivery', () => {
  it('releases each contiguous object immediately, leaving the buffer empty', () => {
    const jb = new JitterBuffer(200, undefined, TIMEBASE);
    expect(jb.AddItem(mkChunk(), 0, 0, undefined).map(key)).toEqual(['0/0']);
    expect(jb.AddItem(mkChunk(), 0, 1, undefined).map(key)).toEqual(['0/1']);
    expect(jb.AddItem(mkChunk(), 0, 2, undefined).map(key)).toEqual(['0/2']);
    const stats = jb.GetStats();
    expect(stats.size).toBe(0);
    expect(stats.totalLengthMs).toBe(0);
    expect(stats.numTotalGaps).toBe(0);
  });

  it('crosses group boundaries with no delay when end-of-group rides inline (datagrams)', () => {
    const jb = new JitterBuffer(200, undefined, TIMEBASE);
    // isLastInGroup = true on every object (one object per group).
    expect(jb.AddItem(mkChunk(), 0, 0, undefined, true).map(key)).toEqual(['0/0']);
    expect(jb.AddItem(mkChunk(), 1, 0, undefined, true).map(key)).toEqual(['1/0']);
    expect(jb.AddItem(mkChunk(), 2, 0, undefined, true).map(key)).toEqual(['2/0']);
    expect(jb.GetStats().size).toBe(0);
    expect(jb.GetStats().numTotalGaps).toBe(0);
  });

  it('holds an out-of-order object and releases the run once the gap fills', () => {
    const jb = new JitterBuffer(200, undefined, TIMEBASE);
    jb.AddItem(mkChunk(), 0, 0, undefined); // released
    expect(jb.AddItem(mkChunk(), 0, 2, undefined)).toEqual([]); // waits for 0/1
    expect(jb.GetStats().size).toBe(1);
    const out = jb.AddItem(mkChunk(), 0, 1, undefined); // fills the gap
    expect(out.map(key)).toEqual(['0/1', '0/2']);
    expect(out.every((r) => !r.isDisco)).toBe(true);
    expect(jb.GetStats().size).toBe(0);
  });

  it('gives up on a gap after bufferSizeMs and releases across it as a discontinuity', () => {
    const jb = new JitterBuffer(5, undefined, TIMEBASE); // give up once the buffered PTS span reaches 5ms
    jb.AddItem(mkChunk(0), 0, 0, undefined); // released, cursor 0/0
    // 0/1 (pts 2000) is missing; later objects pile up behind the gap. Buffered
    // span is (last - first) PTS, so a single held object spans 0ms.
    expect(jb.AddItem(mkChunk(4000), 0, 2, undefined)).toEqual([]); // span 0ms, waits
    expect(jb.AddItem(mkChunk(6000), 0, 3, undefined)).toEqual([]); // span 2ms, waits
    expect(jb.AddItem(mkChunk(8000), 0, 4, undefined)).toEqual([]); // span 4ms, waits
    const out = jb.AddItem(mkChunk(10000), 0, 5, undefined); // span 6ms >= 5 -> give up
    expect(out.map(key)).toEqual(['0/2', '0/3', '0/4', '0/5']);
    expect(out[0].isDisco).toBe(true); // 0/2 bridges the missing 0/1
    expect(out.slice(1).every((r) => !r.isDisco)).toBe(true);
    expect(jb.GetStats().numTotalGaps).toBe(1);
    expect(jb.GetStats().size).toBe(0);
  });

  it('counts a lone held object as ~one average item duration instead of 0ms', () => {
    const jb = new JitterBuffer(30, undefined, TIMEBASE); // give up at 30ms of buffered span
    // Prime the average item duration with a contiguous ~40ms-spaced run.
    jb.AddItem(mkChunk(0), 0, 0, undefined); // released
    jb.AddItem(mkChunk(40000), 0, 1, undefined); // released, cursor 0/1, avg item ~40ms
    // 0/2 is missing; a single later object arrives and is held. Its PTS span is
    // 0 (one item), but the average-duration estimate exceeds 30ms, so the buffer
    // gives up across the gap instead of stalling (which the old span-only code did).
    const out = jb.AddItem(mkChunk(120000), 0, 3, undefined);
    expect(out.map(key)).toEqual(['0/3']);
    expect(out[0].isDisco).toBe(true);
    expect(jb.GetStats().numTotalGaps).toBe(1);
    expect(jb.GetStats().size).toBe(0);
  });

  it('waits at a group boundary until the retroactive end-of-group unblocks it (subgroups)', () => {
    const jb = new JitterBuffer(200, undefined, TIMEBASE);
    jb.AddItem(mkChunk(), 0, 0, undefined); // released, isLastInGroup unknown
    expect(jb.AddItem(mkChunk(), 1, 0, undefined)).toEqual([]); // 1/0 waits: is group 0 done?
    expect(jb.GetStats().size).toBe(1);
    // End-of-group for the already-released 0/0 arrives -> boundary is clean.
    const out = jb.MarkEndOfGroup(0, 0);
    expect(out.map(key)).toEqual(['1/0']);
    expect(out[0].isDisco).toBe(false);
    expect(jb.GetStats().size).toBe(0);
  });

  it('records end-of-group on a still-buffered object for use when it is released', () => {
    const jb = new JitterBuffer(200, undefined, TIMEBASE);
    jb.AddItem(mkChunk(), 0, 0, undefined); // released, cursor 0/0
    jb.AddItem(mkChunk(), 0, 2, undefined); // waits for 0/1; 0/2 buffered
    expect(jb.MarkEndOfGroup(0, 2)).toEqual([]); // flags buffered 0/2, still blocked
    expect(jb.elementsList[0].isLastInGroup).toBe(true);
    const out = jb.AddItem(mkChunk(), 0, 1, undefined); // fills the gap, run drains
    expect(out.map(key)).toEqual(['0/1', '0/2']);
    // 0/2 was flagged last-in-group, so a following group 1 is contiguous.
    expect(jb.AddItem(mkChunk(), 1, 0, undefined).map(key)).toEqual(['1/0']);
    expect(jb.GetStats().numTotalGaps).toBe(0);
  });

  it('drops objects at or before the playback cursor', () => {
    const dropped: any[] = [];
    const jb = new JitterBuffer(200, (info) => dropped.push(info), TIMEBASE);
    jb.AddItem(mkChunk(), 0, 0, undefined);
    jb.AddItem(mkChunk(), 0, 1, undefined); // cursor now 0/1
    expect(jb.AddItem(mkChunk(), 0, 0, undefined)).toEqual([]); // late
    expect(jb.AddItem(mkChunk(), 0, 1, undefined)).toEqual([]); // duplicate of cursor
    expect(dropped.length).toBe(2);
    expect(jb.GetStats().size).toBe(0);
  });

  it('ignores end-of-group markers for objects neither buffered nor at the cursor', () => {
    const jb = new JitterBuffer(200, undefined, TIMEBASE);
    jb.AddItem(mkChunk(), 0, 0, undefined);
    jb.AddItem(mkChunk(), 0, 2, undefined); // 0/2 buffered
    expect(jb.MarkEndOfGroup(9, 9)).toEqual([]);
    expect(jb.elementsList[0].isLastInGroup).toBe(false);
  });

  it('resets all state on Clear', () => {
    const jb = new JitterBuffer(200, undefined, TIMEBASE);
    jb.AddItem(mkChunk(), 0, 0, undefined);
    jb.AddItem(mkChunk(), 0, 2, undefined); // leaves something buffered
    jb.Clear();
    expect(jb.elementsList.length).toBe(0);
    expect(jb.GetStats().size).toBe(0);
    expect(jb.GetStats().totalLengthMs).toBe(0);
    expect(jb.lastCorrectGroupId).toBeUndefined();
    expect(jb.lastWasLastInGroup).toBe(false);
  });
});
