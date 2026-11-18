/// <reference types="node" />
/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import { VideoRenderBuffer } from '../src/render/video_render_buffer.js';

import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function localDiagnosticFrame(timestamp: number): any {
  return { timestamp, displayWidth: 320, displayHeight: 180, close: jest.fn() };
}

// Execute the actual demo functions, not a second implementation of its logging.
function localDiagnosticPlayer(): any {
  const html = fs.readFileSync(`${__dirname}/../demo/player/index.html`, 'utf8');
  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
  const source = ts.createSourceFile('player.js', script, ts.ScriptTarget.Latest, true);
  const names = new Set([
    'createVideoDiagnostics',
    'logVideoDiagnostics',
    'updateAudioStats',
    'audioTimestamps',
    'processWorkerMessage',
    'processReleasedAudio',
    'createVideoRendererBuffer',
  ]);
  const functions = source.statements
    .filter((s: any) => ts.isFunctionDeclaration(s) && names.has(s.name?.text))
    .map((s: any) => s.getText(source))
    .join('\n');
  const context: any = {
    console: { debug: jest.fn() },
    Date,
    VERBOSE: true,
    timingInfo: {
      muxer: { currentVideoTs: 0, currentAudioTs: 0 },
      decoder: { currentVideoTs: 0, currentAudioTs: 0 },
      renderer: { currentAudioTsMs: -1, currentVideoTsMs: -1 },
    },
    buffersInfo: {
      decoder: { video: {}, audio: {} },
      renderer: { audio: {}, video: {} },
    },
    downloaderConfig: { moqTracks: { video: { timebase: 90000 }, audio: { timebase: 48000 } } },
    VideoRenderBuffer,
    videoRendererBuffer: new VideoRenderBuffer(90000),
    audioPlayer: { systemLatencyMs: 10, getRequestedPlaybackSpeed: () => 1 },
    playbackRateController: null,
    AUDIO_PLAYING: 1,
    AUDIO_STOPPED: 0,
    systemAudioLatencyMs: 0,
    lastPlaybackSpeed: 1,
    document: { hidden: false, getElementById: () => ({ value: '' }) },
    updateRendererAudioUI: jest.fn(),
    updateRendererVideoUI: jest.fn(),
    updateDecoderUI: jest.fn(),
    wtAudioJitterBuffer: { GetStats: () => ({}) },
    audioDecoderWorker: { postMessage: jest.fn() },
    updateChunkTSUI: jest.fn(),
    updatePlayedFromRelayUI: jest.fn(),
    updateJitterStatsUI: jest.fn(),
    setVideoSize: jest.fn(),
    videoPlayerCtx: { drawImage: jest.fn() },
    overlayExtractorStopped: true,
    wcLastRender: 0,
    RENDER_VIDEO_EVERY_MS: 10,
    animFrame: null,
    requestAnimationFrame: jest.fn(() => 1),
  };
  vm.createContext(context);
  vm.runInContext(functions, context);
  vm.runInContext('var videoDiagnostics = createVideoDiagnostics();', context);
  return context;
}

function localDiagnosticStats(playingTimestampTsMs: number | null = 1000): any {
  return {
    ctxState: 'running',
    currentTime: 2,
    nextPlayTime: 2.2,
    bufferAhead: 0.2,
    rendered: 3,
    gapsRecovered: 0,
    playingTimestampTsMs,
  };
}

function localDiagnosticSnapshot(context: any): any {
  const calls = context.console.debug.mock.calls;
  const message = calls[calls.length - 1][0];
  expect(message).toMatch(/^\[PLAYER-DIAG\] /);
  return JSON.parse(message.substring('[PLAYER-DIAG] '.length));
}

