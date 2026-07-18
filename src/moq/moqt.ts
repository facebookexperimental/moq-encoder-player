/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import { numberToVarInt, varIntToNumberOrThrow, varIntToNumbeFromBuffer } from './varint.js';
import { numberTo2BytesArray, numberToSingleByteArray } from './byte_utils.js';
import {
  concatBuffer,
  buffRead,
  ReadStreamClosed,
  getArrayBufferByteLength,
} from './buffer_utils.js';

// MOQ Transport definitions — draft-ietf-moq-transport-19
// https://datatracker.ietf.org/doc/draft-ietf-moq-transport/
//
// Since draft-15 the MOQT version is negotiated by the transport via ALPN (over
// native QUIC) or WT-Available-Protocols (over WebTransport), not in-band in the
// SETUP message (draft-19 SETUP carries only Setup Options). The "version" is
// therefore an ALPN token string, offered to WebTransport as a connection
// protocol (see Moq.init in ./moq.ts).
export const MOQ_ALPN_DRAFT19_VERSION = 'moqt-19';

export const MOQ_CURRENT_VERSION = MOQ_ALPN_DRAFT19_VERSION;

// Identifies our implementation in the MOQT_IMPLEMENTATION setup option.
export const MOQ_IMPLEMENTATION_NAME = 'moq-encoder-player';

export const MOQ_USE_LITTLE_ENDIAN = false; // MoQ is big endian

// Setup Options (draft-19 §15.4) — separate namespace from Message Parameters.
export const MOQ_SETUP_OPTION_PATH = 0x1;
export const MOQ_SETUP_OPTION_AUTHORIZATION_TOKEN = 0x3;
export const MOQ_SETUP_OPTION_MAX_AUTH_TOKEN_CACHE_SIZE = 0x4;
export const MOQ_SETUP_OPTION_AUTHORITY = 0x5;
export const MOQ_SETUP_OPTION_MAX_FILTER_RANGES = 0x6; // draft-19 (#1765); default 0
export const MOQ_SETUP_OPTION_MOQT_IMPLEMENTATION = 0x7;
export const MOQ_SETUP_OPTION_MAX_REQUEST_UPDATES = 0x8; // draft-19 (#1613); default 0

// Message Parameters (draft-19 §15.7).
export const MOQ_PARAMETER_OBJECT_DELIVERY_TIMEOUT = 0x02;
export const MOQ_PARAMETER_AUTHORIZATION_TOKEN = 0x03;
export const MOQ_PARAMETER_RENDEZVOUS_TIMEOUT = 0x04;
export const MOQ_PARAMETER_SUBGROUP_DELIVERY_TIMEOUT = 0x06;
export const MOQ_PARAMETER_EXPIRES = 0x08;
export const MOQ_PARAMETER_LARGEST_OBJECT = 0x09;
export const MOQ_PARAMETER_FILL_TIMEOUT = 0x0a;
export const MOQ_PARAMETER_FORWARD = 0x10;
export const MOQ_PARAMETER_SUBSCRIBER_PRIORITY = 0x20;
// draft-19 renamed SUBSCRIPTION_FILTER -> LOCATION_FILTER (code 0x21 unchanged, #1765).
export const MOQ_PARAMETER_LOCATION_FILTER = 0x21;
export const MOQ_PARAMETER_GROUP_ORDER = 0x22;
export const MOQ_PARAMETER_NEW_GROUP_REQUEST = 0x32;
export const MOQ_PARAMETER_TRACK_NAMESPACE_PREFIX = 0x34;

export const MOQ_MAX_PARAMS = 256;
export const MOQ_MAX_ARRAY_LENGTH = 1024;
export const MOQ_MAX_TUPLE_PARAMS = 32;

// REQUEST_ERROR codes (draft-19 §15.10.2) — subset used by this app.
export const MOQ_REQUEST_ERROR_INTERNAL = 0x0;
export const MOQ_REQUEST_ERROR_UNAUTHORIZED = 0x1;
export const MOQ_REQUEST_ERROR_TIMEOUT = 0x2;
export const MOQ_REQUEST_ERROR_NOT_SUPPORTED = 0x3;
export const MOQ_REQUEST_ERROR_GOING_AWAY = 0x6;
export const MOQ_REQUEST_ERROR_EXCESSIVE_LOAD = 0x9;
export const MOQ_REQUEST_ERROR_DOES_NOT_EXIST = 0x10;
export const MOQ_REQUEST_ERROR_INVALID_RANGE = 0x11;
export const MOQ_REQUEST_ERROR_MALFORMED_TRACK = 0x12;
export const MOQ_REQUEST_ERROR_REDIRECT = 0x34;
// draft-19 additions (#1765): filter-related request errors. DUPLICATE_SUBSCRIPTION
// (0x19 in draft-18) was removed — multiple subscriptions per track are now allowed.
export const MOQ_REQUEST_ERROR_CONFLICTING_FILTERS = 0x35;
export const MOQ_REQUEST_ERROR_INVALID_FILTER = 0x36;
// Back-compat alias used by the session layer when rejecting a SUBSCRIBE.
export const MOQ_SUBSCRIPTION_ERROR_INTERNAL = MOQ_REQUEST_ERROR_INTERNAL;

// Session-level termination code added in draft-19 (#1613).
export const MOQ_SESSION_ERROR_TOO_MANY_REQUEST_UPDATES = 0x1b;

// Location Filter types (draft-19 §5.1.2; renamed from "Subscription Filter",
// same codes). Range Filters (0x25-0x29) are out of scope for this client.
export const MOQ_FILTER_TYPE_NEXT_GROUP_START = 0x1;
export const MOQ_FILTER_TYPE_LARGEST_OBJECT = 0x2;
export const MOQ_FILTER_TYPE_ABSOLUTE_START = 0x3;
export const MOQ_FILTER_TYPE_ABSOLUTE_RANGE = 0x4;

// Object datagram type bits (draft-19 §11.3.1). Form 0b00X0XXXX.
const MOQ_DATAGRAM_BIT_PROPERTIES = 0x01;
const MOQ_DATAGRAM_BIT_END_OF_GROUP = 0x02;
const MOQ_DATAGRAM_BIT_ZERO_OBJECT_ID = 0x04;
const MOQ_DATAGRAM_BIT_DEFAULT_PRIORITY = 0x08;
const MOQ_DATAGRAM_BIT_STATUS = 0x20;
const MOQ_DATAGRAM_ALLOWED_BITS = 0x2f; // bits that may be set; 0x10 must be clear

// Subgroup header type bits (draft-19 §11.4.2). Form 0b0XX1XXXX (bit 0x10 set).
const MOQ_SUBGROUP_BIT_PROPERTIES = 0x01;
const MOQ_SUBGROUP_SUBGROUP_ID_MODE_MASK = 0x06; // bits 1-2
const MOQ_SUBGROUP_BIT_REQUIRED = 0x10;
const MOQ_SUBGROUP_BIT_END_OF_GROUP = 0x08;
const MOQ_SUBGROUP_BIT_DEFAULT_PRIORITY = 0x20;
const MOQ_SUBGROUP_BIT_FIRST_OBJECT = 0x40;
const MOQ_SUBGROUP_ID_MODE_ABSENT_FIRST_OBJ = 1;
const MOQ_SUBGROUP_ID_MODE_PRESENT = 2;

