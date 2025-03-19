/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

'use strict';

export const DEFAULT_AVCC_HEADER_LENGTH = 4;

const NAL_TYPE_SLICE_IDR = 0x5;

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

export function getSPSandPPSFromNalus(h264AvccStreamData, dataBytes) {
  const ret = { spsData: undefined, ppsData: undefined }
  if (dataBytes == undefined || dataBytes == null || h264AvccStreamData == undefined || h264AvccStreamData == null) {
    return ret
  }
  let dataBytes8b = dataBytes
  if (!(dataBytes instanceof Uint8Array)) {
    dataBytes8b = new Uint8Array(dataBytes)
  }

  let i = 0
  while (i < h264AvccStreamData.length && (ret.spsData == undefined || ret.ppsData == undefined)) {
    const naluData = h264AvccStreamData[i]
    if (naluData.nalType == 7) { // SPS
      ret.spsData = dataBytes8b.subarray(naluData.offset, naluData.offset + naluData.length)
    }
    if (naluData.nalType == 8) { // PPS
      ret.ppsData = dataBytes8b.subarray(naluData.offset, naluData.offset + naluData.length)
    } 
    i++
  }
  return ret
}

export function ParseH264NALs(dataBytes, avccHeaderLengthSize) {
  if (dataBytes == undefined || dataBytes == null) {
      return undefined
  }
  let dataBytes8b = dataBytes
  if (!(dataBytes instanceof Uint8Array)) {
    dataBytes8b = new Uint8Array(dataBytes)
  }
  const h264AvccStreamData = [];

  let nPos = 0;
  while (nPos + avccHeaderLengthSize < dataBytes8b.byteLength) {
    const naluSize = BitReaderHelper(
      dataBytes8b.subarray(nPos, nPos + avccHeaderLengthSize),
      0,
      avccHeaderLengthSize * 8,
    );
    nPos += avccHeaderLengthSize;
    if (nPos + naluSize <= dataBytes8b.byteLength) {
      const nalu = ParseNAL(dataBytes8b.subarray(nPos, nPos + naluSize));
      h264AvccStreamData.push(nalu);
    } else {
      throw new Error(
        `NALU size indicates an offset bigger than data buffer. Buffer size ${
          dataBytes8b.byteLength
        }, requested: ${nPos + naluSize}`,
      );
    }
    nPos += naluSize;
  }

  return h264AvccStreamData;
}

export function ContainsNALUSliceIDR(dataBytes, avccHeaderLengthSize) {
  if (dataBytes == undefined || dataBytes == null) {
    return false;
  }
  const nals = ParseH264NALs(dataBytes, avccHeaderLengthSize);
    let i = 0
    while (i < nals.length) {
      if (nals[i].nalType === NAL_TYPE_SLICE_IDR) {
        return true;
      }
      i++;
    }
    return false;
}
