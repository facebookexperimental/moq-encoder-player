/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

// High-level, media-free MoQ publisher API built on top of the low-level wire
// protocol in ./moqt.ts. The worker that uses it lives in ../sender/moq/.
//
//   const moq = new Moq();
//   moq.init(urlHostPort, { serverCertificateHash });   // sync, starts connecting
//   await moq.setup(MOQ_CURRENT_VERSION);                // CLIENT/SERVER_SETUP
//   const track = await moq.addTrack(ns, name, maxInFlight, auth, mapping);
//   const obj = track.sendObject(bytes, { priority }, extHeaders, () => {});  // new group
//   track.sendObject(moreBytes);                                              // same group
//   obj.getInfo();   // { objId, groupId, status }
//   moq.close();     // sync

import {
  moqCreate,
  moqClose,
  moqCreateControlStream,
  moqSendClientSetup,
  moqParseMsg,
  moqSendPublish,
  moqSendPublishDone,
  moqSendSubscribeOk,
  moqSendSubscribeError,
  moqSendSubgroupHeader,
  moqSendObjectSubgroupToWriter,
  moqSendObjectEndOfGroupToWriter,
  moqSendObjectPerDatagramToWriter,
  getAuthInfofromParameters,
  getTrackFullName,
  MOQ_CURRENT_VERSION,
  MOQ_MESSAGE_SERVER_SETUP,
  MOQ_MESSAGE_PUBLISH_OK,
  MOQ_MESSAGE_PUBLISH_ERROR,
  MOQ_MESSAGE_MAX_REQUEST_ID,
  MOQ_MESSAGE_SUBSCRIBE,
  MOQ_MESSAGE_SUBSCRIBE_UPDATE,
  MOQ_MESSAGE_UNSUBSCRIBE,
  MOQ_PUBLISHER_PRIORITY_BASE_DEFAULT,
  MOQ_SUBSCRIPTION_ERROR_INTERNAL,
  MOQ_STATUS_TRACK_ENDED,
  type MoqtState,
  type KvPair,
} from './moqt.js';

const LOG_PREFIX = '[MOQ]';

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
  numInFlight: number;
  currentGroup: number;
  currentObject: number;
}

export interface MoqInitOptions {
  serverCertificateHash?: Uint8Array | null;
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
  readonly maxInFlightRequests: number;
  readonly moqMapping: MoqMapping;

  subscribers: Subscriber[] = [];

  private moq: Moq;
  private queue: ObjData[] = [];
  private draining = false;
  private closed = false;

  private firstObjectSent = false;
  private currentGroupSeq = 0;
  private currentObjectSeq = 0;
  // Priority of the current group; updated when a new group is started.
  private currentGroupPriority = MOQ_PUBLISHER_PRIORITY_BASE_DEFAULT;

  // Open subgroup stream writer keyed by group id (one at a time in practice).
  private streams = new Map<number, WritableStreamDefaultWriter<Uint8Array>>();
  // Last object id written per group (used to send the end-of-group marker).
  private groupLastObj = new Map<number, number>();

  constructor(
    moq: Moq,
    namespace: string[],
    name: string,
    trackAlias: number,
    publisherRequestId: number,
    maxInFlightRequests: number,
    authInfo: string | undefined,
    moqMapping: MoqMapping,
  ) {
    this.moq = moq;
    this.namespace = namespace;
    this.name = name;
    this.trackAlias = trackAlias;
    this.publisherRequestId = publisherRequestId;
    this.maxInFlightRequests =
      maxInFlightRequests > 0 ? maxInFlightRequests : Number.MAX_SAFE_INTEGER;
    this.authInfo = authInfo;
    this.moqMapping = moqMapping;
  }

