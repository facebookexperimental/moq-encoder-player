/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import { MOQ_FORWARD_FALSE, MOQ_FORWARD_TRUE } from '../../moq/moqt.js';
import { type PackagerFormat } from '../../packager/media_packager.js';
import { sendMessageToMain } from '../../utils/utils.js';
import { ReceiverConnection, type RelayLabel } from './receiver_connection.js';

const WORKER_PREFIX = '[MOQ-DOWNLOADER]';

// When true, unexpected errors are re-thrown (surfaced in the console).
const DEV_MODE = true;

// A single track to subscribe to (from the `init` message config).
export interface TrackData {
  namespace: string[];
  name: string;
  // Timebase (ticks per second) this player wants the track's timestamps in.
  // Mandatory for audio and video: they may differ, so there is no safe default.
  timebase: number;
  authInfo?: string;
  maxInFlightRequests?: number;
  isHipri?: boolean;
  moqMapping?: string;
}

// Configuration passed in the `init` message (formerly `downloaderConfig`).
export interface ReceiverConfig {
  urlHostPort: string;
  // Optional second relay carrying the very same objects. '' = disabled.
  backupUrlHostPort: string;
  backupMode: 'none' | 'hot-hot' | 'hot-cold';
  isSendingStats: boolean;
  moqTracks: Record<string, TrackData>;
  certificateHash: any;
  // Packaging the publisher is expected to use on every track: LOC (default) or
  // CMAF / CMSF. There is no catalog to negotiate it, so it is a player setting.
  packagerFormat: PackagerFormat;
  verbose: boolean;
}

/**
 * MoQ subscriber Web Worker. Opens one subscribing session per relay (main and,
 * optionally, backup; see ReceiverConnection), each parsing its objects with
 * the configured depackager (LOC or CMSF, see src/packager/media_packager.ts)
 * into EncodedAudioChunk / EncodedVideoChunk for the player pipeline. All MoQ
 * protocol work (session, control loop, subscriptions, object reception) lives
 * in the `Moq`/`Subscription` classes.
 */
export class MoqReceiver {
  // Main relay first, then the optional backup.
  private connections: ReceiverConnection[] = [];
  private config: ReceiverConfig | null = null;
  // Preferred forwarding relay per media type. This is control-plane state used
  // to choose the direction of the next switch; playback badges follow objects.
  private active: Record<string, RelayLabel> = {};
  private switching = new Set<string>();

  // -------------------------------------------------------------------------
  // Worker message dispatch
  // -------------------------------------------------------------------------

