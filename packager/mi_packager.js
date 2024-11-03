/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import { numberToVarInt, varIntToNumberOrThrow } from '../utils/varint.js'
import { readUntilEof, buffRead, concatBuffer } from '../utils/buffer_utils.js'

'use strict'

const MI_VIDEO_H264_AVCC = 0x0
const MI_AUDIO_OPUS = 0x1
const MI_RAW = 0x2

export class MIPayloadTypeEnum {
  // Create new instances of the same class as static attributes
  static None = new MIPayloadTypeEnum('None')
  static VideoH264AVCCWCP = new MIPayloadTypeEnum('VideoH264AVCCWCP')
  static AudioOpusWCP = new MIPayloadTypeEnum('AudioOpusWCP')
  static RAWData = new MIPayloadTypeEnum('RAWData')
  
  constructor (name) {
    this.name = name
  }

  toString() {
    return this.name;
  }
}

export class MIPackager {
  constructor () {
    this.type = MIPayloadTypeEnum.None // Commom
    this.seqId = -1 // Commom
    this.pts = undefined // Commom
    this.timebase = undefined // Common
    this.duration = undefined // Common
    this.wallclock = undefined // Common
    this.data = null // Common

    this.dts = undefined // VideoH264AVCCWCP
    this.metadata = null // VideoH264AVCCWCP

    this.sampleFreq = undefined // AudioOpusWCP
    this.numChannels = undefined // AudioOpusWCP
    
    this.isDelta = undefined // Internal (only use in set data)
    this.eof = false // Internal

    this.READ_BLOCK_SIZE = 1024
  }

  SetData (type, seqId, pts, timebase, duration, wallclock, data, dts, metadata, sampleFreq, numChannels, isDelta) {
    this.type = type
    this.seqId = seqId
    this.pts = pts
    this.timebase = timebase
    this.duration = duration
    this.wallclock = wallclock
    this.data = data
    this.dts = dts
    this.metadata = metadata
    this.sampleFreq = sampleFreq
    this.numChannels = numChannels

    this.isDelta = isDelta
  }

  async ReadLengthBytes (readerStream, length) {
    await this.reaMIHeader(readerStream)
    const ret = await buffRead(readerStream, length)
    this.data = ret.buff
    this.eof = ret.eof
  }

  async ReadBytesToEOF (readerStream) {
    await this.reaMIHeader(readerStream)
    this.data = await readUntilEof(readerStream, this.READ_BLOCK_SIZE)
    this.eof = true
  }

  async reaMIHeader (readerStream) {
    const intType = await varIntToNumberOrThrow(readerStream)
    if (intType === MI_VIDEO_H264_AVCC) {
      this.type = MIPayloadTypeEnum.VideoH264AVCCWCP
    } else if (intType === MI_AUDIO_OPUS) {
      this.type = MIPayloadTypeEnum.AudioOpusWCP
    } else if (intType === MI_RAW) {
      this.type = MIPayloadTypeEnum.RAWData
    } else {
      throw new Error(`Payload type ${this.type} not supported`)
    }

    if (this.type === MIPayloadTypeEnum.VideoH264AVCCWCP) {
      this.seqId = await varIntToNumberOrThrow(readerStream)
      this.pts = await varIntToNumberOrThrow(readerStream)
      this.dts = await varIntToNumberOrThrow(readerStream)
      this.timebase = await varIntToNumberOrThrow(readerStream)
      this.duration = await varIntToNumberOrThrow(readerStream)
      this.wallclock = await varIntToNumberOrThrow(readerStream)
      const metadataSize = await varIntToNumberOrThrow(readerStream)
      if (metadataSize > 0) {
        const ret = await buffRead(readerStream, metadataSize)
        if (ret.eof) {
          throw new Error(`Connection closed while receiving MI header metadata`)
        }
        this.metadata = ret.buff;
      } else {
        this.metadata = null
      }
    } else if (this.type === MIPayloadTypeEnum.AudioOpusWCP) {
      this.seqId = await varIntToNumberOrThrow(readerStream)
      this.pts = await varIntToNumberOrThrow(readerStream)
      this.timebase = await varIntToNumberOrThrow(readerStream)
      this.sampleFreq = await varIntToNumberOrThrow(readerStream)
      this.numChannels = await varIntToNumberOrThrow(readerStream)
      this.duration = await varIntToNumberOrThrow(readerStream)
      this.wallclock = await varIntToNumberOrThrow(readerStream)
    } else if (this.type === MIPayloadTypeEnum.RAWData) {
      this.seqId = await varIntToNumberOrThrow(readerStream)
    }
  }

