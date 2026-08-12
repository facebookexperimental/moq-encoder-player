/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

// Builds a CMAF Header (ISO/IEC 23000-19 §7.3.2.1): the `ftyp` + `moov` pair
// that initializes one CMAF Track. It describes the track but references no
// media samples, so all the sample tables in `stbl` are empty and the sample
// defaults live in `mvex`/`trex`.
//
// One CMAF Track per MOQT track, so the movie always holds exactly ONE ISOBMFF
// track (draft-wilaw-moq-cmafpackaging-01 §3).

import {
  box,
  fixed16x16,
  fixed8x8,
  fourCC,
  fullBox,
  i16,
  u16,
  u24,
  u32,
  u8,
  zeros,
  UNITY_MATRIX,
} from './box_writer.js';
import { concatBuffer } from '../../moq/buffer_utils.js';
import { GetAudioDecoderConfig } from '../../utils/media/audio_decoder_config_parser.js';

// Movie header timescale. Only the media (`mdhd`) timescale matters for
// timing; the movie one is never used because the duration is always 0 (live).
const MOVIE_TIMESCALE = 1000;

// ISO-639-2/T "und" (undetermined), packed as 3 x 5 bits.
const LANGUAGE_UNDETERMINED = 0x55c4;

// MPEG-4 Audio (ISO/IEC 14496-3) object type indication and stream type, used
// in the `esds` DecoderConfigDescriptor for AAC.
const ESDS_OTI_MPEG4_AUDIO = 0x40;
const ESDS_STREAM_TYPE_AUDIO = 0x15; // (streamType 5 << 2) | upStream 0 | reserved 1

export type CMAFMediaType = 'audio' | 'video';

export interface CMAFTrackParams {
  mediaType: CMAFMediaType;
  trackId: number;
  // Media timescale (ticks per second) used by `mdhd`, `tfdt` and `trun`.
  timescale: number;
  // WebCodecs codec string ('avc1.42001e', 'opus', 'mp4a.40.2', ...).
  codec: string;
  // WebCodecs decoder `description`: an AVCDecoderConfigurationRecord, an
  // OpusHead, or an AAC AudioSpecificConfig.
  config: Uint8Array;
  // Video only. The visual sample entry / `tkhd` dimensions.
  codedWidth?: number;
  codedHeight?: number;
  // Audio only. Parsed from `config` when not given.
  sampleRate?: number;
  numberOfChannels?: number;
}

/** `ftyp` + `moov` for one CMAF Track. */
export function createCMAFInitSegment(params: CMAFTrackParams): Uint8Array {
  return concatBuffer([createFtyp(params), createMoov(params)]);
}

function createFtyp(params: CMAFTrackParams): Uint8Array {
  // 'cmfc': CMAF Track (23000-19 §A.1). 'iso6' is required by the `trun`
  // version-1 / `tfdt` usage, 'msdh' marks the media segments as self-
  // describing, and 'avc1'/'mp42' keep generic ISOBMFF readers happy.
  const brands = ['cmfc', 'iso6', 'isom', 'msdh'];
  brands.push(params.mediaType === 'video' ? 'avc1' : 'mp42');
  return box(
    'ftyp',
    fourCC('cmfc'),
    u32(0), // minor_version
    ...brands.map(fourCC),
  );
}

function createMoov(params: CMAFTrackParams): Uint8Array {
  return box('moov', createMvhd(params), createTrak(params), createMvex(params));
}

function createMvhd(params: CMAFTrackParams): Uint8Array {
  return fullBox(
    'mvhd',
    0,
    0,
    u32(0), // creation_time
    u32(0), // modification_time
    u32(MOVIE_TIMESCALE),
    u32(0), // duration: unknown (live)
    fixed16x16(1), // rate
    fixed8x8(1), // volume
    zeros(2 + 8), // reserved
    UNITY_MATRIX,
    zeros(6 * 4), // pre_defined
    u32(params.trackId + 1), // next_track_ID
  );
}

function createTrak(params: CMAFTrackParams): Uint8Array {
  return box('trak', createTkhd(params), createMdia(params));
}