// MOQ Messages (draft-19 §10 Table 5).
export const MOQ_MESSAGE_SETUP = 0x2f00; // doubles as the control uni-stream type
export const MOQ_MESSAGE_GOAWAY = 0x10;
export const MOQ_MESSAGE_REQUEST_UPDATE = 0x2;
export const MOQ_MESSAGE_SUBSCRIBE = 0x3;
export const MOQ_MESSAGE_SUBSCRIBE_OK = 0x4;
export const MOQ_MESSAGE_REQUEST_ERROR = 0x5;
export const MOQ_MESSAGE_PUBLISH_NAMESPACE = 0x6;
export const MOQ_MESSAGE_REQUEST_OK = 0x7;
export const MOQ_MESSAGE_NAMESPACE = 0x8;
export const MOQ_MESSAGE_PUBLISH_DONE = 0xb;
export const MOQ_MESSAGE_TRACK_STATUS = 0xd;
export const MOQ_MESSAGE_NAMESPACE_DONE = 0xe;
// draft-19 renamed PUBLISH_BLOCKED -> PUBLISH_SKIPPED (code 0xf unchanged, #1779).
export const MOQ_MESSAGE_PUBLISH_SKIPPED = 0xf;
export const MOQ_MESSAGE_FETCH = 0x16;
export const MOQ_MESSAGE_FETCH_OK = 0x18;
export const MOQ_MESSAGE_PUBLISH = 0x1d;
export const MOQ_MESSAGE_SUBSCRIBE_NAMESPACE = 0x50;
export const MOQ_MESSAGE_SUBSCRIBE_TRACKS = 0x51;

// Unidirectional / datagram stream types (draft-19 §3.4).
export const MOQ_STREAM_TYPE_FETCH_HEADER = 0x05;
export const MOQ_STREAM_TYPE_SETUP = 0x2f00;
export const MOQ_STREAM_TYPE_PADDING = 0x132b3e28;
export const MOQ_DATAGRAM_TYPE_PADDING = 0x132b3e29;

// MOQ PRIORITIES
export const MOQ_PUBLISHER_PRIORITY_BASE_DEFAULT = 0xa;

// MOQ - QUIC mapping
export const MOQ_MAPPING_OBJECT_PER_DATAGRAM = 'ObjPerDatagram';
export const MOQ_MAPPING_SUBGROUP_PER_GROUP = 'SubGroupPerObj';

export const MOQ_USECASE_SUBSCRIBER_PRIORITY_DEFAULT = 0x1; // Lower values are hi-pri (highest = 0)

// Group order
export const MOQ_GROUP_ORDER_FOLLOW_PUBLISHER = 0x0;
export const MOQ_GROUP_ORDER_ASCENDING = 0x1;
export const MOQ_GROUP_ORDER_DESCENDING = 0x2;

// Forward
export const MOQ_FORWARD_FALSE = 0;
export const MOQ_FORWARD_TRUE = 1;

// Object status (draft-19 §11.2.1.1). NOT_EXISTS (0x1) and END_OF_SUBGROUP (0x5)
// were removed in the draft-15..18 cleanup.
export const MOQ_OBJ_STATUS_NORMAL = 0x0;
export const MOQ_OBJ_STATUS_END_OF_GROUP = 0x3;
export const MOQ_OBJ_STATUS_END_OF_TRACK_AND_GROUP = 0x4;

// Object Properties (draft-19 §15.8). Renamed from "Extension Headers"; the
// MoQMI media-interop types keep their values and ride the delta-encoded KVPs.
export const MOQ_EXT_HEADER_TYPE_MOQMI_MEDIA_TYPE = 0x0a;
export const MOQ_EXT_HEADER_TYPE_MOQMI_VIDEO_H264_IN_AVCC_METADATA = 0x15;
export const MOQ_EXT_HEADER_TYPE_MOQMI_VIDEO_H264_IN_AVCC_EXTRADATA = 0x0d;
export const MOQ_EXT_HEADER_TYPE_MOQMI_AUDIO_OPUS_METADATA = 0x0f;
export const MOQ_EXT_HEADER_TYPE_MOQMI_TEXT_UTF8_METADATA = 0x11;
export const MOQ_EXT_HEADER_TYPE_MOQMI_AUDIO_AACLC_MPEG4_METADATA = 0x13;

export const MOQ_EXT_HEADERS_SUPPORTED = [
  MOQ_EXT_HEADER_TYPE_MOQMI_MEDIA_TYPE,
  MOQ_EXT_HEADER_TYPE_MOQMI_VIDEO_H264_IN_AVCC_METADATA,
  MOQ_EXT_HEADER_TYPE_MOQMI_VIDEO_H264_IN_AVCC_EXTRADATA,
  MOQ_EXT_HEADER_TYPE_MOQMI_AUDIO_OPUS_METADATA,
  MOQ_EXT_HEADER_TYPE_MOQMI_TEXT_UTF8_METADATA,
  MOQ_EXT_HEADER_TYPE_MOQMI_AUDIO_AACLC_MPEG4_METADATA,
];

// Authorization Token Alias Type (draft-19 §15.5)
export const MOQ_TOKEN_DELETE = 0x0;
export const MOQ_TOKEN_REGISTER = 0x1;
export const MOQ_TOKEN_USE_ALIAS = 0x2;
export const MOQ_TOKEN_USE_VALUE = 0x3;

// Token type
export const MOQ_TOKEN_TYPE_NEGOTIATED_OUT_OF_BAND = 0x0;

// PUBLISH_DONE status codes (draft-19 §15.10.3)
export const MOQ_STATUS_INTERNAL_ERROR = 0x0;
export const MOQ_STATUS_UNAUTHORIZED = 0x1;
export const MOQ_STATUS_TRACK_ENDED = 0x2;
export const MOQ_STATUS_SUBSCRIPTION_ENDED = 0x3;
export const MOQ_STATUS_GOING_AWAY = 0x4;
export const MOQ_STATUS_TOO_FAR_BEHIND = 0x5;
export const MOQ_STATUS_EXPIRED = 0x6;

// Protocol value types

export interface Token {
  aliasType: number;
  tokenType: number;
  value: Uint8Array;
}

export interface Location {
  group: number;
  obj: number;
}

export type KvPairValue = number | string | Uint8Array | ArrayBuffer | Token | Location;

export interface KvPair<T extends KvPairValue = KvPairValue> {
  name: number;
  val: T;
}

export interface RangeEnd {
  group: number;
}

export interface Filter {
  type: number;
  start?: Location;
  end?: RangeEnd;
}

export interface DatagramTypeOptions {
  isStatus: boolean;
  extensionsPresent: boolean; // Object Properties present
  isEndOfGroup: boolean;
  isObjIdPresent: boolean;
  isDefaultPriority: boolean;
}

export interface StreamHeaderOptions {
  extensionsPresent: boolean; // Object Properties present
  isEndOfGroup: boolean;
  subGroupIdPresent: boolean;
  isSubgroupIdFirstObjectId: boolean;
  isDefaultPriority: boolean;
  isFirstObject: boolean;
}

// Parsed control messages (draft-19)

export interface ParsedSetup {
  options: KvPair[];
}

