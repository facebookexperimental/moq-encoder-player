/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import { PlaybackRateController } from '../src/render/playback_rate_controller.js';

// Defaults: onTargetPerct 0.2, speedUp 1.05, slowDown 0.95. With target 200ms the
// band is [160, 240]: above 240 speed up, below 160 slow down.
const mk = (over: Partial<{ targetLatencyMs: number }> = {}) =>
  new PlaybackRateController({ targetLatencyMs: 200, ...over });

describe('PlaybackRateController config validation', () => {
  it('accepts defaults and rejects out-of-range config', () => {
    expect(() => mk()).not.toThrow();
    expect(() => new PlaybackRateController({ targetLatencyMs: 0 })).toThrow(RangeError);
    expect(() => new PlaybackRateController({ targetLatencyMs: 200, onTargetPerct: 1 })).toThrow(RangeError);
    expect(() => new PlaybackRateController({ targetLatencyMs: 200, speedUp: 1 })).toThrow(RangeError);
    expect(() => new PlaybackRateController({ targetLatencyMs: 200, speedUp: 10 })).toThrow(RangeError);
    expect(() => new PlaybackRateController({ targetLatencyMs: 200, slowDown: 1 })).toThrow(RangeError);
  });
});

describe('PlaybackRateController hysteresis', () => {
  it('does nothing while inside the on-target band', () => {
    const c = mk();
    expect(c.currentRenderBuffer(200)).toBeNull();
    expect(c.currentRenderBuffer(240)).toBeNull(); // band edge, not past it
    expect(c.currentRenderBuffer(160)).toBeNull();
    expect(c.getSpeed()).toBe(1);
  });

  it('speeds up when over the band and holds until the buffer drains to target', () => {
    const c = mk();
    expect(c.currentRenderBuffer(241)).toBe(1.05); // crossed upper -> speed up
    expect(c.getSpeed()).toBe(1.05);
    expect(c.currentRenderBuffer(230)).toBeNull(); // still above target -> hold
    expect(c.currentRenderBuffer(201)).toBeNull(); // back in band but not at target -> keep draining
    expect(c.currentRenderBuffer(200)).toBe(1); // reached target -> back to 1x
    expect(c.getSpeed()).toBe(1);
    expect(c.currentRenderBuffer(200)).toBeNull(); // no further change
  });

  it('slows down when under the band and holds until the buffer refills to target', () => {
    const c = mk();
    expect(c.currentRenderBuffer(159)).toBe(0.95); // crossed lower -> slow down
    expect(c.getSpeed()).toBe(0.95);
    expect(c.currentRenderBuffer(170)).toBeNull(); // still below target -> hold
    expect(c.currentRenderBuffer(200)).toBe(1); // reached target -> back to 1x
    expect(c.getSpeed()).toBe(1);
  });

  it('reset() returns to normal so the next reading re-decides from 1x', () => {
    const c = mk();
    expect(c.currentRenderBuffer(241)).toBe(1.05); // in speedup mode
    c.reset();
    expect(c.getSpeed()).toBe(1);
    // Buffer still high, but from normal it re-issues speed up rather than holding.
    expect(c.currentRenderBuffer(241)).toBe(1.05);
  });

  it('honors a retarget applied mid-stream', () => {
    const c = mk();
    expect(c.currentRenderBuffer(300)).toBe(1.05); // over the 200 band
    c.setTargetLatency(500); // now under the new target
    expect(c.currentRenderBuffer(300)).toBe(1); // <= new target -> stop speeding up
    expect(c.currentRenderBuffer(300)).toBe(0.95); // 300 < 500*0.8=400 -> slow down
  });
});

describe('PlaybackRateController updateConfig', () => {
  it('applies a partial update and recomputes the band', () => {
    const c = mk();
    expect(c.currentRenderBuffer(250)).toBe(1.05); // 250 > 240 with perct 0.2
    c.updateConfig({ onTargetPerct: 0.3, speedUp: 1.5 }); // band now [140, 260]
    c.currentRenderBuffer(200); // back to target -> normal
    expect(c.currentRenderBuffer(250)).toBeNull(); // 250 now inside the wider band
    expect(c.currentRenderBuffer(261)).toBe(1.5); // uses the updated speedUp
  });

  it('rejects invalid config atomically (leaves state unchanged)', () => {
    const c = mk();
    expect(() => c.updateConfig({ targetLatencyMs: 100, speedUp: 20 })).toThrow(RangeError);
    // The valid targetLatencyMs must not have been applied: old 200 band still holds.
    expect(c.currentRenderBuffer(150)).toBe(0.95); // 150 < 160 (old lower), not < 80
  });
});
