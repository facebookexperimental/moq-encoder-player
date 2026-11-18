/// <reference types="node" />
/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { VideoRenderBuffer } from '../src/render/video_render_buffer.js';

// A cached pre-diagnostics renderer has the same queue fields, but no GetStats.
// Run the real audio stats -> diagnostic logger path against that shape.
function localCompatPlayer(buffer: any): any {
  const html = fs.readFileSync(`${__dirname}/../demo/player/index.html`, 'utf8');
  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
  const source = ts.createSourceFile('player.js', script, ts.ScriptTarget.Latest, true);
  const names = new Set(['createVideoDiagnostics', 'logVideoDiagnostics', 'updateAudioStats']);
  const functions = source.statements
    .filter((s: any) => ts.isFunctionDeclaration(s) && names.has(s.name?.text))
    .map((s: any) => s.getText(source))
    .join('\n');
  const context: any = {
    console: { debug: jest.fn() },
    Date,
    VERBOSE: true,
    videoRendererBuffer: buffer,
    timingInfo: {
      muxer: { currentAudioTs: 0, currentVideoTs: 0 },
      decoder: { currentAudioTs: 0, currentVideoTs: 0 },
      renderer: { currentAudioTsMs: -1 },
    },
    downloaderConfig: { moqTracks: { audio: { timebase: 48000 }, video: { timebase: 90000 } } },
    buffersInfo: { renderer: { audio: {} } },
    document: { hidden: false, getElementById: () => ({ value: '' }) },
    audioPlayer: null,
    playbackRateController: null,
    AUDIO_PLAYING: 1,
    AUDIO_STOPPED: 0,
    systemAudioLatencyMs: 0,
    updateRendererAudioUI: jest.fn(),
  };
  vm.createContext(context);
  vm.runInContext(functions, context);
  vm.runInContext('var videoDiagnostics = createVideoDiagnostics();', context);
  return context;
}

function localCompatLog(context: any, audioMs = 1000): any {
  expect(() =>
    context.updateAudioStats({
      ctxState: 'running',
      currentTime: 2,
      nextPlayTime: 2.2,
      bufferAhead: 0.2,
      playingTimestampTsMs: audioMs,
      gapsRecovered: 0,
    }),
  ).not.toThrow();
  expect(context.console.debug).toHaveBeenCalledTimes(1);
  return JSON.parse(context.console.debug.mock.calls[0][0].substring('[PLAYER-DIAG] '.length));
}

describe('Local cached-renderer diagnostic compatibility', () => {
  it('reports a multi-frame queue without GetStats and leaves every frame untouched', () => {
    const frames = [
      { timestamp: 900000, close: jest.fn() },
      { timestamp: 903000, close: jest.fn() },
    ];
    const buffer = {
      elementsList: frames,
      timebase: 90000,
      totalDiscarded: 4,
      avgItemDur: { avg: 3000 },
    };
    const snapshot = localCompatLog(localCompatPlayer(buffer));
    expect(snapshot.reason).toBe('video-ahead-of-audio');
    expect(snapshot.videoLeadMs).toBe(9000);
    expect(snapshot.videoBuffer).toEqual({
      queueSize: 2,
      queueLengthMs: (3000 * 1000) / 90000,
      totalDiscarded: 4,
      oldestTsMs: 10000,
      newestTsMs: (903000 * 1000) / 90000,
    });
    expect(buffer.elementsList).toBe(frames);
    expect(frames).toHaveLength(2);
    for (const frame of frames) expect(frame.close).not.toHaveBeenCalled();
  });

  it.each([{ frames: [] }, { frames: [{ timestamp: 0 }] }])(
    'handles cached empty and single-frame queues: %j',
    ({ frames }) => {
      const buffer = {
        elementsList: frames,
        timebase: 90000,
        totalDiscarded: 0,
        avgItemDur: { avg: 3000 },
      };
      const snapshot = localCompatLog(localCompatPlayer(buffer), 0);
      expect(snapshot.reason).toBe(frames.length === 0 ? 'empty-video-buffer' : 'frame-due');
      expect(snapshot.videoBuffer.queueSize).toBe(frames.length);
      expect(snapshot.videoBuffer.queueLengthMs).toBe(
        frames.length === 0 ? 0 : (3000 * 1000) / 90000,
      );
      expect(snapshot.videoBuffer.oldestTsMs).toBe(frames.length === 0 ? null : 0);
    },
  );

  it.each([undefined, null, {}])(
    'allows a minimal queue with absent duration statistics: %j',
    (avgItemDur) => {
      const buffer = {
        elementsList: [{ timestamp: 0 }],
        timebase: 90000,
        totalDiscarded: 0,
        avgItemDur,
      };
      const snapshot = localCompatLog(localCompatPlayer(buffer), 0);
      expect(snapshot.reason).toBe('frame-due');
      expect(snapshot.videoBuffer.queueLengthMs).toBe(0);
    },
  );

  it.each([null, undefined])('still reports an absent renderer: %s', (buffer) => {
    const snapshot = localCompatLog(localCompatPlayer(buffer));
    expect(snapshot.reason).toBe('no-video-renderer');
    expect(snapshot.videoBuffer).toBeNull();
  });

  it.each([undefined, null, 0, 'stale'])(
    'uses the fallback for a non-callable GetStats: %s',
    (GetStats) => {
      const buffer = { elementsList: [], timebase: 90000, totalDiscarded: 0, GetStats };
      const snapshot = localCompatLog(localCompatPlayer(buffer));
      expect(snapshot.reason).toBe('empty-video-buffer');
      expect(snapshot.videoBuffer.queueSize).toBe(0);
    },
  );

  it('preserves the current renderer GetStats path', () => {
    const buffer = new VideoRenderBuffer(90000);
    buffer.AddItem({ timestamp: 90000, close: jest.fn() });
    const getStats = jest.spyOn(buffer, 'GetStats');
    const snapshot = localCompatLog(localCompatPlayer(buffer));
    expect(getStats).toHaveBeenCalledTimes(1);
    expect(snapshot.reason).toBe('frame-due');
    expect(snapshot.videoBuffer).toEqual(buffer.GetStats());
    expect(buffer.elementsList).toHaveLength(1);
  });
});
