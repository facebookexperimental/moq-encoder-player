/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

// PAIRED CONTRACT: this layout MUST stay identical to the SharedStates map in
// source_buffer_worklet.ts (the reader). Both index the same Int32Array.
const SharedStates = {
  AUDIO_BUFF_START: 0, // The reader only modifies this pointer
  AUDIO_BUFF_END: 1, // The writer (this) only modifies this pointer

  AUDIO_INSERTED_SILENCE_MS: 2,

  IS_PLAYING: 3, // Indicates playback state
};

// Lower bound for the TS index size. The actual cap is derived from the ring
// capacity in Init() so it can always map every frame the buffer can hold.
const MIN_ITEMS_IN_TS_INDEX = 30;

// Conservative smallest audio frame assumed when sizing the TS index (5 ms).
const MIN_FRAME_DURATION_S = 0.005;

export class CicularAudioSharedBuffer {
  sampleIndexToTS: Array<{ sampleIndex: number; ts: number }> | null;
  sharedAudiobuffers: SharedArrayBuffer[] | null;
  sharedCommBuffer: SharedArrayBuffer;
  size: number;
  contextFrequency: number;
  sharedStates: Int32Array;
  onDropped: ((info: any) => void) | null;
  lastTimestamp: number | undefined;
  maxIndexItems: number;

  constructor() {
    this.sampleIndexToTS = null; // In Us
    this.sharedAudiobuffers = null;
    this.sharedCommBuffer = new SharedArrayBuffer(
      Object.keys(SharedStates).length * Int32Array.BYTES_PER_ELEMENT,
    );
    this.size = -1;

    this.contextFrequency = -1;

    // Get TypedArrayView from SAB.
    this.sharedStates = new Int32Array(this.sharedCommBuffer);

    this.onDropped = null;
    this.maxIndexItems = MIN_ITEMS_IN_TS_INDEX;

    // Initialize |States| buffer.
    Atomics.store(this.sharedStates, SharedStates.AUDIO_BUFF_START, -1);
    Atomics.store(this.sharedStates, SharedStates.AUDIO_BUFF_END, -1);
    Atomics.store(this.sharedStates, SharedStates.AUDIO_INSERTED_SILENCE_MS, 0);

    // Last sent timestamp
    this.lastTimestamp = undefined;
  }

  SetCallbacks(onDropped: (info: any) => void) {
    this.onDropped = onDropped;
  }

  Init(numChannels: number, numSamples: number, contextFrequency: number) {
    if (this.sharedAudiobuffers != null) {
      throw new Error('Already initialized');
    }
    if (numChannels <= 0 || numChannels === undefined) {
      throw new Error('Passed bad numChannels');
    }
    if (numSamples <= 0 || numSamples === undefined) {
      throw new Error('Passed bad numSamples');
    }
    this.sharedAudiobuffers = [];
    for (let c = 0; c < numChannels; c++) {
      this.sharedAudiobuffers.push(
        new SharedArrayBuffer(numSamples * Float32Array.BYTES_PER_ELEMENT),
      );
    }

    this.contextFrequency = contextFrequency;
    this.lastTimestamp = -1;

    this.size = numSamples;
    this.sampleIndexToTS = [];

    // Cap the TS index so it can map every frame the ring can hold (plus the
    // MIN_ITEMS floor). Prevents losing the cursor->PTS mapping when the writer
    // races far ahead of GetStats() (e.g. background tab).
    const minFrameSamples = Math.max(1, Math.floor(contextFrequency * MIN_FRAME_DURATION_S));
    this.maxIndexItems = Math.max(MIN_ITEMS_IN_TS_INDEX, Math.ceil(numSamples / minFrameSamples));

    Atomics.store(this.sharedStates, SharedStates.AUDIO_BUFF_START, 0);
    Atomics.store(this.sharedStates, SharedStates.AUDIO_BUFF_END, 0);
  }

  Add(aFrame: any, overrideFrameTs?: number) {
    const frameTimestamp = overrideFrameTs === undefined ? aFrame.timestamp : overrideFrameTs;
    if (aFrame === undefined) {
      throw new Error('Passed undefined aFrame');
    }
    if (aFrame.numberOfChannels !== this.sharedAudiobuffers.length) {
      throw new Error(
        `Channels diffent than expected, expected ${this.sharedAudiobuffers.length}, passed: ${aFrame.numberOfChannels}`,
      );
    }
    // Playback is 1:1 (no resampling): the AudioContext is created at the capture
    // rate and the player verifies aFrame.sampleRate === audioCtx.sampleRate before
    // constructing this buffer, so contextFrequency always matches here.

    const samplesToAdd = aFrame.numberOfFrames;

    const start = Atomics.load(this.sharedStates, SharedStates.AUDIO_BUFF_START);
    let end = Atomics.load(this.sharedStates, SharedStates.AUDIO_BUFF_END);

    if (samplesToAdd > this._getFreeSlots(start, end)) {
      if (this.onDropped != null) {
        this.onDropped({
          clkms: Date.now(),
          mediaType: 'audio',
          ts: frameTimestamp,
          msg: 'Dropped PCM audio frame, ring buffer full',
        });
      }
    } else {
      // This will always return recent TS. This is a cicular buffer, we are indexing with numsample in the buffer, so things will get messy if we do not ask for GetStats for more than buffer size. And this happens when tab loses focus
      this._cleanUpIndex();
      this.sampleIndexToTS.push({ sampleIndex: end, ts: frameTimestamp });
      if (end + samplesToAdd <= this.size) {
        // All
        for (let c = 0; c < aFrame.numberOfChannels; c++) {
          const outputRingBuffer = new Float32Array(
            this.sharedAudiobuffers[c],
            end * Float32Array.BYTES_PER_ELEMENT,
          );
          aFrame.copyTo(outputRingBuffer, {
            planeIndex: c,
            frameOffset: 0,
            frameCount: samplesToAdd,
          });
        }
        end += samplesToAdd;
      } else {
        const samplesToAddFirstHalf = this.size - end;
        const samplesToAddSecondsHalf = samplesToAdd - samplesToAddFirstHalf;
        for (let c = 0; c < aFrame.numberOfChannels; c++) {
          // First half
          const outputRingBuffer1 = new Float32Array(
            this.sharedAudiobuffers[c],
            end * Float32Array.BYTES_PER_ELEMENT,
            samplesToAddFirstHalf,
          );
          aFrame.copyTo(outputRingBuffer1, {
            planeIndex: c,
            frameOffset: 0,
            frameCount: samplesToAddFirstHalf,
          });

          // Second half
          const outputRingBuffer2 = new Float32Array(
            this.sharedAudiobuffers[c],
            0,
            samplesToAddSecondsHalf,
          );
          aFrame.copyTo(outputRingBuffer2, {
            planeIndex: c,
            frameOffset: samplesToAddFirstHalf,
            frameCount: samplesToAddSecondsHalf,
          });
        }
        end = samplesToAddSecondsHalf;
      }
    }
    Atomics.store(this.sharedStates, SharedStates.AUDIO_BUFF_END, end);
  }

