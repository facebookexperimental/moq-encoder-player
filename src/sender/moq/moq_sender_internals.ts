/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import { Moq, MoqState, Track, MoqMapping } from '../../moq/moq.js';
import { MOQ_CURRENT_VERSION, MOQ_PUBLISHER_PRIORITY_BASE_DEFAULT } from '../../moq/moqt.js';
import { LOCPackager, type LOCMediaType } from '../../packager/loc_packager.js';
import type { WireDropConfig, WireHoldConfig } from '../../moq/network_simulator.js';

const WORKER_PREFIX = '[MOQ-SENDER]';

// When true, unexpected errors are re-thrown (surfaced in the console).
const DEV_MODE = true;

// A single track to publish (from the `init` message config).
export interface TrackData {
  namespace: string[];
  name: string;
  authInfo?: string;
  maxInFlightRequests?: number;
  maxOpenStreams?: number;
  isHipri?: boolean;
  moqMapping?: string;
  newSubgroupEvery?: number;
  // Optional simulated packet loss on the send path (testing only).
  dropConfig?: WireDropConfig;
  // Optional simulated slowness (hold) on the send path (testing only).
  holdConfig?: WireHoldConfig;
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
  compensatedTs?: number;
  metadata?: any;
  timebase?: number;
  codec?: string;
  moqMapping?: string;
}

