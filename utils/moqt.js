/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import { numberToVarInt, varIntToNumberOrThrow } from './varint.js'
import { concatBuffer, buffRead, ReadStreamClosed , getArrayBufferByteLength } from './buffer_utils.js'

// MOQ definitions
// https://datatracker.ietf.org/doc/draft-ietf-moq-transport/
export const MOQ_DRAFT01_VERSION = 0xff000001
export const MOQ_DRAFT02_VERSION = 0xff000002
export const MOQ_DRAFT03_VERSION = 0xff000003
export const MOQ_DRAFT04_VERSION = 0xff000004
export const MOQ_DRAFT07exp2_VERSION = 0xff070002
export const MOQ_DRAFT07_VERSION = 0xff000007
export const MOQ_DRAFT08_VERSION_EXP9 = 0xff080009
export const MOQ_DRAFT08_VERSION = 0xff000008

export const MOQ_CURRENT_VERSION = MOQ_DRAFT08_VERSION
export const MOQ_SUPPORTED_VERSIONS = [MOQ_CURRENT_VERSION]

// Setup params
// export const MOQ_SETUP_PARAMETER_ROLE = 0x0 removed in version 8
export const MOQ_SETUP_PARAMETER_PATH = 0x1
export const MOQ_SETUP_PARAMETER_MAX_SUBSCRIBE_ID = 0x2

//MOQ general params
export const MOQ_PARAMETER_AUTHORIZATION_INFO = 0x2
export const MOQ_PARAMETER_DELIVERY_TIMEOUT = 0x3
export const MOQ_PARAMETER_MAX_CACHE_DURATION = 0x4

export const MOQ_MAX_PARAMS = 256
export const MOQ_MAX_ARRAY_LENGTH = 1024
export const MOQ_MAX_TUPLE_PARAMS = 32
export const MOQ_MAX_SUBSCRIBE_ID_NUM = 128

// MOQ Location modes
export const MOQ_LOCATION_MODE_NONE = 0x0
export const MOQ_LOCATION_MODE_ABSOLUTE = 0x1
export const MOQ_LOCATION_MODE_RELATIVE_PREVIOUS = 0x2
export const MOQ_LOCATION_MODE_RELATIVE_NEXT = 0x3

// MOQ SUBSCRIPTION CODES
export const MOQ_SUBSCRIPTION_ERROR_INTERNAL = 0
export const MOQ_SUBSCRIPTION_RETRY_TRACK_ALIAS = 0x2

// MOQ SUBSCRIPTION DONE CODES
export const MOQ_SUBSCRIPTION_DONE_ENDED = 0x4

// MOQ FILTER TYPES
export const MOQ_FILTER_TYPE_LATEST_GROUP = 0x1
export const MOQ_FILTER_TYPE_LATEST_OBJ = 0x2
export const MOQ_FILTER_TYPE_ABSOLUTE_START = 0x3
export const MOQ_FILTER_TYPE_ABSOLUTE_RANGE = 0x4

// MOQ object headers
export const MOQ_MESSAGE_OBJECT_DATAGRAM = 0x1
export const MOQ_MESSAGE_STREAM_HEADER_SUBGROUP = 0x4

// MOQ Messages
export const MOQ_MESSAGE_CLIENT_SETUP = 0x40
export const MOQ_MESSAGE_SERVER_SETUP = 0x41

export const MOQ_MESSAGE_SUBSCRIBE = 0x3
export const MOQ_MESSAGE_SUBSCRIBE_OK = 0x4
export const MOQ_MESSAGE_SUBSCRIBE_ERROR = 0x5
export const MOQ_MESSAGE_UNSUBSCRIBE = 0xa
export const MOQ_MESSAGE_SUBSCRIBE_DONE = 0xb

export const MOQ_MESSAGE_ANNOUNCE = 0x6
export const MOQ_MESSAGE_ANNOUNCE_OK = 0x7
export const MOQ_MESSAGE_ANNOUNCE_ERROR = 0x8
export const MOQ_MESSAGE_UNANNOUNCE = 0x9

// MOQ PRIORITIES
export const MOQ_PUBLISHER_PRIORITY_BASE_DEFAULT = 0xa

// MOQ - QUIC mapping
export const MOQ_MAPPING_OBJECT_PER_DATAGRAM = "ObjPerDatagram"
export const MOQ_MAPPING_SUBGROUP_PER_GROUP = "SubGroupPerObj"

export const MOQ_USECASE_SUBSCRIBER_PRIORITY_DEFAULT = 0x1 // Lower values are hi-pri (highest = 0)

// Group order
export const MOQ_GROUP_ORDER_FOLLOW_PUBLISHER = 0x0
export const MOQ_GROUP_ORDER_ASCENDING = 0x1
export const MOQ_GROUP_ORDER_DESCENDING = 0x2

