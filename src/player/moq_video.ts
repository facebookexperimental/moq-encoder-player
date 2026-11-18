/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

/**
 * `<moq-video>` — a video-player custom element wrapping the existing
 * MoQ player pipeline.
 *
 * The demo player (demo/player/index.html) is untouched. This element reuses
 * the same compiled pieces the demo uses — the receiver/decoder workers,
 * `JitterBuffer`, `VideoRenderBuffer`, `GapTolerantPlayer`, and
 * `PlaybackRateController` — and mirrors the demo's orchestration (worker
 * messages, jitter buffers, render loop, live buffer updates) with the
 * element's own configuration instead of the demo's form fields. The demo's
 * diagnostics UI (timelines, stats tabs, relay-switch buttons, backup
 * relays) is not reproduced: playback here is single-relay (main only).
 * Graph data (state, timing, latency, dejitter gaps) reaches the host through
 * `infoCallback` / the `moq-info` event; worker log lines reach it separately
 * through `logCallback` / the `moq-log` event, so a chatty worker log can
 * never flood the graph callback.
 *
 * Custom-element names must contain a hyphen, so the element is `moq-video`
 * (not `moqvideo`). Registering the hyphen-less name would throw.
 *
 * The compiled file lives at `dist/player/moq_video.js`; workers are resolved
 * relative to this module, so the whole `dist/` tree must be served with its
 * layout intact (see the README "Web component" section).
 */

import {
  MOQ_VIDEO_TIMEBASE,
  MoqVideoAdvancedConfig,
  MoqVideoAdvancedConfigInput,
  MoqVideoConfig,
  MoqVideoConfigInput,
  MoqVideoPackager,
  MoqVideoSizeStrategy,
  MoqVideoSpeedCompensationConfig,
  cloneAdvancedConfig,
  deriveDetailedBuffers,
  normalizeAdvancedConfig,
  normalizePackager,
  normalizeSizeStrategy,
  receiverPackagerFormat,
  resolveMoqVideoConfig,
  splitNamespace,
  validateTargetBufferSize,
} from './moq_video_config.js';
import { VideoRenderBuffer } from '../render/video_render_buffer.js';
import { OverlayDecoder } from '../overlay_processor/overlay_decoder.js';
import { JitterBuffer } from '../utils/jitter_buffer.js';
import { GapTolerantPlayer, PlayerStats } from '../render/audio_player.js';
import { PlaybackRateController } from '../render/playback_rate_controller.js';
import { getBinaryFile } from '../utils/utils.js';
import { LOCgetTrackName } from '../packager/loc_packager.js';

export type MoqVideoState = 'idle' | 'starting' | 'playing' | 'stopping';

/** Snapshot of the live pipeline, as returned by `getStats()` and `stats` infos. */
export interface MoqVideoStats {
  state: MoqVideoState;
  src: string;
  videoTrack: string;
  audioTrack: string;
  videoResolution: string;
  playbackSpeed: number;
  systemAudioLatencyMs: number;
  /** Audio gaps recovered by the renderer (silence inserted) since start. */
  audioGapsRecovered: number;
  /** Capture-to-display latency in ms, or -1 until an overlaid frame is read. */
  videoLatencyMs: number;
  timingMs: {
    muxerAudio: number | null;
    muxerVideo: number | null;
    decoderAudio: number | null;
    decoderVideo: number | null;
    rendererAudio: number | null;
    rendererVideo: number | null;
  };
  buffers: {
    decoder: {
      audio: { size: number; lengthMs: number };
      video: { size: number; lengthMs: number };
    };
    renderer: {
      audio: { size: number; lengthMs: number };
      video: { size: number; lengthMs: number };
    };
  };
  jitter: {
    audio: ReturnType<JitterBuffer['GetStats']> | null;
    video: ReturnType<JitterBuffer['GetStats']> | null;
  };
  videoBuffer: ReturnType<VideoRenderBuffer['GetStats']> | null;
  relay: { video: string; audio: string };
  diagnostics: {
    receivedFrames: number;
    paintedFrames: number;
    hiddenFrames: number;
    noRendererFrames: number;
    noFrameAttempts: number;
    lastRenderResult: string;
  };
}

/**
 * Payloads delivered to `infoCallback` and the `moq-info` event: only state
 * transitions, graph data (`stats`, `video-size`, `relay`, `dropped`), and
 * component `error`s. Worker log lines are NOT here — see MoqVideoLogInfo.
 * `stats.stats` carries everything a graph needs: per-track PTS
 * (`timingMs`), capture-to-display latency (`videoLatencyMs`), playback
 * speed, renderer buffer lengths, and dejitter gaps (each `jitter` entry's
 * `numTotalGaps` / `numTotalLostStreams`, plus `audioGapsRecovered`).
 */
export type MoqVideoInfo =
  | { type: 'state'; state: MoqVideoState; previousState: MoqVideoState; at: number }
  | { type: 'started'; at: number; src: string; videoTrack: string; audioTrack: string }
  | { type: 'stopped'; at: number }
  | { type: 'stats'; at: number; stats: MoqVideoStats }
  | { type: 'video-size'; at: number; width: number; height: number }
  | { type: 'relay'; at: number; mediaType: 'video' | 'audio'; relay: string }
  | { type: 'dropped'; at: number; message: string }
  | { type: 'error'; at: number; message: string }
  | { type: 'restart'; at: number; reason: string };

export type MoqVideoInfoCallback = (info: MoqVideoInfo) => void;

/**
 * One worker log line, delivered to `logCallback` and the `moq-log` event.
 * Workers emit several of these per media chunk (one per chunk per worker
 * while verbose), so hosts must NEVER append every one to the DOM: cap and
 * batch the rendering, or the log itself starves the render loop and
 * playback appears to stop after a few seconds. With no `logCallback` set,
 * lines still reach the console, as in the demo player.
 */
export interface MoqVideoLogInfo {
  type: 'log';
  at: number;
  level: 'debug' | 'info' | 'warning' | 'error';
  message: string;
}

export type MoqVideoLogCallback = (log: MoqVideoLogInfo) => void;

const RENDER_VIDEO_EVERY_MS = 10;
const STATS_INFO_EVERY_MS = 1000;
const AUDIO_STOPPED = 0;
const AUDIO_PLAYING = 1;

type WorkerLike = {
  postMessage: (message: unknown, ...args: unknown[]) => void;
  addEventListener: (type: string, listener: (e: MessageEvent) => void) => void;
  terminate?: () => void;
};

export class MoqVideoElement extends HTMLElement {
  static observedAttributes = [
    'src',
    'namespace',
    'tracks-prefix',
    'tracksprefix',
    'video-suffix',
    'videosuffix',
    'audio-suffix',
    'audiosuffix',
    'packager',
    'advanced-config',
    'advancedconfig',
    'size-strategy',
    'sizestrategy',
    'is-local',
    'islocal',
    'autoplay',
    'verbose',
  ];

