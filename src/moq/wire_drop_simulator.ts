/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

// Deterministic-ish helper used to SIMULATE packet loss on the send path. It
// decides, unit by unit, whether the next "wire unit" (a QUIC datagram or a
// subgroup stream, depending on the MoQ→QUIC mapping) should be dropped instead
// of written to the wire. Used by Track (src/moq/moq.ts) for A/V-sync and
// loss-recovery testing; it has no knowledge of media.
//
// The drop always happens AFTER the object's group/object id has been assigned,
// so the receiver observes a real gap (and triggers its loss handling) exactly
// as it would for genuine network loss.

/** How the simulator chooses which units to drop. */
export enum WireDropMode {
  // Never drop (feature disabled).
  None = 'none',
  // Drop a burst after a random gap in [1, interval] units.
  Random = 'random',
  // Drop a burst once every `interval` units (deterministic).
  Fixed = 'fixed',
}

export interface WireDropConfig {
  // 'none' | 'random' | 'fixed' (WireDropMode values). Anything else is treated
  // as 'none'.
  mode: WireDropMode | string;
  // Fixed: drop one burst every `interval` units. Random: the max number of
  // units between bursts (the actual gap is random in [1, interval]).
  interval: number;
  // Number of consecutive units dropped per burst (>= 1).
  burst: number;
}

// True when the config actually drops anything.
export function wireDropConfigIsActive(cfg: WireDropConfig | null | undefined): boolean {
  return cfg != null && normalizeMode(cfg.mode) !== WireDropMode.None;
}

function normalizeMode(mode: WireDropMode | string): WireDropMode {
  if (mode === WireDropMode.Random || mode === WireDropMode.Fixed) {
    return mode;
  }
  return WireDropMode.None;
}

export class WireDropSimulator {
  private readonly mode: WireDropMode;
  // Fixed gap, or the upper bound of the random gap. Always >= 1.
  private readonly interval: number;
  // Consecutive units dropped per burst. Always >= 1.
  private readonly burst: number;

  // Units still to pass before the next burst begins.
  private unitsUntilBurst: number;
  // Units still to drop in the burst currently in progress.
  private burstRemaining = 0;

  constructor(cfg: WireDropConfig) {
    this.mode = normalizeMode(cfg.mode);
    this.interval = Math.max(1, Math.floor(cfg.interval) || 1);
    this.burst = Math.max(1, Math.floor(cfg.burst) || 1);
    this.unitsUntilBurst = this.computeGap();
  }

  // Advance one unit and report whether it should be dropped.
  shouldDrop(): boolean {
    if (this.mode === WireDropMode.None) {
      return false;
    }
    // Already inside a burst: keep dropping until it is exhausted.
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
      // Start a new burst; this unit is its first dropped unit.
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
    if (this.mode === WireDropMode.Random) {
      return 1 + Math.floor(Math.random() * this.interval);
    }
    return this.interval;
  }
}
