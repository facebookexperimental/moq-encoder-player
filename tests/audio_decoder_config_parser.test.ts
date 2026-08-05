/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import {
  ParseOpusHead,
  ParseAudioSpecificConfig,
  GetAudioDecoderConfig,
} from '../src/utils/media/audio_decoder_config_parser.js';

function buildOpusHead(channels: number, inputSampleRate: number): Uint8Array {
  const buf = new Uint8Array(19);
  buf.set(new TextEncoder().encode('OpusHead'), 0);
  buf[8] = 1; // version
  buf[9] = channels;
  const view = new DataView(buf.buffer);
  view.setUint16(10, 312, true); // pre-skip
  view.setUint32(12, inputSampleRate, true);
  return buf;
}

describe('ParseOpusHead', () => {
  it('reads the channel count and the little-endian input sample rate', () => {
    expect(ParseOpusHead(buildOpusHead(2, 48000))).toEqual({
      numberOfChannels: 2,
      sampleRate: 48000,
    });
    expect(ParseOpusHead(buildOpusHead(1, 44100))).toEqual({
      numberOfChannels: 1,
      sampleRate: 44100,
    });
  });

  it('accepts an ArrayBuffer', () => {
    const head = buildOpusHead(1, 48000);
    expect(ParseOpusHead(head.buffer as ArrayBuffer)).toEqual({
      numberOfChannels: 1,
      sampleRate: 48000,
    });
  });

  it('throws when the magic does not match', () => {
    const head = buildOpusHead(1, 48000);
    head[0] = 0x00;
    expect(() => ParseOpusHead(head)).toThrow(/Not an OpusHead/);
  });

  it('throws when the header is truncated', () => {
    expect(() => ParseOpusHead(buildOpusHead(1, 48000).subarray(0, 12))).toThrow(/too short/);
  });
});

describe('ParseAudioSpecificConfig', () => {
  it('reads AAC-LC stereo at 44.1kHz', () => {
    // AOT 2 (00010), freq index 4 = 44100 (0100), channel config 2 (0010)
    expect(ParseAudioSpecificConfig(new Uint8Array([0x12, 0x10]))).toEqual({
      sampleRate: 44100,
      numberOfChannels: 2,
    });
  });

  it('reads AAC-LC mono at 48kHz', () => {
    // AOT 2 (00010), freq index 3 = 48000 (0011), channel config 1 (0001)
    expect(ParseAudioSpecificConfig(new Uint8Array([0x11, 0x88]))).toEqual({
      sampleRate: 48000,
      numberOfChannels: 1,
    });
  });

  it('reads an explicit sample rate when the frequency index is 15', () => {
    // AOT 2 (00010) | index 15 (1111) | 24-bit rate 44100 | channel config 1 (0001)
    const bits = '00010' + '1111' + (44100).toString(2).padStart(24, '0') + '0001';
    expect(ParseAudioSpecificConfig(bitsToBytes(bits))).toEqual({
      sampleRate: 44100,
      numberOfChannels: 1,
    });
  });

  it('skips the 6-bit escape when the object type is 31', () => {
    // AOT 31 (11111) | 6-bit ext 3 | index 3 = 48000 (0011) | channel config 2 (0010)
    const bits = '11111' + '000011' + '0011' + '0010';
    expect(ParseAudioSpecificConfig(bitsToBytes(bits))).toEqual({
      sampleRate: 48000,
      numberOfChannels: 2,
    });
  });

  it('throws on a reserved frequency index', () => {
    // AOT 2 (00010) | index 13 (1101) | channel config 1 (0001)
    expect(() => ParseAudioSpecificConfig(bitsToBytes('00010' + '1101' + '0001'))).toThrow(
      /Reserved/,
    );
  });

  it('throws when the channel count is in a program config element', () => {
    // AOT 2 (00010) | index 3 (0011) | channel config 0 (0000)
    expect(() => ParseAudioSpecificConfig(bitsToBytes('00010' + '0011' + '0000'))).toThrow(
      /program config element/,
    );
  });
});

describe('GetAudioDecoderConfig', () => {
  it('parses an OpusHead for an opus codec string', () => {
    const description = buildOpusHead(1, 48000);
    expect(GetAudioDecoderConfig('opus', description)).toEqual({
      codec: 'opus',
      description,
      sampleRate: 48000,
      numberOfChannels: 1,
    });
  });

  it('parses an AudioSpecificConfig for an AAC codec string', () => {
    const description = new Uint8Array([0x12, 0x10]);
    expect(GetAudioDecoderConfig('mp4a.40.2', description)).toEqual({
      codec: 'mp4a.40.2',
      description,
      sampleRate: 44100,
      numberOfChannels: 2,
    });
  });
});

// Pack a MSB-first bit string into bytes, zero padded to a byte boundary.
function bitsToBytes(bits: string): Uint8Array {
  const padded = bits.padEnd(Math.ceil(bits.length / 8) * 8, '0');
  const out = new Uint8Array(padded.length / 8);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(padded.slice(i * 8, i * 8 + 8), 2);
  }
  return out;
}