  /** Testing hook: override how workers are created (defaults to real Workers). */
  workerFactory?: (url: string | URL, options?: WorkerOptions) => WorkerLike;

  // No src until the host sets one: `src` is the only mandatory value, so the
  // pending config starts empty and `start()` validates it. Defaults below
  // are the documented defaults; validation happens on every update/start.
  private _config: MoqVideoConfig = {
    src: '',
    namespace: 'vc',
    tracksPrefix: '',
    videoSuffix: 'video0',
    audioSuffix: 'audio0',
    packager: 'CMSF',
    advancedConfig: {
      authInfo: 'secret',
      targetBufferSizeMs: 200,
      audioRenderBufferMs: 200,
      audioJitterBufferMs: 160,
      videoJitterBufferMs: 160,
      speedCompensation: { enabled: true, onTargetRangePercent: 20, speedUp: 1.05, slowDown: 0.95 },
      verbose: true,
    },
    sizeStrategy: 'fitInCanvas',
    isLocal: false,
  };
  private _infoCallback: MoqVideoInfoCallback | null = null;
  private _logCallback: MoqVideoLogCallback | null = null;
  private _autoplay = false;
  private _state: MoqVideoState = 'idle';
  private _operation: Promise<void> = Promise.resolve();
  private _canvas: HTMLCanvasElement | null = null;
  private _view: HTMLElement | null = null;
  private _videoCtx: CanvasRenderingContext2D | null = null;

  private _downloaderWorker: WorkerLike | null = null;
  private _audioDecoderWorker: WorkerLike | null = null;
  private _videoDecoderWorker: WorkerLike | null = null;
  private _videoRendererBuffer: VideoRenderBuffer | null = null;
  private _audioJitterBuffer: JitterBuffer | null = null;
  private _videoJitterBuffer: JitterBuffer | null = null;
  private _audioPlayer: GapTolerantPlayer | null = null;
  private _playbackRateController: PlaybackRateController | null = null;
  private _overlayDecoder = new OverlayDecoder();
  private _overlayStopped = false;
  private _animFrame: number | null = null;
  private _wcLastRender = 0;
  private _playerBufferMs = 200;
  private _systemAudioLatencyMs = 0;
  private _gapsRecovered = 0;
  private _lastPlaybackSpeed = -1;
  private _lastVideoLatencyMs = -1;
  private _audioSampleRateWarned = false;
  private _lastStatsInfoMs = 0;
  private _onVisibilityChange = (): void => {
    if (typeof document !== 'undefined' && document.hidden && this._videoRendererBuffer != null) {
      this._videoRendererBuffer.Clear();
    }
  };

  private _timing = {
    muxer: { currentAudioTs: -1, currentVideoTs: -1 },
    decoder: { currentAudioTs: -1, currentVideoTs: -1 },
    renderer: { currentAudioTsMs: -1, currentVideoTsMs: -1 },
  };
  private _buffers = {
    decoder: { audio: { size: -1, lengthMs: -1 }, video: { size: -1, lengthMs: -1 } },
    renderer: {
      audio: { size: -1, lengthMs: -1, state: AUDIO_STOPPED },
      video: { size: -1, lengthMs: -1 },
    },
  };
  private _currentVideoSize = { width: -1, height: -1 };
  private _relay: { video: string | undefined; audio: string | undefined } = {
    video: undefined,
    audio: undefined,
  };
  private _diagnostics = {
    receivedFrames: 0,
    paintedFrames: 0,
    hiddenFrames: 0,
    noRendererFrames: 0,
    noFrameAttempts: 0,
    lastRenderResult: 'not-started',
  };

  constructor() {
    super();
    if (typeof this.attachShadow === 'function') {
      this.attachShadow({ mode: 'open' });
    }
  }

  // -- Configuration (properties; attributes mirror them) ------------------

  get src(): string {
    return this._config.src;
  }
  set src(value: string) {
    this._setConnectionConfig({ src: value });
  }

  get namespace(): string {
    return this._config.namespace;
  }
  set namespace(value: string) {
    this._setConnectionConfig({ namespace: value });
  }

  get tracksPrefix(): string {
    return this._config.tracksPrefix;
  }
  set tracksPrefix(value: string) {
    this._setConnectionConfig({ tracksPrefix: value });
  }

  get videoSuffix(): string {
    return this._config.videoSuffix;
  }
  set videoSuffix(value: string) {
    this._setConnectionConfig({ videoSuffix: value });
  }

  get audioSuffix(): string {
    return this._config.audioSuffix;
  }
  set audioSuffix(value: string) {
    this._setConnectionConfig({ audioSuffix: value });
  }

  get packager(): MoqVideoPackager {
    return this._config.packager;
  }
  set packager(value: MoqVideoPackager) {
    this._setConnectionConfig({ packager: value });
  }

  get advancedConfig(): MoqVideoAdvancedConfig {
    return cloneAdvancedConfig(this._config.advancedConfig);
  }
  set advancedConfig(value: MoqVideoAdvancedConfigInput) {
    this.setAdvancedConfig(value);
  }

  get sizeStrategy(): MoqVideoSizeStrategy {
    return this._config.sizeStrategy;
  }
  set sizeStrategy(value: MoqVideoSizeStrategy) {
    this.setSizeStrategy(value);
  }

  get infoCallback(): MoqVideoInfoCallback | null {
    return this._infoCallback;
  }
  set infoCallback(value: MoqVideoInfoCallback | null | undefined) {
    if (value != null && typeof value !== 'function') {
      throw new TypeError('infoCallback must be a function or null');
    }
    this._infoCallback = value ?? null;
  }

  /** Worker log lines only; see MoqVideoLogInfo for the volume warning. */
  get logCallback(): MoqVideoLogCallback | null {
    return this._logCallback;
  }
  set logCallback(value: MoqVideoLogCallback | null | undefined) {
    if (value != null && typeof value !== 'function') {
      throw new TypeError('logCallback must be a function or null');
    }
    this._logCallback = value ?? null;
  }

  get isLocal(): boolean {
    return this._config.isLocal;
  }
  set isLocal(value: boolean) {
    this._setConnectionConfig({ isLocal: value });
  }

  get autoplay(): boolean {
    return this._autoplay;
  }
  set autoplay(value: boolean) {
    this._autoplay = Boolean(value);
    if (this._autoplay && this.isConnected && this._state === 'idle' && this._config.src !== '') {
      void this.start().catch((err: unknown) => this._emitError(err));
    }
  }

  get verbose(): boolean {
    return this._config.advancedConfig.verbose;
  }
  set verbose(value: boolean) {
    this.setVerbose(value);
  }

