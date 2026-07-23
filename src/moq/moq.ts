/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

// High-level, media-free MoQ client API built on top of the low-level wire
// protocol in ./moqt.ts. It handles both roles: publish (Track) and subscribe
// (Subscription). The workers that use it live in ../sender/moq/ and
// ../receiver/moq/.
//
//   const moq = new Moq();
//   moq.init(urlHostPort, { serverCertificateHash, alpnVersion });   // sync, starts connecting
//   await moq.setup();                                              // SETUP handshake
//   // The MOQT version is negotiated by the transport via ALPN /
//   // WT-Available-Protocols (draft-18), so setup() carries no version. draft-18
//   // uses a pair of unidirectional control streams and runs each request
//   // (PUBLISH / SUBSCRIBE / ...) on its own bidirectional stream.
//
//   // Publish:
//   const track = await moq.addTrack(ns, name, maxQueuedObjects, maxOpenStreams, auth, mapping);
//   const obj = track.sendObject(bytes, { priority }, extHeaders, () => {});  // new group
//   track.sendObject(moreBytes);                                              // same group
//   obj.getInfo();   // { objId, groupId, status }
//
//   // Subscribe (objects routed to the callback by track alias):
//   const sub = await moq.subscribe(ns, name, auth, (reader, extHeaders, len) => {
//     /* demux payload */ return isEof;
//   });
//
//   moq.close();     // sync

import {
  moqCreate,
  moqClose,
  moqCreateControlStream,
  moqSendSetup,
  moqParseMsg,
  moqParseControlMessageWithType,
  moqReadVarintType,
  moqParseObjectHeaderWithType,
  moqSendPublish,
  moqSendPublishNamespace,
  moqSendPublishDone,
  moqSendSubscribe,
  moqSendSubscribeOk,
  moqSendRequestError,
  moqSendRequestUpdate,
  moqSendSubgroupHeader,
  moqSendObjectSubgroupToWriter,
  moqSendObjectEndOfGroupToWriter,
  moqSendObjectPerDatagramToWriter,
  moqParseObjectHeader,
  moqParseObjectFromSubgroupHeader,
  isMoqObjectStreamHeaderType,
  isMoqObjectDatagramType,
  moqDecodeDatagramType,
  getTrackFullName,
  MOQ_MESSAGE_SETUP,
  MOQ_MESSAGE_SUBSCRIBE,
  MOQ_MESSAGE_PUBLISH_NAMESPACE,
  MOQ_MESSAGE_SUBSCRIBE_NAMESPACE,
  MOQ_MESSAGE_PUBLISH_DONE,
  MOQ_MESSAGE_SUBSCRIBE_OK,
  MOQ_MESSAGE_REQUEST_OK,
  MOQ_MESSAGE_REQUEST_UPDATE,
  MOQ_REQUEST_ERROR_DOES_NOT_EXIST,
  MOQ_REQUEST_ERROR_NOT_SUPPORTED,
  MOQ_STREAM_TYPE_PADDING,
  MOQ_PARAMETER_FORWARD,
  MOQ_OBJ_STATUS_END_OF_GROUP,
  MOQ_OBJ_STATUS_END_OF_TRACK_AND_GROUP,
  MOQ_PUBLISHER_PRIORITY_BASE_DEFAULT,
  MOQ_STATUS_TRACK_ENDED,
  MOQ_FORWARD_TRUE,
  MOQ_FORWARD_FALSE,
  type MoqtState,
  type KvPair,
  type ObjectHeader,
  type ParsedSubscribe,
  MOQ_ALPN_DRAFT18_VERSION,
} from './moqt.js';
import {
  WireDropSimulator,
  wireDropConfigIsActive,
  type WireDropConfig,
  WireHoldSimulator,
  wireHoldConfigIsActive,
  type WireHoldConfig,
} from './network_simulator.js';

const LOG_PREFIX = '[MOQ]';

// On SUBSCRIBE_ERROR we wait this long before retrying the subscription.
const SLEEP_SUBSCRIBE_ERROR_MS = 2000;

// Track alias 0/1 are reserved (1 for keep-alive); real tracks start at 2.
const KEEPALIVE_TRACK_ALIAS = 1;
const INITIAL_TRACK_ALIAS = KEEPALIVE_TRACK_ALIAS + 1;

// Client request IDs step by 2 (MoQ reserves the parity for the peer).
const CLIENT_REQUEST_ID_STEP = 2;

/**
 * MoQ → QUIC object mapping. Values are the on-the-wire identifiers used by the
 * low-level protocol (see MOQ_MAPPING_* in ./moqt.ts) and must stay in sync.
 */
export enum MoqMapping {
  ObjectPerDatagram = 'ObjPerDatagram',
  SubgroupPerGroup = 'SubGroupPerObj',
}

export type ObjStatus = 'queued' | 'sent' | 'aborted' | 'dropped';

export interface ObjInfo {
  objId: number;
  groupId: number;
  status: ObjStatus;
}

/** Options for starting a new group, passed to `Track.sendObject`. */
export interface NewGroupOptions {
  priority: number;
}

export interface TrackInfo {
  namespace: string[];
  name: string;
  trackAlias: number;
  moqMapping: MoqMapping;
  numSubscribers: number;
  // Objects waiting in the per-track send queue (not yet written to a stream).
  numQueued: number;
  // Open QUIC subgroup streams: created but not yet closed (0 for datagram).
  numOpenStreams: number;
  currentGroup: number;
  currentObject: number;
}

export interface MoqInitOptions {
  // SHA-256 hash of the server certificate, for WebTransport `serverCertificateHashes`.
  serverCertificateHash?: Uint8Array | null;
  // MOQT ALPN token (e.g. "moqt-18"). draft-18 negotiates the version via the
  // transport (ALPN over native QUIC, WT-Available-Protocols over WebTransport),
  // so this is offered to WebTransport as `protocols` rather than sent in SETUP.
  // Optional; defaults to MOQ_ALPN_DRAFT18_VERSION when omitted.
  alpnVersion?: string;
}

/**
 * Called for every object received on a subscription. It is handed the raw
 * payload reader (a `ReadableStream` positioned at the object payload), the
 * object extension headers, the payload length (`undefined` means "read to the
 * end of the datagram"), and the MoQ transport-native group/object ids for this
 * object. It returns whether this was the last object (end of stream). Media
 * decoding lives in the caller, keeping `Moq` media-free.
 *
 * `groupId`/`objectId` are the MoQ ordering keys. For subgroup streams `objectId`
 * is the receiver-counted arrival index within the group (the wire object-id
 * delta is always 0 in this mapping); for datagrams it is the wire object id.
 *
 * `isLastInGroup` is true when the object carries the end-of-group signal inline,
 * i.e. datagrams (one object per group, end-of-group bit on the object). Subgroup
 * streams signal end-of-group retroactively instead (see `EndOfGroupCallback`),
 * so this is false for them.
 */
export type ObjectCallback = (
  reader: ReadableStream<Uint8Array>,
  extensionHeaders: KvPair[],
  length?: number,
  groupId?: number,
  objectId?: number,
  isLastInGroup?: boolean,
) => Promise<boolean> | boolean;

/**
 * Called when the transport learns retroactively that a group is complete,
 * carrying the group id and the object id of its final object. Used for subgroup
 * streams, where end-of-group is a MOQ_OBJ_STATUS_END_OF_GROUP status object that
 * trails the group's last payload object -- so it cannot ride on that object and
 * is delivered out of band. Datagrams carry end-of-group inline on the object
 * instead (see `ObjectCallback`'s `isLastInGroup`).
 */
export type EndOfGroupCallback = (groupId: number, lastObjId: number) => void;

export interface SubscriptionInfo {
  namespace: string[];
  name: string;
  subscribeRequestId: number;
  trackAlias: number;
}

/**
 * Keep-alive loop options. When passed to `Moq.setup`, the session periodically
 * sends a keep-alive PUBLISH while idle (no object sent within `everyMs`).
 * `namespace`/`name` default to 'keepAlive' and a random name.
 */
export interface KeepAliveOptions {
  everyMs: number;
  namespace?: string;
  name?: string;
}

