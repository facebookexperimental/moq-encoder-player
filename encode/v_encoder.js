/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import { sendMessageToMain, StateEnum } from '../utils/utils.js'
import { ParseAVCDecoderConfigurationRecord } from "../utils/media/avc_decoder_configuration_record_parser.js"

const WORKER_PREFIX = '[VIDEO-ENC]'

const WEBCODECS_TIMEBASE = 1000000

let frameDeliveredCounter = 0
let chunkDeliveredCounter = 0

let workerState = StateEnum.Created

// Default values
let encoderMaxQueueSize = 5
let keyframeEvery = 60
let insertNextKeyframe = false

// Encoder
const initVideoEncoder = {
  output: handleChunk,
  error: (e) => {
    if (workerState === StateEnum.Created) {
      console.error(e.message)
    } else {
      sendMessageToMain(WORKER_PREFIX, 'error', e.message)
    }
  }
}

let vEncoder = null

function handleChunk (chunk, metadata) {
  // decoderConfig in h264 is AVCDecoderConfigurationRecord
  const frame_metadata = (metadata != undefined && metadata.decoderConfig != undefined && "description" in metadata.decoderConfig) ? metadata.decoderConfig.description : undefined;
  const msg = { type: 'vchunk', seqId: chunkDeliveredCounter++, chunk, metadata: frame_metadata, timebase: WEBCODECS_TIMEBASE}

  // Assume we are sending AVCDecoderConfigurationRecord in the metadata.description
  sendMessageToMain(WORKER_PREFIX, 'debug', `Chunk created. sId: ${msg.seqId}, pts: ${chunk.timestamp}, dur: ${chunk.duration}, type: ${chunk.type}, size: ${chunk.byteLength}, metadata_size:${(frame_metadata != undefined) ? frame_metadata.byteLength : 0}, avcDecoderConfigurationRecord: ${(frame_metadata != undefined) ? JSON.stringify(ParseAVCDecoderConfigurationRecord(frame_metadata)) : "-"}`)

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
    await vEncoder.flush()

    vEncoder.close()
    workerState = StateEnum.Stopped
    return
  }
  if (type === 'vencoderini') {
    const encoderConfig = e.data.encoderConfig

    // eslint-disable-next-line no-undef
    vEncoder = new VideoEncoder(initVideoEncoder)

    vEncoder.configure(encoderConfig)
    if ('encoderMaxQueueSize' in e.data) {
      encoderMaxQueueSize = e.data.encoderMaxQueueSize
    }
    if ('keyframeEvery' in e.data) {
      keyframeEvery = e.data.keyframeEvery
    }
    sendMessageToMain(WORKER_PREFIX, 'info', `Encoder initialized: ${JSON.stringify(encoderConfig)}`);

    workerState = StateEnum.Running
    return
  }
  if (type !== 'vframe') {
    sendMessageToMain(WORKER_PREFIX, 'error', 'Invalid message received')
    return
  }

  const vFrame = e.data.vframe

  if (vEncoder.encodeQueueSize > encoderMaxQueueSize) {
    // Too many frames in the encoder queue, encoder is overwhelmed let's not add this frame
    sendMessageToMain(WORKER_PREFIX, 'dropped', { clkms: Date.now(), ts: vFrame.timestamp, msg: 'Dropped encoding video frame' })
    vFrame.close()
    // Insert a keyframe after dropping
    insertNextKeyframe = true
  } else {
    const frameNum = frameDeliveredCounter++
    const insertKeyframe = (frameNum % keyframeEvery) === 0 || (insertNextKeyframe === true)
    vEncoder.encode(vFrame, { keyFrame: insertKeyframe })
    sendMessageToMain(WORKER_PREFIX, 'debug', `Encoded frame: ${frameNum}, key: ${insertKeyframe}`)
    vFrame.close()
    insertNextKeyframe = false
    frameDeliveredCounter++
  }
})
