/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import { Moq, MoqState, Track, MoqMapping } from '../../moq/moq.js';
import { MOQ_CURRENT_VERSION, MOQ_PUBLISHER_PRIORITY_BASE_DEFAULT } from '../../moq/moqt.js';
import { MIPackager, MIPayloadTypeEnum } from '../../packager/mi_packager.js';

const WORKER_PREFIX = '[MOQ-SENDER]';

// When true, unexpected errors are re-thrown (surfaced in the console).
const DEV_MODE = true;

// A single track to publish (from the `init` message config).
export interface TrackData {
  namespace: string[];
  name: string;
  authInfo?: string;
  maxInFlightRequests?: number;
  isHipri?: boolean;
  moqMapping?: string;
  newSubgroupEvery?: number;
}

// Configuration passed in the `init` message (formerly `muxerSenderConfig`).
export interface MuxerSenderConfig {
  urlHostPort: string;
  isSendingStats: boolean;
  moqTracks: Record<string, TrackData>;
  keepAlivesEveryMs: number;
  certificateHash: any;
  usePublishNamespace: boolean;
  verbose: boolean;
}

// Decoded media chunk message coming from the main thread.
interface ChunkMessage {
  mediaType: string;
  chunk: any;
  seqId?: number;
  firstFrameClkms?: number;
  compensatedTs?: number;
  estimatedDuration?: number;
  metadata?: any;
  timebase?: number;
  sampleFreq?: number;
  numChannels?: number;
  codec?: string;
  moqMapping?: string;
}

/**
 * MoQ publisher Web Worker.
 * MoQ publisher Web Worker. Translates main-thread messages into calls on the
 * high-level MoQ API (src/moq/moq.ts) and packages encoded media with
 * MIPackager. All MoQ protocol work (session, control loop, subscriptions,
 * object scheduling) lives in the `Moq`/`Track` classes.
 */
export class MoqSender {
  private config: MuxerSenderConfig | null = null;
  private verbose = false;