// Object status
export const MOQ_OBJ_STATUS_NORMAL = 0x0
export const MOQ_OBJ_STATUS_NOT_EXISTS = 0x1
export const MOQ_OBJ_STATUS_END_OF_GROUP = 0x3
export const MOQ_OBJ_STATUS_END_OF_TRACK_AND_GROUP = 0x4
export const MOQ_OBJ_STATUS_END_OF_SUBGROUP = 0x5

// Extension headers (Even types indicate value coded by a single varint. Odd types idicates value is byte buffer with prefixed varint to indicate lenght)
export const MOQ_EXT_HEADER_TYPE_MOQMI_MEDIA_TYPE = 0x0A
export const MOQ_EXT_HEADER_TYPE_MOQMI_VIDEO_H264_IN_AVCC_METADATA = 0x0B
export const MOQ_EXT_HEADER_TYPE_MOQMI_VIDEO_H264_IN_AVCC_EXTRADATA = 0x0D
export const MOQ_EXT_HEADER_TYPE_MOQMI_AUDIO_OPUS_METADATA = 0x0F
export const MOQ_EXT_HEADER_TYPE_MOQMI_TEXT_UTF8_METADATA = 0x11
export const MOQ_EXT_HEADER_TYPE_MOQMI_AUDIO_AACLC_MPEG4_METADATA = 0x13

//Audio AAC-LC in MPEG4 bitstream data header extension (Header extension type = 0x13)

export const MOQ_EXT_HEADERS_SUPPORTED = [MOQ_EXT_HEADER_TYPE_MOQMI_MEDIA_TYPE, MOQ_EXT_HEADER_TYPE_MOQMI_VIDEO_H264_IN_AVCC_METADATA, MOQ_EXT_HEADER_TYPE_MOQMI_VIDEO_H264_IN_AVCC_EXTRADATA, MOQ_EXT_HEADER_TYPE_MOQMI_AUDIO_OPUS_METADATA, MOQ_EXT_HEADER_TYPE_MOQMI_TEXT_UTF8_METADATA, MOQ_EXT_HEADER_TYPE_MOQMI_AUDIO_AACLC_MPEG4_METADATA]

export function moqCreate () {
  return {
    wt: null,
    
    controlStream: null,
    controlWriter: null,
    controlReader: null,

    multiObjectWritter: {},

    datagramsReader: null,
  }
}

export async function moqCloseWrttingStreams (moqt) {
  const multiWritterClosePromises = []
  for (const multiWritter of Object.values(moqt.multiObjectWritter)) {
    multiWritterClosePromises.push(multiWritter.close())
  } 
  if (multiWritterClosePromises.length > 0) {
    await Promise.all(multiWritterClosePromises)
  }
  moqt.multiObjectWritter = {}
}

export async function moqClose (moqt) {
  await moqCloseWrttingStreams(moqt)

  if (moqt.datagramsReader != null) {
    await moqt.datagramsReader.cancel("Closing!")
  }

  if (moqt.controlWriter != null) {
    await moqt.controlWriter.close()
    moqt.controlWriter = null
  }
  // TODO: We need to cancel the reader (https://developer.mozilla.org/en-US/docs/Web/API/ReadableStreamBYOBReader)
  if (moqt.controlReader != null) {
    await moqt.controlReader.cancel("Closing!")
    moqt.controlReader = null
  }
  if (moqt.wt != null) {
    // Race condition, relay closing too
    await moqt.wt.close() 
  }
  moqt.wt = null
  moqt.controlStream = null
  moqt.controlReader = null
  moqt.datagramsReader = null
}

// MOQ control stream

export async function moqCreateControlStream (moqt) {
  if (moqt.wt === null) {
    throw new Error('WT session is NULL when we tried to create MOQ')
  }
  if (moqt.controlReader != null || moqt.controlWriter != null) {
    throw new Error('controlReader OR controlWriter are NOT null this indicates there are some dirt from previous sessions when we tried to create MOQ')
  }

  moqt.controlStream = await moqt.wt.createBidirectionalStream()
  moqt.controlWriter = moqt.controlStream.writable
  moqt.controlReader = moqt.controlStream.readable
}

// SETUP

function moqCreateSetupMessageBytes () {
  const msg = []
  
  // Version length
  msg.push(numberToVarInt(1));
  // Version[0]
  msg.push(numberToVarInt(MOQ_CURRENT_VERSION));
  // Number of parameters
  msg.push(numberToVarInt(numberToVarInt(1)));
  // param[0]: Max subscribe ID
  msg.push(moqCreateParamBytes(MOQ_SETUP_PARAMETER_MAX_SUBSCRIBE_ID, MOQ_MAX_SUBSCRIBE_ID_NUM));
  
  // Length
  const totalLength = getArrayBufferByteLength(msg);

  return concatBuffer([numberToVarInt(MOQ_MESSAGE_CLIENT_SETUP), numberToVarInt(totalLength), ...msg])
}

