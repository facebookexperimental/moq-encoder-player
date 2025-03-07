/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import { buffReadFrombyobReader, ReadStreamClosed } from './buffer_utils.js'

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

export function varIntToNumbeFromBuffer(buff, offset) {
  let startOffset = 0
  if (typeof offset === 'number') {
    startOffset = offset
  }
  let ret = {num: undefined, byteLength: 0}    
  const size = (new DataView(buff, startOffset, 1).getUint8() & 0xc0) >> 6
  if (buff.byteLength < size + 1) {
    throw new Error(`Size of varint does NOT match (size: ${size}, buff.byteLength: ${buff.byteLength})`)
  }
  if (size === 0) {
    ret.num = new DataView(buff, startOffset, 1).getUint8() & 0x3f
    ret.byteLength = 1
  } else if (size === 1) {
    ret.num = new DataView(buff, startOffset, 2).getUint16() & 0x3fff
    ret.byteLength = 2
  } else if (size === 2) {
    ret.num = new DataView(buff, startOffset, 4).getUint32() & 0x3fffffff
    ret.byteLength = 4
  } else if (size === 3) {
    ret.num = Number(new DataView(buff, startOffset, 8).getBigUint64() & BigInt('0x3fffffffffffffff'))
    ret.byteLength = 8
  } else {
    throw new Error('Impossible size for varint')
  }
  return ret
}

export async function varIntToNumberOrThrow (readableStream) {
  let ret = await varIntToNumber(readableStream)
  if (ret.eof) {
    throw new ReadStreamClosed(`Connection closed while reading data`)
  }
  return ret.num
}

export async function varIntToNumberAndLengthOrThrow (readableStream) {
  let ret = await varIntToNumber(readableStream)
  if (ret.eof) {
    throw new ReadStreamClosed(`Connection closed while reading data`)
  }
  return {num: ret.num, byteLength: ret.byteLength}
}

async function varIntToNumber (readableStream) {
  const ret = {eof: false, num: undefined, byteLength: 0}
  const reader = readableStream.getReader({ mode: 'byob' })
  try {
    let buff = new ArrayBuffer(8)
    let retData = await buffReadFrombyobReader(reader, buff, 0, 1)
    ret.byteLength = ret.byteLength + 1;
    ret.eof = retData.eof
    if (!ret.eof) {
      buff = retData.buff
      const size = (new DataView(buff, 0, 1).getUint8() & 0xc0) >> 6
      if (size === 0) {
        ret.eof = retData.eof
        ret.num = new DataView(buff, 0, 1).getUint8() & 0x3f
      } else if (size === 1) {
        retData = await buffReadFrombyobReader(reader, buff, 1, 1)
        ret.byteLength = ret.byteLength + 1;
        buff = retData.buff
        ret.eof = retData.eof
        ret.num = new DataView(buff, 0, 2).getUint16() & 0x3fff
      } else if (size === 2) {
        retData = await buffReadFrombyobReader(reader, buff, 1, 3)
        ret.byteLength = ret.byteLength + 3;
        buff = retData.buff
        ret.eof = retData.eof
        ret.num = new DataView(buff, 0, 4).getUint32() & 0x3fffffff
      } else if (size === 3) {
        retData = await buffReadFrombyobReader(reader, buff, 1, 7)
        ret.byteLength = ret.byteLength + 7;
        buff = retData.buff
        ret.eof = retData.eof
        ret.num = Number(new DataView(buff, 0, 8).getBigUint64() & BigInt('0x3fffffffffffffff'))
      } else {
        throw new Error('Impossible size for varint')
      }
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
