/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

// Follows "draft-ietf-moq-loc-04": https://datatracker.ietf.org/doc/draft-ietf-moq-loc/
//
// No LOC Private Properties are sent, but the (empty) Private Properties block
// still prefixes every audio / video payload, as the draft requires.
//
// This is draft 04 PLUS the Codecstring property (LOC_PROP_CODECSTRING, 0x11),
// which draft 04 does not register. That addition is required here, not
// optional: LOC puts no media type on the wire and this project has no catalog,
// so Codecstring is the only thing telling the player which codec to configure
// its decoders with. A plain draft-04 peer will NOT interoperate.

import { buffRead, readUntilEof } from '../moq/buffer_utils.js';
import { moqCreateKvPair, type KvPair } from '../moq/moqt.js';
import { varIntToNumbeFromBuffer } from '../moq/varint.js';
import type { MediaPackager, MediaDepackager } from './media_packager.js';

export const LOC_PACKAGER_VERSION = '04+codecstringPR';

// LOC Properties (LOC §2.3, §6.1). They ride the MoQ Object Properties, whose
// KVP encoding already matches the LOC rule: an even ID carries a varint value,
// an odd ID carries length-prefixed bytes (see encodeKvpValue in moqt.ts).
export const LOC_PROP_TIMESCALE = 0x08;
export const LOC_PROP_VIDEO_FRAME_MARKING = 0x09;
export const LOC_PROP_VIDEO_CONFIG = 0x0d;
export const LOC_PROP_AUDIO_CONFIG = 0x0f;
export const LOC_PROP_TIMESTAMP = 0x10;
export const LOC_PROP_CODECSTRING = 0x11;

// Video Frame Marking, 1-byte short form (RFC 9626 §3): S|E|I|D|B|TID(3), most
// significant bit first. One object is one whole frame here, so Start and End
// are always set and Independent is what tells a key frame from a delta frame.
const FRAME_MARKING_START = 0x80;
const FRAME_MARKING_END = 0x40;
const FRAME_MARKING_INDEPENDENT = 0x20;

// LOC Private Properties (LOC §2.2, §3.1.3): the MoQ Object Payload is the
// Private Properties block followed by the LOC Payload. The block is always
// present, even when empty, so a receiver can find where the media starts. Its
// type is the Secure Objects Private properties type (0x0A) and its value is
// length-prefixed. We send no private properties, so it is always 0x0A 0x00.
export const LOC_PRIVATE_PROPERTIES_TYPE = 0x0a;
const LOC_EMPTY_PRIVATE_PROPERTIES = new Uint8Array([LOC_PRIVATE_PROPERTIES_TYPE, 0x00]);

export type LOCMediaType = 'audio' | 'video' | 'data';

export type LOCConfig = Uint8Array | ArrayBuffer;

export interface LOCData {
  mediaType: LOCMediaType;
  timestamp: number | undefined;
  timescale: number | undefined;
  codec: string | undefined;
  config: LOCConfig | undefined;
  data: any;
}

/**
 * One LOC object: the LOC Payload (the "internal data" of an EncodedAudioChunk
 * or EncodedVideoChunk, carried as the MoQ Object Payload) plus the LOC
 * Properties describing it (carried as MoQ Object Properties).
 *
 * The media type is NOT on the wire. LOC leaves that to the catalog; here the
 * publisher and the subscriber both know it from their own per-track config, so
 * it is passed to the constructor.
 */
export class LOCPackager implements MediaPackager, MediaDepackager {
  mediaType: LOCMediaType;

  timestamp: number | undefined;
  timescale: number | undefined;
  codec: string | undefined;
  // Video Config or Audio Config: the WebCodecs decoder "description" bytes.
  config: LOCConfig | undefined;
  data: any;

  isDelta: boolean | undefined;
  eof: boolean;

  READ_BLOCK_SIZE: number;

  constructor(mediaType: LOCMediaType) {
    this.mediaType = mediaType;

    this.timestamp = undefined;
    this.timescale = undefined;
    this.codec = undefined;
    this.config = undefined;
    this.data = null;

    this.isDelta = undefined;
    this.eof = false;

    this.READ_BLOCK_SIZE = 1024;
  }

  SetData(
    timestamp: number | undefined,
    timescale: number | undefined,
    codec: string | undefined,
    config: LOCConfig | undefined,
    data: any,
    isDelta: boolean | undefined,
  ) {
    this.timestamp = timestamp;
    this.timescale = timescale;
    this.codec = codec;
    this.config = config;
    this.data = data;
    this.isDelta = isDelta;
  }

  async ParseData(readerStream: any, properties: KvPair[], payloadLength?: number) {
    // Every LOC object describes itself, so nothing carries over from the
    // previous one: a reused instance must not inherit its config or timing.
    this.timestamp = undefined;
    this.timescale = undefined;
    this.codec = undefined;
    this.config = undefined;
    this.isDelta = undefined;
    this.parseProperties(properties);

    // Read payload with length
    let payload: any;
    if (typeof payloadLength !== 'undefined') {
      const ret = await buffRead(readerStream, payloadLength);
      payload = ret.buff;
      this.eof = ret.eof;
    } else {
      payload = await readUntilEof(readerStream, this.READ_BLOCK_SIZE);
      this.eof = true;
    }
    this.data = this.mediaType === 'data' ? payload : skipPrivateProperties(payload);
  }