describe('Local player diagnostic snapshots', () => {
  let now = 0;
  beforeEach(() => {
    now = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });
  afterEach(() => jest.restoreAllMocks());

  it('distinguishes an empty buffer from future video without consuming frames', () => {
    const context = localDiagnosticPlayer();
    context.updateAudioStats(localDiagnosticStats());
    expect(localDiagnosticSnapshot(context).reason).toBe('empty-video-buffer');
    const frame = localDiagnosticFrame(900000);
    context.videoRendererBuffer.AddItem(frame);
    now = 1000;
    context.updateAudioStats(localDiagnosticStats());
    const snapshot = localDiagnosticSnapshot(context);
    expect(snapshot.reason).toBe('video-ahead-of-audio');
    expect(snapshot.videoBuffer.oldestTsMs).toBe(10000);
    expect(snapshot.videoLeadMs).toBe(9000);
    expect(snapshot.audioTimebase).toBe(48000);
    expect(snapshot.videoTimebase).toBe(90000);
    expect(context.videoRendererBuffer.elementsList).toEqual([frame]);
    expect(frame.close).not.toHaveBeenCalled();
  });

  it('logs promptly at clock zero, throttles the stats loop, and shows a frozen audio clock', () => {
    const context = localDiagnosticPlayer();
    context.updateAudioStats(localDiagnosticStats());
    expect(context.console.debug).toHaveBeenCalledTimes(1);
    now = 999;
    context.updateAudioStats(localDiagnosticStats());
    expect(context.console.debug).toHaveBeenCalledTimes(1);
    now = 1000;
    context.updateAudioStats(localDiagnosticStats());
    expect(context.console.debug).toHaveBeenCalledTimes(2);
    expect(localDiagnosticSnapshot(context).audioClockDeltaMs).toBe(0);
    expect(localDiagnosticSnapshot(context).renderLoopAgeMs).toBeNull();
  });

  it('reports waiting audio, hidden-page drops, and missing-renderer drops', async () => {
    const context = localDiagnosticPlayer();
    context.updateAudioStats(localDiagnosticStats(null));
    expect(localDiagnosticSnapshot(context).reason).toBe('waiting-for-audio-clock');
    context.document.hidden = true;
    const hiddenFrame = localDiagnosticFrame(0);
    await context.processWorkerMessage({ data: { type: 'vframe', frame: hiddenFrame } });
    now = 1000;
    context.updateAudioStats(localDiagnosticStats());
    expect(localDiagnosticSnapshot(context).reason).toBe('page-hidden');
    expect(localDiagnosticSnapshot(context).hiddenFrames).toBe(1);
    expect(hiddenFrame.close).toHaveBeenCalledTimes(1);
    context.document.hidden = false;
    context.videoRendererBuffer = null;
    const lateFrame = localDiagnosticFrame(0);
    await context.processWorkerMessage({ data: { type: 'vframe', frame: lateFrame } });
    now = 2000;
    context.updateAudioStats(localDiagnosticStats());
    expect(localDiagnosticSnapshot(context).reason).toBe('no-video-renderer');
    expect(localDiagnosticSnapshot(context).noRendererFrames).toBe(1);
    expect(lateFrame.close).toHaveBeenCalledTimes(1);
  });

  it('counts actual paints and no-frame attempts without changing exact-fit playback', async () => {
    const context = localDiagnosticPlayer();
    const frame = localDiagnosticFrame(90000);
    await context.processWorkerMessage({ data: { type: 'vframe', frame } });
    context.updateAudioStats(localDiagnosticStats());
    context.audioTimestamps(20);
    expect(context.videoPlayerCtx.drawImage).toHaveBeenCalledWith(frame, 0, 0, 320, 180);
    expect(frame.close).toHaveBeenCalledTimes(1);
    context.audioTimestamps(40);
    now = 1000;
    context.updateAudioStats(localDiagnosticStats(1020));
    const snapshot = localDiagnosticSnapshot(context);
    expect(snapshot.receivedFrames).toBe(1);
    expect(snapshot.paintedFrames).toBe(1);
    expect(snapshot.noFrameAttempts).toBe(1);
    expect(snapshot.lastRenderResult).toBe('empty-video-buffer');
    expect(snapshot.audioClockDeltaMs).toBe(20);
    expect(snapshot.lastFrameAgeMs).toBe(1000);
    expect(snapshot.lastPaintAgeMs).toBe(1000);
    expect(snapshot.renderLoopAgeMs).toBe(1000);
  });

  it('propagates verbose mode through the real audio chunk forwarding path', () => {
    const context = localDiagnosticPlayer();
    const released = [{ chunk: { timestamp: 0 }, groupId: 7, objId: 0, extraData: {} }];
    context.processReleasedAudio(released);
    expect(context.audioDecoderWorker.postMessage.mock.calls[0][0].verbose).toBe(true);
    context.VERBOSE = false;
    context.processReleasedAudio(released);
    expect(context.audioDecoderWorker.postMessage.mock.calls[1][0].verbose).toBe(false);
  });

  it('respects verbose mode and resets diagnostics for a new playback session', () => {
    const context = localDiagnosticPlayer();
    context.VERBOSE = false;
    context.updateAudioStats(localDiagnosticStats());
    expect(context.console.debug).not.toHaveBeenCalled();
    context.VERBOSE = true;
    context.updateAudioStats(localDiagnosticStats());
    context.createVideoRendererBuffer();
    context.updateAudioStats(localDiagnosticStats());
    expect(context.console.debug).toHaveBeenCalledTimes(2);
    expect(localDiagnosticSnapshot(context).paintedFrames).toBe(0);
    expect(localDiagnosticSnapshot(context).audioClockDeltaMs).toBeNull();
  });
});