export async function moqSendSetup (writerStream) {
  return moqSend(writerStream, moqCreateSetupMessageBytes())
}

async function moqParseSetupResponse (readerStream) {
  const ret = { }
  await varIntToNumberOrThrow(readerStream) // Length

  ret.version = await varIntToNumberOrThrow(readerStream)
  if (!MOQ_SUPPORTED_VERSIONS.includes(ret.version)) {
    throw new Error(`version sent from server NOT supported. Supported versions ${JSON.stringify(MOQ_SUPPORTED_VERSIONS)}, got from server ${JSON.stringify(ret.version)}`)
  }
  ret.parameters = await moqReadSetupParameters(readerStream)

  return ret
}

// ANNOUNCE

function moqCreateAnnounceMessageBytes (namespace, authInfo) {
  const msg = []

  // Namespace
  msg.push(moqCreateTupleBytes(namespace));
  // Number of parameters
  msg.push(numberToVarInt(1))
  // param[0]: authinfo
  // param[0]: authinfo value
  msg.push(moqCreateParamBytes(MOQ_PARAMETER_AUTHORIZATION_INFO, authInfo));

  // Length
  const totalLength = getArrayBufferByteLength(msg);
  const lengthBytes = numberToVarInt(totalLength);
  
  return concatBuffer([numberToVarInt(MOQ_MESSAGE_ANNOUNCE), lengthBytes, ...msg])
}

export async function moqSendAnnounce (writerStream, namespace, authInfo) {
  return moqSend(writerStream, moqCreateAnnounceMessageBytes(namespace, authInfo))
}

async function moqParseAnnounceOk (readerStream) {
  const ret = { }

  await varIntToNumberOrThrow(readerStream) // Length

  ret.namespace = await moqTupleReadOrThrow(readerStream)
  
  return ret
}

async function moqParseAnnounceError (readerStream) {
  const ret = { }

  await varIntToNumberOrThrow(readerStream) // Length

  ret.namespace = await moqTupleReadOrThrow(readerStream)
  ret.errorCode = await varIntToNumberOrThrow(readerStream)
  ret.reason = await moqStringReadOrThrow(readerStream)
  
  return ret
}


// UNANNOUNCE

function moqCreateUnAnnounceMessageBytes (namespace) {
  const msg = []
  
  // Namespace
  msg.push(moqCreateTupleBytes(namespace));

  // Length
  const totalLength = getArrayBufferByteLength(msg);
  const lengthBytes = numberToVarInt(totalLength);
  
  return concatBuffer([numberToVarInt(MOQ_MESSAGE_UNANNOUNCE), lengthBytes, ...msg])
}

export async function moqSendUnAnnounce (writerStream, namespace) {
  return moqSend(writerStream, moqCreateUnAnnounceMessageBytes(namespace))
}


// SUBSCRIBE
// Always subscribe from start next group

function moqCreateSubscribeMessageBytes(subscribeId, trackAlias, trackNamespace, trackName, authInfo) {
  const msg = []

  // SubscribeID(i)
  // Unique within the session. Subscribe ID is a monotonically increasing variable length integer which MUST not be reused within a session
  msg.push(numberToVarInt(subscribeId));
  
  // Track Alias (i)
  // A session specific identifier for the track. Messages that reference a track, such as OBJECT, reference this Track Alias instead of the Track Name and Track Namespace to reduce overhead
  msg.push(numberToVarInt(trackAlias));
  
  // Track namespace
  msg.push(moqCreateTupleBytes(trackNamespace));

  // Track name
  msg.push(moqCreateStringBytes(trackName));

  // Subscriber priority (i)
  msg.push(new Uint8Array([MOQ_USECASE_SUBSCRIBER_PRIORITY_DEFAULT]));

  // Group order
  msg.push(new Uint8Array([MOQ_GROUP_ORDER_FOLLOW_PUBLISHER]));

  // Filter type (request latest object)
  msg.push(numberToVarInt(MOQ_FILTER_TYPE_LATEST_OBJ));

  // NO need to add StartGroup, StartObject, EndGroup

  // Params
  // Number of parameters
  msg.push(numberToVarInt(1))
  // param[0]: auth info id
  // param[0]: length + auth info
  msg.push(moqCreateParamBytes(MOQ_PARAMETER_AUTHORIZATION_INFO, authInfo));
  
  // Length
  const totalLength = getArrayBufferByteLength(msg);
  const lengthBytes = numberToVarInt(totalLength);
  
  return concatBuffer([numberToVarInt(MOQ_MESSAGE_SUBSCRIBE), lengthBytes, ...msg])
}

// SUBSCRIBE OK

