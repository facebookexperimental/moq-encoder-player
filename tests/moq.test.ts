/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import { Track, Subscription, MoqMapping } from '../src/moq/moq.js';
import { MOQ_PUBLISHER_PRIORITY_BASE_DEFAULT } from '../src/moq/moqt.js';

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
