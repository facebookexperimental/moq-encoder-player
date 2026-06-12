/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

// Fixed-width big/little-endian integer encoders used by the MoQ wire format.

export function numberToSingleByteArray(num: number): Uint8Array {
  if (num > 255 || num < 0) throw new Error(`Overlfow! Tried to encode ${num} as single byte`);
  return new Uint8Array([Math.round(num)]);
}

export function numberTo2BytesArray(num: number, isLittleEndian?: boolean): ArrayBuffer {
  if (num > 65535 || num < 0) throw new Error(`Overlfow! Tried to encode ${num} as single byte`);

  const buffer = new ArrayBuffer(2);
  new DataView(buffer).setInt16(0, num, isLittleEndian);
  return buffer;
}