  get state(): MoqVideoState {
    return this._state;
  }

  get isPlaying(): boolean {
    return this._state === 'playing' || this._state === 'starting';
  }

  /** The canvas frames are painted into (inside the shadow root). */
  get canvas(): HTMLCanvasElement | null {
    return this._canvas;
  }

  /** Current effective config, with defaults applied (a copy). */
  getConfig(): MoqVideoConfig {
    return { ...this._config, advancedConfig: cloneAdvancedConfig(this._config.advancedConfig) };
  }

  getAdvancedConfig(): MoqVideoAdvancedConfig {
    return cloneAdvancedConfig(this._config.advancedConfig);
  }

  // -- Lifecycle ------------------------------------------------------------

  connectedCallback(): void {
    this._renderShadow();
    if (this._autoplay && this._config.src !== '') {
      void this.start().catch((err: unknown) => this._emitError(err));
    }
  }

  disconnectedCallback(): void {
    // Teardown must not throw from a lifecycle callback; the pipeline is
    // stopped and its workers terminated so a removed element leaks nothing.
    void this.stop().catch(() => {
      // Already reported through the info channel by stop() itself.
    });
  }

  attributeChangedCallback(name: string, _oldValue: string | null, newValue: string | null): void {
    const attr = name.toLowerCase();
    try {
      if (attr === 'src')
        this._setConnectionConfig({ src: newValue ?? '' }, { fromAttribute: true });
      else if (attr === 'namespace') {
        this._setConnectionConfig({ namespace: newValue ?? '' }, { fromAttribute: true });
      } else if (attr === 'tracks-prefix' || attr === 'tracksprefix') {
        this._setConnectionConfig({ tracksPrefix: newValue ?? '' }, { fromAttribute: true });
      } else if (attr === 'video-suffix' || attr === 'videosuffix') {
        this._setConnectionConfig({ videoSuffix: newValue ?? '' }, { fromAttribute: true });
      } else if (attr === 'audio-suffix' || attr === 'audiosuffix') {
        this._setConnectionConfig({ audioSuffix: newValue ?? '' }, { fromAttribute: true });
      } else if (attr === 'packager') {
        this._setConnectionConfig(
          { packager: normalizePackager(newValue ?? '') },
          { fromAttribute: true },
        );
      } else if (attr === 'advanced-config' || attr === 'advancedconfig') {
        if (newValue == null || newValue === '') return;
        this.setAdvancedConfig(JSON.parse(newValue) as MoqVideoAdvancedConfigInput);
      } else if (attr === 'size-strategy' || attr === 'sizestrategy') {
        this.setSizeStrategy(normalizeSizeStrategy(newValue ?? ''));
      } else if (attr === 'is-local' || attr === 'islocal') {
        this._setConnectionConfig(
          { isLocal: this._parseBooleanAttribute(newValue) },
          { fromAttribute: true },
        );
      } else if (attr === 'autoplay') {
        this._autoplay = this._parseBooleanAttribute(newValue);
      } else if (attr === 'verbose') {
        this.setVerbose(this._parseBooleanAttribute(newValue));
      }
    } catch (err) {
      // Attribute changes cannot throw to a parser; report and keep the
      // previous value for that field.
      this._emitError(err);
    }
  }

  private _parseBooleanAttribute(value: string | null): boolean {
    if (value == null) return false;
    if (value === '') return true;
    return value.toLowerCase() === 'true' || value === '1';
  }

  /**
   * Start playback. Safe to call when already playing (no-op). Call from a
   * user gesture when audio output matters: the first audio frame resumes
   * the AudioContext, which browsers gate on a gesture.
   */
  start(): Promise<void> {
    return this._enqueue(async () => {
      if (this._state === 'playing' || this._state === 'starting') return;
      await this._startInternal();
    });
  }

  /** Stop playback and tear the pipeline down. Safe to call when idle. */
  stop(): Promise<void> {
    return this._enqueue(async () => {
      if (this._state === 'idle' || this._state === 'stopping') return;
      await this._stopInternal();
    });
  }

  private _enqueue(operation: () => Promise<void>): Promise<void> {
    const run = this._operation.then(operation, operation);
    // Keep the chain alive for the next operation even if this one rejects,
    // but surface the rejection to this caller.
    this._operation = run.catch(() => undefined);
    return run;
  }

  private _setState(state: MoqVideoState): void {
    const previousState = this._state;
    this._state = state;
    this._emit({ type: 'state', state, previousState, at: Date.now() });
  }

  private async _startInternal(): Promise<void> {
    const config = this._config;
    // Validate eagerly so a bad attribute/property fails here, not in a worker.
    const resolved = resolveMoqVideoConfig({
      ...config,
      advancedConfig: cloneAdvancedConfig(config.advancedConfig),
    });
    this._config = resolved;
    this._setState('starting');
    this._playerBufferMs = resolved.advancedConfig.audioRenderBufferMs;
    this._resetDiagnostics();
    this._createVideoRendererBuffer();
    this._createJitterBuffers();
    this._setRelay('video', undefined);
    this._setRelay('audio', undefined);
    this._createWorkers();
    this._attachWorkerListeners();

    const downloaderConfig = await this._buildDownloaderConfig(resolved);
    this._downloaderWorker?.postMessage({ type: 'init', config: downloaderConfig });
    document.addEventListener('visibilitychange', this._onVisibilityChange);
    this._setState('playing');
    this._emit({
      type: 'started',
      at: Date.now(),
      src: resolved.src,
      videoTrack: this._videoTrackName(),
      audioTrack: this._audioTrackName(),
    });
  }

  private async _stopInternal(): Promise<void> {
    this._setState('stopping');
    if (this._animFrame != null) {
      cancelAnimationFrame(this._animFrame);
      this._animFrame = null;
    }
    document.removeEventListener('visibilitychange', this._onVisibilityChange);
    const stopMsg = { type: 'stop' };
    this._downloaderWorker?.postMessage(stopMsg);
    this._videoDecoderWorker?.postMessage(stopMsg);
    this._audioDecoderWorker?.postMessage(stopMsg);
    for (const worker of [
      this._downloaderWorker,
      this._videoDecoderWorker,
      this._audioDecoderWorker,
    ]) {
      try {
        worker?.terminate?.();
      } catch {
        // Worker already gone; nothing to clean up.
      }
    }
    this._downloaderWorker = null;
    this._videoDecoderWorker = null;
    this._audioDecoderWorker = null;
    if (this._audioPlayer != null) {
      await this._audioPlayer.close();
    }
    this._audioPlayer = null;
    this._playbackRateController = null;
    this._audioSampleRateWarned = false;
    this._systemAudioLatencyMs = 0;
    this._gapsRecovered = 0;
    this._lastPlaybackSpeed = -1;
    this._lastVideoLatencyMs = -1;
    this._overlayStopped = false;
    this._clearTimingInfo();
    this._clearBufferInfo();
    this._currentVideoSize = { width: -1, height: -1 };
    this._videoCtx = null;
    this._clearJitterBuffers();
    this._setRelay('video', undefined);
    this._setRelay('audio', undefined);
    if (this._videoRendererBuffer != null) {
      this._videoRendererBuffer.Clear();
    }
    this._videoRendererBuffer = null;
    this._setState('idle');
    this._emit({ type: 'stopped', at: Date.now() });
  }

