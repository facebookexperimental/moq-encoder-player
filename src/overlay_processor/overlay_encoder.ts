/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

// Overlays an integer value (e.g. an epoch-ms timestamp) into the top rows of a
// raw video frame by writing bright/dark pixel runs, one run per bit. Paired with
// OverlayDecoder on the player side, this measures glass-to-glass latency without
// any side-channel metadata: the value survives encode/decode as image content.

const DEFAULT_START_LINE = 0;
const DEFAULT_NUM_LINES = 2;
const DEFAULT_BITS_TO_WRITE = 64;
// Marker prefix so the decoder can tell an overlaid frame from ordinary content.
const START_SEQ = '1010';

export class OverlayEncoder {
  startLine: number;
  numLines: number;
  bitsToWrite: number;

  constructor() {
    this.startLine = DEFAULT_START_LINE;
    this.numLines = DEFAULT_NUM_LINES;
    this.bitsToWrite = DEFAULT_BITS_TO_WRITE;
  }

  // Returns a NEW VideoFrame with `data` written into its top rows and closes the
  // input frame. Requires an NV12 raw frame (Y plane first).
  Encode(vFrame: any, data: number): any {
    if (vFrame.format != 'NV12') {
      throw new Error('Only NV12 format supported');
    }
    if (!('codedWidth' in vFrame) || !('codedHeight' in vFrame)) {
      throw new Error('Bad frame format NV12 format supported');
    }
    if (!Number.isInteger(data)) {
      throw new Error('Data to encode in overlay needs to be integer');
    }
    if (vFrame.codedWidth < this.bitsToWrite) {
      throw new Error(
        `Image is to small to encode ${this.bitsToWrite} bits, at least we need ${this.bitsToWrite} width`,
      );
    }
    if (vFrame.codedHeight < this.numLines) {
      throw new Error(`Image is to small to encode data, we need ${this.numLines} height`);
    }

    const mewFramepixelsData = new Uint8Array(
      Math.trunc(vFrame.codedWidth * vFrame.codedHeight * (1 + 1 / 4 + 1 / 4)),
    );

    const copyOptions = {
      layout: [
        { offset: 0, stride: vFrame.codedWidth },
        { offset: vFrame.codedHeight * vFrame.codedWidth, stride: vFrame.codedWidth },
      ],
    };
    vFrame.copyTo(mewFramepixelsData, copyOptions);

    const data_num_bytes_to_write = this.bitsToWrite - START_SEQ.length;
    const data_str_pad = START_SEQ + data.toString(2).padStart(data_num_bytes_to_write, '0');

    const pixelsPerBit = Math.floor(vFrame.codedWidth / this.bitsToWrite);
    // Y is stored at start for NV12
    for (let l = 0; l < this.numLines; l++) {
      const y_byte_offset = l * vFrame.codedWidth;
      for (let x = 0; x < this.bitsToWrite; x++) {
        const base_offset = y_byte_offset + x * pixelsPerBit;
        const val = data_str_pad[x] == '1' ? 255 : 0;
        for (let f = 0; f < pixelsPerBit; f++) {
          mewFramepixelsData[base_offset + f] = val;
        }
      }
    }
    const vNewFrame = new VideoFrame(mewFramepixelsData, vFrame);
    vFrame.close();

    return vNewFrame;
  }
}
