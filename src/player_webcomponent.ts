/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

/*
 * `<moq-video>` entry point, published as the `moq-encoder-player/player_webcomponent`
 * subpath export (see `exports` in package.json).
 *
 * Importing this module has a side effect: it registers the `moq-video`
 * custom element (see `src/player/moq_video.ts`). Do not re-export it from
 * the side-effect-free entry point (`src/index.ts`); consumers that only
 * need the transport/packager utilities must not pay for, or trigger,
 * element registration.
 *
 * Workers are still resolved relative to `src/player/moq_video.ts`, not
 * relative to this file, so the whole compiled `dist/` tree must be
 * shipped and served with its layout intact.
 */

export * from './player/moq_video.js';
export * from './player/moq_video_config.js';

declare global {
  interface HTMLElementTagNameMap {
    'moq-video': import('./player/moq_video.js').MoqVideoElement;
  }
}
