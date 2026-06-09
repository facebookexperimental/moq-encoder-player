/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import {
  numberToSingleByteArray,
  numberTo2BytesArray,
  compareArrayBuffer,
  convertTimestamp,
  buf2hex,
} from '../src/utils/utils.js';

describe('numberToSingleByteArray', () => {
  it('encodes a value in [0, 255]', () => {
    expect(Array.from(numberToSingleByteArray(0))).toEqual([0]);
    expect(Array.from(numberToSingleByteArray(255))).toEqual([255]);
    expect(Array.from(numberToSingleByteArray(128))).toEqual([128]);
  });

  it('throws on overflow / underflow', () => {
    expect(() => numberToSingleByteArray(256)).toThrow();
    expect(() => numberToSingleByteArray(-1)).toThrow();
  });
});

describe('numberTo2BytesArray', () => {
  it('encodes big-endian by default', () => {
    const buf = numberTo2BytesArray(0x0102);
    expect(Array.from(new Uint8Array(buf))).toEqual([0x01, 0x02]);
  });

  it('encodes little-endian when requested', () => {
    const buf = numberTo2BytesArray(0x0102, true);
    expect(Array.from(new Uint8Array(buf))).toEqual([0x02, 0x01]);
  });
});

describe('compareArrayBuffer', () => {
  it('returns true for equal buffers', () => {
    const a = new Uint8Array([1, 2, 3]).buffer;
    const b = new Uint8Array([1, 2, 3]).buffer;
    expect(compareArrayBuffer(a, b)).toBe(true);
  });

  it('returns false for buffers of different content or length', () => {
    expect(
      compareArrayBuffer(new Uint8Array([1, 2, 3]).buffer, new Uint8Array([1, 2, 4]).buffer),
    ).toBe(false);
    expect(
      compareArrayBuffer(new Uint8Array([1, 2]).buffer, new Uint8Array([1, 2, 3]).buffer),
    ).toBe(false);
  });

  it('treats two undefined buffers as equal', () => {
    expect(compareArrayBuffer(undefined as any, undefined as any)).toBe(true);
    expect(compareArrayBuffer(new Uint8Array([1]).buffer, undefined as any)).toBe(false);
  });
});

describe('convertTimestamp', () => {
  it('rescales timestamps between timescales', () => {
    // 1 second at 1us timescale -> 90kHz
    expect(convertTimestamp(1_000_000, 1_000_000, 90_000)).toBe(90_000);
    expect(convertTimestamp(90_000, 90_000, 1_000_000)).toBe(1_000_000);
  });

  it('rounds to the nearest integer', () => {
    expect(convertTimestamp(1, 3, 1)).toBe(0);
    expect(convertTimestamp(2, 3, 1)).toBe(1);
  });
});

describe('buf2hex', () => {
  it('renders a hex string with zero padding', () => {
    expect(buf2hex(new Uint8Array([0x00, 0x0f, 0xff, 0xa0]).buffer)).toBe('000fffa0');
  });
});