function createTkhd(params: CMAFTrackParams): Uint8Array {
  const isVideo = params.mediaType === 'video';
  // flags: track_enabled | track_in_movie | track_in_preview
  return fullBox(
    'tkhd',
    0,
    0x000007,
    u32(0), // creation_time
    u32(0), // modification_time
    u32(params.trackId),
    u32(0), // reserved
    u32(0), // duration: unknown (live)
    zeros(8), // reserved
    i16(0), // layer
    i16(0), // alternate_group
    fixed8x8(isVideo ? 0 : 1), // volume
    zeros(2), // reserved
    UNITY_MATRIX,
    fixed16x16(isVideo ? (params.codedWidth ?? 0) : 0),
    fixed16x16(isVideo ? (params.codedHeight ?? 0) : 0),
  );
}

function createMdia(params: CMAFTrackParams): Uint8Array {
  return box('mdia', createMdhd(params), createHdlr(params), createMinf(params));
}

function createMdhd(params: CMAFTrackParams): Uint8Array {
  return fullBox(
    'mdhd',
    0,
    0,
    u32(0), // creation_time
    u32(0), // modification_time
    u32(params.timescale),
    u32(0), // duration: unknown (live)
    u16(LANGUAGE_UNDETERMINED),
    u16(0), // pre_defined
  );
}

function createHdlr(params: CMAFTrackParams): Uint8Array {
  const isVideo = params.mediaType === 'video';
  const name = isVideo ? 'VideoHandler' : 'SoundHandler';
  return fullBox(
    'hdlr',
    0,
    0,
    u32(0), // pre_defined
    fourCC(isVideo ? 'vide' : 'soun'),
    zeros(3 * 4), // reserved
    new TextEncoder().encode(name),
    u8(0), // null terminated
  );
}

function createMinf(params: CMAFTrackParams): Uint8Array {
  const mediaHeader =
    params.mediaType === 'video'
      ? fullBox('vmhd', 0, 1, u16(0), zeros(3 * 2)) // graphicsmode + opcolor
      : fullBox('smhd', 0, 0, i16(0), u16(0)); // balance + reserved
  return box('minf', mediaHeader, createDinf(), createStbl(params));
}

function createDinf(): Uint8Array {
  // A single self-contained data entry: the media lives in this same file.
  const url = fullBox('url ', 0, 1);
  return box('dinf', fullBox('dref', 0, 0, u32(1), url));
}

function createStbl(params: CMAFTrackParams): Uint8Array {
  return box(
    'stbl',
    fullBox('stsd', 0, 0, u32(1), createSampleEntry(params)),
    // Empty sample tables: the samples live in the media fragments.
    fullBox('stts', 0, 0, u32(0)),
    fullBox('stsc', 0, 0, u32(0)),
    fullBox('stsz', 0, 0, u32(0), u32(0)),
    fullBox('stco', 0, 0, u32(0)),
  );
}

function createSampleEntry(params: CMAFTrackParams): Uint8Array {
  if (params.mediaType === 'video') {
    return createAvc1(params);
  }
  return params.codec.startsWith('opus') ? createOpusEntry(params) : createMp4aEntry(params);
}

/** AVC visual sample entry (ISO/IEC 14496-15 §5.3.4). */
function createAvc1(params: CMAFTrackParams): Uint8Array {
  // 32-byte fixed-length "compressorname": one length byte + padding.
  const compressorName = zeros(32);
  return box(
    'avc1',
    zeros(6), // reserved
    u16(1), // data_reference_index
    u16(0), // pre_defined
    u16(0), // reserved
    zeros(3 * 4), // pre_defined
    u16(params.codedWidth ?? 0),
    u16(params.codedHeight ?? 0),
    u32(0x00480000), // horizresolution 72 dpi
    u32(0x00480000), // vertresolution 72 dpi
    u32(0), // reserved
    u16(1), // frame_count
    compressorName,
    u16(0x0018), // depth
    i16(-1), // pre_defined
    // The WebCodecs `description` IS the AVCDecoderConfigurationRecord, so it
    // goes in verbatim. It also means the encoder must stay on the default AVC
    // format ('avc'): samples are length-prefixed AVCC, not Annex-B, and go
    // into `mdat` untouched.
    box('avcC', params.config),
  );
}

function audioInfo(params: CMAFTrackParams): { sampleRate: number; numberOfChannels: number } {
  if (params.sampleRate !== undefined && params.numberOfChannels !== undefined) {
    return { sampleRate: params.sampleRate, numberOfChannels: params.numberOfChannels };
  }
  const parsed = GetAudioDecoderConfig(params.codec, params.config);
  return {
    sampleRate: params.sampleRate ?? parsed.sampleRate,
    numberOfChannels: params.numberOfChannels ?? parsed.numberOfChannels,
  };
}

