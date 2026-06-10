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

describe('varint', () => {
  it('encodes small values (<= 6 bits) into a single byte', () => {
    const encoded = numberToVarInt(5);
    expect(encoded.byteLength).toBe(1);
    expect(roundTrip(5)).toEqual({ num: 5, byteLength: 1 });
  });

  it('encodes 14-bit values into 2 bytes', () => {
    const encoded = numberToVarInt(1000);
    expect(encoded.byteLength).toBe(2);
    expect(roundTrip(1000)).toEqual({ num: 1000, byteLength: 2 });
  });

  it('encodes 30-bit values into 4 bytes', () => {
    const encoded = numberToVarInt(100000);
    expect(encoded.byteLength).toBe(4);
    expect(roundTrip(100000)).toEqual({ num: 100000, byteLength: 4 });
  });

  it('encodes 53-bit values into 8 bytes', () => {
    const value = 2 ** 40;
    const encoded = numberToVarInt(value);
    expect(encoded.byteLength).toBe(8);
    expect(roundTrip(value)).toEqual({ num: value, byteLength: 8 });
  });

  it('round-trips the boundary values for each varint size', () => {
    for (const value of [0, 63, 64, 16383, 16384, 1073741823]) {
      expect(roundTrip(value).num).toBe(value);
    }
  });

  it('throws when the value is larger than 53 bits', () => {
    expect(() => numberToVarInt(Number.MAX_SAFE_INTEGER + 1)).toThrow();
  });
});
