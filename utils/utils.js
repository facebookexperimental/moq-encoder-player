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

export async function getBinaryFile(url) {
  const response = await fetch(url);
  if (!response.ok) {
      throw new Error(`Response status: ${response.status}`);
  }

  return await response.arrayBuffer()
}

export function compareArrayBuffer(a, b) {
  if (a == undefined && b == undefined) {
    return true;
  }
  if (a == undefined || b == undefined) {
    return false;
  }
  if (a.byteLength !== b.byteLength) {
    return false;
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

export function convertTimestamp(ts, originalTimebase, destTimeBase) {
  return Math.round(ts * destTimeBase / originalTimebase);
}

export function buf2hex(buffer) { // buffer is an ArrayBuffer
  return [...new Uint8Array(buffer)]
      .map(x => x.toString(16).padStart(2, '0'))
      .join('');
}
