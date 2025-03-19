/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

'use strict';

import { concatBuffer } from '../buffer_utils.js'

import { DEFAULT_AVCC_HEADER_LENGTH, BitReaderHelper, GetUint16FromBufferBe } from "./avcc_parser.js"

export function createAVCDecoderConfigurationRecord(spsData, ppsData, avccHeaderLengthSize) {
  if (spsData == undefined || ppsData == undefined || spsData.byteLength < 4) {
    return undefined
  }

  const ret = []

  // Configuration record header (ISO/IEC 14496-15 AVC file format)
  ret.push(new Uint8Array([1])) // configurationVersion 
  ret.push(new Uint8Array([spsData[1]])) // AVCProfileIndication 
  ret.push(new Uint8Array([spsData[2]])) // profile_compatibility 
  ret.push(new Uint8Array([spsData[3]])) // AVCLevelIndication 
  ret.push(new Uint8Array([0xFC | (avccHeaderLengthSize - 1)])) // 6 bits reserved (111111 = 0xFC) + 2 bits NAL length size - 1 
  ret.push(new Uint8Array([0xE0 | 1])) // 3 bits reserved (111 = 0xE0) + 5 bits number of SPS NALUs

  // Write SPS
  const viewSPSLength = new Uint8Array(2)
  const viewSPSLengthView = new DataView(viewSPSLength.buffer)
  viewSPSLengthView.setUint16(0, spsData.byteLength, false)
  ret.push(viewSPSLength) // Size
  ret.push(spsData) // SPS data

  // Write PPS
  ret.push(new Uint8Array([1])) // number of PPS NALUs 
  const viewPPSLength = new Uint8Array(2)
  const viewPPSLengthView = new DataView(viewPPSLength.buffer)
  viewPPSLengthView.setUint16(0, ppsData.byteLength, false)
  ret.push(viewPPSLength) // Size
  ret.push(ppsData) // PPS data

  // Add extended data for high profiles
  const AVCProfileIndication = spsData[1]
  if (AVCProfileIndication != 66 && // Baseline
      AVCProfileIndication != 77 && // Main
      AVCProfileIndication != 88) { // Extended
    // NOT SUPPORTED!
  }

  return concatBuffer([...ret])
}

export function ParseAVCDecoderConfigurationRecord(data) {
  if (data == undefined || data == null) {
    return undefined
  }
  const avcVDCR = {
    configurationVersion: -1,
    avcProfileIndication: -1,
    profileCompatibility: -1,
    AVCLevelIndication: -1,
    avcHeaderLengthSize: DEFAULT_AVCC_HEADER_LENGTH,
    spsUnits: [],
    ppsUnits: [],
    chromaFormat: -1,
    bitDepthLuma: -1,
    bitDepthChroma: -1,
    spsExtUnits: [],
    dataBytes: new Uint8Array(data),
  };

  let nPos = 0;
  avcVDCR.configurationVersion = avcVDCR.dataBytes[nPos++];
  avcVDCR.avcProfileIndication = avcVDCR.dataBytes[nPos++];
  avcVDCR.profileCompatibility = avcVDCR.dataBytes[nPos++];
  avcVDCR.AVCLevelIndication = avcVDCR.dataBytes[nPos++];
  const lengthSizeMinusOne = BitReaderHelper(
    avcVDCR.dataBytes.subarray(nPos, nPos + 1),
    6,
    2,
  );
  nPos++;

  // Set AVC header length
  avcVDCR.avcHeaderLengthSize = lengthSizeMinusOne + 1;

  const numOfSequenceParameterSets = BitReaderHelper(
    avcVDCR.dataBytes.subarray(nPos, nPos + 1),
    3,
    5,
  );
  nPos++;
  for (let n = 0; n < numOfSequenceParameterSets; n++) {
    const sequenceParameterSetLength = GetUint16FromBufferBe(
      avcVDCR.dataBytes.subarray(nPos, nPos + 2),
    );
    nPos += 2;
    const spsNaluData = avcVDCR.dataBytes.subarray(nPos, nPos + sequenceParameterSetLength);
    avcVDCR.spsUnits.push(spsNaluData);
    nPos += sequenceParameterSetLength;
  }

  const numOfPictureParameterSets = avcVDCR.dataBytes[nPos++];
  for (let n = 0; n < numOfPictureParameterSets; n++) {
    const pictureParameterSetLength = GetUint16FromBufferBe(
      avcVDCR.dataBytes.subarray(nPos, nPos + 2),
    );
    nPos += 2;
    const ppsNaluData = avcVDCR.dataBytes.subarray(nPos, nPos + pictureParameterSetLength);
    avcVDCR.ppsUnits.push(ppsNaluData);
    nPos += pictureParameterSetLength;
  }

  if (
    avcVDCR.avcProfileIndication !== 66 &&
    avcVDCR.avcProfileIndication !== 77 &&
    avcVDCR.avcProfileIndication !== 88
  ) {
    const chromaFormatNum = BitReaderHelper(
      avcVDCR.dataBytes.subarray(nPos, nPos + 1),
      6,
      2,
    );
    nPos++;
    avcVDCR.chromaFormat = chromaFormatNum;

    const bitDepthLumaMinus8 = BitReaderHelper(
      avcVDCR.dataBytes.subarray(nPos, nPos + 1),
      5,
      3,
    );
    nPos++;
    avcVDCR.bitDepthLuma = bitDepthLumaMinus8 + 8;
    const bitDepthChromaMinus8 = BitReaderHelper(
      avcVDCR.dataBytes.subarray(nPos, nPos + 1),
      5,
      3,
    );
    nPos++;
    avcVDCR.bitDepthChroma = bitDepthChromaMinus8 + 8;

    const numOfSequenceParameterSetExt = avcVDCR.dataBytes[nPos++];
    for (let n = 0; n < numOfSequenceParameterSetExt; n++) {
      const sequenceParameterSetExtLength = GetUint16FromBufferBe(
        avcVDCR.dataBytes.subarray(nPos, nPos + 2),
      );
      nPos += 2;
      const spsExtNaluData = avcVDCR.dataBytes.subarray(nPos, nPos + sequenceParameterSetExtLength);
      avcVDCR.spsExtUnits.push(spsExtNaluData);
      nPos += sequenceParameterSetExtLength;
    }
  }

  return avcVDCR;
}

export function GetVideoCodecStringFromAVCDecoderConfigurationRecord(avcDecoderConfigurationRecord) {
  return GetVideoCodecStringFromProfileLevel("avc1", avcDecoderConfigurationRecord.avcProfileIndication, avcDecoderConfigurationRecord.AVCLevelIndication);
}

export function GetVideoCodecStringFromProfileLevel(codec, profile, level) {
  return codec + "." + profile.toString(16).toUpperCase().padStart(2, '0') + "00" + level.toString(16).toUpperCase().padStart(2, '0');
}