/**
 * A track offered under a published namespace (`Moq.publishNamespace` +
 * `Moq.offerTrack`). Unlike `addTrack` (which proactively PUBLISHes a track),
 * an offered track is served lazily: the `Track` is created only when a peer
 * sends a matching SUBSCRIBE, at which point `onSubscribed` fires with the live
 * `Track` handle. `onUnsubscribed` fires when that subscription ends.
 */
export interface TrackOffer {
  namespace: string[];
  name: string;
  maxQueuedObjects: number;
  maxOpenStreams: number;
  moqMapping: MoqMapping;
  authInfo?: string;
  onSubscribed?: (track: Track) => void;
  onUnsubscribed?: (track: Track) => void;
}

// Subscriber state we keep per track (from SUBSCRIBE / SUBSCRIBE_UPDATE).
interface Subscriber {
  subscriptionRequestId: number;
  forward: number;
  parameters: KvPair[];
}

/**
 * Handle for one object handed to `Track.sendObject`. Lets the caller observe
 * delivery (`getInfo`) and cancel an object that has not been written yet
 * (`abort`).
 */
export class ObjData {
  groupId: number;
  objId: number;
  status: ObjStatus;
  readonly priority: number;
  readonly data: BufferSource | undefined;
  readonly newGroup: boolean;
  readonly extensionHeaders: KvPair[];
  readonly callback?: (obj: ObjData) => void;
  private track: Track;

  constructor(
    track: Track,
    groupId: number,
    objId: number,
    status: ObjStatus,
    priority: number,
    data?: BufferSource,
    newGroup = false,
    extensionHeaders: KvPair[] = [],
    callback?: (obj: ObjData) => void,
  ) {
    this.track = track;
    this.groupId = groupId;
    this.objId = objId;
    this.status = status;
    this.priority = priority;
    this.data = data;
    this.newGroup = newGroup;
    this.extensionHeaders = extensionHeaders;
    this.callback = callback;
  }

  /** Synchronous snapshot: object id, group id and current status. */
  getInfo(): ObjInfo {
    return { objId: this.objId, groupId: this.groupId, status: this.status };
  }

  /** Drop this object from the queue if it has not been written yet. */
  abort(): void {
    if (this.status === 'queued') {
      this.track._abort(this);
    }
  }
}

/**
 * A published track. Created via `Moq.addTrack`. Carries the per-track send
 * queue, group/object sequencing, open subgroup stream, and subscriber list.
 */
export class Track {
  readonly namespace: string[];
  readonly name: string;
  readonly trackAlias: number;
  readonly publisherRequestId: number;
  readonly authInfo: string | undefined;
  // Send-queue cap: objects are dropped once `queue.length` reaches this.
  readonly maxQueuedObjects: number;
  // Open-stream cap (subgroup mapping): a new group is dropped (its stream is
  // not opened) while `openStreamCount` is at this limit. 0 / unset = unbounded.
  readonly maxOpenStreams: number;
  readonly moqMapping: MoqMapping;

  subscribers: Subscriber[] = [];

  private moq: Moq;
  // draft-18: each request runs on its own bidirectional stream. PUBLISH was sent
  // on this stream; REQUEST_OK / REQUEST_UPDATE (Forward State) and the final
  // PUBLISH_DONE all flow back on it.
  private publishStream: WebTransportBidirectionalStream;
  private queue: ObjData[] = [];
  private draining = false;
  private closed = false;
  // Forward State for this subscription (draft-18). The relay toggles it via
  // REQUEST_UPDATE; objects are only sent while it is true. Starts false: the
  // relay's PUBLISH_OK parks new tracks at Forward State 0 until a subscriber
  // appears.
  private forwarding = false;
  // Set when forwarding resumes (0 -> 1), so the next object starts a fresh
  // group on a new subgroup stream rather than reusing a stopped one.
  private resumeNeedsNewGroup = false;

  private firstObjectSent = false;
  private currentGroupSeq = 0;
  private currentObjectSeq = 0;
  // Priority of the current group; updated when a new group is started.
  private currentGroupPriority = MOQ_PUBLISHER_PRIORITY_BASE_DEFAULT;

  // Open subgroup stream writer keyed by group id (one at a time in practice).
  private openStreams = new Map<number, WritableStreamDefaultWriter<Uint8Array>>();
  // Last object id written per group (used to send the end-of-group marker).
  private groupLastObj = new Map<number, number>();
  // Number of subgroup streams created but not yet finished closing. Counts the
  // current group's stream plus any whose end-of-group close is still settling,
  // so it reflects the QUIC streams genuinely open against the relay.
  private openStreamCount = 0;
  // Set when a new group was dropped by the open-stream cap, so the rest of that
  // group's objects (deltas) are dropped too until the next group is accepted.
  private skipDeltasUntilNewGroup = false;

  // Optional simulated packet loss on the send path (A/V-sync / loss-recovery
  // testing). null = disabled. The drop unit follows the mapping: one datagram
  // per object, or one subgroup stream per group. See writeObject/shouldDropOnWire.
  private dropSim: WireDropSimulator | null = null;
  // Group currently being dropped as a whole (subgroup mapping): once the first
  // object of a group is chosen for drop, every object of that group is dropped
  // so the entire QUIC stream is skipped. undefined = current group is kept.
  private droppedGroupId: number | undefined = undefined;
  // Optional simulated slowness on the send path (A/V-sync testing). null =
  // disabled. Holds bursts of objects and releases them together, so the receiver
  // sees a stall followed by a clump. Operates per object regardless of mapping.
  private holdSim: WireHoldSimulator<ObjData> | null = null;
  // Number of upcoming wire units to force-drop on demand (manual burst),
  // independent of the periodic drop simulator. Consumed one unit at a time.
  private forcedDropRemaining = 0;
  // Manual "hold" burst: while > 0, upcoming objects are buffered instead of
  // written (a stall), then released together once the count reaches 0 (a clump).
  // Independent of the periodic hold simulator. See forceHoldBurst / drain.
  private forcedHoldRemaining = 0;
  private forcedHoldBuffer: ObjData[] = [];
  // Fired for every object skipped by the drop simulator (not for real drops
  // like queue/stream-cap). Lets the sender surface simulated loss in the UI.
  onWireDrop?: (obj: ObjData) => void;

  constructor(
    moq: Moq,
    namespace: string[],
    name: string,
    trackAlias: number,
    publisherRequestId: number,
    maxQueuedObjects: number,
    maxOpenStreams: number,
    authInfo: string | undefined,
    moqMapping: MoqMapping,
    publishStream: WebTransportBidirectionalStream,
  ) {
    this.moq = moq;
    this.namespace = namespace;
    this.name = name;
    this.trackAlias = trackAlias;
    this.publisherRequestId = publisherRequestId;
    this.maxQueuedObjects = maxQueuedObjects > 0 ? maxQueuedObjects : Number.MAX_SAFE_INTEGER;
    this.maxOpenStreams = maxOpenStreams > 0 ? maxOpenStreams : Number.MAX_SAFE_INTEGER;
    this.authInfo = authInfo;
    this.moqMapping = moqMapping;
    this.publishStream = publishStream;
  }

