/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import {
  BitReaderHelper,
  GetUint16FromBufferBe,
  ParseNAL,
  ContainsNALUSliceIDR,
} from '../src/utils/media/avcc_parser.js';
import {
  GetVideoCodecStringFromProfileLevel,
  GetVideoCodecStringFromAVCDecoderConfigurationRecord,
  type AVCDecoderConfigurationRecord,
} from '../src/utils/media/avc_decoder_configuration_record_parser.js';

describe('BitReaderHelper', () => {
  const buf = new Uint8Array([0b10110010]);

  it('reads the full byte', () => {
    expect(BitReaderHelper(buf, 0, 8)).toBe(0b10110010);
  });

  it('reads a high nibble and a low nibble', () => {
    expect(BitReaderHelper(buf, 0, 4)).toBe(0b1011);
    expect(BitReaderHelper(buf, 4, 4)).toBe(0b0010);
  });

  it('reads across a byte boundary', () => {
    const twoBytes = new Uint8Array([0b00000001, 0b10000000]);
    expect(BitReaderHelper(twoBytes, 7, 2)).toBe(0b11);
  });
});

describe('GetUint16FromBufferBe', () => {
  it('reads a big-endian uint16', () => {
    expect(GetUint16FromBufferBe(new Uint8Array([0x12, 0x34]))).toBe(0x1234);
  });
});

describe('ParseNAL', () => {
  it('extracts the NAL unit type from the header byte', () => {
    // 0x65 -> forbidden_zero_bit 0, nal_ref_idc 11, nal_unit_type 00101 (5 = IDR slice)
    expect(ParseNAL(new Uint8Array([0x65])).nalType).toBe(5);
    // 0x61 -> nal_unit_type 00001 (1 = non-IDR slice)
    expect(ParseNAL(new Uint8Array([0x61])).nalType).toBe(1);
  });
});

describe('ContainsNALUSliceIDR', () => {
  it('detects an IDR slice in an AVCC buffer (4-byte length prefix)', () => {
    // length = 1, NAL header 0x65 (IDR)
    const idr = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x65]);
    expect(ContainsNALUSliceIDR(idr, 4)).toBe(true);
  });

  it('returns false when there is no IDR slice', () => {
    // length = 1, NAL header 0x61 (non-IDR)
    const nonIdr = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x61]);
    expect(ContainsNALUSliceIDR(nonIdr, 4)).toBe(false);
  });

  it('returns false for undefined / null input', () => {
    expect(ContainsNALUSliceIDR(undefined, 4)).toBe(false);
    expect(ContainsNALUSliceIDR(null, 4)).toBe(false);
  });
});

describe('GetVideoCodecStringFromProfileLevel', () => {
  it('builds an avc1 codec string from profile and level', () => {
    expect(GetVideoCodecStringFromProfileLevel('avc1', 66, 30)).toBe('avc1.42001E');
    expect(GetVideoCodecStringFromProfileLevel('avc1', 100, 31)).toBe('avc1.64001F');
  });

  it('includes the constraint flags when they are given', () => {
    expect(GetVideoCodecStringFromProfileLevel('avc1', 66, 30, 0xe0)).toBe('avc1.42E01E');
  });
});

describe('GetVideoCodecStringFromAVCDecoderConfigurationRecord', () => {
  it('builds the codec string from profile, constraint flags and level', () => {
    const record = {
      avcProfileIndication: 66,
      profileCompatibility: 0xe0,
      AVCLevelIndication: 30,
    } as AVCDecoderConfigurationRecord;
    expect(GetVideoCodecStringFromAVCDecoderConfigurationRecord(record)).toBe('avc1.42E01E');
  });
});
