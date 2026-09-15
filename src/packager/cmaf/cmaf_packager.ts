/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

// CMSF (CMAF packaging for MOQT), https://datatracker.ietf.org/doc/draft-ietf-moq-cmsf/.
// Written against "draft-wilaw-moq-cmafpackaging-01" (local-scratch/moqt-cmaf.txt),
// the individual draft the working group adopted as draft-ietf-moq-cmsf, with the
// box syntax of CMAF (ISO/IEC 23000-19) and ISOBMFF (ISO/IEC 14496-12).
//
// Mapping used here (§4.2, "CMAF Chunk to MOQT Object"):
//
//   1 encoded frame = 1 CMAF chunk (moof + mdat, one sample) = 1 MOQT Object
//   1 CMAF fragment (GOP)                                    = 1 MOQT Group
//
// which is exactly the grouping the sender already applies to LOC (a new group
// starts on every key frame), so nothing changes in the MoQ / QUIC layer.
//
// Two things to know before comparing this against the draft:
//
//  * Initialization header (§6). The draft offers a binary blob delivered by the
//    streaming format (§6.1) or a dedicated init MOQT track (§6.2). This project
//    has no catalog and no out-of-band channel, so instead the CMAF Header
//    (ftyp + moov) is PREPENDED to the first object of a group, which makes each
//    group self-initializing. It is repeated at most every
//    `initRepeatEveryMs` (see CMAFPackagerOptions) so that per-frame audio
//    groups do not pay ~600 bytes of moov per 20ms frame.
//  * Object payload (§3). Every object payload here is
//    `[ftyp moov] styp moof mdat`, i.e. the mandated "styp followed by media
//    fragments" plus the optional self-initializing prefix above.
//
// Unlike LOC, CMAF is self-describing: timing, codec and key-frame information
// all live inside the boxes, so `Properties()` returns no MoQ Object Properties.

import type { MediaPackager, PackagerSourceInfo } from '../media_packager.js';
import type { KvPair } from '../../moq/moqt.js';
import { concatBuffer } from '../../moq/buffer_utils.js';
import { GetAudioDecoderConfig } from '../../utils/media/audio_decoder_config_parser.js';
import { box, fourCC, fullBox, u32, u64 } from './box_writer.js';
import { createCMAFInitSegment, type CMAFMediaType } from './cmaf_init_segment.js';

export const CMAF_PACKAGER_VERSION = 'cmafpackaging-01(self-init)';

// Each MOQT track carries a single ISOBMFF track (§3), always with this id.
const CMAF_TRACK_ID = 1;

// Used for the very first sample only, when WebCodecs reports no duration and
// there is no previous timestamp to diff against.
const DEFAULT_VIDEO_SAMPLE_DURATION_US = 33_333; // ~30fps
const DEFAULT_AUDIO_SAMPLE_DURATION_US = 20_000; // 20ms

// How often the self-initializing CMAF Header is repeated, in media time.
const DEFAULT_INIT_REPEAT_EVERY_MS = 1000;

// `trun` sample_flags (ISO/IEC 14496-12 §8.8.3.1): sample_depends_on = 2 means
// "does not depend on others" (an I frame), 1 means "depends on others", and
// bit 16 is sample_is_non_sync_sample.
const SAMPLE_FLAGS_KEY = 0x02000000;
const SAMPLE_FLAGS_DELTA = 0x01010000;

// `tfhd` flags: default-base-is-moof, so every data_offset in `trun` is
// relative to the start of the enclosing `moof`.
const TFHD_FLAG_DEFAULT_BASE_IS_MOOF = 0x020000;

// `trun` flags: data-offset-present | sample-duration-present |
// sample-size-present | sample-flags-present.
const TRUN_FLAGS = 0x000001 | 0x000100 | 0x000200 | 0x000400;

const MDAT_HEADER_LENGTH = 8;

export interface CMAFPackagerOptions {
  // Minimum media time between two CMAF Headers. 0 repeats it on every group
  // (every group self-initializing, at the cost of bitrate on audio tracks).
  initRepeatEveryMs?: number;
}

export class CMAFPackager implements MediaPackager {
  readonly mediaType: CMAFMediaType;