  /**
   * Queue an object for delivery. Passing `newGroupOptions` starts a new group
   * (e.g. a video keyframe) with the given publisher priority; omit it to append
   * to the current group. `extensionHeaders` are MoQ object extension headers
   * (e.g. MoQMI media metadata). `callback` fires once the object is written.
   *
   * Returns an `ObjData` handle. Objects are dropped (status `dropped`) when the
   * subscription is not being forwarded (Forward State 0 / no subscriber), when
   * the pending send queue is already at `maxQueuedObjects`, or (subgroup
   * mapping) when starting a new group would exceed `maxOpenStreams` — in which
   * case the whole group is dropped until a later group finds room.
   */
  sendObject(
    data: BufferSource | undefined,
    newGroupOptions?: NewGroupOptions,
    extensionHeaders: KvPair[] = [],
    callback?: (obj: ObjData) => void,
  ): ObjData {
    if (this.closed) {
      return new ObjData(this, -1, -1, 'dropped', this.currentGroupPriority);
    }

    let newGroup = newGroupOptions !== undefined;

    // Forward-state gating (draft-18 §5.1): the publisher does not send Objects
    // while Forward State is 0. The relay toggles this via REQUEST_UPDATE (see
    // Moq.onRequestUpdate -> Track._setForwarding).
    if (!this.forwarding) {
      return new ObjData(
        this,
        this.currentGroupSeq,
        this.currentObjectSeq,
        'dropped',
        this.currentGroupPriority,
      );
    }

    // When forwarding resumes, start a fresh group. Streams opened before the
    // pause were reset (by us) and/or STOP_SENDING'd by the relay, so we must
    // open new subgroup streams and must not reuse Object IDs within an
    // already-sent group (which would make the track malformed).
    if (this.resumeNeedsNewGroup) {
      newGroup = true;
      this.resumeNeedsNewGroup = false;
    }

    // Open-stream cap (subgroup mapping): refuse to start a new group while too
    // many subgroup streams are still open, and drop the rest of a group whose
    // start was refused. Datagram mapping opens no streams, so it is exempt.
    if (this.moqMapping === MoqMapping.SubgroupPerGroup) {
      if (newGroup) {
        this.skipDeltasUntilNewGroup = this.openStreamCount >= this.maxOpenStreams;
      }
      if (this.skipDeltasUntilNewGroup) {
        return new ObjData(
          this,
          this.currentGroupSeq,
          this.currentObjectSeq,
          'dropped',
          this.currentGroupPriority,
        );
      }
    }

    // Drop when the pending send queue is full.
    if (this.queue.length >= this.maxQueuedObjects) {
      return new ObjData(
        this,
        this.currentGroupSeq,
        this.currentObjectSeq,
        'dropped',
        this.currentGroupPriority,
      );
    }

    if (newGroupOptions !== undefined) {
      this.currentGroupPriority = newGroupOptions.priority;
    }
    const { groupId, objId } = this.advanceSequence(newGroup);
    const obj = new ObjData(
      this,
      groupId,
      objId,
      'queued',
      this.currentGroupPriority,
      data,
      newGroup,
      extensionHeaders,
      callback,
    );
    this.queue.push(obj);
    void this.drain();
    return obj;
  }

  /**
   * Enable or disable simulated packet loss on this track's send path. Pass
   * `null` (or an inactive config) to disable. Used only for testing; genuine
   * publication never sets this.
   */
  setWireDropConfig(cfg: WireDropConfig | null): void {
    this.dropSim = wireDropConfigIsActive(cfg) ? new WireDropSimulator(cfg!) : null;
    this.droppedGroupId = undefined;
  }

  /**
   * Enable or disable simulated slowness (a stall-then-clump hold) on this
   * track's send path. Pass `null` (or an inactive config) to disable, flushing
   * anything still held. Used only for testing; genuine publication never sets this.
   */
  setWireHoldConfig(cfg: WireHoldConfig | null): void {
    if (this.holdSim !== null) {
      // Release whatever is still buffered (in order, at the front) so no object
      // is stranded, then let the drain send it.
      const held = this.holdSim.flush();
      if (held.length > 0) {
        this.queue.unshift(...held);
        void this.drain();
      }
    }
    this.holdSim = wireHoldConfigIsActive(cfg) ? new WireHoldSimulator<ObjData>(cfg!) : null;
  }

  /**
   * Force-drop the next `count` wire units on demand (a manual loss burst), on
   * top of (and independent of) any periodic drop policy. The unit follows the
   * mapping: `count` datagrams, or `count` subgroup streams (groups). Testing only.
   */
  forceDropBurst(count: number): void {
    this.forcedDropRemaining += Math.max(1, Math.floor(count) || 1);
  }

  /**
   * Force-hold the next `count` objects on demand (a manual slowness burst): they
   * are buffered as they arrive (a stall) and released together once the burst is
   * full (a clump), on top of (and independent of) any periodic hold policy.
   * Testing only.
   */
  forceHoldBurst(count: number): void {
    this.forcedHoldRemaining += Math.max(1, Math.floor(count) || 1);
  }

  /** Snapshot of the track's identity and live counters. */
  getInfo(): TrackInfo {
    return {
      namespace: this.namespace,
      name: this.name,
      trackAlias: this.trackAlias,
      moqMapping: this.moqMapping,
      numSubscribers: this.subscribers.length,
      numQueued: this.queue.length,
      numOpenStreams: this.openStreamCount,
      currentGroup: this.currentGroupSeq,
      currentObject: this.currentObjectSeq,
    };
  }

  /** Stop the track: drop the queue, close streams, send PUBLISH_DONE. */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;

    // Drop anything still queued, including a manual hold burst that never
    // reached its release count.
    for (const obj of [...this.forcedHoldBuffer, ...this.queue]) {
      obj.status = 'aborted';
    }
    this.forcedHoldBuffer = [];
    this.forcedHoldRemaining = 0;
    this.queue = [];

    // Close every open subgroup stream with an end-of-group object.
    for (const [groupId, writer] of this.openStreams) {
      const lastObj = this.groupLastObj.get(groupId) ?? 0;
      try {
        await moqSendObjectEndOfGroupToWriter(writer, lastObj + 1, [], true);
      } catch {
        // Best-effort on teardown.
      }
    }
    this.openStreams.clear();
    this.openStreamCount = 0;

