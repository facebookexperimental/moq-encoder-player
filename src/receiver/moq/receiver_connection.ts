/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import {
  Moq,
  type Subscription,
  type ObjectCallback,
  type EndOfGroupCallback,
} from '../../moq/moq.js';
import { MOQ_CURRENT_VERSION, MOQ_FORWARD_FALSE, type KvPair } from '../../moq/moqt.js';
import { type LOCMediaType } from '../../packager/loc_packager.js';
import {
  createDepackager,
  type MediaDepackager,
  type ParsedMediaData,
} from '../../packager/media_packager.js';
import { sendMessageToMain, convertTimestamp } from '../../utils/utils.js';
import type { ReceiverConfig } from './moq_receiver_internals.js';

const WORKER_PREFIX = '[MOQ-DOWNLOADER]';

// Which relay a connection (and every message it posts) belongs to.
export type RelayLabel = 'main' | 'backup';

/**
 * One MoQ subscribing session against one relay. Connections share nothing (not
 * even depackagers, which are stateful per stream), so a slow or dead relay
 * never delays another one. Every object is posted tagged with the relay; the
 * player de-duplicates them in its jitter buffers.
 */
export class ReceiverConnection {
  readonly label: RelayLabel;
  readonly url: string;

  private config: ReceiverConfig;
  private moq: Moq | null = null;
  // One depackager per media type, kept for the lifetime of the subscription:
  // the CMSF one is stateful (it remembers the CMAF Header).
  private depackagers: Record<string, MediaDepackager> = {};
  private subs: Record<string, Subscription> = {};
  // Media types already reported as "waiting for a CMAF Header", so joining
  // mid-group logs once instead of once per object.
  private waitingForHeader = new Set<string>();
  private closed = false;

  constructor(label: RelayLabel, url: string, config: ReceiverConfig) {
    this.label = label;
    this.url = url;
    this.config = config;
  }

  /**
   * Open the session and subscribe to the configured tracks. Never rejects: a
   * failure only takes this connection down, it is logged and the other
   * connections go on.
   */
  async start(): Promise<void> {
    try {
      this.moq = new Moq();
      this.moq.init(this.url, {
        serverCertificateHash: this.config.certificateHash,
        alpnVersion: MOQ_CURRENT_VERSION,
      });
      await this.moq.setup();
      this.log('info', `MOQ session established with ${this.url}`);

      // Subscribe to each configured track. Objects are routed to onObject by
      // the negotiated track alias.
      for (const [mediaType, trackData] of Object.entries(this.config.moqTracks)) {
        if (this.closed) {
          return;
        }
        const forward =
          this.label === 'backup' && this.config.backupMode === 'hot-cold'
            ? MOQ_FORWARD_FALSE
            : undefined;
        this.subs[mediaType] = await this.moq.subscribe(
          trackData.namespace,
          trackData.name,
          trackData.authInfo,
          this.objectHandler(mediaType as LOCMediaType),
          this.endOfGroupHandler(mediaType),
          forward,
        );
        this.log(
          'info',
          `Subscribed to track ${mediaType} (${trackData.namespace}/${trackData.name})`,
        );
      }
      this.log('info', 'MOQ Initialized');
    } catch (err: any) {
      if (!this.closed) {
        this.log('error', `Can NOT subscribe from ${this.url}. Err: ${err?.message}`);
      }
    }
  }

  async setForward(mediaType: string, forward: number): Promise<void> {
    if (this.moq === null) {
      throw new Error(`${this.label} relay has no active MoQ session`);
    }
    const sub = this.subs[mediaType];
    if (sub === undefined) {
      throw new Error(`${this.label} relay has no ${mediaType} subscription`);
    }
    await this.moq.setSubscriptionForward(sub, forward);
  }

  close(): void {
    this.closed = true;
    this.moq?.close();
    this.moq = null;
    this.subs = {};
    this.depackagers = {};
    this.waitingForHeader.clear();
  }

  // -------------------------------------------------------------------------
  // object reception (media)
  // -------------------------------------------------------------------------

  // Build the per-object callback handed to Moq.subscribe. Neither format puts
  // the media type on the wire (that is the catalog's job), so it is bound here
  // from the track config.
  private objectHandler(mediaType: LOCMediaType): ObjectCallback {
    return (reader, extensionHeaders, length, groupId, objectId, isLastInGroup) =>
      this.handleObject(
        mediaType,
        reader,
        extensionHeaders,
        length,
        groupId,
        objectId,
        isLastInGroup,
      );
  }

  // Build the end-of-group callback handed to Moq.subscribe. Forwards the MoQ
  // end-of-group signal (group complete, and its last object id) to the main
  // thread, tagged with the track's media type so the player can attribute it to
  // the right jitter buffer. This is out of band from the media chunks because
  // for subgroup streams the signal is retroactive (it trails the last object).
  private endOfGroupHandler(mediaType: string): EndOfGroupCallback {
    return (groupId, lastObjId) => {
      self.postMessage({ type: 'endofgroup', relay: this.label, mediaType, groupId, lastObjId });
    };
  }

