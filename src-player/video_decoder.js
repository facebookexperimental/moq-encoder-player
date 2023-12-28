/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import { sendMessageToMain, StateEnum, deSerializeMetadata } from './utils.js'
import { TsQueue } from './ts_queue.js'

const WORKER_PREFIX = '[VIDEO-DECO]'

const MAX_DECODE_QUEUE_SIZE_FOR_WARNING_MS = 500
const MAX_QUEUED_CHUNKS_DEFAULT = 60

let workerState = StateEnum.Created

let videoDecoder = null

let waitForKeyFrame = true
let discardedDelta = 0
let discardedBufferFull = 0
const maxQueuedChunks = MAX_QUEUED_CHUNKS_DEFAULT

// Unlike the  audio decoder video decoder tracks timestamps between input - output, so timestamps of RAW frames matches the timestamps of encoded frames

const ptsQueue = new TsQueue()

function processVideoFrame (vFrame) {
  self.postMessage({ type: 'vframe', frame: vFrame, queueSize: ptsQueue.getPtsQueueLengthInfo().size, queueLengthMs: ptsQueue.getPtsQueueLengthInfo().lengthMs }, [vFrame])
}

function setWaitForKeyframe (a) {
  waitForKeyFrame = a
}

function isWaitingForKeyframe () {
  return waitForKeyFrame
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
    if (videoDecoder != null) {
      await videoDecoder.flush()
      videoDecoder.close()
      videoDecoder = null

      ptsQueue.clear()
    }
    workerState = StateEnum.Created
  } else if (type === 'videochunk') {
    if (e.data.metadata !== undefined && e.data.metadata != null) {
      sendMessageToMain(WORKER_PREFIX, 'debug', `SeqId: ${e.data.seqId} Received chunk, chunkSize: ${e.data.chunk.byteLength}, metadataSize: ${e.data.metadata.byteLength}`)
      if (videoDecoder != null) {
        sendMessageToMain(WORKER_PREFIX, 'debug', `SeqId: ${e.data.seqId} Received init, but VideoDecoder already initialized`)
      } else {
        // Initialize video decoder
        // eslint-disable-next-line no-undef
        videoDecoder = new VideoDecoder({
          output: frame => {
            processVideoFrame(frame)
          },
          error: err => {
            sendMessageToMain(WORKER_PREFIX, 'error', 'Video decoder. err: ' + err.message)
          }
        })

        videoDecoder.addEventListener('dequeue', (event) => {
          if (videoDecoder != null) {
            ptsQueue.removeUntil(videoDecoder.decodeQueueSize)
          }
        })

        // Override values
        const config = deSerializeMetadata(e.data.metadata)
        config.optimizeForLatency = true
        // In my test @2022/11 with hardware accel could NOT get real time decoding,
        // switching to soft decoding fixed everything (h264)
        config.hardwareAcceleration = 'prefer-software'
        videoDecoder.configure(config)

        workerState = StateEnum.Running
        setWaitForKeyframe(true)

        sendMessageToMain(WORKER_PREFIX, 'info', `SeqId: ${e.data.seqId} Initialized and configured`)
      }
    } else {
      sendMessageToMain(WORKER_PREFIX, 'debug', `SeqId: ${e.data.seqId} Received chunk, chunkSize: ${e.data.chunk.byteLength}, metadataSize: -`)
    }

    if (workerState !== StateEnum.Running) {
      sendMessageToMain(WORKER_PREFIX, 'warning', 'Received video chunk, but NOT running state')
      return
    }

    if (videoDecoder.decodeQueueSize >= maxQueuedChunks) {
      discardedBufferFull++
      sendMessageToMain(WORKER_PREFIX, 'warning', 'Discarded ' + discardedBufferFull + ' video chunks because decoder buffer is full')
      return
    }

    discardedBufferFull = 0

    // If there is a disco, we need to wait for a new key
    if (e.data.isDisco) {
      setWaitForKeyframe(true)
    }

    // The message is video chunk
    if (isWaitingForKeyframe() && (e.data.chunk.type !== 'key')) {
      // Discard Frame
      discardedDelta++
    } else {
      if (discardedDelta > 0) {
        sendMessageToMain(WORKER_PREFIX, 'warning', 'Discarded ' + discardedDelta + ' video chunks before key')
      }
      discardedDelta = 0
      setWaitForKeyframe(false)

      ptsQueue.removeUntil(videoDecoder.decodeQueueSize)
      ptsQueue.addToPtsQueue(e.data.chunk.timestamp, e.data.chunk.duration)
      videoDecoder.decode(e.data.chunk)

      const decodeQueueInfo = ptsQueue.getPtsQueueLengthInfo()
      if (decodeQueueInfo.lengthMs > MAX_DECODE_QUEUE_SIZE_FOR_WARNING_MS) {
        sendMessageToMain(WORKER_PREFIX, 'warning', 'Decode queue size is ' + decodeQueueInfo.lengthMs + 'ms (' + decodeQueueInfo.size + ' frames), videoDecoder: ' + videoDecoder.decodeQueueSize)
      } else {
        sendMessageToMain(WORKER_PREFIX, 'debug', 'Decode queue size is ' + decodeQueueInfo.lengthMs + 'ms (' + decodeQueueInfo.size + ' frames), videoDecoder: ' + videoDecoder.decodeQueueSize)
      }
    }
  } else {
    sendMessageToMain(WORKER_PREFIX, 'error', 'Invalid message received')
  }
})
