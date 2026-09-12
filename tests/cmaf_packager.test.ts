/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import { CMAFPackager, CMAF_PACKAGER_VERSION } from '../src/packager/cmaf/cmaf_packager.js';
import { createCMAFInitSegment } from '../src/packager/cmaf/cmaf_init_segment.js';
import { createPackager, getMediaTrackName } from '../src/packager/media_packager.js';
import { LOCPackager, LOCgetTrackName } from '../src/packager/loc_packager.js';

// ---------------------------------------------------------------------------
// A very small ISOBMFF walker, enough to inspect what the packager emits.
// ---------------------------------------------------------------------------

interface Box {
  type: string;
  // Offset of the box header within the buffer it was parsed from.
  start: number;
  size: number;
  payload: Uint8Array;
}

// Boxes whose children do not start at the beginning of the payload: `stsd` has
// a FullBox header + entry_count, and sample entries have their fixed fields.
const CHILD_OFFSETS: Record<string, number> = {
  stsd: 8,
  avc1: 78,
  Opus: 28,
  mp4a: 28,
};

function parseBoxes(buf: Uint8Array): Box[] {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const boxes: Box[] = [];
  let pos = 0;
  while (pos + 8 <= buf.byteLength) {
    const size = view.getUint32(pos);
    const type = new TextDecoder().decode(buf.subarray(pos + 4, pos + 8));
    expect(size).toBeGreaterThanOrEqual(8);
    expect(pos + size).toBeLessThanOrEqual(buf.byteLength);
    boxes.push({ type, start: pos, size, payload: buf.subarray(pos + 8, pos + size) });
    pos += size;
  }
  expect(pos).toBe(buf.byteLength);
  return boxes;
}

/** Look up a box by a '/' separated path, e.g. 'moov/trak/mdia'. */
function findBox(buf: Uint8Array, path: string): Box {
  const types = path.split('/');
  let boxes = parseBoxes(buf);
  let found: Box | undefined;
  types.forEach((type, index) => {
    found = boxes.find((b) => b.type === type);
    if (found === undefined) {
      throw new Error(`Box "${type}" not found while looking up "${path}"`);
    }
    // Only descend while there is more path left: the last box is a leaf as far
    // as this lookup is concerned, and its payload may not be a box list.
    if (index < types.length - 1) {
      boxes = parseBoxes(found.payload.subarray(CHILD_OFFSETS[found.type] ?? 0));
    }
  });
  return found!;
}

function boxTypes(buf: Uint8Array): string[] {
  return parseBoxes(buf).map((b) => b.type);
}

function u32At(buf: Uint8Array, offset: number): number {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(offset);
}

