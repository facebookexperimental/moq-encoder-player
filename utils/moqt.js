/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import { numberToVarInt, varIntToNumber } from './varint.js'
import { concatBuffer, buffRead } from './buffer_utils.js'

// MOQ definitions
// https://datatracker.ietf.org/doc/draft-ietf-moq-transport/
export const MOQ_DRAFT01_VERSION = 0xff000001
export const MOQ_SUPPORTED_VERSIONS = [MOQ_DRAFT01_VERSION]

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

// MOQ messages
const MOQ_MESSAGE_OBJECT = 0x0
const MOQ_MESSAGE_OBJECT_WITH_LENGTH = 0x2
const MOQ_MESSAGE_CLIENT_SETUP = 0x40
const MOQ_MESSAGE_SERVER_SETUP = 0x41

const MOQ_MESSAGE_SUBSCRIBE = 0x3
const MOQ_MESSAGE_SUBSCRIBE_OK = 0x4

const MOQ_MESSAGE_ANNOUNCE = 0x6
const MOQ_MESSAGE_ANNOUNCE_OK = 0x7
// const MOQ_MESSAGE_ANNOUNCE_ERROR = 0x8
// const MOQ_MESSAGE_UNANNOUNCE = 0x9

export function moqCreate () {
  return {
    wt: null,

    controlStream: null,
    controlWriter: null,
    controlReader: null
  }
}