function moqCreateSubscribeOkMessageBytes (subscribeId, expiresMs, lastGroupSent, lastObjSent, authInfo) {
  const msg = []
  
  // Subscribe Id
  msg.push(numberToVarInt(subscribeId))

  // Expires MS
  msg.push(numberToVarInt(expiresMs))

  // Group order
  msg.push(new Uint8Array([MOQ_GROUP_ORDER_DESCENDING])); // Live streaming app (so new needs to be send first)

  if (lastGroupSent != undefined && lastObjSent != undefined) {
    // Content exists
    msg.push(new Uint8Array([1]));
    // Final group
    msg.push(numberToVarInt(lastGroupSent));
    // Final object
    msg.push(numberToVarInt(lastObjSent));
  } else {
    // Content exists
    msg.push(new Uint8Array([0]));
  }

  // Params
  // Number of parameters
  msg.push(numberToVarInt(1))
  // param[0]: auth info id
  // param[0]: length + auth info
  msg.push(moqCreateParamBytes(MOQ_PARAMETER_AUTHORIZATION_INFO, authInfo));

  // Length
  const totalLength = getArrayBufferByteLength(msg);
  const lengthBytes = numberToVarInt(totalLength);
  
  return concatBuffer([numberToVarInt(MOQ_MESSAGE_SUBSCRIBE_OK), lengthBytes, ...msg])
}

// SUBSCRIBE ERROR

function moqCreateSubscribeErrorMessageBytes (subscribeId, errorCode, reason, trackAlias) {
  const msg = []
  
  // Subscribe Id
  msg.push(numberToVarInt(subscribeId));
  // errorCode
  msg.push(numberToVarInt(errorCode));
  // Reason
  msg.push(moqCreateStringBytes(reason))
  // trackAlias
  msg.push(numberToVarInt(trackAlias))

  // Length
  const totalLength = getArrayBufferByteLength(msg);
  const lengthBytes = numberToVarInt(totalLength);
  
  return concatBuffer([numberToVarInt(MOQ_MESSAGE_SUBSCRIBE_ERROR), lengthBytes, ...msg])
}

// UNSUBSCRIBE

function moqCreateUnSubscribeMessageBytes (subscribeId) {
  const msg = []

  // Subscribe Id
  msg.push(numberToVarInt(subscribeId));

  // Length
  const totalLength = getArrayBufferByteLength(msg);
  const lengthBytes = numberToVarInt(totalLength);
  
  return concatBuffer([numberToVarInt(MOQ_MESSAGE_UNSUBSCRIBE), lengthBytes, ...msg])
}

// SUBSCRIBE DONE

function moqCreateSubscribeDoneMessageBytes(subscribeId, errorCode, reason, numberOfOpenedStreams) {
  const msg = []
  
  // Subscribe Id
  msg.push(numberToVarInt(subscribeId));
  // errorCode
  msg.push(numberToVarInt(errorCode));
  // numberOfOpenedStreams
  msg.push(numberToVarInt(numberOfOpenedStreams));
  // Reason
  msg.push(moqCreateStringBytes(reason));

  // Length
  const totalLength = getArrayBufferByteLength(msg);
  const lengthBytes = numberToVarInt(totalLength);
  
  return concatBuffer([numberToVarInt(MOQ_MESSAGE_SUBSCRIBE_DONE), lengthBytes, ...msg])
}

export async function moqSendSubscribe (writerStream, subscribeId, trackAlias, trackNamespace, trackName, authInfo) {
  return moqSend(writerStream, moqCreateSubscribeMessageBytes(subscribeId, trackAlias, trackNamespace, trackName, authInfo))
}

export async function moqSendUnSubscribe (writerStream, subscribeId) {
  return moqSend(writerStream, moqCreateUnSubscribeMessageBytes(subscribeId))
}

async function moqParseSubscribeOk (readerStream) {
  const ret = { }

  await varIntToNumberOrThrow(readerStream) // Length
  ret.subscribeId = await varIntToNumberOrThrow(readerStream)
  ret.expires = await varIntToNumberOrThrow(readerStream)
  ret.groupOrder = await moqByteReadOrThrow(readerStream);
  const contentExists =  await moqByteReadOrThrow(readerStream);
  if (contentExists > 0) {
    ret.lastGroupSent = await varIntToNumberOrThrow(readerStream)
    ret.lastObjSent = await varIntToNumberOrThrow(readerStream)
  }
  ret.parameters = moqReadParameters(readerStream)
  
  return ret
}

async function moqParseSubscribeError (readerStream) {
  const ret = { }

  await varIntToNumberOrThrow(readerStream) // Length
  ret.subscribeId = await varIntToNumberOrThrow(readerStream)
  ret.errorCode = await varIntToNumberOrThrow(readerStream)
  ret.errorReason = await moqStringReadOrThrow(readerStream)
  ret.trackAlias = await varIntToNumberOrThrow(readerStream)

  return ret
}