  // -- Configuration updates --------------------------------------------------

  /**
   * Update a connection setting. While playing, the pipeline restarts with
   * the new setting (as changing `<video src>` reloads); while idle it only
   * updates the pending config. Validation happens first, so an invalid
   * value throws and leaves the previous config untouched.
   */
  private _setConnectionConfig(
    patch: Partial<MoqVideoConfigInput>,
    _options: { fromAttribute?: boolean } = {},
  ): void {
    // Validate first so an invalid value throws and the previous config is
    // untouched. An empty `src` is allowed while pending (it only fails at
    // `start()`); every other value is validated as if starting now.
    const candidate: MoqVideoConfig = {
      ...this._config,
      ...patch,
      advancedConfig: cloneAdvancedConfig(this._config.advancedConfig),
      packager: normalizePackager(patch.packager ?? this._config.packager),
      sizeStrategy: normalizeSizeStrategy(patch.sizeStrategy ?? this._config.sizeStrategy),
    };
    if (candidate.src !== '') {
      const resolved = resolveMoqVideoConfig({
        ...candidate,
        advancedConfig: candidate.advancedConfig,
      });
      this._config = resolved;
    } else {
      if (
        candidate.tracksPrefix === '' &&
        (candidate.videoSuffix === '' || candidate.audioSuffix === '')
      ) {
        throw new Error(
          '"tracksPrefix" is empty, so "videoSuffix" and "audioSuffix" can NOT be empty',
        );
      }
      this._config = candidate;
    }
    if (this._state === 'playing' || this._state === 'starting') {
      void this._restart('config-changed');
    }
  }

  private _restart(reason: string): Promise<void> {
    return this._enqueue(async () => {
      if (this._state === 'playing' || this._state === 'starting') {
        this._emit({ type: 'restart', at: Date.now(), reason });
        await this._stopInternal();
      }
      if (this._state === 'idle') {
        await this._startInternal();
      }
    });
  }

  /** Replace the shadow canvas sizing mode; works at any time. Returns the old value. */
  setSizeStrategy(strategy: MoqVideoSizeStrategy): MoqVideoSizeStrategy {
    const old = this._config.sizeStrategy;
    this._config.sizeStrategy = normalizeSizeStrategy(strategy);
    this._applySizeStrategy();
    return old;
  }

  private _applySizeStrategy(): void {
    if (this._view == null) return;
    this._view.classList.toggle('fit', this._config.sizeStrategy === 'fitInCanvas');
    this._view.classList.toggle('original', this._config.sizeStrategy === 'original');
  }

  /** Toggle verbose logging at any time. Returns the old value. */
  setVerbose(enabled: boolean): boolean {
    const old = this._config.advancedConfig.verbose;
    this._config.advancedConfig.verbose = Boolean(enabled);
    return old;
  }

  /**
   * Merge a partial `advancedConfig` and apply every live-updatable field
   * immediately; `authInfo` takes effect on the next start (it is baked into
   * the receiver config sent on `start()`). Returns the previous config.
   */
  setAdvancedConfig(input: MoqVideoAdvancedConfigInput): MoqVideoAdvancedConfig {
    const old = cloneAdvancedConfig(this._config.advancedConfig);
    const next = normalizeAdvancedConfig(input, old);
    this._config.advancedConfig = next;
    this._applyLiveAdvancedConfig(old, next);
    return old;
  }

  private _applyLiveAdvancedConfig(
    old: MoqVideoAdvancedConfig,
    next: MoqVideoAdvancedConfig,
  ): void {
    if (next.targetBufferSizeMs !== old.targetBufferSizeMs) {
      this.setTargetBufferSize(next.targetBufferSizeMs);
      return;
    }
    if (next.audioRenderBufferMs !== old.audioRenderBufferMs) {
      this.setAudioRenderBufferMs(next.audioRenderBufferMs);
    }
    if (next.audioJitterBufferMs !== old.audioJitterBufferMs) {
      this.setAudioJitterBufferMs(next.audioJitterBufferMs);
    }
    if (next.videoJitterBufferMs !== old.videoJitterBufferMs) {
      this.setVideoJitterBufferMs(next.videoJitterBufferMs);
    }
    const compChanged =
      next.speedCompensation.enabled !== old.speedCompensation.enabled ||
      next.speedCompensation.onTargetRangePercent !== old.speedCompensation.onTargetRangePercent ||
      next.speedCompensation.speedUp !== old.speedCompensation.speedUp ||
      next.speedCompensation.slowDown !== old.speedCompensation.slowDown;
    if (compChanged) {
      this.setSpeedCompensation({ ...next.speedCompensation });
    }
  }

  /** Set the auth token; takes effect on the next start. Returns the old value. */
  setAuthInfo(authInfo: string): string {
    const old = this._config.advancedConfig.authInfo;
    this._config.advancedConfig.authInfo = String(authInfo);
    return old;
  }

  /**
   * Set the playback target buffer size (ms) at any time. Derives the audio
   * render buffer (= target) and both de-jitter caps (= target - 40 ms,
   * floored at 0) and applies all three live, exactly like the demo's
   * "Update" button for this field. Returns the previous target.
   * Throws RangeError outside [10, 30000] and leaves the config unchanged.
   */
  setTargetBufferSize(targetBufferSizeMs: number): number {
    const old = this._config.advancedConfig.targetBufferSizeMs;
    const value = validateTargetBufferSize(Number(targetBufferSizeMs));
    const derived = deriveDetailedBuffers(value);
    this._config.advancedConfig.targetBufferSizeMs = value;
    this._config.advancedConfig.audioRenderBufferMs = derived.audioRenderBufferMs;
    this._config.advancedConfig.audioJitterBufferMs = derived.audioJitterBufferMs;
    this._config.advancedConfig.videoJitterBufferMs = derived.videoJitterBufferMs;
    this.setAudioJitterBufferMs(derived.audioJitterBufferMs);
    this.setVideoJitterBufferMs(derived.videoJitterBufferMs);
    this.setAudioRenderBufferMs(derived.audioRenderBufferMs);
    this._ensurePlaybackRateController();
    this._playbackRateController?.setTargetLatency(value);
    return old;
  }