export interface ParsedSubscribe {
  requestId: number;
  namespace: string[];
  trackName: string;
  parameters: KvPair[];
}

export interface ParsedSubscribeOk {
  trackAlias: number;
  last?: Location;
  parameters: KvPair[];
  properties: KvPair[];
}

export interface ParsedPublish {
  requestId: number;
  namespace: string[];
  trackName: string;
  trackAlias: number;
  parameters: KvPair[];
  properties: KvPair[];
}

export interface ParsedPublishDone {
  statusCode: number;
  streamCount: number;
  errorReason: string;
}

export interface ParsedRequestOk {
  parameters: KvPair[];
  properties: KvPair[];
}

export interface ParsedRequestError {
  errorCode: number;
  retryInterval: number;
  errorReason: string;
}

export interface ParsedUnknown {
  raw: Uint8Array;
}

export type MoqMessageData =
  | ParsedSetup
  | ParsedSubscribe
  | ParsedSubscribeOk
  | ParsedPublish
  | ParsedPublishDone
  | ParsedRequestOk
  | ParsedRequestError
  | ParsedRequestUpdate
  | ParsedUnknown;

export interface MoqMessage {
  type: number;
  // `data` is one of the Parsed* shapes above, discriminated at runtime by
  // `type`. Typed `any` because callers select fields based on `type`.
  data: any;
}

export interface ObjectHeader {
  type: number;
  options: DatagramTypeOptions | StreamHeaderOptions;
  trackAlias: number;
  groupSeq: number;
  publisherPriority: number;
  objSeq?: number;
  extensionHeaders?: KvPair[];
  subGroupSeq?: number;
}

export interface SubgroupObject {
  objSeq: number;
  payloadLength: number;
  extensionHeaders: KvPair[];
  status?: number;
}

export interface MoqtState {
  // Kept loose: callers invoke `wt.createUnidirectionalStream(...)` etc.
  wt: any;
  // draft-19 uses a pair of unidirectional control streams. We open one to send
  // (controlWriter); the peer's incoming control stream is discovered by the
  // session layer and stored in controlReader.
  controlWriter: WritableStream<Uint8Array> | null;
  controlReader: ReadableStream<Uint8Array> | null;
  multiObjectWritter: Record<string, WritableStreamDefaultWriter<Uint8Array>>;
  datagramsReader: ReadableStreamDefaultReader<Uint8Array> | null;
}

export function moqCreate(): MoqtState {
  return {
    wt: null,
    controlWriter: null,
    controlReader: null,
    multiObjectWritter: {},
    datagramsReader: null,
  };
}

export async function moqCloseWrttingStreams(moqt: MoqtState): Promise<void> {
  const multiWritterClosePromises: Promise<void>[] = [];
  for (const multiWritter of Object.values(moqt.multiObjectWritter)) {
    multiWritterClosePromises.push(multiWritter.close());
  }
  if (multiWritterClosePromises.length > 0) {
    await Promise.all(multiWritterClosePromises);
  }
  moqt.multiObjectWritter = {};
}

export async function moqClose(moqt: MoqtState): Promise<void> {
  await moqCloseWrttingStreams(moqt);

  if (moqt.datagramsReader != null) {
    await moqt.datagramsReader.cancel('Closing!');
  }

  if (moqt.controlWriter != null) {
    if (!moqt.controlWriter.locked) {
      await moqt.controlWriter.close();
    }
    moqt.controlWriter = null;
  }
  if (moqt.controlReader != null) {
    if (!moqt.controlReader.locked) {
      await moqt.controlReader.cancel('Closing!');
    }
    moqt.controlReader = null;
  }
  if (moqt.wt != null) {
    // Race condition, relay closing too
    await moqt.wt.close();
  }
  moqt.wt = null;
  moqt.controlWriter = null;
  moqt.controlReader = null;
  moqt.datagramsReader = null;
}

// MOQ control stream — draft-19 opens a unidirectional stream that begins with
// the SETUP message (stream type 0x2F00 == SETUP message type).
export async function moqCreateControlStream(moqt: MoqtState): Promise<void> {
  if (moqt.wt === null) {
    throw new Error('WT session is NULL when we tried to create MOQ');
  }
  if (moqt.controlWriter != null) {
    throw new Error('controlWriter is NOT null, dirty state from a previous session');
  }
  // createUnidirectionalStream() resolves to the WritableStream send side.
  moqt.controlWriter = await moqt.wt.createUnidirectionalStream();
}

// ---- buffer cursor used to parse length-bounded control messages -----------

class BufReader {
  private bytes: Uint8Array;
  off = 0;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }
  remaining(): number {
    return this.bytes.byteLength - this.off;
  }
  readVarint(): number {
    const r = varIntToNumbeFromBuffer(
      this.bytes.buffer as ArrayBuffer,
      this.bytes.byteOffset + this.off,
    );
    this.off += r.byteLength;
    return r.num as number;
  }
  readU8(): number {
    return this.bytes[this.off++];
  }
  readU16(): number {
    const v = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.off, 2).getUint16(
      0,
      MOQ_USE_LITTLE_ENDIAN,
    );
    this.off += 2;
    return v;
  }
  readBytes(n: number): Uint8Array {
    const b = this.bytes.subarray(this.off, this.off + n);
    this.off += n;
    return b;
  }
  readString(): string {
    const n = this.readVarint();
    return new TextDecoder().decode(this.readBytes(n));
  }
  readNamespace(): string[] {
    const n = this.readVarint();
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      out.push(this.readString());
    }
    return out;
  }
  readLocation(): Location {
    return { group: this.readVarint(), obj: this.readVarint() };
  }
}

// ---- SETUP ------------------------------------------------------------------

function moqCreateSetupMessageBytes(): Uint8Array {
  const options = moqCreateKvpDeltaBytes([
    moqCreateKvPair(MOQ_SETUP_OPTION_MOQT_IMPLEMENTATION, MOQ_IMPLEMENTATION_NAME),
  ]);
  return concatBuffer([
    numberToVarInt(MOQ_MESSAGE_SETUP),
    numberTo2BytesArray(options.byteLength, MOQ_USE_LITTLE_ENDIAN),
    options,
  ]);
}

export async function moqSendSetup(writerStream: WritableStream<Uint8Array>): Promise<void> {
  return moqSendToStream(writerStream, moqCreateSetupMessageBytes());
}

function moqParseSetup(r: BufReader): ParsedSetup {
  return { options: moqReadKvpDelta(r, r.remaining()) };
}

// ---- PUBLISH ----------------------------------------------------------------

export async function moqSendPublish(
  writerStream: WritableStream<Uint8Array>,
  reqId: number,
  namespace: string[],
  name: string,
  trackAlias: number,
  authInfo: string | number | undefined,
  forward?: number,
): Promise<void> {
  return moqSendToStream(
    writerStream,
    moqCreatePublishMessageBytes(reqId, namespace, name, trackAlias, authInfo, forward),
  );
}

