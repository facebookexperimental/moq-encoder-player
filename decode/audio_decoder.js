/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import { sendMessageToMain, StateEnum} from '../utils/utils.js'
import { TsQueue } from '../utils/ts_queue.js'

const WORKER_PREFIX = '[AUDIO-DECO]'

const MAX_DECODE_QUEUE_SIZE_FOR_WARNING_MS = 200

let workerState = StateEnum.Created

let audioDecoder = null

// The Audio decoder does NOT track timestamps (bummer), it just uses the 1st one sent and at every decoded audio sample adds 1/fs (so sample time)
// That means if we drop and audio packet those timestamps will be collapsed creating A/V out of sync
let timestampOffset = 0
let lastChunkSentTimestamp = -1

const ptsQueue = new TsQueue()

function processAudioFrame (aFrame) {
  self.postMessage({ type: 'aframe', frame: aFrame, queueSize: ptsQueue.getPtsQueueLengthInfo().size, queueLengthMs: ptsQueue.getPtsQueueLengthInfo().lengthMs, timestampCompensationOffset: timestampOffset }, [aFrame])
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
    if (audioDecoder != null) {
      await audioDecoder.flush()
      audioDecoder.close()
      audioDecoder = null

      ptsQueue.clear()
    }
    workerState = StateEnum.Created
    timestampOffset = 0
    lastChunkSentTimestamp = -1
  } else if (type === 'audiochunk') {
    if (audioDecoder != null) {
      sendMessageToMain(WORKER_PREFIX, 'debug', `audio-${e.data.seqId} Received init, but AudioDecoder already initialized`)
    } else {
      // Initialize audio decoder
      // eslint-disable-next-line no-undef
      audioDecoder = new AudioDecoder({
        output: frame => {
          processAudioFrame(frame)
        },
        error: err => {
          sendMessageToMain(WORKER_PREFIX, 'error', 'Audio decoder. err: ' + err.message)
        }
      })

      audioDecoder.addEventListener('dequeue', () => {
        if (audioDecoder != null) {
          ptsQueue.removeUntil(audioDecoder.decodeQueueSize)
        }
      })

      const config = {codec: "opus", sampleRate: e.data.sampleFreq, numberOfChannels: e.data.numChannels}
      audioDecoder.configure(config)

      workerState = StateEnum.Running
  
      sendMessageToMain(WORKER_PREFIX, 'info', `Initialized and configured: ${JSON.stringify(config)}`)
    }
  
    sendMessageToMain(WORKER_PREFIX, 'debug', `audio-${e.data.seqId} Received chunk, chunkSize: ${e.data.chunk.byteLength}, metadataSize: -`);

    if (workerState !== StateEnum.Running) {
      sendMessageToMain(WORKER_PREFIX, 'warning', 'Received audio chunk, but NOT running state')
      return
    }
    ptsQueue.addToPtsQueue(e.data.chunk.timestamp, e.data.chunk.duration)

    if (e.data.isDisco && lastChunkSentTimestamp >= 0) {
      const addTs = e.data.chunk.timestamp - lastChunkSentTimestamp
      sendMessageToMain(WORKER_PREFIX, 'warning', `disco at seqId: ${e.data.seqId}, ts: ${e.data.chunk.timestamp}, added: ${addTs}`)
      timestampOffset += addTs
    }
    lastChunkSentTimestamp = e.data.chunk.timestamp + e.data.chunk.duration

    audioDecoder.decode(e.data.chunk)

    const decodeQueueInfo = ptsQueue.getPtsQueueLengthInfo()
    if (decodeQueueInfo.lengthMs > MAX_DECODE_QUEUE_SIZE_FOR_WARNING_MS) {
      sendMessageToMain(WORKER_PREFIX, 'warning', 'Decode queue size is ' + decodeQueueInfo.lengthMs + 'ms (' + decodeQueueInfo.size + ' frames), audioDecoder: ' + audioDecoder.decodeQueueSize)
    } else {
      sendMessageToMain(WORKER_PREFIX, 'debug', 'Decode queue size is ' + decodeQueueInfo.lengthMs + 'ms (' + decodeQueueInfo.size + ' frames), audioDecoder: ' + audioDecoder.decodeQueueSize)
    }
  } else {
    sendMessageToMain(WORKER_PREFIX, 'error', 'Invalid message received')
  }
})
