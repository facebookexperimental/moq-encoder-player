/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import { MoqSender, type TrackData } from '../src/sender/moq/moq_sender_internals.js';
import { CMAFDepackager } from '../src/packager/cmaf/cmaf_depackager.js';
import { MoqState } from '../src/moq/moq.js';
import { RelayConnection, type RelayLabel } from '../src/sender/moq/relay_connection.js';

// A relay connection with a running session and the given tracks, no transport.
function connectionWith(label: RelayLabel, tracks: Record<string, any>): RelayConnection {
  const conn = new RelayConnection(label, `https://${label}:4433`);
  conn.moq = { state: MoqState.Running, close: () => {} } as any;
  conn.tracks = tracks;
  return conn;
}

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

  it('defaults to LOC with the media dump disabled', () => {
    const cfg = parseSenderConfig(baseConfig);
    expect(cfg.packagerFormat).toBe('loc');
    expect(cfg.mediaDump.enabled).toBe(false);
    expect(cfg.mediaDump.mediaTypes).toEqual(['video', 'audio']);
  });

  it('only accepts the formats it implements', () => {
    expect(parseSenderConfig({ ...baseConfig, packagerFormat: 'cmaf' }).packagerFormat).toBe(
      'cmaf',
    );
    expect(parseSenderConfig({ ...baseConfig, packagerFormat: 'mp2t' }).packagerFormat).toBe('loc');
  });

  it('rejects CMSF over datagrams, which it can not initialize', () => {
    const datagramTracks = {
      audio: { namespace: ['vc'], name: 'a0', authInfo: 'secret', moqMapping: 'ObjPerDatagram' },
    };
    expect(() =>
      parseSenderConfig({ ...baseConfig, packagerFormat: 'cmaf', moqTracks: datagramTracks }),
    ).toThrow(/object per datagram/i);
    // ... but LOC is free to use them.
    expect(
      parseSenderConfig({ ...baseConfig, packagerFormat: 'loc', moqTracks: datagramTracks })
        .packagerFormat,
    ).toBe('loc');
  });

  it('reads the media dump settings', () => {
    const cfg = parseSenderConfig({
      ...baseConfig,
      packagerFormat: 'cmaf',
      mediaDump: { enabled: true, mediaTypes: ['video'], maxObjects: 10, maxDurationMs: 5000 },
    });
    expect(cfg.mediaDump).toEqual({
      enabled: true,
      mediaTypes: ['video'],
      maxObjects: 10,
      maxDurationMs: 5000,
    });
  });
});

describe('media dump capture', () => {
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
  function armedSender(mediaDump: any, packagerFormat = 'cmaf') {
    const s = new MoqSender() as any;
    s.config = parseSenderConfig({
      urlHostPort: 'https://relay:4433',
      moqTracks: { video: { namespace: ['vc'], name: 'v0', authInfo: 'secret' } },
      packagerFormat,
      mediaDump,
    });
    s.startConfiguredDump();
    return s;
  }

  it('stays inert when the dump is disabled', () => {
    const s = armedSender({ enabled: false });
    s.dumper.capture('video', new Uint8Array([1]), true);
    s.handleStop();
    expect(posted).toHaveLength(0);
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
    const dump = posted.find((m) => m.type === 'mediadump');
    expect(dump).toBeDefined();
    expect(dump.fileName).toBe('cmaf-video.mp4');
    expect(new TextDecoder().decode(dump.data.subarray(4, 8))).toBe('ftyp');
    expect(dump.data.byteLength).toBeGreaterThan(avcConfig.byteLength);
  });

  // `compensatedTs` is relative to a capture origin shared by audio and video,
  // and normalizeChunk clamps it at 0, so a sender that anchors its streams
  // imperfectly can report 0 for the first seconds of a track. The duration cap
  // must not be fooled by that: it reads the chunk timestamp instead.
  it('caps the capture on media duration, even when compensatedTs starts clamped', () => {
    const s = armedSender({
      enabled: true,
      mediaTypes: ['audio'],
      maxObjects: 10_000,
      maxDurationMs: 5000,
    });
    const opusHead = new Uint8Array(19);
    opusHead.set(new TextEncoder().encode('OpusHead'), 0);
    new DataView(opusHead.buffer).setUint32(12, 48000, true);
    opusHead[8] = 1;
    opusHead[9] = 1;

    // 15s of 10ms Opus whose first 3s land before the shared capture anchor.
    const ANCHOR_OFFSET_US = 3_000_000;
    for (let i = 0; i < 1500; i++) {
      const tsUs = i * 10_000;
      s.handleChunk({
        mediaType: 'audio',
        chunk: {
          byteLength: 2,
          timestamp: tsUs,
          duration: 10_000,
          type: 'key',
          copyTo: (buf: Uint8Array) => buf.set([1, 2]),
        },
        seqId: i,
        compensatedTs: tsUs - ANCHOR_OFFSET_US,
        metadata: opusHead,
        timebase: 1_000_000,
        codec: 'opus',
      });
    }
    s.handleStop();

    const dumps = posted.filter((m) => m.type === 'mediadump');
    expect(dumps).toHaveLength(1);
    expect(dumps[0].reason).toBe('durationCap');
    expect(dumps[0].durationMs).toBe(5000);
    expect(dumps[0].objects).toBe(501);
  });
});