export async function moqClose (moqt) {
  if (moqt.controlWriter != null) {
    await moqt.controlWriter.close()
    moqt.controlWriter = null
  }
  if (moqt.wt != null) {
    await moqt.wt.close()
    moqt.wt = null
  }
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
  // TODO moqBug: In the draft the use of varint is NOT clear AT ALL
  // TODO moqBug: Should we have a SETUP error
  // TODO moqComment: Adding a examples would be great: Coding and call flow

  // Message type
  const messageTypeBytes = numberToVarInt(MOQ_MESSAGE_CLIENT_SETUP)
  // Version length
  const versionLengthBytes = numberToVarInt(1)
  // Version[0]
  const versionBytes = numberToVarInt(MOQ_DRAFT01_VERSION)
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

export async function moqParseSetupResponse (readerStream) {
  const ret = { version: 0, parameters: null }
  const type = await varIntToNumber(readerStream)
  if (type !== MOQ_MESSAGE_SERVER_SETUP) {
    throw new Error(`SETUP answer type must be ${MOQ_MESSAGE_SERVER_SETUP}, got ${type}`)
  }
  ret.version = await varIntToNumber(readerStream)
  if (!MOQ_SUPPORTED_VERSIONS.includes(ret.version)) {
    throw new Error(`version sent from server NOT supported. Supported versions ${JSON.stringify(MOQ_SUPPORTED_VERSIONS)}, got from server ${JSON.stringify(MOQ_SUPPORTED_VERSIONS)}`)
  }

  ret.parameters = await mpqReadParameters(readerStream)

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
  // TODO moqComment: It says ASCII (should we default all strings to UTF-8?)
  const authInfoBytes = moqCreateStringBytes(authInfo)

  return concatBuffer([messageTypeBytes, namespaceBytes, numberOfParamsBytes, authInfoIdBytes, authInfoBytes])
}

export async function moqSendAnnounce (writerStream, namespace, authInfo) {
  return moqSend(writerStream, moqCreateAnnounceMessageBytes(namespace, authInfo))
}

export async function moqParseAnnounceResponse (readerStream) {
  const type = await varIntToNumber(readerStream)
  if (type !== MOQ_MESSAGE_ANNOUNCE_OK) {
    throw new Error(`ANNOUNCE answer type must be ${MOQ_MESSAGE_ANNOUNCE_OK}, got ${type}`)
  }

  // Track namespace
  const namespace = await moqStringRead(readerStream)

  return { namespace }
}

// SUBSCRIBE
// Always subscribe from start next group

function moqCreateSubscribeMessageBytes (trackNamespace, trackName, authInfo) {
  // Message type
  const messageTypeBytes = numberToVarInt(MOQ_MESSAGE_SUBSCRIBE)

  // Track namespace
  const trackNamespaceBytes = moqCreateStringBytes(trackNamespace)

  // Track name
  const trackNameBytes = moqCreateStringBytes(trackName)

  // Start group
  const startGroupBytesMode = numberToVarInt(MOQ_LOCATION_MODE_RELATIVE_NEXT)
  const startGroupBytesValue = numberToVarInt(0)
  // Start object
  const startObjectBytesMode = numberToVarInt(MOQ_LOCATION_MODE_ABSOLUTE)
  const startObjectBytesValue = numberToVarInt(0)
  // End group
  const endGroupBytesMode = numberToVarInt(MOQ_LOCATION_MODE_NONE)
  // End object
  const endObjectBytesMode = numberToVarInt(MOQ_LOCATION_MODE_NONE)

  // Params
  // Number of parameters
  const numberOfParamsBytes = numberToVarInt(1)
  // param[0]: auth info id
  const authInfoParamIdBytes = numberToVarInt(MOQ_PARAMETER_AUTHORIZATION_INFO)
  // param[0]: length + auth info
  const authInfoBytes = moqCreateStringBytes(authInfo)

  return concatBuffer([messageTypeBytes, trackNamespaceBytes, trackNameBytes, startGroupBytesMode, startGroupBytesValue, startObjectBytesMode, startObjectBytesValue, endGroupBytesMode, endObjectBytesMode, numberOfParamsBytes, authInfoParamIdBytes, authInfoBytes])
}

function moqCreateSubscribeResponseMessageBytes (namespace, trackName, trackId, expiresMs) {
  // Message type
  const messageTypeBytes = numberToVarInt(MOQ_MESSAGE_SUBSCRIBE_OK)

  // Track namespace
  const trackNamespaceBytes = moqCreateStringBytes(namespace)
  // Track name
  const trackNameBytes = moqCreateStringBytes(trackName)
  // Track id
  const trackIdBytes = numberToVarInt(trackId)
  // Expires MS
  const expiresMsBytes = numberToVarInt(expiresMs)

  return concatBuffer([messageTypeBytes, trackNamespaceBytes, trackNameBytes, trackIdBytes, expiresMsBytes])
}

export async function moqSendSubscribe (writerStream, trackNamespace, trackName, authInfo) {
  return moqSend(writerStream, moqCreateSubscribeMessageBytes(trackNamespace, trackName, authInfo))
}

export async function moqParseSubscribeResponse (readerStream) {
  const ret = { namespace: '', trackName: '', trackId: -1, expires: -1 }
  const type = await varIntToNumber(readerStream)
  if (type !== MOQ_MESSAGE_SUBSCRIBE_OK) {
    throw new Error(`SUBSCRIBE answer type must be ${MOQ_MESSAGE_SUBSCRIBE_OK}, got ${type}`)
  }

  // Track namespace
  ret.namespace = await moqStringRead(readerStream)
  // Track name
  ret.trackName = await moqStringRead(readerStream)
  // Track Id
  ret.trackId = await varIntToNumber(readerStream)
  // Expires
  ret.expires = await varIntToNumber(readerStream)

  return ret
}

export async function moqParseSubscribe (readerStream) {
  const ret = { namespace: '', trackName: '', startGroup: -1, startObject: -1, endGroup: -1, endObject: -1, parameters: null }
  const type = await varIntToNumber(readerStream)
  if (type !== MOQ_MESSAGE_SUBSCRIBE) {
    throw new Error(`SUBSCRIBE type must be ${MOQ_MESSAGE_SUBSCRIBE}, got ${type}`)
  }

  // Track namespace
  ret.namespace = await moqStringRead(readerStream)

  // Track name
  ret.trackName = await moqStringRead(readerStream)

  // Start group
  ret.startGroup = await varIntToNumber(readerStream)
  if (ret.startGroup !== MOQ_LOCATION_MODE_NONE) {
    await varIntToNumber(readerStream)
    // TODO: Do not start sending until this position
  }

  // Start object
  ret.startObject = await varIntToNumber(readerStream)
  if (ret.startObject !== MOQ_LOCATION_MODE_NONE) {
    await varIntToNumber(readerStream)
    // TODO: Do not start sending until this position
  }

  // End group
  ret.endGroup = await varIntToNumber(readerStream)
  if (ret.endGroup !== MOQ_LOCATION_MODE_NONE) {
    await varIntToNumber(readerStream)
    // TODO: Stop sending if NO subscribers after this position
  }

  // End object
  ret.endObject = await varIntToNumber(readerStream)
  if (ret.endObject !== MOQ_LOCATION_MODE_NONE) {
    await varIntToNumber(readerStream)
    // TODO: Stop sending if NO subscribers after this position
  }

  ret.parameters = await mpqReadParameters(readerStream)

  return ret
}

export async function moqSendSubscribeResponse (writerStream, namespace, trackName, trackId, expiresMs) {
  return moqSend(writerStream, moqCreateSubscribeResponseMessageBytes(namespace, trackName, trackId, expiresMs))
}

// OBJECT
// TODO: Send also objects with length, only useful if I put more than one in a quic stream

function moqCreateObjectBytes (trackId, groupSeq, objSeq, sendOrder, data) {
  // Message type
  const messageTypeBytes = numberToVarInt(MOQ_MESSAGE_OBJECT)
  const trackIdBytes = numberToVarInt(trackId)
  const groupSeqBytes = numberToVarInt(groupSeq)
  const objSeqBytes = numberToVarInt(objSeq)
  const sendOrderBytes = numberToVarInt(sendOrder)

  return concatBuffer([messageTypeBytes, trackIdBytes, groupSeqBytes, objSeqBytes, sendOrderBytes, data])
}

export function moqSendObjectToWriter (writer, trackId, groupSeq, objSeq, sendOrder, data) {
  return moqSendToWriter(writer, moqCreateObjectBytes(trackId, groupSeq, objSeq, sendOrder, data))
}

export async function moqParseObjectHeader (readerStream) {
  const type = await varIntToNumber(readerStream)
  if (type !== MOQ_MESSAGE_OBJECT && type !== MOQ_MESSAGE_OBJECT_WITH_LENGTH) {
    throw new Error(`OBJECT answer type must be ${MOQ_MESSAGE_OBJECT} or ${MOQ_MESSAGE_OBJECT_WITH_LENGTH}, got ${type}`)
  }

  const trackId = await varIntToNumber(readerStream)
  const groupSeq = await varIntToNumber(readerStream)
  const objSeq = await varIntToNumber(readerStream)
  const sendOrder = await varIntToNumber(readerStream)
  const ret = { trackId, groupSeq, objSeq, sendOrder }
  if (type === MOQ_MESSAGE_OBJECT_WITH_LENGTH) {
    ret.payloadLength = await varIntToNumber(readerStream)
  }
  return ret
}

// Helpers

function moqCreateStringBytes (str) {
  const dataStrBytes = new TextEncoder().encode(str)
  const dataStrLengthBytes = numberToVarInt(dataStrBytes.byteLength)
  return concatBuffer([dataStrLengthBytes, dataStrBytes])
}

async function moqStringRead (readerStream) {
  const size = await varIntToNumber(readerStream)
  const buffer = await buffRead(readerStream, size)
  return new TextDecoder().decode(buffer)
}

async function moqSend (writerStream, dataBytes) {
  const writer = writerStream.getWriter()
  moqSendToWriter(writer, dataBytes)
  await writer.ready
  writer.releaseLock()
}

async function mpqReadParameters (readerStream) {
  const ret = {}
  // Params
  const numParams = await varIntToNumber(readerStream)
  if (numParams > MOQ_MAX_PARAMS) {
    throw new Error(`exceeded the max number of supported params ${MOQ_MAX_PARAMS}, got ${numParams}`)
  }
  for (let i = 0; i < numParams; i++) {
    const paramId = await varIntToNumber(readerStream)
    if (paramId === MOQ_PARAMETER_AUTHORIZATION_INFO) {
      ret.authInfo = await moqStringRead(readerStream)
    } else if (paramId === MOQ_PARAMETER_ROLE) {
      await varIntToNumber(readerStream)
      ret.role = await varIntToNumber(readerStream)
    } else {
      const paramLength = await varIntToNumber(readerStream)
      const skip = await buffRead(readerStream, paramLength)
      ret[`unknown-${i}-${paramId}-${paramLength}`] = JSON.stringify(skip)
    }
  }
  return ret
}

async function moqSendToWriter (writer, dataBytes) {
  writer.write(dataBytes)
}
