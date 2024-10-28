/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

'use strict';

import {DEFAULT_AVCC_HEADER_LENGTH, BitReaderHelper, GetUint16FromBufferBe, ParseNAL} from "./avcc_parser.js"

export function ParseAVCDecoderConfigurationRecord(data) {
  if (data == undefined || data == null) {
    return undefined
  }
  const dataBytes = new Uint8Array(data);
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
  };

  let nPos = 0;
  avcVDCR.configurationVersion = dataBytes[nPos++];
  avcVDCR.avcProfileIndication = dataBytes[nPos++];
  avcVDCR.profileCompatibility = dataBytes[nPos++];
  avcVDCR.AVCLevelIndication = dataBytes[nPos++];
  const lengthSizeMinusOne = BitReaderHelper(
    dataBytes.subarray(nPos, nPos + 1),
    6,
    2,
  );
  nPos++;

  // Set AVC header length
  avcVDCR.avcHeaderLengthSize = lengthSizeMinusOne + 1;

  const numOfSequenceParameterSets = BitReaderHelper(
    dataBytes.subarray(nPos, nPos + 1),
    3,
    5,
  );
  nPos++;
  for (let n = 0; n < numOfSequenceParameterSets; n++) {
    const sequenceParameterSetLength = GetUint16FromBufferBe(
      dataBytes.subarray(nPos, nPos + 2),
    );
    nPos += 2;
    const spsNaluData = ParseNAL(
      dataBytes.subarray(nPos, nPos + sequenceParameterSetLength),
    );
    avcVDCR.spsUnits.push(spsNaluData);
    nPos += sequenceParameterSetLength;
  }

  const numOfPictureParameterSets = dataBytes[nPos++];
  for (let n = 0; n < numOfPictureParameterSets; n++) {
    const pictureParameterSetLength = GetUint16FromBufferBe(
      dataBytes.subarray(nPos, nPos + 2),
    );
    nPos += 2;
    const ppsNaluData = ParseNAL(
      dataBytes.subarray(nPos, nPos + pictureParameterSetLength),
    );
    avcVDCR.ppsUnits.push(ppsNaluData);
    nPos += pictureParameterSetLength;
  }

  if (
    avcVDCR.avcProfileIndication !== 66 &&
    avcVDCR.avcProfileIndication !== 77 &&
    avcVDCR.avcProfileIndication !== 88
  ) {
    const chromaFormatNum = BitReaderHelper(
      dataBytes.subarray(nPos, nPos + 1),
      6,
      2,
    );
    nPos++;
    avcVDCR.chromaFormat = chromaFormatNum;

    const bitDepthLumaMinus8 = BitReaderHelper(
      dataBytes.subarray(nPos, nPos + 1),
      5,
      3,
    );
    nPos++;
    avcVDCR.bitDepthLuma = bitDepthLumaMinus8 + 8;
    const bitDepthChromaMinus8 = BitReaderHelper(
      dataBytes.subarray(nPos, nPos + 1),
      5,
      3,
    );
    nPos++;
    avcVDCR.bitDepthChroma = bitDepthChromaMinus8 + 8;

    const numOfSequenceParameterSetExt = dataBytes[nPos++];
    for (let n = 0; n < numOfSequenceParameterSetExt; n++) {
      const sequenceParameterSetExtLength = GetUint16FromBufferBe(
        dataBytes.subarray(nPos, nPos + 2),
      );
      nPos += 2;
      const spsExtNaluData = ParseNAL(
        dataBytes.subarray(nPos, nPos + sequenceParameterSetExtLength),
      );
      avcVDCR.spsExtUnits.push(spsExtNaluData);
      nPos += sequenceParameterSetExtLength;
    }
  }

  return avcVDCR;
}
