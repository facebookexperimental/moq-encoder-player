/*
OffscreenCanvas-based VideoDecoder Worker
Renders decoded frames to OffscreenCanvas and transfers ImageBitmap to main thread
*/

import { ParseAVCDecoderConfigurationRecord, GetVideoCodecStringFromAVCDecoderConfigurationRecord } from "../utils/media/avc_decoder_configuration_record_parser.js"

const WORKER_PREFIX = '[VIDEO-OFFSCREEN]'

let videoDecoder = null
let offscreenCanvas = null
let canvasCtx = null
let lastVideoMetadata = null
let waitForKeyFrame = true
let frameCount = 0

self.addEventListener('message', async function (e) {
  const { type } = e.data

  if (type === 'init') {
    // Receive OffscreenCanvas from main thread
    offscreenCanvas = e.data.canvas
    canvasCtx = offscreenCanvas.getContext('2d', {
      alpha: false,
      desynchronized: true // Optimize for low latency
    })

    // Initialize VideoDecoder
    videoDecoder = new VideoDecoder({
      output: (vFrame) => {
        try {
          // Resize canvas if needed
          if (offscreenCanvas.width !== vFrame.displayWidth || offscreenCanvas.height !== vFrame.displayHeight) {
            offscreenCanvas.width = vFrame.displayWidth
            offscreenCanvas.height = vFrame.displayHeight
            console.log(`[${WORKER_PREFIX}] Canvas resized to ${vFrame.displayWidth}x${vFrame.displayHeight}`)
          }

          // Draw frame directly to OffscreenCanvas (shows up on main thread canvas automatically!)
          canvasCtx.drawImage(vFrame, 0, 0)

          // Notify main thread that frame was rendered (for FPS tracking)
          self.postMessage({
            type: 'frameRendered',
            timestamp: vFrame.timestamp,
            frameNumber: frameCount++
          })

          vFrame.close()
        } catch (err) {
          console.error(`[${WORKER_PREFIX}] Error rendering frame:`, err)
          vFrame.close()
        }
      },
      error: (err) => {
        console.error(`[${WORKER_PREFIX}] VideoDecoder error:`, err)
        self.postMessage({ type: 'error', message: err.message })
      }
    })

    console.log(`[${WORKER_PREFIX}] Initialized with OffscreenCanvas`)

  } else if (type === 'videochunk') {
    const { chunk, seqId, metadata, isDisco } = e.data

    // Configure decoder if we have new metadata
    if (metadata && (!lastVideoMetadata || metadata !== lastVideoMetadata)) {
      const avcInfo = ParseAVCDecoderConfigurationRecord(metadata)
      const codecString = GetVideoCodecStringFromAVCDecoderConfigurationRecord(avcInfo)

      const config = {
        codec: codecString,
        description: metadata,
        optimizeForLatency: true,
        hardwareAcceleration: 'prefer-software'
      }

      console.log(`[${WORKER_PREFIX}] Configuring with codec:`, codecString)
      videoDecoder.configure(config)
      lastVideoMetadata = metadata
    }

    // Wait for keyframe after disco or initial start
    if (isDisco) {
      waitForKeyFrame = true
    }

    if (waitForKeyFrame && chunk.type !== 'key') {
      return // Discard delta frames until keyframe
    }

    if (chunk.type === 'key') {
      waitForKeyFrame = false
    }

    // Decode
    if (videoDecoder.state === 'configured') {
      videoDecoder.decode(chunk)
    }

  } else if (type === 'stop') {
    if (videoDecoder) {
      videoDecoder.close()
      videoDecoder = null
    }
    lastVideoMetadata = null
    waitForKeyFrame = true
    frameCount = 0
    console.log(`[${WORKER_PREFIX}] Stopped`)
  }
})
