/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import { MoqReceiver, type TrackData } from '../src/receiver/moq/moq_receiver_internals.js';
import { CMAFPackager } from '../src/packager/cmaf/cmaf_packager.js';

// parseReceiverConfig and checkTrackData are private methods; access them through
// a cast so the pure config logic can still be unit tested in isolation.
const receiver = new MoqReceiver() as any;
const parseReceiverConfig = (raw: any) => receiver.parseReceiverConfig(raw);
const checkTrackData = (tracks: Record<string, TrackData>) => receiver.checkTrackData(tracks);

describe('parseReceiverConfig', () => {
  it('throws on an empty/undefined config (empty host port)', () => {
    expect(() => parseReceiverConfig(undefined)).toThrow(/host port/i);
  });

  it('throws when the track map is invalid', () => {
    expect(() => parseReceiverConfig({ urlHostPort: 'https://relay:4433', moqTracks: {} })).toThrow(
      /> 0/,
    );
  });

  it('returns a fully-populated config for valid input', () => {
    const cfg = parseReceiverConfig({
      urlHostPort: 'https://relay:4433',
      isSendingStats: true,
      moqTracks: {
        video: { namespace: ['vc'], name: 'v0', authInfo: 'secret', timebase: 1000000 },
      },
      certificateHash: new Uint8Array([1, 2]),
      verbose: true,
    });
    expect(cfg.urlHostPort).toBe('https://relay:4433');
    expect(cfg.isSendingStats).toBe(true);
    expect(cfg.verbose).toBe(true);
    expect(Object.keys(cfg.moqTracks)).toEqual(['video']);
    expect(cfg.moqTracks.video.timebase).toBe(1000000);
  });
});

describe('checkTrackData', () => {
  it('rejects an empty track map', () => {
    expect(checkTrackData({})).toMatch(/needs to be > 0/);
  });

  it('rejects a track missing required fields', () => {
    expect(
      checkTrackData({
        a: { namespace: [], name: 'x', authInfo: 's', timebase: 1000000 } as TrackData,
      }),
    ).toMatch(/malformed/);
    expect(checkTrackData({ a: { namespace: ['vc'] } as TrackData })).toMatch(/malformed/);
  });

  it('rejects a track without a valid timebase', () => {
    expect(
      checkTrackData({ a: { namespace: ['vc'], name: 'v0', authInfo: 'secret' } as TrackData }),
    ).toMatch(/timebase/);
    expect(
      checkTrackData({
        a: { namespace: ['vc'], name: 'v0', authInfo: 'secret', timebase: 0 } as TrackData,
      }),
    ).toMatch(/timebase/);
  });

  it('accepts a valid track map', () => {
    expect(
      checkTrackData({
        a: { namespace: ['vc'], name: 'v0', authInfo: 'secret', timebase: 1000000 },
      }),
    ).toBeUndefined();
  });
});

describe('CMSF reception', () => {
  // WebCodecs types and the worker postMessage are browser globals.
  let posted: any[] = [];
  beforeEach(() => {
    posted = [];
    (globalThis as any).self = { postMessage: (msg: any) => posted.push(msg) };
    (globalThis as any).EncodedVideoChunk = class {
      timestamp: number;
      type: string;
      data: any;
      constructor(init: any) {
        this.timestamp = init.timestamp;
        this.type = init.type;
        this.data = init.data;
      }
    };
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const AVC_CONFIG = new Uint8Array([
    1, 0x42, 0x00, 0x1e, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x42, 0x00, 0x1e, 0x01, 0x00, 0x02, 0x68,
    0xce,
  ]);

  // The object payloads a CMSF publisher puts on the wire, as a readable stream
  // (which is how Moq.subscribe hands them to the receiver).
  function objectStream(payload: Uint8Array): ReadableStream<Uint8Array> {
    // A byte stream, like the one the MoQ layer exposes per object.
    return new ReadableStream({
      type: 'bytes',
      start(controller: any) {
        controller.enqueue(payload);
        controller.close();
      },
    } as any);
  }

  function cmsfReceiver(): any {
    const r = new MoqReceiver() as any;
    r.config = r.parseReceiverConfig({
      urlHostPort: 'https://relay:4433',
      moqTracks: { video: { namespace: ['vc'], name: 'v0', authInfo: 's', timebase: 1000 } },
      packagerFormat: 'cmaf',
    });
    return r;
  }

  // How the receiver is called for one object. A subgroup stream states the
  // payload length (buffRead path, which yields a raw ArrayBuffer); a datagram
  // does not (readUntilEof path, which yields a Uint8Array). Both have to work.
  async function receiveObject(
    receiver: any,
    payload: Uint8Array,
    withLength: boolean,
    groupId: number,
    objectId: number,
  ) {
    // Enqueuing detaches the payload buffer, so read its length first.
    const length = withLength ? payload.byteLength : undefined;
    await receiver.handleObject('video', objectStream(payload), [], length, groupId, objectId);
  }

  function videoObject(packager: CMAFPackager, tsUs: number, isDelta: boolean): Uint8Array {
    packager.SetSourceInfo({ codedWidth: 320, codedHeight: 180, durationUs: 33_333 });
    packager.SetData(
      tsUs,
      1_000_000,
      'avc1.42001e',
      isDelta ? undefined : AVC_CONFIG,
      new Uint8Array([1, 2, 3]),
      isDelta,
    );
    return packager.PayloadToBytes();
  }

  it.each([
    ['a subgroup stream (payload length known)', true],
    ['a datagram (payload read until EOF)', false],
  ])(
    'turns CMSF objects from %s into decoder chunks, in the track timebase',
    async (_name, withLength) => {
      const receiver = cmsfReceiver();
      const packager = new CMAFPackager('video');

      await receiveObject(receiver, videoObject(packager, 0, false), withLength, 0, 0);
      await receiveObject(receiver, videoObject(packager, 2_000_000, true), withLength, 0, 1);

      const chunks = posted.filter((m) => m.type === 'videochunk');
      expect(chunks).toHaveLength(2);
      expect(chunks[0].chunk.type).toBe('key');
      expect(chunks[0].codec).toBe('avc1.42001E');
      expect(chunks[0].metadata).toEqual(AVC_CONFIG);
      // 2s of a 1MHz source, in the 1kHz timebase this player asked for.
      expect(chunks[1].chunk.type).toBe('delta');
      expect(chunks[1].chunk.timestamp).toBe(2000);
      // The CMAF Header only rides the first object, but its config is reapplied.
      expect(chunks[1].metadata).toEqual(AVC_CONFIG);
    },
  );

  it('skips objects received before the first CMAF Header (joined mid-group)', async () => {
    const receiver = cmsfReceiver();
    const packager = new CMAFPackager('video');
    // The publisher is already running: its header went out before we joined.
    videoObject(packager, 0, false);

    await receiveObject(receiver, videoObject(packager, 33_333, true), true, 0, 1);
    expect(posted.filter((m) => m.type === 'videochunk')).toHaveLength(0);

    // ... and playback starts on the next object that carries one.
    await receiveObject(receiver, videoObject(packager, 1_000_000, false), true, 1, 0);
    expect(posted.filter((m) => m.type === 'videochunk')).toHaveLength(1);
  });
});
