/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

'use strict'

export class CancelledError extends Error {
  constructor(message) {
    super(message);
    this.name = "CancelledError";
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
      retBuffer.set(element, pos)
      pos += element.byteLength
    }
  })
  return retBuffer
}

export function getReaderFromByobWrapper(readableStream, abortController) {
  const reader = readableStream.getReader({ mode: 'byob' })
  if (abortController != undefined) {
    abortController.signal.addEventListener("abort", () => {abortReader(reader)});  
  }
  return reader
}

export function freeReaderFromByobWrapper(readableStream, reader, abortController) {
  if (abortController != undefined) {
    abortController.signal.removeEventListener("abort", abortReader);
  }
  if (readableStream.locked) {
    reader.releaseLock();
  }
}

async function abortReader(reader) {
  reader.isCancelled = true
  await reader.cancel();
}

export async function readUntilEof (readableStream, blockSize, abortController) {
  const chunkArray = []
  let totalLength = 0

  while (true) {
    let bufferChunk = new Uint8Array(blockSize)
    const reader = getReaderFromByobWrapper(readableStream, abortController)
    const { value, done } = await reader.read(new Uint8Array(bufferChunk, 0, blockSize))
    if (value !== undefined) {
      bufferChunk = value.buffer
      chunkArray.push(bufferChunk.slice(0, value.byteLength))
      totalLength += value.byteLength
    }
    freeReaderFromByobWrapper(readableStream, reader, abortController)
    if (reader.isCancelled === true) {
      throw new CancelledError('Cancelled reader')
    }
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

export async function buffRead (readableStream, size, abortController) {
  const ret = null
  if (size <= 0) {
    return ret
  }
  let buff = new Uint8Array(Number(size))
  const reader = getReaderFromByobWrapper(readableStream, abortController)
  try {
    buff = await buffReadFrombyobReader(reader, buff, 0, size)
  } finally {
    freeReaderFromByobWrapper(readableStream, reader, abortController)
  }
  return buff
}

export async function buffReadFrombyobReader (reader, buffer, offset, size) {
  const ret = null
  if (size <= 0) {
    return ret
  }
  let remainingSize = size
  while (remainingSize > 0) {
    const { value, done } = await reader.read(new Uint8Array(buffer, offset, remainingSize))
    if (value !== undefined) {
      buffer = value.buffer
      offset += value.byteLength
      remainingSize = remainingSize - value.byteLength
    }
    if (reader.isCancelled === true) {
      throw new CancelledError('Cancelled reader')
    }
    if (done && remainingSize > 0) {
      throw new Error('short buffer')
    }
  }
  return buffer
}
