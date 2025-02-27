/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

// Follows "draft-cenzano-moq-media-interop/": https://datatracker.ietf.org/doc/draft-cenzano-moq-media-interop/

import { numberToVarInt, varIntToNumbeFromBuffer } from '../utils/varint.js'
import { buffRead, concatBuffer } from '../utils/buffer_utils.js'
import { MOQ_EXT_HEADER_TYPE_MOQMI_MEDIA_TYPE, MOQ_EXT_HEADER_TYPE_MOQMI_VIDEO_H264_IN_AVCC_METADATA, MOQ_EXT_HEADER_TYPE_MOQMI_VIDEO_H264_IN_AVCC_EXTRADATA, MOQ_EXT_HEADER_TYPE_MOQMI_AUDIO_OPUS_METADATA, MOQ_EXT_HEADER_TYPE_MOQMI_AUDIO_AACLC_MPEG4_METADATA, MOQ_EXT_HEADER_TYPE_MOQMI_TEXT_UTF8_METADATA} from '../utils/moqt.js'

'use strict'

export const MI_PACKAGER_VERSION = "02"

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
    
    // Read payload
    const ret = await buffRead(readerStream, payloadLength)
    this.data = ret.buff
    this.eof = ret.eof
  }

  parseExtensionHeaders(extensionHeaders) {
    const extTypeRead = []

    console.log(`JOC extensionHeaders: ${JSON.stringify(extensionHeaders)}`)

    for (let i = 0; i < extensionHeaders.length; i++) {
      const extHeader = extensionHeaders[i]
      extTypeRead.push(extHeader.type)

      if (extHeader.type == MOQ_EXT_HEADER_TYPE_MOQMI_MEDIA_TYPE) {
        this.type = extHeader.value
      }
      if (extHeader.type === MOQ_EXT_HEADER_TYPE_MOQMI_VIDEO_H264_IN_AVCC_METADATA) {
        // TODO Decode it
        console.log(`JOC: MOQ_EXT_HEADER_TYPE_MOQMI_VIDEO_H264_IN_AVCC_METADATA: ${extHeader.value}`)
      }
      if (extHeader.type == MOQ_EXT_HEADER_TYPE_MOQMI_VIDEO_H264_IN_AVCC_EXTRADATA) {
        // TODO Decode it
        console.log(`JOC: MOQ_EXT_HEADER_TYPE_MOQMI_VIDEO_H264_IN_AVCC_EXTRADATA: ${extHeader.value}`)
      }
      if (extHeader.type === MOQ_EXT_HEADER_TYPE_MOQMI_AUDIO_OPUS_METADATA) {
        // TODO Decode it
        console.log(`JOC: MOQ_EXT_HEADER_TYPE_MOQMI_AUDIO_OPUS_METADATA: ${extHeader.value}`)
      }
      if (extHeader.type === MOQ_EXT_HEADER_TYPE_MOQMI_TEXT_UTF8_METADATA) {
        // TODO Decode it
        console.log(`JOC: MOQ_EXT_HEADER_TYPE_MOQMI_TEXT_UTF8_METADATA: ${extHeader.value}`)
        this.seqId = varIntToNumbeFromBuffer(extHeader.value);
      }
      if (extHeader.type === MOQ_EXT_HEADER_TYPE_MOQMI_AUDIO_AACLC_MPEG4_METADATA) {
        // TODO Decode it
        console.log(`JOC: MOQ_EXT_HEADER_TYPE_MOQMI_AUDIO_AACLC_MPEG4_METADATA: ${extHeader.value}`)
      }
    }

    if (this.type === MIPayloadTypeEnum.RAWData) {
      if (!(extTypeRead.includes(MOQ_EXT_HEADER_TYPE_MOQMI_TEXT_UTF8_METADATA))) {
        throw new Error(`Type RAWData needs MOQ_EXT_HEADER_TYPE_MOQMI_TEXT_UTF8_METADATA`) 
      }
    }
    
    // this.type = ret.num;
    // if (ret.num != MIPayloadTypeEnum.VideoH264AVCCWCP && ret.num === MIPayloadTypeEnum.AudioOpusWCP && ret.num === MIPayloadTypeEnum.AudioAACMP4LCWCP && ret.num === MIPayloadTypeEnum.RAWData) {
    //   throw new Error(`Payload type ${this.type} not supported`)
    // }

    // if (this.type === MIPayloadTypeEnum.VideoH264AVCCWCP) {
    //   ret = await varIntToNumberAndLengthOrThrow(readerStream);
    //   bytesRead += ret.byteLength;
    //   this.seqId = ret.num;

    //   ret = await varIntToNumberAndLengthOrThrow(readerStream);
    //   bytesRead += ret.byteLength;
    //   this.pts = ret.num;

    //   ret = await varIntToNumberAndLengthOrThrow(readerStream);
    //   bytesRead += ret.byteLength;
    //   this.dts = ret.num;

    //   ret = await varIntToNumberAndLengthOrThrow(readerStream);
    //   bytesRead += ret.byteLength;
    //   this.timebase = ret.num;

    //   ret = await varIntToNumberAndLengthOrThrow(readerStream);
    //   bytesRead += ret.byteLength;
    //   this.duration = ret.num;

    //   ret = await varIntToNumberAndLengthOrThrow(readerStream);
    //   bytesRead += ret.byteLength;
    //   this.wallclock = ret.num;

    //   // Metadata size
    //   ret = await varIntToNumberAndLengthOrThrow(readerStream)
    //   bytesRead += ret.byteLength;
    //   const metadataSize = ret.num
    //   if (metadataSize > 0) {
    //     ret = await buffRead(readerStream, metadataSize);
    //     if (ret.eof) {
    //       throw new Error(`Connection closed while receiving MI header metadata`)
    //     }
    //     bytesRead += metadataSize;
    //     this.metadata = ret.buff;
    //   } else {
    //     this.metadata = null
    //   }
    // } else if (this.type === MIPayloadTypeEnum.AudioOpusWCP || this.type === MIPayloadTypeEnum.AudioAACMP4LCWCP) {
    //   ret = await varIntToNumberAndLengthOrThrow(readerStream);
    //   bytesRead += ret.byteLength;
    //   this.seqId = ret.num;

    //   ret = await varIntToNumberAndLengthOrThrow(readerStream);
    //   bytesRead += ret.byteLength;
    //   this.pts = ret.num;

    //   ret = await varIntToNumberAndLengthOrThrow(readerStream);
    //   bytesRead += ret.byteLength;
    //   this.timebase = ret.num;

    //   ret = await varIntToNumberAndLengthOrThrow(readerStream);
    //   bytesRead += ret.byteLength;
    //   this.sampleFreq = ret.num;

    //   ret = await varIntToNumberAndLengthOrThrow(readerStream);
    //   bytesRead += ret.byteLength;
    //   this.numChannels = ret.num;

    //   ret = await varIntToNumberAndLengthOrThrow(readerStream);
    //   bytesRead += ret.byteLength;
    //   this.duration = ret.num;

    //   ret = await varIntToNumberAndLengthOrThrow(readerStream);
    //   bytesRead += ret.byteLength;
    //   this.wallclock = ret.num;
    // } else if (this.type === MIPayloadTypeEnum.RAWData) {
    //   ret = await varIntToNumberAndLengthOrThrow(readerStream);
    //   bytesRead += ret.byteLength;
    //   this.seqId = ret.num;
    // }

    // return bytesRead;
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
    return `type: ${this.type} - seqId: ${this.seqId} - pts: ${this.pts} - duration: ${this.duration} - wallclock: ${this.wallclock} - metadataSize: ${metadataSize} - dataSize: ${dataSize}`
  }

  PayloadToBytes() {
    if (this.type != MIPayloadTypeEnum.VideoH264AVCCWCP && this.type != MIPayloadTypeEnum.AudioOpusWCP && this.type != MIPayloadTypeEnum.AudioAACMP4LCWCP && this.type != MIPayloadTypeEnum.RAWData) {
      throw new Error(`Payload type ${this.type} not supported`)
    }
    return  this.data
  }

  ExtensionHeaders() {
    let ret = []
    if (this.type == MIPayloadTypeEnum.VideoH264AVCCWCP) {
      ret.push({ type: MOQ_EXT_HEADER_TYPE_MOQMI_MEDIA_TYPE, value: MOQ_EXT_HEADER_TYPE_MOQMI_MEDIA_VALUE_VIDEO_H264_IN_AVCC })
      
      const h264AvccMetadataValue = [];
      h264AvccMetadataValue.push(numberToVarInt(this.seqId))
      h264AvccMetadataValue.push(numberToVarInt(this.pts))
      h264AvccMetadataValue.push(numberToVarInt(this.dts))
      h264AvccMetadataValue.push(numberToVarInt(this.timebase))
      h264AvccMetadataValue.push(numberToVarInt(this.duration))
      h264AvccMetadataValue.push(numberToVarInt(this.wallclock))

      const h264AvccMetadataValueBuff = concatBuffer(h264AvccMetadataValue)
      ret.push({ type: MOQ_EXT_HEADER_TYPE_MOQMI_VIDEO_H264_IN_AVCC_METADATA, value: h264AvccMetadataValueBuff })
          
      if (this.metadata != undefined && this.metadata != null && this.metadata.byteLength > 0) {
        ret.push({ type: MOQ_EXT_HEADER_TYPE_MOQMI_VIDEO_H264_IN_AVCC_EXTRADATA, value: this.metadata })
      }
    } else if (this.type == MIPayloadTypeEnum.AudioOpusWCP) {
      ret.push({ type: MOQ_EXT_HEADER_TYPE_MOQMI_MEDIA_TYPE, value: MOQ_EXT_HEADER_TYPE_MOQMI_MEDIA_VALUE_AUDIO_OPUS_BITSTREAM })
      
      const opusMetadataValue = [];
      opusMetadataValue.push(numberToVarInt(this.seqId))
      opusMetadataValue.push(numberToVarInt(this.pts))
      opusMetadataValue.push(numberToVarInt(this.timebase))
      opusMetadataValue.push(numberToVarInt(this.sampleFreq))
      opusMetadataValue.push(numberToVarInt(this.numChannels))
      opusMetadataValue.push(numberToVarInt(this.duration))
      opusMetadataValue.push(numberToVarInt(this.wallclock))

      const opusMetadataValueBuff = concatBuffer(opusMetadataValue)
      ret.push({ type: MOQ_EXT_HEADER_TYPE_MOQMI_AUDIO_OPUS_METADATA, value: opusMetadataValueBuff })
    } else if (this.type == MIPayloadTypeEnum.AudioAACMP4LCWCP) {
      ret.push({ type: MOQ_EXT_HEADER_TYPE_MOQMI_MEDIA_TYPE, value: MOQ_EXT_HEADER_TYPE_MOQMI_MEDIA_VALUE_AUDIO_AUDIO_AACLC_MPEG4 })
      
      const aacMetadataValue = [];
      aacMetadataValue.push(numberToVarInt(this.seqId))
      aacMetadataValue.push(numberToVarInt(this.pts))
      aacMetadataValue.push(numberToVarInt(this.timebase))
      aacMetadataValue.push(numberToVarInt(this.sampleFreq))
      aacMetadataValue.push(numberToVarInt(this.numChannels))
      aacMetadataValue.push(numberToVarInt(this.duration))
      aacMetadataValue.push(numberToVarInt(this.wallclock))

      const aacMetadataValueBuff = concatBuffer(aacMetadataValue)
      ret.push({ type: MOQ_EXT_HEADER_TYPE_MOQMI_AUDIO_AACLC_MPEG4_METADATA, value: aacMetadataValueBuff })
    } else if (this.type == MIPayloadTypeEnum.RAWData) {
      ret.push({ type: MOQ_EXT_HEADER_TYPE_MOQMI_MEDIA_TYPE, value: MOQ_EXT_HEADER_TYPE_MOQMI_MEDIA_VALUE_AUDIO_TEXT_UTF8 })
      
      const textValue = [];
      textValue.push(numberToVarInt(this.seqId))

      const textValueBuff = concatBuffer(textValue)
      ret.push({ type: MOQ_EXT_HEADER_TYPE_MOQMI_TEXT_UTF8_METADATA, value: textValueBuff })
    } else {
      throw new Error(`Payload type ${this.type} not supported`)
    }

    return ret
  }


  // OLD

  ToBytes () {
    let ret = null
    if (this.type == MIPayloadTypeEnum.VideoH264AVCCWCP) {
      const msg = [];
      msg.push(numberToVarInt(this.type))
      msg.push(numberToVarInt(this.seqId))
      msg.push(numberToVarInt(this.pts))
      msg.push(numberToVarInt(this.dts))
      msg.push(numberToVarInt(this.timebase))
      msg.push(numberToVarInt(this.duration))
      msg.push(numberToVarInt(this.wallclock))
      const metadataSize = (this.metadata == undefined || this.metadata == null) ? 0 : this.metadata.byteLength
      msg.push(numberToVarInt(metadataSize))
      if (metadataSize > 0) {
        ret = concatBuffer([...msg, this.metadata, this.data])
      } else {
        ret = concatBuffer([...msg, this.data])
      }
    } else if (this.type == MIPayloadTypeEnum.AudioOpusWCP || this.type == MIPayloadTypeEnum.AudioAACMP4LCWCP) {
      const msg = [];
      msg.push(numberToVarInt(this.type))
      msg.push(numberToVarInt(this.seqId))
      msg.push(numberToVarInt(this.pts))
      msg.push(numberToVarInt(this.timebase))
      msg.push(numberToVarInt(this.sampleFreq))
      msg.push(numberToVarInt(this.numChannels))
      msg.push(numberToVarInt(this.duration))
      msg.push(numberToVarInt(this.wallclock))
      ret = concatBuffer([...msg, this.data])
    } else if (this.type == MIPayloadTypeEnum.RAWData) {
      const msg = [];
      msg.push(numberToVarInt(this.type))
      msg.push(numberToVarInt(this.seqId))
      ret = concatBuffer([...msg, this.data])
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

  getMediaType() {
    if (this.type == MIPayloadTypeEnum.VideoH264AVCCWCP) {
      return "video";
    } else if (this.type == MIPayloadTypeEnum.AudioOpusWCP) {
      return "audio";
    } else {
      return "data";
    }
  }
}

export function MIgetFullTrackName(ns, trackPrefix, isAudio) {
  return `${ns}/${MIgetTrackName(trackPrefix, isAudio)}`;
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
