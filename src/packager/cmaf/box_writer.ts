/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

// Minimal ISO Base Media File Format (ISO/IEC 14496-12) box writer. Only what
// the CMAF packager needs: every box is built in memory and concatenated, so
// there is no seeking / patching of sizes after the fact.

import { concatBuffer } from '../../moq/buffer_utils.js';

export type BoxPart = Uint8Array | ArrayBuffer;

const BOX_HEADER_LENGTH = 8;

/** 4 ASCII characters (a box type or a brand) as bytes. */
export function fourCC(type: string): Uint8Array {
  if (type.length !== 4) {
    throw new Error(`A FourCC must be 4 characters long, got "${type}"`);
  }
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    out[i] = type.charCodeAt(i) & 0xff;
  }
  return out;
}

export function u8(value: number): Uint8Array {
  return new Uint8Array([value & 0xff]);
}

export function u16(value: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value);
  return out;
}

export function u24(value: number): Uint8Array {
  return new Uint8Array([(value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

export function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0);
  return out;
}

export function u64(value: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(Math.round(value)));
  return out;
}

export function i16(value: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setInt16(0, value);
  return out;
}

/** A fixed-point 16.16 value, the ISOBMFF encoding for rates and matrices. */
export function fixed16x16(value: number): Uint8Array {
  return u32(Math.round(value * 0x10000));
}

/** A fixed-point 8.8 value (used by `smhd` balance and sample entry volume). */
export function fixed8x8(value: number): Uint8Array {
  return u16(Math.round(value * 0x100));
}

export function zeros(length: number): Uint8Array {
  return new Uint8Array(length);
}

/** `size | type | payload`. */
export function box(type: string, ...parts: BoxPart[]): Uint8Array {
  const payload = concatBuffer(parts);
  return concatBuffer([u32(BOX_HEADER_LENGTH + payload.byteLength), fourCC(type), payload]);
}

/** A box whose payload starts with the `version` + `flags` FullBox header. */
export function fullBox(
  type: string,
  version: number,
  flags: number,
  ...parts: BoxPart[]
): Uint8Array {
  return box(type, u8(version), u24(flags), ...parts);
}

/**
 * The identity 3x3 transformation matrix `tkhd` / `mvhd` carry (values are
 * 16.16 fixed point except the last column, which is 2.30).
 */
export const UNITY_MATRIX = concatBuffer([
  u32(0x00010000),
  u32(0),
  u32(0),
  u32(0),
  u32(0x00010000),
  u32(0),
  u32(0),
  u32(0),
  u32(0x40000000),
]);
