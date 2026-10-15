/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import { sendMessageToMain, StateEnum } from '../utils/utils.js';
import { ParseAVCDecoderConfigurationRecord } from '../utils/media/avc_decoder_configuration_record_parser.js';
import { OverlayEncoder } from '../overlay_processor/overlay_encoder.js';

const WORKER_PREFIX = '[VIDEO-ENC]';

const WEBCODECS_TIMESCALE = 1000000;

let chunkDeliveredCounter = 0;

let workerState = StateEnum.Created;

// Default values
let encoderMaxQueueSize = 5;
let keyframeEvery = 60;
let insertNextKeyframe = false;
// When part of an ABR ladder, keyframes are placed only by captureIndex so all
// renditions stay aligned; no extra keyframe is forced after a dropped frame.
let isPartOfABR = false;

// Latency overlay: when enabled, stamp the capture-read wall-clock epoch (ms) into the
// top rows of each frame before encoding so the player can later recover it and
// estimate capture-read-to-render latency (see src/overlay_processor). The epoch
// is sampled in v_capture when its track processor yields the frame and piped here;
// it is NOT generated at encode time. Requires NV12 raw frames; skipped (warned once)
// for other source formats.
let addLatencyInfoInVideo = false;
const overlayEncoder = new OverlayEncoder();
let overlayWarned = false;

// Make sure we send the metadata in all keyframes (send last if encoder not provides one)
let last_keyframe_metadata: any = undefined;
// WebCodecs reports the decoder config on the first chunk only; the LOC
// Codecstring property rides every video object.
let last_codec: string | undefined = undefined;
// Coded dimensions, also reported on the first chunk only. The CMAF packager
// needs them to describe the track (tkhd / visual sample entry); LOC does not.
let last_coded_width: number | undefined = undefined;
let last_coded_height: number | undefined = undefined;

// Encoder
const initVideoEncoder = {
  output: handleChunk,
  error: (e: any) => {
    if (workerState === StateEnum.Created) {
      console.error(e.message);
    } else {
      sendMessageToMain(WORKER_PREFIX, 'error', e.message);
    }
  },
};

let vEncoder: any = null;

function handleChunk(chunk: any, metadata: any) {
  // decoderConfig in h264 is AVCDecoderConfigurationRecord
  let frame_metadata =
    metadata != undefined &&
    metadata.decoderConfig != undefined &&
    'description' in metadata.decoderConfig
      ? metadata.decoderConfig.description
      : undefined;
  if (frame_metadata != undefined) {
    last_keyframe_metadata = frame_metadata;
  } else if (chunk.type == 'key') {
    frame_metadata = last_keyframe_metadata;
  }
  if (metadata?.decoderConfig?.codec != undefined) {
    last_codec = metadata.decoderConfig.codec;
  }
  if (metadata?.decoderConfig?.codedWidth != undefined) {
    last_coded_width = metadata.decoderConfig.codedWidth;
    last_coded_height = metadata.decoderConfig.codedHeight;
  }

  const msg = {
    type: 'vchunk',
    seqId: chunkDeliveredCounter++,
    chunk,
    metadata: frame_metadata,
    timebase: WEBCODECS_TIMESCALE,
    codec: last_codec,
    codedWidth: last_coded_width,
    codedHeight: last_coded_height,
  };

  // Assume we are sending AVCDecoderConfigurationRecord in the metadata.description
  sendMessageToMain(
    WORKER_PREFIX,
    'debug',
    `Chunk created. sId: ${msg.seqId}, pts: ${msg.chunk.timestamp}, dur: ${msg.chunk.duration}, type: ${msg.chunk.type}, size: ${msg.chunk.byteLength}, metadata_size:${msg.metadata != undefined ? msg.metadata.byteLength : 0}, avcDecoderConfigurationRecord: ${msg.metadata != undefined ? JSON.stringify(ParseAVCDecoderConfigurationRecord(msg.metadata)) : '-'}`,
  );

  self.postMessage(msg);
}

