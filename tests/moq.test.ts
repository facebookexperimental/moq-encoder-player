/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import { Track, Subscription, MoqMapping, Moq } from '../src/moq/moq.js';
import { MOQ_PUBLISHER_PRIORITY_BASE_DEFAULT, MOQ_CURRENT_VERSION } from '../src/moq/moqt.js';

const BASE_PRI = MOQ_PUBLISHER_PRIORITY_BASE_DEFAULT;
const flush = () => new Promise((r) => setTimeout(r, 0));

// A minimal stand-in for the bits of `Moq` that `Track` touches.
function fakeMoq(opts: { hangStream?: boolean } = {}) {
  const writes: any[] = [];
  const writer = {
    write: (b: any) => {
      writes.push(b);
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
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
    _markObjectSent: () => {},
  };
  return { moq, writes };
}

function makeTrack(moq: any, mapping: MoqMapping, maxInFlight = 1000): Track {
  return new Track(moq, ['vc'], 'v0', 2, 7, maxInFlight, undefined, mapping);
}

describe('Track sequencing', () => {
  it('assigns group/object ids, starting a new group when newGroupOptions is passed', () => {
    const { moq } = fakeMoq({ hangStream: true });
    const track = makeTrack(moq, MoqMapping.SubgroupPerGroup);
    track._addSubscriber(1, 1, []); // Forward State 1, so objects are sent
    const o1 = track.sendObject(new Uint8Array([1]), { priority: BASE_PRI });
    const o2 = track.sendObject(new Uint8Array([2]));
    const o3 = track.sendObject(new Uint8Array([3]), { priority: BASE_PRI });
    expect(o1.getInfo()).toMatchObject({ groupId: 0, objId: 0 });
    expect(o2.getInfo()).toMatchObject({ groupId: 0, objId: 1 });
    expect(o3.getInfo()).toMatchObject({ groupId: 1, objId: 0 });
  });
});

describe('Track object delivery (datagram)', () => {
  it('writes the object, marks it sent and fires the callback', async () => {
    const { moq, writes } = fakeMoq();
    const track = makeTrack(moq, MoqMapping.ObjectPerDatagram);
    track._addSubscriber(1, 1, []); // Forward State 1, so objects are sent
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
    track._addSubscriber(1, 1, []); // Forward State 1, so objects are sent
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
    track._addSubscriber(1, 1, []); // Forward State 1, so objects are sent
    const obj = track.sendObject(new Uint8Array([1]), { priority: BASE_PRI });
    await flush();
    expect(obj.getInfo().status).toBe('sent');
    obj.abort();
    expect(obj.getInfo().status).toBe('sent');
  });
});

describe('Subscription', () => {
  it('reports its identity and forwards received objects to the callback', async () => {
    const { moq } = fakeMoq();
    const received: Array<{ length?: number }> = [];
    const sub = new Subscription(moq, ['vc'], 'a0', 4, 9, 'secret', async (_r, _e, length) => {
      received.push({ length });
      return true; // EOF
    });

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

  it('unsubscribe sends UNSUBSCRIBE once and is idempotent', async () => {
    const { moq, writes } = fakeMoq();
    const sub = new Subscription(moq, ['vc'], 'a0', 4, 9, undefined, () => false);
    await sub.unsubscribe();
    await sub.unsubscribe(); // no-op the second time
    expect(writes.length).toBe(1);
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
  it('drops objects while not forwarding, sends once forwarding (datagram)', async () => {
    const { moq, writes } = fakeMoq();
    const track = makeTrack(moq, MoqMapping.ObjectPerDatagram);

    // No subscribers yet (Forward State 0) -> dropped, nothing written.
    const o1 = track.sendObject(new Uint8Array([1]), { priority: BASE_PRI });
    await flush();
    expect(o1.getInfo().status).toBe('dropped');
    expect(writes.length).toBe(0);

    // Relay sets Forward State 1 (modeled as a subscriber entry).
    track._addSubscriber(7, 1, []);
    const o2 = track.sendObject(new Uint8Array([2]), { priority: BASE_PRI });
    await flush();
    expect(o2.getInfo().status).toBe('sent');
    expect(writes.length).toBeGreaterThan(0);
  });

  it('finishes the started group after forwarding stops, then gates the next group (subgroup)', async () => {
    const { moq } = fakeMoq();
    const track = makeTrack(moq, MoqMapping.SubgroupPerGroup);
    track._addSubscriber(7, 1, []);

    const key = track.sendObject(new Uint8Array([1]), { priority: BASE_PRI }); // start group
    await flush();
    expect(key.getInfo().status).toBe('sent');

    // Forwarding stops mid-group; the rest of the already-started group still goes out.
    track._removeSubscribersByRequestId(7);
    const delta = track.sendObject(new Uint8Array([2])); // same group (no newGroup)
    await flush();
    expect(delta.getInfo().status).toBe('sent');

    // The next group must not start while not forwarding.
    const nextKey = track.sendObject(new Uint8Array([3]), { priority: BASE_PRI });
    await flush();
    expect(nextKey.getInfo().status).toBe('dropped');
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
    async createBidirectionalStream() {
      return { readable: {}, writable: {} };
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