async function moqParseSubscribeDone (readerStream) {
  const ret = { }

  await varIntToNumberOrThrow(readerStream) // Length
  ret.subscribeId = await varIntToNumberOrThrow(readerStream)
  ret.errorCode = await varIntToNumberOrThrow(readerStream)
  ret.errorReason = await moqStringReadOrThrow(readerStream)
  const contentExists = await moqByteReadOrThrow(readerStream);
  if (contentExists > 0) {
    ret.lastGroupSent = await varIntToNumberOrThrow(readerStream)
    ret.lastObjSent = await varIntToNumberOrThrow(readerStream)
  }

  return ret
}

async function moqParseSubscribe (readerStream) {
  const ret = { }
  
  await varIntToNumberOrThrow(readerStream) // Length
  ret.subscribeId = await varIntToNumberOrThrow(readerStream)
  ret.trackAlias = await varIntToNumberOrThrow(readerStream)
  ret.namespace = await moqTupleReadOrThrow(readerStream)
  ret.trackName = await moqStringReadOrThrow(readerStream)
  ret.subscriberPriority = await moqByteReadOrThrow(readerStream);
  ret.groupOrder = await moqByteReadOrThrow(readerStream);

  ret.filterType = await varIntToNumberOrThrow(readerStream)
  if (ret.filterType === MOQ_FILTER_TYPE_ABSOLUTE_START || ret.filterType === MOQ_FILTER_TYPE_ABSOLUTE_RANGE) {
    ret.startGroup = await varIntToNumberOrThrow(readerStream)
    if (ret.startGroup !== MOQ_LOCATION_MODE_NONE) {
      await varIntToNumberOrThrow(readerStream)
      throw new Error('Not supported startGroup')
    }
    // Start object
    ret.startObject = await varIntToNumberOrThrow(readerStream)
    if (ret.startObject !== MOQ_LOCATION_MODE_NONE) {
      await varIntToNumberOrThrow(readerStream)
      throw new Error('Not supported startObject')
    }
  }
  if (ret.filterType === MOQ_FILTER_TYPE_ABSOLUTE_RANGE) {
    ret.endGroup = await varIntToNumberOrThrow(readerStream)
    if (ret.endGroup !== MOQ_LOCATION_MODE_NONE) {
      await varIntToNumberOrThrow(readerStream)
      throw new Error('Not supported endGroup')
    }
    ret.endObject = await varIntToNumberOrThrow(readerStream)
    if (ret.endObject !== MOQ_LOCATION_MODE_NONE) {
      await varIntToNumberOrThrow(readerStream)
      throw new Error('Not supported endObject')
    }    
  }
  ret.parameters = await moqReadParameters(readerStream)

  return ret
}

async function moqParseUnSubscribe (readerStream) {
  const ret = { }
  
  await varIntToNumberOrThrow(readerStream) // Length

  // SubscribeId
  ret.subscribeId = await varIntToNumberOrThrow(readerStream)

  return ret
}

export async function moqParseMsg (readerStream) {
  const msgType = await varIntToNumberOrThrow(readerStream)
  let data = null
  if (msgType === MOQ_MESSAGE_SUBSCRIBE) {
    data = await moqParseSubscribe(readerStream)
  } else if (msgType === MOQ_MESSAGE_UNSUBSCRIBE) {
    data = await moqParseUnSubscribe(readerStream)
  } else if (msgType === MOQ_MESSAGE_SUBSCRIBE_DONE) {
    data = await moqParseSubscribeDone(readerStream)
  } else if (msgType === MOQ_MESSAGE_SERVER_SETUP) {
    data = await moqParseSetupResponse(readerStream)
  } else if (msgType === MOQ_MESSAGE_ANNOUNCE_OK) {
    data = await moqParseAnnounceOk(readerStream)
  } else if (msgType === MOQ_MESSAGE_ANNOUNCE_ERROR) {
    data = await moqParseAnnounceError(readerStream)
  } else if (msgType === MOQ_MESSAGE_SUBSCRIBE_OK) {
    data = await moqParseSubscribeOk(readerStream)
  } else if (msgType === MOQ_MESSAGE_SUBSCRIBE_ERROR) {
    data = await moqParseSubscribeError(readerStream)
  } else {
    throw new Error(`UNKNOWN msg type received, got ${msgType}`)
  }

  return {type: msgType, data: data}
}

export async function moqSendSubscribeOk (writerStream, subscribeId, expiresMs, lastGroupSent, lastObjSent, authInfo) {
  return moqSend(writerStream, moqCreateSubscribeOkMessageBytes(subscribeId, expiresMs, lastGroupSent, lastObjSent, authInfo))
}

