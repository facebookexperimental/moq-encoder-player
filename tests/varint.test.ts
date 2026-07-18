/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import { numberToVarInt, varIntToNumbeFromBuffer } from '../src/moq/varint.js';

function roundTrip(value: number) {
  const encoded = numberToVarInt(value);
  return varIntToNumbeFromBuffer(encoded.buffer as ArrayBuffer, 0);
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

describe('varint (draft-18 vi64, leading-1-bits)', () => {
  it('encodes 7-bit values into a single byte', () => {
    const encoded = numberToVarInt(5);
    expect(encoded.byteLength).toBe(1);
    expect(roundTrip(5)).toEqual({ num: 5, byteLength: 1 });
  });

  it('encodes 14-bit values into 2 bytes', () => {
    const encoded = numberToVarInt(1000);
    expect(encoded.byteLength).toBe(2);
    expect(roundTrip(1000)).toEqual({ num: 1000, byteLength: 2 });
  });

  it('encodes 21-bit values into 3 bytes', () => {
    const encoded = numberToVarInt(100000);
    expect(encoded.byteLength).toBe(3);
    expect(roundTrip(100000)).toEqual({ num: 100000, byteLength: 3 });
  });

  it('encodes 2^40 into 6 bytes', () => {
    const value = 2 ** 40;
    const encoded = numberToVarInt(value);
    expect(encoded.byteLength).toBe(6);
    expect(roundTrip(value)).toEqual({ num: value, byteLength: 6 });
  });

  it('matches the draft-18 §1.4.1 minimal-encoding example vectors', () => {
    // 0x25 -> 37, 0xbbbd -> 15293, 0xed7f3e7d -> 226442877
    expect(hex(numberToVarInt(37))).toBe('25');
    expect(hex(numberToVarInt(15293))).toBe('bbbd');
    expect(hex(numberToVarInt(226442877))).toBe('ed7f3e7d');
  });

  it('decodes non-minimal encodings (0x8025 -> 37)', () => {
    const nonMinimal = new Uint8Array([0x80, 0x25]);
    expect(varIntToNumbeFromBuffer(nonMinimal.buffer as ArrayBuffer, 0)).toEqual({
      num: 37,
      byteLength: 2,
    });
  });

  it('round-trips the boundary values for each varint size', () => {
    for (const value of [0, 127, 128, 16383, 16384, 2097151, 2097152, 268435455]) {
      expect(roundTrip(value).num).toBe(value);
    }
  });

  it('throws when the value is larger than 53 bits', () => {
    expect(() => numberToVarInt(Number.MAX_SAFE_INTEGER + 1)).toThrow();
  });
});