  private moq: Moq | null = null;
  // Published tracks keyed by mediaType ('audio' | 'video' | 'data').
  private tracks: Record<string, Track> = {};

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
        case 'chunk':
          this.handleChunk(e.data);
          break;
        case 'stop':
          this.handleStop();
          break;
        default:
          console.error(`${WORKER_PREFIX} Unknown message type received: ${type}`);
      }
    } catch (err: any) {
      if (DEV_MODE) {
        throw err;
      }
      console.error(`${WORKER_PREFIX} Error handling message ${type}. Err: ${err?.message}`);
    }
  }

  // -------------------------------------------------------------------------
  // init
  // -------------------------------------------------------------------------

  // Normalize a raw config object into a fully-populated MuxerSenderConfig.
  // Throws an Error if the config is invalid (empty host port or bad tracks).
  private parseSenderConfig(raw: any): MuxerSenderConfig {
    const cfg = raw ?? {};
    const config: MuxerSenderConfig = {
      urlHostPort: typeof cfg.urlHostPort === 'string' ? cfg.urlHostPort : '',
      isSendingStats: cfg.isSendingStats ?? true,
      moqTracks: cfg.moqTracks ?? {},
      keepAlivesEveryMs: cfg.keepAlivesEveryMs ?? 0,
      certificateHash: cfg.certificateHash ?? null,
      usePublishNamespace: cfg.usePublishNamespace ?? false,
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
      return 'Number of Track Ids to publish needs to be > 0';
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

  /** Open the session, publish the tracks and start keep-alive. */
  async handleInit(data: any): Promise<void> {
    if (this.moq !== null) {
      console.error(`${WORKER_PREFIX} Received init while a session already exists`);
      return;
    }

    this.config = this.parseSenderConfig(data.config);
    this.verbose = this.config.verbose;

    // Open the transport and perform the MoQ SETUP handshake. The keep-alive
    // loop (if enabled) is managed by the Moq session itself.
    this.moq = new Moq();
    this.moq.init(this.config.urlHostPort, { serverCertificateHash: this.config.certificateHash, alpnVersion: MOQ_CURRENT_VERSION });
    console.log(`${WORKER_PREFIX} WT initiating to ${this.config.urlHostPort}`);
    await this.moq.setup(this.config.keepAlivesEveryMs > 0 ? { everyMs: this.config.keepAlivesEveryMs } : undefined);
    console.log(`${WORKER_PREFIX} MOQ session established`);

    // Publish each configured track.
    this.tracks = {};
    for (const [mediaType, trackData] of Object.entries(this.config.moqTracks)) {
      this.tracks[mediaType] = await this.publishTrack(mediaType, trackData);
      console.log(`${WORKER_PREFIX} Published track ${mediaType} (${trackData.namespace}/${trackData.name})`);
    }

    console.log(`${WORKER_PREFIX} MOQ Initialized, waiting for subscriptions`);
  }

  private async publishTrack(_mediaType: string, trackData: TrackData): Promise<Track> {
    return this.moq!.addTrack(
      trackData.namespace,
      trackData.name,
      trackData.maxInFlightRequests ?? Number.MAX_SAFE_INTEGER,
      trackData.authInfo,
      trackData.moqMapping as MoqMapping,
    );
  }

  // Audio is sent at higher priority than video (lower value = higher pri).
  private priorityForMediaType(mediaType: string): number {
    return mediaType === 'audio'
      ? MOQ_PUBLISHER_PRIORITY_BASE_DEFAULT - 1
      : MOQ_PUBLISHER_PRIORITY_BASE_DEFAULT;
  }

  // -------------------------------------------------------------------------
  // chunk (media)
  // -------------------------------------------------------------------------

  /** Package one encoded media chunk and hand it to its track. */
  handleChunk(data: ChunkMessage): void {
    if (this.moq === null || this.moq.state !== MoqState.Running) {
      this.emitDropped(data.seqId, data.chunk?.timestamp, 'transport is NOT open yet', data.mediaType);
      return;
    }

    const track = this.tracks[data.mediaType];
    if (track === undefined) {
      console.error(`${WORKER_PREFIX} Invalid chunk: ${data.mediaType} is NOT a published track`);
      return;
    }
    if (track.getInfo().numSubscribers <= 0) {
      this.emitDropped(data.seqId, data.chunk?.timestamp, 'no subscribers', data.mediaType);
      return;
    }

    const chunkData = this.normalizeChunk(data);
    const packet = this.packetizeChunk(chunkData);
    const newGroup = !packet.IsDelta();
    const seqId = chunkData.seqId;

    // Priority only applies when starting a new group.
    const newGroupOptions = newGroup
      ? { priority: this.priorityForMediaType(data.mediaType) }
      : undefined;
    const obj = track.sendObject(packet.PayloadToBytes(), newGroupOptions, packet.ExtensionHeaders(), () => {
      if (this.verbose) {
        console.debug(
          `${WORKER_PREFIX} SENT ${data.mediaType} seqId ${seqId} (${obj.getInfo().groupId}/${obj.getInfo().objId})`,
        );
      }
    });

    if (obj.getInfo().status === 'dropped') {
      this.emitDropped(seqId, chunkData.chunk?.timestamp, 'too many inflight requests', data.mediaType);
    }

    if (this.config?.isSendingStats) {
      this.emitStats();
    }
  }

  // Normalize the raw chunk message into the shape the packager path expects.
  private normalizeChunk(data: ChunkMessage): any {
    const nonNeg = (v: number | undefined) => (v === undefined || v < 0 ? 0 : v);
    const trackCfg = this.config?.moqTracks[data.mediaType];
    return {
      mediaType: data.mediaType,
      firstFrameClkms: nonNeg(data.firstFrameClkms),
      compensatedTs: nonNeg(data.compensatedTs),
      estimatedDuration:
        data.estimatedDuration === undefined || data.estimatedDuration < 0
          ? data.chunk?.duration
          : data.estimatedDuration,
      seqId: data.seqId ?? 0,
      chunk: data.chunk,
      metadata: data.metadata,
      timebase: data.timebase,
      sampleFreq: data.sampleFreq,
      numChannels: data.numChannels,
      codec: data.codec,
      newSubgroupEvery: trackCfg?.newSubgroupEvery,
    };
  }

  // Wrap a media chunk into an MIPackager packet.
  private packetizeChunk(chunkData: any): MIPackager {
    const packet = new MIPackager();
    if (chunkData.mediaType === 'video') {
      const buf = new Uint8Array(chunkData.chunk.byteLength);
      chunkData.chunk.copyTo(buf);
      const avcDecoderConfig = chunkData.metadata != null ? chunkData.metadata : undefined;
      // Assuming NO B-Frames (pts === dts).
      packet.SetData(
        MIPayloadTypeEnum.VideoH264AVCCWCP,
        chunkData.seqId,
        chunkData.compensatedTs,
        chunkData.timebase,
        chunkData.estimatedDuration,
        chunkData.firstFrameClkms,
        buf,
        chunkData.compensatedTs,
        avcDecoderConfig,
        undefined,
        undefined,
        chunkData.chunk.type === 'delta',
      );
    } else if (chunkData.mediaType === 'audio') {
      const buf = new Uint8Array(chunkData.chunk.byteLength);
      chunkData.chunk.copyTo(buf);
      const payloadType =
        chunkData.codec === 'opus'
          ? MIPayloadTypeEnum.AudioOpusWCP
          : MIPayloadTypeEnum.AudioAACMP4LCWCP;
      packet.SetData(
        payloadType,
        chunkData.seqId,
        chunkData.compensatedTs,
        chunkData.timebase,
        chunkData.estimatedDuration,
        chunkData.firstFrameClkms,
        buf,
        undefined,
        undefined,
        chunkData.sampleFreq,
        chunkData.numChannels,
        chunkData.chunk.type === 'delta',
      );
    } else if (chunkData.mediaType === 'data') {
      let isDelta = false;
      if (chunkData.newSubgroupEvery > 1) {
        isDelta = chunkData.seqId % chunkData.newSubgroupEvery !== 0;
      }
      packet.SetData(
        MIPayloadTypeEnum.RAWData,
        chunkData.seqId,
        undefined,
        undefined,
        undefined,
        undefined,
        chunkData.chunk,
        undefined,
        undefined,
        undefined,
        undefined,
        isDelta,
      );
    } else {
      throw new Error(`Not supported media type ${chunkData.mediaType}`);
    }
    return packet;
  }

  // -------------------------------------------------------------------------
  // stop
  // -------------------------------------------------------------------------

  /** Stop publishing and close the session. */
  handleStop(): void {
    this.moq?.close();
    this.moq = null;
    this.tracks = {};
  }

  // -------------------------------------------------------------------------
  // Messages to the main thread (data only — logging goes to the console)
  // -------------------------------------------------------------------------

  private emitDropped(
    seqId: number | undefined,
    ts: number | undefined,
    msg: string,
    mediaType: string,
  ): void {
    self.postMessage({
      type: 'dropped',
      data: { clkms: Date.now(), seqId, mediaType, ts, msg: `Dropped chunk because ${msg}` },
    });
  }

  private emitStats(): void {
    const inFlightReq: Record<string, number> = {};
    for (const [mediaType, track] of Object.entries(this.tracks)) {
      inFlightReq[mediaType] = track.getInfo().numInFlight;
    }
    self.postMessage({ type: 'sendstats', clkms: Date.now(), inFlightReq });
  }
}