  /** Set the audio render buffer (ms) live. Returns the old value. */
  setAudioRenderBufferMs(audioRenderBufferMs: number): number {
    const old = this._config.advancedConfig.audioRenderBufferMs;
    const value = Number(audioRenderBufferMs);
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`audioRenderBufferMs must be >= 0, got ${audioRenderBufferMs}`);
    }
    this._config.advancedConfig.audioRenderBufferMs = value;
    this._playerBufferMs = value;
    if (this._audioPlayer != null) {
      this._audioPlayer.setJitterDelay(value / 1000);
      // The cushion is only (re)applied when a segment starts; force a gap
      // to re-prime at the new size right away (as the demo does).
      this._audioPlayer.forceGap();
    }
    return old;
  }

  /** Set the audio de-jitter cap (ms) live. Returns the old value. */
  setAudioJitterBufferMs(audioJitterBufferMs: number): number {
    const old = this._config.advancedConfig.audioJitterBufferMs;
    const value = Number(audioJitterBufferMs);
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`audioJitterBufferMs must be >= 0, got ${audioJitterBufferMs}`);
    }
    this._config.advancedConfig.audioJitterBufferMs = value;
    this._audioJitterBuffer?.UpdateMaxSize(value);
    return old;
  }

  /** Set the video de-jitter cap (ms) live. Returns the old value. */
  setVideoJitterBufferMs(videoJitterBufferMs: number): number {
    const old = this._config.advancedConfig.videoJitterBufferMs;
    const value = Number(videoJitterBufferMs);
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`videoJitterBufferMs must be >= 0, got ${videoJitterBufferMs}`);
    }
    this._config.advancedConfig.videoJitterBufferMs = value;
    this._videoJitterBuffer?.UpdateMaxSize(value);
    return old;
  }

  /**
   * Replace the speed-compensation settings live (any subset). Returns the
   * previous full settings. Throws and leaves the controller unchanged on
   * an out-of-range value, as the demo's "Update config" button does.
   */
  setSpeedCompensation(
    patch: Partial<MoqVideoSpeedCompensationConfig>,
  ): MoqVideoSpeedCompensationConfig {
    const old = { ...this._config.advancedConfig.speedCompensation };
    const next = { ...old, ...patch };
    this._ensurePlaybackRateController();
    if (this._playbackRateController != null) {
      this._playbackRateController.updateConfig({
        targetLatencyMs: this._config.advancedConfig.targetBufferSizeMs,
        onTargetPerct: next.onTargetRangePercent / 100,
        speedUp: next.speedUp,
        slowDown: next.slowDown,
      });
    }
    this._config.advancedConfig.speedCompensation = next;
    if (!next.enabled) this._onToggleSpeedCompensation();
    return old;
  }

  /** Enable/disable speed compensation live. Returns the old value. */
  setSpeedCompensationEnabled(enabled: boolean): boolean {
    const old = this._config.advancedConfig.speedCompensation.enabled;
    this.setSpeedCompensation({ enabled: Boolean(enabled) });
    return old;
  }

  /** Current pipeline snapshot (timing, buffers, latency, relay, counters). */
  getStats(): MoqVideoStats {
    const toMs = (ts: number, timebase: number): number | null =>
      ts < 0 ? null : (ts * 1000) / timebase;
    const audioTimebase = MOQ_VIDEO_TIMEBASE;
    const videoTimebase = MOQ_VIDEO_TIMEBASE;
    return {
      state: this._state,
      src: this._config.src,
      videoTrack: this._videoTrackName(),
      audioTrack: this._audioTrackName(),
      videoResolution:
        this._currentVideoSize.width > 0
          ? `${this._currentVideoSize.width}x${this._currentVideoSize.height}`
          : '-',
      playbackSpeed: this._lastPlaybackSpeed >= 0 ? this._lastPlaybackSpeed : 1,
      systemAudioLatencyMs: this._systemAudioLatencyMs,
      audioGapsRecovered: this._gapsRecovered,
      videoLatencyMs: this._lastVideoLatencyMs,
      timingMs: {
        muxerAudio: toMs(this._timing.muxer.currentAudioTs, audioTimebase),
        muxerVideo: toMs(this._timing.muxer.currentVideoTs, videoTimebase),
        decoderAudio: toMs(this._timing.decoder.currentAudioTs, audioTimebase),
        decoderVideo: toMs(this._timing.decoder.currentVideoTs, videoTimebase),
        rendererAudio:
          this._timing.renderer.currentAudioTsMs >= 0
            ? this._timing.renderer.currentAudioTsMs
            : null,
        rendererVideo:
          this._timing.renderer.currentVideoTsMs >= 0
            ? this._timing.renderer.currentVideoTsMs
            : null,
      },
      buffers: {
        decoder: {
          audio: { ...this._buffers.decoder.audio },
          video: { ...this._buffers.decoder.video },
        },
        renderer: {
          audio: {
            size: this._buffers.renderer.audio.size,
            lengthMs: this._buffers.renderer.audio.lengthMs,
          },
          video: { ...this._buffers.renderer.video },
        },
      },
      jitter: {
        audio: this._audioJitterBuffer?.GetStats() ?? null,
        video: this._videoJitterBuffer?.GetStats() ?? null,
      },
      videoBuffer: this._videoRendererBuffer?.GetStats() ?? null,
      relay: {
        video: this._relay.video ?? '-',
        audio: this._relay.audio ?? '-',
      },
      diagnostics: { ...this._diagnostics },
    };
  }

  // -- Shadow DOM and info channel --------------------------------------------

  private _renderShadow(): void {
    const root = this.shadowRoot;
    if (root == null || this._canvas != null) return;
    root.innerHTML = `<style>
      :host { display: block; }
      .view { overflow: hidden; }
      .view.fit canvas { width: 100%; height: auto; display: block; }
      .view.original canvas { max-width: none; display: block; }
      canvas { border: 1px solid currentColor; background: #000; }
    </style><div class="view fit"><canvas width="320" height="160"></canvas></div>`;
    this._view = root.querySelector('.view');
    this._canvas = root.querySelector('canvas');
    this._videoCtx = this._canvas?.getContext('2d') ?? null;
    this._applySizeStrategy();
  }

  private _emit(info: MoqVideoInfo): void {
    try {
      this._infoCallback?.(info);
    } catch (err) {
      // A host callback must never break playback.
      console.error('[moq-video] infoCallback threw: ' + (err as Error)?.message);
    }
    try {
      this.dispatchEvent(
        new CustomEvent('moq-info', { detail: info, bubbles: true, composed: true }),
      );
    } catch {
      // Dispatching before upgrade completes (attribute callbacks) is a no-op.
    }
  }

  private _emitError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[moq-video] ' + message);
    this._emit({ type: 'error', at: Date.now(), message });
  }

  // Worker log lines go ONLY to the log channel. They must never reach
  // infoCallback: at verbose rates they are several per media chunk, and a
  // host that renders every one (e.g. appending to the DOM) starves the
  // render loop until playback appears to stop after a few seconds.
  private _emitLog(level: 'debug' | 'info' | 'warning' | 'error', message: string): void {
    if (level === 'debug' && !this._config.advancedConfig.verbose) return;
    if (level === 'debug') console.debug(message);
    else if (level === 'info') console.log(message);
    else if (level === 'warning') console.warn(message);
    else console.error(message);
    const log: MoqVideoLogInfo = { type: 'log', at: Date.now(), level, message };
    try {
      this._logCallback?.(log);
    } catch (err) {
      // A host callback must never break playback.
      console.error('[moq-video] logCallback threw: ' + (err as Error)?.message);
    }
    try {
      this.dispatchEvent(
        new CustomEvent('moq-log', { detail: log, bubbles: true, composed: true }),
      );
    } catch {
      // Dispatching before upgrade completes (attribute callbacks) is a no-op.
    }
  }

  // -- Pipeline construction --------------------------------------------------

  private _videoTrackName(): string {
    return LOCgetTrackName(this._config.tracksPrefix, false, this._config.videoSuffix);
  }

  private _audioTrackName(): string {
    return LOCgetTrackName(this._config.tracksPrefix, true, this._config.audioSuffix);
  }

  private async _buildDownloaderConfig(config: MoqVideoConfig): Promise<Record<string, unknown>> {
    let certificateHash: ArrayBuffer | null = null;
    if (config.isLocal) {
      certificateHash = await getBinaryFile(`${location.origin}/certs/certificate_fingerprint.hex`);
    }
    const namespace = splitNamespace(config.namespace);
    const authInfo = config.advancedConfig.authInfo;
    return {
      urlHostPort: config.src,
      backupUrlHostPort: '',
      backupMode: 'none',
      urlPath: '',
      certificateHash,
      packagerFormat: receiverPackagerFormat(config.packager),
      // No `verbose`: the demo player does not send one, so the receiver
      // stays quiet instead of logging every parsed object (one debug
      // message per media chunk, on top of the decoders' own verbose logs).
      moqTracks: {
        audio: {
          alias: 0,
          namespace,
          name: this._audioTrackName(),
          authInfo,
          timebase: MOQ_VIDEO_TIMEBASE,
        },
        video: {
          alias: 1,
          namespace,
          name: this._videoTrackName(),
          authInfo,
          timebase: MOQ_VIDEO_TIMEBASE,
        },
      },
    };
  }

  private _workerUrl(relativePath: string): URL {
    if (this.workerFactory != null) {
      // The factory receives the resolved URL so fakes can tell workers apart.
      return new URL(relativePath, 'moq-video://worker/');
    }
    return new URL(relativePath, import.meta.url);
  }

  private _createWorker(relativePath: string): WorkerLike {
    const url = this._workerUrl(relativePath);
    if (this.workerFactory != null) return this.workerFactory(url);
    return new Worker(url, { type: 'module' });
  }

  private _createWorkers(): void {
    this._downloaderWorker = this._createWorker('../receiver/moq_demuxer_downloader.js');
    this._audioDecoderWorker = this._createWorker('../decode/audio_decoder.js');
    this._videoDecoderWorker = this._createWorker('../decode/video_decoder.js');
  }

  private _attachWorkerListeners(): void {
    const handler = (e: MessageEvent): void => {
      void this._processWorkerMessage(e);
    };
    this._downloaderWorker?.addEventListener('message', handler);
    this._videoDecoderWorker?.addEventListener('message', handler);
    this._audioDecoderWorker?.addEventListener('message', handler);
  }

  private _createVideoRendererBuffer(): void {
    this._videoRendererBuffer = new VideoRenderBuffer(MOQ_VIDEO_TIMEBASE);
  }

  private _createJitterBuffers(): void {
    const advanced = this._config.advancedConfig;
    this._videoJitterBuffer = new JitterBuffer(
      advanced.videoJitterBufferMs,
      (data: {
        groupId: number;
        objId: number;
        firstBufferGroupId: number;
        firstBufferObjId: number;
      }) => {
        console.warn(
          `[VIDEO-JITTER] Dropped late video frame. (${data.groupId}/${data.objId}), current:(${data.firstBufferGroupId}/${data.firstBufferObjId})`,
        );
      },
      MOQ_VIDEO_TIMEBASE,
    );
    this._audioJitterBuffer = new JitterBuffer(
      advanced.audioJitterBufferMs,
      (data: {
        groupId: number;
        objId: number;
        firstBufferGroupId: number;
        firstBufferObjId: number;
      }) => {
        console.warn(
          `[AUDIO-JITTER] Dropped late audio frame. (${data.groupId}/${data.objId}), current:(${data.firstBufferGroupId}/${data.firstBufferObjId})`,
        );
      },
      MOQ_VIDEO_TIMEBASE,
    );
  }

  private _clearJitterBuffers(): void {
    this._videoJitterBuffer = null;
    this._audioJitterBuffer = null;
  }

  private _resetDiagnostics(): void {
    this._lastStatsInfoMs = 0;
    this._diagnostics = {
      receivedFrames: 0,
      paintedFrames: 0,
      hiddenFrames: 0,
      noRendererFrames: 0,
      noFrameAttempts: 0,
      lastRenderResult: 'not-started',
    };
  }

  private _clearTimingInfo(): void {
    this._timing.muxer.currentAudioTs = -1;
    this._timing.muxer.currentVideoTs = -1;
    this._timing.decoder.currentAudioTs = -1;
    this._timing.decoder.currentVideoTs = -1;
    this._timing.renderer.currentAudioTsMs = -1;
    this._timing.renderer.currentVideoTsMs = -1;
  }

  private _clearBufferInfo(): void {
    this._buffers.decoder.audio = { size: -1, lengthMs: -1 };
    this._buffers.decoder.video = { size: -1, lengthMs: -1 };
    this._buffers.renderer.audio = { size: -1, lengthMs: -1, state: AUDIO_STOPPED };
    this._buffers.renderer.video = { size: -1, lengthMs: -1 };
  }

  private _speedCompensationEnabled(): boolean {
    return this._config.advancedConfig.speedCompensation.enabled;
  }

  private _ensurePlaybackRateController(): void {
    if (this._playbackRateController != null) return;
    const comp = this._config.advancedConfig.speedCompensation;
    try {
      this._playbackRateController = new PlaybackRateController({
        targetLatencyMs: this._config.advancedConfig.targetBufferSizeMs,
        onTargetPerct: comp.onTargetRangePercent / 100,
        speedUp: comp.speedUp,
        slowDown: comp.slowDown,
        onLog: (msg: string) => {
          if (this._config.advancedConfig.verbose) console.debug('[PLAYBACK-COMP] ' + msg);
        },
      });
    } catch (err) {
      console.error(
        '[PLAYBACK-COMP] controller not created (invalid config): ' + (err as Error).message,
      );
    }
  }

  private _onToggleSpeedCompensation(): void {
    if (!this._speedCompensationEnabled()) {
      this._playbackRateController?.reset();
      this._audioPlayer?.setPlaybackSpeed(1);
    }
  }

  private _setRelay(mediaType: 'video' | 'audio', relay: string | undefined): void {
    const previous = this._relay[mediaType];
    if (previous === relay) return;
    this._relay[mediaType] = relay;
    this._emit({ type: 'relay', at: Date.now(), mediaType, relay: relay ?? '-' });
  }

  // -- Worker messages (mirrors the demo's processWorkerMessage) ---------------

  private async _processWorkerMessage(e: MessageEvent): Promise<void> {
    const data = e.data ?? {};
    const type = data.type;
    if (
      type === 'debug' ||
      type === 'info' ||
      type === 'warning' ||
      type === 'warn' ||
      type === 'error'
    ) {
      // The video decoder uses 'warn' where the rest use 'warning'.
      const level = (type === 'warn' ? 'warning' : type) as 'debug' | 'info' | 'warning' | 'error';
      this._emitLog(level, String(data.data));
      return;
    }
    if (type === 'videochunk') {
      const extraData = { metadata: data.metadata, codec: data.codec, relay: data.relay ?? 'main' };
      if (this._videoJitterBuffer != null) {
        this._processReleasedVideo(
          this._videoJitterBuffer.AddItem(
            data.chunk,
            data.groupId,
            data.objectId,
            extraData,
            data.isLastInGroup,
          ),
        );
      }
      return;
    }
    if (type === 'audiochunk') {
      const extraData = { metadata: data.metadata, codec: data.codec, relay: data.relay ?? 'main' };
      if (this._audioJitterBuffer != null) {
        this._processReleasedAudio(
          this._audioJitterBuffer.AddItem(
            data.chunk,
            data.groupId,
            data.objectId,
            extraData,
            data.isLastInGroup,
          ),
        );
      }
      return;
    }
    if (type === 'endofgroup') {
      if (data.mediaType === 'audio' && this._audioJitterBuffer != null) {
        this._processReleasedAudio(
          this._audioJitterBuffer.MarkEndOfGroup(data.groupId, data.lastObjId),
        );
      } else if (data.mediaType === 'video' && this._videoJitterBuffer != null) {
        this._processReleasedVideo(
          this._videoJitterBuffer.MarkEndOfGroup(data.groupId, data.lastObjId),
        );
      }
      return;
    }
    if (type === 'aframe') {
      await this._handleAudioFrame(data.frame, data.ts, data.queueSize, data.queueLengthMs);
      return;
    }
    if (type === 'vframe') {
      this._handleVideoFrame(data.frame, data.queueSize, data.queueLengthMs);
      return;
    }
    if (type === 'dropped') {
      const dropped = data.data ?? {};
      const message =
        `${new Date(dropped.clkms).toISOString()} (${dropped.ts}) ${dropped.msg ?? ''}`.trim();
      this._emit({ type: 'dropped', at: Date.now(), message });
      return;
    }
    if (type === 'downloaderstats' || type === 'switchcomplete') {
      // No component surface for these (the demo shows them in its stats UI).
      return;
    }
    console.error('unknown message: ' + JSON.stringify(e.data));
    this._emit({
      type: 'error',
      at: Date.now(),
      message: 'unknown worker message: ' + JSON.stringify(e.data),
    });
  }

  private _processReleasedVideo(releasedVideo: unknown[]): void {
    if (this._videoJitterBuffer == null) return;
    const advanced = this._config.advancedConfig;
    for (const item of releasedVideo) {
      const ordered = item as {
        groupId: number;
        objId: number;
        chunk: { timestamp: number };
        isDisco?: boolean;
        repeatedOrBackwards?: boolean;
        extraData: { relay?: string; metadata?: unknown; codec?: unknown };
      };
      if (ordered.isDisco) {
        console.warn(`VIDEO DISCO detected at (${ordered.groupId}/${ordered.objId})`);
      }
      if (ordered.repeatedOrBackwards) {
        console.warn(
          `VIDEO Repeated or backwards chunk, discarding, (${ordered.groupId}/${ordered.objId})`,
        );
      } else {
        this._timing.muxer.currentVideoTs = ordered.chunk.timestamp;
        this._setRelay('video', ordered.extraData.relay);
        this._videoDecoderWorker?.postMessage({
          type: 'videochunk',
          groupId: ordered.groupId,
          objId: ordered.objId,
          chunk: ordered.chunk,
          metadata: ordered.extraData.metadata,
          codec: ordered.extraData.codec,
          isDisco: ordered.isDisco,
          timebase: MOQ_VIDEO_TIMEBASE,
          verbose: advanced.verbose,
        });
      }
    }
  }

  private _processReleasedAudio(releasedAudio: unknown[]): void {
    if (this._audioJitterBuffer == null) return;
    const advanced = this._config.advancedConfig;
    for (const item of releasedAudio) {
      const ordered = item as {
        groupId: number;
        objId: number;
        chunk: { timestamp: number };
        isDisco?: boolean;
        repeatedOrBackwards?: boolean;
        extraData: { relay?: string; metadata?: unknown; codec?: unknown };
      };
      if (ordered.isDisco) {
        console.warn(`AUDIO DISCO detected at (${ordered.groupId}/${ordered.objId})`);
      }
      if (ordered.repeatedOrBackwards) {
        console.warn(
          `AUDIO Repeated or backwards chunk, discarding, (${ordered.groupId}/${ordered.objId})`,
        );
      } else {
        this._timing.muxer.currentAudioTs = ordered.chunk.timestamp;
        this._setRelay('audio', ordered.extraData.relay);
        this._audioDecoderWorker?.postMessage({
          type: 'audiochunk',
          groupId: ordered.groupId,
          objId: ordered.objId,
          chunk: ordered.chunk,
          metadata: ordered.extraData.metadata,
          codec: ordered.extraData.codec,
          isDisco: ordered.isDisco,
          timebase: MOQ_VIDEO_TIMEBASE,
          verbose: advanced.verbose,
        });
      }
    }
  }

  private async _handleAudioFrame(
    aFrame: { sampleRate: number; numberOfChannels: number; close: () => void },
    ts: number,
    queueSize: number,
    queueLengthMs: number,
  ): Promise<void> {
    this._timing.decoder.currentAudioTs = ts;
    this._buffers.decoder.audio.size = queueSize;
    this._buffers.decoder.audio.lengthMs = queueLengthMs;
    if (this._audioPlayer == null && aFrame.sampleRate > 0) {
      this._audioPlayer = new GapTolerantPlayer({
        sampleRate: aFrame.sampleRate,
        numberOfChannels: aFrame.numberOfChannels,
        timebase: MOQ_VIDEO_TIMEBASE,
        jitterDelay: this._playerBufferMs / 1000,
        fadeIn: true,
        onStats: (stats: PlayerStats) => this._updateAudioStats(stats),
        onLog: (msg: string) => {
          if (this._config.advancedConfig.verbose) console.debug('[AUDIO-PLAYER] ' + msg);
        },
      });
      this._ensurePlaybackRateController();
      await this._audioPlayer.resume();
      if (this._audioPlayer.sampleRate !== aFrame.sampleRate && !this._audioSampleRateWarned) {
        console.error(
          `Audio disabled: browser did not honor requested sample rate. Capture: ${aFrame.sampleRate} Hz, AudioContext: ${this._audioPlayer.sampleRate} Hz (resampling not implemented).`,
        );
        this._audioSampleRateWarned = true;
      }
    }
    if (this._audioPlayer != null && !this._audioSampleRateWarned) {
      this._audioPlayer.addFrame(aFrame as never, ts);
      if (this._animFrame === null) {
        this._animFrame = requestAnimationFrame((t: number) => this._audioTimestamps(t));
      }
    } else {
      aFrame.close();
    }
  }

  private _handleVideoFrame(
    vFrame: { timestamp: number; close: () => void },
    queueSize: number,
    queueLengthMs: number,
  ): void {
    this._diagnostics.receivedFrames++;
    this._timing.decoder.currentVideoTs = vFrame.timestamp;
    this._buffers.decoder.video.size = queueSize;
    this._buffers.decoder.video.lengthMs = queueLengthMs;
    if (typeof document !== 'undefined' && document.hidden) {
      this._diagnostics.hiddenFrames++;
      vFrame.close();
    } else if (this._videoRendererBuffer != null) {
      this._videoRendererBuffer.AddItem(vFrame);
    } else {
      this._diagnostics.noRendererFrames++;
      vFrame.close();
    }
  }

  // -- Audio stats + video render loop (mirrors the demo) ----------------------

  private _updateAudioStats(data: PlayerStats): void {
    if (data.playingTimestampTsMs != null) {
      this._timing.renderer.currentAudioTsMs = data.playingTimestampTsMs;
    }
    this._buffers.renderer.audio.state =
      data.ctxState === 'running' ? AUDIO_PLAYING : AUDIO_STOPPED;
    this._buffers.renderer.audio.lengthMs = data.bufferAhead * 1000;
    if (
      this._audioPlayer != null &&
      this._playbackRateController != null &&
      this._speedCompensationEnabled()
    ) {
      const newSpeed = this._playbackRateController.currentRenderBuffer(
        this._buffers.renderer.audio.lengthMs,
      );
      if (newSpeed != null) {
        this._audioPlayer.setPlaybackSpeed(newSpeed);
      }
    }
    if (this._audioPlayer != null) {
      this._systemAudioLatencyMs = this._audioPlayer.systemLatencyMs;
      this._gapsRecovered = data.gapsRecovered;
      this._lastPlaybackSpeed = this._audioPlayer.getRequestedPlaybackSpeed();
    }
    const now = Date.now();
    if (now - this._lastStatsInfoMs >= STATS_INFO_EVERY_MS) {
      this._lastStatsInfoMs = now;
      this._emit({ type: 'stats', at: now, stats: this.getStats() });
    }
  }

  private _setVideoSize(vFrame: { displayWidth: number; displayHeight: number }): void {
    if (this._canvas == null) return;
    let needsSet = false;
    if (vFrame.displayWidth !== this._currentVideoSize.width) {
      this._currentVideoSize.width = vFrame.displayWidth;
      needsSet = true;
    }
    if (vFrame.displayHeight !== this._currentVideoSize.height) {
      this._currentVideoSize.height = vFrame.displayHeight;
      needsSet = true;
    }
    if (needsSet) {
      this._canvas.width = this._currentVideoSize.width;
      this._canvas.height = this._currentVideoSize.height;
      this._videoCtx = this._canvas.getContext('2d');
      this._emit({
        type: 'video-size',
        at: Date.now(),
        width: this._currentVideoSize.width,
        height: this._currentVideoSize.height,
      });
    }
  }

  private _audioTimestamps(wcTimestamp: number): void {
    const wcInterval = wcTimestamp - this._wcLastRender;
    if (this._audioPlayer != null && wcInterval > RENDER_VIDEO_EVERY_MS) {
      this._wcLastRender = wcTimestamp;
      if (this._videoRendererBuffer != null && this._timing.renderer.currentAudioTsMs >= 0) {
        const retData = this._videoRendererBuffer.GetItemByTsinMs(
          this._timing.renderer.currentAudioTsMs,
        );
        if (retData.vFrame != null) {
          this._setVideoSize(retData.vFrame);
          this._videoCtx?.drawImage(
            retData.vFrame,
            0,
            0,
            retData.vFrame.displayWidth,
            retData.vFrame.displayHeight,
          );
          this._diagnostics.paintedFrames++;
          this._diagnostics.lastRenderResult = 'painted';
          this._timing.renderer.currentVideoTsMs =
            (retData.vFrame.timestamp * 1000) / MOQ_VIDEO_TIMEBASE;
          this._buffers.renderer.video.size = retData.queueSize;
          this._buffers.renderer.video.lengthMs = retData.queueLengthMs;
          if (!this._overlayStopped) {
            try {
              const overlay = this._overlayDecoder.Decode(retData.vFrame);
              if (overlay.confidence === 1) {
                this._lastVideoLatencyMs = Date.now() - Number(overlay.val);
              }
            } catch (err) {
              this._overlayStopped = true;
              this._emitError(`${(err as Error).message}. epoch latency info extractor stopped`);
            }
          }
          retData.vFrame.close();
        } else {
          this._diagnostics.noFrameAttempts++;
          this._diagnostics.lastRenderResult =
            retData.queueSize === 0 ? 'empty-video-buffer' : 'video-ahead-of-audio';
        }
      }
    }
    // Only keep the loop alive while playing: a callback that fires as
    // stop() runs must not re-queue itself into a zombie loop.
    if (this._state === 'playing') {
      this._animFrame = requestAnimationFrame((t: number) => this._audioTimestamps(t));
    } else {
      this._animFrame = null;
    }
  }
}

if (typeof customElements !== 'undefined' && typeof HTMLElement !== 'undefined') {
  if (!customElements.get('moq-video')) {
    customElements.define('moq-video', MoqVideoElement);
  }
}