  // Set per chunk by SetData (same signature as LOCPackager).
  private timestamp: number | undefined;
  // Timescale of `timestamp`, i.e. the WebCodecs timebase (microseconds).
  private sourceTimescale: number | undefined;
  private codec: string | undefined;
  private config: Uint8Array | undefined;
  private data: Uint8Array | undefined;
  private isDelta: boolean | undefined;

  // Extra per-chunk / per-source information LOC does not need.
  private codedWidth: number | undefined;
  private codedHeight: number | undefined;
  private chunkDurationUs: number | undefined;
  private startsGroup: boolean | undefined;

  // Packaging state that must survive across chunks.
  private initSegment: Uint8Array | undefined;
  private initConfig: Uint8Array | undefined;
  private initSentAtUs: number | undefined;
  private sequenceNumber = 0;
  private lastTimestamp: number | undefined;
  private mediaTimescale: number | undefined;
  private missingConfigWarned = false;

  private readonly initRepeatEveryUs: number;

  constructor(mediaType: CMAFMediaType, options: CMAFPackagerOptions = {}) {
    this.mediaType = mediaType;
    this.initRepeatEveryUs = (options.initRepeatEveryMs ?? DEFAULT_INIT_REPEAT_EVERY_MS) * 1000;
  }

  SetData(
    timestamp: number | undefined,
    timescale: number | undefined,
    codec: string | undefined,
    config: Uint8Array | ArrayBuffer | undefined,
    data: any,
    isDelta: boolean | undefined,
  ): void {
    this.timestamp = timestamp;
    this.sourceTimescale = timescale;
    this.codec = codec;
    this.config = config === undefined ? undefined : toUint8Array(config);
    this.data = data === undefined || data === null ? undefined : toUint8Array(data);
    this.isDelta = isDelta;
  }

  /**
   * Per-chunk extras that the LOC `SetData` shape has no room for: the coded
   * dimensions (needed by `tkhd` / the visual sample entry), the WebCodecs chunk
   * duration (needed by `trun`), and whether this chunk starts a MoQ group
   * (which is where the CMAF Header goes). All optional; see
   * `sampleDurationInSourceUnits` and `startsNewGroup` for the fallbacks.
   */
  SetSourceInfo(info: PackagerSourceInfo): void {
    if (info.codedWidth !== undefined && info.codedWidth > 0) {
      this.codedWidth = info.codedWidth;
    }
    if (info.codedHeight !== undefined && info.codedHeight > 0) {
      this.codedHeight = info.codedHeight;
    }
    this.chunkDurationUs = info.durationUs;
    this.startsGroup = info.startsGroup;
  }

  IsDelta(): boolean | undefined {
    return this.isDelta;
  }

  /** CMAF is self-describing: nothing rides the MoQ Object Properties. */
  Properties(): KvPair[] {
    return [];
  }

  /** `[ftyp moov] styp moof mdat` for this chunk. */
  PayloadToBytes(): Uint8Array {
    if (this.timestamp === undefined) {
      throw new Error(`${this.mediaType} CMAF objects need a timestamp`);
    }
    const payload = this.data ?? new Uint8Array();
    // The CMAF Header rides the first object of a group. With several audio
    // frames per group that is not every key frame, so the sender says so
    // explicitly; fall back to the frame type when it does not.
    const startsGroup = this.startsGroup ?? this.isDelta !== true;

    const timescale = this.resolveMediaTimescale();
    const decodeTime = this.toMediaTime(this.timestamp, timescale);
    const duration = this.toMediaTime(this.sampleDurationInSourceUnits(), timescale);

    const parts: Uint8Array[] = [];
    const initSegment = startsGroup ? this.initSegmentToSend() : undefined;
    if (initSegment !== undefined) {
      parts.push(initSegment);
      this.initSentAtUs = this.timestamp;
    }
    parts.push(createStyp());
    parts.push(...this.createChunk(decodeTime, duration, payload));

    this.lastTimestamp = this.timestamp;
    return concatBuffer(parts);
  }

  GetDataStr(): string {
    const configSize = this.config === undefined ? 0 : this.config.byteLength;
    const dataSize = this.data === undefined ? 0 : this.data.byteLength;
    return `mediaType: ${this.mediaType} - timestamp: ${this.timestamp} - timescale: ${this.sourceTimescale} - codec: ${this.codec} - configSize: ${configSize} - dataSize: ${dataSize} - moofSeq: ${this.sequenceNumber}`;
  }

