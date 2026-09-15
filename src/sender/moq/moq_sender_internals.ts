/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import { Moq, MoqState, Track, MoqMapping } from '../../moq/moq.js';
import {
  MOQ_CURRENT_VERSION,
  MOQ_MAPPING_OBJECT_PER_DATAGRAM,
  MOQ_PUBLISHER_PRIORITY_BASE_DEFAULT,
} from '../../moq/moqt.js';
import { type LOCMediaType } from '../../packager/loc_packager.js';
import {
  createPackager,
  type MediaPackager,
  type PackagerFormat,
} from '../../packager/media_packager.js';
import type { WireDropConfig, WireHoldConfig } from '../../moq/network_simulator.js';
import {
  MediaDumper,
  MEDIA_DUMP_DEFAULT_MEDIA_TYPES,
  MEDIA_DUMP_DEFAULT_MAX_OBJECTS,
  type MediaDumpConfig,
} from '../../utils/media_dumper.js';

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
  // Media packaging format for every track: LOC (default) or CMAF.
  packagerFormat: PackagerFormat;
  // Off by default. See MediaDumpConfig.
  mediaDump: MediaDumpConfig;
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
  // Optional capture of the packaged objects to a local file (debug aid).
  private dumper: MediaDumper | null = null;
  // Encoded media bytes written per group, keyed by media type then group id.
  // The packaging overhead of a group is what the track counted as payload minus
  // this (see emitSubgroupBytes).
  private groupMediaBytes: Record<string, Map<number, number>> = {};
  // Last group already reported per media type, so each subgroup is reported once.
  private reportedGroup: Record<string, number> = {};

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
        case 'armMediaDump':
          this.handleArmMediaDump(e.data);
          break;
        case 'dumpMedia':
          this.handleDumpMedia(e.data);
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
      mediaDump: {
        enabled: cfg.mediaDump?.enabled === true,
        mediaTypes: cfg.mediaDump?.mediaTypes ?? MEDIA_DUMP_DEFAULT_MEDIA_TYPES,
        maxObjects: cfg.mediaDump?.maxObjects ?? MEDIA_DUMP_DEFAULT_MAX_OBJECTS,
        maxDurationMs: cfg.mediaDump?.maxDurationMs ?? 0,
      },
      verbose: cfg.verbose ?? false,
    };
    if (config.urlHostPort === '') {
      throw new Error('Empty host port');
    }
    const trackErr =
      this.checkTrackData(config.moqTracks) ??
      checkPackagerMappings(config.packagerFormat, config.moqTracks);
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
    this.startConfiguredDump();

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
    const capturing = this.dumper?.isArmed(data.mediaType) === true;
    if (blockedReason !== undefined && !capturing) {
      this.emitDropped(data.seqId, data.chunk?.timestamp, blockedReason, data.mediaType);
      return;
    }

    const chunkData = this.normalizeChunk(data);
    const newGroup = startsNewGroup(chunkData);
    const packet = this.packetizeChunk(chunkData, newGroup);
    const seqId = chunkData.seqId;
    const payload = packet.PayloadToBytes();
    this.dumper?.capture(data.mediaType, payload, newGroup, chunkTimestampMs(data));

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
    // Media bytes as the encoder produced them: everything the packager added on
    // top is overhead (see emitSubgroupBytes).
    const mediaBytes = chunkData.chunk?.byteLength ?? 0;
    const obj = track.sendObject(payload, newGroupOptions, packet.Properties(), (sent) => {
      // Only objects that reached the wire are accounted for, so the numbers
      // match what the track counted.
      const info = sent.getInfo();
      this.accountSentObject(data.mediaType, info.groupId, mediaBytes);
      if (this.verbose) {
        console.debug(
          `${WORKER_PREFIX} SENT ${data.mediaType} seqId ${seqId} (${info.groupId}/${info.objId})`,
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
      this.emitSubgroupBytes();
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

  // Wrap a media chunk into a LOC or CMAF packet. `startsGroup` is the transport
  // grouping decision (see startsNewGroup), which the packager needs because it
  // does not always match "this frame is a key frame": several audio frames can
  // share one group.
  private packetizeChunk(chunkData: any, startsGroup: boolean): MediaPackager {
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
      packet.SetData(undefined, undefined, undefined, undefined, chunkData.chunk, !startsGroup);
      return packet;
    }

    const buf = new Uint8Array(chunkData.chunk.byteLength);
    chunkData.chunk.copyTo(buf);
    packet.SetSourceInfo?.({
      codedWidth: chunkData.codedWidth,
      codedHeight: chunkData.codedHeight,
      durationUs: chunkData.durationUs,
      startsGroup,
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
  // Media dump to a local file (debug aid for the encoder demo)
  // -------------------------------------------------------------------------

  // Create the dumper and arm the captures asked for by the `init` config.
  private startConfiguredDump(): void {
    this.dumper = new MediaDumper(this.config!.packagerFormat, (file) => {
      self.postMessage({ type: 'mediadump', ...file }, [file.data.buffer] as any);
    });
    this.dumper.armFromConfig(this.config!.mediaDump);
  }

  /**
   * Start capturing packaged object payloads for one media type. Capture only
   * begins on the next group boundary, so what is captured is decodable on its
   * own (for CMAF it starts with a CMAF Header).
   */
  private handleArmMediaDump(data: any): void {
    if (this.dumper === null) {
      console.error(`${WORKER_PREFIX} Can NOT arm a dump before the session is initialized`);
      return;
    }
    this.dumper.arm(data?.mediaType ?? 'video', data?.maxObjects, data?.maxDurationMs);
  }

  /** Hand the captured bytes back to the main thread and disarm the capture. */
  private handleDumpMedia(data: any): void {
    this.dumper?.flush(data?.mediaType ?? 'video');
  }

  // -------------------------------------------------------------------------
  // stop
  // -------------------------------------------------------------------------

  /** Stop publishing and close the session. */
  handleStop(): void {
    // Save whatever the debug capture collected before tearing the session down.
    this.dumper?.flushAll();
    this.dumper = null;
    this.moq?.close();
    this.moq = null;
    this.tracks = {};
    this.packagers = {};
    this.groupMediaBytes = {};
    this.reportedGroup = {};
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

  // Remember the encoded media bytes of an object that reached the wire, against
  // the group it went out in.
  private accountSentObject(mediaType: string, groupId: number, mediaBytes: number): void {
    let groups = this.groupMediaBytes[mediaType];
    if (groups === undefined) {
      groups = new Map();
      this.groupMediaBytes[mediaType] = groups;
    }
    groups.set(groupId, (groups.get(groupId) ?? 0) + mediaBytes);
  }

  /**
   * Report what the last finished subgroup cost, per track, once each.
   *
   * payload  = the encoded media bytes the encoder produced
   * overhead = everything added on top of them to put that subgroup on the wire:
   *            the packager (CMSF boxes and the periodic CMAF Header; LOC adds
   *            nothing to the payload) plus the MoQ signaling the track counted
   *            (subgroup header, per-object headers, object properties,
   *            end-of-group marker).
   */
  private emitSubgroupBytes(): void {
    for (const [mediaType, track] of Object.entries(this.tracks)) {
      const subgroup = track.getInfo().lastSubgroup;
      if (subgroup === undefined || subgroup.groupId === this.reportedGroup[mediaType]) {
        continue;
      }
      this.reportedGroup[mediaType] = subgroup.groupId;

      const groups = this.groupMediaBytes[mediaType];
      const payloadBytes = groups?.get(subgroup.groupId) ?? subgroup.payloadBytes;
      // Groups older than the one being reported are done (or were dropped):
      // their media bytes will never be claimed.
      if (groups !== undefined) {
        for (const groupId of groups.keys()) {
          if (groupId <= subgroup.groupId) {
            groups.delete(groupId);
          }
        }
      }
      const packagingBytes = subgroup.payloadBytes - payloadBytes;
      self.postMessage({
        type: 'subgroupbytes',
        clkms: Date.now(),
        mediaType,
        groupId: subgroup.groupId,
        objects: subgroup.objects,
        payloadBytes,
        overheadBytes: packagingBytes + subgroup.signalingBytes,
      });
    }
  }
}

/**
 * CMSF is only published over subgroup streams here. Its objects are
 * self-describing (`styp moof mdat`, plus the CMAF Header on the object that
 * opens a group), and the datagram mapping sends every object on its own,
 * size-limited datagram, so the combination is rejected instead of silently
 * producing a stream no subscriber can initialize.
 */
function checkPackagerMappings(
  format: PackagerFormat,
  tracks: Record<string, TrackData>,
): string | undefined {
  if (format !== 'cmaf') {
    return undefined;
  }
  for (const [mediaType, track] of Object.entries(tracks)) {
    if (track.moqMapping === MOQ_MAPPING_OBJECT_PER_DATAGRAM) {
      return `CMSF can NOT be sent with the "object per datagram" mapping (${mediaType} track), use a subgroup mapping`;
    }
  }
  return undefined;
}

/**
 * Whether a chunk starts a new MoQ group, which is what opens a new subgroup
 * stream. Video groups are GOPs, so a new group starts on every key frame.
 * Audio frames are all independent, so the grouping is a pure transport choice:
 * `newSubgroupEvery` frames share a group (1, the default, gives one group per
 * frame). The opaque `data` track works the same way.
 *
 * This is deliberately NOT "the packager says this is a key frame": grouping
 * several audio frames must not make them look like delta frames to the
 * packagers (CMSF would then mark them as non-sync samples in `trun`).
 */
function startsNewGroup(chunkData: any): boolean {
  if (chunkData.mediaType === 'video') {
    return chunkData.chunk?.type !== 'delta';
  }
  const framesPerGroup = chunkData.newSubgroupEvery;
  if (!(framesPerGroup > 1)) {
    return true;
  }
  return chunkData.seqId % framesPerGroup === 0 && chunkData.chunk?.type !== 'delta';
}

// Media time of a chunk in milliseconds, or undefined when the chunk carries no
// timebase / timestamp (an opaque data track). Only used to cap a dump by
// duration, so it deliberately reads the chunk's OWN timestamp rather than
// `compensatedTs`: the compensated value is relative to a capture anchor shared
// by audio and video and is clamped at 0, so the stream that does not own the
// anchor starts with a run of zeroes and would make the dump overrun its cap.
function chunkTimestampMs(data: ChunkMessage): number | undefined {
  const timestamp = data.chunk?.timestamp;
  if (!(data.timebase! > 0) || typeof timestamp !== 'number') {
    return undefined;
  }
  return (timestamp * 1000) / data.timebase!;
}
