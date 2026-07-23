/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

/**
 * Gap-tolerant audio renderer (Web Audio side).
 *
 * Core idea: keep a `nextPlayTime` cursor on the AudioContext clock. Every
 * decoded frame is scheduled at `nextPlayTime`, then the cursor advances by the
 * frame's duration. If the network stalls, `nextPlayTime` falls into the past;
 * resuming at `currentTime` makes late audio play immediately instead of piling
 * up.
 *
 * Decoding lives in the audio decoder Web Worker (src/decode/audio_decoder.ts);
 * this class only turns already-decoded AudioData frames into scheduled playback.
 * The worker hands each frame together with the true source timestamp (`ts`) of
 * the chunk that produced it, which is used to anchor media time on a resume.
 */

export interface PlayerOptions {
  sampleRate: number;
  numberOfChannels: number;
  /** Timestamp ticks per second used by the source/encoder (WebCodecs: 1e6 for µs). */
  timebase: number;
  /** Cushion (seconds) added when starting fresh or recovering from a gap. */
  jitterDelay: number;
  /** Apply a short fade-in on each resume to avoid clicks at gap edges. */
  fadeIn: boolean;
  onStats?: (s: PlayerStats) => void;
  onLog?: (msg: string) => void;
}

export interface PlayerStats {
  ctxState: AudioContextState;
  currentTime: number;
  nextPlayTime: number;
  bufferAhead: number;
  rendered: number;
  gapsRecovered: number;
  /** Media timestamp (seconds) of the sample currently at the speakers, or null during silence. */
  playingTimestamp: number | null;
}

const UPDATE_INTERVAL_MS = 20;

const FADE_SECONDS = 0.005; // 5 ms
// Shortfalls smaller than this are ordinary timing jitter, not a real gap.
const GAP_THRESHOLD = 0.05; // 50 ms

export class GapTolerantPlayer {
  private ctx: AudioContext;
  private nextPlayTime = 0;
  private lastBufferDuration = 0;
  private opts: PlayerOptions;

  /**
   * Playback rate control. `setPlaybackSpeed` only records the request; it is
   * adopted by `addFrame` at the moment the next frame is scheduled (at the
   * nextPlayTime boundary), which keeps playback contiguous — see setPlaybackSpeed.
   */
  private requestedPlaybackSpeed = 1; // set by setPlaybackSpeed(), pending until next frame
  private currentPlaybackSpeed = 1; // speed adopted by the most recently scheduled frame

  private rendered = 0;
  private gapsRecovered = 0;
  private statsTimer: number | null = null;

  /**
   * Anchor for the current contiguous segment (the run since the last gap): the
   * media timestamp (in source timebase) of its first sample and the
   * AudioContext time it starts playing. Within a segment the media↔clock
   * mapping is linear, so the sounding timestamp is just anchorTs + (samples
   * played since the anchor).
   */
  private anchorTs = 0;
  private anchorCtxStart = -1;
  /** Playback speed the current segment plays at, so the media↔clock slope is right. */
  private anchorSpeed = 1;

  /**
   * Buffer sources scheduled but not yet finished. Tracked so forceGap() can
   * stop still-pending audio when the jitter cushion is lowered live, otherwise
   * the re-primed (shorter) cursor would overlap audio already scheduled ahead.
   */
  private activeSources = new Set<AudioBufferSourceNode>();