  // Demux one received object into an encoded media chunk and post it upstream.
  private async handleObject(
    mediaType: LOCMediaType,
    reader: ReadableStream<Uint8Array>,
    properties: KvPair[],
    length?: number,
    groupId?: number,
    objectId?: number,
    isLastInGroup?: boolean,
  ): Promise<boolean> {
    this.reportStats();

    const packet = this.depackagerFor(mediaType);
    await packet.ParseData(reader, properties, length);
    const isEOF = packet.IsEof();

    const parsed = packet.GetData();
    if (this.config.verbose) {
      this.log(
        'debug',
        `Parsed ${this.config.packagerFormat.toUpperCase()}: ${packet.GetDataStr()}`,
      );
    }
    if (!this.isDecodable(mediaType, parsed)) {
      return isEOF;
    }

    let chunk;
    let appMediaType;
    if (mediaType === 'audio') {
      appMediaType = 'audiochunk';
      chunk = new EncodedAudioChunk({
        timestamp: this.toTrackTimebase(parsed, mediaType),
        type: 'key',
        data: parsed.data,
      });
    } else if (mediaType === 'video') {
      appMediaType = 'videochunk';
      chunk = new EncodedVideoChunk({
        timestamp: this.toTrackTimebase(parsed, mediaType),
        // Both formats mark independent frames (LOC Video Frame Marking, CMSF
        // `trun` sample flags), so we never inspect the payload for an IDR slice.
        type: packet.IsDelta() ? 'delta' : 'key',
        data: parsed.data,
      });
    } else {
      appMediaType = 'data';
      chunk = parsed.data;
    }

    self.postMessage({
      type: appMediaType,
      relay: this.label,
      clkms: Date.now(),
      // MoQ transport-native ordering keys. The player dejitters/orders (and
      // de-duplicates across relays) on (groupId, objectId). isLastInGroup carries
      // the end-of-group signal inline for datagrams; subgroup streams signal it
      // out of band (endofgroup msg).
      groupId,
      objectId,
      isLastInGroup,
      chunk,
      codec: parsed.codec,
      // The WebCodecs decoder description (LOC Video / Audio Config, or the
      // CMAF Header sample entry).
      metadata: parsed.config,
    });

    return isEOF;
  }

  // The depackager for one media type, created on first use and kept for the
  // rest of the session: the CMSF one carries the track description across
  // objects (see MediaDepackager).
  private depackagerFor(mediaType: LOCMediaType): MediaDepackager {
    let depackager = this.depackagers[mediaType];
    if (depackager === undefined) {
      depackager = createDepackager(this.config.packagerFormat, mediaType);
      this.depackagers[mediaType] = depackager;
    }
    return depackager;
  }

  /**
   * A CMSF object that arrives before the first CMAF Header (which the
   * publisher repeats at most once a second) describes neither its timing nor
   * its codec, so it cannot be decoded. That is expected when joining mid-group:
   * skip it and report once per media type instead of failing the session.
   */
  private isDecodable(mediaType: LOCMediaType, parsed: ParsedMediaData): boolean {
    if (mediaType === 'data' || parsed.timescale !== undefined) {
      if (this.waitingForHeader.delete(mediaType)) {
        this.log('info', `Got the ${mediaType} CMAF Header, decoding now`);
      }
      return true;
    }
    if (this.config.packagerFormat !== 'cmaf') {
      return true;
    }
    if (!this.waitingForHeader.has(mediaType)) {
      this.waitingForHeader.add(mediaType);
      this.log(
        'warning',
        `Dropping ${mediaType} objects until a CMAF Header arrives (joined mid-group)`,
      );
    }
    return false;
  }

  // Convert a received timestamp from the publisher's timescale into the
  // timebase this player's pipeline runs the track at.
  private toTrackTimebase(parsed: ParsedMediaData, mediaType: LOCMediaType): number {
    if (parsed.timestamp === undefined || parsed.timescale === undefined) {
      throw new Error(`Received a ${mediaType} object with no timestamp or timescale`);
    }
    return convertTimestamp(
      parsed.timestamp,
      parsed.timescale,
      this.config.moqTracks[mediaType].timebase,
    );
  }

  private reportStats(): void {
    if (this.config.isSendingStats) {
      sendMessageToMain(this.prefix(), 'downloaderstats', { clkms: Date.now() });
    }
  }

  private log(level: string, msg: string): void {
    sendMessageToMain(this.prefix(), level, msg);
  }

  private prefix(): string {
    return `${WORKER_PREFIX}[${this.label}]`;
  }
}
