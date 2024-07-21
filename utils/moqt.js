/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import { numberToVarInt, varIntToNumberOrThrow } from './varint.js'
import { concatBuffer, buffRead, ReadStreamClosed } from './buffer_utils.js'

// MOQ definitions
// https://datatracker.ietf.org/doc/draft-ietf-moq-transport/
export const MOQ_DRAFT01_VERSION = 0xff000001
export const MOQ_DRAFT02_VERSION = 0xff000002
export const MOQ_DRAFT03_VERSION = 0xff000003
export const MOQ_DRAFT04_VERSION = 0xff000004
export const MOQ_CURRENT_VERSION = MOQ_DRAFT04_VERSION
export const MOQ_SUPPORTED_VERSIONS = [MOQ_CURRENT_VERSION]

export const MOQ_PARAMETER_ROLE = 0x0
export const MOQ_PARAMETER_AUTHORIZATION_INFO = 0x2

export const MOQ_MAX_PARAMS = 256
export const MOQ_MAX_ARRAY_LENGTH = 1024

export const MOQ_PARAMETER_ROLE_INVALID = 0x0
export const MOQ_PARAMETER_ROLE_PUBLISHER = 0x1
export const MOQ_PARAMETER_ROLE_SUBSCRIBER = 0x2
export const MOQ_PARAMETER_ROLE_BOTH = 0x3

// Location modes
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

// MOQ messages
export const MOQ_MESSAGE_OBJECT_STREAM = 0x0
export const MOQ_MESSAGE_OBJECT_DATAGRAM = 0x1
export const MOQ_MESSAGE_STREAM_HEADER_TRACK = 0x50
export const MOQ_MESSAGE_STREAM_HEADER_GROUP = 0x51

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

// MOQ - QUIC mapping
export const MOQ_MAPPING_OBJECT_PER_STREAM = "ObjPerStream"
export const MOQ_MAPPING_OBJECT_PER_DATAGRAM = "ObjPerDatagram"
export const MOQ_MAPPING_TRACK_PER_STREAM = "TrackPerStream"
export const MOQ_MAPPING_GROUP_PER_STREAM = "GroupPerStream"

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

