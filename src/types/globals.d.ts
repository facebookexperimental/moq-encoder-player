/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

/*
 * Ambient declarations for experimental browser APIs that are used by this
 * project but are not (yet) part of the standard TypeScript DOM library.
 *
 * They are intentionally loose: the goal of this migration is to type the
 * project's own code, not to provide a full spec-accurate model of these APIs.
 */

// ---------------------------------------------------------------------------
// WebTransport (https://developer.mozilla.org/en-US/docs/Web/API/WebTransport)
// ---------------------------------------------------------------------------
interface WebTransportCloseInfo {
  closeCode?: number;
  reason?: string;
}

declare class WebTransport {
  constructor(url: string, options?: unknown);
  readonly ready: Promise<void>;
  readonly closed: Promise<WebTransportCloseInfo>;
  readonly datagrams: any;
  readonly incomingUnidirectionalStreams: ReadableStream<any>;
  readonly incomingBidirectionalStreams: ReadableStream<any>;
  createUnidirectionalStream(options?: unknown): Promise<any>;
  createBidirectionalStream(options?: unknown): Promise<any>;
  close(closeInfo?: WebTransportCloseInfo): void;
}

declare class WebTransportError extends Error {
  readonly source: string;
  readonly streamErrorCode: number | null;
}

// ---------------------------------------------------------------------------
// AudioWorklet processor scope
// (https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletProcessor)
// ---------------------------------------------------------------------------
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}

declare function registerProcessor(
  name: string,
  processorCtor: new (options?: unknown) => AudioWorkletProcessor,
): void;
