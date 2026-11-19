/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

/**
 * Pure configuration logic for the `<moq-video>` custom element.
 *
 * This module has no DOM, Worker, or network dependency so it can be unit
 * tested in Node. The element itself (moq_video.ts) only adds the lifecycle,
 * the shadow-DOM canvas, and the worker/render pipeline on top of it.
 *
 * The values mirror the full demo player (demo/player/index.html): the
 * connection fields at the top of that page, and every field inside its
 * "Advanced" panel. The demo itself is untouched; this is the component's
 * view of the same settings.
 */

/** User-facing packager names. The receiver only understands 'cmaf'/'loc'. */
export type MoqVideoPackager = 'CMSF' | 'LOC';

/** How the canvas is sized. Mirrors the demo's display-mode selector. */
export type MoqVideoSizeStrategy = 'fitInCanvas' | 'original';

/** Speed-compensation settings (the demo's "Playback compensation" fieldset). */
export interface MoqVideoSpeedCompensationConfig {
  /** Enable speed compensation. Default: true. */
  enabled: boolean;
  /** On-target band as a percent of the target, e.g. 20 = +/-20%. Default: 20. */
  onTargetRangePercent: number;
  /** Playback rate while draining an over-full buffer, (1, 2]. Default: 1.05. */
  speedUp: number;
  /** Playback rate while refilling an under-full buffer, [0.5, 1). Default: 0.95. */
  slowDown: number;
}

/**
 * Everything inside the demo player's "Advanced" panel, plus the verbose
 * logging gate (the demo's `?verbose=1` query flag, on by default).
 */
export interface MoqVideoAdvancedConfig {
  /** Out-of-band token sent as `authInfo`. '' = no token. Default: 'secret'. */
  authInfo: string;
  /** Playback target latency in ms; derives the three buffers below. [10, 30000]. */
  targetBufferSizeMs: number;
  /** Audio render buffer in ms. Default: 200 (the target, when derived). */
  audioRenderBufferMs: number;
  /** Audio de-jitter buffer cap in ms. Default: 160 (target - 40 headroom). */
  audioJitterBufferMs: number;
  /** Video de-jitter buffer cap in ms. Default: 160 (target - 40 headroom). */
  videoJitterBufferMs: number;
  /** Playback speed compensation. */
  speedCompensation: MoqVideoSpeedCompensationConfig;
  /** Verbose `console.debug` logging, including the 1 Hz diagnostics. Default: true. */
  verbose: boolean;
}

/** Partial input for `advancedConfig`: every field optional, nested too. */
export interface MoqVideoAdvancedConfigInput {
  authInfo?: string;
  /** Alias for `authInfo`, matching the demo's "Token" label. */
  token?: string;
  targetBufferSizeMs?: number;
  /** Alias for `targetBufferSizeMs`, matching the demo field name. */
  playbackTargetLatencyMs?: number;
  audioRenderBufferMs?: number;
  /** Alias for `audioRenderBufferMs`, matching the demo field name. */
  playerBufferMs?: number;
  audioJitterBufferMs?: number;
  videoJitterBufferMs?: number;
  speedCompensation?: Partial<MoqVideoSpeedCompensationConfig> & {
    /** Alias for `onTargetRangePercent`, matching the demo field name. */
    onTargetRangePerct?: number;
  };
  verbose?: boolean;
}

/** Everything the element needs, fully resolved with defaults applied. */
export interface MoqVideoConfig {
  /** Relay URL, e.g. 'https://localhost:4433/moq'. Only mandatory value. */
  src: string;
  /** Track namespace, '/'-separated tuples, e.g. 'vc'. Default: 'vc'. */
  namespace: string;
  /** Track-name prefix prepended to both suffixes. Default: ''. */
  tracksPrefix: string;
  /** Video track suffix. Default: 'video0'. */
  videoSuffix: string;
  /** Audio track suffix. Default: 'audio0'. */
  audioSuffix: string;
  /** Media packager the encoder publishes. Default: 'CMSF'. */
  packager: MoqVideoPackager;
  /** Advanced panel settings. */
  advancedConfig: MoqVideoAdvancedConfig;
  /** Canvas sizing. Default: 'fitInCanvas'. */
  sizeStrategy: MoqVideoSizeStrategy;
  /** Fetch the relay certificate fingerprint from `/certs/`. Default: false. */
  isLocal: boolean;
}

/** Partial input for a full config: only `src` is required. */
export type MoqVideoConfigInput = Partial<Omit<MoqVideoConfig, 'advancedConfig'>> &
  Pick<MoqVideoConfig, 'src'> & { advancedConfig?: MoqVideoAdvancedConfigInput };

