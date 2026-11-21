/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import { GapTolerantPlayer } from '../src/render/audio_player.js';

// The player builds a real AudioContext; the tests run in Node, so stand in
// a fake whose clock the test drives by hand. The fake only implements the
// surface GapTolerantPlayer touches.
class FakeBufferSource {
  buffer: any = null;
  playbackRate = { value: 1 };
  onended: (() => void) | null = null;
  connect(dest: any): any {
    return dest;
  }
  start(_when?: number): void {}
}

class FakeAudioContext {
  currentTime = 0;
  sampleRate = 48000;
  outputLatency = 0;
  baseLatency = 0;
  state = 'running';
  destination = {};
  constructor(_opts?: any) {}
  async resume(): Promise<void> {}
  async close(): Promise<void> {}
  createBuffer(channels: number, frames: number, sampleRate: number): any {
    return {
      duration: frames / sampleRate,
      getChannelData: (_ch: number) => new Float32Array(frames),
    };
  }
  createBufferSource(): any {
    return new FakeBufferSource();
  }
  createGain(): any {
    return {
      gain: { setValueAtTime: () => {}, linearRampToValueAtTime: () => {} },
      connect(dest: any): any {
        return dest;
      },
    };
  }
}

(globalThis as any).self ??= globalThis;
(globalThis as any).AudioContext = FakeAudioContext;

const FRAME_US = 21333;
const FRAME_S = 1024 / 48000;

function fakeAudioData() {
  return {
    numberOfChannels: 1,
    numberOfFrames: 1024,
    sampleRate: 48000,
    copyTo: () => {},
    close: () => {},
  } as any;
}

describe('GapTolerantPlayer sounding clock', () => {
  let players: GapTolerantPlayer[] = [];
  let ctx: FakeAudioContext;

  const mkPlayer = () => {
    const player = new GapTolerantPlayer({
      sampleRate: 48000,
      numberOfChannels: 1,
      timebase: 1_000_000,
      jitterDelay: 0.2,
      fadeIn: true,
    });
    players.push(player);
    ctx = (player as any).ctx as FakeAudioContext;
    return player;
  };

  // Drive the fake clock and read the private sounding-clock computation
  // the stats loop (and the video renderer) consume.
  const clockMs = (player: GapTolerantPlayer): number | null =>
    (player as any).currentPlayingTimeMs();

  const feed = (player: GapTolerantPlayer, count: number, firstIndex = 0) => {
    for (let i = 0; i < count; i++) {
      player.addFrame(fakeAudioData(), (firstIndex + i) * FRAME_US);
    }
  };

  afterEach(async () => {
    await Promise.all(players.map((p) => p.close()));
    players = [];
  });

  it('keeps reporting the sounding clock across a playback-speed change', () => {
    const player = mkPlayer();
    feed(player, 10);
    ctx.currentTime = 0.25;
    expect(clockMs(player)).toBeCloseTo(50, 0);

    player.setPlaybackSpeed(1.05);
    feed(player, 1, 10);
    // The new anchor starts ~200ms in the future (the buffered audio ahead
    // of the speakers). The clock must keep following the audio that is
    // actually sounding instead of going null until the new anchor starts.
    ctx.currentTime = 0.3;
    expect(clockMs(player)).not.toBeNull();
    expect(clockMs(player)).toBeCloseTo(100, 0);

    // Once the new anchor starts sounding, the clock follows it at 1.05x.
    ctx.currentTime = 0.45;
    expect(clockMs(player)).toBeCloseTo(213.33 + (0.45 - (0.2 + 10 * FRAME_S)) * 1050, 0);
  });

  it('holds the last sounding time during a gap-recovery cushion', () => {
    const player = mkPlayer();
    feed(player, 10);
    // Jump past the scheduled audio: a genuine gap, recovered with a
    // 200ms cushion before the new segment starts sounding.
    ctx.currentTime = 0.6;
    feed(player, 1, 28); // ts 28*21333, well past the old segment
    ctx.currentTime = 0.65;
    // Not null, and held at the end of the previously sounding segment
    // rather than extrapolated through the silent gap.
    expect(clockMs(player)).toBeCloseTo(10 * FRAME_S * 1000, 0);

    ctx.currentTime = 0.85;
    // New anchor: ts 28*21333 µs, starting at ctx time 0.80.
    expect(clockMs(player)).toBeCloseTo((28 * FRAME_US) / 1000 + 50, 0);
  });

  it('still reports null during the very first pre-roll', () => {
    const player = mkPlayer();
    feed(player, 1);
    ctx.currentTime = 0.05;
    expect(clockMs(player)).toBeNull();
    ctx.currentTime = 0.25;
    expect(clockMs(player)).toBeCloseTo(50, 0);
  });

  it('survives chained speed changes before the new anchor sounds', () => {
    const player = mkPlayer();
    feed(player, 10);
    ctx.currentTime = 0.25;
    player.setPlaybackSpeed(1.05);
    feed(player, 1, 10);
    player.setPlaybackSpeed(1);
    feed(player, 1, 11);
    // The intermediate (never-sounded) anchor must not replace the
    // sounding segment's mapping, nor null the clock.
    ctx.currentTime = 0.3;
    expect(clockMs(player)).toBeCloseTo(100, 0);
    ctx.currentTime = 0.45;
    // Second anchor starts when the 1.05x frame ends: 0.2 + 10 frames at
    // 1x + one frame at 1.05x; its ts is 11*21333 µs.
    const secondAnchorStart = 0.2 + 10 * FRAME_S + FRAME_S / 1.05;
    expect(clockMs(player)).toBeCloseTo(
      (11 * FRAME_US) / 1000 + (0.45 - secondAnchorStart) * 1000,
      0,
    );
  });
});
