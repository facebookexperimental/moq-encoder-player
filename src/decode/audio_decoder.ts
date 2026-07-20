/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

/*
 * Audio decoder Web Worker.
 *
 * Thin wrapper around the WebCodecs `AudioDecoder` that also reports which fed
 * chunk each decoded frame came from. The decoder re-times its own output
 * contiguously (anchored to the first chunk) and can't represent gaps, so the
 * fed timestamp is the only reliable source of the true media position at a
 * resume. A decoded chunk can produce any number of output frames, so we can't
 * pair timestamps to frames on the `output` callback. Instead we mirror the
 * decoder's input queue in `pendingTs` and reconcile it on the `dequeue` event:
 * whatever left the input queue is now being decoded, and the most recent of
 * those chunks owns the frames about to be output. The renderer (GapTolerantPlayer)
 * uses this true `ts` to anchor media time, which supersedes the old manual
 * discontinuity/timestamp-offset compensation.
 */

import { sendMessageToMain, StateEnum } from '../utils/utils.js';
import { TsQueue } from '../utils/ts_queue.js';
import { MIPayloadTypeEnum } from '../packager/mi_packager.js';

const WORKER_PREFIX = '[AUDIO-DECO]';

const MAX_DECODE_QUEUE_SIZE_FOR_WARNING_MS = 200;

let workerState = StateEnum.Created;

let audioDecoder: any = null;

// Timestamps of chunks still in the decoder's input queue, in feed order.
let pendingTs: number[] = [];
// Timestamp of the chunk whose frames are currently being output.
let currentTs = -1;

// Tracks decode-queue length (ms) for stats/backpressure warnings only.
const ptsQueue = new TsQueue();

function processAudioFrame(aFrame: any) {
  (self as any).postMessage(
    {
      type: 'aframe',
      frame: aFrame,
      ts: currentTs,
      queueSize: ptsQueue.getPtsQueueLengthInfo().size,
      queueLengthMs: ptsQueue.getPtsQueueLengthInfo().lengthMs,
    },
    [aFrame],
  );
}

function initializeDecoder(config: any) {
  audioDecoder = new AudioDecoder({
    output: (frame: any) => {
      processAudioFrame(frame);
    },
    error: (err: any) => {
      sendMessageToMain(WORKER_PREFIX, 'error', 'Audio decoder. err: ' + err.message);
    },
  });

  // Keep pendingTs (and the stats queue) in sync with the input queue as chunks
  // are consumed. Reading decodeQueueSize here (rather than counting per event)
  // tolerates the event coalescing multiple decrements: whatever left the queue
  // is spliced off, and the most recently consumed chunk becomes the timestamp
  // for its output frames.
  audioDecoder.addEventListener('dequeue', () => {
    if (audioDecoder == null) {
      return;
    }
    ptsQueue.removeUntil(audioDecoder.decodeQueueSize);

    const consumed = pendingTs.length - audioDecoder.decodeQueueSize;
    if (consumed > 0 && consumed <= pendingTs.length) {
      currentTs = pendingTs[consumed - 1];
      pendingTs.splice(0, consumed);
    } else if (consumed !== 0) {
      sendMessageToMain(
        WORKER_PREFIX,
        'warning',
        `Unexpected dequeue event. Queue size: ${audioDecoder.decodeQueueSize} and consumed: ${consumed}`,
      );
    }
  });

  audioDecoder.configure(config);

  workerState = StateEnum.Running;

  sendMessageToMain(WORKER_PREFIX, 'info', `Initialized and configured: ${JSON.stringify(config)}`);
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
    if (audioDecoder != null) {
      await audioDecoder.flush();
      audioDecoder.close();
      audioDecoder = null;

      ptsQueue.clear();
    }
    workerState = StateEnum.Created;
    pendingTs = [];
    currentTs = -1;
  } else if (type === 'audiochunk') {
    if (audioDecoder != null) {
      sendMessageToMain(
        WORKER_PREFIX,
        'debug',
        `audio-${e.data.groupId}/${e.data.objId} Received init, but AudioDecoder already initialized`,
      );
    } else {
      let config;
      if (e.data.packagerType == MIPayloadTypeEnum.AudioAACMP4LCWCP) {
        config = {
          codec: 'mp4a.40.02',
          sampleRate: e.data.sampleFreq,
          numberOfChannels: e.data.numChannels,
        };
      } else if (e.data.packagerType == MIPayloadTypeEnum.AudioOpusWCP) {
        config = {
          codec: 'opus',
          sampleRate: e.data.sampleFreq,
          numberOfChannels: e.data.numChannels,
        };
      }
      if (config === undefined) {
        sendMessageToMain(
          WORKER_PREFIX,
          'error',
          `audio-${e.data.groupId}/${e.data.objId} Unsupported audio packager type: ${e.data.packagerType}, can NOT configure decoder`,
        );
        return;
      }
      initializeDecoder(config);
    }

    sendMessageToMain(
      WORKER_PREFIX,
      'debug',
      `audio-${e.data.groupId}/${e.data.objId} Received chunk, chunkSize: ${e.data.chunk.byteLength}, metadataSize: -`,
    );

    if (workerState !== StateEnum.Running) {
      sendMessageToMain(WORKER_PREFIX, 'warning', 'Received audio chunk, but NOT running state');
      return;
    }
    ptsQueue.addToPtsQueue(e.data.chunk.timestamp, e.data.chunk.duration);

    // Seed before the first dequeue fires so the very first frame has a timestamp.
    if (currentTs < 0) {
      currentTs = e.data.chunk.timestamp;
    }
    pendingTs.push(e.data.chunk.timestamp);

    audioDecoder.decode(e.data.chunk);

    const decodeQueueInfo = ptsQueue.getPtsQueueLengthInfo();
    if (decodeQueueInfo.lengthMs > MAX_DECODE_QUEUE_SIZE_FOR_WARNING_MS) {
      sendMessageToMain(
        WORKER_PREFIX,
        'warning',
        'Decode queue size is ' +
          decodeQueueInfo.lengthMs +
          'ms (' +
          decodeQueueInfo.size +
          ' frames), audioDecoder: ' +
          audioDecoder.decodeQueueSize,
      );
    } else {
      sendMessageToMain(
        WORKER_PREFIX,
        'debug',
        'Decode queue size is ' +
          decodeQueueInfo.lengthMs +
          'ms (' +
          decodeQueueInfo.size +
          ' frames), audioDecoder: ' +
          audioDecoder.decodeQueueSize,
      );
    }
  } else {
    sendMessageToMain(WORKER_PREFIX, 'error', 'Invalid message received');
  }
});
