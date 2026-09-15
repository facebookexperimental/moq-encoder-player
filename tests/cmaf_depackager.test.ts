/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import { CMAFPackager } from '../src/packager/cmaf/cmaf_packager.js';
import {
  CMAFDepackager,
  opusHeadFromDOps,
  audioSpecificConfigFromEsds,
} from '../src/packager/cmaf/cmaf_depackager.js';
import { createDOps, createEsds } from '../src/packager/cmaf/cmaf_init_segment.js';
import { createDepackager } from '../src/packager/media_packager.js';
import { LOCPackager } from '../src/packager/loc_packager.js';

const TIMEBASE = 1_000_000;

// A complete AVCDecoderConfigurationRecord: baseline (66) / level 30, one SPS
// and one PPS, as WebCodecs hands it over in `description`.
const AVC_CONFIG = new Uint8Array([
  1, 0x42, 0x00, 0x1e, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x42, 0x00, 0x1e, 0x01, 0x00, 0x02, 0x68, 0xce,
]);
const AAC_CONFIG = new Uint8Array([0x11, 0x90]); // AAC-LC, 48kHz, 2ch

function makeOpusHead(channels = 2, preSkip = 312, sampleRate = 48000): Uint8Array {
  const head = new Uint8Array(19);
  head.set(new TextEncoder().encode('OpusHead'), 0);
  const view = new DataView(head.buffer);
  head[8] = 1;
  head[9] = channels;
  view.setUint16(10, preSkip, true);
  view.setUint32(12, sampleRate, true);
  view.setInt16(16, -3, true); // output gain
  head[18] = 0;
  return head;
}