  GetData () {
    if (this.type == MIPayloadTypeEnum.VideoH264AVCCWCP) {
      return {
        type: this.type,
        seqId: this.seqId,
        pts: this.pts,
        dts: this.dts,
        timebase: this.timebase,
        duration: this.duration,
        wallclock: this.wallclock,
        metadata: this.metadata,
        data: this.data,
      }
    } else if (this.type == MIPayloadTypeEnum.AudioOpusWCP) {
      return {
        type: this.type,
        seqId: this.seqId,
        pts: this.pts,
        timebase: this.timebase,
        sampleFreq: this.sampleFreq,
        numChannels: this.numChannels,
        duration: this.duration,
        wallclock: this.wallclock,
        data: this.data,
      }
    } else if (this.type == MIPayloadTypeEnum.RAWData) {
      return {
        type: this.type,
        seqId: this.seqId,
        data: this.data,
      }
    } else {
      return null
    }
  }

  GetDataStr () {
    const metadataSize = (this.metadata === undefined || this.metadata == null) ? 0 : this.metadata.byteLength
    const dataSize = (this.data === undefined || this.data == null) ? 0 : this.data.byteLength
    return `Type: ${this.type} - seqId: ${this.seqId} - pts: ${this.pts} - duration: ${this.duration} - wallclock: ${this.wallclock} - metadataSize: ${metadataSize} - dataSize: ${dataSize}`
  }

  ToBytes () {
    let ret = null
    if (this.type == MIPayloadTypeEnum.VideoH264AVCCWCP) {
      const typeBytes = numberToVarInt(MI_VIDEO_H264_AVCC)
      const seqIdBytes = numberToVarInt(this.seqId)
      const ptsBytes = numberToVarInt(this.pts)
      const dtsBytes = numberToVarInt(this.dts)
      const timebaseBytes = numberToVarInt(this.timebase)
      const durationBytes = numberToVarInt(this.duration)
      const wallclockBytes = numberToVarInt(this.wallclock)
      const metadataSize = (this.metadata === undefined || this.metadata == null) ? 0 : this.metadata.byteLength
      const metadataSizeBytes = numberToVarInt(metadataSize)
      if (metadataSize > 0) {
        ret = concatBuffer([typeBytes, seqIdBytes, ptsBytes, dtsBytes, timebaseBytes, durationBytes, wallclockBytes, metadataSizeBytes, this.metadata, this.data]);
      } else {
        ret = concatBuffer([typeBytes, seqIdBytes, ptsBytes, dtsBytes, timebaseBytes, durationBytes, wallclockBytes, metadataSizeBytes, this.data])
      }
    } else if (this.type == MIPayloadTypeEnum.AudioOpusWCP) {
      const typeBytes = numberToVarInt(MI_AUDIO_OPUS)
      const seqIdBytes = numberToVarInt(this.seqId)
      const ptsBytes = numberToVarInt(this.pts)
      const timebaseBytes = numberToVarInt(this.timebase)
      const sampleFreqBytes = numberToVarInt(this.sampleFreq)
      const numChannelsBytes = numberToVarInt(this.numChannels)
      const durationBytes = numberToVarInt(this.duration)
      const wallclockBytes = numberToVarInt(this.wallclock)
      ret = concatBuffer([typeBytes, seqIdBytes, ptsBytes, timebaseBytes, sampleFreqBytes, numChannelsBytes, durationBytes, wallclockBytes, this.data])
    } else if (this.type == MIPayloadTypeEnum.RAWData) {
      const typeBytes = numberToVarInt(MI_RAW)
      ret = concatBuffer([typeBytes, this.data])
    } else {
      throw new Error(`Payload type ${this.type} not supported`)
    }

    return ret
  }

  IsEof() {
    return this.eof
  }

  IsDelta() {
    return this.isDelta // Only valid from setData
  }
}
