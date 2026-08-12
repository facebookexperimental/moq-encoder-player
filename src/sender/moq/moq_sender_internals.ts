/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import { Moq, MoqState, Track, MoqMapping } from '../../moq/moq.js';
import { MOQ_CURRENT_VERSION, MOQ_PUBLISHER_PRIORITY_BASE_DEFAULT } from '../../moq/moqt.js';
import { type LOCMediaType } from '../../packager/loc_packager.js';
import {
  createPackager,
  type MediaPackager,
  type PackagerFormat,
} from '../../packager/media_packager.js';
import type { WireDropConfig, WireHoldConfig } from '../../moq/network_simulator.js';
import { concatBuffer } from '../../moq/buffer_utils.js';

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

/**
 * Debug aid: save the packaged CMAF objects to a local file so the stream can be
 * inspected with ffprobe / ffplay / an MP4 analyzer. Disabled unless `enabled`,
 * because it buffers the captured objects in memory.
 *
 * The capture starts on the first group boundary of each media type (so it
 * begins with a CMAF Header) and is handed back to the main thread — as a
 * `cmafdump` message — when `maxObjects` is reached or when the session stops.
 */
export interface CmafDumpConfig {
  enabled: boolean;
  // Media types to capture. Defaults to audio and video.
  mediaTypes?: string[];
  // Cap on the captured objects, so a long session cannot exhaust memory.
  maxObjects?: number;
}

const CMAF_DUMP_DEFAULT_MEDIA_TYPES = ['video', 'audio'];
const CMAF_DUMP_DEFAULT_MAX_OBJECTS = 600;

// Configuration passed in the `init` message (formerly `muxerSenderConfig`).
export interface MuxerSenderConfig {
  urlHostPort: string;
  isSendingStats: boolean;
  moqTracks: Record<string, TrackData>;
  keepAlivesEveryMs: number;
  certificateHash: any;
  usePublishNamespace: boolean;
  // Media packaging format for every track: LOC (default) or CMAF.
  packagerFormat: PackagerFormat;
  // Off by default. See CmafDumpConfig.
  cmafDump: CmafDumpConfig;
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
  // Video only, reported by the encoder. Needed by the CMAF packager to
  // describe the track; LOC ignores them.
  codedWidth?: number;
  codedHeight?: number;
}

/**
 * Debug capture of the packaged bytes for one media type. Only used by the CMAF
 * dump helper in the encoder demo: the capture starts at a group boundary, so
 * the first object carries the CMAF Header and the concatenation of everything
 * captured is a playable fragmented MP4.
 */
interface CmafDumpState {
  maxObjects: number;
  started: boolean;
  chunks: Uint8Array[];
}

/**
 * MoQ publisher Web Worker.
 * MoQ publisher Web Worker. Translates main-thread messages into calls on the
 * high-level MoQ API (src/moq/moq.ts) and packages encoded media with the
 * configured packager (LOC or CMAF, see src/packager/media_packager.ts). All
 * MoQ protocol work (session, control loop, subscriptions, object scheduling)
 * lives in the `Moq`/`Track` classes.
 */
export class MoqSender {
  private config: MuxerSenderConfig | null = null;
  private verbose = false;

  private moq: Moq | null = null;
  // Published tracks keyed by mediaType ('audio' | 'video' | 'data').
  private tracks: Record<string, Track> = {};
  // One packager per media type, kept for the lifetime of the session: the CMAF
  // packager is stateful (sequence numbers, initialization header).
  private packagers: Record<string, MediaPackager> = {};
  // Optional CMAF capture, armed from the demo console (see handleArmCmafDump).
  private cmafDump: Record<string, CmafDumpState> = {};

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
        case 'armCmafDump':
          this.handleArmCmafDump(e.data);
          break;
        case 'dumpCmaf':
          this.handleDumpCmaf(e.data);
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
      packagerFormat: cfg.packagerFormat === 'cmaf' ? 'cmaf' : 'loc',
      cmafDump: {
        enabled: cfg.cmafDump?.enabled === true,
        mediaTypes: cfg.cmafDump?.mediaTypes ?? CMAF_DUMP_DEFAULT_MEDIA_TYPES,
        maxObjects: cfg.cmafDump?.maxObjects ?? CMAF_DUMP_DEFAULT_MAX_OBJECTS,
      },
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