function moqCreatePublishMessageBytes(
  reqId: number,
  namespace: string[],
  name: string,
  trackAlias: number,
  authInfo: string | number | undefined,
  forward: number | undefined,
): Uint8Array {
  const params: KvPair[] = [];
  // FORWARD defaults to 1 when omitted; only send it to suppress forwarding.
  if (forward === MOQ_FORWARD_FALSE) {
    params.push(moqCreateKvPair(MOQ_PARAMETER_FORWARD, MOQ_FORWARD_FALSE));
  }
  if (authInfo != undefined && authInfo != '') {
    params.push(
      moqCreateKvPair(
        MOQ_PARAMETER_AUTHORIZATION_TOKEN,
        moqCreateUseValueTokenFromString(authInfo as string),
      ),
    );
  }

  const msg: Uint8Array[] = [
    numberToVarInt(reqId),
    moqCreateTupleBytes(namespace),
    moqCreateStringBytes(name),
    numberToVarInt(trackAlias),
    moqCreateMessageParametersBytes(params),
    // Track Properties (empty)
  ];

  return frameControlMessage(MOQ_MESSAGE_PUBLISH, msg);
}

function moqParsePublish(r: BufReader): ParsedPublish {
  const requestId = r.readVarint();
  const namespace = r.readNamespace();
  const trackName = r.readString();
  const trackAlias = r.readVarint();
  const parameters = moqReadMessageParameters(r);
  const properties = moqReadKvpDelta(r, r.remaining());
  return { requestId, namespace, trackName, trackAlias, parameters, properties };
}

// ---- PUBLISH_NAMESPACE ------------------------------------------------------

export async function moqSendPublishNamespace(
  writerStream: WritableStream<Uint8Array>,
  reqId: number,
  namespace: string[],
  authInfo: string | number | undefined,
): Promise<void> {
  const params: KvPair[] = [];
  if (authInfo != undefined && authInfo != '') {
    params.push(
      moqCreateKvPair(
        MOQ_PARAMETER_AUTHORIZATION_TOKEN,
        moqCreateUseValueTokenFromString(authInfo as string),
      ),
    );
  }
  const msg: Uint8Array[] = [
    numberToVarInt(reqId),
    moqCreateTupleBytes(namespace),
    moqCreateMessageParametersBytes(params),
  ];
  return moqSendToStream(writerStream, frameControlMessage(MOQ_MESSAGE_PUBLISH_NAMESPACE, msg));
}

// ---- PUBLISH_DONE -----------------------------------------------------------

export async function moqSendPublishDone(
  writerStream: WritableStream<Uint8Array>,
  statusCode: number,
  streamCount: number,
  reason: string,
): Promise<void> {
  const msg: Uint8Array[] = [
    numberToVarInt(statusCode),
    numberToVarInt(streamCount),
    moqCreateStringBytes(reason),
  ];
  return moqSendToStream(writerStream, frameControlMessage(MOQ_MESSAGE_PUBLISH_DONE, msg));
}

function moqParsePublishDone(r: BufReader): ParsedPublishDone {
  return {
    statusCode: r.readVarint(),
    streamCount: r.readVarint(),
    errorReason: r.readString(),
  };
}

// ---- SUBSCRIBE --------------------------------------------------------------

export async function moqSendSubscribe(
  writerStream: WritableStream<Uint8Array>,
  requestId: number,
  trackNamespace: string[],
  trackName: string,
  authInfo: string | number | undefined,
): Promise<void> {
  return moqSendToStream(
    writerStream,
    moqCreateSubscribeMessageBytes(requestId, trackNamespace, trackName, authInfo),
  );
}

function moqCreateSubscribeMessageBytes(
  requestId: number,
  trackNamespace: string[],
  trackName: string,
  authInfo: string | number | undefined,
): Uint8Array {
  const params: KvPair[] = [];
  // Request the live edge with a Largest Object subscription filter.
  params.push(
    moqCreateKvPair(MOQ_PARAMETER_LOCATION_FILTER, numberToVarInt(MOQ_FILTER_TYPE_LARGEST_OBJECT)),
  );
  if (authInfo != undefined && authInfo != '') {
    params.push(
      moqCreateKvPair(
        MOQ_PARAMETER_AUTHORIZATION_TOKEN,
        moqCreateUseValueTokenFromString(authInfo as string),
      ),
    );
  }

  const msg: Uint8Array[] = [
    numberToVarInt(requestId),
    moqCreateTupleBytes(trackNamespace),
    moqCreateStringBytes(trackName),
    moqCreateMessageParametersBytes(params),
  ];

  return frameControlMessage(MOQ_MESSAGE_SUBSCRIBE, msg);
}

function moqParseSubscribe(r: BufReader): ParsedSubscribe {
  const requestId = r.readVarint();
  const namespace = r.readNamespace();
  const trackName = r.readString();
  const parameters = moqReadMessageParameters(r);
  return { requestId, namespace, trackName, parameters };
}

// ---- SUBSCRIBE_OK -----------------------------------------------------------

export async function moqSendSubscribeOk(
  writerStream: WritableStream<Uint8Array>,
  trackAlias: number,
  lastGroupSent?: number,
  lastObjSent?: number,
): Promise<void> {
  return moqSendToStream(
    writerStream,
    moqCreateSubscribeOkMessageBytes(trackAlias, lastGroupSent, lastObjSent),
  );
}

function moqCreateSubscribeOkMessageBytes(
  trackAlias: number,
  lastGroupSent?: number,
  lastObjSent?: number,
): Uint8Array {
  const params: KvPair[] = [];
  if (lastGroupSent != undefined && lastObjSent != undefined) {
    params.push(
      moqCreateKvPair(MOQ_PARAMETER_LARGEST_OBJECT, { group: lastGroupSent, obj: lastObjSent }),
    );
  }
  const msg: Uint8Array[] = [
    numberToVarInt(trackAlias),
    moqCreateMessageParametersBytes(params),
    // Track Properties (empty)
  ];
  return frameControlMessage(MOQ_MESSAGE_SUBSCRIBE_OK, msg);
}

function moqParseSubscribeOk(r: BufReader): ParsedSubscribeOk {
  const trackAlias = r.readVarint();
  const parameters = moqReadMessageParameters(r);
  const properties = moqReadKvpDelta(r, r.remaining());
  const ret: ParsedSubscribeOk = { trackAlias, parameters, properties };
  const largest = parameters.find((p) => p.name === MOQ_PARAMETER_LARGEST_OBJECT);
  if (largest !== undefined) {
    ret.last = largest.val as Location;
  }
  return ret;
}

// ---- REQUEST_OK / REQUEST_ERROR --------------------------------------------

export async function moqSendRequestOk(writerStream: WritableStream<Uint8Array>): Promise<void> {
  const msg: Uint8Array[] = [
    moqCreateMessageParametersBytes([]),
    // Track Properties (empty)
  ];
  return moqSendToStream(writerStream, frameControlMessage(MOQ_MESSAGE_REQUEST_OK, msg));
}

function moqParseRequestOk(r: BufReader): ParsedRequestOk {
  const parameters = moqReadMessageParameters(r);
  const properties = moqReadKvpDelta(r, r.remaining());
  return { parameters, properties };
}

export async function moqSendRequestError(
  writerStream: WritableStream<Uint8Array>,
  errorCode: number,
  reason: string,
): Promise<void> {
  const msg: Uint8Array[] = [
    numberToVarInt(errorCode),
    numberToVarInt(0), // Retry Interval: 0 => do not retry
    moqCreateStringBytes(reason),
  ];
  return moqSendToStream(writerStream, frameControlMessage(MOQ_MESSAGE_REQUEST_ERROR, msg));
}

