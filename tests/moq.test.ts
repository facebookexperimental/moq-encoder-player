/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import { Track, Subscription, MoqMapping, Moq, MoqState } from '../src/moq/moq.js';
import {
  MOQ_PUBLISHER_PRIORITY_BASE_DEFAULT,
  MOQ_CURRENT_VERSION,
  moqSendSubgroupHeader,
  moqSendObjectSubgroupToWriter,
  moqSendRequestOk,
  moqSendRequestError,
  moqSendRequestUpdate,
  moqParseMsg,
  moqCreateKvPair,
  MOQ_MESSAGE_REQUEST_UPDATE,
  MOQ_MESSAGE_REQUEST_OK,
  MOQ_STREAM_TYPE_PADDING,
  MOQ_PARAMETER_FORWARD,
  MOQ_FORWARD_FALSE,
  MOQ_FORWARD_TRUE,
} from '../src/moq/moqt.js';
import { concatBuffer } from '../src/moq/buffer_utils.js';
import { numberToVarInt } from '../src/moq/varint.js';

const BASE_PRI = MOQ_PUBLISHER_PRIORITY_BASE_DEFAULT;
const flush = () => new Promise((r) => setTimeout(r, 0));

// A minimal stand-in for the bits of `Moq` that `Track` touches.
function fakeMoq(opts: { hangStream?: boolean; hangClose?: boolean } = {}) {
  const writes: any[] = [];
  const writer = {
    write: (b: any) => {
      writes.push(b);
      return Promise.resolve();
    },
    // hangClose keeps each stream "open" forever (close never settles), so the
    // open-stream counter accumulates — used to exercise the maxOpenStreams cap.
    close: () => (opts.hangClose ? new Promise<void>(() => {}) : Promise.resolve()),
    releaseLock: () => {},
    ready: Promise.resolve(),
  };
  const wt = {
    datagrams: { writable: { getWriter: () => writer } },
    createUnidirectionalStream: opts.hangStream
      ? () => new Promise(() => {}) // never resolves -> drain stalls
      : async () => ({ getWriter: () => writer }),
  };
  const moq: any = {
    _wt: () => wt,
    _controlWriter: () => ({ getWriter: () => writer }),
  };
  return { moq, writes };
}

// A minimal stand-in for a WebTransport bidirectional request stream (draft-18
// runs each PUBLISH / SUBSCRIBE on its own bidi stream). Records outbound bytes
// and lets tests feed responses into the readable half.
function fakeBidiStream() {
  const calls = { cancelled: 0, closed: 0 };
  const writes: Uint8Array[] = [];
  const responses = createQueuedReadable();
  const writer = {
    write: (b: Uint8Array) => {
      writes.push(new Uint8Array(b));
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
    ready: Promise.resolve(),
    releaseLock: () => {},
  };
  const responseWriter = {
    write: (b: Uint8Array) => {
      responses.enqueue(b);
      return Promise.resolve();
    },
    close: () => {
      responses.close();
      return Promise.resolve();
    },
    ready: Promise.resolve(),
    releaseLock: () => {},
  };
  const stream: any = {
    writable: {
      getWriter: () => writer,
      close: () => {
        calls.closed++;
        return Promise.resolve();
      },
    },
    readable: responses.readable,
    _calls: calls,
    _writes: writes,
    _responseWritable: { getWriter: () => responseWriter },
    _closeResponses: responses.close,
  };
  stream.readable.cancel = () => {
    calls.cancelled++;
    responses.close();
    return Promise.resolve();
  };
  return stream;
}

function createQueuedReadable() {
  let buffered: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  let closed = false;
  let wakeReaders: Array<() => void> = [];

  const wake = () => {
    const readers = wakeReaders;
    wakeReaders = [];
    readers.forEach((resolve) => resolve());
  };
  const enqueue = (bytes: Uint8Array) => {
    buffered = concatBuffer([buffered, new Uint8Array(bytes)]);
    wake();
  };
  const close = () => {
    closed = true;
    wake();
  };
  const read = async (view: Uint8Array) => {
    while (buffered.byteLength === 0 && !closed) {
      await new Promise<void>((resolve) => wakeReaders.push(resolve));
    }
    if (buffered.byteLength === 0) {
      return { value: new Uint8Array(view.buffer, view.byteOffset, 0), done: true };
    }
    const size = Math.min(view.byteLength, buffered.byteLength);
    view.set(buffered.subarray(0, size));
    buffered = buffered.slice(size);
    return { value: new Uint8Array(view.buffer, view.byteOffset, size), done: false };
  };

  return {
    readable: {
      getReader: () => ({ read, releaseLock: () => {} }),
    } as unknown as ReadableStream<Uint8Array>,
    enqueue,
    close,
  };
}

function readableFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  const queued = createQueuedReadable();
  queued.enqueue(bytes);
  queued.close();
  return queued.readable;
}

