/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

// The two sides of a media packager — packaging on the publisher, parsing on
// the subscriber — and the factories the sender and the receiver use to pick
// one. Two formats are implemented:
//
//  * 'loc'  - draft-ietf-moq-loc (see ./loc_packager.ts): the payload is the
//             raw encoded chunk and the metadata rides the MoQ Object
//             Properties. This is the format the player in this repo speaks.
//  * 'cmaf' - CMSF, draft-ietf-moq-cmsf (see ./cmaf/cmaf_packager.ts): the
//             payload is a self-describing ISOBMFF fragment and there are no
//             MoQ Object Properties.
//
// Both formats keep the same group structure (a new group starts on every key
// frame), so the choice is invisible to the MoQ / QUIC layer.

import type { KvPair } from '../moq/moqt.js';
import { LOCPackager, LOCgetTrackName, type LOCMediaType } from './loc_packager.js';
import { CMAFPackager } from './cmaf/cmaf_packager.js';
import { CMAFDepackager } from './cmaf/cmaf_depackager.js';

export type PackagerFormat = 'loc' | 'cmaf';

/** Extras a packager may need that are not part of the encoded chunk itself. */
export interface PackagerSourceInfo {
  // Video only: the coded dimensions reported by the encoder.
  codedWidth?: number;
  codedHeight?: number;
  // The WebCodecs chunk duration in microseconds, when the encoder reports one.
  durationUs?: number;
  // Whether this chunk starts a new MoQ group. It is not always "this is a key
  // frame": a track can group several (independent) audio frames per group.
  // Defaults to "not a delta frame" when the sender does not say.
  startsGroup?: boolean;
}

/**
 * What the sender needs from a packager to turn one encoded chunk into one MoQ
 * object: set the chunk, then read back the payload and the object properties.
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

/** One received object, decoded far enough to feed a WebCodecs decoder. */
export interface ParsedMediaData {
  mediaType: LOCMediaType;
  timestamp: number | undefined;
  // Timescale of `timestamp` (ticks per second), as stated by the publisher.
  timescale: number | undefined;
  codec: string | undefined;
  // The WebCodecs decoder `description`.
  config: Uint8Array | ArrayBuffer | undefined;
  data: any;
}

/**
 * The mirror image of MediaPackager: what the receiver needs to turn one MoQ
 * object back into an encoded frame.
 *
 * A depackager instance belongs to ONE track and is kept for the lifetime of
 * the subscription: CMSF spreads its track description over the objects that
 * carry a CMAF Header, so the parser has to remember it. Until one has been
 * received, `GetData()` reports an undefined timescale and the object cannot be
 * decoded.
 */
export interface MediaDepackager {
  ParseData(readerStream: any, properties: KvPair[], payloadLength?: number): Promise<void>;
  GetData(): ParsedMediaData;
  GetDataStr(): string;
  IsDelta(): boolean | undefined;
  IsEof(): boolean;
}

/**
 * One packager instance per media type. CMAF instances are stateful (they carry
 * the `moof` sequence number and the initialization header), so the caller must
 * keep them for the lifetime of the track rather than creating one per chunk.
 *
 * CMAF describes audio and video only, so any other media type (an opaque
 * `data` track) is rejected rather than silently packaged as something else.
 */
export function createPackager(format: PackagerFormat, mediaType: LOCMediaType): MediaPackager {
  if (format === 'cmaf') {
    if (mediaType !== 'audio' && mediaType !== 'video') {
      throw new Error(`CMAF only covers audio and video, it can NOT package a ${mediaType} track`);
    }
    return new CMAFPackager(mediaType);
  }
  return new LOCPackager(mediaType);
}

/**
 * One depackager instance per subscribed track, kept for the lifetime of the
 * subscription (see MediaDepackager). Like createPackager, CMAF covers audio
 * and video only.
 */
export function createDepackager(format: PackagerFormat, mediaType: LOCMediaType): MediaDepackager {
  if (format === 'cmaf') {
    if (mediaType !== 'audio' && mediaType !== 'video') {
      throw new Error(`CMAF only covers audio and video, it can NOT parse a ${mediaType} track`);
    }
    return new CMAFDepackager(mediaType);
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