function localDiagnosticWorker(track: 'audio' | 'video'): any {
  let listener: any;
  let decoderCallbacks: any;
  const posted: any[] = [];
  class LocalDecoder {
    decodeQueueSize = 0;
    state = 'unconfigured';
    constructor(callbacks: any) {
      decoderCallbacks = callbacks;
    }
    configure() {
      this.state = 'configured';
    }
    addEventListener() {}
    decode() {
      this.decodeQueueSize++;
    }
    async flush() {}
    close() {
      this.state = 'closed';
    }
  }
  (globalThis as any).self = {
    addEventListener: (_type: string, fn: any) => {
      listener = fn;
    },
    postMessage: (message: any, transfer: any) => posted.push({ message, transfer }),
  };
  (globalThis as any).AudioDecoder = LocalDecoder;
  (globalThis as any).VideoDecoder = LocalDecoder;
  jest.isolateModules(() => {
    if (track === 'audio') jest.requireActual('../src/decode/audio_decoder');
    else jest.requireActual('../src/decode/video_decoder');
  });
  return {
    posted,
    send: (data: any) => listener({ data }),
    output: (frame: any) => decoderCallbacks.output(frame),
  };
}

function localDiagnosticChunk(track: 'audio' | 'video', verbose?: boolean | null): any {
  return {
    type: `${track}chunk`,
    groupId: 7,
    objId: 0,
    timebase: 1000000,
    verbose,
    codec: track === 'video' ? 'avc1.42001e' : 'mp4a.40.2',
    metadata:
      track === 'audio'
        ? new Uint8Array([17, 136])
        : new Uint8Array([
            1, 0x42, 0, 0x1e, 0xff, 0xe1, 0, 4, 0x67, 0x42, 0, 0x1e, 1, 0, 2, 0x68, 0xce,
          ]),
    chunk: {
      timestamp: 0,
      byteLength: 8,
      type: 'key',
      copyTo: (dest: Uint8Array) => dest.set([0, 0, 0, 4, 0x65, 0, 0, 0]),
    },
  };
}

function localDiagnosticOutputs(worker: any): any[] {
  return worker.posted
    .filter((p: any) => p.message.type === 'debug' && p.message.data.includes('Decoded frame: '))
    .map((p: any) => JSON.parse(p.message.data.split('Decoded frame: ')[1]));
}