  // ---------------------------------------------------------------------------
  // Media fragment (one CMAF chunk = one sample)
  // ---------------------------------------------------------------------------

  private createChunk(decodeTime: number, duration: number, payload: Uint8Array): Uint8Array[] {
    // Every chunk gets its own `moof`, and `mfhd` sequence numbers increase in
    // chunk order (CMAF §7.3.2.3).
    const sequenceNumber = ++this.sequenceNumber;
    const sampleFlags = this.isDelta === true ? SAMPLE_FLAGS_DELTA : SAMPLE_FLAGS_KEY;

    // data_offset is measured from the start of the `moof`, and the `moof` size
    // does not depend on the value itself (it is a fixed-width u32), so build it
    // once to learn the size and once more with the real offset.
    const probe = createMoof(
      sequenceNumber,
      decodeTime,
      duration,
      payload.byteLength,
      0,
      sampleFlags,
    );
    const dataOffset = probe.byteLength + MDAT_HEADER_LENGTH;
    const moof = createMoof(
      sequenceNumber,
      decodeTime,
      duration,
      payload.byteLength,
      dataOffset,
      sampleFlags,
    );
    return [moof, box('mdat', payload)];
  }

  // ---------------------------------------------------------------------------
  // Initialization header
  // ---------------------------------------------------------------------------

  /**
   * The CMAF Header to prepend to this object, or undefined when the subscriber
   * does not need a fresh copy yet (see `initRepeatEveryMs`).
   */
  private initSegmentToSend(): Uint8Array | undefined {
    this.refreshInitSegment();
    if (this.initSegment === undefined) {
      return undefined;
    }
    if (this.initSentAtUs === undefined) {
      return this.initSegment;
    }
    const elapsedUs = (this.timestamp ?? 0) - this.initSentAtUs;
    return elapsedUs >= this.initRepeatEveryUs ? this.initSegment : undefined;
  }

  // (Re)build the CMAF Header when the decoder config appears or changes.
  private refreshInitSegment(): void {
    if (this.config === undefined || this.config.byteLength <= 0) {
      if (this.initSegment === undefined && !this.missingConfigWarned) {
        this.missingConfigWarned = true;
        console.warn(
          `[CMAF-PACKAGER] No decoder config yet for the ${this.mediaType} track, objects are sent without a CMAF Header`,
        );
      }
      return;
    }
    if (this.initSegment !== undefined && bytesEqual(this.initConfig, this.config)) {
      return;
    }
    if (
      this.mediaType === 'video' &&
      (this.codedWidth === undefined || this.codedHeight === undefined)
    ) {
      // Not fatal: ffmpeg-class demuxers read the real dimensions from the SPS
      // inside `avcC`, but the boxes would advertise 0x0.
      console.warn('[CMAF-PACKAGER] Video dimensions unknown, the CMAF Header will advertise 0x0');
    }
    const initSegment = this.buildInitSegment();
    if (initSegment === undefined) {
      return;
    }
    this.initSegment = initSegment;
    this.initConfig = this.config;
    // A new header must reach the subscriber before the media that needs it.
    this.initSentAtUs = undefined;
  }