  /**
   * Queue an object for delivery. Passing `newGroupOptions` starts a new group
   * (e.g. a video keyframe) with the given publisher priority; omit it to append
   * to the current group. `extensionHeaders` are MoQ object extension headers
   * (e.g. MoQMI media metadata). `callback` fires once the object is written.
   *
   * Returns an `ObjData` handle. When the pending queue is already at
   * `maxInFlightRequests`, the object is dropped (its status is `dropped`).
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
    // Drop when the pending queue is full.
    if (this.queue.length >= this.maxInFlightRequests) {
      return new ObjData(
        this,
        this.currentGroupSeq,
        this.currentObjectSeq,
        'dropped',
        this.currentGroupPriority,
      );
    }

    const newGroup = newGroupOptions !== undefined;
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
      numInFlight: this.queue.length,
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
    for (const [groupId, writer] of this.streams) {
      const lastObj = this.groupLastObj.get(groupId) ?? 0;
      try {
        await moqSendObjectEndOfGroupToWriter(writer, lastObj + 1, [], true);
      } catch {
        // Best-effort on teardown.
      }
    }
    this.streams.clear();

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

    // Close any open stream from a previous group (the group rolled).
    for (const [groupId, writer] of this.streams) {
      if (groupId !== obj.groupId) {
        const lastObj = this.groupLastObj.get(groupId) ?? 0;
        await moqSendObjectEndOfGroupToWriter(writer, lastObj + 1, [], true);
        this.streams.delete(groupId);
      }
    }

    // Open a stream for this group on demand, writing the subgroup header.
    let writer = this.streams.get(obj.groupId);
    if (writer === undefined) {
      // Use the group priority directly as the WebTransport stream send order.
      const uniStream = await this.moq._wt().createUnidirectionalStream({ sendOrder: obj.priority });
      writer = uniStream.getWriter();
      this.streams.set(obj.groupId, writer);
      await moqSendSubgroupHeader(writer, this.trackAlias, obj.groupId, obj.priority);
    }

    // Object id delta is always 0: one stream per group, ids tracked locally.
    await moqSendObjectSubgroupToWriter(writer, 0, obj.data, obj.extensionHeaders);
    this.groupLastObj.set(obj.groupId, obj.objId);
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

  /**
   * Open the transport (sync). Connection + control stream creation happen in
   * the background; `setup` and `addTrack` await readiness.
   */
  init(urlHostPort: string, options: MoqInitOptions = {}): void {
    const url = new URL(urlHostPort);
    url.protocol = 'https'; // WebTransport requires https

    let wtOptions: any = {};
    if (options.serverCertificateHash != null) {
      wtOptions = {
        serverCertificateHashes: [{ algorithm: 'sha-256', value: options.serverCertificateHash }],
      };
    }

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
    version: number = MOQ_CURRENT_VERSION,
    keepAliveOpts?: KeepAliveOptions,
  ): Promise<void> {
    if (this._state === MoqState.Idle) {
      throw new Error('setup() called before init()');
    }
    await this.connecting;

    await moqSendClientSetup(this.controlWriter(), version);
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
    maxInFlightRequests: number,
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
      maxInFlightRequests,
      authInfo,
      moqMapping,
    );
    if (resp?.forward === 1) {
      track._addSubscriber(requestId, 1, resp.parameters);
    }
    this.tracks.push(track);
    return track;
  }

  /** Drop queues, close tracks and the transport (best-effort, async teardown). */
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
    void (async () => {
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
        case MOQ_MESSAGE_PUBLISH_ERROR:
          console.log(`${LOG_PREFIX} received PUBLISH_ERROR ${JSON.stringify(msg.data)}`);
          this.resolvePublish(msg.data, false);
          break;
        case MOQ_MESSAGE_SUBSCRIBE:
          console.log(`${LOG_PREFIX} received MOQ_MESSAGE_SUBSCRIBE ${JSON.stringify(msg.data)}`);
          await this.onSubscribe(msg.data);
          break;
        case MOQ_MESSAGE_SUBSCRIBE_UPDATE:
          console.log(`${LOG_PREFIX} received MOQ_MESSAGE_SUBSCRIBE_UPDATE ${JSON.stringify(msg.data)}`);
          this.onSubscribeUpdate(msg.data);
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

  // Resolve/reject a pending addTrack. PUBLISH_OK with an unknown request id is
  // treated as a keep-alive answer and ignored.
  private resolvePublish(data: any, ok: boolean): void {
    const pending = this.pendingPublish.get(data?.reqId);
    if (pending === undefined) {
      return;
    }
    this.pendingPublish.delete(data.reqId);
    ok ? pending.resolve(data) : pending.reject(new Error(`PUBLISH_ERROR: ${JSON.stringify(data)}`));
  }

  private async onSubscribe(subscribe: any): Promise<void> {
    const fullTrackName = getTrackFullName(subscribe.namespace, subscribe.trackName);
    const track = this.trackByFullName(fullTrackName);
    if (track == null) {
      await moqSendSubscribeError(
        this.controlWriter(),
        subscribe.requestId,
        MOQ_SUBSCRIPTION_ERROR_INTERNAL,
        `Unknown track ${fullTrackName}`,
      );
      return;
    }
    if (!authMatches(track.authInfo, subscribe.parameters)) {
      await moqSendSubscribeError(
        this.controlWriter(),
        subscribe.requestId,
        MOQ_SUBSCRIPTION_ERROR_INTERNAL,
        'Invalid subscribe authInfo',
      );
      return;
    }

    track._addSubscriber(subscribe.requestId, 1, subscribe.parameters);
    const last = track._lastSent();
    await moqSendSubscribeOk(
      this.controlWriter(),
      subscribe.requestId,
      track.trackAlias,
      0,
      last.group,
      last.obj,
      undefined,
    );
  }

  private onSubscribeUpdate(update: any): void {
    if (!('subscriptionRequestId' in update) || !('forward' in update)) {
      console.warn(`${LOG_PREFIX} Invalid SUBSCRIBE_UPDATE, ignoring`);
      return;
    }
    // NOTE: the update references the original subscription id; we match it
    // against the publisher request id we sent (preserved mapping).
    const track = this.trackByPublisherRequestId(update.subscriptionRequestId);
    if (track == null || !authMatches(track.authInfo, update.parameters)) {
      return;
    }
    if (update.forward === 1) {
      track._addSubscriber(update.subscriptionRequestId, 1, update.parameters);
    } else {
      track._removeSubscribersByRequestId(update.subscriptionRequestId);
    }
  }

  private onUnsubscribe(unsubscribe: any): void {
    if (!('subscriptionRequestId' in unsubscribe)) {
      return;
    }
    for (const track of this.tracks) {
      track._removeSubscribersByRequestId(unsubscribe.subscriptionRequestId);
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

// Auth passes when the track has no authInfo, or the parameters carry a match.
function authMatches(trackAuth: string | undefined, parameters: KvPair[]): boolean {
  if (trackAuth == undefined || trackAuth === '') {
    return true;
  }
  return trackAuth === getAuthInfofromParameters(parameters);
}