function moqParseRequestError(r: BufReader): ParsedRequestError {
  const errorCode = r.readVarint();
  const retryInterval = r.readVarint();
  const errorReason = r.readString();
  // A Redirect structure may follow when errorCode === REDIRECT; ignored here.
  return { errorCode, retryInterval, errorReason };
}

// ---- REQUEST_UPDATE ---------------------------------------------------------

export interface ParsedRequestUpdate {
  requestId: number;
  parameters: KvPair[];
}

export async function moqSendRequestUpdate(
  writerStream: WritableStream<Uint8Array>,
  requestId: number,
  params: KvPair[] = [],
): Promise<void> {
  const msg: Uint8Array[] = [numberToVarInt(requestId), moqCreateMessageParametersBytes(params)];
  return moqSendToStream(writerStream, frameControlMessage(MOQ_MESSAGE_REQUEST_UPDATE, msg));
}

function moqParseRequestUpdate(r: BufReader): ParsedRequestUpdate {
  return { requestId: r.readVarint(), parameters: moqReadMessageParameters(r) };
}

// ---- UNKNOWN ----------------------------------------------------------------

function moqParseUnknown(r: BufReader): ParsedUnknown {
  return { raw: r.readBytes(r.remaining()) };
}

// ---- control message dispatch ----------------------------------------------

// Read a leading variable-length type (stream type or control message type).
export function moqReadVarintType(readerStream: ReadableStream<Uint8Array>): Promise<number> {
  return varIntToNumberOrThrow(readerStream);
}

export async function moqParseMsg(readerStream: ReadableStream<Uint8Array>): Promise<MoqMessage> {
  const msgType = await moqReadVarintType(readerStream);
  return moqParseControlMessageWithType(readerStream, msgType);
}

// Parse a control/request message whose leading type varint was already read.
export async function moqParseControlMessageWithType(
  readerStream: ReadableStream<Uint8Array>,
  msgType: number,
): Promise<MoqMessage> {
  const len = await moqIntReadBytesOrThrow(readerStream, 2);
  const payload = len > 0 ? await buffReadOrThrow(readerStream, len) : new Uint8Array(0);
  const r = new BufReader(payload);

  let data: MoqMessageData;
  switch (msgType) {
    case MOQ_MESSAGE_SETUP:
      data = moqParseSetup(r);
      break;
    case MOQ_MESSAGE_SUBSCRIBE:
      data = moqParseSubscribe(r);
      break;
    case MOQ_MESSAGE_SUBSCRIBE_OK:
      data = moqParseSubscribeOk(r);
      break;
    case MOQ_MESSAGE_PUBLISH:
      data = moqParsePublish(r);
      break;
    case MOQ_MESSAGE_PUBLISH_DONE:
      data = moqParsePublishDone(r);
      break;
    case MOQ_MESSAGE_REQUEST_OK:
      data = moqParseRequestOk(r);
      break;
    case MOQ_MESSAGE_REQUEST_ERROR:
      data = moqParseRequestError(r);
      break;
    case MOQ_MESSAGE_REQUEST_UPDATE:
      data = moqParseRequestUpdate(r);
      break;
    default:
      data = moqParseUnknown(r);
  }
  return { type: msgType, data };
}

// ---- OBJECT framing ---------------------------------------------------------

function moqCreateSubgroupHeaderBytes(
  trackAlias: number,
  groupSeq: number,
  publisherPriority: number,
): Uint8Array {
  // Properties present (MoQMI always carries them), subgroup id present, first
  // object of the subgroup (we are the original publisher), explicit priority.
  const type = getSubgroupHeaderType({
    propertiesPresent: true,
    subGroupIdPresent: true,
    isFirstObject: true,
  });
  return concatBuffer([
    numberToVarInt(type),
    numberToVarInt(trackAlias),
    numberToVarInt(groupSeq),
    numberToVarInt(groupSeq), // Subgroup ID
    numberToSingleByteArray(publisherPriority),
  ]);
}

function moqCreateObjectEndOfGroupBytes(
  objSeqDelta: number,
  extensionHeaders: KvPair[],
): Uint8Array {
  return concatBuffer([
    numberToVarInt(objSeqDelta), // Object ID delta
    moqCreatePropertiesBytes(extensionHeaders), // length-prefixed (0 when empty)
    numberToVarInt(0), // Object payload length
    numberToVarInt(MOQ_OBJ_STATUS_END_OF_GROUP),
  ]);
}

function moqCreateObjectSubgroupBytes(
  objSeqDelta: number,
  data: BufferSource | undefined,
  extensionHeaders: KvPair[],
): Uint8Array {
  const msg: Array<Uint8Array | BufferSource> = [];
  msg.push(numberToVarInt(objSeqDelta));
  msg.push(moqCreatePropertiesBytes(extensionHeaders)); // header has PROPERTIES bit set
  if (data != undefined && data.byteLength > 0) {
    msg.push(numberToVarInt(data.byteLength));
    msg.push(data);
  } else {
    msg.push(numberToVarInt(0));
    msg.push(numberToVarInt(MOQ_OBJ_STATUS_NORMAL));
  }
  return concatBuffer(msg);
}

function moqCreateObjectPerDatagramBytes(
  trackAlias: number,
  groupSeq: number,
  objSeq: number,
  publisherPriority: number,
  data: BufferSource | undefined,
  extensionHeaders: KvPair[],
  isEndOfGroup: boolean,
): Uint8Array {
  const msg: Array<Uint8Array | BufferSource> = [];
  const hasHeaders = extensionHeaders != undefined && extensionHeaders.length > 0;
  const hasData = data != undefined && data.byteLength > 0;

  const type = getDatagramType({
    isStatus: !hasData,
    propertiesPresent: hasHeaders,
    isEndOfGroup,
  });

  msg.push(numberToVarInt(type));
  msg.push(numberToVarInt(trackAlias));
  msg.push(numberToVarInt(groupSeq));
  msg.push(numberToVarInt(objSeq));
  msg.push(numberToSingleByteArray(publisherPriority));
  if (hasHeaders) {
    msg.push(moqCreatePropertiesBytes(extensionHeaders));
  }
  if (hasData) {
    msg.push(data);
  } else {
    msg.push(numberToVarInt(MOQ_OBJ_STATUS_NORMAL));
  }
  return concatBuffer(msg);
}

export function moqSendSubgroupHeader(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  trackAlias: number,
  groupSeq: number,
  publisherPriority: number,
): Promise<void> {
  return moqSendToWriter(
    writer,
    moqCreateSubgroupHeaderBytes(trackAlias, groupSeq, publisherPriority),
  );
}

export function moqSendObjectSubgroupToWriter(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  objSeqDelta: number,
  data: BufferSource | undefined,
  extensionHeaders: KvPair[],
): Promise<void> {
  return moqSendToWriter(writer, moqCreateObjectSubgroupBytes(objSeqDelta, data, extensionHeaders));
}

export function moqSendObjectEndOfGroupToWriter(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  objSeqDelta: number,
  extensionHeaders: KvPair[],
  closeStream?: boolean,
): Promise<void> {
  return moqSendToWriter(
    writer,
    moqCreateObjectEndOfGroupBytes(objSeqDelta, extensionHeaders),
    closeStream,
  );
}