function makeTrack(
  moq: any,
  mapping: MoqMapping,
  maxInFlight = 1000,
  maxOpenStreams = 1000,
): Track {
  return new Track(
    moq,
    ['vc'],
    'v0',
    2,
    7,
    maxInFlight,
    maxOpenStreams,
    undefined,
    mapping,
    fakeBidiStream(),
  );
}

describe('Track sequencing', () => {
  it('assigns group/object ids, starting a new group when newGroupOptions is passed', () => {
    const { moq } = fakeMoq({ hangStream: true });
    const track = makeTrack(moq, MoqMapping.SubgroupPerGroup);
    track._setForwarding(true); // Forward State 1, so objects are sent
    const o1 = track.sendObject(new Uint8Array([1]), { priority: BASE_PRI });
    const o2 = track.sendObject(new Uint8Array([2]));
    const o3 = track.sendObject(new Uint8Array([3]), { priority: BASE_PRI });
    expect(o1.getInfo()).toMatchObject({ groupId: 0, objId: 0 });
    expect(o2.getInfo()).toMatchObject({ groupId: 0, objId: 1 });
    expect(o3.getInfo()).toMatchObject({ groupId: 1, objId: 0 });
  });

  it('uses caller-assigned ids, waiting for a group start it can follow', () => {
    const { moq } = fakeMoq({ hangStream: true });
    const track = makeTrack(moq, MoqMapping.SubgroupPerGroup);
    track._setForwarding(true);
    const send = (groupId: number, objId: number, newGroup = false) =>
      track.sendObject(
        new Uint8Array([1]),
        newGroup ? { priority: BASE_PRI } : undefined,
        [],
        undefined,
        { groupId, objId },
      );

    // Joined mid-group: nothing to follow until the caller starts a group.
    expect(send(4, 3).getInfo().status).toBe('dropped');
    expect(send(5, 0, true).getInfo()).toMatchObject({ groupId: 5, objId: 0, status: 'queued' });
    expect(send(5, 1).getInfo()).toMatchObject({ groupId: 5, objId: 1, status: 'queued' });
  });

  it('caller-assigned ids: resuming forwarding waits for the next group start', () => {
    const { moq } = fakeMoq({ hangStream: true });
    const track = makeTrack(moq, MoqMapping.SubgroupPerGroup);
    track._setForwarding(true);
    const send = (groupId: number, objId: number, newGroup = false) =>
      track.sendObject(
        new Uint8Array([1]),
        newGroup ? { priority: BASE_PRI } : undefined,
        [],
        undefined,
        { groupId, objId },
      );

    expect(send(0, 0, true).getInfo().status).toBe('queued');
    track._setForwarding(false);
    track._setForwarding(true);
    // The track can not invent a new group: the rest of group 0 is dropped.
    expect(send(0, 1).getInfo().status).toBe('dropped');
    expect(send(1, 0, true).getInfo()).toMatchObject({ groupId: 1, objId: 0, status: 'queued' });
  });

  it('caller-assigned ids: drops the rest of a group whose start was refused', () => {
    const { moq } = fakeMoq({ hangStream: true });
    const track = makeTrack(moq, MoqMapping.SubgroupPerGroup, 1);
    track._setForwarding(true);
    const send = (groupId: number, objId: number, newGroup = false) =>
      track.sendObject(
        new Uint8Array([1]),
        newGroup ? { priority: BASE_PRI } : undefined,
        [],
        undefined,
        { groupId, objId },
      );

    send(0, 0, true); // drains, stalls opening the stream
    send(0, 1); // fills the 1-object queue
    expect(send(1, 0, true).getInfo().status).toBe('dropped'); // queue full
    expect(send(1, 1).getInfo().status).toBe('dropped'); // its group never started
  });
});