export async function moqSendSubscribeError (writerStream, subscribeId, errorCode, reason, trackAlias) {
  return moqSend(writerStream, moqCreateSubscribeErrorMessageBytes(subscribeId, errorCode, reason, trackAlias))
}

export async function moqSendSubscribeDone(writerStream, subscribeId, errorCode, reason, numberOfOpenedStreams) {
  return moqSend(writerStream, moqCreateSubscribeDoneMessageBytes(subscribeId, errorCode, reason, numberOfOpenedStreams))
}

// OBJECT

function moqCreateSubgroupHeaderBytes(trackAlias, groupSeq, publisherPriority) {
  const msg = []

  // Message type
  msg.push(numberToVarInt(MOQ_MESSAGE_STREAM_HEADER_SUBGROUP));
  msg.push(numberToVarInt(trackAlias)); // Track Alias
  msg.push(numberToVarInt(groupSeq)); // Group ID
  msg.push(numberToVarInt(groupSeq)); // Subgroup ID
  msg.push(new Uint8Array([publisherPriority])); // Publisher priority

  return concatBuffer(msg);
}

function moqCreateObjectEndOfGroupBytes(objSeq, extensionHeaders) {
  const msg = []

  msg.push(numberToVarInt(objSeq)) // Object ID
  if (extensionHeaders == undefined || extensionHeaders.length <= 0) {
    msg.push(numberToVarInt(0)); // Extension headers count
  } else {
    msg.push(moqCreateExtensionHeaders(extensionHeaders)); // Extension headers
  }
  msg.push(numberToVarInt(0)) // Size = 0
  msg.push(numberToVarInt(MOQ_OBJ_STATUS_END_OF_GROUP))

  return concatBuffer(msg);
}

function moqCreateObjectSubgroupBytes(objSeq, data, extensionHeaders) {
  const msg = []

  msg.push(numberToVarInt(objSeq)); // Object ID
  if (extensionHeaders == undefined || extensionHeaders.length <= 0) {
    msg.push(numberToVarInt(0)); // Extension headers count
  } else {
    msg.push(moqCreateExtensionHeaders(extensionHeaders)); // Extension headers
  }
  if (data != undefined && data.byteLength > 0) {
    msg.push(numberToVarInt(data.byteLength)) // Data size
    msg.push(data)
  } else {
    msg.push(numberToVarInt(0)) // Data size
    msg.push(numberToVarInt(MOQ_OBJ_STATUS_NORMAL)) // Obj status
  }
  return concatBuffer(msg);
}

function moqCreateObjectPerDatagramBytes (trackAlias, groupSeq, objSeq, publisherPriority, data, extensionHeaders) {
  const msg = []

  // Message type
  msg.push(numberToVarInt(MOQ_MESSAGE_OBJECT_DATAGRAM))
  msg.push(numberToVarInt(trackAlias))
  msg.push(numberToVarInt(groupSeq))
  msg.push(numberToVarInt(objSeq))
  msg.push(new Uint8Array([publisherPriority]))
  if (extensionHeaders == undefined || extensionHeaders.length <= 0) {
    msg.push(numberToVarInt(0)); // Extension headers count
  } else {
    msg.push(moqCreateExtensionHeaders(extensionHeaders)); // Extension headers
  }
  if (data != undefined && data.byteLength > 0) {
    msg.push(numberToVarInt(data.byteLength))
    msg.push(data)
  } else {
    msg.push(numberToVarInt(0))
    msg.push(numberToVarInt(MOQ_OBJ_STATUS_NORMAL))
  }

  return concatBuffer(msg);
}

export function moqSendSubgroupHeader (writer, trackAlias, groupSeq, publisherPriority) {
  return moqSendToWriter(writer, moqCreateSubgroupHeaderBytes(trackAlias, groupSeq, publisherPriority))
}

export function moqSendObjectSubgroupToWriter (writer, objSeq, data, extensionHeaders) {
  return moqSendToWriter(writer, moqCreateObjectSubgroupBytes(objSeq, data, extensionHeaders))
}

export function moqSendObjectEndOfGroupToWriter (writer, objSeq, extensionHeaders) {
  return moqSendToWriter(writer, moqCreateObjectEndOfGroupBytes(objSeq, extensionHeaders))
}

export function moqSendObjectPerDatagramToWriter (writer, trackAlias, groupSeq, objSeq, publisherPriority, data, extensionHeaders) {
  return moqSendToWriter(writer, moqCreateObjectPerDatagramBytes(trackAlias, groupSeq, objSeq, publisherPriority, data, extensionHeaders))
}

