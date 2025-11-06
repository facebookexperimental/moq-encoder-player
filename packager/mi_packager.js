/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

// Follows "draft-cenzano-moq-media-interop/": https://datatracker.ietf.org/doc/draft-cenzano-moq-media-interop/

import { numberToVarInt, varIntToNumbeFromBuffer } from '../utils/varint.js'
import { buffRead, concatBuffer, readUntilEof } from '../utils/buffer_utils.js'
import { MOQ_EXT_HEADER_TYPE_MOQMI_MEDIA_TYPE, MOQ_EXT_HEADER_TYPE_MOQMI_VIDEO_H264_IN_AVCC_METADATA, MOQ_EXT_HEADER_TYPE_MOQMI_VIDEO_H264_IN_AVCC_EXTRADATA, MOQ_EXT_HEADER_TYPE_MOQMI_AUDIO_OPUS_METADATA, MOQ_EXT_HEADER_TYPE_MOQMI_AUDIO_AACLC_MPEG4_METADATA, MOQ_EXT_HEADER_TYPE_MOQMI_TEXT_UTF8_METADATA, moqCreateKvPair} from '../utils/moqt.js'

'use strict'

export const MI_PACKAGER_VERSION = "03"

// Values for MOQ_EXT_HEADER_TYPE_MOQMI_MEDIA_TYPE
export const MOQ_EXT_HEADER_TYPE_MOQMI_MEDIA_VALUE_VIDEO_H264_IN_AVCC = 0x00
export const MOQ_EXT_HEADER_TYPE_MOQMI_MEDIA_VALUE_AUDIO_OPUS_BITSTREAM = 0x01
export const MOQ_EXT_HEADER_TYPE_MOQMI_MEDIA_VALUE_AUDIO_TEXT_UTF8 = 0x02
export const MOQ_EXT_HEADER_TYPE_MOQMI_MEDIA_VALUE_AUDIO_AUDIO_AACLC_MPEG4 = 0x03


export class MIPayloadTypeEnum {
  static #_NONE = 0xff;
  static #_VideoH264AVCCWCP = 0x0;
  static #_AudioOpusWCP = 0x1;
  static #_AudioAACMP4LCWCP = 0x3;
  static #_RAW = 0x2;

