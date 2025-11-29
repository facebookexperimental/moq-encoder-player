/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import { sendMessageToMain, StateEnum, compareArrayBuffer } from '../utils/utils.js'
import { TsQueue } from '../utils/ts_queue.js'
import { ParseAVCDecoderConfigurationRecord, GetVideoCodecStringFromAVCDecoderConfigurationRecord } from "../utils/media/avc_decoder_configuration_record_parser.js"
import { ParseH264NALs, DEFAULT_AVCC_HEADER_LENGTH } from "../utils/media/avcc_parser.js"

const WORKER_PREFIX = '[VIDEO-DECO]'

const MAX_DECODE_QUEUE_SIZE_FOR_WARNING_MS = 500
const MAX_QUEUED_CHUNKS_DEFAULT = 3  // Reduced from 60 to prevent worker message queue saturation

let workerState = StateEnum.Created

let videoDecoder = null

let lastMetadataUsed = null

let waitForKeyFrame = true
let discardedDelta = 0
let discardedBufferFull = 0
const maxQueuedChunks = MAX_QUEUED_CHUNKS_DEFAULT

// Unlike the  audio decoder video decoder tracks timestamps between input - output, so timestamps of RAW frames matches the timestamps of encoded frames

const ptsQueue = new TsQueue()

function processVideoFrame (vFrame) {
  self.postMessage({ type: 'vframe', frame: vFrame, queueSize: ptsQueue.getPtsQueueLengthInfo().size, queueLengthMs: ptsQueue.getPtsQueueLengthInfo().lengthMs }, [vFrame])
}

function setWaitForKeyframe (value) {
  waitForKeyFrame = value
}

function isWaitingForKeyframe () {
  return waitForKeyFrame
}

function getAndOverrideInitDataValues(metadata) {
  // Assume we are sending AVCDecoderConfigurationRecord in the metadata.description
  const avcDecoderConfigurationRecordInfo = ParseAVCDecoderConfigurationRecord(metadata);

  // Override values
  // We can get the width and height from SPS inside AVCDecoderConfigurationRecord but that is complex and NOT necessary
  const config = {codec: GetVideoCodecStringFromAVCDecoderConfigurationRecord(avcDecoderConfigurationRecordInfo) , description: metadata};
  config.optimizeForLatency = true
  // In my test @2022/11 with hardware accel could NOT get real time decoding,
  // switching to soft decoding fixed everything (h264)
  config.hardwareAcceleration = 'prefer-software'

  return {config, avcDecoderConfigurationRecordInfo};
}

function configureDecoder(seqId, metadata) {
  if (videoDecoder == null) {
    sendMessageToMain(WORKER_PREFIX, 'warn', `SeqId: ${seqId} Could NOT initialize decoder, decoder was null at this time`)
    return
  }
  const ret = getAndOverrideInitDataValues(metadata)

  console.log('[DEBUG] Configuring VideoDecoder:', {
    seqId: seqId,
    codec: ret.config.codec,
    descriptionLength: ret.config.description ? ret.config.description.byteLength : 0,
    hardwareAcceleration: ret.config.hardwareAcceleration,
    optimizeForLatency: ret.config.optimizeForLatency
  })

  sendMessageToMain(WORKER_PREFIX, 'info', `SeqId: ${seqId} Received different init, REinitializing the VideoDecoder. Config: ${JSON.stringify(ret.config)}, avcDecoderConfigurationRecord: ${JSON.stringify(ret.avcDecoderConfigurationRecordInfo)}`)
  videoDecoder.configure(ret.config)

  console.log('[DEBUG] VideoDecoder configured, state:', videoDecoder.state)
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
        if (lastMetadataUsed == null || !compareArrayBuffer(lastMetadataUsed, e.data.metadata)) {
          configureDecoder(e.data.seqId, e.data.metadata)
        }
        lastMetadataUsed = e.data.metadata        
      } else {
        // Initialize video decoder
        // eslint-disable-next-line no-undef
        videoDecoder = new VideoDecoder({
          output: frame => {
            console.log('[DEBUG] VideoDecoder output callback fired:', {
              timestamp: frame.timestamp,
              duration: frame.duration,
              displayWidth: frame.displayWidth,
              displayHeight: frame.displayHeight
            })
            processVideoFrame(frame)
          },
          error: err => {
            console.error('[DEBUG] VideoDecoder error callback fired:', err.message, err)
            sendMessageToMain(WORKER_PREFIX, 'error', 'Video decoder. err: ' + err.message)
          }
        })

        videoDecoder.addEventListener('dequeue', () => {
          if (videoDecoder != null) {
            ptsQueue.removeUntil(videoDecoder.decodeQueueSize)
          }
        })
        
        configureDecoder(e.data.seqId, e.data.metadata)
        lastMetadataUsed = e.data.metadata

        workerState = StateEnum.Running
        setWaitForKeyframe(true)
      }
    } else {
      sendMessageToMain(WORKER_PREFIX, 'debug', `SeqId: ${e.data.seqId} Received chunk, chunkSize: ${e.data.chunk.byteLength}`)
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
    console.log('[DEBUG] VideoDecoder state:', {
      seqId: e.data.seqId,
      chunkType: e.data.chunk.type,
      chunkTimestamp: e.data.chunk.timestamp,
      chunkDuration: e.data.chunk.duration,
      chunkByteLength: e.data.chunk.byteLength,
      waitingForKeyframe: isWaitingForKeyframe(),
      decoderState: videoDecoder.state,
      decodeQueueSize: videoDecoder.decodeQueueSize
    })
    if (isWaitingForKeyframe() && (e.data.chunk.type !== 'key')) {
      // Discard Frame
      discardedDelta++
      console.warn('[DEBUG] VideoDecoder DISCARDING delta frame (waiting for keyframe):', {
        seqId: e.data.seqId,
        chunkType: e.data.chunk.type,
        totalDiscarded: discardedDelta
      })
    } else {
      if (discardedDelta > 0) {
        sendMessageToMain(WORKER_PREFIX, 'warning', 'Discarded ' + discardedDelta + ' video chunks before key')
      }
      discardedDelta = 0
      if (e.data.chunk.type === 'key') {
        console.log('[DEBUG] VideoDecoder RECEIVED KEYFRAME, starting decode:', {
          seqId: e.data.seqId,
          timestamp: e.data.chunk.timestamp,
          byteLength: e.data.chunk.byteLength
        })
      }
      setWaitForKeyframe(false)

      ptsQueue.removeUntil(videoDecoder.decodeQueueSize)
      ptsQueue.addToPtsQueue(e.data.chunk.timestamp, e.data.chunk.duration)

      // This is verbose and slow
      if ("verbose" in e.data && e.data.verbose === true) {
        // Assumes it is h264 AVCC with 4 bytes of size length
        const chunkDataBuffer = new Uint8Array(e.data.chunk.byteLength)
        e.data.chunk.copyTo(chunkDataBuffer);
        const chunkNALUInfo = ParseH264NALs(chunkDataBuffer, DEFAULT_AVCC_HEADER_LENGTH);
        sendMessageToMain(WORKER_PREFIX, 'info', `New chunk SeqId: ${e.data.seqId}, NALUS: ${JSON.stringify(chunkNALUInfo)}`)
      }
      console.log('[DEBUG] VideoDecoder calling decode():', {
        seqId: e.data.seqId,
        chunkType: e.data.chunk.type,
        timestamp: e.data.chunk.timestamp,
        decoderStateBefore: videoDecoder.state
      })
      videoDecoder.decode(e.data.chunk)
      console.log('[DEBUG] VideoDecoder decode() returned, state:', videoDecoder.state)

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
