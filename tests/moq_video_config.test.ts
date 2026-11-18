/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import {
  buildTrackName,
  deriveDetailedBuffers,
  normalizeAdvancedConfig,
  normalizePackager,
  normalizeSizeStrategy,
  receiverPackagerFormat,
  resolveMoqVideoConfig,
  splitNamespace,
  validateTargetBufferSize,
} from '../src/player/moq_video_config';

describe('moq-video config defaults', () => {
  it('requires only src and fills every documented default', () => {
    const config = resolveMoqVideoConfig({ src: 'https://localhost:4433/moq' });
    expect(config.namespace).toBe('vc');
    expect(config.tracksPrefix).toBe('');
    expect(config.videoSuffix).toBe('video0');
    expect(config.audioSuffix).toBe('audio0');
    expect(config.packager).toBe('CMSF');
    expect(config.sizeStrategy).toBe('fitInCanvas');
    expect(config.isLocal).toBe(false);
    expect(config.advancedConfig.authInfo).toBe('secret');
    expect(config.advancedConfig.targetBufferSizeMs).toBe(200);
    expect(config.advancedConfig.audioRenderBufferMs).toBe(200);
    expect(config.advancedConfig.audioJitterBufferMs).toBe(160);
    expect(config.advancedConfig.videoJitterBufferMs).toBe(160);
    expect(config.advancedConfig.speedCompensation).toEqual({
      enabled: true,
      onTargetRangePercent: 20,
      speedUp: 1.05,
      slowDown: 0.95,
    });
    expect(config.advancedConfig.verbose).toBe(true);
  });

  it('keeps an explicitly supplied value instead of the default', () => {
    const config = resolveMoqVideoConfig({
      src: 'https://relay.example/moq',
      namespace: 'live/show',
      tracksPrefix: '2024',
      packager: 'LOC',
      isLocal: true,
    });
    expect(config.namespace).toBe('live/show');
    expect(config.tracksPrefix).toBe('2024');
    expect(config.packager).toBe('LOC');
    expect(config.isLocal).toBe(true);
  });

  it('rejects a missing or malformed src', () => {
    expect(() => resolveMoqVideoConfig({ src: '' } as never)).toThrow(/src is mandatory/);
    expect(() => resolveMoqVideoConfig({ src: 'not a url' })).toThrow(/valid URL/);
  });

  it('rejects an empty namespace and empty suffixes with an empty prefix', () => {
    expect(() =>
      resolveMoqVideoConfig({ src: 'https://localhost:4433/moq', namespace: '/' }),
    ).toThrow(/namespace/);
    expect(() =>
      resolveMoqVideoConfig({ src: 'https://localhost:4433/moq', videoSuffix: '' }),
    ).toThrow(/tracksPrefix/);
  });
});

describe('packager and size strategy normalization', () => {
  it('maps the user-facing CMSF spelling to the receiver cmaf format', () => {
    expect(normalizePackager('CMSF')).toBe('CMSF');
    expect(normalizePackager('cmaf')).toBe('CMSF');
    expect(normalizePackager('loc')).toBe('LOC');
    expect(receiverPackagerFormat('CMSF')).toBe('cmaf');
    expect(receiverPackagerFormat('LOC')).toBe('loc');
    expect(() => normalizePackager('mp4')).toThrow(/CMSF.*LOC/);
  });

  it('accepts the demo display-mode spellings as size strategies', () => {
    expect(normalizeSizeStrategy('fitInCanvas')).toBe('fitInCanvas');
    expect(normalizeSizeStrategy('fit')).toBe('fitInCanvas');
    expect(normalizeSizeStrategy('original')).toBe('original');
    expect(normalizeSizeStrategy('originalResolution')).toBe('original');
    expect(() => normalizeSizeStrategy('cover')).toThrow(/sizeStrategy/);
  });
});

describe('advanced config', () => {
  it('derives detailed buffers from the target like the demo does', () => {
    expect(deriveDetailedBuffers(200)).toEqual({
      audioRenderBufferMs: 200,
      audioJitterBufferMs: 160,
      videoJitterBufferMs: 160,
    });
    expect(deriveDetailedBuffers(30)).toEqual({
      audioRenderBufferMs: 30,
      audioJitterBufferMs: 0,
      videoJitterBufferMs: 0,
    });
    expect(() => validateTargetBufferSize(9)).toThrow(RangeError);
    expect(() => validateTargetBufferSize(30001)).toThrow(RangeError);
    expect(validateTargetBufferSize(10)).toBe(10);
  });

  it('merges partial input over defaults and honors demo field-name aliases', () => {
    const merged = normalizeAdvancedConfig({
      token: 'hunter2',
      playbackTargetLatencyMs: 300,
      playerBufferMs: 123,
      speedCompensation: { onTargetRangePerct: 10, speedUp: 1.1 },
    });
    expect(merged.authInfo).toBe('hunter2');
    // The target derivation wins for the render buffer, then the explicit
    // playerBufferMs alias overrides it; the jitter caps stay derived.
    expect(merged.targetBufferSizeMs).toBe(300);
    expect(merged.audioJitterBufferMs).toBe(260);
    expect(merged.audioRenderBufferMs).toBe(123);
    expect(merged.speedCompensation.onTargetRangePercent).toBe(10);
    expect(merged.speedCompensation.speedUp).toBe(1.1);
    expect(merged.speedCompensation.slowDown).toBe(0.95);
  });

  it('does not mutate the base config when merging', () => {
    const base = normalizeAdvancedConfig(undefined);
    const merged = normalizeAdvancedConfig({ targetBufferSizeMs: 400 }, base);
    expect(merged.targetBufferSizeMs).toBe(400);
    expect(base.targetBufferSizeMs).toBe(200);
    expect(merged.speedCompensation).not.toBe(base.speedCompensation);
  });

  it('rejects a non-object advanced config', () => {
    expect(() => normalizeAdvancedConfig('nope' as never)).toThrow(TypeError);
  });
});

describe('track naming', () => {
  it('splits namespaces on / and concatenates prefix + suffix', () => {
    expect(splitNamespace('vc')).toEqual(['vc']);
    expect(splitNamespace('a/b/c')).toEqual(['a', 'b', 'c']);
    expect(splitNamespace('/vc/')).toEqual(['vc']);
    expect(buildTrackName('', 'video0')).toBe('video0');
    expect(buildTrackName('202112241726', 'video0')).toBe('202112241726video0');
  });
});