    // draft-18: PUBLISH_DONE goes back on this request's own bidi stream (no
    // Request ID field — the stream identifies the request); then FIN it.
    try {
      await moqSendPublishDone(
        this.publishStream.writable,
        MOQ_STATUS_TRACK_ENDED,
        this.subscribers.length,
        'Subscription Ended, the stream has finished',
      );
      await this.publishStream.writable.close();
    } catch {
      // Best-effort on teardown.
    }
  }

  // ---- internal (called by Moq / ObjData) --------------------------------

  // The writable half of the PUBLISH request stream (used for keep-alive).
  _publishWritable(): WritableStream<Uint8Array> {
    return this.publishStream.writable;
  }

  // Read REQUEST_UPDATE (Forward State toggles) and other late control messages
  // that the peer sends on the publish stream after the initial REQUEST_OK. In
  // draft-18 the message arrives on this track's own stream, so it is inherently
  // scoped to this track (no Existing Request ID lookup needed).
  async _runResponseLoop(): Promise<void> {
    try {
      for (;;) {
        const msg = await moqParseMsg(this.publishStream.readable);
        if (msg.type === MOQ_MESSAGE_REQUEST_UPDATE) {
          const forward = forwardFromParameters(msg.data?.parameters ?? []);
          if (forward === MOQ_FORWARD_TRUE) {
            this._addSubscriber(this.publisherRequestId, MOQ_FORWARD_TRUE, msg.data.parameters);
            this._setForwarding(true);
          } else {
            this._removeSubscribersByRequestId(this.publisherRequestId);
            this._setForwarding(false);
          }
        } else if (msg.type === MOQ_MESSAGE_PUBLISH_DONE) {
          // Message already dumped by the central control-message logger.
          break;
        }
        // Ignore other late control messages.
      }
    } catch {
      // Stream closed/reset: the peer is done with this publication.
      console.warn(`${LOG_PREFIX} Stream closed reset. Probably peer closed it.`);
    }
  }

  // True when the subscription is being forwarded (Forward State 1).
  isForwarding(): boolean {
    return this.forwarding;
  }

  // Update Forward State. On 1->0 we proactively reset the open subgroup streams
  // (the relay will also STOP_SENDING them); on 0->1 we flag that the next object
  // must start a fresh group so we open new streams. See sendObject/writeObject.
  _setForwarding(forwarding: boolean): void {
    if (forwarding === this.forwarding) {
      return;
    }
    this.forwarding = forwarding;
    if (forwarding) {
      this.resumeNeedsNewGroup = true;
    } else {
      void this.resetStreams();
    }
  }

  // Reset and forget all open subgroup streams (best-effort). Used when
  // forwarding stops, so stale streams don't linger to be STOP_SENDING'd.
  private async resetStreams(): Promise<void> {
    const streams = this.openStreams;
    this.openStreams = new Map();
    this.groupLastObj.clear();
    this.skipDeltasUntilNewGroup = false;
    for (const writer of streams.values()) {
      try {
        await writer.abort('forward paused');
      } catch {
        // Best-effort: the relay may have already reset the stream.
      }
      this.openStreamCount = Math.max(0, this.openStreamCount - 1);
    }
  }

  _addSubscriber(subscriptionRequestId: number, forward: number, parameters: KvPair[]): void {
    this.subscribers.push({ subscriptionRequestId, forward, parameters });
  }

  // Returns the subscribers removed.
  _removeSubscribersByRequestId(requestId: number): Subscriber[] {
    const removed: Subscriber[] = [];
    this.subscribers = this.subscribers.filter((s) => {
      if (s.subscriptionRequestId === requestId) {
        removed.push(s);
        return false;
      }
      return true;
    });
    return removed;
  }

  // Approximate last (group, obj) sent — used to answer SUBSCRIBE_OK.
  _lastSent(): { group: number | undefined; obj: number | undefined } {
    if (!this.firstObjectSent) {
      return { group: undefined, obj: undefined };
    }
    return { group: this.currentGroupSeq, obj: this.currentObjectSeq };
  }

  _abort(obj: ObjData): void {
    const idx = this.queue.indexOf(obj);
    if (idx >= 0) {
      this.queue.splice(idx, 1);
      obj.status = 'aborted';
    }
  }

  // Assign this object's (group, obj) ids and advance the counters.
  private advanceSequence(newGroup: boolean): { groupId: number; objId: number } {
    if (!this.firstObjectSent) {
      this.firstObjectSent = true;
      this.currentGroupSeq = 0;
      this.currentObjectSeq = 0;
    } else if (newGroup) {
      this.currentGroupSeq++;
      this.currentObjectSeq = 0;
    }
    const groupId = this.currentGroupSeq;
    const objId = this.currentObjectSeq;
    this.currentObjectSeq++;
    return { groupId, objId };
  }

  // Drain the queue sequentially (preserves stream write ordering).
  private async drain(): Promise<void> {
    if (this.draining) {
      return;
    }
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const obj = this.queue[0];
        if (obj.status === 'aborted') {
          this.queue.shift();
          continue;
        }
        // Manual forced hold: buffer arriving objects (a stall) and release the
        // whole burst together once it is full (a clump). Objects normally arrive
        // one at a time between drains, so this stalls the wire until the count is
        // reached, then re-queues the burst at the front to be written in one go.
        if (this.forcedHoldRemaining > 0) {
          this.queue.shift();
          this.forcedHoldBuffer.push(obj);
          this.forcedHoldRemaining--;
          if (this.forcedHoldRemaining === 0) {
            this.queue.unshift(...this.forcedHoldBuffer);
            this.forcedHoldBuffer = [];
          }
          continue;
        }
        // Simulated slowness: the hold sim buffers bursts of objects and returns
        // them together on flush; between bursts (and when disabled) the object
        // passes straight through. The object leaves the queue as soon as the sim
        // takes ownership; queue backlog therefore only reflects not-yet-offered
        // objects, keeping the no-hold path (below) unchanged.
        const toWrite = this.holdSim !== null ? this.holdSim.offer(obj) : [obj];
        if (this.holdSim !== null) {
          this.queue.shift();
        }
        for (const o of toWrite) {
          try {
            const written = await this.writeObject(o);
            // A simulated wire drop returns false: the id was consumed (so the
            // receiver sees a gap) but nothing hit the wire, so it is not 'sent'.
            o.status = written ? 'sent' : 'dropped';
          } catch (err) {
            o.status = 'dropped';
            console.error(`${LOG_PREFIX} Failed to write object ${o.groupId}/${o.objId}: ${err}`);
          }
          if (o.status === 'sent') {
            this.moq._markObjectSent();
            if (o.callback) {
              o.callback(o);
            }
          }
        }
        // No hold sim: the object stayed in the queue during its write (so the
        // backlog counters and the full-queue policy see it); shift it now.
        if (this.holdSim === null) {
          this.queue.shift();
        }
      }
    } finally {
      this.draining = false;
    }
  }

  // Decide whether this object should be dropped by the simulated-loss policy.
  // Datagram mapping: the unit is one datagram (one object). Subgroup mapping:
  // the unit is one QUIC stream (one group), so the decision is taken once on the
  // group's first object and applied to every object in that group.
  private shouldDropOnWire(obj: ObjData): boolean {
    if (this.moqMapping === MoqMapping.ObjectPerDatagram) {
      // Datagram: the unit is one object (one datagram).
      return this.decideDropUnit();
    }
    // Subgroup mapping: the unit is one QUIC stream (one group); decide once on
    // the group's first object and apply it to every object in that group.
    if (obj.newGroup) {
      this.droppedGroupId = this.decideDropUnit() ? obj.groupId : undefined;
    }
    return this.droppedGroupId === obj.groupId;
  }

  // Decide whether the current wire unit should be dropped. A forced manual burst
  // takes precedence over (and does not advance) the periodic drop simulator.
  private decideDropUnit(): boolean {
    if (this.forcedDropRemaining > 0) {
      this.forcedDropRemaining--;
      return true;
    }
    if (this.dropSim !== null) {
      return this.dropSim.shouldDrop();
    }
    return false;
  }

  // Writes one object to the wire. Returns true when the bytes were written,
  // false when the object was intentionally skipped by the drop simulator (its
  // id was still consumed, so the receiver sees a real gap).
  private async writeObject(obj: ObjData): Promise<boolean> {
    if (this.shouldDropOnWire(obj)) {
      // Simulated wire loss: skip the datagram / subgroup stream entirely.
      if (this.onWireDrop !== undefined) {
        this.onWireDrop(obj);
      }
      return false;
    }

    if (this.moqMapping === MoqMapping.ObjectPerDatagram) {
      const writer = this.moq._wt().datagrams.writable.getWriter();
      try {
        await moqSendObjectPerDatagramToWriter(
          writer,
          this.trackAlias,
          obj.groupId,
          obj.objId,
          obj.priority,
          obj.data,
          obj.extensionHeaders,
          true,
        );
      } finally {
        writer.releaseLock();
      }
      return true;
    }

    if (this.moqMapping !== MoqMapping.SubgroupPerGroup) {
      throw new Error(`Unexpected MOQ - QUIC mapping: ${this.moqMapping}`);
    }

    // Close any open stream from a previous group (the group rolled). The close
    // runs in the background (closeStream) so a slow end-of-group + FIN does not
    // block the drain; the stream stays counted in openStreamCount until it
    // settles, which is what the open-stream cap throttles against.
    for (const [groupId, writer] of this.openStreams) {
      if (groupId !== obj.groupId) {
        this.openStreams.delete(groupId);
        this.groupLastObj.delete(groupId);
        this.closeStream(writer);
      }
    }

    // Open a stream for this group on demand, writing the subgroup header. The
    // open-stream cap already gated this in sendObject, so by here there is room.
    let writer = this.openStreams.get(obj.groupId);
    if (writer === undefined) {
      // Use the group priority directly as the WebTransport stream send order.
      const uniStream = await this.moq
        ._wt()
        .createUnidirectionalStream({ sendOrder: obj.priority });
      writer = uniStream.getWriter();
      this.openStreams.set(obj.groupId, writer);
      this.openStreamCount++;
      await moqSendSubgroupHeader(writer, this.trackAlias, obj.groupId, obj.priority);
    }

    // Object id delta is always 0: one stream per group, ids tracked locally.
    try {
      await moqSendObjectSubgroupToWriter(writer, 0, obj.data, obj.extensionHeaders);
    } catch (err) {
      // The stream was stopped/reset (e.g. the relay sent STOP_SENDING when the
      // subscriber left). Abandon it so we don't keep writing to a dead stream;
      // a later object (after forwarding resumes) opens a fresh one.
      this.openStreams.delete(obj.groupId);
      this.groupLastObj.delete(obj.groupId);
      this.openStreamCount = Math.max(0, this.openStreamCount - 1);
      throw err;
    }
    this.groupLastObj.set(obj.groupId, obj.objId);
    return true;
  }

  // Close a rolled-off subgroup stream in the background: send end-of-group +
  // FIN (Object ID Delta 0), then drop it from openStreamCount once the close
  // settles. Best-effort — the relay may have already reset the stream.
  private closeStream(writer: WritableStreamDefaultWriter<Uint8Array>): void {
    void moqSendObjectEndOfGroupToWriter(writer, 0, [], true)
      .catch(() => {
        // Stream was likely stopped/reset by the peer; just forget it.
      })
      .finally(() => {
        this.openStreamCount = Math.max(0, this.openStreamCount - 1);
      });
  }
}

