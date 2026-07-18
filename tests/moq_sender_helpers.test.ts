/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import { MoqSender, type TrackData } from '../src/sender/moq/moq_sender_internals.js';

// parseSenderConfig and checkTrackData are private methods; access them through
// a cast so the pure config logic can still be unit tested in isolation.
const sender = new MoqSender() as any;
const parseSenderConfig = (raw: any) => sender.parseSenderConfig(raw);
const checkTrackData = (tracks: Record<string, TrackData>) => sender.checkTrackData(tracks);

describe('parseSenderConfig', () => {
  it('throws on an empty/undefined config (empty host port)', () => {
    expect(() => parseSenderConfig(undefined)).toThrow(/host port/i);
  });

  it('throws when the track map is invalid', () => {
    expect(() => parseSenderConfig({ urlHostPort: 'https://relay:4433', moqTracks: {} })).toThrow(
      /> 0/,
    );
  });

  it('returns a fully-populated config and fills defaults for valid input', () => {
    const cfg = parseSenderConfig({
      urlHostPort: 'https://relay:4433',
      isSendingStats: false,
      moqTracks: { video: { namespace: ['vc'], name: 'v0', authInfo: 'secret' } },
      keepAlivesEveryMs: 5000,
      certificateHash: new Uint8Array([1, 2]),
      usePublishNamespace: true,
      verbose: true,
    });
    expect(cfg.urlHostPort).toBe('https://relay:4433');
    expect(cfg.isSendingStats).toBe(false);
    expect(cfg.keepAlivesEveryMs).toBe(5000);
    expect(cfg.usePublishNamespace).toBe(true);
    expect(cfg.verbose).toBe(true);
    expect(Object.keys(cfg.moqTracks)).toEqual(['video']);
  });
});

describe('checkTrackData', () => {
  it('rejects an empty track map', () => {
    expect(checkTrackData({})).toMatch(/needs to be > 0/);
  });

  it('rejects a track missing required fields', () => {
    expect(checkTrackData({ a: { namespace: [], name: 'x', authInfo: 's' } as TrackData })).toMatch(
      /malformed/,
    );
    expect(checkTrackData({ a: { namespace: ['vc'] } as TrackData })).toMatch(/malformed/);
  });

  it('accepts a valid track map', () => {
    expect(
      checkTrackData({ a: { namespace: ['vc'], name: 'v0', authInfo: 'secret' } }),
    ).toBeUndefined();
  });
});
