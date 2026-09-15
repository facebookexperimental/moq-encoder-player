/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

/**
 * Debug aid: capture the packaged object payloads of a live session so the
 * stream can be inspected offline (ffprobe / ffplay / an MP4 analyzer for CMAF,
 * a bitstream analyzer for LOC).
 *
 * It works with any packager: the capture is a plain concatenation of the MoQ
 * object payloads, which for CMAF is a playable fragmented MP4 and for LOC is
 * the raw elementary stream the encoder produced.
 *
 * Capture starts on the first group boundary of each media type (so a CMAF
 * capture opens with a CMAF Header) and ends when the object cap, the duration
 * cap, or the end of the session is reached. It buffers everything in memory,
 * hence the caps.
 */

import { concatBuffer } from '../moq/buffer_utils.js';
import type { PackagerFormat } from '../packager/media_packager.js';

const LOG_PREFIX = '[MEDIA-DUMPER]';

export const MEDIA_DUMP_DEFAULT_MEDIA_TYPES = ['video', 'audio'];
export const MEDIA_DUMP_DEFAULT_MAX_OBJECTS = 600;

/** What to capture, typically read from the UI / the worker `init` config. */
export interface MediaDumpConfig {
  enabled: boolean;
  // Media types to capture. Defaults to audio and video.
  mediaTypes?: string[];
  // Cap on the captured objects, so a long session cannot exhaust memory.
  maxObjects?: number;
  // Cap on the captured media duration. 0 / undefined means no duration cap.
  maxDurationMs?: number;
}

/** Why a capture stopped, so the caller can tell a full dump from a truncated one. */
export type MediaDumpReason = 'objectCap' | 'durationCap' | 'manual' | 'sessionEnd';

/** One finished capture, ready to be written to disc by the main thread. */
export interface MediaDumpFile {
  mediaType: string;
  data: Uint8Array;
  fileName: string;
  mimeType: string;
  objects: number;
  // Media time covered by the capture, as measured from the object timestamps.
  durationMs: number;
  reason: MediaDumpReason;
}

interface MediaDumpState {
  maxObjects: number;
  maxDurationMs: number;
  started: boolean;
  firstTimestampMs: number | undefined;
  lastTimestampMs: number | undefined;
  chunks: Uint8Array[];
}

/** File name and MIME type for a capture of `format`. */
export function mediaDumpFileInfo(
  format: PackagerFormat,
  mediaType: string,
): { fileName: string; mimeType: string } {
  if (format === 'cmaf') {
    return { fileName: `cmaf-${mediaType}.mp4`, mimeType: 'video/mp4' };
  }
  return { fileName: `${format}-${mediaType}.bin`, mimeType: 'application/octet-stream' };
}

export class MediaDumper {
  private readonly format: PackagerFormat;
  private readonly onFile: (file: MediaDumpFile) => void;
  private states: Record<string, MediaDumpState> = {};

  constructor(format: PackagerFormat, onFile: (file: MediaDumpFile) => void) {
    this.format = format;
    this.onFile = onFile;
  }

  /** Arm every media type asked for by a config, if it is enabled at all. */
  armFromConfig(config: MediaDumpConfig): void {
    this.states = {};
    if (!config.enabled) {
      return;
    }
    for (const mediaType of config.mediaTypes ?? MEDIA_DUMP_DEFAULT_MEDIA_TYPES) {
      this.arm(mediaType, config.maxObjects, config.maxDurationMs);
    }
  }

  /**
   * Start capturing one media type. Capture only begins on the next group
   * boundary, so what is captured can be decoded on its own.
   */
  arm(mediaType: string, maxObjects?: number, maxDurationMs?: number): void {
    this.states[mediaType] = {
      maxObjects: maxObjects === undefined ? MEDIA_DUMP_DEFAULT_MAX_OBJECTS : maxObjects,
      maxDurationMs: maxDurationMs ?? 0,
      started: false,
      firstTimestampMs: undefined,
      lastTimestampMs: undefined,
      chunks: [],
    };
    const limit =
      maxDurationMs !== undefined && maxDurationMs > 0
        ? `${maxDurationMs / 1000}s`
        : `${this.states[mediaType].maxObjects} objects`;
    console.log(
      `${LOG_PREFIX} Armed ${mediaType} ${this.format.toUpperCase()} dump, capturing up to ${limit} from the next group`,
    );
  }

  isArmed(mediaType: string): boolean {
    return this.states[mediaType] !== undefined;
  }

  armedMediaTypes(): string[] {
    return Object.keys(this.states);
  }

  /**
   * Add one packaged object payload to the capture of its media type.
   * `timestampMs` is the media time of the object, used for the duration cap.
   */
  capture(mediaType: string, payload: any, newGroup: boolean, timestampMs?: number): void {
    const state = this.states[mediaType];
    if (state === undefined || !(payload instanceof Uint8Array)) {
      return;
    }
    if (!state.started) {
      if (!newGroup) {
        return;
      }
      state.started = true;
      state.firstTimestampMs = timestampMs;
    }
    // The payload is handed to the transport as-is, so keep a copy.
    state.chunks.push(new Uint8Array(payload));
    state.lastTimestampMs = timestampMs;

    if (state.chunks.length >= state.maxObjects) {
      console.log(
        `${LOG_PREFIX} ${mediaType} dump reached its ${state.maxObjects} object cap, saving it now (the rest of the session is NOT captured)`,
      );
      this.flush(mediaType, false, 'objectCap');
      return;
    }
    if (state.maxDurationMs > 0 && capturedMs(state) >= state.maxDurationMs) {
      this.flush(mediaType, false, 'durationCap');
    }
  }

  /**
   * Hand the captured bytes to the callback and disarm. `skipIfEmpty` is for
   * the end-of-session flush, which must stay quiet when nothing was captured.
   */
  flush(mediaType: string, skipIfEmpty = false, reason: MediaDumpReason = 'manual'): void {
    const state = this.states[mediaType];
    if (skipIfEmpty && (state === undefined || state.chunks.length <= 0)) {
      return;
    }
    delete this.states[mediaType];
    const data = concatBuffer(state?.chunks ?? []);
    const { fileName, mimeType } = mediaDumpFileInfo(this.format, mediaType);
    const objects = state?.chunks.length ?? 0;
    const durationMs = state === undefined ? 0 : capturedMs(state);
    console.log(
      `${LOG_PREFIX} Dumping ${objects} ${mediaType} objects, ${(durationMs / 1000).toFixed(1)}s of media (${data.byteLength} bytes) to ${fileName} [${reason}]`,
    );
    this.onFile({ mediaType, data, fileName, mimeType, objects, durationMs, reason });
  }

  /** Save whatever every armed capture collected so far (end of session). */
  flushAll(): void {
    for (const mediaType of this.armedMediaTypes()) {
      this.flush(mediaType, true, 'sessionEnd');
    }
  }
}

// Media time covered by a capture. 0 while the object timestamps are unknown
// (an opaque data track), which also disables the duration cap.
function capturedMs(state: MediaDumpState): number {
  if (state.firstTimestampMs === undefined || state.lastTimestampMs === undefined) {
    return 0;
  }
  return state.lastTimestampMs - state.firstTimestampMs;
}
