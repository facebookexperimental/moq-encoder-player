/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

// The publisher side of a media packager, and the factory the sender uses to
// pick one. Two formats are implemented:
//
//  * 'loc'  - draft-ietf-moq-loc (see ./loc_packager.ts): the payload is the
//             raw encoded chunk and the metadata rides the MoQ Object
//             Properties. This is the format the player in this repo speaks.
//  * 'cmaf' - draft-wilaw-moq-cmafpackaging (see ./cmaf/cmaf_packager.ts): the
//             payload is a self-describing ISOBMFF fragment and there are no
//             MoQ Object Properties.
//
// Both formats keep the same group structure (a new group starts on every key
// frame), so the choice is invisible to the MoQ / QUIC layer.

import type { KvPair } from '../moq/moqt.js';
import { LOCPackager, LOCgetTrackName, type LOCMediaType } from './loc_packager.js';
import { CMAFPackager } from './cmaf/cmaf_packager.js';

export type PackagerFormat = 'loc' | 'cmaf';

/** Extras a packager may need that are not part of the encoded chunk itself. */
export interface PackagerSourceInfo {
  // Video only: the coded dimensions reported by the encoder.
  codedWidth?: number;
  codedHeight?: number;
  // The WebCodecs chunk duration in microseconds, when the encoder reports one.
  durationUs?: number;
}

/**
 * What the sender needs from a packager to turn one encoded chunk into one MoQ
 * object: set the chunk, then read back the payload and the object properties.
 * (Parsing lives on the receiver side and is LOC specific, so it is not part of
 * this interface.)
 */
export interface MediaPackager {
  SetData(
    timestamp: number | undefined,
    timescale: number | undefined,
    codec: string | undefined,
    config: Uint8Array | ArrayBuffer | undefined,
    data: any,
    isDelta: boolean | undefined,
  ): void;
  PayloadToBytes(): any;
  Properties(): KvPair[];
  IsDelta(): boolean | undefined;
  GetDataStr(): string;
  // Implemented by packagers that need more than the LOC chunk fields.
  SetSourceInfo?(info: PackagerSourceInfo): void;
}

/**
 * One packager instance per media type. CMAF instances are stateful (they carry
 * the `moof` sequence number and the initialization header), so the caller must
 * keep them for the lifetime of the track rather than creating one per chunk.
 *
 * CMAF describes audio and video only, so an opaque `data` track falls back to
 * the LOC packager (which sends the payload through untouched).
 */
export function createPackager(format: PackagerFormat, mediaType: LOCMediaType): MediaPackager {
  if (format === 'cmaf') {
    if (mediaType === 'data') {
      console.warn(
        '[PACKAGER] CMAF does not cover opaque data tracks, packaging this one as LOC instead',
      );
      return new LOCPackager(mediaType);
    }
    return new CMAFPackager(mediaType);
  }
  return new LOCPackager(mediaType);
}

/**
 * MOQT track name for a media type. The same in both formats, so switching
 * packagers does not change the names a subscriber has to ask for.
 */
export function getMediaTrackName(trackPrefix: string, isAudio: boolean): string {
  return LOCgetTrackName(trackPrefix, isAudio);
}