export function moqSendObjectPerDatagramToWriter(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  trackAlias: number,
  groupSeq: number,
  objSeq: number,
  publisherPriority: number,
  data: BufferSource | undefined,
  extensionHeaders: KvPair[],
  isEndOfGroup: boolean,
): Promise<void> {
  return moqSendToWriter(
    writer,
    moqCreateObjectPerDatagramBytes(
      trackAlias,
      groupSeq,
      objSeq,
      publisherPriority,
      data,
      extensionHeaders,
      isEndOfGroup,
    ),
  );
}

export async function moqParseObjectHeader(
  readerStream: ReadableStream<Uint8Array>,
): Promise<ObjectHeader> {
  const type = await varIntToNumberOrThrow(readerStream);
  return moqParseObjectHeaderWithType(readerStream, type);
}

// Parse an object/subgroup header whose leading type varint was already read.
export async function moqParseObjectHeaderWithType(
  readerStream: ReadableStream<Uint8Array>,
  type: number,
): Promise<ObjectHeader> {
  if (!isMoqObjectStreamHeaderType(type) && !isMoqObjectDatagramType(type)) {
    throw new Error(`OBJECT is not any known object type, got ${type}`);
  }

  if (isMoqObjectDatagramType(type)) {
    const ret = { type } as ObjectHeader;
    const options = moqDecodeDatagramType(type);
    ret.options = options;
    ret.trackAlias = await varIntToNumberOrThrow(readerStream);
    ret.groupSeq = await varIntToNumberOrThrow(readerStream);
    ret.objSeq = options.isObjIdPresent ? await varIntToNumberOrThrow(readerStream) : 0;
    ret.publisherPriority = options.isDefaultPriority
      ? MOQ_PUBLISHER_PRIORITY_BASE_DEFAULT
      : await moqIntReadBytesOrThrow(readerStream, 1);
    if (options.extensionsPresent) {
      ret.extensionHeaders = await moqReadProperties(readerStream);
    }
    return ret;
  }

  const ret = { type } as ObjectHeader;
  const options = moqDecodeStreamHeaderType(type);
  ret.options = options;
  ret.trackAlias = await varIntToNumberOrThrow(readerStream);
  ret.groupSeq = await varIntToNumberOrThrow(readerStream);
  if (options.subGroupIdPresent) {
    ret.subGroupSeq = await varIntToNumberOrThrow(readerStream);
  }
  ret.publisherPriority = options.isDefaultPriority
    ? MOQ_PUBLISHER_PRIORITY_BASE_DEFAULT
    : await moqIntReadBytesOrThrow(readerStream, 1);
  return ret;
}

export async function moqParseObjectFromSubgroupHeader(
  readerStream: ReadableStream<Uint8Array>,
  type: number,
): Promise<SubgroupObject> {
  const typeDecoded = moqDecodeStreamHeaderType(type);

  const objSeq = await varIntToNumberOrThrow(readerStream);
  let extensionHeaders: KvPair[] = [];
  if (typeDecoded.extensionsPresent) {
    extensionHeaders = await moqReadProperties(readerStream);
  }
  const payloadLength = await varIntToNumberOrThrow(readerStream);
  const ret: SubgroupObject = { objSeq, payloadLength, extensionHeaders };
  if (payloadLength == 0) {
    ret.status = await varIntToNumberOrThrow(readerStream);
  }
  return ret;
}

// ---- low level helpers ------------------------------------------------------

export function getTrackFullName(namespace: string, trackName: string): string {
  return namespace + trackName;
}

// Frame a control/request message: [type varint][u16 length][body...].
function frameControlMessage(type: number, body: Uint8Array[]): Uint8Array {
  const totalLength = getArrayBufferByteLength(body);
  return concatBuffer([
    numberToVarInt(type),
    numberTo2BytesArray(totalLength, MOQ_USE_LITTLE_ENDIAN),
    ...body,
  ]);
}

function moqCreateStringBytes(str: string): Uint8Array {
  const dataStrBytes = new TextEncoder().encode(str);
  const dataStrLengthBytes = numberToVarInt(dataStrBytes.byteLength);
  return concatBuffer([dataStrLengthBytes, dataStrBytes]);
}

function moqCreateTupleBytes(arr: string[]): Uint8Array {
  const msg: Uint8Array[] = [];
  if (arr.length > MOQ_MAX_TUPLE_PARAMS) {
    throw new Error(`We only support up to ${MOQ_MAX_TUPLE_PARAMS} items in an MOQ tuple`);
  }
  msg.push(numberToVarInt(arr.length));
  for (let i = 0; i < arr.length; i++) {
    msg.push(moqCreateStringBytes(arr[i]));
  }
  return concatBuffer(msg);
}

export function moqCreateKvPair(name: number, val: KvPairValue): KvPair {
  return { name, val };
}

// ---- Message Parameters (draft-19 §10.2) -----------------------------------
//
// Type-delta encoded, count-bounded; each parameter Type has a fixed value
// encoding. Unknown parameter types are a protocol violation (we throw).

const PARAM_ENC_UINT8 = 1;
const PARAM_ENC_VARINT = 2;
const PARAM_ENC_LOCATION = 3;
const PARAM_ENC_LENPREFIXED = 4;

const MESSAGE_PARAM_ENCODING: Record<number, number> = {
  [MOQ_PARAMETER_OBJECT_DELIVERY_TIMEOUT]: PARAM_ENC_VARINT,
  [MOQ_PARAMETER_AUTHORIZATION_TOKEN]: PARAM_ENC_LENPREFIXED,
  [MOQ_PARAMETER_RENDEZVOUS_TIMEOUT]: PARAM_ENC_VARINT,
  [MOQ_PARAMETER_SUBGROUP_DELIVERY_TIMEOUT]: PARAM_ENC_VARINT,
  [MOQ_PARAMETER_EXPIRES]: PARAM_ENC_VARINT,
  [MOQ_PARAMETER_LARGEST_OBJECT]: PARAM_ENC_LOCATION,
  [MOQ_PARAMETER_FILL_TIMEOUT]: PARAM_ENC_VARINT,
  [MOQ_PARAMETER_FORWARD]: PARAM_ENC_UINT8,
  [MOQ_PARAMETER_SUBSCRIBER_PRIORITY]: PARAM_ENC_UINT8,
  [MOQ_PARAMETER_LOCATION_FILTER]: PARAM_ENC_LENPREFIXED,
  [MOQ_PARAMETER_GROUP_ORDER]: PARAM_ENC_UINT8,
  [MOQ_PARAMETER_NEW_GROUP_REQUEST]: PARAM_ENC_VARINT,
  [MOQ_PARAMETER_TRACK_NAMESPACE_PREFIX]: PARAM_ENC_LENPREFIXED,
};

function moqCreateMessageParametersBytes(kvParams: KvPair[]): Uint8Array {
  const sorted = [...kvParams].sort((a, b) => a.name - b.name);
  const parts: Array<Uint8Array | BufferSource> = [numberToVarInt(sorted.length)];
  let prevType = 0;
  for (const p of sorted) {
    parts.push(numberToVarInt(p.name - prevType));
    prevType = p.name;
    parts.push(encodeMessageParamValue(p.name, p.val));
  }
  return concatBuffer(parts);
}