describe('Track object delivery (datagram)', () => {
  it('writes the object, marks it sent and fires the callback', async () => {
    const { moq, writes } = fakeMoq();
    const track = makeTrack(moq, MoqMapping.ObjectPerDatagram);
    track._setForwarding(true); // Forward State 1, so objects are sent
    let cbObj: any = null;
    const obj = track.sendObject(new Uint8Array([1, 2, 3]), { priority: BASE_PRI }, [], (o) => {
      cbObj = o;
    });
    await flush();
    expect(obj.getInfo().status).toBe('sent');
    expect(cbObj).toBe(obj);
    expect(writes.length).toBeGreaterThan(0);
  });
});

describe('Track queue policy', () => {
  it('drops when the pending queue is full and supports abort', async () => {
    // Subgroup stream creation hangs, so the queue stays full.
    const { moq } = fakeMoq({ hangStream: true });
    const track = makeTrack(moq, MoqMapping.SubgroupPerGroup, 2);
    track._setForwarding(true); // Forward State 1, so objects are sent
    const o1 = track.sendObject(new Uint8Array([1]), { priority: BASE_PRI }); // drains, stalls on stream open
    await flush();
    const o2 = track.sendObject(new Uint8Array([2])); // queued
    const o3 = track.sendObject(new Uint8Array([3])); // queue full -> dropped

    expect(o1.getInfo().status).toBe('queued');
    expect(o2.getInfo().status).toBe('queued');
    expect(o3.getInfo().status).toBe('dropped');

    o2.abort();
    expect(o2.getInfo().status).toBe('aborted');

    // With o2 gone there is room again.
    const o4 = track.sendObject(new Uint8Array([4]));
    expect(o4.getInfo().status).toBe('queued');
  });

  it('abort() is a no-op once an object has been sent', async () => {
    const { moq } = fakeMoq();
    const track = makeTrack(moq, MoqMapping.ObjectPerDatagram);
    track._setForwarding(true); // Forward State 1, so objects are sent
    const obj = track.sendObject(new Uint8Array([1]), { priority: BASE_PRI });
    await flush();
    expect(obj.getInfo().status).toBe('sent');
    obj.abort();
    expect(obj.getInfo().status).toBe('sent');
  });
});

describe('Track info counters (numQueued / numOpenStreams)', () => {
  it('subgroup: opens one stream per group, no queue backlog once written', async () => {
    const { moq } = fakeMoq();
    const track = makeTrack(moq, MoqMapping.SubgroupPerGroup);
    track._setForwarding(true);

    track.sendObject(new Uint8Array([1]), { priority: BASE_PRI });
    await flush();
    expect(track.getInfo().numQueued).toBe(0);
    expect(track.getInfo().numOpenStreams).toBe(1);
  });

  it('datagram: never opens a subgroup stream', async () => {
    const { moq } = fakeMoq();
    const track = makeTrack(moq, MoqMapping.ObjectPerDatagram);
    track._setForwarding(true);

    track.sendObject(new Uint8Array([1]), { priority: BASE_PRI });
    await flush();
    expect(track.getInfo().numQueued).toBe(0);
    expect(track.getInfo().numOpenStreams).toBe(0);
  });

  it('numQueued reflects objects waiting while stream creation is stalled', async () => {
    const { moq } = fakeMoq({ hangStream: true });
    const track = makeTrack(moq, MoqMapping.SubgroupPerGroup);
    track._setForwarding(true);

    track.sendObject(new Uint8Array([1]), { priority: BASE_PRI }); // drains, stalls opening the stream
    track.sendObject(new Uint8Array([2])); // waits in the queue
    await flush();
    expect(track.getInfo().numQueued).toBe(2);
    expect(track.getInfo().numOpenStreams).toBe(0);
  });
});

