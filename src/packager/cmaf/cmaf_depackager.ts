/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

// The subscriber side of CMSF (see ./cmaf_packager.ts for the publisher side and
// the mapping): it turns one MOQT object payload — `[ftyp moov] styp moof mdat` —
// back into the encoded frame plus the timing and codec information the player
// pipeline needs.
//
// Unlike LOC, CMSF carries nothing in the MoQ Object Properties: everything is
// read out of the boxes. Two consequences for this class:
//
//  * It is STATEFUL, one instance per track. The CMAF Header (`ftyp` + `moov`)
//    only rides the objects that start a group, and at most once every
//    `initRepeatEveryMs`, so the timescale / codec / decoder configuration it
//    carries is remembered and reapplied to every following object.
//  * A player that joins mid-group receives objects before its first header.
//    Those cannot be decoded: `GetData()` reports an undefined timescale and the
//    caller is expected to skip them until a header arrives.

import type { MediaDepackager, ParsedMediaData } from '../media_packager.js';
import type { KvPair } from '../../moq/moqt.js';
import { buffRead, readUntilEof, concatBuffer } from '../../moq/buffer_utils.js';
import {
  ParseAVCDecoderConfigurationRecord,
  GetVideoCodecStringFromAVCDecoderConfigurationRecord,
} from '../../utils/media/avc_decoder_configuration_record_parser.js';
import { findBox, childBoxes, parseBoxes, type Box } from './box_reader.js';
import type { CMAFMediaType } from './cmaf_init_segment.js';

const LOG_PREFIX = '[CMAF-DEPACKAGER]';

const READ_BLOCK_SIZE = 1024;

// `trun` flags (ISO/IEC 14496-12 §8.8.8.1).
const TRUN_FLAG_DATA_OFFSET = 0x000001;
const TRUN_FLAG_FIRST_SAMPLE_FLAGS = 0x000004;
const TRUN_FLAG_SAMPLE_DURATION = 0x000100;
const TRUN_FLAG_SAMPLE_SIZE = 0x000200;
const TRUN_FLAG_SAMPLE_FLAGS = 0x000400;

// `trun` sample_flags: sample_depends_on == 1 means "depends on others" (a delta
// frame), and bit 16 is sample_is_non_sync_sample.
const SAMPLE_DEPENDS_ON_OTHERS = 1;
const SAMPLE_IS_NON_SYNC = 0x00010000;

// MPEG-4 descriptor tags used inside `esds` (ISO/IEC 14496-1 §7.2.6).
const ES_TAG_ES_DESCRIPTOR = 0x03;
const ES_TAG_DECODER_CONFIG = 0x04;
const ES_TAG_DECODER_SPECIFIC_INFO = 0x05;

export class CMAFDepackager implements MediaDepackager {
  readonly mediaType: CMAFMediaType;

  // Carried by the CMAF Header, so they survive across objects.
  private timescale: number | undefined;
  private codec: string | undefined;
  private config: Uint8Array | undefined;

  // Set per object.
  private timestamp: number | undefined;
  private data: Uint8Array | undefined;
  private isDelta: boolean | undefined;
  private eof = false;

  constructor(mediaType: CMAFMediaType) {
    this.mediaType = mediaType;
  }

  async ParseData(readerStream: any, _properties: KvPair[], payloadLength?: number): Promise<void> {
    // buffRead hands back the raw ArrayBuffer it read into, readUntilEof a
    // Uint8Array, so normalize before walking the boxes.
    let payload: Uint8Array | ArrayBuffer;
    if (payloadLength !== undefined) {
      const ret = await buffRead(readerStream, payloadLength);
      payload = ret!.buff;
      this.eof = ret!.eof;
    } else {
      payload = await readUntilEof(readerStream, READ_BLOCK_SIZE);
      this.eof = true;
    }
    this.ParseObject(payload);
  }

  /** Parse one complete object payload. Exposed for tests and offline tooling. */
  ParseObject(payload: Uint8Array | ArrayBuffer): void {
    this.timestamp = undefined;
    this.data = undefined;
    this.isDelta = undefined;

    const samples: Uint8Array[] = [];
    let moofCount = 0;
    for (const box of parseBoxes(toUint8Array(payload))) {
      if (box.type === 'moov') {
        this.readCmafHeader(box);
      } else if (box.type === 'moof') {
        moofCount++;
        if (moofCount === 1) {
          this.readMoof(box);
        }
      } else if (box.type === 'mdat') {
        samples.push(box.payload);
      }
    }
    if (moofCount > 1) {
      // One CMAF chunk (one sample) per object is what this project publishes,
      // and what the player pipeline expects downstream.
      console.warn(
        `${LOG_PREFIX} ${this.mediaType} object carries ${moofCount} movie fragments, only the timing of the first one is used`,
      );
    }
    if (samples.length > 0) {
      this.data = samples.length === 1 ? samples[0] : concatBuffer(samples);
    }
  }