export async function moqParseObjectHeader (readerStream) {
  const type = await varIntToNumberOrThrow(readerStream)
  if (type !== MOQ_MESSAGE_STREAM_HEADER_SUBGROUP && type != MOQ_MESSAGE_OBJECT_DATAGRAM) {
    throw new Error(`OBJECT answer type must be ${MOQ_MESSAGE_STREAM_HEADER_SUBGROUP} or ${MOQ_MESSAGE_OBJECT_DATAGRAM}, got ${type}`)
  }

  let ret
  if (type == MOQ_MESSAGE_OBJECT_DATAGRAM) {
    const trackAlias = await varIntToNumberOrThrow(readerStream);
    const groupSeq = await varIntToNumberOrThrow(readerStream);
    const objSeq = await varIntToNumberOrThrow(readerStream);
    const publisherPriority = await moqByteReadOrThrow(readerStream);
    const extensionHeaders = await moqReadExtensionHeaders(readerStream)
    const payloadLength = await varIntToNumberOrThrow(readerStream);
    ret = {type, trackAlias, groupSeq, objSeq, publisherPriority, extensionHeaders, payloadLength}
    if (payloadLength == 0) {
      ret.status = await varIntToNumberOrThrow(readerStream)
    }
  }
  else if (type == MOQ_MESSAGE_STREAM_HEADER_SUBGROUP) {
    const trackAlias = await varIntToNumberOrThrow(readerStream)
    const groupSeq = await varIntToNumberOrThrow(readerStream)
    const subGroupSeq = await varIntToNumberOrThrow(readerStream)
    const publisherPriority = await moqByteReadOrThrow(readerStream)
    ret = {type, trackAlias, groupSeq, subGroupSeq, publisherPriority}  
  }
  return ret
}

export async function moqParseObjectFromSubgroupHeader (readerStream) { 
  const objSeq = await varIntToNumberOrThrow(readerStream)
  const extensionHeaders = await moqReadExtensionHeaders(readerStream)
  const payloadLength = await varIntToNumberOrThrow(readerStream)  
  const ret = {objSeq, payloadLength, extensionHeaders}  
  if (payloadLength == 0) {
    ret.status = await varIntToNumberOrThrow(readerStream)
  }
  return ret
}

// Helpers

export function getTrackFullName(namespace, trackName) {
  return namespace + trackName
}

function moqCreateStringBytes (str) {
  const dataStrBytes = new TextEncoder().encode(str)
  const dataStrLengthBytes = numberToVarInt(dataStrBytes.byteLength)
  return concatBuffer([dataStrLengthBytes, dataStrBytes])
}

function moqCreateTupleBytes(arr) {
    const msg = [];
    if (arr.length > MOQ_MAX_TUPLE_PARAMS) {
      throw new Error(`We only support up to ${MOQ_MAX_TUPLE_PARAMS} items in an MOQ tuple`)
    }
    msg.push(numberToVarInt(arr.length));
    for (let i = 0; i < arr.length; i++) {
      msg.push(moqCreateStringBytes(arr[i]));
    }
    return concatBuffer(msg);
}

function moqCreateParamBytes(name, val) {
  const msg = [];
  msg.push(numberToVarInt(name));

  if (typeof val === 'number') {
    const paramDataBytes = numberToVarInt(val);
    msg.push(numberToVarInt(paramDataBytes.byteLength));
    msg.push(paramDataBytes);  
  } else if (typeof val === 'string') {
    msg.push(moqCreateStringBytes(val));
  } else {
    throw new Error("Not supported MOQT param type");
  }
  return concatBuffer(msg);
}

function moqCreateExtensionHeaders(extensionHeaders) {
  const msg = [];
  const lenght = extensionHeaders.length
  msg.push(numberToVarInt(lenght));
  for (let i = 0; i < lenght; i++) {
    const extHeader = extensionHeaders[i]
    if (!('type' in extHeader) || (!('value' in extHeader))) {
      throw new Error(`Malformed externsion header ${JSON.stringify(extHeader)}`)
    }
    if (!MOQ_EXT_HEADERS_SUPPORTED.includes(extHeader.type)) {
      throw new Error(`Unsupported externsion header ${JSON.stringify(extHeader)}`)
    }
    if (extHeader.type % 2 == 0) { // Even are followed by varint
      if (typeof extHeader.value != 'number') {
        throw new Error(`Trying to write an non number as header extension even. ${JSON.stringify(extHeader)}`)
      }
      msg.push(numberToVarInt(extHeader.type));
      msg.push(numberToVarInt(extHeader.value));
    } else { // Odd are followed by length and buffer
      if (!(extHeader.value instanceof Uint8Array) && !(extHeader.value instanceof ArrayBuffer)) {
        throw new Error(`Trying to write an non Uint8Array as header extension odd, only Uint8Array is supported. ${JSON.stringify(extHeader)} (${typeof extHeader.value})}`)
      }
      msg.push(numberToVarInt(extHeader.type));
      msg.push(numberToVarInt(extHeader.value.byteLength));
      msg.push(extHeader.value);
    }
  }
  return concatBuffer(msg);
}