describe('Track open-stream cap (maxOpenStreams)', () => {
  it('drops a new group once too many subgroup streams are still open', async () => {
    // Stream closes never settle, so each new group leaves its stream "open".
    const { moq } = fakeMoq({ hangClose: true });
    const track = makeTrack(moq, MoqMapping.SubgroupPerGroup, 1000, 2); // maxOpenStreams = 2
    track._setForwarding(true);

    const g0 = track.sendObject(new Uint8Array([1]), { priority: BASE_PRI });
    await flush();
    const g1 = track.sendObject(new Uint8Array([2]), { priority: BASE_PRI });
    await flush();
    const g2 = track.sendObject(new Uint8Array([3]), { priority: BASE_PRI });
    await flush();

    expect(g0.getInfo().status).toBe('sent');
    expect(g1.getInfo().status).toBe('sent');
    expect(g2.getInfo().status).toBe('dropped'); // cap reached -> new group dropped
    expect(track.getInfo().numOpenStreams).toBe(2);
  });

  it('drops the rest of a group whose start was refused, until a new group fits', async () => {
    const { moq } = fakeMoq({ hangClose: true });
    const track = makeTrack(moq, MoqMapping.SubgroupPerGroup, 1000, 1); // maxOpenStreams = 1
    track._setForwarding(true);

    const key = track.sendObject(new Uint8Array([1]), { priority: BASE_PRI }); // opens group 0
    await flush();
    // Next keyframe is refused (1 stream already open); its delta is refused too.
    const refusedKey = track.sendObject(new Uint8Array([2]), { priority: BASE_PRI });
    const refusedDelta = track.sendObject(new Uint8Array([3]));
    await flush();

    expect(key.getInfo().status).toBe('sent');
    expect(refusedKey.getInfo().status).toBe('dropped');
    expect(refusedDelta.getInfo().status).toBe('dropped');
    expect(track.getInfo().numOpenStreams).toBe(1);
  });
});

