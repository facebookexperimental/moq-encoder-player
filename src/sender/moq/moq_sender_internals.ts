/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import type { ObjectIds } from '../../moq/moq.js';
import {
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
import { RelayConnection, postDropped, type RelayLabel } from './relay_connection.js';

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
  // Optional second relay that receives the very same objects. '' = disabled.
  backupUrlHostPort: string;
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
 * MoQ publisher Web Worker. Packages encoded media with the configured packager
 * (LOC or CMAF, see src/packager/media_packager.ts) and assigns the MoQ
 * (group, object) ids once, then hands every object to each relay connection
 * (main and, optionally, backup; see RelayConnection). All MoQ protocol work
 * (session, control loop, subscriptions, object scheduling) lives in the
 * `Moq`/`Track` classes.
 */
export class MoqSender {
  private config: MuxerSenderConfig | null = null;
  private verbose = false;

  // Main relay first, then the optional backup.
  private connections: RelayConnection[] = [];
  // One packager per media type, kept for the lifetime of the session: the CMAF
  // packager is stateful (sequence numbers, initialization header).
  private packagers: Record<string, MediaPackager> = {};
  // Optional capture of the packaged objects to a local file (debug aid).
  private dumper: MediaDumper | null = null;
  // Last (group, object) ids assigned per media type. Assigned here, for every
  // chunk, so all relays get identical ids whatever each one drops.
  private sequences: Record<string, ObjectIds> = {};

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
      backupUrlHostPort: typeof cfg.backupUrlHostPort === 'string' ? cfg.backupUrlHostPort : '',
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

  /**
   * Open one session per relay (main and optional backup) and publish the
   * tracks on each. The connections start concurrently and independently: one
   * that hangs or fails never holds back the other.
   */
  async handleInit(data: any): Promise<void> {
    if (this.connections.length > 0) {
      console.error(`${WORKER_PREFIX} Received init while a session already exists`);
      return;
    }

    this.config = this.parseSenderConfig(data.config);
    this.verbose = this.config.verbose;

    // Packaging is set up before the transport: chunks are packaged (and
    // captured by the debug dump, if armed) whether or not a session is ever
    // established, so a CMAF file can be produced without a relay.
    this.packagers = {};
    this.sequences = {};
    this.startConfiguredDump();

    this.connections = [new RelayConnection('main', this.config.urlHostPort)];
    if (this.config.backupUrlHostPort !== '') {
      this.connections.push(new RelayConnection('backup', this.config.backupUrlHostPort));
    }
    const config = this.config;
    await Promise.all(this.connections.map((conn) => conn.start(config)));
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

  /** Package one encoded media chunk and hand it to every relay connection. */
  handleChunk(data: ChunkMessage): void {
    const chunkData = this.normalizeChunk(data);
    const newGroup = startsNewGroup(chunkData);
    // Ids advance for every chunk, sent or not, so they are the same on all relays.
    const ids = this.nextObjectIds(data.mediaType, newGroup);
    const ts = data.chunk?.timestamp;

    const blocked = this.connections.map((conn) => conn.sendBlockedReason(data.mediaType));
    const canSend = blocked.some((reason) => reason === undefined);
    // The debug capture does not depend on the transport: while it is armed the
    // chunk is packaged (and written to the dump) even with no session and no
    // subscriber, so a CMAF file can be produced without a relay.
    const capturing = this.dumper?.isArmed(data.mediaType) === true;
    if (!canSend) {
      this.emitBlocked(blocked, chunkData.seqId, ts, data.mediaType);
      if (!capturing) {
        return;
      }
    }

    // Packaged once: every relay gets the very same bytes and properties.
    const packet = this.packetizeChunk(chunkData, newGroup);
    const payload = packet.PayloadToBytes();
    this.dumper?.capture(data.mediaType, payload, newGroup, chunkTimestampMs(data));
    if (!canSend) {
      // Captured, but there is nowhere to publish it.
      return;
    }
    const properties = packet.Properties();

    // Priority only applies when starting a new group.
    const newGroupOptions = newGroup
      ? { priority: this.priorityForMediaType(data.mediaType) }
      : undefined;
    // Media bytes as the encoder produced them: everything the packager added on
    // top is overhead (see RelayConnection.emitSubgroupBytes).
    const mediaBytes = chunkData.chunk?.byteLength ?? 0;
    this.connections.forEach((conn, i) => {
      if (blocked[i] !== undefined) {
        conn.emitDropped(chunkData.seqId, ts, blocked[i]!, data.mediaType);
        return;
      }
      conn.sendObject(
        data.mediaType,
        payload,
        ids,
        newGroupOptions,
        properties,
        mediaBytes,
        chunkData.seqId,
        ts,
        this.verbose,
      );
    });

    if (this.config?.isSendingStats) {
      for (const conn of this.connections) {
        conn.emitStats();
        conn.emitSubgroupBytes();
      }
    }
  }

  // Report a chunk that no connection can take, once per connection (or once
  // when there is no session at all).
  private emitBlocked(
    blocked: (string | undefined)[],
    seqId: number,
    ts: number | undefined,
    mediaType: string,
  ): void {
    if (this.connections.length === 0) {
      postDropped('main', seqId, ts, 'transport is NOT open yet', mediaType);
      return;
    }
    this.connections.forEach((conn, i) => conn.emitDropped(seqId, ts, blocked[i]!, mediaType));
  }

  // The (group, object) ids of the next chunk of a media type. Before the first
  // group starts the group id is -1, which no track accepts.
  private nextObjectIds(mediaType: string, newGroup: boolean): ObjectIds {
    const prev = this.sequences[mediaType] ?? { groupId: -1, objId: -1 };
    const ids = newGroup
      ? { groupId: prev.groupId + 1, objId: 0 }
      : { groupId: prev.groupId, objId: prev.objId + 1 };
    this.sequences[mediaType] = ids;
    return ids;
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

  /** Force-drop the next burst of wire units for one media type, on one relay. */
  private handleForceDropBurst(data: any): void {
    this.connectionFor(data?.relay)?.forceDropBurst(data?.mediaType, data?.burst ?? 1);
  }

  /** Force-hold (stall then clump) the next burst for one media type, on one relay. */
  private handleForceHoldBurst(data: any): void {
    this.connectionFor(data?.relay)?.forceHoldBurst(data?.mediaType, data?.burst ?? 1);
  }

  // The connection to a relay ('main' when unspecified), if it exists.
  private connectionFor(relay: RelayLabel | undefined): RelayConnection | undefined {
    return this.connections.find((conn) => conn.label === (relay ?? 'main'));
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

  /** Stop publishing and close every relay session. */
  handleStop(): void {
    // Save whatever the debug capture collected before tearing the session down.
    this.dumper?.flushAll();
    this.dumper = null;
    for (const conn of this.connections) {
      conn.close();
    }
    this.connections = [];
    this.packagers = {};
    this.sequences = {};
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
// `compensatedTs`: the compensated value is relative to a capture origin shared
// by audio and video, and normalizeChunk clamps it at 0. A sender that anchors
// its streams imperfectly can therefore feed us a run of zeroes at the start of
// a track, which would make the dump overrun its cap.
function chunkTimestampMs(data: ChunkMessage): number | undefined {
  const timestamp = data.chunk?.timestamp;
  if (!(data.timebase! > 0) || typeof timestamp !== 'number') {
    return undefined;
  }
  return (timestamp * 1000) / data.timebase!;
}
