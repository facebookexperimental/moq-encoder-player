/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import { numberToVarInt, varIntToNumber } from '../utils/varint.js'
import { readUntilEof, buffRead, concatBuffer } from '../utils/buffer_utils.js'

export class LocPackager {
  constructor () {
    this.mediaType = ''
    this.timestamp = 0
    this.duration = 0
    this.chunkType = ''
    this.seqId = -1
    this.firstFrameClkms = 0
    this.pId = ''

    this.metadata = null
    this.data = null

    this.READ_BLOCK_SIZE = 1024
  }

  SetData (mediaType, timestamp, duration, chunkType, seqId, firstFrameClkms, metadata, data) {
    const pId = btoa(`${mediaType}-${timestamp}-${chunkType}-${seqId}-${Math.floor(Math.random * 100000)}`)

    this.seqId = seqId
    this.timestamp = timestamp

    this.mediaType = mediaType
    this.duration = duration
    this.chunkType = chunkType
    this.firstFrameClkms = firstFrameClkms

    this.pId = pId // Internal

    this.metadata = metadata
    this.data = data
  }

  async ReadBytes (readerStream) {
    const mediaTypeInt = await varIntToNumber(readerStream)
    if (mediaTypeInt === 0) {
      this.mediaType = 'data'
    } else if (mediaTypeInt === 1) {
      this.mediaType = 'audio'
    } else if (mediaTypeInt === 2) {
      this.mediaType = 'video'
    } else {
      throw new Error(`Mediatype ${mediaTypeInt} not supported`)
    }

    const chunkTypeInt = await varIntToNumber(readerStream)
    if (chunkTypeInt === 0) {
      this.chunkType = 'delta'
    } else if (chunkTypeInt === 1) {
      this.chunkType = 'key'
    } else {
      throw new Error(`chunkType ${chunkTypeInt} not supported`)
    }

    this.seqId = await varIntToNumber(readerStream)
    this.timestamp = await varIntToNumber(readerStream)
    this.duration = await varIntToNumber(readerStream)
    this.firstFrameClkms = await varIntToNumber(readerStream)
    const metadataSize = await varIntToNumber(readerStream)
    if (metadataSize > 0) {
      this.metadata = await buffRead(readerStream, metadataSize)
    } else {
      this.metadata = null
    }
    this.data = await readUntilEof(readerStream, this.READ_BLOCK_SIZE)
  }

  GetData () {
    return {
      seqId: this.seqId,
      timestamp: this.timestamp,

      mediaType: this.mediaType,
      duration: this.duration,
      chunkType: this.chunkType,
      firstFrameClkms: this.firstFrameClkms,

      pId: this.pId, // Internal

      data: this.data,
      metadata: this.metadata
    }
  }

  GetDataStr () {
    const metadataSize = (this.metadata === undefined || this.metadata == null) ? 0 : this.metadata.byteLength
    const dataSize = (this.data === undefined || this.data == null) ? 0 : this.data.byteLength
    return `${this.mediaType} - ${this.seqId} - ${this.timestamp} - ${this.duration} - ${this.chunkType} - ${this.firstFrameClkms} - ${metadataSize} - ${dataSize}`
  }

  ToBytes () {
    let mediaTypeBytes = []
    if (this.mediaType === 'data') {
      mediaTypeBytes = numberToVarInt(0)
    } else if (this.mediaType === 'audio') {
      mediaTypeBytes = numberToVarInt(1)
    } else if (this.mediaType === 'video') {
      mediaTypeBytes = numberToVarInt(2)
    } else {
      throw new Error(`Mediatype ${this.mediaType} not supported`)
    }

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
      ret = concatBuffer([mediaTypeBytes, chunkTypeBytes, seqIdBytes, timestampBytes, durationBytes, firstFrameClkmsBytes, metadataSizeBytes, this.metadata, this.data])
    } else {
      ret = concatBuffer([mediaTypeBytes, chunkTypeBytes, seqIdBytes, timestampBytes, durationBytes, firstFrameClkmsBytes, metadataSizeBytes, this.data])
    }
    return ret
  }
}