describe('Subscription', () => {
  it('reports its identity and forwards received objects to the callback', async () => {
    const received: Array<{ length?: number }> = [];
    const sub = new Subscription(
      ['vc'],
      'a0',
      4,
      9,
      'secret',
      async (_r, _e, length) => {
        received.push({ length });
        return true; // EOF
      },
      fakeBidiStream(),
    );

    expect(sub.getInfo()).toEqual({
      namespace: ['vc'],
      name: 'a0',
      subscribeRequestId: 4,
      trackAlias: 9,
    });

    const eof = await (sub as any)._deliver({} as any, [], 10);
    expect(eof).toBe(true);
    expect(received).toEqual([{ length: 10 }]);
  });

  it('unsubscribe closes the request stream once and is idempotent', async () => {
    const stream = fakeBidiStream();
    const sub = new Subscription(['vc'], 'a0', 4, 9, undefined, () => false, stream);
    // draft-18 has no UNSUBSCRIBE message: cancel readable (STOP_SENDING) + close
    // writable (FIN) exactly once, even across repeated calls.
    await sub.unsubscribe();
    await sub.unsubscribe(); // no-op the second time
    expect(stream._calls.cancelled).toBe(1);
    expect(stream._calls.closed).toBe(1);
  });

  it('sends REQUEST_UPDATE and resolves when REQUEST_OK arrives', async () => {
    const stream = fakeBidiStream();
    const sub = new Subscription(['vc'], 'v0', 4, 9, undefined, () => false, stream);
    const responseLoop = sub._runResponseLoop();
    const update = sub._requestUpdate(12, [
      moqCreateKvPair(MOQ_PARAMETER_FORWARD, MOQ_FORWARD_FALSE),
    ]);
    await flush();

    const parsed = await moqParseMsg(readableFromBytes(concatBuffer(stream._writes)));
    expect(parsed.type).toBe(MOQ_MESSAGE_REQUEST_UPDATE);
    expect(parsed.data.requestId).toBe(12);
    expect(parsed.data.parameters).toEqual([
      { name: MOQ_PARAMETER_FORWARD, val: MOQ_FORWARD_FALSE },
    ]);

    await moqSendRequestOk(stream._responseWritable);
    await expect(update).resolves.toBeUndefined();
    stream._closeResponses();
    await responseLoop;
  });

  it('rejects a pending update on REQUEST_ERROR', async () => {
    const stream = fakeBidiStream();
    const sub = new Subscription(['vc'], 'v0', 4, 9, undefined, () => false, stream);
    const responseLoop = sub._runResponseLoop();
    const update = expect(
      sub._requestUpdate(12, [moqCreateKvPair(MOQ_PARAMETER_FORWARD, MOQ_FORWARD_TRUE)]),
    ).rejects.toThrow('REQUEST_ERROR 3: denied');

    await moqSendRequestError(stream._responseWritable, 3, 'denied');
    await update;
    stream._closeResponses();
    await responseLoop;
  });

  it('rejects a pending update when the response stream closes', async () => {
    const stream = fakeBidiStream();
    const sub = new Subscription(['vc'], 'v0', 4, 9, undefined, () => false, stream);
    const responseLoop = sub._runResponseLoop();
    const update = expect(
      sub._requestUpdate(12, [moqCreateKvPair(MOQ_PARAMETER_FORWARD, MOQ_FORWARD_TRUE)]),
    ).rejects.toThrow('Subscription ended before REQUEST_UPDATE was acknowledged');

    stream._closeResponses();
    await update;
    await responseLoop;
  });

  it('rejects an overlapping update while one is pending', async () => {
    const stream = fakeBidiStream();
    const sub = new Subscription(['vc'], 'v0', 4, 9, undefined, () => false, stream);
    const responseLoop = sub._runResponseLoop();
    const first = expect(
      sub._requestUpdate(12, [moqCreateKvPair(MOQ_PARAMETER_FORWARD, MOQ_FORWARD_TRUE)]),
    ).rejects.toThrow('Subscription ended before REQUEST_UPDATE was acknowledged');

    await expect(
      sub._requestUpdate(14, [moqCreateKvPair(MOQ_PARAMETER_FORWARD, MOQ_FORWARD_FALSE)]),
    ).rejects.toThrow('A subscription update is already pending');
    stream._closeResponses();
    await first;
    await responseLoop;
  });
});

describe('Padding-stream keep alive', () => {
  it('sends and closes padding without opening a request stream', async () => {
    const write = jest.fn(() => Promise.resolve());
    const close = jest.fn(() => Promise.resolve());
    const releaseLock = jest.fn();
    const getWriter = jest.fn(() => ({
      write,
      close,
      ready: Promise.resolve(),
      releaseLock,
    }));
    const createUnidirectionalStream = jest.fn(async () => ({ getWriter }));
    const moq = new Moq() as any;
    moq._state = MoqState.Running;
    moq.moqt.wt = {
      createUnidirectionalStream,
      createBidirectionalStream: jest.fn(),
    };

    await moq.sendKeepAlive();

    expect(moq.moqt.wt.createBidirectionalStream).not.toHaveBeenCalled();
    expect(createUnidirectionalStream).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(numberToVarInt(MOQ_STREAM_TYPE_PADDING));
    expect(close).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });
});

