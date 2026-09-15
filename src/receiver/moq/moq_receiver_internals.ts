/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import { Moq, type ObjectCallback, type EndOfGroupCallback } from '../../moq/moq.js';
import { MOQ_CURRENT_VERSION, type KvPair } from '../../moq/moqt.js';
import { type LOCMediaType } from '../../packager/loc_packager.js';
import {
  createDepackager,
  type MediaDepackager,
  type PackagerFormat,
  type ParsedMediaData,
} from '../../packager/media_packager.js';
import { sendMessageToMain, convertTimestamp } from '../../utils/utils.js';

const WORKER_PREFIX = '[MOQ-DOWNLOADER]';

// When true, unexpected errors are re-thrown (surfaced in the console).
const DEV_MODE = true;

// A single track to subscribe to (from the `init` message config).
export interface TrackData {
  namespace: string[];
  name: string;
  // Timebase (ticks per second) this player wants the track's timestamps in.
  // Mandatory for audio and video: they may differ, so there is no safe default.
  timebase: number;
  authInfo?: string;
  maxInFlightRequests?: number;
  isHipri?: boolean;
  moqMapping?: string;
}

// Configuration passed in the `init` message (formerly `downloaderConfig`).
export interface ReceiverConfig {
  urlHostPort: string;
  isSendingStats: boolean;
  moqTracks: Record<string, TrackData>;
  certificateHash: any;
  // Packaging the publisher is expected to use on every track: LOC (default) or
  // CMAF / CMSF. There is no catalog to negotiate it, so it is a player setting.
  packagerFormat: PackagerFormat;
  verbose: boolean;
}

/**
 * MoQ subscriber Web Worker. Translates main-thread messages into calls on the
 * high-level MoQ API (src/moq/moq.ts) and parses received objects with the
 * configured depackager (LOC or CMSF, see src/packager/media_packager.ts) into
 * EncodedAudioChunk / EncodedVideoChunk for the player pipeline. All MoQ
 * protocol work (session, control loop, subscriptions, object reception) lives
 * in the `Moq`/`Subscription` classes.
 */
export class MoqReceiver {
  private config: ReceiverConfig | null = null;
  private verbose = false;

  private moq: Moq | null = null;
  // One depackager per media type, kept for the lifetime of the subscription:
  // the CMSF one is stateful (it remembers the CMAF Header).
  private depackagers: Record<string, MediaDepackager> = {};
  // Media types already reported as "waiting for a CMAF Header", so joining
  // mid-group logs once instead of once per object.
  private waitingForHeader = new Set<string>();

  // -------------------------------------------------------------------------
  // Worker message dispatch
  // -------------------------------------------------------------------------

