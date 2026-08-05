/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import {
  LOCPackager,
  LOC_PROP_TIMESCALE,
  LOC_PROP_VIDEO_FRAME_MARKING,
  LOC_PROP_VIDEO_CONFIG,
  LOC_PROP_AUDIO_CONFIG,
  LOC_PROP_TIMESTAMP,
  LOC_PROP_CODECSTRING,
  LOCgetTrackName,
  type LOCMediaType,
} from '../src/packager/loc_packager.js';
import {
  moqSendObjectPerDatagramToWriter,
  moqParseObjectHeader,
  type KvPair,
} from '../src/moq/moqt.js';

// Serializing the properties is moqt.ts' job (and is covered there); here we
// hand the emitted KVPs straight back to a fresh packager, with the string
// values encoded the way the wire would deliver them.
function reparse(mediaType: LOCMediaType, props: KvPair[]): LOCPackager {
  const onWire = props.map((p) =>
    typeof p.val === 'string' ? { name: p.name, val: new TextEncoder().encode(p.val) } : p,
  );
  const packet = new LOCPackager(mediaType);
  packet.parseProperties(onWire);
  return packet;
}

function propertyIds(props: KvPair[]): number[] {
  return props.map((p) => p.name).sort((a, b) => a - b);
}

describe('LOCPackager properties', () => {
  const config = new Uint8Array([1, 2, 3, 4]);

  it('round-trips a video key frame', () => {
    const packet = new LOCPackager('video');
    packet.SetData(1000, 1_000_000, 'avc1.42001e', config, new Uint8Array([9]), false);

    const props = packet.Properties();
    expect(propertyIds(props)).toEqual([
      LOC_PROP_TIMESCALE,
      LOC_PROP_VIDEO_FRAME_MARKING,
      LOC_PROP_VIDEO_CONFIG,
      LOC_PROP_TIMESTAMP,
      LOC_PROP_CODECSTRING,
    ]);

    const parsed = reparse('video', props);
    expect(parsed.GetData()).toMatchObject({
      mediaType: 'video',
      timestamp: 1000,
      timescale: 1_000_000,
      codec: 'avc1.42001e',
      config,
    });
    expect(parsed.IsDelta()).toBe(false);
  });

  it('round-trips a video delta frame, which carries no config', () => {
    const packet = new LOCPackager('video');
    packet.SetData(2000, 1_000_000, 'avc1.42001e', undefined, new Uint8Array([9]), true);

    const props = packet.Properties();
    expect(propertyIds(props)).toEqual([
      LOC_PROP_TIMESCALE,
      LOC_PROP_VIDEO_FRAME_MARKING,
      LOC_PROP_TIMESTAMP,
      LOC_PROP_CODECSTRING,
    ]);

    const parsed = reparse('video', props);
    expect(parsed.IsDelta()).toBe(true);
    expect(parsed.GetData().config).toBeUndefined();
  });

  it('marks frames with the RFC 9626 short form: start, end and independent', () => {
    const marking = (isDelta: boolean) => {
      const packet = new LOCPackager('video');
      packet.SetData(0, 1_000_000, 'avc1.42001e', undefined, new Uint8Array(), isDelta);
      const prop = packet.Properties().find((p) => p.name === LOC_PROP_VIDEO_FRAME_MARKING);
      return (prop!.val as Uint8Array)[0];
    };
    expect(marking(false)).toBe(0xe0);
    expect(marking(true)).toBe(0xc0);
  });

  it('round-trips an audio object', () => {
    const packet = new LOCPackager('audio');
    packet.SetData(480, 48000, 'opus', config, new Uint8Array([9]), false);

    const props = packet.Properties();
    expect(propertyIds(props)).toEqual([
      LOC_PROP_TIMESCALE,
      LOC_PROP_AUDIO_CONFIG,
      LOC_PROP_TIMESTAMP,
      LOC_PROP_CODECSTRING,
    ]);

    const parsed = reparse('audio', props);
    expect(parsed.GetData()).toMatchObject({
      mediaType: 'audio',
      timestamp: 480,
      timescale: 48000,
      codec: 'opus',
      config,
    });
  });

  it('emits no properties for a data object', () => {
    const packet = new LOCPackager('data');
    packet.SetData(undefined, undefined, undefined, undefined, 'hello', false);
    expect(packet.Properties()).toEqual([]);
    expect(packet.PayloadToBytes()).toBe('hello');
  });

  it('parses an object with no properties without failing', () => {
    expect(reparse('data', []).GetData()).toMatchObject({
      mediaType: 'data',
      timestamp: undefined,
      timescale: undefined,
    });
  });

  it('ignores properties it does not know', () => {
    const parsed = reparse('audio', [
      { name: LOC_PROP_TIMESTAMP, val: 7 },
      { name: LOC_PROP_TIMESCALE, val: 48000 },
      { name: 0x0c, val: 42 }, // Audio Level: registered by LOC, unused here
      { name: 0x7f, val: new Uint8Array([1]) },
    ]);
    expect(parsed.GetData()).toMatchObject({ timestamp: 7, timescale: 48000 });
  });

  it('refuses to emit a media object with no timing', () => {
    const packet = new LOCPackager('audio');
    packet.SetData(undefined, undefined, 'opus', config, new Uint8Array(), false);
    expect(() => packet.Properties()).toThrow(/timestamp and a timescale/);
  });
});

describe('LOC properties on the wire', () => {
  it('survives the MoQ object encoding, including the string codec', async () => {
    const packet = new LOCPackager('audio');
    const audioConfig = new Uint8Array([1, 2, 3]);
    packet.SetData(480, 48000, 'opus', audioConfig, new Uint8Array([9]), false);

    const cap = createCaptureStream();
    await moqSendObjectPerDatagramToWriter(
      cap.writer,
      1,
      2,
      3,
      0x0a,
      new Uint8Array([9]),
      packet.Properties(),
      false,
    );
    const parsed = await moqParseObjectHeader(createByobReadable(cap.getBytes()));

    const received = new LOCPackager('audio');
    received.parseProperties(parsed.extensionHeaders);
    expect(received.GetData()).toMatchObject({ timestamp: 480, timescale: 48000, codec: 'opus' });
    expect(received.GetData().config).toEqual(audioConfig);
  });
});

function createCaptureStream() {
  const chunks: Uint8Array[] = [];
  const writer = {
    write: async (bytes: Uint8Array) => {
      chunks.push(bytes);
    },
  };
  return {
    writer: writer as any,
    getBytes: () => {
      const out = new Uint8Array(chunks.reduce((total, c) => total + c.byteLength, 0));
      let pos = 0;
      for (const c of chunks) {
        out.set(c, pos);
        pos += c.byteLength;
      }
      return out;
    },
  };
}

function createByobReadable(bytes: Uint8Array) {
  let offset = 0;
  return new ReadableStream({
    type: 'bytes',
    pull(controller: any) {
      const view = controller.byobRequest.view;
      const size = Math.min(view.byteLength, bytes.byteLength - offset);
      if (size <= 0) {
        controller.close();
        controller.byobRequest.respond(0);
        return;
      }
      new Uint8Array(view.buffer, view.byteOffset, size).set(bytes.subarray(offset, offset + size));
      offset += size;
      controller.byobRequest.respond(size);
    },
  }) as any;
}

describe('LOCgetTrackName', () => {
  it('suffixes the track prefix per media type', () => {
    expect(LOCgetTrackName('room1/', true)).toBe('room1/audio0');
    expect(LOCgetTrackName('room1/', false)).toBe('room1/video0');
  });
});