/**
 * A subscribed track. Created via `Moq.subscribe`. Holds the subscription
 * identity and the per-object callback the receive loops invoke (routed by
 * track alias). Symmetric to `Track` on the publisher side.
 */
export class Subscription {
  readonly namespace: string[];
  readonly name: string;
  readonly subscribeRequestId: number;
  readonly trackAlias: number;
  readonly authInfo: string | undefined;

  private moq: Moq;
  private onObject: ObjectCallback;
  private onEndOfGroup: EndOfGroupCallback | undefined;
  // draft-18: SUBSCRIBE ran on this bidi stream; SUBSCRIBE_OK / PUBLISH_DONE and
  // any REQUEST_UPDATE flow back on it. Objects still arrive on separate uni
  // subgroup streams / datagrams, routed by track alias.
  private subscribeStream: WebTransportBidirectionalStream;
  private closed = false;

  constructor(
    moq: Moq,
    namespace: string[],
    name: string,
    subscribeRequestId: number,
    trackAlias: number,
    authInfo: string | undefined,
    onObject: ObjectCallback,
    subscribeStream: WebTransportBidirectionalStream,
    onEndOfGroup?: EndOfGroupCallback,
  ) {
    this.moq = moq;
    this.namespace = namespace;
    this.name = name;
    this.subscribeRequestId = subscribeRequestId;
    this.trackAlias = trackAlias;
    this.authInfo = authInfo;
    this.onObject = onObject;
    this.subscribeStream = subscribeStream;
    this.onEndOfGroup = onEndOfGroup;
  }

  /** Snapshot of the subscription's identity. */
  getInfo(): SubscriptionInfo {
    return {
      namespace: this.namespace,
      name: this.name,
      subscribeRequestId: this.subscribeRequestId,
      trackAlias: this.trackAlias,
    };
  }

  /**
   * Stop the subscription. draft-18 removed the UNSUBSCRIBE message: cancelling
   * the request stream's readable (STOP_SENDING) and closing its writable (FIN)
   * signals the publisher to stop sending objects for this subscription.
   */
  async unsubscribe(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      await this.subscribeStream.readable.cancel('unsubscribe'); // STOP_SENDING
    } catch {
      // Best-effort on teardown.
    }
    try {
      await this.subscribeStream.writable.close();
    } catch {
      // Best-effort on teardown.
    }
  }

  // ---- internal (called by Moq receive loops) ----------------------------

  // The writable half of the SUBSCRIBE request stream (used for keep-alive).
  _requestWritable(): WritableStream<Uint8Array> {
    return this.subscribeStream.writable;
  }

  // Read PUBLISH_DONE / late control messages that arrive on the subscribe
  // stream after SUBSCRIBE_OK. A stream close/reset ends the subscription.
  async _runResponseLoop(): Promise<void> {
    try {
      for (;;) {
        const msg = await moqParseMsg(this.subscribeStream.readable);
        if (msg.type === MOQ_MESSAGE_PUBLISH_DONE) {
          // Message already dumped by the central control-message logger.
          break;
        }
      }
    } catch {
      // Stream closed/reset.
    }
  }

  // Hand one received object payload to the callback; returns its EOF result.
  async _deliver(
    reader: ReadableStream<Uint8Array>,
    extensionHeaders: KvPair[],
    length?: number,
    groupId?: number,
    objectId?: number,
    isLastInGroup?: boolean,
  ): Promise<boolean> {
    // Datagrams pass isLastInGroup=true inline (end-of-group bit on the object),
    // so it rides with the object to the callback. Subgroup streams leave it
    // false and signal end-of-group retroactively via _signalEndOfGroup.
    return this.onObject(reader, extensionHeaders, length, groupId, objectId, isLastInGroup);
  }

  // Signal that a group finished at `lastObjId` (MoQ end-of-group), retroactively.
  // Called by the subgroup receive loop on the trailing end-of-group marker;
  // no-op when the subscriber did not register a callback.
  _signalEndOfGroup(groupId: number, lastObjId: number): void {
    this.onEndOfGroup?.(groupId, lastObjId);
  }
}

// Lifecycle of a `Moq` session.
export enum MoqState {
  Idle, // before init()
  Connecting, // init() called; transport + control stream coming up
  Running, // SETUP handshake done; control loop active
  Closed, // close() called
}

/**
 * A MoQ publisher session over WebTransport. Owns the transport, the control
 * stream, the inbound control loop (subscriptions), and the set of tracks.
 */
export class Moq {
  private moqt: MoqtState = moqCreate();
  private connecting: Promise<void> | null = null;
  private _state: MoqState = MoqState.Idle;

  // Current lifecycle state of the session.
  get state(): MoqState {
    return this._state;
  }

  private tracks: Track[] = [];
  private nextClientReqId: number | undefined = undefined;
  private nextAliasValue = INITIAL_TRACK_ALIAS;

  // Keep-alive loop (optional; configured via setup()).
  private keepAliveOpts: Required<KeepAliveOptions> | null = null;
  private keepAliveInterval: ReturnType<typeof setInterval> | null = null;
  private lastObjectSentMs = 0;

  // Subscriber state.
  private subscriptions: Subscription[] = [];
  private subscriptionsByAlias = new Map<number, Subscription>();
  private incomingLoopsStarted = false;

  // Publisher-serve state (Moq.publishNamespace / offerTrack). Tracks offered
  // under an announced namespace are served on demand when a matching SUBSCRIBE
  // arrives on an incoming bidirectional stream.
  private trackOffers: TrackOffer[] = [];
  private incomingBidiLoopStarted = false;

  // Resolves once the peer's SETUP has been received on its incoming control
  // (unidirectional) stream. draft-18 handshakes over a pair of uni streams
  // rather than a single bidi control stream, so we cannot simply read the reply
  // back on the stream we wrote to.
  private peerSetupReceived: Promise<void> | null = null;
  private resolvePeerSetup: (() => void) | null = null;

  /**
   * Open the transport (sync). Connection + control stream creation happen in
   * the background; `setup` and `addTrack` await readiness.
   */
  init(urlHostPort: string, options: MoqInitOptions = {}): void {
    const url = new URL(urlHostPort);
    url.protocol = 'https'; // WebTransport requires https

    const wtOptions: any = {};
    if (options.serverCertificateHash != null) {
      wtOptions.serverCertificateHashes = [
        { algorithm: 'sha-256', value: options.serverCertificateHash },
      ];
    }
    // Offer the MOQT version for transport-level negotiation. The browser maps
    // `protocols` to the WT-Available-Protocols header; engines that do not yet
    // support it ignore the option (no version is then offered).
    wtOptions.protocols = [options.alpnVersion ?? MOQ_ALPN_DRAFT18_VERSION];

    console.info(`${LOG_PREFIX} Opening MOQT to ${url}, options: ${JSON.stringify(wtOptions)}`);

    this.moqt.wt = new WebTransport(url.href, wtOptions);
    this.moqt.wt.closed.catch(() => {
      /* surfaced via failures of in-flight operations */
    });

    this._state = MoqState.Connecting;
    this.connecting = (async () => {
      await this.moqt.wt.ready;
      await moqCreateControlStream(this.moqt);
    })();
  }

  /** Perform the MoQ SETUP handshake and start the incoming receive loops. */
  async setup(keepAliveOpts?: KeepAliveOptions): Promise<void> {
    if (this._state === MoqState.Idle) {
      throw new Error('setup() called before init()');
    }
    await this.connecting;

    this.peerSetupReceived = new Promise<void>((resolve) => {
      this.resolvePeerSetup = resolve;
    });

    // The peer's SETUP arrives on its own incoming unidirectional stream, so the
    // incoming loops must be running before we can complete the handshake.
    this.ensureIncomingLoops();

    // Send our SETUP on the local unidirectional control stream, then wait for
    // the peer's SETUP (draft-18 §7).
    await moqSendSetup(this.controlWriter());
    await this.peerSetupReceived;

    this._state = MoqState.Running;

    if (keepAliveOpts !== undefined) {
      this.startKeepAlive(keepAliveOpts);
    }
  }