function encodeMessageParamValue(type: number, val: KvPairValue): Uint8Array {
  const enc = MESSAGE_PARAM_ENCODING[type];
  if (enc === PARAM_ENC_UINT8) {
    return numberToSingleByteArray(val as number);
  }
  if (enc === PARAM_ENC_VARINT) {
    return numberToVarInt(val as number);
  }
  if (enc === PARAM_ENC_LOCATION) {
    const loc = val as Location;
    return concatBuffer([numberToVarInt(loc.group), numberToVarInt(loc.obj)]);
  }
  if (enc === PARAM_ENC_LENPREFIXED) {
    let bytes: Uint8Array;
    if (type === MOQ_PARAMETER_AUTHORIZATION_TOKEN) {
      bytes = moqSerializeTokenStruct(val as Token);
    } else if (val instanceof Uint8Array) {
      bytes = val;
    } else if (val instanceof ArrayBuffer) {
      bytes = new Uint8Array(val);
    } else {
      throw new Error(`Message param ${type} expects a byte value`);
    }
    return concatBuffer([numberToVarInt(bytes.byteLength), bytes]);
  }
  throw new Error(`Unknown message parameter type ${type}`);
}

function moqReadMessageParameters(r: BufReader): KvPair[] {
  const count = r.readVarint();
  const out: KvPair[] = [];
  let prevType = 0;
  for (let i = 0; i < count; i++) {
    const type = prevType + r.readVarint();
    prevType = type;
    out.push(moqCreateKvPair(type, decodeMessageParamValue(r, type)));
  }
  return out;
}

function decodeMessageParamValue(r: BufReader, type: number): KvPairValue {
  const enc = MESSAGE_PARAM_ENCODING[type];
  if (enc === PARAM_ENC_UINT8) {
    return r.readU8();
  }
  if (enc === PARAM_ENC_VARINT) {
    return r.readVarint();
  }
  if (enc === PARAM_ENC_LOCATION) {
    return r.readLocation();
  }
  if (enc === PARAM_ENC_LENPREFIXED) {
    const len = r.readVarint();
    const bytes = r.readBytes(len);
    if (type === MOQ_PARAMETER_AUTHORIZATION_TOKEN) {
      return moqParseTokenStruct(bytes);
    }
    return new Uint8Array(bytes); // copy out of the shared buffer view
  }
  throw new Error(`Unknown message parameter type ${type}`);
}

// ---- Key-Value-Pairs (draft-19 §1.4.3) -------------------------------------
//
// Delta-type encoded; Length present only when the (absolute) Type is odd. Used
// for Setup Options, Track Properties and Object Properties.

// Serialize KVPs (no outer length) — used for Setup Options / Track Properties.
function moqCreateKvpDeltaBytes(kvParams: KvPair[]): Uint8Array {
  const sorted = [...kvParams].sort((a, b) => a.name - b.name);
  const parts: Array<Uint8Array | BufferSource> = [];
  let prevType = 0;
  for (const p of sorted) {
    parts.push(numberToVarInt(p.name - prevType));
    prevType = p.name;
    parts.push(encodeKvpValue(p.name, p.val));
  }
  return concatBuffer(parts);
}

function encodeKvpValue(name: number, val: KvPairValue): Uint8Array {
  if (name % 2 === 0) {
    if (typeof val !== 'number') {
      throw new Error('Even KVP type must carry a varint value');
    }
    return numberToVarInt(val);
  }
  // Odd type: length-prefixed bytes (or a UTF-8 string).
  let bytes: Uint8Array;
  if (typeof val === 'string') {
    bytes = new TextEncoder().encode(val);
  } else if (val instanceof Uint8Array) {
    bytes = val;
  } else if (val instanceof ArrayBuffer) {
    bytes = new Uint8Array(val);
  } else {
    throw new Error('Odd KVP type must carry a string or byte value');
  }
  return concatBuffer([numberToVarInt(bytes.byteLength), bytes]);
}

// Object Properties: a length prefix followed by delta-encoded KVPs.
function moqCreatePropertiesBytes(kvParams: KvPair[]): Uint8Array {
  const inner = moqCreateKvpDeltaBytes(kvParams);
  return concatBuffer([numberToVarInt(inner.byteLength), inner]);
}

// Parse delta-encoded KVPs from a buffer cursor up to `byteLen` bytes.
function moqReadKvpDelta(r: BufReader, byteLen: number): KvPair[] {
  const out: KvPair[] = [];
  const end = r.off + byteLen;
  let prevType = 0;
  while (r.off < end) {
    const type = prevType + r.readVarint();
    prevType = type;
    if (type % 2 === 0) {
      out.push(moqCreateKvPair(type, r.readVarint()));
    } else {
      const size = r.readVarint();
      out.push(moqCreateKvPair(type, new Uint8Array(r.readBytes(size))));
    }
  }
  return out;
}

// Parse Object Properties (length-prefixed delta KVPs) from a data stream.
async function moqReadProperties(readerStream: ReadableStream<Uint8Array>): Promise<KvPair[]> {
  const totalLen = await varIntToNumberOrThrow(readerStream);
  if (totalLen <= 0) {
    return [];
  }
  const buf = await buffReadOrThrow(readerStream, totalLen);
  return moqReadKvpDelta(new BufReader(buf), buf.byteLength);
}

async function buffReadOrThrow(
  readerStream: ReadableStream<Uint8Array>,
  size: number,
): Promise<Uint8Array> {
  const ret = await buffRead(readerStream, size);
  if (ret == null) {
    throw new ReadStreamClosed('Connection closed while reading data');
  }
  // buffRead returns the underlying ArrayBuffer in `buff`; wrap it.
  return new Uint8Array(ret.buff as ArrayBuffer);
}

async function moqIntReadBytesOrThrow(
  readerStream: ReadableStream<Uint8Array>,
  length: number,
): Promise<number> {
  if (length > 4 || length < 0 || !Number.isInteger(length))
    throw new Error(`We can NOT read ints of length ${length}, only ints from 1 to 4 bytes`);

  const ret = await buffRead(readerStream, length);
  if (ret.eof) {
    throw new ReadStreamClosed(`Connection closed while reading byte`);
  }
  if (length === 1) return new DataView(ret.buff, 0, length).getUint8(0);
  if (length === 2) return new DataView(ret.buff, 0, length).getUint16(0, MOQ_USE_LITTLE_ENDIAN);
  return new DataView(ret.buff, 0, length).getUint32(0, MOQ_USE_LITTLE_ENDIAN);
}

// ---- Authorization Token ----------------------------------------------------

function moqCreateUseValueTokenFromString(str: string): Token {
  return {
    aliasType: MOQ_TOKEN_USE_VALUE,
    tokenType: MOQ_TOKEN_TYPE_NEGOTIATED_OUT_OF_BAND,
    value: new TextEncoder().encode(str),
  };
}

// Token struct (no outer length; the parameter provides the length).
function moqSerializeTokenStruct(token: Token): Uint8Array {
  if (token.aliasType != MOQ_TOKEN_USE_VALUE) {
    throw new Error('Only USE_VALUE token supported');
  }
  if (token.tokenType != MOQ_TOKEN_TYPE_NEGOTIATED_OUT_OF_BAND) {
    throw new Error('Only TYPE_NEGOTIATED_OUT_OF_BAND token type supported');
  }
  return concatBuffer([
    numberToVarInt(token.aliasType),
    numberToVarInt(token.tokenType),
    token.value,
  ]);
}

