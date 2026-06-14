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
//   await moq.setup();                                              // CLIENT/SERVER_SETUP
//   // The MOQT version is negotiated by the transport via ALPN /
//   // WT-Available-Protocols (draft-16), so setup() carries no version.
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
  moqSendClientSetup,
  moqParseMsg,
  moqSendPublish,
  moqSendPublishDone,
  moqSendSubscribe,
  moqSendUnSubscribe,
  moqSendSubscribeOk,
  moqSendRequestError,
  moqSendSubgroupHeader,
  moqSendObjectSubgroupToWriter,
  moqSendObjectEndOfGroupToWriter,
  moqSendObjectPerDatagramToWriter,
  moqParseObjectHeader,
  moqParseObjectFromSubgroupHeader,
  isMoqObjectStreamHeaderType,
  isMoqObjectDatagramType,
  moqDecodeDatagramType,
  getAuthInfofromParameters,
  getTrackFullName,
  MOQ_MESSAGE_SERVER_SETUP,
  MOQ_MESSAGE_PUBLISH_OK,
  MOQ_MESSAGE_PUBLISH_DONE,
  MOQ_MESSAGE_MAX_REQUEST_ID,
  MOQ_MESSAGE_SUBSCRIBE,
  MOQ_MESSAGE_SUBSCRIBE_OK,
  MOQ_MESSAGE_REQUEST_OK,
  MOQ_MESSAGE_REQUEST_ERROR,
  MOQ_MESSAGE_REQUEST_UPDATE,
  MOQ_MESSAGE_UNSUBSCRIBE,
  MOQ_PARAMETER_FORWARD,
  MOQ_OBJ_STATUS_END_OF_GROUP,
  MOQ_OBJ_STATUS_END_OF_TRACK_AND_GROUP,
  MOQ_PUBLISHER_PRIORITY_BASE_DEFAULT,
  MOQ_SUBSCRIPTION_ERROR_INTERNAL,
  MOQ_STATUS_TRACK_ENDED,
  MOQ_FORWARD_TRUE,
  type MoqtState,
  type KvPair,
  type ObjectHeader,
  MOQ_ALPN_DRAFT16_VERSION,
} from './moqt.js';

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
  // MOQT ALPN token (e.g. "moqt-16"). draft-16 negotiates the version via the
  // transport (ALPN over native QUIC, WT-Available-Protocols over WebTransport),
  // so this is offered to WebTransport as `protocols` rather than sent in SETUP.
  // Optional; defaults to MOQ_ALPN_DRAFT16_VERSION when omitted.
  alpnVersion?: string;
}

/**
 * Called for every object received on a subscription. It is handed the raw
 * payload reader (a `ReadableStream` positioned at the object payload), the
 * object extension headers, and the payload length (`undefined` means "read to
 * the end of the datagram"). It returns whether this was the last object
 * (end of stream). Media decoding lives in the caller, keeping `Moq` media-free.
 */