  GetStats() {
    const start = Atomics.load(this.sharedStates, SharedStates.AUDIO_BUFF_START); // Reader
    const end = Atomics.load(this.sharedStates, SharedStates.AUDIO_BUFF_END); // Writer

    // Update the PTS estimate of the sample currently under the read cursor.
    this._updateCurrentTimestamp(start, end);

    const sizeSamples = this._getUsedSlots(start, end);
    const sizeMs = Math.floor((sizeSamples * 1000) / this.contextFrequency);
    const totalSilenceInsertedMs = Atomics.load(
      this.sharedStates,
      SharedStates.AUDIO_INSERTED_SILENCE_MS,
    );
    const isPlaying = Atomics.load(this.sharedStates, SharedStates.IS_PLAYING);

    return {
      currentTimestamp: this.lastTimestamp,
      queueSize: sizeSamples,
      queueLengthMs: sizeMs,
      totalSilenceInsertedMs,
      isPlaying,
    };
  }

  Play() {
    Atomics.store(this.sharedStates, SharedStates.IS_PLAYING, 1);
  }

  GetSharedBuffers() {
    if (this.sharedAudiobuffers === null) {
      throw new Error('Not initialized yet');
    }
    return {
      sharedAudiobuffers: this.sharedAudiobuffers,
      sharedCommBuffer: this.sharedCommBuffer,
    };
  }

  Clear() {
    this.sharedAudiobuffers = null;
    this.size = -1;
    this.sampleIndexToTS = null;
    this.contextFrequency = -1;
    this.lastTimestamp = undefined;

    Atomics.store(this.sharedStates, SharedStates.AUDIO_BUFF_START, -1);
    Atomics.store(this.sharedStates, SharedStates.AUDIO_BUFF_END, -1);
    Atomics.store(this.sharedStates, SharedStates.AUDIO_INSERTED_SILENCE_MS, 0);
    Atomics.store(this.sharedStates, SharedStates.IS_PLAYING, 0);
  }

  _cleanUpIndex() {
    if (this.sampleIndexToTS == null) {
      return;
    }
    while (this.sampleIndexToTS.length > this.maxIndexItems) {
      this.sampleIndexToTS.shift();
    }
  }

  // Estimates the PTS of the sample currently under the read cursor (`start`) and
  // prunes index entries the reader has already passed. Finds the most recent
  // frame whose start the reader has consumed, then extrapolates at sample
  // granularity within that frame. Keeps that anchor frame so the clock keeps
  // advancing smoothly between frame boundaries on subsequent calls.
  _updateCurrentTimestamp(start: number, end: number) {
    if (this.sampleIndexToTS == null) {
      return;
    }
    let anchorIndex;
    for (let n = 0; n < this.sampleIndexToTS.length; n++) {
      if (this._isSentSample(this.sampleIndexToTS[n].sampleIndex, start, end)) {
        anchorIndex = n;
      } else if (anchorIndex !== undefined) {
        break; // Entries are ordered: once we pass the sent region we are done.
      }
    }
    if (anchorIndex === undefined) {
      return;
    }
    const anchor = this.sampleIndexToTS[anchorIndex];
    const extraSamplesSent = start - anchor.sampleIndex;
    // Assume ts in microseconds.
    this.lastTimestamp = anchor.ts + (extraSamplesSent * 1000 * 1000) / this.contextFrequency;

    // Drop entries older than the anchor (already consumed); keep the anchor.
    if (anchorIndex > 0) {
      this.sampleIndexToTS = this.sampleIndexToTS.slice(anchorIndex);
    }
  }

  _getUsedSlots(start: number, end: number) {
    if (start === end) {
      return 0;
    } else if (end > start) {
      return end - start;
    } else {
      return this.size - start + end;
    }
  }

  _getFreeSlots(start: number, end: number) {
    return this.size - this._getUsedSlots(start, end);
  }

  _isSentSample(index: number, start: number, end: number) {
    if (start === end) {
      return false;
    } else if (end > start) {
      return index <= start;
    } else {
      return index <= start && index > end;
    }
  }
}