  /** Entry point for the worker shell: routes one message to one handler. */
  async onMessage(e: MessageEvent): Promise<void> {
    const type = e.data?.type;
    try {
      switch (type) {
        case 'init':
          await this.handleInit(e.data);
          break;
        case 'stop':
          this.handleStop();
          break;
        case 'switch':
          await this.handleSwitch(e.data.mediaType);
          break;
        default:
          sendMessageToMain(WORKER_PREFIX, 'error', `Unknown message type received: ${type}`);
      }
    } catch (err: any) {
      if (DEV_MODE) {
        throw err;
      }
      sendMessageToMain(
        WORKER_PREFIX,
        'error',
        `Error handling message ${type}. Err: ${err?.message}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // init
  // -------------------------------------------------------------------------

  // Normalize a raw config object into a fully-populated ReceiverConfig.
  // Throws an Error if the config is invalid (empty host port or bad tracks).
  private parseReceiverConfig(raw: any): ReceiverConfig {
    const cfg = raw ?? {};
    const backupUrlHostPort =
      typeof cfg.backupUrlHostPort === 'string' ? cfg.backupUrlHostPort : '';
    const backupMode =
      cfg.backupMode === 'none' ||
      cfg.backupMode === 'hot-hot' ||
      cfg.backupMode === 'hot-cold'
        ? cfg.backupMode
        : backupUrlHostPort !== ''
          ? 'hot-hot'
          : 'none';
    const config: ReceiverConfig = {
      urlHostPort: typeof cfg.urlHostPort === 'string' ? cfg.urlHostPort : '',
      backupUrlHostPort,
      backupMode,
      isSendingStats: cfg.isSendingStats ?? false,
      moqTracks: cfg.moqTracks ?? {},
      certificateHash: cfg.certificateHash ?? null,
      packagerFormat: cfg.packagerFormat === 'cmaf' ? 'cmaf' : 'loc',
      verbose: cfg.verbose ?? false,
    };
    if (config.urlHostPort === '') {
      throw new Error('Empty host port');
    }
    const trackErr = this.checkTrackData(config.moqTracks);
    if (trackErr !== undefined) {
      throw new Error(trackErr);
    }
    return config;
  }

  // Validate the per-track config. Returns an error string, or undefined if OK.
  private checkTrackData(tracks: Record<string, TrackData>): string | undefined {
    if (Object.keys(tracks).length <= 0) {
      return 'Number of Track Ids to subscribe needs to be > 0';
    }
    for (const [mediaType, track] of Object.entries(tracks)) {
      if (
        !('namespace' in track) ||
        track.namespace.length <= 0 ||
        !('name' in track) ||
        !('authInfo' in track)
      ) {
        return 'Track malformed, needs to contain namespace, name, and authInfo';
      }
      // Only media tracks are timed; a data track carries no LOC timestamps.
      if (mediaType !== 'data' && !(track.timebase > 0)) {
        return 'Track malformed, needs a timebase (ticks/sec) > 0';
      }
    }
    return undefined;
  }

  /**
   * Open one session per relay (main and optional backup) and subscribe to the
   * configured tracks on each. The connections start concurrently and
   * independently: one that hangs or fails never holds back the other.
   */
  async handleInit(data: any): Promise<void> {
    if (this.connections.length > 0) {
      sendMessageToMain(WORKER_PREFIX, 'error', 'Received init while a session already exists');
      return;
    }

    const config = this.parseReceiverConfig(data.config);
    this.config = config;
    // Main subscriptions start forwarding. In hot-cold mode only the backup
    // subscriptions start with FORWARD=0, so every media type begins on main.
    this.active = Object.fromEntries(
      Object.keys(config.moqTracks).map((mediaType) => [mediaType, 'main' as RelayLabel]),
    );

    this.connections = [new ReceiverConnection('main', config.urlHostPort, config)];
    if (config.backupUrlHostPort !== '') {
      this.connections.push(new ReceiverConnection('backup', config.backupUrlHostPort, config));
    }
    await Promise.all(this.connections.map((conn) => conn.start()));
  }

  private async handleSwitch(mediaType: unknown): Promise<void> {
    if (
      typeof mediaType !== 'string' ||
      this.config?.backupMode !== 'hot-cold' ||
      this.active[mediaType] === undefined ||
      this.switching.has(mediaType)
    ) {
      return;
    }

    const main = this.connections.find((connection) => connection.label === 'main');
    const backup = this.connections.find((connection) => connection.label === 'backup');
    if (main === undefined || backup === undefined) {
      return;
    }

    // Toggle away from the relay selected by the previous successful switch.
    const previous = this.active[mediaType] === 'main' ? main : backup;
    const next = previous === main ? backup : main;
    this.switching.add(mediaType);
    try {
      sendMessageToMain(
        WORKER_PREFIX,
        'info',
        `Enabling ${mediaType} forwarding from ${next.label} relay`,
      );
      try {
        await next.setForward(mediaType, MOQ_FORWARD_TRUE);
      } catch (err: any) {
        sendMessageToMain(
          WORKER_PREFIX,
          'error',
          `Can NOT enable ${mediaType} forwarding from ${next.label} relay. Err: ${err?.message}`,
        );
        return;
      }

      if (
        this.config?.backupMode !== 'hot-cold' ||
        !this.switching.has(mediaType) ||
        !this.connections.includes(previous) ||
        !this.connections.includes(next)
      ) {
        return;
      }

      // Commit the new preference only after its FORWARD=1 is acknowledged.
      // The old relay is disabled afterwards to avoid a media-flow gap.
      this.active[mediaType] = next.label;
      sendMessageToMain(
        WORKER_PREFIX,
        'info',
        `${mediaType} forwarding switched to ${next.label} relay`,
      );
      sendMessageToMain(
        WORKER_PREFIX,
        'info',
        `Disabling ${mediaType} forwarding from ${previous.label} relay`,
      );
      try {
        await previous.setForward(mediaType, MOQ_FORWARD_FALSE);
      } catch (err: any) {
        sendMessageToMain(
          WORKER_PREFIX,
          'error',
          `Can NOT disable ${mediaType} forwarding from ${previous.label} relay. Err: ${err?.message}`,
        );
      }
    } finally {
      this.switching.delete(mediaType);
    }
  }

  // -------------------------------------------------------------------------
  // stop
  // -------------------------------------------------------------------------

  /** Stop subscribing and close every relay session. */
  handleStop(): void {
    for (const conn of this.connections) {
      conn.close();
    }
    this.connections = [];
    this.config = null;
    // A later init rebuilds the per-media preferences with main as the default.
    this.active = {};
    this.switching.clear();
  }
}
