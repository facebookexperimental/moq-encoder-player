/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

/*
 * Public entry point of the library.
 *
 * It re-exports the reusable, side-effect-free modules. The Web Worker entry
 * points (capture/, encode/, decode/, sender/, receiver/) and the AudioWorklet
 * processor (render/source_buffer_worklet) are NOT re-exported here because
 * importing them runs their top-level side effects (they register message
 * listeners / processors). Those are loaded directly by the demos as workers.
 */

// Generic utilities
export * from './utils/utils.js';
export * from './utils/varint.js';
export * from './utils/buffer_utils.js';
export * from './utils/ts_queue.js';
export * from './utils/time_buffer_checker.js';
export * from './utils/jitter_buffer.js';

// Media (H.264 / AVCC) helpers
export * from './utils/media/avcc_parser.js';
export * from './utils/media/avc_decoder_configuration_record_parser.js';

// Media over QUIC transport + Media Interop packager
export * from './utils/moqt.js';
export * from './packager/mi_packager.js';

// Render buffers
export * from './render/video_render_buffer.js';
export * from './render/audio_circular_buffer.js';

// Overlay (in-band data) processors
export * from './overlay_processor/overlay_encoder.js';
export * from './overlay_processor/overlay_decoder.js';