export type ObjectCallback = (
  reader: ReadableStream<Uint8Array>,
  extensionHeaders: KvPair[],
  length?: number,
) => Promise<boolean> | boolean;

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
  private queue: ObjData[] = [];
  private draining = false;
  private closed = false;
  // Forward State for this subscription (draft-16). The relay toggles it via
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
  ) {
    this.moq = moq;
    this.namespace = namespace;
    this.name = name;
    this.trackAlias = trackAlias;
    this.publisherRequestId = publisherRequestId;
    this.maxQueuedObjects =
      maxQueuedObjects > 0 ? maxQueuedObjects : Number.MAX_SAFE_INTEGER;
    this.maxOpenStreams =
      maxOpenStreams > 0 ? maxOpenStreams : Number.MAX_SAFE_INTEGER;
    this.authInfo = authInfo;
    this.moqMapping = moqMapping;
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

    // Forward-state gating (draft-16 §5.1): the publisher does not send Objects
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

    // Drop anything still queued.
    for (const obj of this.queue) {
      obj.status = 'aborted';
    }
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

    try {
      await moqSendPublishDone(
        this.moq._controlWriter(),
        this.publisherRequestId,
        MOQ_STATUS_TRACK_ENDED,
        this.subscribers.length,
        'Subscription Ended, the stream has finished',
      );
    } catch {
      // Best-effort on teardown.
    }
  }

  // ---- internal (called by Moq / ObjData) --------------------------------

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
        try {
          await this.writeObject(obj);
          obj.status = 'sent';
        } catch (err) {
          obj.status = 'dropped';
          console.error(`${LOG_PREFIX} Failed to write object ${obj.groupId}/${obj.objId}: ${err}`);
        }
        this.queue.shift();
        if (obj.status === 'sent') {
          this.moq._markObjectSent();
          if (obj.callback) {
            obj.callback(obj);
          }
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async writeObject(obj: ObjData): Promise<void> {
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
      return;
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
      const uniStream = await this.moq._wt().createUnidirectionalStream({ sendOrder: obj.priority });
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
  private closed = false;

  constructor(
    moq: Moq,
    namespace: string[],
    name: string,
    subscribeRequestId: number,
    trackAlias: number,
    authInfo: string | undefined,
    onObject: ObjectCallback,
  ) {
    this.moq = moq;
    this.namespace = namespace;
    this.name = name;
    this.subscribeRequestId = subscribeRequestId;
    this.trackAlias = trackAlias;
    this.authInfo = authInfo;
    this.onObject = onObject;
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

  /** Stop the subscription (best-effort UNSUBSCRIBE). */
  async unsubscribe(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      await moqSendUnSubscribe(this.moq._controlWriter(), this.subscribeRequestId);
    } catch {
      // Best-effort on teardown.
    }
  }

  // ---- internal (called by Moq receive loops) ----------------------------

  // Hand one received object payload to the callback; returns its EOF result.
  async _deliver(
    reader: ReadableStream<Uint8Array>,
    extensionHeaders: KvPair[],
    length?: number,
  ): Promise<boolean> {
    return this.onObject(reader, extensionHeaders, length);
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

  // Pending addTrack PUBLISH requests, keyed by request id.
  private pendingPublish = new Map<
    number,
    { resolve: (data: any) => void; reject: (err: any) => void }
  >();

  // Subscriber state.
  private subscriptions: Subscription[] = [];
  private subscriptionsByAlias = new Map<number, Subscription>();
  private receiveLoopsStarted = false;
  // Pending subscribe SUBSCRIBE requests, keyed by request id.
  private pendingSubscribe = new Map<
    number,
    { resolve: (data: any) => void; reject: (err: any) => void }
  >();

  /**
   * Open the transport (sync). Connection + control stream creation happen in
   * the background; `setup` and `addTrack` await readiness.
   */
  init(urlHostPort: string, options: MoqInitOptions = {}): void {
    const url = new URL(urlHostPort);
    url.protocol = 'https'; // WebTransport requires https

    const wtOptions: any = {};
    if (options.serverCertificateHash != null) {
      wtOptions.serverCertificateHashes = [{ algorithm: 'sha-256', value: options.serverCertificateHash }];
    }
    // Offer the MOQT version for transport-level negotiation. The browser maps
    // `protocols` to the WT-Available-Protocols header; engines that do not yet
    // support it ignore the option (no version is then offered).
    wtOptions.protocols = [options.alpnVersion ?? MOQ_ALPN_DRAFT16_VERSION];

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

  /** Perform the MoQ SETUP handshake and start the control loop. */
  async setup(
    keepAliveOpts?: KeepAliveOptions,
  ): Promise<void> {
    if (this._state === MoqState.Idle) {
      throw new Error('setup() called before init()');
    }
    await this.connecting;

    await moqSendClientSetup(this.controlWriter());
    const msg = await moqParseMsg(this.controlReader());
    if (msg.type !== MOQ_MESSAGE_SERVER_SETUP) {
      throw new Error(`Expected MOQ_MESSAGE_SERVER_SETUP, received ${msg.type}`);
    }

    this._state = MoqState.Running;
    // Control loop runs in the background until close().
    this.runControlLoop().catch((err) => {
      if (this._state === MoqState.Running) {
        console.error(`${LOG_PREFIX} Control loop error: ${err}`);
      }
    });

    if (keepAliveOpts !== undefined) {
      this.startKeepAlive(keepAliveOpts);
    }
  }

  /** Publish a track (sends PUBLISH, resolves on PUBLISH_OK). */
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

    const published = new Promise<any>((resolve, reject) => {
      this.pendingPublish.set(requestId, { resolve, reject });
    });
    await moqSendPublish(this.controlWriter(), requestId, namespace, name, trackAlias, authInfo, 1);
    const resp = await published;

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
    );
    // FORWARD defaults to 1 when the parameter is absent (draft-16 §9.2.2.8).
    // Relays typically PUBLISH_OK with Forward State 0 until a subscriber exists.
    const forwarding = forwardFromParameters(resp?.parameters ?? []) !== 0;
    if (forwarding) {
      track._addSubscriber(requestId, MOQ_FORWARD_TRUE, resp?.parameters ?? []);
    }
    track._setForwarding(forwarding);
    this.tracks.push(track);
    return track;
  }

  /**
   * Subscribe to a track (sends SUBSCRIBE, resolves on SUBSCRIBE_OK). Objects
   * received for the track are routed to `onObject` by the negotiated track
   * alias. A SUBSCRIBE_ERROR is retried after `SLEEP_SUBSCRIBE_ERROR_MS`.
   */
  async subscribe(
    namespace: string[],
    name: string,
    authInfo: string | undefined,
    onObject: ObjectCallback,
  ): Promise<Subscription> {
    if (this._state !== MoqState.Running) {
      if (this._state === MoqState.Idle) {
        throw new Error('subscribe() called before init()/setup()');
      }
      await this.connecting;
    }

    // Make sure the incoming stream / datagram receive loops are running before
    // any objects can arrive.
    this.ensureReceiveLoops();

    // Retry on SUBSCRIBE_ERROR with a fresh request id, mirroring the relay
    // race handling the legacy downloader had.
    for (;;) {
      const requestId = this.allocateClientReqId();
      const answered = new Promise<any>((resolve, reject) => {
        this.pendingSubscribe.set(requestId, { resolve, reject });
      });
      await moqSendSubscribe(this.controlWriter(), requestId, namespace, name, authInfo);
      try {
        const resp = await answered;
        const sub = new Subscription(
          this,
          namespace,
          name,
          requestId,
          resp.trackAlias,
          authInfo,
          onObject,
        );
        this.subscriptions.push(sub);
        this.subscriptionsByAlias.set(resp.trackAlias, sub);
        console.log(
          `${LOG_PREFIX} SUBSCRIBE_OK for ${getTrackFullName(namespace as any, name)} (alias ${resp.trackAlias})`,
        );
        return sub;
      } catch (err) {
        console.warn(
          `${LOG_PREFIX} SUBSCRIBE_ERROR for ${getTrackFullName(namespace as any, name)}: ${err}. Retrying in ${SLEEP_SUBSCRIBE_ERROR_MS}ms`,
        );
        await new Promise((r) => setTimeout(r, SLEEP_SUBSCRIBE_ERROR_MS));
      }
    }
  }

  /** Drop queues, close tracks/subscriptions and the transport (best-effort, async teardown). */
  close(): void {
    if (this._state === MoqState.Closed) {
      return;
    }
    this._state = MoqState.Closed;
    this.stopKeepAlive();

    // Tear down asynchronously: tracks must finish closing (they send
    // PUBLISH_DONE on the control stream, which locks the control writer)
    // BEFORE moqClose() closes that stream, otherwise the writer is still
    // locked and close() throws "Cannot close a locked stream".
    const tracks = this.tracks;
    this.tracks = [];
    const subscriptions = this.subscriptions;
    this.subscriptions = [];
    this.subscriptionsByAlias.clear();
    void (async () => {
      // Unsubscribe sequentially so we never hold two control-writer locks.
      for (const sub of subscriptions) {
        await sub.unsubscribe();
      }
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

  // Send a keep-alive PUBLISH only when the session has been idle for `everyMs`.
  private async maybeSendKeepAlive(): Promise<void> {
    const opts = this.keepAliveOpts;
    if (opts === null || this._state !== MoqState.Running) {
      return;
    }
    if (Date.now() - this.lastObjectSentMs <= opts.everyMs) {
      return;
    }
    await moqSendPublish(
      this.controlWriter(),
      this.allocateClientReqId(),
      [opts.namespace],
      opts.name,
      KEEPALIVE_TRACK_ALIAS,
      undefined,
    );
    console.log(`${LOG_PREFIX} Sent keep alive (publish)`);
  }

  // ---- internal accessors used by Track ----------------------------------

  _wt(): any {
    return this.moqt.wt;
  }
  _controlWriter(): WritableStream<Uint8Array> {
    return this.controlWriter();
  }
  _markObjectSent(): void {
    this.lastObjectSentMs = Date.now();
  }

  // ---- control loop ------------------------------------------------------

  private async runControlLoop(): Promise<void> {
    while (this._state === MoqState.Running) {
      const msg = await moqParseMsg(this.controlReader());
      switch (msg.type) {
        case MOQ_MESSAGE_PUBLISH_OK:
          console.log(`${LOG_PREFIX} received PUBLISH_OK ${JSON.stringify(msg.data)}`);
          this.resolvePublish(msg.data, true);
          break;
        case MOQ_MESSAGE_SUBSCRIBE_OK:
          console.log(`${LOG_PREFIX} received SUBSCRIBE_OK ${JSON.stringify(msg.data)}`);
          this.resolveSubscribe(msg.data, true);
          break;
        case MOQ_MESSAGE_REQUEST_ERROR:
          // draft-16 unified error; route by Request ID to whichever request is pending.
          console.log(`${LOG_PREFIX} received REQUEST_ERROR ${JSON.stringify(msg.data)}`);
          this.rejectByRequestId(msg.data);
          break;
        case MOQ_MESSAGE_REQUEST_OK:
          // Response to REQUEST_UPDATE/TRACK_STATUS/etc. Informational here.
          console.log(`${LOG_PREFIX} received REQUEST_OK ${JSON.stringify(msg.data)}`);
          break;
        case MOQ_MESSAGE_PUBLISH_DONE:
          console.log(`${LOG_PREFIX} received PUBLISH_DONE ${JSON.stringify(msg.data)}`);
          break;
        case MOQ_MESSAGE_SUBSCRIBE:
          console.log(`${LOG_PREFIX} received MOQ_MESSAGE_SUBSCRIBE ${JSON.stringify(msg.data)}`);
          await this.onSubscribe(msg.data);
          break;
        case MOQ_MESSAGE_REQUEST_UPDATE:
          console.log(`${LOG_PREFIX} received MOQ_MESSAGE_REQUEST_UPDATE ${JSON.stringify(msg.data)}`);
          this.onRequestUpdate(msg.data);
          break;
        case MOQ_MESSAGE_UNSUBSCRIBE:
          console.log(`${LOG_PREFIX} received MOQ_MESSAGE_UNSUBSCRIBE ${JSON.stringify(msg.data)}`);
          this.onUnsubscribe(msg.data);
          break;
        case MOQ_MESSAGE_MAX_REQUEST_ID:
          console.log(`${LOG_PREFIX} received MOQ_MESSAGE_MAX_REQUEST_ID ${JSON.stringify(msg.data)}`);
          break; // informational
        default:
          console.warn(`${LOG_PREFIX} Unexpected control message type ${msg.type}, ignoring`);
      }
    }
  }

  // Resolve a pending addTrack on PUBLISH_OK. An unknown request id is treated
  // as a keep-alive answer and ignored.
  private resolvePublish(data: any, ok: boolean): void {
    const pending = this.pendingPublish.get(data?.reqId);
    if (pending === undefined) {
      return;
    }
    this.pendingPublish.delete(data.reqId);
    ok ? pending.resolve(data) : pending.reject(new Error(`PUBLISH rejected: ${JSON.stringify(data)}`));
  }

  // Resolve a pending subscribe on SUBSCRIBE_OK. An unknown request id is
  // ignored (e.g. a late answer after we already retried).
  private resolveSubscribe(data: any, ok: boolean): void {
    const pending = this.pendingSubscribe.get(data?.requestId);
    if (pending === undefined) {
      return;
    }
    this.pendingSubscribe.delete(data.requestId);
    ok
      ? pending.resolve(data)
      : pending.reject(new Error(`SUBSCRIBE rejected: ${JSON.stringify(data)}`));
  }

  // draft-16 REQUEST_ERROR is unified; route it by Request ID to whichever
  // pending publish or subscribe it answers.
  private rejectByRequestId(data: any): void {
    const id = data?.requestId;
    const err = new Error(`REQUEST_ERROR: ${JSON.stringify(data)}`);
    const pubPending = this.pendingPublish.get(id);
    if (pubPending !== undefined) {
      this.pendingPublish.delete(id);
      pubPending.reject(err);
      return;
    }
    const subPending = this.pendingSubscribe.get(id);
    if (subPending !== undefined) {
      this.pendingSubscribe.delete(id);
      subPending.reject(err);
    }
  }

  private async onSubscribe(subscribe: any): Promise<void> {
    const fullTrackName = getTrackFullName(subscribe.namespace, subscribe.trackName);
    const track = this.trackByFullName(fullTrackName);
    if (track == null) {
      await moqSendRequestError(
        this.controlWriter(),
        subscribe.requestId,
        MOQ_SUBSCRIPTION_ERROR_INTERNAL,
        `Unknown track ${fullTrackName}`,
      );
      return;
    }
    if (!authMatches(track.authInfo, subscribe.parameters)) {
      await moqSendRequestError(
        this.controlWriter(),
        subscribe.requestId,
        MOQ_SUBSCRIPTION_ERROR_INTERNAL,
        'Invalid subscribe authInfo',
      );
      return;
    }

    track._addSubscriber(subscribe.requestId, MOQ_FORWARD_TRUE, subscribe.parameters);
    track._setForwarding(true);
    const last = track._lastSent();
    await moqSendSubscribeOk(
      this.controlWriter(),
      subscribe.requestId,
      track.trackAlias,
      last.group,
      last.obj,
    );
  }

  // draft-16 REQUEST_UPDATE references an Existing Request ID; Forward State is
  // carried as the FORWARD parameter.
  private onRequestUpdate(update: any): void {
    if (!('existingRequestId' in update)) {
      console.warn(`${LOG_PREFIX} Invalid REQUEST_UPDATE, ignoring`);
      return;
    }
    const track = this.trackByPublisherRequestId(update.existingRequestId);
    if (track == null || !authMatches(track.authInfo, update.parameters)) {
      return;
    }
    const forward = forwardFromParameters(update.parameters);
    if (forward === MOQ_FORWARD_TRUE) {
      track._addSubscriber(update.existingRequestId, MOQ_FORWARD_TRUE, update.parameters);
      track._setForwarding(true);
    } else if (forward === 0) {
      track._removeSubscribersByRequestId(update.existingRequestId);
      track._setForwarding(false);
    }
  }

  private onUnsubscribe(unsubscribe: any): void {
    if (!('requestId' in unsubscribe)) {
      return;
    }
    for (const track of this.tracks) {
      const removed = track._removeSubscribersByRequestId(unsubscribe.requestId);
      if (removed.length > 0 && track.subscribers.length === 0) {
        track._setForwarding(false);
      }
    }
  }

  // ---- receive loops (subscriber) ----------------------------------------

  // Start the incoming unidirectional-stream and datagram receive loops once.
  // They run in the background until close(); errors after close are expected.
  private ensureReceiveLoops(): void {
    if (this.receiveLoopsStarted) {
      return;
    }
    this.receiveLoopsStarted = true;
    this.runStreamReceiveLoop().catch((err) => {
      if (this._state === MoqState.Running) {
        console.error(`${LOG_PREFIX} Stream receive loop error: ${err}`);
      }
    });
    this.runDatagramReceiveLoop().catch((err) => {
      if (this._state === MoqState.Running) {
        console.error(`${LOG_PREFIX} Datagram receive loop error: ${err}`);
      }
    });
  }

  // Accept incoming unidirectional QUIC streams (one subgroup per stream).
  private async runStreamReceiveLoop(): Promise<void> {
    const reader = this._wt().incomingUnidirectionalStreams.getReader();
    while (this._state === MoqState.Running) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const header = await moqParseObjectHeader(value);
      if (!isMoqObjectStreamHeaderType(header.type)) {
        console.warn(`${LOG_PREFIX} Unsupported incoming stream type ${header.type}`);
        continue;
      }
      // No await on purpose: drain this subgroup stream concurrently with the
      // next incoming stream.
      void this.receiveSubgroupStream(value, header);
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
    while (this._state === MoqState.Running && !isEOF) {
      try {
        const objHeader = await moqParseObjectFromSubgroupHeader(readerStream, header.type);
        isEOF = isEndOfGroupStatus(objHeader.status);
        if (!isEOF && objHeader.payloadLength > 0) {
          isEOF = await sub._deliver(readerStream, objHeader.extensionHeaders, objHeader.payloadLength);
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
  }

  // Accept incoming datagrams (one object per datagram).
  private async runDatagramReceiveLoop(): Promise<void> {
    const reader = this._wt().datagrams.readable.getReader();
    while (this._state === MoqState.Running) {
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
      const length = moqDecodeDatagramType(header.type).isStatus ? 0 : undefined;
      await sub._deliver(readable, header.extensionHeaders ?? [], length);
    }
  }

  // ---- helpers -----------------------------------------------------------

  private controlWriter(): WritableStream<Uint8Array> {
    return this.moqt.controlWriter as WritableStream<Uint8Array>;
  }
  private controlReader(): ReadableStream<Uint8Array> {
    return this.moqt.controlReader as ReadableStream<Uint8Array>;
  }

  private trackByFullName(fullTrackName: string): Track | null {
    return this.tracks.find((t) => getTrackFullName(t.namespace as any, t.name) === fullTrackName) ?? null;
  }
  private trackByPublisherRequestId(reqId: number): Track | null {
    return this.tracks.find((t) => t.publisherRequestId === reqId) ?? null;
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

// Auth passes when the track has no authInfo, or the parameters carry a match.
function authMatches(trackAuth: string | undefined, parameters: KvPair[]): boolean {
  if (trackAuth == undefined || trackAuth === '') {
    return true;
  }
  return trackAuth === getAuthInfofromParameters(parameters);
}

// Read the FORWARD parameter (draft-16 §9.2.2.8); returns 1 when absent.
function forwardFromParameters(parameters: KvPair[]): number {
  const fwd = parameters.find((p) => p.name === MOQ_PARAMETER_FORWARD);
  return fwd === undefined ? MOQ_FORWARD_TRUE : (fwd.val as number);
}
