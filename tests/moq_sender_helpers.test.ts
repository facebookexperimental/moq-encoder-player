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

describe('packaging config', () => {
  const baseConfig = {
    urlHostPort: 'https://relay:4433',
    moqTracks: { video: { namespace: ['vc'], name: 'v0', authInfo: 'secret' } },
  };

  it('defaults to LOC with the CMAF dump disabled', () => {
    const cfg = parseSenderConfig(baseConfig);
    expect(cfg.packagerFormat).toBe('loc');
    expect(cfg.cmafDump.enabled).toBe(false);
    expect(cfg.cmafDump.mediaTypes).toEqual(['video', 'audio']);
  });

  it('only accepts the formats it implements', () => {
    expect(parseSenderConfig({ ...baseConfig, packagerFormat: 'cmaf' }).packagerFormat).toBe(
      'cmaf',
    );
    expect(parseSenderConfig({ ...baseConfig, packagerFormat: 'mp2t' }).packagerFormat).toBe('loc');
  });

  it('reads the CMAF dump settings', () => {
    const cfg = parseSenderConfig({
      ...baseConfig,
      packagerFormat: 'cmaf',
      cmafDump: { enabled: true, mediaTypes: ['video'], maxObjects: 10 },
    });
    expect(cfg.cmafDump).toEqual({ enabled: true, mediaTypes: ['video'], maxObjects: 10 });
  });
});

describe('CMAF dump capture', () => {
  // The capture posts the collected bytes back to the main thread; in the
  // worker that is `self.postMessage`.
  let posted: any[] = [];
  beforeEach(() => {
    posted = [];
    (globalThis as any).self = { postMessage: (msg: any) => posted.push(msg) };
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  // A MoqSender with the dump armed from its config, without a live session.
  function armedSender(cmafDump: any, packagerFormat = 'cmaf') {
    const s = new MoqSender() as any;
    s.config = parseSenderConfig({
      urlHostPort: 'https://relay:4433',
      moqTracks: { video: { namespace: ['vc'], name: 'v0', authInfo: 'secret' } },
      packagerFormat,
      cmafDump,
    });
    s.startConfiguredCmafDump();
    return s;
  }

  it('captures nothing until a group starts, so the file opens with a CMAF Header', () => {
    const s = armedSender({ enabled: true, mediaTypes: ['video'], maxObjects: 10 });

    s.captureForDump('video', new Uint8Array([1]), false); // mid-group, ignored
    s.captureForDump('video', new Uint8Array([2]), true); // group boundary
    s.captureForDump('video', new Uint8Array([3]), false);
    s.handleStop();

    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ type: 'cmafdump', mediaType: 'video' });
    expect(posted[0].data).toEqual(new Uint8Array([2, 3]));
  });

  it('saves the file as soon as the object cap is reached', () => {
    const s = armedSender({ enabled: true, mediaTypes: ['video'], maxObjects: 2 });

    s.captureForDump('video', new Uint8Array([1]), true);
    s.captureForDump('video', new Uint8Array([2]), false);
    expect(posted).toHaveLength(1);
    expect(posted[0].data).toEqual(new Uint8Array([1, 2]));

    // Disarmed afterwards: the rest of the session is not captured.
    s.captureForDump('video', new Uint8Array([3]), true);
    s.handleStop();
    expect(posted).toHaveLength(1);
  });

  it('stays inert when disabled, and on media types it was not armed for', () => {
    const s = armedSender({ enabled: false });
    s.captureForDump('video', new Uint8Array([1]), true);
    s.handleStop();
    expect(posted).toHaveLength(0);

    const armedForVideo = armedSender({ enabled: true, mediaTypes: ['video'], maxObjects: 10 });
    armedForVideo.captureForDump('audio', new Uint8Array([1]), true);
    armedForVideo.handleStop();
    expect(posted).toHaveLength(0);
  });

  it('warns when dumping a LOC stream, which is not a valid MP4', () => {
    const warn = jest.spyOn(console, 'warn');
    armedSender({ enabled: true, mediaTypes: ['video'] }, 'loc');
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/NOT be a valid MP4/));
  });

  it('captures with no session at all: the file does not depend on the transport', () => {
    const s = armedSender({ enabled: true, mediaTypes: ['video'], maxObjects: 10 });
    // A stand-in for an EncodedVideoChunk, and a stand-in for the
    // AVCDecoderConfigurationRecord the encoder attaches to key frames.
    const chunk = {
      byteLength: 3,
      timestamp: 0,
      duration: 33_333,
      type: 'key',
      copyTo: (buf: Uint8Array) => buf.set([7, 8, 9]),
    };
    const avcConfig = new Uint8Array([1, 0x42, 0x00, 0x1e, 0xff, 0xe1, 0, 1, 0x67]);

    // this.moq is null (no init, no relay), so the chunk cannot be published...
    s.handleChunk({
      mediaType: 'video',
      chunk,
      seqId: 0,
      compensatedTs: 0,
      metadata: avcConfig,
      timebase: 1_000_000,
      codec: 'avc1.42001e',
      codedWidth: 320,
      codedHeight: 180,
    });
    expect(posted.filter((m) => m.type === 'dropped')).toHaveLength(1);

    // ... but it was still packaged and captured.
    s.handleStop();
    const dump = posted.find((m) => m.type === 'cmafdump');
    expect(dump).toBeDefined();
    expect(new TextDecoder().decode(dump.data.subarray(4, 8))).toBe('ftyp');
    expect(dump.data.byteLength).toBeGreaterThan(avcConfig.byteLength);
  });
});