  // Properties this implementation does not know are ignored: LOC allows other
  // specifications to register their own.
  parseProperties(properties: KvPair[]) {
    for (const prop of properties) {
      if (prop.name === LOC_PROP_TIMESTAMP) {
        this.timestamp = prop.val as number;
      } else if (prop.name === LOC_PROP_TIMESCALE) {
        this.timescale = prop.val as number;
      } else if (prop.name === LOC_PROP_CODECSTRING) {
        this.codec = new TextDecoder().decode(prop.val as Uint8Array);
      } else if (prop.name === LOC_PROP_VIDEO_CONFIG || prop.name === LOC_PROP_AUDIO_CONFIG) {
        this.config = prop.val as Uint8Array;
      } else if (prop.name === LOC_PROP_VIDEO_FRAME_MARKING) {
        const marking = prop.val as Uint8Array;
        this.isDelta = (marking[0] & FRAME_MARKING_INDEPENDENT) === 0;
      }
    }
  }

  GetData(): LOCData {
    return {
      mediaType: this.mediaType,
      timestamp: this.timestamp,
      timescale: this.timescale,
      codec: this.codec,
      config: this.config,
      data: this.data,
    };
  }

  GetDataStr() {
    const configSize = this.config == null ? 0 : this.config.byteLength;
    const dataSize = this.data == null ? 0 : this.data.byteLength;
    return `mediaType: ${this.mediaType} - timestamp: ${this.timestamp} - timescale: ${this.timescale} - codec: ${this.codec} - configSize: ${configSize} - dataSize: ${dataSize}`;
  }

  PayloadToBytes() {
    // A data track is not LOC: its payload goes out untouched.
    if (this.mediaType === 'data') {
      return this.data;
    }
    const payload = new Uint8Array(LOC_EMPTY_PRIVATE_PROPERTIES.byteLength + this.data.byteLength);
    payload.set(LOC_EMPTY_PRIVATE_PROPERTIES, 0);
    const media = this.data instanceof Uint8Array ? this.data : new Uint8Array(this.data);
    payload.set(media, LOC_EMPTY_PRIVATE_PROPERTIES.byteLength);
    return payload;
  }

  Properties(): KvPair[] {
    const props: KvPair[] = [];

    // LOC covers audio and video only. A data track is an opaque payload with no
    // properties.
    if (this.mediaType === 'data') {
      return props;
    }

    if (this.timestamp === undefined || this.timescale === undefined) {
      throw new Error(`${this.mediaType} objects need a timestamp and a timescale`);
    }
    // Timescale is mandatory here: without it LOC reads the timestamp as
    // microseconds since the Unix epoch, and ours are capture-relative.
    props.push(moqCreateKvPair(LOC_PROP_TIMESTAMP, this.timestamp));
    props.push(moqCreateKvPair(LOC_PROP_TIMESCALE, this.timescale));
    if (this.codec !== undefined) {
      props.push(moqCreateKvPair(LOC_PROP_CODECSTRING, this.codec));
    }

    if (this.mediaType === 'video') {
      let marking = FRAME_MARKING_START | FRAME_MARKING_END;
      if (this.isDelta !== true) {
        marking |= FRAME_MARKING_INDEPENDENT;
      }
      props.push(moqCreateKvPair(LOC_PROP_VIDEO_FRAME_MARKING, new Uint8Array([marking])));
      // The encoder only attaches the config to key frames.
      if (this.config != null && this.config.byteLength > 0) {
        props.push(moqCreateKvPair(LOC_PROP_VIDEO_CONFIG, this.config));
      }
    } else if (this.config != null && this.config.byteLength > 0) {
      // Audio config rides EVERY audio object. There is no catalog and no
      // track-scope property plumbing, so this is the only way a subscriber can
      // configure its decoder as soon as it joins. It is not free: at 10ms Opus
      // frames the LOC properties add ~37 bytes to a ~40 byte payload, roughly
      // doubling audio bitrate. Sending the config periodically instead, or
      // batching several audio chunks per group, would cut that down at the cost
      // of join latency or a bigger change to the group structure.
      props.push(moqCreateKvPair(LOC_PROP_AUDIO_CONFIG, this.config));
    }

    return props;
  }

  IsEof() {
    return this.eof;
  }

  IsDelta() {
    return this.isDelta;
  }
}

// Returns the LOC Payload that follows the Private Properties block at the start
// of `payload`. Private properties are not used here, so their contents are
// skipped rather than parsed.
function skipPrivateProperties(payload: ArrayBuffer | Uint8Array): Uint8Array {
  const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  // varIntToNumbeFromBuffer reads from the start of an ArrayBuffer, so hand it
  // one that begins where the payload does.
  const buff =
    bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? (bytes.buffer as ArrayBuffer)
      : bytes.slice().buffer;
  if (buff.byteLength === 0) {
    throw new Error('LOC payload is missing its private properties block');
  }
  const type = varIntToNumbeFromBuffer(buff, 0);
  if (type.num !== LOC_PRIVATE_PROPERTIES_TYPE) {
    throw new Error(
      `LOC payload must start with private properties (type 0x${LOC_PRIVATE_PROPERTIES_TYPE.toString(16)}), got type 0x${type.num?.toString(16)}`,
    );
  }
  const length = varIntToNumbeFromBuffer(buff, type.byteLength);
  const start = type.byteLength + length.byteLength + (length.num ?? 0);
  if (start > buff.byteLength) {
    throw new Error(
      `LOC private properties length (${length.num}) exceeds the payload (${buff.byteLength} bytes)`,
    );
  }
  return new Uint8Array(buff, start);
}

export function LOCgetTrackName(trackPrefix: string, isAudio: boolean, suffix?: string) {
  return `${trackPrefix}${suffix ?? (isAudio ? 'audio0' : 'video0')}`;
}