  GetData(): ParsedMediaData {
    return {
      mediaType: this.mediaType,
      timestamp: this.timestamp,
      timescale: this.timescale,
      codec: this.codec,
      // The WebCodecs decoder `description`, rebuilt from the sample entry.
      config: this.config,
      data: this.data,
    };
  }

  GetDataStr(): string {
    const configSize = this.config === undefined ? 0 : this.config.byteLength;
    const dataSize = this.data === undefined ? 0 : this.data.byteLength;
    return `mediaType: ${this.mediaType} - timestamp: ${this.timestamp} - timescale: ${this.timescale} - codec: ${this.codec} - configSize: ${configSize} - dataSize: ${dataSize}`;
  }

  IsDelta(): boolean | undefined {
    return this.isDelta;
  }

  IsEof(): boolean {
    return this.eof;
  }

  // ---------------------------------------------------------------------------
  // CMAF Header (`moov`): timescale, codec and decoder configuration
  // ---------------------------------------------------------------------------

  private readCmafHeader(moov: Box): void {
    const mdhd = findBox(moov.payload, 'trak/mdia/mdhd');
    if (mdhd !== undefined) {
      this.timescale = readMdhdTimescale(mdhd);
    }
    const stsd = findBox(moov.payload, 'trak/mdia/minf/stbl/stsd');
    if (stsd === undefined) {
      return;
    }
    // Exactly one CMAF Track per MOQT track, so one sample entry.
    const sampleEntry = childBoxes(stsd)[0];
    if (sampleEntry === undefined) {
      return;
    }
    try {
      this.readSampleEntry(sampleEntry);
    } catch (err: any) {
      console.error(
        `${LOG_PREFIX} Could not read the ${this.mediaType} "${sampleEntry.type}" sample entry: ${err?.message}`,
      );
    }
  }

  private readSampleEntry(sampleEntry: Box): void {
    const children = childBoxes(sampleEntry);
    const child = (type: string) => children.find((b) => b.type === type);

    if (sampleEntry.type === 'avc1' || sampleEntry.type === 'avc3') {
      const avcC = child('avcC');
      if (avcC === undefined) {
        throw new Error('no avcC box');
      }
      // The WebCodecs `description` IS the AVCDecoderConfigurationRecord, which
      // is what `avcC` holds, so it goes back out verbatim.
      this.config = avcC.payload;
      this.codec = GetVideoCodecStringFromAVCDecoderConfigurationRecord(
        ParseAVCDecoderConfigurationRecord(avcC.payload),
      );
      return;
    }
    if (sampleEntry.type === 'Opus') {
      const dOps = child('dOps');
      if (dOps === undefined) {
        throw new Error('no dOps box');
      }
      this.config = opusHeadFromDOps(dOps.payload);
      this.codec = 'opus';
      return;
    }
    if (sampleEntry.type === 'mp4a') {
      const esds = child('esds');
      if (esds === undefined) {
        throw new Error('no esds box');
      }
      const audioSpecificConfig = audioSpecificConfigFromEsds(esds.payload);
      this.config = audioSpecificConfig;
      // Object type from the AudioSpecificConfig (5 bit audioObjectType), e.g.
      // 2 for AAC-LC -> 'mp4a.40.2'.
      this.codec = `mp4a.40.${audioSpecificConfig[0] >> 3}`;
      return;
    }
    throw new Error(`unsupported sample entry "${sampleEntry.type}"`);
  }

  // ---------------------------------------------------------------------------
  // Media fragment (`moof`): decode time and key / delta
  // ---------------------------------------------------------------------------

  private readMoof(moof: Box): void {
    const tfdt = findBox(moof.payload, 'traf/tfdt');
    if (tfdt !== undefined) {
      this.timestamp = readTfdtDecodeTime(tfdt);
    }
    const trun = findBox(moof.payload, 'traf/trun');
    if (trun !== undefined) {
      this.isDelta = readTrunIsDelta(trun);
    }
  }
}

function toUint8Array(payload: Uint8Array | ArrayBuffer): Uint8Array {
  return payload instanceof Uint8Array ? payload : new Uint8Array(payload);
}

/** `mdhd` timescale (ISO/IEC 14496-12 §8.4.2), version 0 or 1. */
function readMdhdTimescale(mdhd: Box): number | undefined {
  const view = new DataView(mdhd.payload.buffer, mdhd.payload.byteOffset, mdhd.payload.byteLength);
  const version = mdhd.payload[0];
  // FullBox header (4) + creation_time + modification_time.
  const offset = version === 1 ? 4 + 8 + 8 : 4 + 4 + 4;
  if (mdhd.payload.byteLength < offset + 4) {
    return undefined;
  }
  return view.getUint32(offset);
}

/** `tfdt` baseMediaDecodeTime (ISO/IEC 14496-12 §8.8.12), version 0 or 1. */
function readTfdtDecodeTime(tfdt: Box): number | undefined {
  const view = new DataView(tfdt.payload.buffer, tfdt.payload.byteOffset, tfdt.payload.byteLength);
  const version = tfdt.payload[0];
  if (version === 1) {
    return tfdt.payload.byteLength < 12 ? undefined : Number(view.getBigUint64(4));
  }
  return tfdt.payload.byteLength < 8 ? undefined : view.getUint32(4);
}