export const MOQ_VIDEO_DEFAULTS = {
  namespace: 'vc',
  tracksPrefix: '',
  videoSuffix: 'video0',
  audioSuffix: 'audio0',
  packager: 'CMSF' as MoqVideoPackager,
  sizeStrategy: 'fitInCanvas' as MoqVideoSizeStrategy,
  isLocal: false,
} as const;

/** Headroom subtracted from the target to derive each de-jitter cap. */
export const MOQ_VIDEO_DEJITTER_HEADROOM_MS = 40;
export const MOQ_VIDEO_TARGET_BUFFER_MIN_MS = 10;
export const MOQ_VIDEO_TARGET_BUFFER_MAX_MS = 30000;
/** Per-track timebase (ticks/sec), hardcoded to microseconds in the demo. */
export const MOQ_VIDEO_TIMEBASE = 1_000_000;

export const DEFAULT_SPEED_COMPENSATION: MoqVideoSpeedCompensationConfig = {
  enabled: true,
  onTargetRangePercent: 20,
  speedUp: 1.05,
  slowDown: 0.95,
};

export const DEFAULT_ADVANCED_CONFIG: MoqVideoAdvancedConfig = {
  authInfo: 'secret',
  targetBufferSizeMs: 200,
  audioRenderBufferMs: 200,
  audioJitterBufferMs: 160,
  videoJitterBufferMs: 160,
  speedCompensation: { ...DEFAULT_SPEED_COMPENSATION },
  verbose: true,
};

/** Derive the detailed buffers from a target, exactly as the demo does. */
export function deriveDetailedBuffers(targetBufferSizeMs: number): {
  audioRenderBufferMs: number;
  audioJitterBufferMs: number;
  videoJitterBufferMs: number;
} {
  const dejitterMs = Math.max(targetBufferSizeMs - MOQ_VIDEO_DEJITTER_HEADROOM_MS, 0);
  return {
    audioRenderBufferMs: targetBufferSizeMs,
    audioJitterBufferMs: dejitterMs,
    videoJitterBufferMs: dejitterMs,
  };
}

