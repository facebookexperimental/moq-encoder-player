/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import { numberToVarInt, varIntToNumberOrThrow } from '../utils/varint.js'
import { readUntilEof, buffRead, concatBuffer } from '../utils/buffer_utils.js'

export class LocPackager {
  constructor () {
    this.timestamp = 0
    this.duration = 0
    this.chunkType = ''
    this.seqId = -1
    this.firstFrameClkms = 0
    
    this.metadata = null
    this.data = null

    this.eof = false

    this.READ_BLOCK_SIZE = 1024
  }

  SetData (timestamp, duration, chunkType, seqId, firstFrameClkms, metadata, data) {
    this.seqId = seqId
    this.timestamp = timestamp

    this.duration = duration
    this.chunkType = chunkType
    this.firstFrameClkms = firstFrameClkms

    this.metadata = metadata
    this.data = data
  }

  async ReadLengthBytes (readerStream, length) {
    await this.readLOCHeader(readerStream)
    const ret = await buffRead(readerStream, length)
    this.data = ret.buff
    this.eof = ret.eof
  }

  async ReadBytesToEOF (readerStream) {
    await this.readLOCHeader(readerStream)
    this.data = await readUntilEof(readerStream, this.READ_BLOCK_SIZE)
    this.eof = true
  }

  async readLOCHeader (readerStream) {
    const chunkTypeInt = await varIntToNumberOrThrow(readerStream)
    if (chunkTypeInt === 0) {
      this.chunkType = 'delta'
    } else if (chunkTypeInt === 1) {
      this.chunkType = 'key'
    } else {
      throw new Error(`chunkType ${chunkTypeInt} not supported`)
    }
    this.seqId = await varIntToNumberOrThrow(readerStream)
    this.timestamp = await varIntToNumberOrThrow(readerStream)
    this.duration = await varIntToNumberOrThrow(readerStream)
    this.firstFrameClkms = await varIntToNumberOrThrow(readerStream)
    const metadataSize = await varIntToNumberOrThrow(readerStream)
    if (metadataSize > 0) {
      const ret = await buffRead(readerStream, metadataSize)
      if (ret.eof) {
        throw new Error(`Connection closed while receiving LOC header metadata`)
      }
      this.metadata = ret.buff
    } else {
      this.metadata = null
    }
  }

  GetData () {
    return {
      seqId: this.seqId,
      timestamp: this.timestamp,

      duration: this.duration,
      chunkType: this.chunkType,
      firstFrameClkms: this.firstFrameClkms,

      data: this.data,
      metadata: this.metadata
    }
  }

  GetDataStr () {
    const metadataSize = (this.metadata === undefined || this.metadata == null) ? 0 : this.metadata.byteLength
    const dataSize = (this.data === undefined || this.data == null) ? 0 : this.data.byteLength
    return `${this.seqId} - ${this.timestamp} - ${this.duration} - ${this.chunkType} - ${this.firstFrameClkms} - ${metadataSize} - ${dataSize}`
  }

  ToBytes () {
    let chunkTypeBytes = []
    if (this.chunkType === 'delta') {
      chunkTypeBytes = numberToVarInt(0)
    } else if (this.chunkType === 'key') {
      chunkTypeBytes = numberToVarInt(1)
    } else {
      throw new Error(`chunkType ${this.chunkType} not supported`)
    }

    const seqIdBytes = numberToVarInt(this.seqId)
    const timestampBytes = numberToVarInt(this.timestamp)

    const durationBytes = numberToVarInt(this.duration)

    const firstFrameClkmsBytes = numberToVarInt(this.firstFrameClkms)

    const metadataSize = (this.metadata === undefined || this.metadata == null) ? 0 : this.metadata.byteLength
    const metadataSizeBytes = numberToVarInt(metadataSize)
    let ret = null
    if (metadataSize > 0) {
      ret = concatBuffer([chunkTypeBytes, seqIdBytes, timestampBytes, durationBytes, firstFrameClkmsBytes, metadataSizeBytes, this.metadata, this.data])
    } else {
      ret = concatBuffer([chunkTypeBytes, seqIdBytes, timestampBytes, durationBytes, firstFrameClkmsBytes, metadataSizeBytes, this.data])
    }
    return ret
  }

  IsEof() {
    return this.eof
  }
}
