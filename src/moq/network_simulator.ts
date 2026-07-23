/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

// Send-path NETWORK-IMPAIRMENT simulators, used for A/V-sync and loss-recovery
// testing. They operate on abstract "wire units" (a QUIC datagram or a subgroup
// stream, depending on the MoQ→QUIC mapping) and have no knowledge of media.
// Used by Track (src/moq/moq.ts).
//
// Two impairments share one scheduling engine (BurstScheduler), which decides
// unit by unit whether the current unit falls inside a periodic "burst":
//   - WireDropSimulator: DROPS the burst (simulated packet loss). The drop
//     happens AFTER ids are assigned, so the receiver observes a real gap.
//   - WireHoldSimulator: HOLDS the burst in a buffer and releases it all at
//     once when the buffer fills (simulated slowness / stall-then-clump jitter).
//     Because live media is continuous, later units keep arriving and naturally
//     flush the buffer.

/** How a simulator chooses which units fall inside a burst. */
export enum BurstMode {
  // Never affect anything (feature disabled).
  None = 'none',
  // Affect a burst after a random gap in [1, interval] units.
  Random = 'random',
  // Affect a burst once every `interval` units (deterministic).
  Fixed = 'fixed',
}

/** Shared config shape for both impairments (drop and hold). */
export interface BurstConfig {
  // 'none' | 'random' | 'fixed' (BurstMode values). Anything else is treated
  // as 'none'.
  mode: BurstMode | string;
  // Fixed: one burst every `interval` units. Random: the max number of units
  // between bursts (the actual gap is random in [1, interval]).
  interval: number;
  // Number of consecutive units per burst (>= 1).
  burst: number;
}

// True when the config actually does something (mode !== none).
export function burstConfigIsActive(cfg: BurstConfig | null | undefined): boolean {
  return cfg != null && normalizeMode(cfg.mode) !== BurstMode.None;
}

function normalizeMode(mode: BurstMode | string): BurstMode {
  if (mode === BurstMode.Random || mode === BurstMode.Fixed) {
    return mode;
  }
  return BurstMode.None;
}

// Decides, unit by unit, whether the current unit belongs to a burst of `burst`
// consecutive units, spaced `interval` units apart (fixed) or at random gaps in
// [1, interval] (random). Shared by both impairments.
class BurstScheduler {
  private readonly mode: BurstMode;
  // Fixed gap, or the upper bound of the random gap. Always >= 1.
  private readonly interval: number;
  // Consecutive units per burst. Always >= 1.
  private readonly burst: number;

  // Units still to pass before the next burst begins.
  private unitsUntilBurst: number;
  // Units still remaining in the burst currently in progress.
  private burstRemaining = 0;

  constructor(cfg: BurstConfig) {
    this.mode = normalizeMode(cfg.mode);
    this.interval = Math.max(1, Math.floor(cfg.interval) || 1);
    this.burst = Math.max(1, Math.floor(cfg.burst) || 1);
    this.unitsUntilBurst = this.computeGap();
  }

  // Consecutive units per burst (>= 1). Lets a hold buffer know when it is full.
  get burstSize(): number {
    return this.burst;
  }

  // Advance one unit and report whether it belongs to the current burst.
  next(): boolean {
    if (this.mode === BurstMode.None) {
      return false;
    }
    // Already inside a burst: keep going until it is exhausted.
    if (this.burstRemaining > 0) {
      this.burstRemaining--;
      if (this.burstRemaining === 0) {
        this.unitsUntilBurst = this.computeGap();
      }
      return true;
    }
    // Between bursts: count down the gap.
    this.unitsUntilBurst--;
    if (this.unitsUntilBurst <= 0) {
      // Start a new burst; this unit is its first.
      this.burstRemaining = this.burst - 1;
      if (this.burstRemaining === 0) {
        this.unitsUntilBurst = this.computeGap();
      }
      return true;
    }
    return false;
  }

  // Units to pass before the next burst: fixed `interval`, or random in
  // [1, interval] for random mode.
  private computeGap(): number {
    if (this.mode === BurstMode.Random) {
      return 1 + Math.floor(Math.random() * this.interval);
    }
    return this.interval;
  }
}

// ---- Simulated packet loss (drop) -----------------------------------------

/** Config alias kept for readability at drop call sites. */
export type WireDropConfig = BurstConfig;

// True when the drop config actually drops anything.
export const wireDropConfigIsActive = burstConfigIsActive;

// Backwards-compatible alias: drop code refers to the modes as WireDropMode.
export { BurstMode as WireDropMode };

export class WireDropSimulator {
  private readonly scheduler: BurstScheduler;

  constructor(cfg: WireDropConfig) {
    this.scheduler = new BurstScheduler(cfg);
  }

  // Advance one unit and report whether it should be dropped.
  shouldDrop(): boolean {
    return this.scheduler.next();
  }
}

// ---- Simulated slowness (hold) --------------------------------------------

/** Config alias kept for readability at hold call sites. */
export type WireHoldConfig = BurstConfig;

// True when the hold config actually holds anything.
export const wireHoldConfigIsActive = burstConfigIsActive;

/**
 * Simulates network slowness by HOLDING bursts of consecutive units in a buffer
 * and releasing them together once the buffer is full, producing a
 * stall-then-clump pattern that stresses A/V sync and the receiver jitter
 * buffer. Units outside a burst pass straight through (the buffer is empty
 * between bursts by construction). Generic over the unit type so it stays media-
 * and transport-agnostic.
 */
export class WireHoldSimulator<T> {
  private readonly scheduler: BurstScheduler;
  // Held units awaiting release; grows to at most `burst` before flushing.
  private buffer: T[] = [];

  constructor(cfg: WireHoldConfig) {
    this.scheduler = new BurstScheduler(cfg);
  }

  // Offer one unit and get back the units to send NOW, in order. Returns an
  // empty array while the current burst is still filling the buffer, the flushed
  // burst when it fills, or the unit itself when it is not being held.
  offer(item: T): T[] {
    if (!this.scheduler.next()) {
      // Not in a burst: pass straight through (the buffer is empty here).
      return [item];
    }
    // In a burst: hold the unit until the buffer is full, then release it whole.
    this.buffer.push(item);
    if (this.buffer.length < this.scheduler.burstSize) {
      return [];
    }
    return this.flush();
  }

  // Release everything still buffered (e.g. on config change or close) so no
  // unit is stranded when the continuous stream stops.
  flush(): T[] {
    const held = this.buffer;
    this.buffer = [];
    return held;
  }
}
