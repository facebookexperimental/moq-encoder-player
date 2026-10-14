/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import {
  Moq,
  MoqState,
  Track,
  MoqMapping,
  type NewGroupOptions,
  type ObjectIds,
} from '../../moq/moq.js';
import { MOQ_CURRENT_VERSION, type KvPair } from '../../moq/moqt.js';
import type { MuxerSenderConfig, TrackData } from './moq_sender_internals.js';

const WORKER_PREFIX = '[MOQ-SENDER]';

// Which relay a connection (and every message it reports) belongs to.
export type RelayLabel = 'main' | 'backup';

/**
 * One MoQ publishing session against one relay: its transport, its tracks and
 * its stats. Connections share nothing, so a slow or dead relay only fills (and
 * drops from) its own queues and never delays another connection.
 */
export class RelayConnection {
  readonly label: RelayLabel;
  readonly url: string;

  moq: Moq | null = null;
  // Published tracks keyed by mediaType ('audio' | 'video' | 'data').
  tracks: Record<string, Track> = {};
  // Encoded media bytes written per group, keyed by media type then group id.
  // The packaging overhead of a group is what the track counted as payload minus
  // this (see emitSubgroupBytes).
  private groupMediaBytes: Record<string, Map<number, number>> = {};
  // Last group already reported per media type, so each subgroup is reported once.
  private reportedGroup: Record<string, number> = {};
  private closed = false;

  constructor(label: RelayLabel, url: string) {
    this.label = label;
    this.url = url;
  }

  /**
   * Open the session and publish the tracks. Never rejects: a failure only
   * takes this connection down, it is logged and the other connections go on.
   */
  async start(config: MuxerSenderConfig): Promise<void> {
    try {
      this.moq = new Moq();
      this.moq.init(this.url, {
        serverCertificateHash: config.certificateHash,
        alpnVersion: MOQ_CURRENT_VERSION,
      });
      console.log(`${this.prefix()} WT initiating to ${this.url}`);
      await this.moq.setup(
        config.keepAlivesEveryMs > 0 ? { everyMs: config.keepAlivesEveryMs } : undefined,
      );
      console.log(`${this.prefix()} MOQ session established`);

      if (config.usePublishNamespace) {
        // Single PUBLISH_NAMESPACE per namespace; tracks are served lazily when
        // a subscriber SUBSCRIBEs (see publishNamespaceTracks).
        await this.publishNamespaceTracks(config.moqTracks);
      } else {
        // One PUBLISH per track (proactive publication).
        for (const [mediaType, trackData] of Object.entries(config.moqTracks)) {
          const track = await this.publishTrack(mediaType, trackData);
          if (this.closed) {
            return;
          }
          this.tracks[mediaType] = track;
          console.log(
            `${this.prefix()} Published track ${mediaType} (${trackData.namespace}/${trackData.name})`,
          );
        }
      }
      console.log(`${this.prefix()} MOQ Initialized, waiting for subscriptions`);
    } catch (err: any) {
      if (!this.closed) {
        console.error(`${this.prefix()} Can NOT publish to ${this.url}. Err: ${err?.message}`);
      }
    }
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
  // in this.tracks) only once a peer subscribes to it; until then chunks for that
  // media type are dropped for this connection.
  private async publishNamespaceTracks(moqTracks: Record<string, TrackData>): Promise<void> {
    // Register offers first so a SUBSCRIBE that races the announce still matches.
    for (const [mediaType, trackData] of Object.entries(moqTracks)) {
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
          console.log(`${this.prefix()} Serving ${mediaType} track (subscriber joined)`);
        },
        onUnsubscribed: () => {
          delete this.tracks[mediaType];
          console.log(`${this.prefix()} Stopped serving ${mediaType} track (subscriber left)`);
        },
      });
    }

    // Announce each distinct namespace a single time.
    const announced = new Set<string>();
    for (const trackData of Object.values(moqTracks)) {
      const nsKey = trackData.namespace.join('/');
      if (announced.has(nsKey)) {
        continue;
      }
      announced.add(nsKey);
      await this.moq!.publishNamespace(trackData.namespace, trackData.authInfo);
      console.log(`${this.prefix()} Published namespace [${nsKey}]`);
    }
  }

  // Why an object for this media type cannot be published right now, or
  // undefined when it can.
  sendBlockedReason(mediaType: string): string | undefined {
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

  /** Hand one already packaged object to this connection's track (never blocks). */
  sendObject(
    mediaType: string,
    payload: BufferSource,
    ids: ObjectIds,
    newGroupOptions: NewGroupOptions | undefined,
    properties: KvPair[],
    mediaBytes: number,
    seqId: number,
    ts: number | undefined,
    verbose: boolean,
  ): void {
    const track = this.tracks[mediaType];
    const obj = track.sendObject(
      payload,
      newGroupOptions,
      properties,
      (sent) => {
        // Only objects that reached the wire are accounted for, so the numbers
        // match what the track counted.
        const info = sent.getInfo();
        this.accountSentObject(mediaType, info.groupId, mediaBytes);
        if (verbose) {
          console.debug(
            `${this.prefix()} SENT ${mediaType} seqId ${seqId} (${info.groupId}/${info.objId})`,
          );
        }
      },
      ids,
    );

    if (obj.getInfo().status === 'dropped') {
      this.emitDropped(
        seqId,
        ts,
        `the track refused it (send queue full, stream cap, or waiting for a new group) (${ids.groupId}/${ids.objId})`,
        mediaType,
      );
    }
  }

  forceDropBurst(mediaType: string, burst: number): void {
    // Not publishing / no subscriber yet: nothing to drop.
    this.tracks[mediaType]?.forceDropBurst(burst);
  }

  forceHoldBurst(mediaType: string, burst: number): void {
    // Not publishing / no subscriber yet: nothing to hold.
    this.tracks[mediaType]?.forceHoldBurst(burst);
  }

  close(): void {
    this.closed = true;
    this.moq?.close();
    this.moq = null;
    this.tracks = {};
    this.groupMediaBytes = {};
    this.reportedGroup = {};
  }

  // -------------------------------------------------------------------------
  // Messages to the main thread, tagged with this connection's relay label
  // -------------------------------------------------------------------------

  emitDropped(
    seqId: number | undefined,
    ts: number | undefined,
    msg: string,
    mediaType: string,
  ): void {
    postDropped(this.label, seqId, ts, msg, mediaType);
  }

  emitStats(): void {
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
    self.postMessage({
      type: 'sendstats',
      relay: this.label,
      clkms: Date.now(),
      queuedReq,
      openStreamsReq,
    });
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
  emitSubgroupBytes(): void {
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
        relay: this.label,
        clkms: Date.now(),
        mediaType,
        groupId: subgroup.groupId,
        objects: subgroup.objects,
        payloadBytes,
        overheadBytes: packagingBytes + subgroup.signalingBytes,
      });
    }
  }

  private prefix(): string {
    return `${WORKER_PREFIX}[${this.label}]`;
  }
}

export function postDropped(
  relay: RelayLabel,
  seqId: number | undefined,
  ts: number | undefined,
  msg: string,
  mediaType: string,
): void {
  self.postMessage({
    type: 'dropped',
    data: { clkms: Date.now(), relay, seqId, mediaType, ts, msg: `Dropped chunk because ${msg}` },
  });
}
