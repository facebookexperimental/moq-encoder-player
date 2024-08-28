/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

'use strict'

export class StateEnum {
  // Create new instances of the same class as static attributes
  static Created = new StateEnum('created')
  static Instantiated = new StateEnum('instantiated')
  static Running = new StateEnum('running')
  static Stopped = new StateEnum('stopped')

  constructor (name) {
    this.name = name
  }
}

export function sendMessageToMain (prefix, type, data) {
    if (type === 'debug' || type === 'info' || type === 'error' || type === 'warning') {
      data = prefix + ' ' + data
    }
    self.postMessage({ type, data })
}

export function serializeMetadata (metadata) {
  let ret
  if (isMetadataValid(metadata)) {
    const newData = {}
    // Copy all enumerable own properties
    newData.decoderConfig = Object.assign({}, metadata.decoderConfig)
    // Description is buffer
    if ('description' in metadata.decoderConfig) {
      newData.decoderConfig.descriptionInBase64 = arrayBufferToBase64(metadata.decoderConfig.description)
      delete newData.description
    }
    // Encode
    const encoder = new TextEncoder()
    ret = encoder.encode(JSON.stringify(newData))
  }
  return ret
}

export function isMetadataValid (metadata) {
  return metadata !== undefined && 'decoderConfig' in metadata
}

function arrayBufferToBase64 (buffer) {
  let binary = ''
  const bytes = new Uint8Array(buffer)
  const len = bytes.byteLength
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

export function deSerializeMetadata (metadata) {
  const decoder = new TextDecoder()
  const str = decoder.decode(metadata)
  const data = JSON.parse(str)

  if (('decoderConfig' in data) && ('descriptionInBase64' in data.decoderConfig)) {
    data.decoderConfig.description = base64ToArrayBuffer(data.decoderConfig.descriptionInBase64)
    delete data.decoderConfig.descriptionInBase64
  }
  return data.decoderConfig
}

export async function getBinaryFile(url) {
  const response = await fetch(url);
  if (!response.ok) {
      throw new Error(`Response status: ${response.status}`);
  }

  return await response.arrayBuffer()
}

export function compareArrayBuffer(a, b) {
  if (a.byteLength !== b.byteLength) {
    return false
  }
  const av = new Int8Array(a)
  const bv = new Int8Array(b)
  for (let i = 0; i < a.byteLength; i++) {    
    if (av[i] !== bv[i]) {
      return false;
    }
  }
  return true;
}

function base64ToArrayBuffer (base64) {
  const binaryString = atob(base64)
  const len = binaryString.length
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i)
  }
  return bytes.buffer
}