describe('Local render buffer diagnostic inspection', () => {
  it('reports an empty queue, multiple frames, capacity eviction, and clearing without extra closes', () => {
    const buffer = new VideoRenderBuffer(1000);
    expect(buffer.GetStats()).toEqual({
      queueSize: 0,
      queueLengthMs: 0,
      totalDiscarded: 0,
      oldestTsMs: null,
      newestTsMs: null,
    });
    const frames = Array.from({ length: 61 }, (_, i) => localDiagnosticFrame(i * 20));
    for (const frame of frames.slice(0, 60)) buffer.AddItem(frame);
    expect(buffer.GetStats()).toMatchObject({ queueSize: 60, oldestTsMs: 0, newestTsMs: 1180 });
    buffer.AddItem(frames[60]);
    expect(buffer.GetStats()).toEqual({
      queueSize: 60,
      queueLengthMs: 1180,
      totalDiscarded: 1,
      oldestTsMs: 20,
      newestTsMs: 1200,
    });
    expect(frames[0].close).toHaveBeenCalledTimes(1);
    for (const frame of frames.slice(1)) expect(frame.close).not.toHaveBeenCalled();
    buffer.Clear();
    expect(buffer.GetStats().queueSize).toBe(0);
    for (const frame of frames) expect(frame.close).toHaveBeenCalledTimes(1);
  });
});

describe.each(['audio', 'video'] as const)('Local %s decoder output diagnostics', (track) => {
  let now = 0;
  beforeEach(() => {
    now = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });
  afterEach(() => jest.restoreAllMocks());

  it('logs real outputs, raw and source timestamps, and throttles without losing frame transfers', async () => {
    const worker = localDiagnosticWorker(track);
    await worker.send(localDiagnosticChunk(track, true));
    const frame = { ...localDiagnosticFrame(0), sampleRate: 48000, numberOfFrames: 1024 };
    worker.output(frame);
    let outputs = localDiagnosticOutputs(worker);
    expect(outputs).toHaveLength(1);
    expect(outputs[0].outputFrames).toBe(1);
    expect(outputs[0].frameTs).toBe(0);
    expect(outputs[0].inputTs).toBe(0);
    expect(outputs[0].timebase).toBe(1000000);
    if (track === 'audio') expect(outputs[0].sourceTs).toBe(0);
    now = 999;
    worker.output({ ...frame, timestamp: 21333 });
    expect(localDiagnosticOutputs(worker)).toHaveLength(1);
    now = 1000;
    worker.output({ ...frame, timestamp: 42666 });
    outputs = localDiagnosticOutputs(worker);
    expect(outputs).toHaveLength(2);
    expect(outputs[1].outputFrames).toBe(3);
    expect(outputs[1].frameTs).toBe(42666);
    const frames = worker.posted.filter(
      (p: any) => p.message.type === (track === 'audio' ? 'aframe' : 'vframe'),
    );
    expect(frames).toHaveLength(3);
    expect(frames[0].transfer).toEqual([frame]);
    expect(frame.close).not.toHaveBeenCalled();
    await worker.send({ type: 'stop' });
    await worker.send(localDiagnosticChunk(track, true));
    worker.output(frame);
    expect(localDiagnosticOutputs(worker)[2].outputFrames).toBe(1);
  });

  it.each([undefined, null, false])(
    'does not emit output diagnostics with verbose=%s',
    async (verbose) => {
      const worker = localDiagnosticWorker(track);
      await worker.send(localDiagnosticChunk(track, verbose));
      worker.output(localDiagnosticFrame(0));
      expect(localDiagnosticOutputs(worker)).toHaveLength(0);
      expect(
        worker.posted.some(
          (p: any) => p.message.type === (track === 'audio' ? 'aframe' : 'vframe'),
        ),
      ).toBe(true);
    },
  );
});
