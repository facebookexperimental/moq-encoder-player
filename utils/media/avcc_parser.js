/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

export const DEFAULT_AVCC_HEADER_LENGTH = 4;

export function BitReaderHelper(buf, bitPos, numBits) {
    let ret = 0;
    let internalBytePos = Math.floor(bitPos / 8);
    let internalBitPos = 7 - (bitPos % 8);
  
    for (let n = 0; n < numBits; n++) {
      const bit =
        (buf[internalBytePos] & parseInt(Math.pow(2, internalBitPos), 10)) > 0
          ? 1
          : 0;
      ret = (ret << 1) | bit;
      
      internalBitPos--;
      if (internalBitPos < 0) {
        internalBytePos++;
        internalBitPos = 7;
      }
    }
    return ret;
  }
  
export function GetUint16FromBufferBe(data) {
    return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint16(
        0,
        false,
    );
}
  
export function ParseNAL(data) {
    const naluData = {
        nalType: -1,
        offset: data.byteOffset, 
        length: data.byteLength
    };

    const nalTypeNum = BitReaderHelper(data, 3, 5);
    naluData.nalType = nalTypeNum

    return naluData;
}

export function ParseH264NALs(dataBytes, avccHeaderLengthSize) {
    if (dataBytes == undefined || dataBytes == null) {
        return undefined
    }
    const h264AvccStreamData = [];
  
    let nPos = 0;
    while (nPos + avccHeaderLengthSize < dataBytes.byteLength) {
      const naluSize = BitReaderHelper(
        dataBytes.subarray(nPos, nPos + avccHeaderLengthSize),
        0,
        avccHeaderLengthSize * 8,
      );
      nPos += avccHeaderLengthSize;
      if (nPos + naluSize <= dataBytes.byteLength) {
        const nalu = ParseNAL(dataBytes.subarray(nPos, nPos + naluSize));
        h264AvccStreamData.push(nalu);
      } else {
        throw new Error(
          `NALU size indicates an offset bigger than data buffer. Buffer size ${
            dataBytes.byteLength
          }, requested: ${nPos + naluSize}`,
        );
      }
      nPos += naluSize;
    }
  
    return h264AvccStreamData;
  }