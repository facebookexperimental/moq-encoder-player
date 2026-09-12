/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import { MediaDumper, type MediaDumpFile } from '../src/utils/media_dumper.js';

describe('MediaDumper', () => {
  let files: MediaDumpFile[] = [];

  beforeEach(() => {
    files = [];
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function dumper(format: 'loc' | 'cmaf' = 'cmaf') {
    return new MediaDumper(format, (file) => files.push(file));
  }

  it('captures nothing until a group starts, so the file is decodable on its own', () => {
    const d = dumper();
    d.arm('video', 10);

    d.capture('video', new Uint8Array([1]), false); // mid-group, ignored
    d.capture('video', new Uint8Array([2]), true); // group boundary
    d.capture('video', new Uint8Array([3]), false);
    d.flushAll();

    expect(files).toHaveLength(1);
    expect(files[0].mediaType).toBe('video');
    expect(files[0].data).toEqual(new Uint8Array([2, 3]));
  });

  it('saves the file as soon as the object cap is reached, then disarms', () => {
    const d = dumper();
    d.arm('video', 2);

    d.capture('video', new Uint8Array([1]), true);
    d.capture('video', new Uint8Array([2]), false);
    expect(files).toHaveLength(1);
    expect(files[0].data).toEqual(new Uint8Array([1, 2]));

    expect(d.isArmed('video')).toBe(false);
    d.capture('video', new Uint8Array([3]), true);
    d.flushAll();
    expect(files).toHaveLength(1);
  });

  it('saves the file once the asked-for media duration is captured', () => {
    const d = dumper();
    d.arm('video', 1000, 2000);

    d.capture('video', new Uint8Array([1]), true, 500);
    d.capture('video', new Uint8Array([2]), false, 1500);
    expect(files).toHaveLength(0);

    // 2s of media time after the first captured object.
    d.capture('video', new Uint8Array([3]), false, 2500);
    expect(files).toHaveLength(1);
    expect(files[0].data).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('ignores media types it was not armed for', () => {
    const d = dumper();
    d.arm('video', 10);

    d.capture('audio', new Uint8Array([1]), true);
    d.flushAll();

    expect(files).toHaveLength(0);
  });

  it('names the file after the packaging format', () => {
    const cmaf = dumper('cmaf');
    cmaf.arm('audio', 10);
    cmaf.capture('audio', new Uint8Array([1]), true);
    cmaf.flushAll();
    expect(files[0]).toMatchObject({ fileName: 'cmaf-audio.mp4', mimeType: 'video/mp4' });

    const loc = dumper('loc');
    loc.arm('video', 10);
    loc.capture('video', new Uint8Array([1]), true);
    loc.flushAll();
    expect(files[1]).toMatchObject({
      fileName: 'loc-video.bin',
      mimeType: 'application/octet-stream',
    });
  });

  it('armFromConfig arms every requested media type, and nothing when disabled', () => {
    const d = dumper();
    d.armFromConfig({ enabled: true, mediaTypes: ['video', 'audio'], maxDurationMs: 1000 });
    expect(d.armedMediaTypes()).toEqual(['video', 'audio']);

    d.armFromConfig({ enabled: false });
    expect(d.armedMediaTypes()).toEqual([]);
  });
});