export async function moqClose (moqt) {
  const multiWritterClosePromises = []
  for (const multiWritter of Object.values(moqt.multiObjectWritter)) {
    multiWritterClosePromises.push(multiWritter.close())
  } 
  if (multiWritterClosePromises.length > 0) {
    await Promise.all(multiWritterClosePromises)
  }
  moqt.multiObjectWritter = {}

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

function moqCreateSetupMessageBytes (moqIntRole) {
  // TODO moqSuggestion: Should we have a SETUP error
  
  // Message type
  const messageTypeBytes = numberToVarInt(MOQ_MESSAGE_CLIENT_SETUP)
  // Version length
  const versionLengthBytes = numberToVarInt(1)
  // Version[0]
  const versionBytes = numberToVarInt(MOQ_CURRENT_VERSION)
  // Number of parameters
  const numberOfParamsBytes = numberToVarInt(1)
  // param[0]: Role-Publisher
  const roleParamIdBytes = numberToVarInt(MOQ_PARAMETER_ROLE)
  // param[0]: Length
  // param[0]: Role value
  const roleParamDataBytes = numberToVarInt(moqIntRole)
  const roleParamRoleLengthBytes = numberToVarInt(roleParamDataBytes.byteLength)

  return concatBuffer([messageTypeBytes, versionLengthBytes, versionBytes, numberOfParamsBytes, roleParamIdBytes, roleParamRoleLengthBytes, roleParamDataBytes])
}

export async function moqSendSetup (writerStream, moqIntRole) {
  return moqSend(writerStream, moqCreateSetupMessageBytes(moqIntRole))
}

async function moqParseSetupResponse (readerStream) {
  const ret = { }
  ret.version = await varIntToNumberOrThrow(readerStream)
  if (!MOQ_SUPPORTED_VERSIONS.includes(ret.version)) {
    throw new Error(`version sent from server NOT supported. Supported versions ${JSON.stringify(MOQ_SUPPORTED_VERSIONS)}, got from server ${JSON.stringify(MOQ_SUPPORTED_VERSIONS)}`)
  }
  ret.parameters = await moqReadParameters(readerStream)

  return ret
}

// ANNOUNCE

function moqCreateAnnounceMessageBytes (namespace, authInfo) {
  // Message type
  const messageTypeBytes = numberToVarInt(MOQ_MESSAGE_ANNOUNCE)

  // Namespace
  const namespaceBytes = moqCreateStringBytes(namespace)

  // Number of parameters
  const numberOfParamsBytes = numberToVarInt(1)

  // param[0]: authinfo
  const authInfoIdBytes = numberToVarInt(MOQ_PARAMETER_AUTHORIZATION_INFO)
  // param[0]: authinfo value
  const authInfoBytes = moqCreateStringBytes(authInfo)

  return concatBuffer([messageTypeBytes, namespaceBytes, numberOfParamsBytes, authInfoIdBytes, authInfoBytes])
}

export async function moqSendAnnounce (writerStream, namespace, authInfo) {
  return moqSend(writerStream, moqCreateAnnounceMessageBytes(namespace, authInfo))
}

async function moqParseAnnounceOk (readerStream) {
  const ret = { }
  
  ret.namespace = await moqStringReadOrThrow(readerStream)
  
  return ret
}

async function moqParseAnnounceError (readerStream) {
  const ret = { }

  ret.namespace = await moqStringReadOrThrow(readerStream)
  ret.errorCode = await numberToVarInt(readerStream)
  ret.reason = await moqStringReadOrThrow(readerStream)
  
  return ret
}

// UNANNOUNCE

function moqCreateUnAnnounceMessageBytes (namespace) {
  // Message type
  const messageTypeBytes = numberToVarInt(MOQ_MESSAGE_UNANNOUNCE)

  // Namespace
  const namespaceBytes = moqCreateStringBytes(namespace)

  return concatBuffer([messageTypeBytes, namespaceBytes])
}

export async function moqSendUnAnnounce (writerStream, namespace) {
  return moqSend(writerStream, moqCreateUnAnnounceMessageBytes(namespace))
}


// SUBSCRIBE
// Always subscribe from start next group

function moqCreateSubscribeMessageBytes(subscribeId, trackAlias, trackNamespace, trackName, authInfo) {
  // Message type
  const messageTypeBytes = numberToVarInt(MOQ_MESSAGE_SUBSCRIBE)

  // SubscribeID(i)
  // Unique within the session. Subscribe ID is a monotonically increasing variable length integer which MUST not be reused within a session
  const subscribeIDBytes = numberToVarInt(subscribeId)
  
  // Track Alias (i)
  // A session specific identifier for the track. Messages that reference a track, such as OBJECT, reference this Track Alias instead of the Track Name and Track Namespace to reduce overhead
  const trackAliasBytes = numberToVarInt(trackAlias)

  // Track namespace
  const trackNamespaceBytes = moqCreateStringBytes(trackNamespace)

  // Track name
  const trackNameBytes = moqCreateStringBytes(trackName)

  // Filter type (request latest object)
  const filterTypeBytes = numberToVarInt(MOQ_FILTER_TYPE_LATEST_OBJ)

  // Params
  // Number of parameters
  const numberOfParamsBytes = numberToVarInt(1)
  // param[0]: auth info id
  const authInfoParamIdBytes = numberToVarInt(MOQ_PARAMETER_AUTHORIZATION_INFO)
  // param[0]: length + auth info
  const authInfoBytes = moqCreateStringBytes(authInfo)

  return concatBuffer([messageTypeBytes, subscribeIDBytes, trackAliasBytes, trackNamespaceBytes, trackNameBytes, filterTypeBytes, numberOfParamsBytes, authInfoParamIdBytes, authInfoBytes])
}

// SUBSCRIBE OK

function moqCreateSubscribeOkMessageBytes (subscribeId, expiresMs, lastGroupSent, lastObjSent) {
  // Message type
  const messageTypeBytes = numberToVarInt(MOQ_MESSAGE_SUBSCRIBE_OK)

  // Subscribe Id
  const subscribeIdBytes = numberToVarInt(subscribeId)
  // Expires MS
  const expiresMsBytes = numberToVarInt(expiresMs)

  let lastGroupSentBytes = new Uint8Array([]);
  let lastObjSentBytes = new Uint8Array([]);
  let contentExistsBytes = new Uint8Array([0]);
  if (lastGroupSent != undefined && lastObjSent != undefined) {
    // Content exists
    contentExistsBytes = new Uint8Array([1]);
    // Final group
    lastGroupSentBytes = numberToVarInt(lastGroupSent)
    // Final object
    lastObjSentBytes = numberToVarInt(lastObjSent)
  }

  return concatBuffer([messageTypeBytes, subscribeIdBytes, expiresMsBytes, contentExistsBytes, lastGroupSentBytes, lastObjSentBytes])
}

// SUBSCRIBE ERROR

function moqCreateSubscribeErrorMessageBytes (subscribeId, errorCode, reason, trackAlias) {
  // Message type
  const messageTypeBytes = numberToVarInt(MOQ_MESSAGE_SUBSCRIBE_ERROR)

  // Subscribe Id
  const subscribeIdBytes = numberToVarInt(subscribeId)
  // errorCode
  const errorCodeBytes = numberToVarInt(errorCode)
  // Reason
  const reasonBytes = moqCreateStringBytes(reason)
  // trackAlias
  const trackAliasBytes = numberToVarInt(trackAlias)

  return concatBuffer([messageTypeBytes, subscribeIdBytes, errorCodeBytes, reasonBytes, trackAliasBytes])
}

// UNSUBSCRIBE

function moqCreateUnSubscribeMessageBytes (subscribeId) {
  // Message type
  const messageTypeBytes = numberToVarInt(MOQ_MESSAGE_UNSUBSCRIBE)

  // Subscribe Id
  const subscribeIdBytes = numberToVarInt(subscribeId)

  return concatBuffer([messageTypeBytes, subscribeIdBytes])
}

// SUBSCRIBE DONE

function moqCreateSubscribeDoneMessageBytes(subscribeId, errorCode, reason, lastGroupSent, lastObjSent) {
  // Message type
  const messageTypeBytes = numberToVarInt(MOQ_MESSAGE_SUBSCRIBE_DONE)

  // Subscribe Id
  const subscribeIdBytes = numberToVarInt(subscribeId)
  // errorCode
  const errorCodeBytes = numberToVarInt(errorCode)
  // Reason
  const reasonBytes = moqCreateStringBytes(reason)

  let lastGroupSentBytes = new Uint8Array([]);
  let lastObjSentBytes = new Uint8Array([]);
  let contentExistsBytes = new Uint8Array([0]);
  if (lastGroupSent != undefined && lastObjSent != undefined) {
    // Content exists
    contentExistsBytes = new Uint8Array([1]);
    // Final group
    lastGroupSentBytes = numberToVarInt(lastGroupSent)
    // Final object
    lastObjSentBytes = numberToVarInt(lastObjSent)
  }

  return concatBuffer([messageTypeBytes, subscribeIdBytes, errorCodeBytes, reasonBytes, contentExistsBytes, lastGroupSentBytes, lastObjSentBytes])
}

export async function moqSendSubscribe (writerStream, subscribeId, trackAlias, trackNamespace, trackName, authInfo) {
  return moqSend(writerStream, moqCreateSubscribeMessageBytes(subscribeId, trackAlias, trackNamespace, trackName, authInfo))
}

export async function moqSendUnSubscribe (writerStream, subscribeId) {
  return moqSend(writerStream, moqCreateUnSubscribeMessageBytes(subscribeId))
}

async function moqParseSubscribeOk (readerStream) {
  const ret = { }

  ret.subscribeId = await varIntToNumberOrThrow(readerStream)
  ret.expires = await varIntToNumberOrThrow(readerStream)
  const contentExists =  await varIntToNumberOrThrow(readerStream)
  if (contentExists > 0) {
    ret.lastGroupSent = await varIntToNumberOrThrow(readerStream)
    ret.lastObjSent = await varIntToNumberOrThrow(readerStream)
  }
  return ret
}

async function moqParseSubscribeError (readerStream) {
  const ret = { }

  ret.subscribeId = await varIntToNumberOrThrow(readerStream)
  ret.errorCode = await varIntToNumberOrThrow(readerStream)
  ret.errorReason = await moqStringReadOrThrow(readerStream)
  ret.trackAlias = await varIntToNumberOrThrow(readerStream)

  return ret
}

async function moqParseSubscribeDone (readerStream) {
  const ret = { }
  ret.subscribeId = await varIntToNumberOrThrow(readerStream)
  ret.errorCode = await varIntToNumberOrThrow(readerStream)
  ret.errorReason = await moqStringReadOrThrow(readerStream)
  const retContentExists = await buffRead(readerStream, 1)
  const contentExists = retContentExists.buff
  if (new DataView(contentExists, 0, 1).getUint8() > 0) {
    ret.lastGroupSent = await varIntToNumberOrThrow(readerStream)
    ret.lastObjSent = await varIntToNumberOrThrow(readerStream)
  }
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

async function moqParseSubscribe (readerStream) {
  const ret = { }
  
  ret.subscribeId = await varIntToNumberOrThrow(readerStream)
  ret.trackAlias = await varIntToNumberOrThrow(readerStream)
  ret.namespace = await moqStringReadOrThrow(readerStream)
  ret.trackName = await moqStringReadOrThrow(readerStream)

  ret.filterType = await varIntToNumberOrThrow(readerStream)

  if (ret.filterType === MOQ_FILTER_TYPE_ABSOLUTE_START || ret.filterType === MOQ_FILTER_TYPE_ABSOLUTE_RANGE) {
    ret.startGroup = await varIntToNumberOrThrow(readerStream)
    if (ret.startGroup !== MOQ_LOCATION_MODE_NONE) {
      await varIntToNumberOrThrow(readerStream)
      // TODO: Do not start sending until this position
    }
    // Start object
    ret.startObject = await varIntToNumberOrThrow(readerStream)
    if (ret.startObject !== MOQ_LOCATION_MODE_NONE) {
      await varIntToNumberOrThrow(readerStream)
      // TODO: Do not start sending until this position
    }
  }
  if (ret.filterType === MOQ_FILTER_TYPE_ABSOLUTE_RANGE) {
    ret.endGroup = await varIntToNumberOrThrow(readerStream)
    if (ret.endGroup !== MOQ_LOCATION_MODE_NONE) {
      await varIntToNumberOrThrow(readerStream)
      // TODO: Stop sending if NO subscribers after this position
    }
    ret.endObject = await varIntToNumberOrThrow(readerStream)
    if (ret.endObject !== MOQ_LOCATION_MODE_NONE) {
      await varIntToNumberOrThrow(readerStream)
      // TODO: Stop sending if NO subscribers after this position
    }    
  }

  ret.parameters = await moqReadParameters(readerStream)

  return ret
}

async function moqParseUnSubscribe (readerStream) {
  const ret = { }
  
  // SubscribeId
  ret.subscribeId = await varIntToNumberOrThrow(readerStream)

  return ret
}

export async function moqSendSubscribeOk (writerStream, subscribeId, expiresMs, lastGroupSent, lastObjSent) {
  return moqSend(writerStream, moqCreateSubscribeOkMessageBytes(subscribeId, expiresMs, lastGroupSent, lastObjSent))
}

export async function moqSendSubscribeError (writerStream, subscribeId, errorCode, reason, trackAlias) {
  return moqSend(writerStream, moqCreateSubscribeErrorMessageBytes(subscribeId, errorCode, reason, trackAlias))
}

export async function moqSendSubscribeDone(writerStream, subscribeId, errorCode, reason, lastGroupSent, lastObjSent) {
  return moqSend(writerStream, moqCreateSubscribeDoneMessageBytes(subscribeId, errorCode, reason, lastGroupSent, lastObjSent))
}

// OBJECT

function moqCreateObjectPerStreamBytes (subscribeId, trackAlias, groupSeq, objSeq, sendOrder, data) {
  // Message type
  const messageTypeBytes = numberToVarInt(MOQ_MESSAGE_OBJECT_STREAM)
  const subscribeIdBytes = numberToVarInt(subscribeId)
  const trackAliasBytes = numberToVarInt(trackAlias)
  const groupSeqBytes = numberToVarInt(groupSeq)
  const objSeqBytes = numberToVarInt(objSeq)
  const sendOrderBytes = numberToVarInt(sendOrder)
  const statusBytes = numberToVarInt(0)

  return concatBuffer([messageTypeBytes, subscribeIdBytes, trackAliasBytes, groupSeqBytes, objSeqBytes, sendOrderBytes, statusBytes, data])
}

function moqCreateObjectPerDatagramBytes (subscribeId, trackAlias, groupSeq, objSeq, sendOrder, data) {
  // Message type
  const messageTypeBytes = numberToVarInt(MOQ_MESSAGE_OBJECT_DATAGRAM)
  const subscribeIdBytes = numberToVarInt(subscribeId)
  const trackAliasBytes = numberToVarInt(trackAlias)
  const groupSeqBytes = numberToVarInt(groupSeq)
  const objSeqBytes = numberToVarInt(objSeq)
  const sendOrderBytes = numberToVarInt(sendOrder)
  const statusBytes = numberToVarInt(0)

  return concatBuffer([messageTypeBytes, subscribeIdBytes, trackAliasBytes, groupSeqBytes, objSeqBytes, sendOrderBytes, statusBytes, data])
}

function moqCreateTrackPerStreamHeaderBytes (subscribeId, trackAlias, sendOrder) {
  // Message type
  const messageTypeBytes = numberToVarInt(MOQ_MESSAGE_STREAM_HEADER_TRACK)
  const subscribeIdBytes = numberToVarInt(subscribeId)
  const trackAliasBytes = numberToVarInt(trackAlias)
  const sendOrderBytes = numberToVarInt(sendOrder)

  return concatBuffer([messageTypeBytes, subscribeIdBytes, trackAliasBytes, sendOrderBytes])
}

function moqCreateGroupPerStreamHeaderBytes (subscribeId, trackAlias, groupSeq, sendOrder) {
  // Message type
  const messageTypeBytes = numberToVarInt(MOQ_MESSAGE_STREAM_HEADER_GROUP)
  const subscribeIdBytes = numberToVarInt(subscribeId)
  const trackAliasBytes = numberToVarInt(trackAlias)
  const groupSeqBytes = numberToVarInt(groupSeq)
  const sendOrderBytes = numberToVarInt(sendOrder)

  return concatBuffer([messageTypeBytes, subscribeIdBytes, trackAliasBytes, groupSeqBytes, sendOrderBytes])
}

function moqCreateTrackPerStreamBytes (groupSeq, objSeq, data) {
  // No message type
  const groupSeqBytes = numberToVarInt(groupSeq)
  const objSeqBytes = numberToVarInt(objSeq)
  let payLoadLengthBytes = numberToVarInt(0)
  let statusBytes = new Uint8Array([]);
  if (data == undefined || data == null || data.byteLength == 0) {
    statusBytes = numberToVarInt(0)
  } else {
    payLoadLengthBytes = numberToVarInt(data.byteLength)
  }
  return concatBuffer([groupSeqBytes, objSeqBytes, payLoadLengthBytes, statusBytes, data])
}

function moqCreateGroupPerStreamBytes (objSeq, data) {
  // No message type
  const objSeqBytes = numberToVarInt(objSeq)
  let payLoadLengthBytes = numberToVarInt(0)
  let statusBytes = new Uint8Array([]);
  if (data == undefined || data == null || data.byteLength == 0) {
    statusBytes = numberToVarInt(0)
  } else {
    payLoadLengthBytes = numberToVarInt(data.byteLength)
  }
  return concatBuffer([objSeqBytes, payLoadLengthBytes, statusBytes, data])
}

export function moqSendObjectPerStreamToWriter (writer, subscribeId, trackAlias, groupSeq, objSeq, sendOrder, data) {
  return moqSendToWriter(writer, moqCreateObjectPerStreamBytes(subscribeId, trackAlias, groupSeq, objSeq, sendOrder, data))
}

export function moqSendObjectPerDatagramToWriter (writer, subscribeId, trackAlias, groupSeq, objSeq, sendOrder, data) {
  return moqSendToWriter(writer, moqCreateObjectPerDatagramBytes(subscribeId, trackAlias, groupSeq, objSeq, sendOrder, data))
}

export async function moqParseObjectHeader (readerStream) {
  const type = await varIntToNumberOrThrow(readerStream)
  if (type !== MOQ_MESSAGE_OBJECT_STREAM && type != MOQ_MESSAGE_STREAM_HEADER_TRACK && type != MOQ_MESSAGE_STREAM_HEADER_GROUP && type != MOQ_MESSAGE_OBJECT_DATAGRAM) {
    throw new Error(`OBJECT answer type must be ${MOQ_MESSAGE_OBJECT_STREAM} or ${MOQ_MESSAGE_STREAM_HEADER_TRACK} or ${MOQ_MESSAGE_OBJECT_DATAGRAM}, got ${type}`)
  }

  let ret
  if (type == MOQ_MESSAGE_OBJECT_STREAM || type == MOQ_MESSAGE_OBJECT_DATAGRAM) {
    const subscribeId = await varIntToNumberOrThrow(readerStream)
    const trackAlias = await varIntToNumberOrThrow(readerStream)
    const groupSeq = await varIntToNumberOrThrow(readerStream)
    const objSeq = await varIntToNumberOrThrow(readerStream)
    const sendOrder = await varIntToNumberOrThrow(readerStream)
    const status = await varIntToNumberOrThrow(readerStream)
    ret = {type, subscribeId, trackAlias, groupSeq, objSeq, sendOrder, status}  
  }
  else if (type == MOQ_MESSAGE_STREAM_HEADER_TRACK) {
    const subscribeId = await varIntToNumberOrThrow(readerStream)
    const trackAlias = await varIntToNumberOrThrow(readerStream)
    const sendOrder = await varIntToNumberOrThrow(readerStream)
    ret = {type, subscribeId, trackAlias, sendOrder}  
  } else if (MOQ_MESSAGE_STREAM_HEADER_GROUP) {
    const subscribeId = await varIntToNumberOrThrow(readerStream)
    const trackAlias = await varIntToNumberOrThrow(readerStream)
    const groupSeq = await varIntToNumberOrThrow(readerStream)
    const sendOrder = await varIntToNumberOrThrow(readerStream)
    ret = {type, subscribeId, trackAlias, groupSeq, sendOrder}  
  }
  return ret
}

export async function moqParseObjectFromTrackPerStreamHeader (readerStream) { 
  const groupSeq = await varIntToNumberOrThrow(readerStream)
  const objSeq = await varIntToNumberOrThrow(readerStream)
  const payloadLength = await varIntToNumberOrThrow(readerStream)  
  const ret = {groupSeq, objSeq, payloadLength}  
  if (payloadLength === 0) {
    ret.status = await varIntToNumberOrThrow(readerStream)
  }
  return ret
}

export async function moqParseObjectFromGroupPerStreamHeader (readerStream) { 
  const objSeq = await varIntToNumberOrThrow(readerStream)
  const payloadLength = await varIntToNumberOrThrow(readerStream)  
  const ret = {objSeq, payloadLength}  
  if (payloadLength === 0) {
    ret.status = await varIntToNumberOrThrow(readerStream)
  }
  return ret
}

export function moqSendTrackPerStreamHeader (writer, subscribeId, trackAlias, sendOrder) {
  return moqSendToWriter(writer, moqCreateTrackPerStreamHeaderBytes(subscribeId, trackAlias, sendOrder))
}

export function moqSendTrackPerStreamToWriter (writer, groupSeq, objSeq, data) {
  return moqSendToWriter(writer, moqCreateTrackPerStreamBytes(groupSeq, objSeq, data))
}

export function moqSendGroupPerStreamHeader (writer, subscribeId, trackAlias, groupSeq, sendOrder) {
  return moqSendToWriter(writer, moqCreateGroupPerStreamHeaderBytes(subscribeId, trackAlias, groupSeq, sendOrder))
}

export function moqSendGroupPerStreamToWriter (writer, objSeq, data) {
  return moqSendToWriter(writer, moqCreateGroupPerStreamBytes(objSeq, data))
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

async function moqStringReadOrThrow (readerStream) {
  const size = await varIntToNumberOrThrow(readerStream)
  const ret = await buffRead(readerStream, size)
  if (ret.eof) {
    throw new ReadStreamClosed(`Connection closed while reading data`)
  }
  return new TextDecoder().decode(ret.buff)
}

async function moqSend (writerStream, dataBytes) {
  const writer = writerStream.getWriter()
  moqSendToWriter(writer, dataBytes)
  await writer.ready
  writer.releaseLock()
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
    } else if (paramId === MOQ_PARAMETER_ROLE) {
      await varIntToNumberOrThrow(readerStream)
      ret.role = await varIntToNumberOrThrow(readerStream)
    } else {
      const paramLength = await varIntToNumberOrThrow(readerStream)
      const retSkip = await buffRead(readerStream, paramLength)
      ret[`unknown-${i}-${paramId}-${paramLength}`] = JSON.stringify(retSkip.buff)
    }
  }
  return ret
}

async function moqSendToWriter (writer, dataBytes) {
  writer.write(dataBytes)
}