describe('Track subscribers', () => {
  it('adds, removes and reports subscribers; lastSent is empty before any send', () => {
    const { moq } = fakeMoq({ hangStream: true });
    const track = makeTrack(moq, MoqMapping.SubgroupPerGroup);

    expect(track.getInfo().numSubscribers).toBe(0);

    track._addSubscriber(7, 1, []);
    track._addSubscriber(8, 1, []);
    expect(track.getInfo().numSubscribers).toBe(2);

    const removed = track._removeSubscribersByRequestId(7);
    expect(removed).toHaveLength(1);
    expect(track.getInfo().numSubscribers).toBe(1);
    expect(track.subscribers[0].subscriptionRequestId).toBe(8);
  });
});

describe('Track forward-state gating', () => {
  it('acknowledges relay updates and preserves forwarding when FORWARD is omitted', async () => {
    const stream = fakeBidiStream();
    const { moq } = fakeMoq();
    const track = new Track(
      moq,
      ['vc'],
      'v0',
      2,
      2,
      1000,
      1000,
      undefined,
      MoqMapping.SubgroupPerGroup,
      stream,
    );
    const responseLoop = track._runResponseLoop();

    await moqSendRequestUpdate(stream._responseWritable, 4, []);
    await flush();
    expect(track.isForwarding()).toBe(false);
    let parsed = await moqParseMsg(readableFromBytes(stream._writes[0]));
    expect(parsed.type).toBe(MOQ_MESSAGE_REQUEST_OK);

    await moqSendRequestUpdate(stream._responseWritable, 6, [
      moqCreateKvPair(MOQ_PARAMETER_FORWARD, MOQ_FORWARD_TRUE),
    ]);
    await flush();
    expect(track.isForwarding()).toBe(true);
    parsed = await moqParseMsg(readableFromBytes(stream._writes[1]));
    expect(parsed.type).toBe(MOQ_MESSAGE_REQUEST_OK);

    stream._closeResponses();
    await responseLoop;
  });

  it('drops objects while not forwarding, sends once forwarding (datagram)', async () => {
    const { moq, writes } = fakeMoq();
    const track = makeTrack(moq, MoqMapping.ObjectPerDatagram);

    // Forward State 0 (default) -> dropped, nothing written.
    const o1 = track.sendObject(new Uint8Array([1]), { priority: BASE_PRI });
    await flush();
    expect(o1.getInfo().status).toBe('dropped');
    expect(writes.length).toBe(0);

    // Relay sets Forward State 1.
    track._setForwarding(true);
    const o2 = track.sendObject(new Uint8Array([2]), { priority: BASE_PRI });
    await flush();
    expect(o2.getInfo().status).toBe('sent');
    expect(writes.length).toBeGreaterThan(0);
  });

  it('pauses on Forward State 0 and resumes on a fresh group (subgroup)', async () => {
    const { moq } = fakeMoq();
    const track = makeTrack(moq, MoqMapping.SubgroupPerGroup);
    track._setForwarding(true);

    const key = track.sendObject(new Uint8Array([1]), { priority: BASE_PRI });
    await flush();
    expect(key.getInfo().status).toBe('sent');
    expect(key.getInfo().groupId).toBe(0);

    // Forwarding stops: objects are dropped while paused.
    track._setForwarding(false);
    const paused = track.sendObject(new Uint8Array([2]));
    await flush();
    expect(paused.getInfo().status).toBe('dropped');

    // Forwarding resumes: the next object starts a fresh group (not reusing
    // group 0), even though it is not flagged as a new group by the caller.
    track._setForwarding(true);
    const resumed = track.sendObject(new Uint8Array([3]));
    await flush();
    expect(resumed.getInfo().status).toBe('sent');
    expect(resumed.getInfo().groupId).toBe(1);
  });
});