describe('audio subgroup grouping', () => {
  beforeEach(() => {
    (globalThis as any).self = { postMessage: () => {} };
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const OPUS_HEAD = (() => {
    const head = new Uint8Array(19);
    head.set(new TextEncoder().encode('OpusHead'), 0);
    new DataView(head.buffer).setUint32(12, 48000, true);
    head[8] = 1;
    head[9] = 1;
    return head;
  })();

  // A sender that packages chunks without a session, reporting every packaged
  // object (and whether it starts a group) through a stand-in dumper.
  function packagingSender(packagerFormat: string, newSubgroupEvery?: number) {
    const s = new MoqSender() as any;
    s.config = parseSenderConfig({
      urlHostPort: 'https://relay:4433',
      moqTracks: {
        audio: { namespace: ['vc'], name: 'a0', authInfo: 'secret', newSubgroupEvery },
      },
      packagerFormat,
    });
    const objects: { newGroup: boolean; payload: Uint8Array }[] = [];
    s.dumper = {
      isArmed: () => true,
      capture: (_mediaType: string, payload: Uint8Array, newGroup: boolean) =>
        objects.push({ newGroup, payload }),
    };
    return { sender: s, objects };
  }

  function sendAudio(sender: any, count: number) {
    for (let i = 0; i < count; i++) {
      const tsUs = i * 20_000;
      sender.handleChunk({
        mediaType: 'audio',
        chunk: {
          byteLength: 4,
          timestamp: tsUs,
          duration: 20_000,
          type: 'key',
          copyTo: (buf: Uint8Array) => buf.set([1, 2, 3, 4]),
        },
        seqId: i,
        compensatedTs: tsUs,
        metadata: OPUS_HEAD,
        timebase: 1_000_000,
        codec: 'opus',
      });
    }
  }

  const carriesCmafHeader = (payload: Uint8Array) =>
    new TextDecoder().decode(payload.subarray(4, 8)) === 'ftyp';

  it('starts a group on every frame by default', () => {
    const { sender, objects } = packagingSender('loc');
    sendAudio(sender, 6);

    expect(objects.map((o) => o.newGroup)).toEqual([true, true, true, true, true, true]);
  });

  it('starts a group every N frames when the track asks for it', () => {
    const { sender, objects } = packagingSender('loc', 5);
    sendAudio(sender, 12);

    expect(objects.map((o) => o.newGroup)).toEqual([
      true,
      false,
      false,
      false,
      false, // frames 0-4
      true,
      false,
      false,
      false,
      false, // frames 5-9
      true,
      false, // frames 10-11
    ]);
  });

  it('keeps the CMSF CMAF Header on the objects that open a group', () => {
    // 120 frames of 20ms = 2.4s, so the header (repeated at most every 1s) has
    // to ride more than one group.
    const { sender, objects } = packagingSender('cmaf', 10);
    sendAudio(sender, 120);

    const withHeader = objects.filter((o) => carriesCmafHeader(o.payload));
    expect(withHeader.length).toBeGreaterThan(1);
    expect(withHeader.every((o) => o.newGroup)).toBe(true);
    expect(objects.filter((o) => o.newGroup)).toHaveLength(12);
  });

  it('does NOT mark the grouped CMSF audio frames as delta samples', () => {
    const { sender, objects } = packagingSender('cmaf', 5);
    sendAudio(sender, 5);

    // Every audio frame is independent, whatever group it ends up in: a
    // subscriber must not see the mid-group ones as non-sync samples.
    const depackager = new CMAFDepackager('audio');
    for (const object of objects) {
      depackager.ParseObject(object.payload);
      expect(depackager.IsDelta()).toBe(false);
    }
  });
});

describe('subgroup byte accounting', () => {
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

  // A Track stand-in: it accepts objects (reporting them as sent, like the real
  // drain does) and lets the test declare which subgroup has finished.
  function fakeTrack(groupId: number) {
    const sent: Uint8Array[] = [];
    const state = {
      sent,
      groupId,
      lastSubgroup: undefined as any,
      getInfo: () => ({
        numSubscribers: 1,
        numQueued: 0,
        numOpenStreams: 1,
        lastSubgroup: state.lastSubgroup,
      }),
      sendObject: (payload: Uint8Array, _opts: any, _props: any, onSent: (o: any) => void) => {
        sent.push(payload);
        const handle = {
          getInfo: () => ({ groupId: state.groupId, objId: sent.length - 1, status: 'sent' }),
        };
        // The real drain hands the object back to its callback once written.
        onSent(handle);
        return handle;
      },
    };
    return state;
  }

  function senderWithTrack(packagerFormat: string, track: any) {
    const s = new MoqSender() as any;
    s.config = parseSenderConfig({
      urlHostPort: 'https://relay:4433',
      moqTracks: {
        audio: { namespace: ['vc'], name: 'a0', authInfo: 'secret', newSubgroupEvery: 2 },
      },
      packagerFormat,
    });
    s.connections = [connectionWith('main', { audio: track })];
    return s;
  }

  const OPUS_HEAD = (() => {
    const head = new Uint8Array(19);
    head.set(new TextEncoder().encode('OpusHead'), 0);
    new DataView(head.buffer).setUint32(12, 48000, true);
    head[8] = 1;
    head[9] = 1;
    return head;
  })();

  function sendAudio(sender: any, count: number, mediaBytes: number) {
    for (let i = 0; i < count; i++) {
      sender.handleChunk({
        mediaType: 'audio',
        chunk: {
          byteLength: mediaBytes,
          timestamp: i * 20_000,
          duration: 20_000,
          type: 'key',
          copyTo: (buf: Uint8Array) => buf.fill(7),
        },
        seqId: i,
        compensatedTs: i * 20_000,
        metadata: OPUS_HEAD,
        timebase: 1_000_000,
        codec: 'opus',
      });
    }
  }

  it('reports the media payload and the MoQ signaling of a finished subgroup (LOC)', () => {
    const track = fakeTrack(0);
    const sender = senderWithTrack('loc', track);

    sendAudio(sender, 2, 100);
    // LOC only prepends its 2 byte empty private properties block.
    expect(track.sent.map((p: Uint8Array) => p.byteLength)).toEqual([102, 102]);

    track.lastSubgroup = { groupId: 0, objects: 2, payloadBytes: 204, signalingBytes: 37 };
    track.groupId = 1; // the next chunk belongs to the next group
    sendAudio(sender, 1, 100); // any later chunk flushes the stats

    const report = posted.find((m) => m.type === 'subgroupbytes');
    expect(report).toMatchObject({
      mediaType: 'audio',
      groupId: 0,
      objects: 2,
      payloadBytes: 200,
      overheadBytes: 41,
    });
  });

  it('counts what the packager added as overhead too (CMSF)', () => {
    const track = fakeTrack(0);
    const sender = senderWithTrack('cmaf', track);

    sendAudio(sender, 2, 100);
    const packagedBytes = track.sent.reduce((acc: number, p: Uint8Array) => acc + p.byteLength, 0);
    // The CMAF boxes (and the header on the first object) are real bytes.
    expect(packagedBytes).toBeGreaterThan(200);

    track.lastSubgroup = {
      groupId: 0,
      objects: 2,
      payloadBytes: packagedBytes,
      signalingBytes: 37,
    };
    track.groupId = 1;
    sendAudio(sender, 1, 100);

    const report = posted.find((m) => m.type === 'subgroupbytes');
    expect(report.payloadBytes).toBe(200);
    expect(report.overheadBytes).toBe(packagedBytes - 200 + 37);
  });

  it('reports each finished subgroup once', () => {
    const track = fakeTrack(0);
    const sender = senderWithTrack('loc', track);

    track.lastSubgroup = { groupId: 0, objects: 1, payloadBytes: 100, signalingBytes: 20 };
    sendAudio(sender, 3, 100);
    expect(posted.filter((m) => m.type === 'subgroupbytes')).toHaveLength(1);

    track.groupId = 1;
    track.lastSubgroup = { groupId: 1, objects: 1, payloadBytes: 100, signalingBytes: 20 };
    sendAudio(sender, 1, 100);
    expect(posted.filter((m) => m.type === 'subgroupbytes')).toHaveLength(2);
  });
});

describe('main + backup relays', () => {
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

  // A Track stand-in recording everything it is handed. `refuse` makes it drop
  // every object, like a stuck relay whose send queue is full.
  function recordingTrack(refuse = false) {
    const calls: { payload: Uint8Array; newGroup: boolean; props: any; ids: any }[] = [];
    return {
      calls,
      getInfo: () => ({ numSubscribers: 1, numQueued: 0, numOpenStreams: 0 }),
      sendObject: (payload: Uint8Array, opts: any, props: any, _cb: any, ids: any) => {
        calls.push({ payload, newGroup: opts !== undefined, props, ids });
        return { getInfo: () => ({ ...ids, status: refuse ? 'dropped' : 'queued' }) };
      },
    };
  }

  function senderWith(connections: RelayConnection[]) {
    const s = new MoqSender() as any;
    s.config = parseSenderConfig({
      urlHostPort: 'https://main:4433',
      backupUrlHostPort: 'https://backup:4433',
      moqTracks: { video: { namespace: ['vc'], name: 'v0', authInfo: 'secret' } },
      packagerFormat: 'cmaf',
    });
    s.connections = connections;
    return s;
  }

  const AVC_CONFIG = new Uint8Array([1, 0x42, 0x00, 0x1e, 0xff, 0xe1, 0, 1, 0x67]);
  function sendVideo(sender: any, types: string[], firstSeqId = 0) {
    types.forEach((type, i) => {
      const seqId = firstSeqId + i;
      sender.handleChunk({
        mediaType: 'video',
        chunk: {
          byteLength: 3,
          timestamp: seqId * 33_333,
          duration: 33_333,
          type,
          copyTo: (buf: Uint8Array) => buf.set([seqId, 2, 3]),
        },
        seqId,
        compensatedTs: seqId * 33_333,
        metadata: type === 'key' ? AVC_CONFIG : undefined,
        timebase: 1_000_000,
        codec: 'avc1.42001e',
        codedWidth: 320,
        codedHeight: 180,
      });
    });
  }

  it('parses the backup relay url, disabled by default', () => {
    const base = {
      urlHostPort: 'https://main:4433',
      moqTracks: { video: { namespace: ['vc'], name: 'v0', authInfo: 'secret' } },
    };
    expect(parseSenderConfig(base).backupUrlHostPort).toBe('');
    expect(
      parseSenderConfig({ ...base, backupUrlHostPort: 'https://backup:4435' }).backupUrlHostPort,
    ).toBe('https://backup:4435');
  });

  it('sends the very same objects (bytes, properties, ids) to both relays', () => {
    const main = recordingTrack();
    const backup = recordingTrack();
    const sender = senderWith([
      connectionWith('main', { video: main }),
      connectionWith('backup', { video: backup }),
    ]);
    sendVideo(sender, ['key', 'delta', 'delta', 'key', 'delta']);

    expect(main.calls.map((c) => c.ids)).toEqual([
      { groupId: 0, objId: 0 },
      { groupId: 0, objId: 1 },
      { groupId: 0, objId: 2 },
      { groupId: 1, objId: 0 },
      { groupId: 1, objId: 1 },
    ]);
    expect(backup.calls).toHaveLength(main.calls.length);
    backup.calls.forEach((c, i) => {
      expect(c.payload).toBe(main.calls[i].payload); // packaged once
      expect(c.props).toBe(main.calls[i].props);
      expect(c.ids).toEqual(main.calls[i].ids);
      expect(c.newGroup).toBe(main.calls[i].newGroup);
    });
  });

  it('keeps the ids aligned when one relay can not send for a while', () => {
    const main = recordingTrack();
    const backup = recordingTrack();
    const backupConn = connectionWith('backup', {});
    const sender = senderWith([connectionWith('main', { video: main }), backupConn]);

    sendVideo(sender, ['key', 'delta']); // backup not subscribed yet
    backupConn.tracks = { video: backup as any };
    sendVideo(sender, ['delta', 'key'], 2);

    expect(backup.calls.map((c) => c.ids)).toEqual([
      { groupId: 0, objId: 2 },
      { groupId: 1, objId: 0 },
    ]);
    expect(main.calls.slice(2).map((c) => c.ids)).toEqual(backup.calls.map((c) => c.ids));
    const backupDrops = posted.filter((m) => m.type === 'dropped' && m.data.relay === 'backup');
    expect(backupDrops).toHaveLength(2);
    expect(backupDrops[0].data.msg).toMatch(/not subscribed/);
  });

  it('a stuck relay only drops (and reports) on its own side', () => {
    const main = recordingTrack();
    const stuck = recordingTrack(true);
    const sender = senderWith([
      connectionWith('main', { video: main }),
      connectionWith('backup', { video: stuck }),
    ]);
    sendVideo(sender, ['key', 'delta', 'delta']);

    expect(main.calls).toHaveLength(3);
    const drops = posted.filter((m) => m.type === 'dropped');
    expect(drops).toHaveLength(3);
    expect(drops.every((m) => m.data.relay === 'backup')).toBe(true);
    const stats = posted.filter((m) => m.type === 'sendstats');
    expect(stats.map((m) => m.relay)).toEqual([
      'main',
      'backup',
      'main',
      'backup',
      'main',
      'backup',
    ]);
  });

  it('stops every relay', () => {
    const closed: string[] = [];
    const main = connectionWith('main', {});
    const backup = connectionWith('backup', {});
    main.moq = { close: () => closed.push('main') } as any;
    backup.moq = { close: () => closed.push('backup') } as any;
    const sender = senderWith([main, backup]);
    sender.handleStop();
    expect(closed).toEqual(['main', 'backup']);
    expect(sender.connections).toEqual([]);
  });
});

describe('per-relay network issue injection', () => {
  function connWithBursts(label: RelayLabel) {
    const calls: string[] = [];
    const track = {
      forceDropBurst: (n: number) => calls.push(`drop ${n}`),
      forceHoldBurst: (n: number) => calls.push(`hold ${n}`),
    };
    return { conn: connectionWith(label, { video: track }), calls };
  }

  it('only affects the relay the action names (main by default)', () => {
    const main = connWithBursts('main');
    const backup = connWithBursts('backup');
    const s = new MoqSender() as any;
    s.connections = [main.conn, backup.conn];

    s.handleForceDropBurst({ relay: 'backup', mediaType: 'video', burst: 3 });
    s.handleForceHoldBurst({ relay: 'main', mediaType: 'video', burst: 2 });
    s.handleForceDropBurst({ mediaType: 'video', burst: 1 });

    expect(main.calls).toEqual(['hold 2', 'drop 1']);
    expect(backup.calls).toEqual(['drop 3']);
  });
});