  // A decoder config this packager cannot describe (an exotic
  // AudioSpecificConfig, say) must not take the publishing session down: warn,
  // keep the previous header if there is one, and keep sending media.
  private buildInitSegment(): Uint8Array | undefined {
    try {
      return createCMAFInitSegment({
        mediaType: this.mediaType,
        trackId: CMAF_TRACK_ID,
        timescale: this.resolveMediaTimescale(),
        codec: this.codec ?? '',
        config: this.config!,
        codedWidth: this.codedWidth,
        codedHeight: this.codedHeight,
      });
    } catch (err: any) {
      console.error(
        `[CMAF-PACKAGER] Could not build the ${this.mediaType} CMAF Header: ${err?.message}`,
      );
      return undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // Timing
  // ---------------------------------------------------------------------------

  /**
   * Media (`mdhd`) timescale. Video keeps the WebCodecs microsecond timebase;
   * audio uses its sample rate, as CMAF recommends (23000-19 §7.5.13). It is
   * resolved once and cached: changing it mid-track would invalidate every
   * timestamp already sent.
   */
  private resolveMediaTimescale(): number {
    if (this.mediaTimescale !== undefined) {
      return this.mediaTimescale;
    }
    let timescale = this.requireSourceTimescale();
    if (this.mediaType === 'audio' && this.config !== undefined && this.codec !== undefined) {
      try {
        timescale = GetAudioDecoderConfig(this.codec, this.config).sampleRate;
      } catch (err: any) {
        console.warn(
          `[CMAF-PACKAGER] Could not read the audio sample rate (${err?.message}), using the ${timescale} timebase as the media timescale`,
        );
      }
    }
    this.mediaTimescale = timescale;
    return timescale;
  }

  /**
   * Timescale of the timestamps the caller passes in. There is no safe default:
   * guessing it would silently scale every timestamp in the stream.
   */
  private requireSourceTimescale(): number {
    if (this.sourceTimescale === undefined || this.sourceTimescale <= 0) {
      throw new Error(`${this.mediaType} CMAF objects need a source timescale`);
    }
    return this.sourceTimescale;
  }

  private toMediaTime(sourceTime: number, mediaTimescale: number): number {
    const sourceTimescale = this.requireSourceTimescale();
    if (mediaTimescale === sourceTimescale) {
      return sourceTime;
    }
    // Rounded per chunk from an absolute source timestamp, so the error stays
    // below one tick instead of accumulating.
    return Math.round((sourceTime * mediaTimescale) / sourceTimescale);
  }

  /**
   * Sample duration in source (WebCodecs, microsecond) units. WebCodecs always
   * reports a duration for audio, but frames captured from a camera often carry
   * none, so fall back to the interval since the previous chunk: a live stream
   * has no lookahead, which makes this the freshest estimate available. `tfdt`
   * stays exact either way, so an off-by-a-little duration only affects the
   * last sample of the stream.
   */
  private sampleDurationInSourceUnits(): number {
    if (this.chunkDurationUs !== undefined && this.chunkDurationUs > 0) {
      return this.chunkDurationUs;
    }
    if (this.lastTimestamp !== undefined && this.timestamp! > this.lastTimestamp) {
      return this.timestamp! - this.lastTimestamp;
    }
    return this.mediaType === 'video'
      ? DEFAULT_VIDEO_SAMPLE_DURATION_US
      : DEFAULT_AUDIO_SAMPLE_DURATION_US;
  }
}

/** Segment Type Box. 'cmfl' is the CMAF chunk brand (23000-19 Annex A). */
function createStyp(): Uint8Array {
  return box(
    'styp',
    fourCC('cmfl'),
    u32(0), // minor_version
    fourCC('cmfl'),
    fourCC('cmfs'),
    fourCC('msdh'),
    fourCC('iso6'),
  );
}

function createMoof(
  sequenceNumber: number,
  decodeTime: number,
  duration: number,
  sampleSize: number,
  dataOffset: number,
  sampleFlags: number,
): Uint8Array {
  const mfhd = fullBox('mfhd', 0, 0, u32(sequenceNumber));
  const tfhd = fullBox('tfhd', 0, TFHD_FLAG_DEFAULT_BASE_IS_MOOF, u32(CMAF_TRACK_ID));
  // Version 1: a 64 bit baseMediaDecodeTime, which a long-running live stream
  // will eventually need.
  const tfdt = fullBox('tfdt', 1, 0, u64(decodeTime));
  const trun = fullBox(
    'trun',
    0,
    TRUN_FLAGS,
    u32(1), // sample_count
    u32(dataOffset),
    u32(duration),
    u32(sampleSize),
    u32(sampleFlags),
  );
  return box('moof', mfhd, box('traf', tfhd, tfdt, trun));
}

function toUint8Array(data: Uint8Array | ArrayBuffer | any): Uint8Array {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  return new Uint8Array(data.buffer ?? data);
}

function bytesEqual(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  if (a === undefined || b === undefined) {
    return false;
  }
  if (a === b) {
    return true;
  }
  if (a.byteLength !== b.byteLength) {
    return false;
  }
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}
