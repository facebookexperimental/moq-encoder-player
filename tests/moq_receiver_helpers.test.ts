/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import { MoqReceiver, type TrackData } from '../src/receiver/moq/moq_receiver_internals.js';

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
      moqTracks: { video: { namespace: ['vc'], name: 'v0', authInfo: 'secret', timebase: 1000000 } },
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
      checkTrackData({ a: { namespace: [], name: 'x', authInfo: 's', timebase: 1000000 } as TrackData }),
    ).toMatch(/malformed/);
    expect(checkTrackData({ a: { namespace: ['vc'] } as TrackData })).toMatch(/malformed/);
  });

  it('rejects a track without a valid timebase', () => {
    expect(
      checkTrackData({ a: { namespace: ['vc'], name: 'v0', authInfo: 'secret' } as TrackData }),
    ).toMatch(/timebase/);
    expect(
      checkTrackData({ a: { namespace: ['vc'], name: 'v0', authInfo: 'secret', timebase: 0 } as TrackData }),
    ).toMatch(/timebase/);
  });

  it('accepts a valid track map', () => {
    expect(
      checkTrackData({ a: { namespace: ['vc'], name: 'v0', authInfo: 'secret', timebase: 1000000 } }),
    ).toBeUndefined();
  });
});