    // Packaging is set up before the transport: chunks are packaged (and
    // captured by the debug dump, if armed) whether or not a session is ever
    // established, so a CMAF file can be produced without a relay.
    this.tracks = {};
    this.packagers = {};
    this.startConfiguredCmafDump();

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

  // Why this chunk cannot be published right now, or undefined when it can.
  private sendBlockedReason(mediaType: string): string | undefined {
    if (this.moq === null || this.moq.state !== MoqState.Running) {
      return 'transport is NOT open yet';
    }
    // In PUBLISH_NAMESPACE mode a track exists only once a subscriber has
    // subscribed; drop until then instead of erroring.
    const track = this.tracks[mediaType];
    if (track === undefined) {
      return 'track not subscribed yet';
    }
    if (track.getInfo().numSubscribers <= 0) {
      return 'no subscribers';
    }
    return undefined;
  }

  /** Package one encoded media chunk and hand it to its track. */
  handleChunk(data: ChunkMessage): void {
    const blockedReason = this.sendBlockedReason(data.mediaType);
    // The debug capture does not depend on the transport: while it is armed the
    // chunk is packaged (and written to the dump) even with no session and no
    // subscriber, so a CMAF file can be produced without a relay.
    const capturing = this.cmafDump[data.mediaType] !== undefined;
    if (blockedReason !== undefined && !capturing) {
      this.emitDropped(data.seqId, data.chunk?.timestamp, blockedReason, data.mediaType);
      return;
    }

    const chunkData = this.normalizeChunk(data);
    const packet = this.packetizeChunk(chunkData);
    const newGroup = !packet.IsDelta();
    const seqId = chunkData.seqId;
    const payload = packet.PayloadToBytes();
    this.captureForDump(data.mediaType, payload, newGroup);

    if (blockedReason !== undefined) {
      // Captured, but there is nowhere to publish it.
      this.emitDropped(seqId, data.chunk?.timestamp, blockedReason, data.mediaType);
      return;
    }
    const track = this.tracks[data.mediaType];

    // Priority only applies when starting a new group.
    const newGroupOptions = newGroup
      ? { priority: this.priorityForMediaType(data.mediaType) }
      : undefined;
    const obj = track.sendObject(payload, newGroupOptions, packet.Properties(), () => {
      if (this.verbose) {
        console.debug(
          `${WORKER_PREFIX} SENT ${data.mediaType} seqId ${seqId} (${obj.getInfo().groupId}/${obj.getInfo().objId})`,
        );
      }
    });

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
      codedWidth: data.codedWidth,
      codedHeight: data.codedHeight,
      // WebCodecs reports a duration for audio and (when the source provides
      // one) for video. The CMAF packager uses it as the sample duration.
      durationUs: data.chunk?.duration ?? undefined,
      newSubgroupEvery: trackCfg?.newSubgroupEvery,
    };
  }

  // The packager for one media type, created on first use. CMAF packagers hold
  // per-track state, so they must not be recreated per chunk; LOC packagers are
  // stateless (SetData overwrites every field) and are reused the same way.
  private packagerFor(mediaType: LOCMediaType): MediaPackager {
    let packager = this.packagers[mediaType];
    if (packager === undefined) {
      packager = createPackager(this.config?.packagerFormat ?? 'loc', mediaType);
      this.packagers[mediaType] = packager;
    }
    return packager;
  }

  // Wrap a media chunk into a LOC or CMAF packet.
  private packetizeChunk(chunkData: any): MediaPackager {
    if (
      chunkData.mediaType !== 'video' &&
      chunkData.mediaType !== 'audio' &&
      chunkData.mediaType !== 'data'
    ) {
      throw new Error(`Not supported media type ${chunkData.mediaType}`);
    }
    const packet = this.packagerFor(chunkData.mediaType as LOCMediaType);

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
    packet.SetSourceInfo?.({
      codedWidth: chunkData.codedWidth,
      codedHeight: chunkData.codedHeight,
      durationUs: chunkData.durationUs,
    });
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
  // CMAF dump (debug aid for the encoder demo)
  // -------------------------------------------------------------------------

  // Arm the captures asked for by the `init` config (cmafDump.enabled).
  private startConfiguredCmafDump(): void {
    this.cmafDump = {};
    const dumpConfig = this.config!.cmafDump;
    if (!dumpConfig.enabled) {
      return;
    }
    if (this.config!.packagerFormat !== 'cmaf') {
      console.warn(
        `${WORKER_PREFIX} The CMAF dump is enabled but the packager is ${this.config!.packagerFormat.toUpperCase()}: the captured file will NOT be a valid MP4`,
      );
    }
    for (const mediaType of dumpConfig.mediaTypes!) {
      this.armDump(mediaType, dumpConfig.maxObjects!);
    }
  }

  /**
   * Start capturing packaged object payloads for one media type. Capture only
   * begins on the next group boundary, so what is captured starts with a CMAF
   * Header and can be written straight to a .mp4 file.
   */
  private handleArmCmafDump(data: any): void {
    this.armDump(data?.mediaType ?? 'video', data?.maxObjects ?? CMAF_DUMP_DEFAULT_MAX_OBJECTS);
  }

  private armDump(mediaType: string, maxObjects: number): void {
    this.cmafDump[mediaType] = { maxObjects, started: false, chunks: [] };
    console.log(
      `${WORKER_PREFIX} Armed ${mediaType} dump, capturing up to ${maxObjects} objects from the next group`,
    );
  }

  /** Hand the captured bytes back to the main thread and disarm the capture. */
  private handleDumpCmaf(data: any): void {
    this.emitDump(data?.mediaType ?? 'video');
  }

  // Post the captured bytes to the main thread (which writes the file) and
  // disarm. `skipIfEmpty` is for the automatic dumps, which must stay quiet when
  // there was nothing to capture.
  private emitDump(mediaType: string, skipIfEmpty = false): void {
    const state = this.cmafDump[mediaType];
    if (skipIfEmpty && (state === undefined || state.chunks.length <= 0)) {
      return;
    }
    delete this.cmafDump[mediaType];
    const payload = concatBuffer(state?.chunks ?? []);
    console.log(
      `${WORKER_PREFIX} Dumping ${state?.chunks.length ?? 0} ${mediaType} objects (${payload.byteLength} bytes)`,
    );
    self.postMessage({ type: 'cmafdump', mediaType, data: payload }, [payload.buffer] as any);
  }

  private captureForDump(mediaType: string, payload: any, newGroup: boolean): void {
    const state = this.cmafDump[mediaType];
    if (state === undefined || !(payload instanceof Uint8Array)) {
      return;
    }
    if (!state.started) {
      if (!newGroup) {
        return;
      }
      state.started = true;
    }
    // The payload is handed to the transport as-is, so keep a copy.
    state.chunks.push(new Uint8Array(payload));
    if (state.chunks.length >= state.maxObjects) {
      console.log(
        `${WORKER_PREFIX} ${mediaType} dump reached its ${state.maxObjects} object cap, saving it now (the rest of the session is NOT captured)`,
      );
      this.emitDump(mediaType);
    }
  }

  // -------------------------------------------------------------------------
  // stop
  // -------------------------------------------------------------------------

  /** Stop publishing and close the session. */
  handleStop(): void {
    // Save whatever the debug capture collected before tearing the session down.
    for (const mediaType of Object.keys(this.cmafDump)) {
      this.emitDump(mediaType, true);
    }
    this.moq?.close();
    this.moq = null;
    this.tracks = {};
    this.packagers = {};
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