/**
 * MoQ publisher Web Worker.
 * MoQ publisher Web Worker. Translates main-thread messages into calls on the
 * high-level MoQ API (src/moq/moq.ts) and packages encoded media with
 * LOCPackager. All MoQ protocol work (session, control loop, subscriptions,
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
        case 'forceDropBurst':
          this.handleForceDropBurst(e.data);
          break;
        case 'forceHoldBurst':
          this.handleForceHoldBurst(e.data);
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
    this.moq.init(this.config.urlHostPort, {
      serverCertificateHash: this.config.certificateHash,
      alpnVersion: MOQ_CURRENT_VERSION,
    });
    console.log(`${WORKER_PREFIX} WT initiating to ${this.config.urlHostPort}`);
    await this.moq.setup(
      this.config.keepAlivesEveryMs > 0 ? { everyMs: this.config.keepAlivesEveryMs } : undefined,
    );
    console.log(`${WORKER_PREFIX} MOQ session established`);

    this.tracks = {};
    if (this.config.usePublishNamespace) {
      // Single PUBLISH_NAMESPACE per namespace; tracks are served lazily when a
      // subscriber SUBSCRIBEs (see offerTrack below).
      await this.publishNamespaceTracks();
    } else {
      // One PUBLISH per track (proactive publication).
      for (const [mediaType, trackData] of Object.entries(this.config.moqTracks)) {
        this.tracks[mediaType] = await this.publishTrack(mediaType, trackData);
        console.log(
          `${WORKER_PREFIX} Published track ${mediaType} (${trackData.namespace}/${trackData.name})`,
        );
      }
    }

    console.log(`${WORKER_PREFIX} MOQ Initialized, waiting for subscriptions`);
  }

  private async publishTrack(mediaType: string, trackData: TrackData): Promise<Track> {
    const track = await this.moq!.addTrack(
      trackData.namespace,
      trackData.name,
      trackData.maxInFlightRequests ?? Number.MAX_SAFE_INTEGER,
      trackData.maxOpenStreams ?? Number.MAX_SAFE_INTEGER,
      trackData.authInfo,
      trackData.moqMapping as MoqMapping,
    );
    this.applyWireImpairments(mediaType, track, trackData);
    return track;
  }

  // Attach the optional simulated-impairment policies (testing) to a freshly
  // created track: simulated loss (drop) routed to the dropped-stats UI, and
  // simulated slowness (hold).
  private applyWireImpairments(mediaType: string, track: Track, trackData: TrackData): void {
    track.setWireDropConfig(trackData.dropConfig ?? null);
    track.setWireHoldConfig(trackData.holdConfig ?? null);
    track.onWireDrop = (obj) => {
      const info = obj.getInfo();
      this.emitDropped(
        info.objId,
        undefined,
        `simulated wire drop (${info.groupId}/${info.objId})`,
        mediaType,
      );
    };
  }

  // Announce each unique namespace once with PUBLISH_NAMESPACE, then register a
  // track offer per media type. The Track for a media type is created (and stored
  // in this.tracks) only once a peer subscribes to it; until then handleChunk
  // drops chunks for that media type.
  private async publishNamespaceTracks(): Promise<void> {
    // Register offers first so a SUBSCRIBE that races the announce still matches.
    for (const [mediaType, trackData] of Object.entries(this.config!.moqTracks)) {
      this.moq!.offerTrack({
        namespace: trackData.namespace,
        name: trackData.name,
        maxQueuedObjects: trackData.maxInFlightRequests ?? Number.MAX_SAFE_INTEGER,
        maxOpenStreams: trackData.maxOpenStreams ?? Number.MAX_SAFE_INTEGER,
        moqMapping: trackData.moqMapping as MoqMapping,
        authInfo: trackData.authInfo,
        onSubscribed: (track) => {
          this.tracks[mediaType] = track;
          this.applyWireImpairments(mediaType, track, trackData);
          console.log(`${WORKER_PREFIX} Serving ${mediaType} track (subscriber joined)`);
        },
        onUnsubscribed: () => {
          delete this.tracks[mediaType];
          console.log(`${WORKER_PREFIX} Stopped serving ${mediaType} track (subscriber left)`);
        },
      });
    }

    // Announce each distinct namespace a single time.
    const announced = new Set<string>();
    for (const trackData of Object.values(this.config!.moqTracks)) {
      const nsKey = trackData.namespace.join('/');
      if (announced.has(nsKey)) {
        continue;
      }
      announced.add(nsKey);
      await this.moq!.publishNamespace(trackData.namespace, trackData.authInfo);
      console.log(`${WORKER_PREFIX} Published namespace [${nsKey}]`);
    }
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
      this.emitDropped(
        data.seqId,
        data.chunk?.timestamp,
        'transport is NOT open yet',
        data.mediaType,
      );
      return;
    }

    const track = this.tracks[data.mediaType];
    if (track === undefined) {
      // In PUBLISH_NAMESPACE mode a track exists only once a subscriber has
      // subscribed; drop until then instead of erroring.
      this.emitDropped(
        data.seqId,
        data.chunk?.timestamp,
        'track not subscribed yet',
        data.mediaType,
      );
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
    const obj = track.sendObject(
      packet.PayloadToBytes(),
      newGroupOptions,
      packet.Properties(),
      () => {
        if (this.verbose) {
          console.debug(
            `${WORKER_PREFIX} SENT ${data.mediaType} seqId ${seqId} (${obj.getInfo().groupId}/${obj.getInfo().objId})`,
          );
        }
      },
    );

    if (obj.getInfo().status === 'dropped') {
      this.emitDropped(
        seqId,
        chunkData.chunk?.timestamp,
        'too many inflight requests',
        data.mediaType,
      );
    }

    if (this.config?.isSendingStats) {
      this.emitStats();
    }
  }

  // Normalize the raw chunk message into the shape the packager path expects.
  private normalizeChunk(data: ChunkMessage): any {
    const trackCfg = this.config?.moqTracks[data.mediaType];
    return {
      mediaType: data.mediaType,
      // The LOC Timestamp is a vi64, and numberToVarInt cannot encode negatives.
      compensatedTs:
        data.compensatedTs === undefined || data.compensatedTs < 0 ? 0 : data.compensatedTs,
      seqId: data.seqId ?? 0,
      chunk: data.chunk,
      metadata: data.metadata,
      timebase: data.timebase,
      codec: data.codec,
      newSubgroupEvery: trackCfg?.newSubgroupEvery,
    };
  }

  // Wrap a media chunk into a LOC packet.
  private packetizeChunk(chunkData: any): LOCPackager {
    if (
      chunkData.mediaType !== 'video' &&
      chunkData.mediaType !== 'audio' &&
      chunkData.mediaType !== 'data'
    ) {
      throw new Error(`Not supported media type ${chunkData.mediaType}`);
    }
    const packet = new LOCPackager(chunkData.mediaType as LOCMediaType);

    if (chunkData.mediaType === 'data') {
      // No LOC properties: the payload is opaque and its group boundaries are
      // driven by the track config rather than by frame types.
      let isDelta = false;
      if (chunkData.newSubgroupEvery > 1) {
        isDelta = chunkData.seqId % chunkData.newSubgroupEvery !== 0;
      }
      packet.SetData(undefined, undefined, undefined, undefined, chunkData.chunk, isDelta);
      return packet;
    }

    const buf = new Uint8Array(chunkData.chunk.byteLength);
    chunkData.chunk.copyTo(buf);
    // Video carries its config (the AVCDecoderConfigurationRecord) on key frames
    // only; audio carries it on every object.
    packet.SetData(
      chunkData.compensatedTs,
      chunkData.timebase,
      chunkData.codec,
      chunkData.metadata ?? undefined,
      buf,
      chunkData.chunk.type === 'delta',
    );
    return packet;
  }

  // -------------------------------------------------------------------------
  // forceDropBurst (manual simulated loss)
  // -------------------------------------------------------------------------

  /** Force-drop the next burst of wire units for one media type, on demand. */
  private handleForceDropBurst(data: any): void {
    const track = this.tracks[data?.mediaType];
    if (track === undefined) {
      // Not publishing / no subscriber yet: nothing to drop.
      return;
    }
    track.forceDropBurst(data?.burst ?? 1);
  }

  /** Force-hold (stall then clump) the next burst for one media type, on demand. */
  private handleForceHoldBurst(data: any): void {
    const track = this.tracks[data?.mediaType];
    if (track === undefined) {
      // Not publishing / no subscriber yet: nothing to hold.
      return;
    }
    track.forceHoldBurst(data?.burst ?? 1);
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
    // Two distinct signals: queuedReq = objects waiting in the send queue (the
    // backpressure cap), openStreamsReq = open QUIC subgroup streams (the meaning
    // the v14 "inflight" stat had; ~1 for subgroup, 0 for datagram).
    const queuedReq: Record<string, number> = {};
    const openStreamsReq: Record<string, number> = {};
    for (const [mediaType, track] of Object.entries(this.tracks)) {
      const info = track.getInfo();
      queuedReq[mediaType] = info.numQueued;
      openStreamsReq[mediaType] = info.numOpenStreams;
    }
    self.postMessage({ type: 'sendstats', clkms: Date.now(), queuedReq, openStreamsReq });
  }
}