function packVideo(
  packager: CMAFPackager,
  tsUs: number,
  isDelta: boolean,
  payload: Uint8Array,
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

function packAudio(
  packager: CMAFPackager,
  tsUs: number,
  config: Uint8Array,
  codec: string,
  payload: Uint8Array,
): Uint8Array {
  packager.SetSourceInfo({ durationUs: 20_000 });
  packager.SetData(tsUs, TIMEBASE, codec, config, payload, false);
  return packager.PayloadToBytes();
}

describe('CMSF round trip (packager -> depackager)', () => {
  it('recovers an AVC key frame: timing, codec, config and payload', () => {
    const payload = new Uint8Array([0, 0, 0, 2, 0x65, 0x88]);
    const object = packVideo(new CMAFPackager('video'), 1_234_567, false, payload);

    const depackager = new CMAFDepackager('video');
    depackager.ParseObject(object);
    const parsed = depackager.GetData();

    expect(parsed.mediaType).toBe('video');
    expect(parsed.timescale).toBe(TIMEBASE);
    expect(parsed.timestamp).toBe(1_234_567);
    expect(parsed.codec).toBe('avc1.42001E');
    expect(parsed.config).toEqual(AVC_CONFIG);
    expect(parsed.data).toEqual(payload);
    expect(depackager.IsDelta()).toBe(false);
  });

  it('keeps the track description across objects that carry no CMAF Header', () => {
    const packager = new CMAFPackager('video', { initRepeatEveryMs: 1000 });
    const depackager = new CMAFDepackager('video');

    depackager.ParseObject(packVideo(packager, 0, false, new Uint8Array([1])));

    // A delta object is a bare `styp moof mdat`: no moov, so the codec and the
    // decoder config have to come from what was parsed earlier.
    const deltaPayload = new Uint8Array([2, 3]);
    depackager.ParseObject(packVideo(packager, 33_333, true, deltaPayload));
    const parsed = depackager.GetData();

    expect(parsed.codec).toBe('avc1.42001E');
    expect(parsed.config).toEqual(AVC_CONFIG);
    expect(parsed.timescale).toBe(TIMEBASE);
    expect(parsed.timestamp).toBe(33_333);
    expect(parsed.data).toEqual(deltaPayload);
    expect(depackager.IsDelta()).toBe(true);
  });

  it('reports an undefined timescale until the first CMAF Header arrives', () => {
    const packager = new CMAFPackager('video', { initRepeatEveryMs: 1000 });
    // Publisher is already running: this object carries no header.
    packVideo(packager, 0, false, new Uint8Array([1]));
    const midStream = packVideo(packager, 33_333, true, new Uint8Array([2]));

    const depackager = new CMAFDepackager('video');
    depackager.ParseObject(midStream);

    expect(depackager.GetData().timescale).toBeUndefined();
    expect(depackager.GetData().codec).toBeUndefined();
    // ... and it picks up as soon as a header does arrive.
    depackager.ParseObject(packVideo(packager, 1_000_000, false, new Uint8Array([3])));
    expect(depackager.GetData().timescale).toBe(TIMEBASE);
  });

  it('recovers an Opus track, rebuilding the OpusHead the decoder needs', () => {
    const head = makeOpusHead(1, 312, 48000);
    const payload = new Uint8Array([9, 9, 9]);
    const object = packAudio(new CMAFPackager('audio'), 100_000, head, 'opus', payload);

    const depackager = new CMAFDepackager('audio');
    depackager.ParseObject(object);
    const parsed = depackager.GetData();

    expect(parsed.codec).toBe('opus');
    expect(parsed.config).toEqual(head);
    // Audio runs on its own media timescale (the sample rate), not the source one.
    expect(parsed.timescale).toBe(48000);
    expect(parsed.timestamp).toBe(4800); // 100ms in 48kHz ticks
    expect(parsed.data).toEqual(payload);
  });

  it('recovers an AAC track, pulling the AudioSpecificConfig out of the esds', () => {
    const payload = new Uint8Array([7, 7]);
    const object = packAudio(new CMAFPackager('audio'), 0, AAC_CONFIG, 'mp4a.40.2', payload);

    const depackager = new CMAFDepackager('audio');
    depackager.ParseObject(object);
    const parsed = depackager.GetData();

    expect(parsed.codec).toBe('mp4a.40.2');
    expect(parsed.config).toEqual(AAC_CONFIG);
    expect(parsed.timescale).toBe(48000);
    expect(parsed.data).toEqual(payload);
  });

  it('survives an object it cannot make sense of', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const depackager = new CMAFDepackager('video');
    depackager.ParseObject(new Uint8Array([0, 0, 0, 0, 1, 2]));

    expect(depackager.GetData().data).toBeUndefined();
    expect(depackager.GetData().timescale).toBeUndefined();
    jest.restoreAllMocks();
  });
});

describe('sample entry helpers', () => {
  it('dOps -> OpusHead is the inverse of OpusHead -> dOps', () => {
    const head = makeOpusHead(2, 500, 44100);
    // createDOps emits the box; strip its 8 byte header before reading it back.
    const dOps = createDOps(head).subarray(8);

    expect(opusHeadFromDOps(dOps)).toEqual(head);
  });

  it('esds -> AudioSpecificConfig is the inverse of AudioSpecificConfig -> esds', () => {
    const asc = new Uint8Array([0x12, 0x10, 0x56, 0xe5, 0x00]);
    const esds = createEsds(asc).subarray(8);

    expect(audioSpecificConfigFromEsds(esds)).toEqual(asc);
  });
});

describe('depackager factory', () => {
  it('builds the depackager the format asks for', () => {
    expect(createDepackager('loc', 'video')).toBeInstanceOf(LOCPackager);
    expect(createDepackager('loc', 'data')).toBeInstanceOf(LOCPackager);
    expect(createDepackager('cmaf', 'video')).toBeInstanceOf(CMAFDepackager);
    expect(createDepackager('cmaf', 'audio')).toBeInstanceOf(CMAFDepackager);
  });

  it('rejects media types CMAF does not cover', () => {
    expect(() => createDepackager('cmaf', 'data')).toThrow(/only covers audio and video/);
  });
});