describe('Moq subgroup reception: end of group', () => {
  const TRACK_ALIAS = 9;
  const GROUP = 7;

  // The bytes of a subgroup stream for group GROUP carrying `numObjects`
  // objects, with no explicit end-of-group marker.
  async function subgroupBytes(numObjects: number): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    const writer: any = {
      write: (b: Uint8Array) => {
        chunks.push(b);
        return Promise.resolve();
      },
    };
    await moqSendSubgroupHeader(writer, TRACK_ALIAS, GROUP, BASE_PRI);
    for (let i = 0; i < numObjects; i++) {
      await moqSendObjectSubgroupToWriter(writer, 0, new Uint8Array([i, i, i]), []);
    }
    return concatBuffer(chunks);
  }

  // A byte stream that delivers `bytes`, then ends with a FIN or a reset.
  function uniStream(bytes: Uint8Array, end: 'fin' | 'reset'): ReadableStream<Uint8Array> {
    let delivered = false;
    return new ReadableStream({
      type: 'bytes',
      pull(controller: any) {
        if (!delivered) {
          delivered = true;
          controller.enqueue(bytes.slice());
        } else if (end === 'fin') {
          controller.close();
          controller.byobRequest?.respond(0);
        } else {
          controller.error(new Error('stream reset'));
        }
      },
    } as any);
  }

  async function receive(end: 'fin' | 'reset') {
    const objects: string[] = [];
    const endsOfGroup: string[] = [];
    const moq = new Moq() as any;
    const sub = new Subscription(
      ['vc'],
      'v0',
      4,
      TRACK_ALIAS,
      undefined,
      async (reader, _props, length, groupId, objectId) => {
        // Consume the payload, as the real depackagers do.
        const r = reader.getReader({ mode: 'byob' });
        await r.read(new Uint8Array(length!));
        r.releaseLock();
        objects.push(`${groupId}/${objectId}`);
        return false;
      },
      fakeBidiStream(),
      (groupId, lastObjId) => endsOfGroup.push(`${groupId}/${lastObjId}`),
    );
    moq.subscriptionsByAlias.set(TRACK_ALIAS, sub);
    await moq.handleIncomingUniStream(uniStream(await subgroupBytes(2), end));
    return { objects, endsOfGroup };
  }

  it('a stream that FINs without a marker ends its group at the last object read', async () => {
    const { objects, endsOfGroup } = await receive('fin');
    expect(objects).toEqual(['7/0', '7/1']);
    expect(endsOfGroup).toEqual(['7/1']);
  });

  it('a stream cut short (relay died, reset) does NOT end its group', async () => {
    const { objects, endsOfGroup } = await receive('reset');
    expect(objects).toEqual(['7/0', '7/1']);
    expect(endsOfGroup).toEqual([]);
  });
});

describe('Moq.init ALPN negotiation', () => {
  // Capture the args passed to the WebTransport constructor.
  let captured: { url: string; options: any } | null = null;
  const realWT = (globalThis as any).WebTransport;

  class FakeWebTransport {
    ready = Promise.resolve();
    closed = new Promise(() => {}); // never settles; init() attaches a .catch()
    constructor(url: string, options: any) {
      captured = { url, options };
    }
    // draft-19 opens a unidirectional control stream (SETUP) rather than a bidi one.
    async createUnidirectionalStream() {
      return {};
    }
    close() {}
  }

  beforeEach(() => {
    captured = null;
    (globalThis as any).WebTransport = FakeWebTransport as any;
  });
  afterEach(() => {
    (globalThis as any).WebTransport = realWT;
  });

  it('offers the default ALPN token (MOQ_CURRENT_VERSION) when none is given', () => {
    new Moq().init('https://localhost:4433/moq');
    expect(captured?.options.protocols).toEqual([MOQ_CURRENT_VERSION]);
  });

  it('offers the caller-supplied ALPN token and the certificate hash', () => {
    const hash = new Uint8Array([1, 2, 3]);
    new Moq().init('https://localhost:4433/moq', {
      alpnVersion: 'moqt-99',
      serverCertificateHash: hash,
    });
    expect(captured?.options.protocols).toEqual(['moqt-99']);
    expect(captured?.options.serverCertificateHashes).toEqual([
      { algorithm: 'sha-256', value: hash },
    ]);
  });
});

