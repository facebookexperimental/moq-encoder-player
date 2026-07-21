/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import {
  WireDropSimulator,
  WireDropMode,
  wireDropConfigIsActive,
} from '../src/moq/wire_drop_simulator.js';

// Run the simulator over `count` units and return the indexes that were dropped.
function droppedIndexes(sim: WireDropSimulator, count: number): number[] {
  const dropped: number[] = [];
  for (let i = 0; i < count; i++) {
    if (sim.shouldDrop()) {
      dropped.push(i);
    }
  }
  return dropped;
}

describe('wireDropConfigIsActive', () => {
  it('is false for none / null / unknown modes', () => {
    expect(wireDropConfigIsActive(null)).toBe(false);
    expect(wireDropConfigIsActive(undefined)).toBe(false);
    expect(wireDropConfigIsActive({ mode: WireDropMode.None, interval: 10, burst: 1 })).toBe(false);
    expect(wireDropConfigIsActive({ mode: 'garbage', interval: 10, burst: 1 })).toBe(false);
  });

  it('is true for random / fixed', () => {
    expect(wireDropConfigIsActive({ mode: WireDropMode.Random, interval: 10, burst: 1 })).toBe(true);
    expect(wireDropConfigIsActive({ mode: WireDropMode.Fixed, interval: 10, burst: 1 })).toBe(true);
  });
});

describe('WireDropSimulator - none', () => {
  it('never drops', () => {
    const sim = new WireDropSimulator({ mode: WireDropMode.None, interval: 2, burst: 5 });
    expect(droppedIndexes(sim, 100)).toEqual([]);
  });

  it('treats unknown modes as none', () => {
    const sim = new WireDropSimulator({ mode: 'nope', interval: 2, burst: 5 });
    expect(droppedIndexes(sim, 100)).toEqual([]);
  });
});

describe('WireDropSimulator - fixed', () => {
  it('drops one unit every `interval` units', () => {
    const sim = new WireDropSimulator({ mode: WireDropMode.Fixed, interval: 10, burst: 1 });
    // Units 9, 19, 29 ... (the 10th of each cycle).
    expect(droppedIndexes(sim, 30)).toEqual([9, 19, 29]);
  });

  it('drops a consecutive burst then waits the full interval again', () => {
    const sim = new WireDropSimulator({ mode: WireDropMode.Fixed, interval: 10, burst: 3 });
    // First burst at 9,10,11; the interval is recounted after the burst, so the
    // next burst starts 10 units after it ends: 21,22,23.
    expect(droppedIndexes(sim, 25)).toEqual([9, 10, 11, 21, 22, 23]);
  });

  it('clamps interval and burst to >= 1', () => {
    const sim = new WireDropSimulator({ mode: WireDropMode.Fixed, interval: 0, burst: 0 });
    // interval 1 => drop every unit.
    expect(droppedIndexes(sim, 5)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('WireDropSimulator - random', () => {
  it('spaces single drops by a random period within [1, interval]', () => {
    const interval = 5;
    const sim = new WireDropSimulator({ mode: WireDropMode.Random, interval, burst: 1 });
    const dropped = droppedIndexes(sim, 2000);
    expect(dropped.length).toBeGreaterThan(0);

    // With burst=1 each drop is isolated; the period between consecutive drops
    // is the random gap, which must stay within [1, interval].
    const periods = new Set<number>();
    for (let i = 1; i < dropped.length; i++) {
      const period = dropped[i] - dropped[i - 1];
      expect(period).toBeGreaterThanOrEqual(1);
      expect(period).toBeLessThanOrEqual(interval);
      periods.add(period);
    }
    // Over 2000 units the randomness should exercise more than one period.
    expect(periods.size).toBeGreaterThan(1);
  });

  it('drops in bursts that are multiples of `burst` consecutive units', () => {
    const sim = new WireDropSimulator({ mode: WireDropMode.Random, interval: 8, burst: 3 });
    const dropped = droppedIndexes(sim, 2000);
    expect(dropped.length).toBeGreaterThan(0);

    // Group the drops into runs of consecutive indexes. Abutting bursts merge
    // into a longer run, so each run's length must be a multiple of the burst
    // size — except the last run, which may be truncated by the unit limit.
    const runLengths: number[] = [];
    for (let i = 0; i < dropped.length; ) {
      let runLen = 1;
      while (i + runLen < dropped.length && dropped[i + runLen] === dropped[i + runLen - 1] + 1) {
        runLen++;
      }
      runLengths.push(runLen);
      i += runLen;
    }
    for (let r = 0; r < runLengths.length - 1; r++) {
      expect(runLengths[r] % 3).toBe(0);
    }
    expect(runLengths.length).toBeGreaterThan(0);
  });
});