function moqParseTokenStruct(bytes: Uint8Array): Token {
  const r = new BufReader(bytes);
  const aliasType = r.readVarint();
  if (aliasType != MOQ_TOKEN_USE_VALUE) {
    throw new Error('Only USE_VALUE token supported');
  }
  const tokenType = r.readVarint();
  if (tokenType != MOQ_TOKEN_TYPE_NEGOTIATED_OUT_OF_BAND) {
    throw new Error('Only TYPE_NEGOTIATED_OUT_OF_BAND token type supported');
  }
  return { aliasType, tokenType, value: new Uint8Array(r.readBytes(r.remaining())) };
}

// ---- stream write helpers ---------------------------------------------------

async function moqSendToStream(
  writerStream: WritableStream<Uint8Array>,
  dataBytes: Uint8Array,
  closeStream?: boolean,
): Promise<void> {
  const writer = writerStream.getWriter();
  await moqSendToWriter(writer, dataBytes, closeStream);
  await writer.ready;
  writer.releaseLock();
}

async function moqSendToWriter(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  dataBytes: Uint8Array,
  closeStream?: boolean,
): Promise<void> {
  return writer.write(dataBytes).then(() => {
    if (closeStream) {
      return writer.close();
    }
    return Promise.resolve();
  });
}

export function getFullTrackName(ns: string[], name: string): string {
  return `[${ns.join('/')}]/${name}`;
}

export function getAuthInfofromParameters(parameters: KvPair[]): string | undefined {
  for (const param of parameters) {
    if (param.name == MOQ_PARAMETER_AUTHORIZATION_TOKEN) {
      const token = param.val as Token;
      if (
        token.aliasType == MOQ_TOKEN_USE_VALUE &&
        token.tokenType == MOQ_TOKEN_TYPE_NEGOTIATED_OUT_OF_BAND
      ) {
        return new TextDecoder().decode(token.value);
      }
    }
  }
  return undefined;
}

// ---- object/datagram type bit-fields ---------------------------------------

export function isMoqObjectDatagramType(type: number): boolean {
  if ((type & ~MOQ_DATAGRAM_ALLOWED_BITS) !== 0) {
    return false;
  }
  // STATUS + END_OF_GROUP together is invalid.
  if ((type & MOQ_DATAGRAM_BIT_STATUS) !== 0 && (type & MOQ_DATAGRAM_BIT_END_OF_GROUP) !== 0) {
    return false;
  }
  return true;
}

export function moqDecodeDatagramType(type: number): DatagramTypeOptions {
  if (!isMoqObjectDatagramType(type)) {
    throw new Error(`No valid datagram type ${type}, it can NOT be decoded`);
  }
  return {
    isStatus: (type & MOQ_DATAGRAM_BIT_STATUS) !== 0,
    extensionsPresent: (type & MOQ_DATAGRAM_BIT_PROPERTIES) !== 0,
    isEndOfGroup: (type & MOQ_DATAGRAM_BIT_END_OF_GROUP) !== 0,
    isObjIdPresent: (type & MOQ_DATAGRAM_BIT_ZERO_OBJECT_ID) === 0,
    isDefaultPriority: (type & MOQ_DATAGRAM_BIT_DEFAULT_PRIORITY) !== 0,
  };
}

function getDatagramType(opts: {
  isStatus: boolean;
  propertiesPresent: boolean;
  isEndOfGroup: boolean;
  objIdPresent?: boolean;
  defaultPriority?: boolean;
}): number {
  let type = 0;
  if (opts.isStatus) type |= MOQ_DATAGRAM_BIT_STATUS;
  if (opts.isEndOfGroup) type |= MOQ_DATAGRAM_BIT_END_OF_GROUP;
  if (opts.objIdPresent === false) type |= MOQ_DATAGRAM_BIT_ZERO_OBJECT_ID;
  if (opts.defaultPriority) type |= MOQ_DATAGRAM_BIT_DEFAULT_PRIORITY;
  if (opts.propertiesPresent) type |= MOQ_DATAGRAM_BIT_PROPERTIES;
  if (!isMoqObjectDatagramType(type)) {
    throw new Error(`Datagram header to create type ${type} does not make sense`);
  }
  return type;
}

export function isMoqObjectStreamHeaderType(type: number): boolean {
  if ((type & MOQ_SUBGROUP_BIT_REQUIRED) === 0) {
    return false; // bit 0x10 must be set
  }
  if ((type & ~0x7f) !== 0) {
    return false; // bit 7 must be clear, form 0b0XX1XXXX
  }
  if ((type & MOQ_SUBGROUP_SUBGROUP_ID_MODE_MASK) >> 1 === 3) {
    return false; // reserved subgroup-id mode
  }
  return true;
}

export function moqDecodeStreamHeaderType(type: number): StreamHeaderOptions {
  if (!isMoqObjectStreamHeaderType(type)) {
    throw new Error(`No valid stream header type ${type}, it can NOT be decoded`);
  }
  const mode = (type & MOQ_SUBGROUP_SUBGROUP_ID_MODE_MASK) >> 1;
  return {
    extensionsPresent: (type & MOQ_SUBGROUP_BIT_PROPERTIES) !== 0,
    isEndOfGroup: (type & MOQ_SUBGROUP_BIT_END_OF_GROUP) !== 0,
    subGroupIdPresent: mode === MOQ_SUBGROUP_ID_MODE_PRESENT,
    isSubgroupIdFirstObjectId: mode === MOQ_SUBGROUP_ID_MODE_ABSENT_FIRST_OBJ,
    isDefaultPriority: (type & MOQ_SUBGROUP_BIT_DEFAULT_PRIORITY) !== 0,
    isFirstObject: (type & MOQ_SUBGROUP_BIT_FIRST_OBJECT) !== 0,
  };
}

function getSubgroupHeaderType(opts: {
  propertiesPresent?: boolean;
  isEndOfGroup?: boolean;
  subGroupIdPresent?: boolean;
  isSubgroupIdFirstObjectId?: boolean;
  isDefaultPriority?: boolean;
  isFirstObject?: boolean;
}): number {
  let type = MOQ_SUBGROUP_BIT_REQUIRED;
  if (opts.subGroupIdPresent) {
    type |= MOQ_SUBGROUP_ID_MODE_PRESENT << 1;
  } else if (opts.isSubgroupIdFirstObjectId) {
    type |= MOQ_SUBGROUP_ID_MODE_ABSENT_FIRST_OBJ << 1;
  }
  if (opts.propertiesPresent) type |= MOQ_SUBGROUP_BIT_PROPERTIES;
  if (opts.isEndOfGroup) type |= MOQ_SUBGROUP_BIT_END_OF_GROUP;
  if (opts.isDefaultPriority) type |= MOQ_SUBGROUP_BIT_DEFAULT_PRIORITY;
  if (opts.isFirstObject) type |= MOQ_SUBGROUP_BIT_FIRST_OBJECT;
  if (!isMoqObjectStreamHeaderType(type)) {
    throw new Error(`Subgroup header to create type ${type} does not make sense`);
  }
  return type;
}