self.addEventListener('message', async function (e) {
  if (workerState === StateEnum.Created) {
    workerState = StateEnum.Instantiated;
  }

  if (workerState === StateEnum.Stopped) {
    sendMessageToMain(WORKER_PREFIX, 'info', 'Encoder is stopped it does not accept messages');
    return;
  }

  const type = e.data.type;
  if (type === 'stop') {
    workerState = StateEnum.Stopped;
    // Make sure all requests has been processed
    await vEncoder.flush();

    vEncoder.close();
    workerState = StateEnum.Stopped;
    return;
  }
  if (type === 'vencoderini') {
    const encoderConfig = e.data.encoderConfig;

    vEncoder = new VideoEncoder(initVideoEncoder);

    vEncoder.configure(encoderConfig);
    if ('encoderMaxQueueSize' in e.data) {
      encoderMaxQueueSize = e.data.encoderMaxQueueSize;
    }
    if ('keyframeEvery' in e.data) {
      keyframeEvery = e.data.keyframeEvery;
    }
    addLatencyInfoInVideo = e.data.addLatencyInfoInVideo === true;
    isPartOfABR = e.data.isPartOfABR === true;
    sendMessageToMain(
      WORKER_PREFIX,
      'info',
      `Encoder initialized (isPartOfABR: ${isPartOfABR}): ${JSON.stringify(encoderConfig)}`,
    );

    workerState = StateEnum.Running;
    return;
  }
  if (type === 'setlatencyoverlay') {
    // Live toggle of the latency overlay (checkbox flipped during a session).
    addLatencyInfoInVideo = e.data.addLatencyInfoInVideo === true;
    return;
  }
  if (type !== 'vframe') {
    sendMessageToMain(WORKER_PREFIX, 'error', 'Invalid message received');
    return;
  }

  const vFrame = e.data.vframe;
  // Capture-read wall-clock epoch (ms), sampled in v_capture when the frame was read
  // and piped through the main thread. Used for the latency overlay so the value
  // reflects processor delivery time rather than encode time.
  const captureClkms = e.data.captureClkms;
  // Monotonically increasing per-frame index assigned in v_capture. Gaps mean frames
  // were dropped between capture and here.
  const captureIndex: number = e.data.captureIndex;

  if (vEncoder.encodeQueueSize > encoderMaxQueueSize) {
    // Too many frames in the encoder queue, encoder is overwhelmed let's not add this frame
    sendMessageToMain(WORKER_PREFIX, 'dropped', {
      clkms: Date.now(),
      ts: vFrame.timestamp,
      msg: `Dropped encoding video frame (captureIndex: ${captureIndex})`,
    });
    vFrame.close();
    if (!isPartOfABR) {
      insertNextKeyframe = true;
    }
  } else {
    let frameToEncode = vFrame;
    if (addLatencyInfoInVideo) {
      // Stamp epoch-ms into the frame pixels. The overlay requires NV12; if the
      // source uses another format it throws before consuming the frame, so we
      // fall back to the original frame (warning once) rather than fail encoding.
      try {
        frameToEncode = overlayEncoder.Encode(vFrame, captureClkms);
      } catch (err: any) {
        if (!overlayWarned) {
          overlayWarned = true;
          sendMessageToMain(
            WORKER_PREFIX,
            'warning',
            `Latency overlay disabled for this stream: ${err?.message}`,
          );
        }
        frameToEncode = vFrame;
      }
    }
    // Keyed off the capture index (not a local counter) so multiple encoders fed from
    // the same capture place keyframes on the same frames.
    const insertKeyframe = captureIndex % keyframeEvery === 0 || insertNextKeyframe === true;
    vEncoder.encode(frameToEncode, { keyFrame: insertKeyframe });
    sendMessageToMain(
      WORKER_PREFIX,
      'debug',
      `Encoded frame captureIndex: ${captureIndex}, key: ${insertKeyframe}`,
    );
    frameToEncode.close();
    insertNextKeyframe = false;
  }
});