describe('Track byte accounting', () => {
  // Like fakeMoq, but every unidirectional stream gets its own writer, so the
  // bytes of one subgroup stream can be measured on their own.
  function fakeMoqPerStream() {
    const streams: number[][] = [];
    const datagrams: number[] = [];
    const makeWriter = (sink: number[]) => ({
      write: (b: any) => {
        sink.push(b.byteLength);
        return Promise.resolve();
      },
      close: () => Promise.resolve(),
      releaseLock: () => {},
      ready: Promise.resolve(),
    });
    const wt = {
      datagrams: { writable: { getWriter: () => makeWriter(datagrams) } },
      createUnidirectionalStream: async () => {
        const sink: number[] = [];
        streams.push(sink);
        return { getWriter: () => makeWriter(sink) };
      },
    };
    const moq: any = {
      _wt: () => wt,
      _controlWriter: () => ({ getWriter: () => makeWriter([]) }),
    };
    return { moq, streams, datagrams };
  }

  const total = (bytes: number[]) => bytes.reduce((acc, n) => acc + n, 0);

  it('accounts a whole subgroup stream: payload + signaling = bytes on the wire', async () => {
    const { moq, streams } = fakeMoqPerStream();
    const track = makeTrack(moq, MoqMapping.SubgroupPerGroup);
    track._setForwarding(true);

    track.sendObject(new Uint8Array(10), { priority: BASE_PRI });
    await flush();
    track.sendObject(new Uint8Array(20));
    track.sendObject(new Uint8Array(30));
    await flush();
    expect(track.getInfo().lastSubgroup).toBeUndefined(); // still open

    // Rolling to a new group closes the first stream, which completes it.
    track.sendObject(new Uint8Array(5), { priority: BASE_PRI });
    await flush();
    await flush();

    const subgroup = track.getInfo().lastSubgroup!;
    expect(subgroup).toMatchObject({ groupId: 0, objects: 3, payloadBytes: 60 });
    // Everything that stream carried: subgroup header, 3 object headers and the
    // end-of-group marker on top of the 60 payload bytes.
    expect(subgroup.payloadBytes + subgroup.signalingBytes).toBe(total(streams[0]));
    expect(subgroup.signalingBytes).toBeGreaterThan(0);
  });

  it('counts object properties as signaling overhead', async () => {
    const bare = fakeMoqPerStream();
    const withProps = fakeMoqPerStream();
    const properties = [{ name: 0x10, val: 1_234_567 }];

    const run = async (fake: ReturnType<typeof fakeMoqPerStream>, props: any[]) => {
      const track = makeTrack(fake.moq, MoqMapping.SubgroupPerGroup);
      track._setForwarding(true);
      track.sendObject(new Uint8Array(10), { priority: BASE_PRI }, props);
      await flush();
      track.sendObject(new Uint8Array(10), { priority: BASE_PRI }, props);
      await flush();
      await flush();
      return track.getInfo().lastSubgroup!;
    };

    const plain = await run(bare, []);
    const tagged = await run(withProps, properties);
    expect(tagged.payloadBytes).toBe(plain.payloadBytes);
    expect(tagged.signalingBytes).toBeGreaterThan(plain.signalingBytes);
  });

  it('treats each datagram as its own finished unit', async () => {
    const { moq, datagrams } = fakeMoqPerStream();
    const track = makeTrack(moq, MoqMapping.ObjectPerDatagram);
    track._setForwarding(true);

    track.sendObject(new Uint8Array(40), { priority: BASE_PRI });
    await flush();

    const subgroup = track.getInfo().lastSubgroup!;
    expect(subgroup).toMatchObject({ groupId: 0, objects: 1, payloadBytes: 40 });
    expect(subgroup.payloadBytes + subgroup.signalingBytes).toBe(total(datagrams));
  });
});
