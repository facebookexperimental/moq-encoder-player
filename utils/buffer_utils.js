/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

'use strict'

export class ReadStreamClosed extends Error {
  constructor(message) {
    super(message)
    this.name = "ReadStreamClosed"
  }
}

export function concatBuffer (arr) {
  let totalLength = 0
  arr.forEach(element => {
    if (element !== undefined) {
      totalLength += element.byteLength
    }
  })
  const retBuffer = new Uint8Array(totalLength)
  let pos = 0
  arr.forEach(element => {
    if (element !== undefined) {
      let element8b = element
      if (!(element instanceof Uint8Array)) {
        element8b = new Uint8Array(element)
      }
      retBuffer.set(element8b, pos)
      pos += element.byteLength
    }
  })
  return retBuffer
}

export async function readUntilEof (readableStream, blockSize) {
  const chunkArray = []
  let totalLength = 0

  while (true) {
    let bufferChunk = new Uint8Array(blockSize)
    const reader = readableStream.getReader({ mode: 'byob' })
    const { value, done } = await reader.read(new Uint8Array(bufferChunk, 0, blockSize))
    if (value !== undefined) {
      bufferChunk = value.buffer
      chunkArray.push(bufferChunk.slice(0, value.byteLength))
      totalLength += value.byteLength
    }
    reader.releaseLock()
    if (value === undefined) {
      throw new Error('error reading incoming data')
    }
    if (done) {
      break
    }
  }
  // Concatenate received data
  const payload = new Uint8Array(totalLength)
  let pos = 0
  for (const element of chunkArray) {
    const uint8view = new Uint8Array(element, 0, element.byteLength)
    payload.set(uint8view, pos)
    pos += element.byteLength
  }

  return payload
}

export async function buffRead (readableStream, size) {
  let ret = null
  if (size <= 0) {
    return ret
  }
  let buff = new Uint8Array(Number(size))
  const reader = readableStream.getReader({ mode: 'byob' })

  try {
    ret = await buffReadFrombyobReader(reader, buff, 0, size)    
  } finally {
    reader.releaseLock()
  }
  return ret
}

export async function buffReadFrombyobReader (reader, buffer, offset, size) {
  const ret = null
  if (size <= 0) {
    return ret
  }
  let remainingSize = size
  let eof = false
  while (remainingSize > 0) {
    const { value, done } = await reader.read(new Uint8Array(buffer, offset, remainingSize))
    if (value !== undefined) {
      buffer = value.buffer
      offset += value.byteLength
      remainingSize = remainingSize - value.byteLength
    }
    if (done && remainingSize > 0) {
      throw new ReadStreamClosed('short buffer')
    }
    eof = done
  }
  return {eof, buff: buffer}
}