/**
 * Whether the (single) sample of a `trun` depends on other frames. The flags
 * are optional, so undefined means "the publisher did not say".
 */
function readTrunIsDelta(trun: Box): boolean | undefined {
  const view = new DataView(trun.payload.buffer, trun.payload.byteOffset, trun.payload.byteLength);
  if (trun.payload.byteLength < 8) {
    return undefined;
  }
  const flags = (trun.payload[1] << 16) | (trun.payload[2] << 8) | trun.payload[3];
  const sampleCount = view.getUint32(4);
  if (sampleCount <= 0) {
    return undefined;
  }
  let pos = 8;
  if (flags & TRUN_FLAG_DATA_OFFSET) {
    pos += 4;
  }
  if (flags & TRUN_FLAG_FIRST_SAMPLE_FLAGS) {
    // When present it overrides the per-sample flags of the first sample, which
    // is the only one this project ever puts in an object.
    return trun.payload.byteLength < pos + 4 ? undefined : sampleFlagsAreDelta(view.getUint32(pos));
  }
  if (!(flags & TRUN_FLAG_SAMPLE_FLAGS)) {
    return undefined;
  }
  if (flags & TRUN_FLAG_SAMPLE_DURATION) {
    pos += 4;
  }
  if (flags & TRUN_FLAG_SAMPLE_SIZE) {
    pos += 4;
  }
  return trun.payload.byteLength < pos + 4 ? undefined : sampleFlagsAreDelta(view.getUint32(pos));
}

function sampleFlagsAreDelta(sampleFlags: number): boolean {
  const dependsOn = (sampleFlags >>> 24) & 0x3;
  return (sampleFlags & SAMPLE_IS_NON_SYNC) !== 0 || dependsOn === SAMPLE_DEPENDS_ON_OTHERS;
}

/**
 * Rebuild the OpusHead identification header (RFC 7845 §5.1) the WebCodecs
 * decoder wants from the `dOps` box that carries the same fields, big endian
 * and without the magic signature. The inverse of `createDOps`.
 */
export function opusHeadFromDOps(dOps: Uint8Array): Uint8Array {
  if (dOps.byteLength < 11) {
    throw new Error(`dOps too short: ${dOps.byteLength} bytes`);
  }
  const view = new DataView(dOps.buffer, dOps.byteOffset, dOps.byteLength);
  const channelCount = dOps[1];
  const mappingFamily = dOps[10];
  const mappingTable = mappingFamily === 0 ? new Uint8Array(0) : dOps.subarray(11);

  const head = new Uint8Array(19 + mappingTable.byteLength);
  head.set(new TextEncoder().encode('OpusHead'), 0);
  const out = new DataView(head.buffer);
  head[8] = 1; // Version
  head[9] = channelCount;
  out.setUint16(10, view.getUint16(2), true); // PreSkip
  out.setUint32(12, view.getUint32(4), true); // InputSampleRate
  out.setInt16(16, view.getInt16(8), true); // OutputGain
  head[18] = mappingFamily;
  head.set(mappingTable, 19);
  return head;
}

/**
 * Pull the AudioSpecificConfig (the WebCodecs `description` for AAC) out of an
 * `esds` box: ES_Descriptor > DecoderConfigDescriptor > DecoderSpecificInfo.
 * The inverse of `createEsds`.
 */
export function audioSpecificConfigFromEsds(esds: Uint8Array): Uint8Array {
  // FullBox header, then the descriptor tree.
  let pos = 4;
  for (const tag of [ES_TAG_ES_DESCRIPTOR, ES_TAG_DECODER_CONFIG, ES_TAG_DECODER_SPECIFIC_INFO]) {
    if (esds[pos] !== tag) {
      throw new Error(`esds: expected descriptor 0x${tag.toString(16)} at offset ${pos}`);
    }
    pos++;
    let length = 0;
    let lengthByte = 0x80;
    while ((lengthByte & 0x80) !== 0) {
      if (pos >= esds.byteLength) {
        throw new Error('esds: truncated descriptor length');
      }
      lengthByte = esds[pos++];
      length = (length << 7) | (lengthByte & 0x7f);
    }
    if (tag === ES_TAG_DECODER_SPECIFIC_INFO) {
      if (pos + length > esds.byteLength) {
        throw new Error('esds: truncated AudioSpecificConfig');
      }
      return esds.subarray(pos, pos + length);
    }
    if (tag === ES_TAG_ES_DESCRIPTOR) {
      // ES_ID (2) + flags/priority (1), then the DecoderConfigDescriptor.
      pos += 3;
    } else {
      // objectTypeIndication (1) + streamType (1) + bufferSizeDB (3) +
      // maxBitrate (4) + avgBitrate (4), then the DecoderSpecificInfo.
      pos += 13;
    }
  }
  throw new Error('esds: no DecoderSpecificInfo');
}