  /** Entry point for the worker shell: routes one message to one handler. */
  async onMessage(e: MessageEvent): Promise<void> {
    const type = e.data?.type;
    try {
      switch (type) {
        case 'init':
          await this.handleInit(e.data);
          break;
        case 'stop':
          this.handleStop();
          break;
        default:
          sendMessageToMain(WORKER_PREFIX, 'error', `Unknown message type received: ${type}`);
      }
    } catch (err: any) {
      if (DEV_MODE) {
        throw err;
      }
      sendMessageToMain(
        WORKER_PREFIX,
        'error',
        `Error handling message ${type}. Err: ${err?.message}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // init
  // -------------------------------------------------------------------------

  // Normalize a raw config object into a fully-populated ReceiverConfig.
  // Throws an Error if the config is invalid (empty host port or bad tracks).
  private parseReceiverConfig(raw: any): ReceiverConfig {
    const cfg = raw ?? {};
    const config: ReceiverConfig = {
      urlHostPort: typeof cfg.urlHostPort === 'string' ? cfg.urlHostPort : '',
      isSendingStats: cfg.isSendingStats ?? false,
      moqTracks: cfg.moqTracks ?? {},
      certificateHash: cfg.certificateHash ?? null,
      packagerFormat: cfg.packagerFormat === 'cmaf' ? 'cmaf' : 'loc',
      verbose: cfg.verbose ?? false,
    };
    if (config.urlHostPort === '') {
      throw new Error('Empty host port');
    }
    const trackErr = this.checkTrackData(config.moqTracks);
    if (trackErr !== undefined) {
      throw new Error(trackErr);
    }
    return config;
  }

  // Validate the per-track config. Returns an error string, or undefined if OK.
  private checkTrackData(tracks: Record<string, TrackData>): string | undefined {
    if (Object.keys(tracks).length <= 0) {
      return 'Number of Track Ids to subscribe needs to be > 0';
    }
    for (const [mediaType, track] of Object.entries(tracks)) {
      if (
        !('namespace' in track) ||
        track.namespace.length <= 0 ||
        !('name' in track) ||
        !('authInfo' in track)
      ) {
        return 'Track malformed, needs to contain namespace, name, and authInfo';
      }
      // Only media tracks are timed; a data track carries no LOC timestamps.
      if (mediaType !== 'data' && !(track.timebase > 0)) {
        return 'Track malformed, needs a timebase (ticks/sec) > 0';
      }
    }
    return undefined;
  }

  /** Open the session and subscribe to the configured tracks. */
  async handleInit(data: any): Promise<void> {
    if (this.moq !== null) {
      sendMessageToMain(WORKER_PREFIX, 'error', 'Received init while a session already exists');
      return;
    }

    this.config = this.parseReceiverConfig(data.config);
    this.verbose = this.config.verbose;

    // Open the transport and perform the MoQ SETUP handshake.
    this.moq = new Moq();
    this.moq.init(this.config.urlHostPort, {
      serverCertificateHash: this.config.certificateHash,
      alpnVersion: MOQ_CURRENT_VERSION,
    });
    await this.moq.setup();
    sendMessageToMain(WORKER_PREFIX, 'info', 'MOQ session established');

    // Subscribe to each configured track. Objects are routed to onObject by the
    // negotiated track alias.
    for (const [mediaType, trackData] of Object.entries(this.config.moqTracks)) {
      await this.moq.subscribe(
        trackData.namespace,
        trackData.name,
        trackData.authInfo,
        this.objectHandler(mediaType as LOCMediaType),
        this.endOfGroupHandler(mediaType),
      );
      sendMessageToMain(
        WORKER_PREFIX,
        'info',
        `Subscribed to track ${mediaType} (${trackData.namespace}/${trackData.name})`,
      );
    }

    sendMessageToMain(WORKER_PREFIX, 'info', 'MOQ Initialized');
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
      self.postMessage({ type: 'endofgroup', mediaType, groupId, lastObjId });
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
    if (this.verbose) {
      sendMessageToMain(
        WORKER_PREFIX,
        'debug',
        `Parsed ${this.config!.packagerFormat.toUpperCase()}: ${packet.GetDataStr()}`,
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
      clkms: Date.now(),
      // MoQ transport-native ordering keys. The player dejitters/orders on
      // (groupId, objectId). isLastInGroup carries the end-of-group signal inline
      // for datagrams; subgroup streams signal it out of band (endofgroup msg).
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
      depackager = createDepackager(this.config!.packagerFormat, mediaType);
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
        sendMessageToMain(WORKER_PREFIX, 'info', `Got the ${mediaType} CMAF Header, decoding now`);
      }
      return true;
    }
    if (this.config!.packagerFormat !== 'cmaf') {
      return true;
    }
    if (!this.waitingForHeader.has(mediaType)) {
      this.waitingForHeader.add(mediaType);
      sendMessageToMain(
        WORKER_PREFIX,
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
      this.config!.moqTracks[mediaType].timebase,
    );
  }

  private reportStats(): void {
    if (this.config?.isSendingStats) {
      sendMessageToMain(WORKER_PREFIX, 'downloaderstats', { clkms: Date.now() });
    }
  }

  // -------------------------------------------------------------------------
  // stop
  // -------------------------------------------------------------------------

  /** Stop subscribing and close the session. */
  handleStop(): void {
    this.moq?.close();
    this.moq = null;
    this.depackagers = {};
    this.waitingForHeader.clear();
  }
}