export function validateTargetBufferSize(value: number, field = 'targetBufferSizeMs'): number {
  if (
    !Number.isFinite(value) ||
    value < MOQ_VIDEO_TARGET_BUFFER_MIN_MS ||
    value > MOQ_VIDEO_TARGET_BUFFER_MAX_MS
  ) {
    throw new RangeError(
      `${field} must be in [${MOQ_VIDEO_TARGET_BUFFER_MIN_MS}, ${MOQ_VIDEO_TARGET_BUFFER_MAX_MS}] ms, got ${value}`,
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** 'CMSF'/'CMAF' -> 'CMSF', 'LOC' -> 'LOC'; anything else throws. */
export function normalizePackager(value: unknown): MoqVideoPackager {
  const normalized = String(value ?? '')
    .trim()
    .toUpperCase();
  if (normalized === 'CMSF' || normalized === 'CMAF') return 'CMSF';
  if (normalized === 'LOC') return 'LOC';
  throw new RangeError(`packager must be 'CMSF' or 'LOC', got ${JSON.stringify(value)}`);
}

/**
 * Accepts 'fitInCanvas' (and the demo's 'fit') and 'original' (and
 * 'originalResolution'). Anything else throws.
 */
export function normalizeSizeStrategy(value: unknown): MoqVideoSizeStrategy {
  const normalized = String(value ?? '').trim();
  if (normalized === 'fitInCanvas' || normalized === 'fit') return 'fitInCanvas';
  if (normalized === 'original' || normalized === 'originalResolution') return 'original';
  throw new RangeError(
    `sizeStrategy must be 'fitInCanvas' or 'original', got ${JSON.stringify(value)}`,
  );
}

/** Merge a partial advanced config over a base (defaults when omitted). */
export function normalizeAdvancedConfig(
  input: MoqVideoAdvancedConfigInput | undefined | null,
  base: MoqVideoAdvancedConfig = DEFAULT_ADVANCED_CONFIG,
): MoqVideoAdvancedConfig {
  const merged: MoqVideoAdvancedConfig = {
    ...base,
    speedCompensation: { ...base.speedCompensation },
  };
  if (input == null) return merged;
  if (!isRecord(input)) throw new TypeError('advancedConfig must be an object');
  if (input.authInfo !== undefined) merged.authInfo = String(input.authInfo);
  if (input.token !== undefined) merged.authInfo = String(input.token);
  const target = input.targetBufferSizeMs ?? input.playbackTargetLatencyMs;
  if (target !== undefined) {
    merged.targetBufferSizeMs = validateTargetBufferSize(Number(target));
    Object.assign(merged, deriveDetailedBuffers(merged.targetBufferSizeMs));
  }
  if (input.audioRenderBufferMs !== undefined) {
    merged.audioRenderBufferMs = Number(input.audioRenderBufferMs);
  }
  if (input.playerBufferMs !== undefined) merged.audioRenderBufferMs = Number(input.playerBufferMs);
  if (input.audioJitterBufferMs !== undefined) {
    merged.audioJitterBufferMs = Number(input.audioJitterBufferMs);
  }
  if (input.videoJitterBufferMs !== undefined) {
    merged.videoJitterBufferMs = Number(input.videoJitterBufferMs);
  }
  const comp = input.speedCompensation;
  if (comp != null) {
    if (!isRecord(comp)) throw new TypeError('advancedConfig.speedCompensation must be an object');
    if (comp.enabled !== undefined) merged.speedCompensation.enabled = Boolean(comp.enabled);
    const range = comp.onTargetRangePercent ?? comp.onTargetRangePerct;
    if (range !== undefined) merged.speedCompensation.onTargetRangePercent = Number(range);
    if (comp.speedUp !== undefined) merged.speedCompensation.speedUp = Number(comp.speedUp);
    if (comp.slowDown !== undefined) merged.speedCompensation.slowDown = Number(comp.slowDown);
  }
  if (input.verbose !== undefined) merged.verbose = Boolean(input.verbose);
  return merged;
}

/** Split a namespace string on '/' and drop empty tuples. */
export function splitNamespace(namespace: string): string[] {
  return String(namespace)
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/** Track name: the demo concatenates prefix + suffix with no separator. */
export function buildTrackName(tracksPrefix: string, suffix: string): string {
  return `${tracksPrefix}${suffix}`;
}

/** Validate a resolved config the way the demo validates its fields. */
export function validateMoqVideoConfig(config: MoqVideoConfig): void {
  if (typeof config.src !== 'string' || config.src.trim() === '') {
    throw new TypeError('src is mandatory: a relay URL such as https://localhost:4433/moq');
  }
  try {
    // Throws on malformed URLs; the receiver opens this with WebTransport.
    new URL(config.src);
  } catch {
    throw new TypeError(`src must be a valid URL, got ${JSON.stringify(config.src)}`);
  }
  if (splitNamespace(config.namespace).length === 0) {
    throw new TypeError('namespace must contain at least one tuple');
  }
  if (config.tracksPrefix === '' && (config.videoSuffix === '' || config.audioSuffix === '')) {
    throw new Error('"tracksPrefix" is empty, so "videoSuffix" and "audioSuffix" can NOT be empty');
  }
  validateTargetBufferSize(config.advancedConfig.targetBufferSizeMs);
}

/** Fill every default; only `src` must be supplied. */
export function resolveMoqVideoConfig(input: MoqVideoConfigInput): MoqVideoConfig {
  if (input == null || !isRecord(input)) throw new TypeError('config must be an object with src');
  const config: MoqVideoConfig = {
    src: String(input.src ?? ''),
    namespace:
      input.namespace !== undefined ? String(input.namespace) : MOQ_VIDEO_DEFAULTS.namespace,
    tracksPrefix:
      input.tracksPrefix !== undefined
        ? String(input.tracksPrefix)
        : MOQ_VIDEO_DEFAULTS.tracksPrefix,
    videoSuffix:
      input.videoSuffix !== undefined ? String(input.videoSuffix) : MOQ_VIDEO_DEFAULTS.videoSuffix,
    audioSuffix:
      input.audioSuffix !== undefined ? String(input.audioSuffix) : MOQ_VIDEO_DEFAULTS.audioSuffix,
    packager:
      input.packager !== undefined
        ? normalizePackager(input.packager)
        : MOQ_VIDEO_DEFAULTS.packager,
    advancedConfig: normalizeAdvancedConfig(input.advancedConfig),
    sizeStrategy:
      input.sizeStrategy !== undefined
        ? normalizeSizeStrategy(input.sizeStrategy)
        : MOQ_VIDEO_DEFAULTS.sizeStrategy,
    isLocal: input.isLocal !== undefined ? Boolean(input.isLocal) : MOQ_VIDEO_DEFAULTS.isLocal,
  };
  validateMoqVideoConfig(config);
  return config;
}

/** Deep copy of a resolved advanced config (so callers cannot mutate state). */
export function cloneAdvancedConfig(config: MoqVideoAdvancedConfig): MoqVideoAdvancedConfig {
  return { ...config, speedCompensation: { ...config.speedCompensation } };
}

/** The `packagerFormat` string the receiver worker expects. */
export function receiverPackagerFormat(packager: MoqVideoPackager): 'cmaf' | 'loc' {
  return packager === 'CMSF' ? 'cmaf' : 'loc';
}
