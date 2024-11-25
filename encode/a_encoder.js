/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import { sendMessageToMain, StateEnum } from '../utils/utils.js'

const WORKER_PREFIX = '[AUDIO-ENC]'

const WEBCODECS_TIMESCALE = 1000000  // 1us

let frameDeliveredCounter = 0
let chunkDeliveredCounter = 0
let workerState = StateEnum.Created

// Default values
let encoderMaxQueueSize = 5

// Last audioData SampleFreq
let lastEncoderConfig;

// Encoder
const initAudioEncoder = {
  output: handleChunk,
  error: (e) => {
    if (workerState === StateEnum.Created) {
      console.error(e.message)
    } else {
      sendMessageToMain(WORKER_PREFIX, 'error', e.message)
    }
  }
}

let aEncoder = null

function handleChunk (chunk, metadata) {
  const msg = { type: 'achunk', seqId: chunkDeliveredCounter++, chunk, timebase: WEBCODECS_TIMESCALE, sampleFreq: lastEncoderConfig.sampleRate, numChannels: lastEncoderConfig.numberOfChannels, codec: lastEncoderConfig.codec}

  sendMessageToMain(WORKER_PREFIX, 'debug', 'Chunk created. sId: ' + msg.seqId + ', Timestamp: ' + chunk.timestamp + ', dur: ' + chunk.duration + ', type: ' + chunk.type + ', size: ' + chunk.byteLength + ', metadata: ' + JSON.stringify(metadata));

  self.postMessage(msg)
}

self.addEventListener('message', async function (e) {
  if (workerState === StateEnum.Created) {
    workerState = StateEnum.Instantiated
  }

  if (workerState === StateEnum.Stopped) {
    sendMessageToMain(WORKER_PREFIX, 'info', 'Encoder is stopped it does not accept messages')
    return
  }

  const type = e.data.type
  if (type === 'stop') {
    workerState = StateEnum.Stopped
    // Make sure all requests has been processed
    await aEncoder.flush()

    aEncoder.close()

    return
  }
  if (type === 'aencoderini') {
    const encoderConfig = e.data.encoderConfig

    // eslint-disable-next-line no-undef
    aEncoder = new AudioEncoder(initAudioEncoder)

    // We do NOT accept changing audio encoding settings mid-stream for now
    aEncoder.configure(encoderConfig)
    lastEncoderConfig = encoderConfig
    if ('encoderMaxQueueSize' in e.data) {
      encoderMaxQueueSize = e.data.encoderMaxQueueSize
    }
    sendMessageToMain(WORKER_PREFIX, 'info', `Encoder initialized with config: ${JSON.stringify(lastEncoderConfig)}`)
    return
  }
  if (type !== 'aframe') {
    sendMessageToMain(WORKER_PREFIX, 'error', 'Invalid message received')
    return
  }

  const aFrame = e.data.aframe

  if (aEncoder.encodeQueueSize > encoderMaxQueueSize) {
    // Too many frames in the encoder, encoder is overwhelmed let's drop this frame.
    sendMessageToMain(WORKER_PREFIX, 'dropped', { clkms: Date.now(), ts: aFrame.timestamp, msg: 'Dropped encoding audio frame' })
    aFrame.close()
  } else {
    sendMessageToMain(WORKER_PREFIX, 'debug', 'Send to encode frame ts: ' + aFrame.timestamp + '. Counter: ' + frameDeliveredCounter++)

    aEncoder.encode(aFrame)
    aFrame.close()
  }
})