  constructor(opts: PlayerOptions) {
    this.opts = opts;
    this.ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: opts.sampleRate });
    this.startStatsLoop();
  }

  /** AudioContext sample rate actually granted by the browser (for the 1:1 guard). */
  get sampleRate(): number {
    return this.ctx.sampleRate;
  }

  /** System (output + base) latency in ms, for latency readouts. */
  get systemLatencyMs(): number {
    return (this.ctx.outputLatency + this.ctx.baseLatency) * 1000;
  }

  /** Live-tune the jitter cushion applied on the next gap recovery. */
  setJitterDelay(seconds: number): void {
    this.opts.jitterDelay = seconds;
  }

  /**
   * Force a fresh segment on the next fed frame so a changed jitterDelay takes
   * effect immediately instead of waiting for the next network gap. The cushion
   * is only (re)applied when a segment starts, so we stop everything still
   * scheduled (preventing overlap when the cushion shrinks) and reset the
   * cursor; the next addFrame then re-primes exactly like the first frame —
   * re-padding with jitterDelay, re-anchoring media time, and fading in.
   */
  forceGap(): void {
    for (const source of this.activeSources) {
      try {
        source.stop();
      } catch {
        // Already stopped or ended; nothing to do.
      }
    }
    this.activeSources.clear();
    this.nextPlayTime = 0;
  }

  /** Toggle the anti-click fade-in for subsequently scheduled resumes. */
  setFadeIn(enabled: boolean): void {
    this.opts.fadeIn = enabled;
  }

  /**
   * Request a playback rate in [0.5, 2]. This only records the request: it does
   * NOT retune sources already scheduled, because changing playbackRate on a
   * playing node shifts when it ends but not the fixed start time of the node
   * after it, which would open a gap or overlap. Instead addFrame adopts the
   * requested speed when it schedules the next frame — at the nextPlayTime
   * boundary where the previous audio cleanly ends — so playback stays
   * contiguous. Note: playbackRate also shifts pitch (tape-speed behavior).
   */
  setPlaybackSpeed(speed: number): void {
    if (!(speed >= 0.5 && speed <= 2)) {
      throw new RangeError(`playback speed must be in [0.5, 2], got ${speed}`);
    }
    this.requestedPlaybackSpeed = speed;
  }

  /** The last speed passed to setPlaybackSpeed (may still be pending). */
  getRequestedPlaybackSpeed(): number {
    return this.requestedPlaybackSpeed;
  }

  /**
   * Speed adopted by the most recently scheduled frame. Equals the requested
   * value once a frame has been scheduled after the change; it trails while a
   * request is pending (e.g. the feed is stalled). Already-queued audio still
   * finishes at the rate it was scheduled with, so the audible speed can lag
   * this by up to bufferAhead while that queue drains.
   */
  getCurrentPlaybackSpeed(): number {
    return this.currentPlaybackSpeed;
  }

  /** Must be called from a user gesture so the browser unblocks audio. */
  async resume(): Promise<void> {
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
  }

  /**
   * Schedule one decoded frame. `ts` is the true source timestamp (in the
   * configured timebase) of the chunk that produced this frame; it re-anchors
   * media time whenever a new contiguous segment begins.
   */
  addFrame(audioData: AudioData, ts: number): void {
    // Convert WebCodecs AudioData -> Web Audio AudioBuffer.
    const buffer = this.ctx.createBuffer(
      audioData.numberOfChannels,
      audioData.numberOfFrames,
      audioData.sampleRate,
    );

    for (let channel = 0; channel < audioData.numberOfChannels; channel++) {
      const channelData = buffer.getChannelData(channel);
      audioData.copyTo(channelData, { planeIndex: channel, format: 'f32-planar' });
    }

    // Free the hardware-backed object immediately.
    audioData.close();
    this.rendered++;

    // Adopt any pending playback-speed request at this scheduling boundary. A
    // speed change begins a new constant-speed run, so it re-anchors media time
    // just like a gap does (see newSegment below).
    const speed = this.requestedPlaybackSpeed;
    const speedChanged = speed !== this.currentPlaybackSpeed;
    this.currentPlaybackSpeed = speed;

    const currentTime = this.ctx.currentTime;

    // Scheduling / gap handling. Any underrun (nextPlayTime fell behind now)
    // starts a fresh contiguous segment. `isResume` (first frame or a real gap)
    // additionally gets a fade-in and re-anchors media to the fed timestamp.
    let isResume = false;
    let newSegment = false;
    if (this.nextPlayTime === 0) {
      // First frame ever: prime the jitter buffer with a small lead.
      this.nextPlayTime = currentTime + this.opts.jitterDelay;
      isResume = true;
      newSegment = true;
    } else if (this.nextPlayTime < currentTime - GAP_THRESHOLD) {
      // Genuine gap: the cursor fell meaningfully behind (network stalled).
      // Re-pad with the jitter cushion and count it.
      this.gapsRecovered++;
      this.log(`Gap recovered: cursor was ${(currentTime - this.nextPlayTime).toFixed(3)}s behind`);
      this.nextPlayTime = currentTime + this.opts.jitterDelay;
      isResume = true;
      newSegment = true;
    } else if (this.nextPlayTime < currentTime) {
      // Small gap (glitch): a sub-threshold shortfall. The silence already
      // happened; we resume immediately and do NOT re-pad the jitter buffer (no
      // added latency). nextPlayTime is only clamped to "now" so we don't
      // schedule in the past — no jitter correction is applied.
      this.log(
        `Small gap (glitch) detected: ${(currentTime - this.nextPlayTime).toFixed(3)}s behind — no jitter re-pad on nextPlayTime`,
      );
      this.nextPlayTime = currentTime;
      newSegment = true;
    }

    // A silence preceded any new segment, so re-anchor. The resuming buffer's
    // media start is the fed timestamp — which jumps over dropped audio after a
    // real gap, and is just the next contiguous frame after a small one — at ctx
    // time nextPlayTime. This single anchor maps the clock to media time for the
    // whole segment (playback within a segment is contiguous).
    if (newSegment || speedChanged) {
      this.anchorTs = ts;
      this.anchorCtxStart = this.nextPlayTime;
      this.anchorSpeed = speed;
    }

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = speed;

    // Only fade the leading edge of a resume. Fading *every* contiguous frame
    // would dip the gain to 0 at each frame boundary — audible amplitude
    // modulation, not the intended anti-click smoothing.
    if (this.opts.fadeIn && isResume) {
      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0, this.nextPlayTime);
      gain.gain.linearRampToValueAtTime(1, this.nextPlayTime + FADE_SECONDS);
      source.connect(gain).connect(this.ctx.destination);
    } else {
      source.connect(this.ctx.destination);
    }

    // Track the source until it finishes so forceGap() can stop pending audio.
    this.activeSources.add(source);
    source.onended = () => {
      this.activeSources.delete(source);
    };

    source.start(this.nextPlayTime);
    // Effective clock time consumed by this buffer at the current rate, so the
    // cursor stays contiguous and the bufferAhead stat is honest.
    const effectiveDuration = buffer.duration / speed;
    this.lastBufferDuration = effectiveDuration;
    this.nextPlayTime += effectiveDuration;
  }

  private currentPlayingTimestamp(): number | null {
    if (this.anchorCtxStart < 0) return null; // nothing started yet
    const latency = this.ctx.outputLatency || this.ctx.baseLatency || 0;
    const audible = this.ctx.currentTime - latency;
    if (audible < this.anchorCtxStart) return null; // pre-roll silence before this segment
    // anchorTs/timebase + media seconds elapsed since the anchor. At playback
    // speed s, media advances s× clock time, so scale the elapsed clock term.
    return this.anchorTs / this.opts.timebase + (audible - this.anchorCtxStart) * this.anchorSpeed;
  }

  /**
   * Resolve once every buffered sample has finished playing: wait out the
   * remaining scheduled audio. Lets the caller drain before closing, so the
   * playing timestamp reaches the stream end instead of freezing on the tail.
   */
  async whenDrained(): Promise<void> {
    // Loop until the audio clock passes the end of the last scheduled buffer.
    // Robust to any late scheduling and unaffected by tab-focus throttling.
    while (this.ctx.state === 'running' && this.ctx.currentTime < this.nextPlayTime) {
      const remainingMs = (this.nextPlayTime - this.ctx.currentTime) * 1000;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(remainingMs + 20, 250)));
    }
  }

  private startStatsLoop(): void {
    // Use setInterval, not requestAnimationFrame: rAF pauses in background tabs,
    // which would freeze the on-screen playing timestamp mid-stream even though
    // audio keeps playing. setInterval keeps updating regardless of focus.
    this.statsTimer = (self as any).setInterval(() => {
      this.opts.onStats?.({
        ctxState: this.ctx.state,
        currentTime: this.ctx.currentTime,
        nextPlayTime: this.nextPlayTime,
        bufferAhead: Math.max(0, this.nextPlayTime - this.ctx.currentTime + this.lastBufferDuration),
        rendered: this.rendered,
        gapsRecovered: this.gapsRecovered,
        playingTimestamp: this.currentPlayingTimestamp(),
      });
    }, UPDATE_INTERVAL_MS);
  }

  private log(msg: string): void {
    this.opts.onLog?.(msg);
  }

  async close(): Promise<void> {
    if (this.statsTimer !== null) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    await this.ctx.close();
  }
}
