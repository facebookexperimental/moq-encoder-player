/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

/*
 * Recovers the sample rate and channel count an `AudioDecoder` needs to be
 * configured with from the LOC Audio Config property, which carries only the
 * WebCodecs `AudioDecoderConfig.description` bytes (OpusHead for Opus, an
 * AudioSpecificConfig for AAC).
 */

import { BitReaderHelper } from './avcc_parser.js';

const OPUS_HEAD_MAGIC = 'OpusHead';
const OPUS_HEAD_MIN_LENGTH = 19;

// MPEG-4 Audio sampling frequency index table (ISO/IEC 14496-3 Table 1.18).
// Index 13 and 14 are reserved; index 15 means the rate follows explicitly.
const ASC_SAMPLING_FREQUENCIES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];
const ASC_FREQUENCY_INDEX_EXPLICIT = 15;
const ASC_OBJECT_TYPE_ESCAPE = 31;

export interface AudioSourceInfo {
  sampleRate: number;
  numberOfChannels: number;
}

function toUint8Array(description: Uint8Array | ArrayBuffer): Uint8Array {
  return description instanceof Uint8Array ? description : new Uint8Array(description);
}

/**
 * Parse an OpusHead identification header (RFC 7845 §5.1). All multi-byte
 * fields are little endian.
 */
export function ParseOpusHead(description: Uint8Array | ArrayBuffer): AudioSourceInfo {
  const buf = toUint8Array(description);
  if (buf.byteLength < OPUS_HEAD_MIN_LENGTH) {
    throw new Error(`OpusHead too short: ${buf.byteLength} bytes`);
  }
  const magic = new TextDecoder().decode(buf.subarray(0, 8));
  if (magic !== OPUS_HEAD_MAGIC) {
    throw new Error(`Not an OpusHead, magic is "${magic}"`);
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return {
    numberOfChannels: buf[9],
    // "Input Sample Rate" is informational in RFC 7845 (Opus always decodes at
    // 48kHz), but it is where the encoder records the rate it was configured
    // with, which is the rate the rest of the pipeline is timed against.
    sampleRate: view.getUint32(12, true),
  };
}

/**
 * Parse an MPEG-4 AudioSpecificConfig (ISO/IEC 14496-3 §1.6.2.1). The fields are
 * bit packed and not byte aligned.
 */
export function ParseAudioSpecificConfig(description: Uint8Array | ArrayBuffer): AudioSourceInfo {
  const buf = toUint8Array(description);
  if (buf.byteLength < 2) {
    throw new Error(`AudioSpecificConfig too short: ${buf.byteLength} bytes`);
  }

  let bitPos = 0;
  if (BitReaderHelper(buf, bitPos, 5) === ASC_OBJECT_TYPE_ESCAPE) {
    bitPos += 5 + 6;
  } else {
    bitPos += 5;
  }

  const frequencyIndex = BitReaderHelper(buf, bitPos, 4);
  bitPos += 4;
  let sampleRate;
  if (frequencyIndex === ASC_FREQUENCY_INDEX_EXPLICIT) {
    sampleRate = BitReaderHelper(buf, bitPos, 24);
    bitPos += 24;
  } else {
    sampleRate = ASC_SAMPLING_FREQUENCIES[frequencyIndex];
    if (sampleRate === undefined) {
      throw new Error(`Reserved AudioSpecificConfig frequency index ${frequencyIndex}`);
    }
  }

  const channelConfiguration = BitReaderHelper(buf, bitPos, 4);
  if (channelConfiguration === 0) {
    // The channel count lives in a program config element we do not parse.
    throw new Error('AudioSpecificConfig carries a program config element');
  }

  return { sampleRate, numberOfChannels: channelConfiguration };
}

/**
 * Build an `AudioDecoderConfig` from a LOC codec string and Audio Config bytes.
 */
export function GetAudioDecoderConfig(
  codec: string,
  description: Uint8Array | ArrayBuffer,
): AudioSourceInfo & { codec: string; description: Uint8Array | ArrayBuffer } {
  const info = codec.startsWith('opus')
    ? ParseOpusHead(description)
    : ParseAudioSpecificConfig(description);
  return { codec, description, ...info };
}
