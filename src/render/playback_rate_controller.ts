/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

/**
 * Playback-rate controller that keeps audio latency near a target.
 *
 * You feed it the live render-buffer size (`audioRenderBufferMs`, how much audio
 * is currently queued ahead of the speakers, a proxy for latency) and it decides
 * whether playback should speed up, slow down, or run at 1×.
 *
 * It is a hysteresis controller, not a proportional one: it reacts only when the
 * buffer leaves an on-target band, then holds that correction until the buffer
 * has crossed all the way back to the target before returning to 1×. Overshooting
 * to the target (rather than just re-entering the band) avoids oscillating around
 * the edges.
 *
 *   buffer > target·(1 + onTargetPerct)  → speed up, hold until buffer ≤ target
 *   buffer < target·(1 - onTargetPerct)  → slow down, hold until buffer ≥ target
 *   otherwise                            → no change
 *
 * The controller is decision-only: `currentRenderBuffer` returns the new speed to
 * apply (or null when nothing changed) so the caller can forward it to
 * GapTolerantPlayer.setPlaybackSpeed without this class owning the player.
 */

export interface PlaybackRateControllerOptions {
  /** Target latency (ms), i.e. the render-buffer size we steer toward. */
  targetLatencyMs: number;
  /** Half-width of the do-nothing band as a fraction of target, 0 < v < 1. Default 0.2. */
  onTargetPerct?: number;
  /** Rate applied while draining an over-full buffer, 1 < v < 10. Default 1.1. */
  speedUp?: number;
  /** Rate applied while refilling an under-full buffer, 0 < v < 1. Default 0.9. */
  slowDown?: number;
  onLog?: (msg: string) => void;
}

const DEFAULT_ON_TARGET_PERCT = 0.2;
const DEFAULT_SPEED_UP = 1.1;
const DEFAULT_SLOW_DOWN = 0.9;

/** normal = playing at 1×; speedup/slowdown = actively correcting toward target. */
type Mode = 'normal' | 'speedup' | 'slowdown';

export class PlaybackRateController {
  private targetLatencyMs = 0;
  private onTargetPerct = DEFAULT_ON_TARGET_PERCT;
  private speedUp = DEFAULT_SPEED_UP;
  private slowDown = DEFAULT_SLOW_DOWN;
  private onLog?: (msg: string) => void;

  // Band edges cached from the config so currentRenderBuffer() stays a few
  // comparisons; recomputed only when the config changes.
  private upperMs = 0;
  private lowerMs = 0;

  private mode: Mode = 'normal';

  constructor(opts: PlaybackRateControllerOptions) {
    this.updateConfig(opts);
  }

  /**
   * Update any subset of the config at any time (target, band, rates, logger).
   * All provided values are range-checked before anything is applied, so a bad
   * value leaves the controller unchanged. The on-target band is recomputed here
   * (not on every currentRenderBuffer call). The mode is left as-is; a rate
   * change takes audible effect on the next transition.
   */
  updateConfig(opts: Partial<PlaybackRateControllerOptions>): void {
    const targetLatencyMs = opts.targetLatencyMs ?? this.targetLatencyMs;
    const onTargetPerct = opts.onTargetPerct ?? this.onTargetPerct;
    const speedUp = opts.speedUp ?? this.speedUp;
    const slowDown = opts.slowDown ?? this.slowDown;

    if (!(targetLatencyMs > 0)) {
      throw new RangeError(`targetLatencyMs must be > 0, got ${targetLatencyMs}`);
    }
    assertRange('onTargetPerct', onTargetPerct, 0, 1);
    assertRange('speedUp', speedUp, 1, 10);
    assertRange('slowDown', slowDown, 0, 1);

    this.targetLatencyMs = targetLatencyMs;
    this.onTargetPerct = onTargetPerct;
    this.speedUp = speedUp;
    this.slowDown = slowDown;
    if (opts.onLog !== undefined) this.onLog = opts.onLog;

    this.upperMs = targetLatencyMs * (1 + onTargetPerct);
    this.lowerMs = targetLatencyMs * (1 - onTargetPerct);
  }

  /** Retarget at any time; the next currentRenderBuffer() call steers to the new value. */
  setTargetLatency(targetLatencyMs: number): void {
    this.updateConfig({ targetLatencyMs });
  }

  /** Snap back to 1x/normal, e.g. when compensation is toggled off. */
  reset(): void {
    this.mode = 'normal';
  }

  /** The playback speed currently commanded by the controller. */
  getSpeed(): number {
    switch (this.mode) {
      case 'speedup':
        return this.speedUp;
      case 'slowdown':
        return this.slowDown;
      default:
        return 1;
    }
  }

  /**
   * Feed the latest render-buffer size and update the correction. Returns the new
   * playback speed to apply, or null when the command is unchanged (so the caller
   * only touches the player on an actual transition).
   */
  currentRenderBuffer(audioRenderBufferMs: number): number | null {
    // Already correcting: hold the rate until the buffer overshoots back to target.
    if (this.mode === 'speedup') {
      return audioRenderBufferMs <= this.targetLatencyMs ? this.enter('normal') : null;
    }
    if (this.mode === 'slowdown') {
      return audioRenderBufferMs >= this.targetLatencyMs ? this.enter('normal') : null;
    }

    // On target: correct only once the buffer leaves the (precomputed) band.
    if (audioRenderBufferMs > this.upperMs) return this.enter('speedup');
    if (audioRenderBufferMs < this.lowerMs) return this.enter('slowdown');
    return null;
  }

  private enter(mode: Mode): number {
    this.mode = mode;
    const speed = this.getSpeed();
    this.onLog?.(`Playback rate -> ${speed}x (${mode}), target ${this.targetLatencyMs}ms`);
    return speed;
  }
}

/** Throw unless min < value < max (strict, and rejects NaN). */
function assertRange(name: string, value: number, min: number, max: number): void {
  if (!(value > min && value < max)) {
    throw new RangeError(`${name} must be in (${min}, ${max}), got ${value}`);
  }
}