/** The common AudioSampleEntry header shared by 'Opus' and 'mp4a'. */
function audioSampleEntryHeader(params: CMAFTrackParams): Uint8Array[] {
  const { sampleRate, numberOfChannels } = audioInfo(params);
  return [
    zeros(6), // reserved
    u16(1), // data_reference_index
    zeros(2 * 4), // reserved
    u16(numberOfChannels),
    u16(16), // samplesize
    u16(0), // pre_defined
    u16(0), // reserved
    // samplerate is 16.16 fixed point, so only the integer part is kept.
    fixed16x16(sampleRate),
  ];
}

/** Opus audio sample entry + `dOps` (Opus in ISOBMFF, ISO/IEC 23003-5). */
function createOpusEntry(params: CMAFTrackParams): Uint8Array {
  return box('Opus', ...audioSampleEntryHeader(params), createDOps(params.config));
}

/**
 * `dOps` carries the same fields as the OpusHead identification header
 * (RFC 7845 §5.1) minus the magic signature, and big endian instead of little
 * endian.
 */
export function createDOps(opusHead: Uint8Array): Uint8Array {
  if (opusHead.byteLength < 19) {
    throw new Error(`OpusHead too short to build a dOps box: ${opusHead.byteLength} bytes`);
  }
  const view = new DataView(opusHead.buffer, opusHead.byteOffset, opusHead.byteLength);
  const channelCount = opusHead[9];
  const preSkip = view.getUint16(10, true);
  const inputSampleRate = view.getUint32(12, true);
  const outputGain = view.getInt16(16, true);
  const mappingFamily = opusHead[18];

  const parts: Uint8Array[] = [
    u8(0), // Version (dOps is not a FullBox)
    u8(channelCount),
    u16(preSkip),
    u32(inputSampleRate),
    i16(outputGain),
    u8(mappingFamily),
  ];
  if (mappingFamily !== 0) {
    // StreamCount, CoupledCount and the per-channel mapping table follow, in
    // the same order and encoding as in the OpusHead.
    parts.push(opusHead.subarray(19, 19 + 2 + channelCount));
  }
  return box('dOps', ...parts);
}

/** AAC audio sample entry + `esds` (ISO/IEC 14496-14 §5.6). */
function createMp4aEntry(params: CMAFTrackParams): Uint8Array {
  return box('mp4a', ...audioSampleEntryHeader(params), createEsds(params.config));
}

/** MPEG-4 descriptor: `tag | length (7 bits per byte) | payload`. */
function esDescriptor(tag: number, ...parts: Uint8Array[]): Uint8Array {
  const payload = concatBuffer(parts);
  let length = payload.byteLength;
  const lengthBytes: number[] = [length & 0x7f];
  length >>>= 7;
  while (length > 0) {
    lengthBytes.unshift((length & 0x7f) | 0x80);
    length >>>= 7;
  }
  return concatBuffer([u8(tag), new Uint8Array(lengthBytes), payload]);
}

export function createEsds(audioSpecificConfig: Uint8Array): Uint8Array {
  const decoderSpecificInfo = esDescriptor(0x05, audioSpecificConfig);
  const decoderConfig = esDescriptor(
    0x04,
    u8(ESDS_OTI_MPEG4_AUDIO),
    u8(ESDS_STREAM_TYPE_AUDIO),
    u24(0), // bufferSizeDB
    u32(0), // maxBitrate: unknown (live)
    u32(0), // avgBitrate: unknown (live)
    decoderSpecificInfo,
  );
  // SLConfigDescriptor, "predefined = MP4" (no sync layer).
  const slConfig = esDescriptor(0x06, u8(0x02));
  const esDescr = esDescriptor(
    0x03,
    u16(0), // ES_ID
    u8(0), // no dependency / URL / OCR, stream priority 0
    decoderConfig,
    slConfig,
  );
  return fullBox('esds', 0, 0, esDescr);
}

function createMvex(params: CMAFTrackParams): Uint8Array {
  // No `mehd`: the duration of a live stream is unknown. Sample defaults are
  // all 0 because every `trun` states duration, size and flags explicitly.
  const trex = fullBox(
    'trex',
    0,
    0,
    u32(params.trackId),
    u32(1), // default_sample_description_index
    u32(0), // default_sample_duration
    u32(0), // default_sample_size
    u32(0), // default_sample_flags
  );
  return box('mvex', trex);
}
