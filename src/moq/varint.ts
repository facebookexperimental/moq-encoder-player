/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import { buffReadFrombyobReader, ReadStreamClosed } from './buffer_utils.js';

// MoQ Transport draft-18 variable-length integer encoding (vi64).
//
// Unlike RFC9000 varints (where the two most-significant bits select a 1/2/4/8
// byte length), draft-18 (§1.4.1) uses the number of leading 1 bits of the first
// byte to indicate the encoded length in bytes (1..9). The value bits follow the
// first 0 bit (or, for the 9-byte form, occupy the remaining 8 bytes).
//
//   Leading bits  Length  Usable bits  Range
//   0             1       7            0-127
//   10            2       14           0-16383
//   110           3       21           ...
//   1110          4       28
//   11110         5       35
//   111110        6       42
//   1111110       7       49
//   11111110      8       56
//   11111111      9       64
//
// Non-minimal encodings are legal (draft-17 #1595): a value can be encoded using
// more bytes than strictly required. Decoders MUST accept them; we always encode
// using the minimal length.

// We represent values as JS numbers, which are exact up to 2^53 - 1. Values that
// require more precision are not produced by this application; encode throws on
// overflow and decode converts via Number (losing precision only above 2^53).
const MAX_U53 = Number.MAX_SAFE_INTEGER;

export interface VarIntResult {
  num: number | undefined;
  byteLength: number;
}

// Usable value bits for a given encoded length (1..9).
function usableBits(len: number): number {
  return len === 9 ? 64 : 7 * len;
}

// Number of leading 1 bits in the first byte gives length - 1 (so length 1..9).
function varIntLengthFromFirstByte(firstByte: number): number {
  let ones = 0;
  for (let mask = 0x80; (mask & firstByte) !== 0; mask >>= 1) {
    ones++;
  }
  return ones + 1;
}

export function numberToVarInt(v: number): Uint8Array {
  if (!Number.isInteger(v) || v < 0) {
    throw new Error(`Cannot encode non integer or negative value as varint: ${v}`);
  }
  if (v > MAX_U53) {
    throw new Error(`overflow, value larger than 53-bits: ${v}`);
  }

  // Pick the minimal length whose usable bits can represent the value.
  let len = 1;
  const big = BigInt(v);
  while (len < 9 && big >= 1n << BigInt(usableBits(len))) {
    len++;
  }

  const ret = new Uint8Array(len);
  let tmp = big;
  for (let i = len - 1; i >= 0; i--) {
    ret[i] = Number(tmp & 0xffn);
    tmp >>= 8n;
  }
  // OR the length-prefix bits into the first byte: (len-1) leading ones followed
  // by a zero (for len 1..8), or 0xff for the 9-byte form.
  const prefix = len === 9 ? 0xff : (0xff << (9 - len)) & 0xff;
  ret[0] |= prefix;
  return ret;
}

// Extract a vi64 value from `bytes` starting at `offset`, given the already
// decoded `len`. The first byte's prefix bits are masked off.
function extractValue(bytes: Uint8Array, offset: number, len: number): number {
  let val = 0n;
  if (len === 9) {
    // First byte (0xff) is all prefix; value is the next 8 bytes.
    for (let i = 1; i < 9; i++) {
      val = (val << 8n) | BigInt(bytes[offset + i]);
    }
  } else {
    const firstByteValueMask = (1 << (8 - len)) - 1;
    val = BigInt(bytes[offset] & firstByteValueMask);
    for (let i = 1; i < len; i++) {
      val = (val << 8n) | BigInt(bytes[offset + i]);
    }
  }
  return Number(val);
}

export function varIntToNumbeFromBuffer(buff: ArrayBuffer, offset?: number): VarIntResult {
  const startOffset = typeof offset === 'number' ? offset : 0;
  const bytes = new Uint8Array(buff);
  const len = varIntLengthFromFirstByte(bytes[startOffset]);
  if (buff.byteLength - startOffset < len) {
    throw new Error(
      `Size of varint does NOT match (len: ${len}, available: ${buff.byteLength - startOffset})`,
    );
  }
  return { num: extractValue(bytes, startOffset, len), byteLength: len };
}

export async function varIntToNumberOrThrow(readableStream: ReadableStream): Promise<number> {
  const ret = await varIntToNumber(readableStream);
  if (ret.eof) {
    throw new ReadStreamClosed(`Connection closed while reading data`);
  }
  return ret.num;
}

export async function varIntToNumberAndLengthOrThrow(
  readableStream: ReadableStream,
): Promise<{ num: number; byteLength: number }> {
  const ret = await varIntToNumber(readableStream);
  if (ret.eof) {
    throw new ReadStreamClosed(`Connection closed while reading data`);
  }
  return { num: ret.num, byteLength: ret.byteLength };
}

async function varIntToNumber(
  readableStream: ReadableStream,
): Promise<{ eof: boolean; num: number; byteLength: number }> {
  const ret = { eof: false, num: undefined, byteLength: 0 };
  const reader = readableStream.getReader({ mode: 'byob' });
  try {
    let buff = new ArrayBuffer(9);
    let retData = await buffReadFrombyobReader(reader, buff, 0, 1);
    ret.byteLength = 1;
    ret.eof = retData.eof;
    if (!ret.eof) {
      buff = retData.buff;
      const len = varIntLengthFromFirstByte(new DataView(buff, 0, 1).getUint8(0));
      if (len > 1) {
        retData = await buffReadFrombyobReader(reader, buff, 1, len - 1);
        buff = retData.buff;
        ret.eof = retData.eof;
        ret.byteLength = len;
      }
      ret.num = extractValue(new Uint8Array(buff), 0, len);
    }
  } finally {
    reader.releaseLock();
  }
  return ret;
}