  /**
   * Publish a track. draft-18: open a dedicated bidirectional stream, send
   * PUBLISH on it, and await the peer's REQUEST_OK (or REQUEST_ERROR) read back
   * on that same stream.
   */
  async addTrack(
    namespace: string[],
    name: string,
    maxQueuedObjects: number,
    maxOpenStreams: number,
    authInfo: string | undefined,
    moqMapping: MoqMapping,
  ): Promise<Track> {
    if (this._state !== MoqState.Running) {
      if (this._state === MoqState.Idle) {
        throw new Error('addTrack() called before init()/setup()');
      }
      await this.connecting;
    }

    const trackAlias = this.allocateTrackAlias();
    const requestId = this.allocateClientReqId();

    const pubStream: WebTransportBidirectionalStream =
      await this.moqt.wt.createBidirectionalStream();
    await moqSendPublish(
      pubStream.writable,
      requestId,
      namespace,
      name,
      trackAlias,
      authInfo,
      MOQ_FORWARD_TRUE,
    );

    const resp = await moqParseMsg(pubStream.readable);
    if (resp.type !== MOQ_MESSAGE_REQUEST_OK) {
      throw new Error(`PUBLISH rejected (${resp.type}): ${JSON.stringify(resp.data)}`);
    }

    const track = new Track(
      this,
      namespace,
      name,
      trackAlias,
      requestId,
      maxQueuedObjects,
      maxOpenStreams,
      authInfo,
      moqMapping,
      pubStream,
    );
    // FORWARD defaults to 1 when the parameter is absent (draft-18 §9.2.2.8).
    // Relays typically REQUEST_OK with Forward State 0 until a subscriber exists,
    // then flip it via REQUEST_UPDATE on the publish stream (Track._runResponseLoop).
    const forwarding = forwardFromParameters(resp.data?.parameters ?? []) !== 0;
    if (forwarding) {
      track._addSubscriber(requestId, MOQ_FORWARD_TRUE, resp.data?.parameters ?? []);
    }
    track._setForwarding(forwarding);
    this.tracks.push(track);
    void track._runResponseLoop();
    return track;
  }

  /**
   * Announce a namespace with a single PUBLISH_NAMESPACE (draft-18 §9.3),
   * instead of one PUBLISH per track. draft-18: open a dedicated bidirectional
   * stream, send PUBLISH_NAMESPACE on it, and await the peer's REQUEST_OK (or
   * REQUEST_ERROR) read back on that same stream.
   *
   * After announcing, register the tracks you are willing to serve with
   * `offerTrack`; each `Track` is then created lazily when a matching SUBSCRIBE
   * arrives from a peer.
   */
  async publishNamespace(namespace: string[], authInfo: string | undefined): Promise<void> {
    if (this._state !== MoqState.Running) {
      if (this._state === MoqState.Idle) {
        throw new Error('publishNamespace() called before init()/setup()');
      }
      await this.connecting;
    }

    const requestId = this.allocateClientReqId();
    const nsStream: WebTransportBidirectionalStream =
      await this.moqt.wt.createBidirectionalStream();
    await moqSendPublishNamespace(nsStream.writable, requestId, namespace, authInfo);

    const resp = await moqParseMsg(nsStream.readable);
    if (resp.type !== MOQ_MESSAGE_REQUEST_OK) {
      throw new Error(`PUBLISH_NAMESPACE rejected (${resp.type}): ${JSON.stringify(resp.data)}`);
    }

    // Accept incoming SUBSCRIBEs so offered tracks under this namespace are
    // served. Late control messages on the announce stream (e.g. NAMESPACE_DONE)
    // are drained in the background.
    this.ensurePublisherBidiLoop();
    void this.drainAnnounceStream(nsStream.readable);
  }

  /**
   * Register a track to serve under a namespace previously announced with
   * `publishNamespace`. The `Track` is created only when a peer SUBSCRIBEs to a
   * matching (namespace, name); `offer.onSubscribed` then fires with the handle.
   */
  offerTrack(offer: TrackOffer): void {
    this.trackOffers.push(offer);
  }

  // Drain (and ignore) any late control messages the peer sends on the
  // PUBLISH_NAMESPACE stream after REQUEST_OK, until it closes.
  private async drainAnnounceStream(readable: ReadableStream<Uint8Array>): Promise<void> {
    try {
      for (;;) {
        // Drain and discard; each message is dumped by the central logger.
        await moqParseMsg(readable);
      }
    } catch {
      // Announce stream closed/reset.
    }
  }

  /**
   * Subscribe to a track. draft-18: open a dedicated bidirectional stream, send
   * SUBSCRIBE on it, and await SUBSCRIBE_OK read back on the same stream. Objects
   * arrive on separate unidirectional subgroup streams / datagrams, routed to
   * `onObject` by the negotiated track alias. A rejection is retried after
   * `SLEEP_SUBSCRIBE_ERROR_MS` with a fresh request stream. `onEndOfGroup`, if
   * given, fires when each group completes (MoQ end-of-group).
   */
  async subscribe(
    namespace: string[],
    name: string,
    authInfo: string | undefined,
    onObject: ObjectCallback,
    onEndOfGroup?: EndOfGroupCallback,
  ): Promise<Subscription> {
    if (this._state !== MoqState.Running) {
      if (this._state === MoqState.Idle) {
        throw new Error('subscribe() called before init()/setup()');
      }
      await this.connecting;
    }

    // Make sure the incoming stream / datagram receive loops are running before
    // any objects can arrive.
    this.ensureIncomingLoops();

    // Retry on rejection with a fresh request id + stream, mirroring the relay
    // race handling the legacy downloader had.
    for (;;) {
      const requestId = this.allocateClientReqId();
      const subStream: WebTransportBidirectionalStream =
        await this.moqt.wt.createBidirectionalStream();
      await moqSendSubscribe(subStream.writable, requestId, namespace, name, authInfo);
      const resp = await moqParseMsg(subStream.readable);
      if (resp.type === MOQ_MESSAGE_SUBSCRIBE_OK) {
        const trackAlias = resp.data.trackAlias;
        const sub = new Subscription(
          this,
          namespace,
          name,
          requestId,
          trackAlias,
          authInfo,
          onObject,
          subStream,
          onEndOfGroup,
        );
        this.subscriptions.push(sub);
        this.subscriptionsByAlias.set(trackAlias, sub);
        void sub._runResponseLoop();
        console.log(
          `${LOG_PREFIX} SUBSCRIBE_OK for ${getTrackFullName(namespace as any, name)} (alias ${trackAlias})`,
        );
        return sub;
      }

      // REQUEST_ERROR or unexpected: close the stream and retry.
      console.warn(
        `${LOG_PREFIX} SUBSCRIBE failed for ${getTrackFullName(namespace as any, name)} (${resp.type}): ${JSON.stringify(resp.data)}. Retrying in ${SLEEP_SUBSCRIBE_ERROR_MS}ms`,
      );
      try {
        await subStream.writable.close();
        await subStream.readable.cancel('retry');
      } catch {
        // ignore
      }
      await new Promise((r) => setTimeout(r, SLEEP_SUBSCRIBE_ERROR_MS));
    }
  }

  /** Drop queues, close tracks/subscriptions and the transport (best-effort, async teardown). */
  close(): void {
    if (this._state === MoqState.Closed) {
      return;
    }
    this._state = MoqState.Closed;
    this.stopKeepAlive();

    // Tear down asynchronously. draft-18: each track/subscription closes its own
    // request stream (PUBLISH_DONE + FIN / STOP_SENDING), independent of the
    // unidirectional control stream, before moqClose() tears down the transport.
    const tracks = this.tracks;
    this.tracks = [];
    const subscriptions = this.subscriptions;
    this.subscriptions = [];
    this.subscriptionsByAlias.clear();
    void (async () => {
      await Promise.allSettled(subscriptions.map((sub) => sub.unsubscribe()));
      await Promise.allSettled(tracks.map((track) => track.close()));
      await moqClose(this.moqt);
    })();
  }