  static get None() { return this.#_NONE; }
  static get VideoH264AVCCWCP() { return this.#_VideoH264AVCCWCP; }
  static get AudioOpusWCP() { return this.#_AudioOpusWCP; }
  static get AudioAACMP4LCWCP() { return this.#_AudioAACMP4LCWCP; }
  static get RAWData() { return this.#_RAW; }
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

    this.sampleFreq = undefined // AudioOpusWCP & AudioAACMP4LCWCP
    this.numChannels = undefined // AudioOpusWCP & AudioAACMP4LCWCP
    
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

  async ParseData(readerStream, extensionHeaders, payloadLength) {
    this.parseExtensionHeaders(extensionHeaders)
    
    // Read payload with length
    if (typeof payloadLength !== 'undefined') {
      const ret = await buffRead(readerStream, payloadLength)
      this.data = ret.buff
      this.eof = ret.eof
    } else {
      const buff = await readUntilEof(readerStream, this.READ_BLOCK_SIZE)
      this.data = buff
      this.eof = true
    }
  }

  parseExtensionHeaders(extensionHeaders) {
    const extTypeRead = []
    for (let i = 0; i < extensionHeaders.length; i++) {
      const extHeader = extensionHeaders[i]
      extTypeRead.push(extHeader.name)

      if (extHeader.name == MOQ_EXT_HEADER_TYPE_MOQMI_MEDIA_TYPE) {
        this.type = extHeader.val
      }
      if (extHeader.name === MOQ_EXT_HEADER_TYPE_MOQMI_VIDEO_H264_IN_AVCC_METADATA) {
        let bytesRead = 0
        let r = varIntToNumbeFromBuffer(extHeader.val, bytesRead)
        bytesRead += r.byteLength
        this.seqId = r.num

        r = varIntToNumbeFromBuffer(extHeader.val, bytesRead)
        bytesRead += r.byteLength
        this.pts = r.num

        r = varIntToNumbeFromBuffer(extHeader.val, bytesRead)
        bytesRead += r.byteLength
        this.dts = r.num

        r = varIntToNumbeFromBuffer(extHeader.val, bytesRead)
        bytesRead += r.byteLength
        this.timebase = r.num

        r = varIntToNumbeFromBuffer(extHeader.val, bytesRead)
        bytesRead += r.byteLength
        this.duration = r.num

        r = varIntToNumbeFromBuffer(extHeader.val, bytesRead)
        bytesRead += r.byteLength
        this.wallclock = r.num
      }
      if (extHeader.name == MOQ_EXT_HEADER_TYPE_MOQMI_VIDEO_H264_IN_AVCC_EXTRADATA) {
        this.metadata = extHeader.val
      }
      if (extHeader.name === MOQ_EXT_HEADER_TYPE_MOQMI_AUDIO_OPUS_METADATA || extHeader.name === MOQ_EXT_HEADER_TYPE_MOQMI_AUDIO_AACLC_MPEG4_METADATA) {
        let bytesRead = 0
        let r = varIntToNumbeFromBuffer(extHeader.val, bytesRead)
        bytesRead += r.byteLength
        this.seqId = r.num

        r = varIntToNumbeFromBuffer(extHeader.val, bytesRead)
        bytesRead += r.byteLength
        this.pts = r.num

        r = varIntToNumbeFromBuffer(extHeader.val, bytesRead)
        bytesRead += r.byteLength
        this.timebase = r.num

        r = varIntToNumbeFromBuffer(extHeader.val, bytesRead)
        bytesRead += r.byteLength
        this.sampleFreq = r.num

        r = varIntToNumbeFromBuffer(extHeader.val, bytesRead)
        bytesRead += r.byteLength
        this.numChannels = r.num

        r = varIntToNumbeFromBuffer(extHeader.val, bytesRead)
        bytesRead += r.byteLength
        this.duration = r.num

        r = varIntToNumbeFromBuffer(extHeader.val, bytesRead)
        bytesRead += r.byteLength
        this.wallclock = r.num
      }
      if (extHeader.name === MOQ_EXT_HEADER_TYPE_MOQMI_TEXT_UTF8_METADATA) {
        const r = varIntToNumbeFromBuffer(extHeader.val, 0)
        this.seqId = r.num
      }
    }

    if (this.name === MIPayloadTypeEnum.RAWData) {
      if (!(extTypeRead.includes(MOQ_EXT_HEADER_TYPE_MOQMI_TEXT_UTF8_METADATA))) {
        throw new Error(`Type RAWData needs MOQ_EXT_HEADER_TYPE_MOQMI_TEXT_UTF8_METADATA`) 
      }
    }
    if (this.name === MIPayloadTypeEnum.VideoH264AVCCWCP) {
      if (!(extTypeRead.includes(MOQ_EXT_HEADER_TYPE_MOQMI_VIDEO_H264_IN_AVCC_METADATA))) {
        throw new Error(`Type VideoH264AVCCWCP needs MOQ_EXT_HEADER_TYPE_MOQMI_VIDEO_H264_IN_AVCC_METADATA`) 
      }
    }
    if (this.name === MIPayloadTypeEnum.AudioOpusWCP) {
      if (!(extTypeRead.includes(MOQ_EXT_HEADER_TYPE_MOQMI_AUDIO_OPUS_METADATA))) {
        throw new Error(`Type AudioOpusWCP needs MOQ_EXT_HEADER_TYPE_MOQMI_AUDIO_OPUS_METADATA`) 
      }
    }
    if (this.name === MIPayloadTypeEnum.AudioAACMP4LCWCP) {
      if (!(extTypeRead.includes(MOQ_EXT_HEADER_TYPE_MOQMI_AUDIO_AACLC_MPEG4_METADATA))) {
        throw new Error(`Type AudioAACMP4LCWCP needs MOQ_EXT_HEADER_TYPE_MOQMI_AUDIO_AACLC_MPEG4_METADATA`) 
      }
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
    } else if (this.type == MIPayloadTypeEnum.AudioOpusWCP || this.type == MIPayloadTypeEnum.AudioAACMP4LCWCP) {
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
    return `type: ${this.type} - seqId: ${this.seqId} - pts: ${this.pts} - duration: ${this.duration} - sampleFreq: ${this.sampleFreq} - numChannels: ${this.numChannels} - wallclock: ${this.wallclock} - metadataSize: ${metadataSize} - dataSize: ${dataSize}`
  }

  PayloadToBytes() {
    if (this.type != MIPayloadTypeEnum.VideoH264AVCCWCP && this.type != MIPayloadTypeEnum.AudioOpusWCP && this.type != MIPayloadTypeEnum.AudioAACMP4LCWCP && this.type != MIPayloadTypeEnum.RAWData) {
      throw new Error(`Payload type ${this.type} not supported`)
    }
    return  this.data
  }

  ExtensionHeaders() {
    const kv_params = []
    if (this.type == MIPayloadTypeEnum.VideoH264AVCCWCP) {
      kv_params.push(moqCreateKvPair(MOQ_EXT_HEADER_TYPE_MOQMI_MEDIA_TYPE, MOQ_EXT_HEADER_TYPE_MOQMI_MEDIA_VALUE_VIDEO_H264_IN_AVCC))
        
      const h264AvccMetadataValue = [];
      h264AvccMetadataValue.push(numberToVarInt(this.seqId))
      h264AvccMetadataValue.push(numberToVarInt(this.pts))
      h264AvccMetadataValue.push(numberToVarInt(this.dts))
      h264AvccMetadataValue.push(numberToVarInt(this.timebase))
      h264AvccMetadataValue.push(numberToVarInt(this.duration))
      h264AvccMetadataValue.push(numberToVarInt(this.wallclock))
      kv_params.push(moqCreateKvPair(MOQ_EXT_HEADER_TYPE_MOQMI_VIDEO_H264_IN_AVCC_METADATA, concatBuffer(h264AvccMetadataValue)))
          
      if (this.metadata != undefined && this.metadata != null && this.metadata.byteLength > 0) {
        kv_params.push(moqCreateKvPair(MOQ_EXT_HEADER_TYPE_MOQMI_VIDEO_H264_IN_AVCC_EXTRADATA, this.metadata ))
      }
    } else if (this.type == MIPayloadTypeEnum.AudioOpusWCP) {
      kv_params.push(moqCreateKvPair(MOQ_EXT_HEADER_TYPE_MOQMI_MEDIA_TYPE, MOQ_EXT_HEADER_TYPE_MOQMI_MEDIA_VALUE_AUDIO_OPUS_BITSTREAM))
      
      const opusMetadataValue = [];
      opusMetadataValue.push(numberToVarInt(this.seqId))
      opusMetadataValue.push(numberToVarInt(this.pts))
      opusMetadataValue.push(numberToVarInt(this.timebase))
      opusMetadataValue.push(numberToVarInt(this.sampleFreq))
      opusMetadataValue.push(numberToVarInt(this.numChannels))
      opusMetadataValue.push(numberToVarInt(this.duration))
      opusMetadataValue.push(numberToVarInt(this.wallclock))
      kv_params.push(moqCreateKvPair(MOQ_EXT_HEADER_TYPE_MOQMI_AUDIO_OPUS_METADATA, concatBuffer(opusMetadataValue)))
    } else if (this.type == MIPayloadTypeEnum.AudioAACMP4LCWCP) {
      kv_params.push(moqCreateKvPair(MOQ_EXT_HEADER_TYPE_MOQMI_MEDIA_TYPE, MOQ_EXT_HEADER_TYPE_MOQMI_MEDIA_VALUE_AUDIO_AUDIO_AACLC_MPEG4))
      
      const aacMetadataValue = [];
      aacMetadataValue.push(numberToVarInt(this.seqId))
      aacMetadataValue.push(numberToVarInt(this.pts))
      aacMetadataValue.push(numberToVarInt(this.timebase))
      aacMetadataValue.push(numberToVarInt(this.sampleFreq))
      aacMetadataValue.push(numberToVarInt(this.numChannels))
      aacMetadataValue.push(numberToVarInt(this.duration))
      aacMetadataValue.push(numberToVarInt(this.wallclock))
      kv_params.push(moqCreateKvPair(MOQ_EXT_HEADER_TYPE_MOQMI_AUDIO_AACLC_MPEG4_METADATA, concatBuffer(aacMetadataValue)))
    } else if (this.type == MIPayloadTypeEnum.RAWData) {
      kv_params.push(moqCreateKvPair(MOQ_EXT_HEADER_TYPE_MOQMI_MEDIA_TYPE, MOQ_EXT_HEADER_TYPE_MOQMI_MEDIA_VALUE_AUDIO_TEXT_UTF8))
      kv_params.push(moqCreateKvPair(MOQ_EXT_HEADER_TYPE_MOQMI_TEXT_UTF8_METADATA, numberToVarInt(this.seqId)))
    } else {
      throw new Error(`Payload type ${this.type} not supported`)
    }
    return kv_params
  }

  IsEof() {
    return this.eof
  }

  IsDelta() {
    return this.isDelta // Only valid from setData
  }

  getMediaType() {
    if (this.type == MIPayloadTypeEnum.VideoH264AVCCWCP) {
      return "video";
    } else if (this.type == MIPayloadTypeEnum.AudioOpusWCP || this.type == MIPayloadTypeEnum.AudioAACMP4LCWCP) {
      return "audio";
    } else {
      return "data";
    }
  }
}

export function MIgetTrackName(trackPrefix, isAudio) {
  let suffix = ""
  if (isAudio) {
    suffix = "audio0";
  } else {
    suffix = "video0";
  }
  return `${trackPrefix}${suffix}`;
}
