/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import { readUntilEof } from '../utils/buffer_utils.js'

export class RawPackager {
  READ_BLOCK_SIZE = 1024

  constructor () {
    this.data = ''

    // Internal
    this.mediaType = ''
    this.chunkType = ''
    this.seqId = -1

    this.READ_BLOCK_SIZE = 1024
  }

  SetData (mediaType, chunkType, seqId, data) {
    this.mediaType = mediaType
    this.chunkType = chunkType
    this.seqId = seqId
    this.data = data
  }

  async ReadBytes (readerStream) {
    const payloadBytes = await readUntilEof(readerStream, this.READ_BLOCK_SIZE)
    this.data = new TextDecoder().decode(payloadBytes)
  }

  GetData () {
    return {
      mediaType: this.mediaType,
      seqId: this.seqId,
      chunkType: this.chunkType,
      data: this.data
    }
  }

  GetDataStr () {
    return `${this.mediaType} - ${this.chunkType} - ${this.seqId} -  ${this.data}`
  }

  ToBytes () {
    return new TextEncoder().encode(this.data)
  }
}