  // ---- keep-alive --------------------------------------------------------

  private startKeepAlive(opts: KeepAliveOptions): void {
    if (opts.everyMs <= 0) {
      return;
    }
    this.keepAliveOpts = {
      everyMs: opts.everyMs,
      namespace: opts.namespace ?? 'keepAlive',
      name: opts.name ?? `${Math.floor(Math.random() * 10000000)}`,
    };
    console.log(`${LOG_PREFIX} Starting keep alive every ${opts.everyMs}ms`);
    this.keepAliveInterval = setInterval(() => void this.maybeSendKeepAlive(), opts.everyMs);
  }

  private stopKeepAlive(): void {
    if (this.keepAliveInterval !== null) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }
    this.keepAliveOpts = null;
  }

  // Send a keep-alive only when the session has been idle for `everyMs`. draft-18
  // has no keep-alive PUBLISH on the control stream; instead we send a no-op
  // REQUEST_UPDATE on an already-open request stream (a published track's stream,
  // or failing that a subscription's). No-op when there is nothing open.
  private async maybeSendKeepAlive(): Promise<void> {
    const opts = this.keepAliveOpts;
    if (opts === null || this._state !== MoqState.Running) {
      return;
    }
    if (Date.now() - this.lastObjectSentMs <= opts.everyMs) {
      return;
    }
    const track = this.tracks[0];
    const sub = this.subscriptions[0];
    try {
      if (track !== undefined) {
        await moqSendRequestUpdate(track._publishWritable(), track.publisherRequestId, []);
      } else if (sub !== undefined) {
        await moqSendRequestUpdate(sub._requestWritable(), sub.subscribeRequestId, []);
      } else {
        return;
      }
      console.log(`${LOG_PREFIX} Sent keep alive (request update)`);
    } catch (err) {
      console.warn(`${LOG_PREFIX} keep alive failed: ${err}`);
    }
  }

  // ---- internal accessors used by Track ----------------------------------

  _wt(): any {
    return this.moqt.wt;
  }
  _markObjectSent(): void {
    this.lastObjectSentMs = Date.now();
  }

  // ---- incoming stream / datagram loops ----------------------------------

  // Start the incoming unidirectional-stream and datagram loops once. They run
  // in the background until close(); errors after close are expected. Unlike
  // draft-18 there is no single control-message loop: request responses are read
  // on their own bidi streams (Track/Subscription._runResponseLoop), and the peer
  // SETUP + object subgroups arrive here on incoming unidirectional streams.
  private ensureIncomingLoops(): void {
    if (this.incomingLoopsStarted) {
      return;
    }
    this.incomingLoopsStarted = true;
    this.runIncomingUniLoop().catch((err) => {
      if (this._state !== MoqState.Closed) {
        console.error(`${LOG_PREFIX} Incoming stream loop error: ${err}`);
      }
    });
    this.runDatagramReceiveLoop().catch((err) => {
      if (this._state !== MoqState.Closed) {
        console.error(`${LOG_PREFIX} Datagram receive loop error: ${err}`);
      }
    });
  }

  // Start the publisher-role incoming bidirectional-stream loop once. Only needed
  // for the publisher-serve role (publishNamespace): peers open a bidi stream per
  // request (SUBSCRIBE, ...). Runs in the background until close().
  private ensurePublisherBidiLoop(): void {
    if (this.incomingBidiLoopStarted) {
      return;
    }
    this.incomingBidiLoopStarted = true;
    this.runPublisherBidiLoop().catch((err) => {
      if (this._state !== MoqState.Closed) {
        console.error(`${LOG_PREFIX} Publisher bidi loop error: ${err}`);
      }
    });
  }

  // Accept incoming bidirectional QUIC streams for the PUBLISHER role. In the
  // publisher-serve model (Moq.publishNamespace) each incoming bidi stream begins
  // with a request the peer directs at us as a publisher — SUBSCRIBE, or the
  // namespace-discovery requests we do not implement (draft-18 runs every request
  // on its own stream).
  private async runPublisherBidiLoop(): Promise<void> {
    const reader = this._wt().incomingBidirectionalStreams.getReader();
    while (this._state !== MoqState.Closed) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      // No await on purpose: handle each incoming request concurrently.
      void this.handlePublisherBidiStream(value as WebTransportBidirectionalStream);
    }
  }

  // Dispatch one incoming bidi request stream directed at us as a PUBLISHER.
  // Only SUBSCRIBE is served; the namespace-discovery requests a peer may send to
  // a publisher (PUBLISH_NAMESPACE, i.e. a peer announcing back to us, and
  // SUBSCRIBE_NAMESPACE, prefix discovery) are consumed and politely rejected
  // with REQUEST_ERROR NOT_SUPPORTED — this app publishes media, it does not act
  // as a relay/aggregator.
  private async handlePublisherBidiStream(
    stream: WebTransportBidirectionalStream,
  ): Promise<void> {
    let msg;
    try {
      // moqParseMsg reads the length-prefixed body, so the request is fully
      // consumed off the stream even for the types we do not implement.
      msg = await moqParseMsg(stream.readable);
    } catch {
      return; // empty / garbage stream
    }

    if (msg.type === MOQ_MESSAGE_SUBSCRIBE) {
      await this.onIncomingSubscribe(msg.data as ParsedSubscribe, stream);
      return;
    }

    if (
      msg.type === MOQ_MESSAGE_PUBLISH_NAMESPACE ||
      msg.type === MOQ_MESSAGE_SUBSCRIBE_NAMESPACE
    ) {
      // Recognized but unimplemented namespace requests: reject so the peer gets
      // a clean answer instead of a silently dropped/reset stream. The request
      // itself (and our REQUEST_ERROR reply) are dumped by the central logger.
      const name =
        msg.type === MOQ_MESSAGE_PUBLISH_NAMESPACE ? 'PUBLISH_NAMESPACE' : 'SUBSCRIBE_NAMESPACE';
      try {
        await moqSendRequestError(
          stream.writable,
          MOQ_REQUEST_ERROR_NOT_SUPPORTED,
          `${name} not supported`,
        );
        await stream.writable.close();
      } catch {
        // ignore
      }
      return;
    }

    console.warn(`${LOG_PREFIX} Unsupported incoming bidi message type 0x${msg.type.toString(16)}`);
    try {
      await stream.readable.cancel('unsupported');
      await stream.writable.close();
    } catch {
      // ignore
    }
  }

  // Serve an incoming SUBSCRIBE against the registered track offers: reply
  // SUBSCRIBE_OK on the request stream and create a Track that streams objects
  // for it. Rejects with REQUEST_ERROR when no offer matches (namespace, name).
  private async onIncomingSubscribe(
    sub: ParsedSubscribe,
    stream: WebTransportBidirectionalStream,
  ): Promise<void> {
    const offer = this.trackOffers.find(
      (o) => namespaceEquals(o.namespace, sub.namespace) && o.name === sub.trackName,
    );
    if (offer === undefined) {
      console.warn(
        `${LOG_PREFIX} SUBSCRIBE for unknown track [${sub.namespace.join('/')}]/${sub.trackName}`,
      );
      try {
        await moqSendRequestError(
          stream.writable,
          MOQ_REQUEST_ERROR_DOES_NOT_EXIST,
          'Track not offered',
        );
        await stream.writable.close();
      } catch {
        // ignore
      }
      return;
    }

    const trackAlias = this.allocateTrackAlias();
    // Live edge: no Largest Object in SUBSCRIBE_OK.
    await moqSendSubscribeOk(stream.writable, trackAlias);
    console.log(
      `${LOG_PREFIX} SUBSCRIBE_OK for [${sub.namespace.join('/')}]/${sub.trackName} (alias ${trackAlias})`,
    );

    const track = new Track(
      this,
      offer.namespace,
      offer.name,
      trackAlias,
      sub.requestId,
      offer.maxQueuedObjects,
      offer.maxOpenStreams,
      offer.authInfo,
      offer.moqMapping,
      stream,
    );
    // A SUBSCRIBE means the peer wants objects now; FORWARD defaults to 1.
    const forward = forwardFromParameters(sub.parameters);
    track._addSubscriber(sub.requestId, forward, sub.parameters);
    track._setForwarding(forward !== MOQ_FORWARD_FALSE);
    this.tracks.push(track);
    if (offer.onSubscribed !== undefined) {
      offer.onSubscribed(track);
    }
    // When the subscribe stream ends (unsubscribe / reset), stop and forget it.
    void track._runResponseLoop().finally(() => {
      track._setForwarding(false);
      this.removeTrack(track);
      if (offer.onUnsubscribed !== undefined) {
        offer.onUnsubscribed(track);
      }
    });
  }

  // Drop a served track from the session (called when its subscription ends).
  private removeTrack(track: Track): void {
    const idx = this.tracks.indexOf(track);
    if (idx >= 0) {
      this.tracks.splice(idx, 1);
    }
  }

  // Accept incoming unidirectional QUIC streams and demux by their leading
  // stream type: the peer control stream (begins with SETUP), an object subgroup
  // header, or padding.
  private async runIncomingUniLoop(): Promise<void> {
    const reader = this._wt().incomingUnidirectionalStreams.getReader();
    while (this._state !== MoqState.Closed) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      // No await on purpose: handle each incoming stream concurrently.
      void this.handleIncomingUniStream(value as ReadableStream<Uint8Array>);
    }
  }

  private async handleIncomingUniStream(stream: ReadableStream<Uint8Array>): Promise<void> {
    let type: number;
    try {
      type = await moqReadVarintType(stream);
    } catch {
      return; // empty / garbage stream
    }

    if (type === MOQ_MESSAGE_SETUP) {
      await this.handlePeerControlStream(stream);
      return;
    }
    if (isMoqObjectStreamHeaderType(type)) {
      try {
        const header = await moqParseObjectHeaderWithType(stream, type);
        await this.receiveSubgroupStream(stream, header);
      } catch (err) {
        if (this._state !== MoqState.Closed) {
          console.warn(`${LOG_PREFIX} subgroup stream error: ${err}`);
        }
      }
      return;
    }
    if (type === MOQ_STREAM_TYPE_PADDING) {
      // Discard padding to release flow control.
      try {
        await stream.cancel('padding');
      } catch {
        // ignore
      }
      return;
    }
    console.warn(`${LOG_PREFIX} Unsupported incoming stream type ${type}`);
  }

  // The peer's control stream begins with SETUP (type already read); consume the
  // SETUP body to complete the handshake, then drain subsequent control messages
  // (e.g. GOAWAY) until the stream closes.
  private async handlePeerControlStream(stream: ReadableStream<Uint8Array>): Promise<void> {
    this.moqt.controlReader = stream;
    try {
      await moqParseControlMessageWithType(stream, MOQ_MESSAGE_SETUP);
    } catch (err) {
      console.error(`${LOG_PREFIX} Failed to parse peer SETUP: ${err}`);
      return;
    }
    if (this.resolvePeerSetup !== null) {
      this.resolvePeerSetup();
      this.resolvePeerSetup = null;
    }
    try {
      while (this._state !== MoqState.Closed) {
        // Drain and discard; each message is dumped by the central logger.
        await moqParseMsg(stream);
      }
    } catch {
      // Control stream closed.
    }
  }

  // Read every object out of one subgroup stream, routing payloads to the
  // matching subscription by track alias.
  private async receiveSubgroupStream(
    readerStream: ReadableStream<Uint8Array>,
    header: ObjectHeader,
  ): Promise<void> {
    const sub = this.subscriptionsByAlias.get(header.trackAlias);
    if (sub === undefined) {
      // No subscription for this alias: nothing to route the objects to.
      return;
    }
    let isEOF = false;
    let numObjRead = 0;
    let endOfGroupSignaled = false;
    // Reconstruct the per-object id from arrival order: the subgroup wire format
    // carries an object-id delta of 0 for every object (see writeObject), so the
    // parsed objSeq is unusable. QUIC delivers a subgroup stream in order and the
    // publisher writes objects in send order, so the count is the object id
    // within this group.
    let objIndex = 0;
    while (this._state !== MoqState.Closed && !isEOF) {
      try {
        const objHeader = await moqParseObjectFromSubgroupHeader(readerStream, header.type);
        isEOF = isEndOfGroupStatus(objHeader.status);
        if (isEOF) {
          // Explicit MoQ end-of-group marker (zero-payload status object). It
          // trails the group's last payload object, so objIndex-1 is that
          // object's id.
          if (objIndex > 0) {
            sub._signalEndOfGroup(header.groupSeq, objIndex - 1);
            endOfGroupSignaled = true;
          }
        } else if (objHeader.payloadLength > 0) {
          isEOF = await sub._deliver(
            readerStream,
            objHeader.extensionHeaders,
            objHeader.payloadLength,
            header.groupSeq,
            objIndex,
          );
          objIndex++;
        }
        numObjRead++;
      } catch (err: any) {
        // A reader on a closed stream throws. Objects with a single
        // subgroup/group do not always send an end-of-group marker, so once we
        // have read at least one object we treat a read error as EOF.
        if (
          numObjRead > 0 ||
          (err instanceof WebTransportError && err.message.includes('The session is closed'))
        ) {
          isEOF = true;
        } else {
          throw err;
        }
      }
    }
    // A subgroup stream carries exactly one group. If it ended without an
    // explicit end-of-group status object -- the common case for one object per
    // group, where the stream just FINs (often the relay closes it as soon as the
    // single object is delivered, before the publisher's trailing marker rolls
    // out on the next group) -- the finished stream still means the group is
    // complete at the last object read. Signal it so the receiver does not treat
    // the next group's first object as a discontinuity.
    if (!endOfGroupSignaled && objIndex > 0) {
      sub._signalEndOfGroup(header.groupSeq, objIndex - 1);
    }
  }

  // Accept incoming datagrams (one object per datagram).
  private async runDatagramReceiveLoop(): Promise<void> {
    const reader = this._wt().datagrams.readable.getReader();
    while (this._state !== MoqState.Closed) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      // Wrap the whole datagram in a BYOB-capable reader for the parsers.
      const readable = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(value);
          controller.close();
        },
        type: 'bytes',
      } as any);

      const header = await moqParseObjectHeader(readable);
      if (!isMoqObjectDatagramType(header.type)) {
        throw new Error(`Received a non datagram-encoded object ${JSON.stringify(header)}`);
      }
      const sub = this.subscriptionsByAlias.get(header.trackAlias);
      if (sub === undefined) {
        continue;
      }
      // Status datagrams carry no payload (length 0 still decodes headers).
      const datagramType = moqDecodeDatagramType(header.type);
      const length = datagramType.isStatus ? 0 : undefined;
      // Datagram headers carry a real object id (unlike subgroup streams) and the
      // end-of-group bit inline, so it rides with the object to the callback as
      // isLastInGroup (no separate retroactive signal needed for datagrams).
      await sub._deliver(
        readable,
        header.extensionHeaders ?? [],
        length,
        header.groupSeq,
        header.objSeq,
        datagramType.isEndOfGroup,
      );
    }
  }

  // ---- helpers -----------------------------------------------------------

  private controlWriter(): WritableStream<Uint8Array> {
    return this.moqt.controlWriter as WritableStream<Uint8Array>;
  }

  private allocateClientReqId(): number {
    this.nextClientReqId =
      this.nextClientReqId === undefined ? 0 : this.nextClientReqId + CLIENT_REQUEST_ID_STEP;
    return this.nextClientReqId;
  }
  private allocateTrackAlias(): number {
    return this.nextAliasValue++;
  }
}

// True when an object header status marks the end of a group/track.
function isEndOfGroupStatus(status: number | undefined): boolean {
  return status === MOQ_OBJ_STATUS_END_OF_GROUP || status === MOQ_OBJ_STATUS_END_OF_TRACK_AND_GROUP;
}

// Read the FORWARD parameter (draft-18 §9.2.2.8); returns 1 when absent.
function forwardFromParameters(parameters: KvPair[]): number {
  const fwd = parameters.find((p) => p.name === MOQ_PARAMETER_FORWARD);
  return fwd === undefined ? MOQ_FORWARD_TRUE : (fwd.val as number);
}

// Compare two track-namespace tuples for equality.
function namespaceEquals(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((part, i) => part === b[i]);
}