/** The single `trun` sample of an object payload, plus its `moof` context. */
function readSample(payload: Uint8Array) {
  const moof = findBox(payload, 'moof');
  const mfhd = findBox(payload, 'moof/mfhd');
  const tfdt = findBox(payload, 'moof/traf/tfdt');
  const trun = findBox(payload, 'moof/traf/trun');
  const mdat = parseBoxes(payload).find((b) => b.type === 'mdat')!;
  const tfdtView = new DataView(
    tfdt.payload.buffer,
    tfdt.payload.byteOffset,
    tfdt.payload.byteLength,
  );
  return {
    moofStart: moof.start,
    sequenceNumber: u32At(mfhd.payload, 4),
    baseMediaDecodeTime: Number(tfdtView.getBigUint64(4)),
    sampleCount: u32At(trun.payload, 4),
    dataOffset: u32At(trun.payload, 8),
    duration: u32At(trun.payload, 12),
    sampleSize: u32At(trun.payload, 16),
    sampleFlags: u32At(trun.payload, 20),
    mdatPayloadStart: mdat.start + 8,
    mdatPayload: mdat.payload,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TIMEBASE = 1_000_000;

// Bytes stand in for a real AVCDecoderConfigurationRecord: the packager copies
// the WebCodecs `description` into `avcC` verbatim, it never parses it.
const AVC_CONFIG = new Uint8Array([1, 0x42, 0x00, 0x1e, 0xff, 0xe1, 0, 2, 0x67, 0x42, 1, 0x68]);

function makeOpusHead(channels = 2, preSkip = 312, sampleRate = 48000): Uint8Array {
  const head = new Uint8Array(19);
  head.set(new TextEncoder().encode('OpusHead'), 0);
  const view = new DataView(head.buffer);
  head[8] = 1; // version
  head[9] = channels;
  view.setUint16(10, preSkip, true);
  view.setUint32(12, sampleRate, true);
  view.setInt16(16, 0, true); // output gain
  head[18] = 0; // channel mapping family
  return head;
}

// AAC-LC (objectType 2), 48000 Hz (index 3), 2 channels.
const AAC_CONFIG = new Uint8Array([0x11, 0x90]);

function videoObject(
  packager: CMAFPackager,
  tsUs: number,
  isDelta: boolean,
  payload = new Uint8Array([1, 2, 3, 4, 5]),
): Uint8Array {
  packager.SetSourceInfo({ codedWidth: 320, codedHeight: 180, durationUs: 33_333 });
  packager.SetData(
    tsUs,
    TIMEBASE,
    'avc1.42001e',
    isDelta ? undefined : AVC_CONFIG,
    payload,
    isDelta,
  );
  return packager.PayloadToBytes();
}

function audioObject(
  packager: CMAFPackager,
  tsUs: number,
  config: Uint8Array,
  codec: string,
  payload = new Uint8Array([9, 9, 9]),
): Uint8Array {
  packager.SetSourceInfo({ durationUs: 20_000 });
  packager.SetData(tsUs, TIMEBASE, codec, config, payload, false);
  return packager.PayloadToBytes();
}

// ---------------------------------------------------------------------------

describe('CMAF object layout', () => {
  it('makes the first object of a group self-initializing', () => {
    const packager = new CMAFPackager('video');
    const key = videoObject(packager, 0, false);

    // [ftyp moov] styp moof mdat
    expect(boxTypes(key)).toEqual(['ftyp', 'moov', 'styp', 'moof', 'mdat']);
    expect(findBox(key, 'moov/trak/mdia/minf/stbl/stsd/avc1/avcC').payload).toEqual(AVC_CONFIG);
    expect(findBox(key, 'moov/mvex/trex')).toBeDefined();
  });

  it('sends delta objects as a bare media fragment', () => {
    const packager = new CMAFPackager('video');
    videoObject(packager, 0, false);
    const delta = videoObject(packager, 33_333, true);

    expect(boxTypes(delta)).toEqual(['styp', 'moof', 'mdat']);
  });

  it('numbers the movie fragments in chunk order', () => {
    const packager = new CMAFPackager('video');
    const seqs = [
      videoObject(packager, 0, false),
      videoObject(packager, 33_333, true),
      videoObject(packager, 66_666, true),
    ].map((obj) => readSample(obj).sequenceNumber);

    expect(seqs).toEqual([1, 2, 3]);
  });

  it('points trun at the mdat payload and describes the sample', () => {
    const packager = new CMAFPackager('video');
    const payload = new Uint8Array([10, 20, 30, 40]);
    const key = videoObject(packager, 100_000, false, payload);
    const sample = readSample(key);

    expect(sample.sampleCount).toBe(1);
    expect(sample.sampleSize).toBe(payload.byteLength);
    expect(sample.mdatPayload).toEqual(payload);
    // data_offset is relative to the start of the enclosing moof
    // (default-base-is-moof).
    expect(sample.moofStart + sample.dataOffset).toBe(sample.mdatPayloadStart);
  });

  it('marks key frames as sync samples and delta frames as dependent', () => {
    const packager = new CMAFPackager('video');
    const key = readSample(videoObject(packager, 0, false));
    const delta = readSample(videoObject(packager, 33_333, true));

    expect(key.sampleFlags).toBe(0x02000000);
    expect(delta.sampleFlags).toBe(0x01010000);
  });

  it('carries no MoQ object properties, whatever the media type', () => {
    const video = new CMAFPackager('video');
    videoObject(video, 0, false);
    const audio = new CMAFPackager('audio');
    audioObject(audio, 0, makeOpusHead(), 'opus');

    expect(video.Properties()).toEqual([]);
    expect(audio.Properties()).toEqual([]);
  });
});

describe('CMAF timing', () => {
  it('keeps the WebCodecs microsecond timebase for video', () => {
    const packager = new CMAFPackager('video');
    const key = videoObject(packager, 1_234_567, false);
    const sample = readSample(key);

    expect(u32At(findBox(key, 'moov/trak/mdia/mdhd').payload, 12)).toBe(TIMEBASE);
    expect(sample.baseMediaDecodeTime).toBe(1_234_567);
    expect(sample.duration).toBe(33_333);
  });

  it('uses the audio sample rate as the media timescale', () => {
    const packager = new CMAFPackager('audio');
    const first = audioObject(packager, 0, makeOpusHead(), 'opus');
    const mdhd = findBox(first, 'moov/trak/mdia/mdhd');
    expect(u32At(mdhd.payload, 12)).toBe(48000);

    // 100ms in, in 48kHz ticks, and a 20ms sample duration.
    const sample = readSample(audioObject(packager, 100_000, makeOpusHead(), 'opus'));
    expect(sample.baseMediaDecodeTime).toBe(4800);
    expect(sample.duration).toBe(960);
  });

  it('needs a source timescale, it does not assume one', () => {
    const packager = new CMAFPackager('video');
    packager.SetSourceInfo({ codedWidth: 320, codedHeight: 180, durationUs: 33_333 });
    packager.SetData(0, undefined, 'avc1.42001e', AVC_CONFIG, new Uint8Array([1]), false);

    expect(() => packager.PayloadToBytes()).toThrow(/source timescale/);
  });

  it('falls back to the interval since the previous chunk when there is no duration', () => {
    const packager = new CMAFPackager('video');
    packager.SetSourceInfo({ codedWidth: 320, codedHeight: 180 });
    packager.SetData(0, TIMEBASE, 'avc1.42001e', AVC_CONFIG, new Uint8Array([1]), false);
    packager.PayloadToBytes();
    packager.SetData(40_000, TIMEBASE, 'avc1.42001e', undefined, new Uint8Array([1]), true);
    const sample = readSample(packager.PayloadToBytes());

    expect(sample.duration).toBe(40_000);
  });
});

describe('CMAF header repetition', () => {
  it('repeats the header at most once per interval, on group boundaries', () => {
    const packager = new CMAFPackager('video', { initRepeatEveryMs: 1000 });

    expect(boxTypes(videoObject(packager, 0, false))).toContain('ftyp');
    // A key frame 500ms later: the subscriber does not need another copy yet.
    expect(boxTypes(videoObject(packager, 500_000, false))).not.toContain('ftyp');
    // ... but one 1s in does.
    expect(boxTypes(videoObject(packager, 1_000_000, false))).toContain('ftyp');
  });

  it('can make every group self-initializing', () => {
    const packager = new CMAFPackager('audio', { initRepeatEveryMs: 0 });
    const head = makeOpusHead();

    expect(boxTypes(audioObject(packager, 0, head, 'opus'))).toContain('ftyp');
    expect(boxTypes(audioObject(packager, 20_000, head, 'opus'))).toContain('ftyp');
  });

  it('re-sends the header when the decoder config changes', () => {
    const packager = new CMAFPackager('video', { initRepeatEveryMs: 1000 });
    videoObject(packager, 0, false);

    const changed = new Uint8Array([1, 0x4d, 0x00, 0x1f, 0xff, 0xe1, 0, 1, 0x67]);
    packager.SetSourceInfo({ codedWidth: 320, codedHeight: 180, durationUs: 33_333 });
    packager.SetData(100_000, TIMEBASE, 'avc1.4d001f', changed, new Uint8Array([1]), false);
    const obj = packager.PayloadToBytes();

    expect(boxTypes(obj)).toContain('ftyp');
    expect(findBox(obj, 'moov/trak/mdia/minf/stbl/stsd/avc1/avcC').payload).toEqual(changed);
  });
});

describe('CMAF initialization header', () => {
  it('describes an AVC track', () => {
    const init = createCMAFInitSegment({
      mediaType: 'video',
      trackId: 1,
      timescale: TIMEBASE,
      codec: 'avc1.42001e',
      config: AVC_CONFIG,
      codedWidth: 320,
      codedHeight: 180,
    });

    expect(boxTypes(init)).toEqual(['ftyp', 'moov']);
    const avc1 = findBox(init, 'moov/trak/mdia/minf/stbl/stsd/avc1');
    // width / height live at the end of the fixed VisualSampleEntry fields.
    const view = new DataView(
      avc1.payload.buffer,
      avc1.payload.byteOffset,
      avc1.payload.byteLength,
    );
    expect(view.getUint16(24)).toBe(320);
    expect(view.getUint16(26)).toBe(180);
    // FullBox header (4) + pre_defined (4), then the handler type.
    expect(findBox(init, 'moov/trak/mdia/hdlr').payload.subarray(8, 12)).toEqual(
      new TextEncoder().encode('vide'),
    );
    expect(findBox(init, 'moov/trak/mdia/minf/vmhd')).toBeDefined();
  });

  it('describes an Opus track with a dOps box', () => {
    const init = createCMAFInitSegment({
      mediaType: 'audio',
      trackId: 1,
      timescale: 48000,
      codec: 'opus',
      config: makeOpusHead(2, 312, 48000),
    });

    const dOps = findBox(init, 'moov/trak/mdia/minf/stbl/stsd/Opus/dOps');
    const view = new DataView(
      dOps.payload.buffer,
      dOps.payload.byteOffset,
      dOps.payload.byteLength,
    );
    expect(dOps.payload[0]).toBe(0); // Version
    expect(dOps.payload[1]).toBe(2); // OutputChannelCount
    // Big endian in dOps, little endian in the OpusHead it came from.
    expect(view.getUint16(2)).toBe(312); // PreSkip
    expect(view.getUint32(4)).toBe(48000); // InputSampleRate
    expect(dOps.payload[10]).toBe(0); // ChannelMappingFamily

    const opus = findBox(init, 'moov/trak/mdia/minf/stbl/stsd/Opus');
    const entry = new DataView(
      opus.payload.buffer,
      opus.payload.byteOffset,
      opus.payload.byteLength,
    );
    expect(entry.getUint16(16)).toBe(2); // channelcount
    expect(entry.getUint32(24)).toBe(48000 * 0x10000); // samplerate, 16.16
    expect(findBox(init, 'moov/trak/mdia/minf/smhd')).toBeDefined();
  });

  it('describes an AAC track with an esds carrying the AudioSpecificConfig', () => {
    const init = createCMAFInitSegment({
      mediaType: 'audio',
      trackId: 1,
      timescale: 48000,
      codec: 'mp4a.40.2',
      config: AAC_CONFIG,
    });

    const esds = findBox(init, 'moov/trak/mdia/minf/stbl/stsd/mp4a/esds').payload;
    // FullBox header, then ES_Descriptor (0x03) > DecoderConfigDescriptor
    // (0x04) > DecoderSpecificInfo (0x05).
    expect(esds[4]).toBe(0x03);
    const decoderConfigTag = esds.indexOf(0x04, 5);
    expect(esds[decoderConfigTag + 2]).toBe(0x40); // MPEG-4 audio
    expect(esds[decoderConfigTag + 3]).toBe(0x15); // audio stream
    const decoderSpecificTag = esds.indexOf(0x05, decoderConfigTag);
    expect(esds[decoderSpecificTag + 1]).toBe(AAC_CONFIG.byteLength);
    expect(
      esds.subarray(decoderSpecificTag + 2, decoderSpecificTag + 2 + AAC_CONFIG.byteLength),
    ).toEqual(AAC_CONFIG);
  });
});

describe('packager factory', () => {
  it('builds the packager the format asks for', () => {
    expect(createPackager('loc', 'video')).toBeInstanceOf(LOCPackager);
    expect(createPackager('cmaf', 'video')).toBeInstanceOf(CMAFPackager);
    expect(createPackager('cmaf', 'audio')).toBeInstanceOf(CMAFPackager);
  });

  it('rejects media types CMAF does not cover, instead of packaging them as LOC', () => {
    expect(() => createPackager('cmaf', 'data')).toThrow(/only covers audio and video/);
    expect(createPackager('loc', 'data')).toBeInstanceOf(LOCPackager);
  });

  it('names tracks the same way in both formats', () => {
    expect(getMediaTrackName('room1/', true)).toBe(LOCgetTrackName('room1/', true));
    expect(getMediaTrackName('room1/', false)).toBe('room1/video0');
  });

  it('exposes the packaging spec version', () => {
    expect(CMAF_PACKAGER_VERSION).toContain('cmafpackaging');
  });
});