async function moqStringReadOrThrow (readerStream) {
  const size = await varIntToNumberOrThrow(readerStream)
  const ret = await buffRead(readerStream, size)
  if (ret.eof) {
    throw new ReadStreamClosed(`Connection closed while reading data`)
  }
  return new TextDecoder().decode(ret.buff)
}

async function moqByteReadOrThrow (readerStream) {
  const ret = await buffRead(readerStream, 1);
  if (ret.eof) {
    throw new ReadStreamClosed(`Connection closed while reading byte`)
  }
  return new DataView(ret.buff, 0, 1).getUint8();
}

async function moqTupleReadOrThrow (readerStream) {
  const ret = [];
  const size = await varIntToNumberOrThrow(readerStream)
  let i = 0;
  while (i < size) {
    const element = await moqStringReadOrThrow(readerStream);
    ret.push(element);
    i++;
  }
  return ret;
}

async function moqSend (writerStream, dataBytes) {
  const writer = writerStream.getWriter()
  moqSendToWriter(writer, dataBytes)
  await writer.ready
  writer.releaseLock()
}

async function moqReadSetupParameters (readerStream) {
  const ret = {}
  
  // Params
  const numParams = await varIntToNumberOrThrow(readerStream)
  if (numParams > MOQ_MAX_PARAMS) {
    throw new Error(`exceeded the max number of supported params ${MOQ_MAX_PARAMS}, got ${numParams}`)
  }
  for (let i = 0; i < numParams; i++) {
    const paramId = await varIntToNumberOrThrow(readerStream)
    if (paramId === MOQ_SETUP_PARAMETER_MAX_SUBSCRIBE_ID) {
      await varIntToNumberOrThrow(readerStream) // Length (we should remove it)
      ret.maxSubscribeId = await varIntToNumberOrThrow(readerStream)
    } else if (paramId === MOQ_SETUP_PARAMETER_PATH) {
      ret.path = await moqStringReadOrThrow(readerStream)
    } else {
      const paramLength = await varIntToNumberOrThrow(readerStream)
      const retSkip = await buffRead(readerStream, paramLength)
      ret[`unknown-${i}-${paramId}-${paramLength}`] = JSON.stringify(retSkip.buff)
    }
  }
  return ret 
}

async function moqReadParameters (readerStream) {
  const ret = {}
  // Params
  const numParams = await varIntToNumberOrThrow(readerStream)
  if (numParams > MOQ_MAX_PARAMS) {
    throw new Error(`exceeded the max number of supported params ${MOQ_MAX_PARAMS}, got ${numParams}`)
  }
  for (let i = 0; i < numParams; i++) {
    const paramId = await varIntToNumberOrThrow(readerStream)
    if (paramId === MOQ_PARAMETER_AUTHORIZATION_INFO) {
      ret.authInfo = await moqStringReadOrThrow(readerStream)
    } else if (paramId === MOQ_PARAMETER_DELIVERY_TIMEOUT) {
      await varIntToNumberOrThrow(readerStream) // Length (we should remove it)
      ret.deliveryTimeout = await varIntToNumberOrThrow(readerStream)
    } else if (paramId === MOQ_PARAMETER_MAX_CACHE_DURATION) {
      await varIntToNumberOrThrow(readerStream) // Length (we should remove it)
      ret.maxCacheDuration = await varIntToNumberOrThrow(readerStream)
    } else {
      const paramLength = await varIntToNumberOrThrow(readerStream)
      const retSkip = await buffRead(readerStream, paramLength)
      ret[`unknown-${i}-${paramId}-${paramLength}`] = JSON.stringify(retSkip.buff)
    }
  }
  return ret
}

async function moqReadExtensionHeaders(readerStream) {
  const ret = []
  const count = await varIntToNumberOrThrow(readerStream)
  for (let i = 0; i < count; i++) {
    const extHeaderType = await varIntToNumberOrThrow(readerStream)
    if (!MOQ_EXT_HEADERS_SUPPORTED.includes(extHeaderType)) {
      throw new Error(`Unsupported externsion header type ${extHeaderType}`)
    }
    if (extHeaderType % 2 == 0) { // Even are followed by varint
      const intValue = await varIntToNumberOrThrow(readerStream)
      ret.push({type: extHeaderType, value: intValue})
    } else { // Odd are followed by length and buffer
      const size = await varIntToNumberOrThrow(readerStream)
      const buffRet = await buffRead(readerStream, size)
      if (buffRet.eof) {
        throw new ReadStreamClosed(`Connection closed while reading data`)
      }
      ret.push({ type: extHeaderType, value: buffRet.buff})      
    }
  }
  return ret
}

async function moqSendToWriter (writer, dataBytes) {
  writer.write(dataBytes)
}

// Helpers

export function getFullTrackName(ns, name) {
  return `[${ns.join("/")}]/${name}`
}