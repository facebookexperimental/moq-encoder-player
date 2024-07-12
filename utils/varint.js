/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import { buffReadFrombyobReader } from './buffer_utils.js'

const MAX_U6 = Math.pow(2, 6) - 1
const MAX_U14 = Math.pow(2, 14) - 1
const MAX_U30 = Math.pow(2, 30) - 1
const MAX_U53 = Number.MAX_SAFE_INTEGER
// const MAX_U62 = 2n ** 62n - 1n

export function numberToVarInt (v) {
  if (v <= MAX_U6) {
    return setUint8(v)
  } else if (v <= MAX_U14) {
    return setUint16(v | 0x4000)
  } else if (v <= MAX_U30) {
    return setUint32(v | 0x80000000)
  } else if (v <= MAX_U53) {
    return setUint64(BigInt(v) | 0xc000000000000000n)
  } else {
    throw new Error(`overflow, value larger than 53-bits: ${v}`)
  }
}

export async function varIntToNumber (readableStream) {
  let ret
  const reader = readableStream.getReader({ mode: 'byob' })
  try {
    let buff = new ArrayBuffer(8)
    let retBuff = null

    retBuff = await buffReadFrombyobReader(reader, buff, 0, 1)
    buff = retBuff.buff
    const size = (new DataView(buff, 0, 1).getUint8() & 0xc0) >> 6
    if (size === 0) {
      ret = new DataView(buff, 0, 1).getUint8() & 0x3f
    } else if (size === 1) {
      retBuff = await buffReadFrombyobReader(reader, buff, 1, 1)
      buff = retBuff.buff
      ret = new DataView(buff, 0, 2).getUint16() & 0x3fff
    } else if (size === 2) {
      retBuff = await buffReadFrombyobReader(reader, buff, 1, 3)
      buff = retBuff.buff
      ret = new DataView(buff, 0, 4).getUint32() & 0x3fffffff
    } else if (size === 3) {
      retBuff = await buffReadFrombyobReader(reader, buff, 1, 7)
      buff = retBuff.buff
      ret = Number(new DataView(buff, 0, 8).getBigUint64() & BigInt('0x3fffffffffffffff'))
    } else {
      throw new Error('impossible')
    }
  } finally {
    reader.releaseLock()
  }
  return ret
}

function setUint8 (v) {
  const ret = new Uint8Array(1)
  ret[0] = v
  return ret
}

function setUint16 (v) {
  const ret = new Uint8Array(2)
  const view = new DataView(ret.buffer)
  view.setUint16(0, v)
  return ret
}

function setUint32 (v) {
  const ret = new Uint8Array(4)
  const view = new DataView(ret.buffer)
  view.setUint32(0, v)
  return ret
}

function setUint64 (v) {
  const ret = new Uint8Array(8)
  const view = new DataView(ret.buffer)
  view.setBigUint64(0, v)
  return ret
}
