/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import { Moq, type ObjectCallback, type EndOfGroupCallback } from '../../moq/moq.js';
import { MOQ_CURRENT_VERSION, type KvPair } from '../../moq/moqt.js';
import { MIPackager, MIPayloadTypeEnum } from '../../packager/mi_packager.js';
import { sendMessageToMain, convertTimestamp } from '../../utils/utils.js';
import { ContainsNALUSliceIDR, DEFAULT_AVCC_HEADER_LENGTH } from '../../utils/media/avcc_parser.js';

const WORKER_PREFIX = '[MOQ-DOWNLOADER]';

// When true, unexpected errors are re-thrown (surfaced in the console).
const DEV_MODE = true;

// WebCodecs default timebase = 1us.
const DEFAULT_TIMEBASE = 1000000;

// A single track to subscribe to (from the `init` message config).
export interface TrackData {
  namespace: string[];
  name: string;
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
  systemVideoTimebase: number;
  systemAudioTimebase: number;
  verbose: boolean;
}

/**
 * MoQ subscriber Web Worker. Translates main-thread messages into calls on the
 * high-level MoQ API (src/moq/moq.ts) and demuxes received objects with
 * MIPackager into EncodedAudioChunk / EncodedVideoChunk for the player
 * pipeline. All MoQ protocol work (session, control loop, subscriptions,
 * object reception) lives in the `Moq`/`Subscription` classes.
 */
export class MoqReceiver {
  private config: ReceiverConfig | null = null;
  private verbose = false;

  private moq: Moq | null = null;

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
      systemVideoTimebase: cfg.systemVideoTimebase ?? DEFAULT_TIMEBASE,
      systemAudioTimebase: cfg.systemAudioTimebase ?? DEFAULT_TIMEBASE,
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
    for (const track of Object.values(tracks)) {
      if (
        !('namespace' in track) ||
        track.namespace.length <= 0 ||
        !('name' in track) ||
        !('authInfo' in track)
      ) {
        return 'Track malformed, needs to contain namespace, name, and authInfo';
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
        this.objectHandler(),
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

  // Build the per-object callback handed to Moq.subscribe.
  private objectHandler(): ObjectCallback {
    return (reader, extensionHeaders, length, groupId, objectId, isLastInGroup) =>
      this.handleObject(reader, extensionHeaders, length, groupId, objectId, isLastInGroup);
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
    reader: ReadableStream<Uint8Array>,
    extensionHeaders: KvPair[],
    length?: number,
    groupId?: number,
    objectId?: number,
    isLastInGroup?: boolean,
  ): Promise<boolean> {
    this.reportStats();

    const packet = new MIPackager();
    await packet.ParseData(reader, extensionHeaders, length);
    const isEOF = packet.IsEof();

    const chunkData: any = packet.GetData();
    if (chunkData == null || chunkData.type === undefined) {
      throw new Error(
        `Corrupted headers, we can NOT parse the data, headers: ${packet.GetDataStr()}`,
      );
    }
    if (this.verbose) {
      sendMessageToMain(WORKER_PREFIX, 'debug', `Decoded MOQT-MI: ${packet.GetDataStr()}`);
    }

    let chunk;
    let appMediaType;
    if (
      chunkData.type === MIPayloadTypeEnum.AudioOpusWCP ||
      chunkData.type === MIPayloadTypeEnum.AudioAACMP4LCWCP
    ) {
      appMediaType = 'audiochunk';
      const timebase = this.config?.systemAudioTimebase ?? DEFAULT_TIMEBASE;
      chunk = new EncodedAudioChunk({
        timestamp: convertTimestamp(chunkData.pts, chunkData.timebase, timebase),
        type: 'key',
        data: chunkData.data,
        duration: convertTimestamp(chunkData.duration, chunkData.timebase, timebase),
      });
    } else if (chunkData.type === MIPayloadTypeEnum.VideoH264AVCCWCP) {
      appMediaType = 'videochunk';
      // Find a NALU SliceIDR to tell whether this is a key or delta frame. We
      // could infer IDR from the MOQT start-of-group, but this is less error
      // prone.
      const isIdr = ContainsNALUSliceIDR(chunkData.data, DEFAULT_AVCC_HEADER_LENGTH);
      const timebase = this.config?.systemVideoTimebase ?? DEFAULT_TIMEBASE;
      chunk = new EncodedVideoChunk({
        timestamp: convertTimestamp(chunkData.pts, chunkData.timebase, timebase),
        type: isIdr ? 'key' : 'delta',
        data: chunkData.data,
        duration: convertTimestamp(chunkData.duration, chunkData.timebase, timebase),
      });
    } else if (chunkData.type === MIPayloadTypeEnum.RAWData) {
      appMediaType = 'data';
      chunk = chunkData.data;
    }

    self.postMessage({
      type: appMediaType,
      clkms: Date.now(),
      packagerType: chunkData.type,
      captureClkms: chunkData.wallclock,
      // MoQ transport-native ordering keys. The player dejitters/orders on
      // (groupId, objectId). isLastInGroup carries the end-of-group signal inline
      // for datagrams; subgroup streams signal it out of band (endofgroup msg).
      groupId,
      objectId,
      isLastInGroup,
      chunk,
      metadata: chunkData.metadata,
      sampleFreq: chunkData.sampleFreq,
      numChannels: chunkData.numChannels,
    });

    return isEOF;
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
  }
}
