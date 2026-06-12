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

// MOQ Transport definitions — draft-ietf-moq-transport-16
// https://datatracker.ietf.org/doc/draft-ietf-moq-transport/
//
// Since draft-15 the MOQT version is negotiated by the transport via ALPN (over
// native QUIC) or WT-Available-Protocols (over WebTransport), not in-band in the
// SETUP messages. The "version" is therefore an ALPN token string, offered to
// WebTransport as a connection protocol (see Moq.init in ./moq.ts).
export const MOQ_ALPN_DRAFT16_VERSION = 'moqt-16';

export const MOQ_CURRENT_VERSION = MOQ_ALPN_DRAFT16_VERSION;

export const MOQ_IMPLEMENTATION_NAME = 'moq-encoder-player';

export const MOQ_USE_LITTLE_ENDIAN = false; // MoQ is big endian

// Setup parameters (draft-16 §9.3.1). Same KVP namespace rules as draft-14.
export const MOQ_SETUP_PARAMETER_PATH = 0x1;
export const MOQ_SETUP_PARAMETER_MAX_REQUEST_ID = 0x2;
export const MOQ_SETUP_MAX_AUTH_TOKEN_CACHE_SIZE = 0x4;
export const MOQ_SETUP_PARAMETER_MOQT_IMPLEMENTATION = 0x7;

// Message Parameters (draft-16 §13.2). Serialized as Key-Value-Pairs.
export const MOQ_PARAMETER_DELIVERY_TIMEOUT = 0x02;
export const MOQ_PARAMETER_AUTHORIZATION_TOKEN = 0x03;
export const MOQ_PARAMETER_EXPIRES = 0x08;
export const MOQ_PARAMETER_LARGEST_OBJECT = 0x09;
export const MOQ_PARAMETER_FORWARD = 0x10;
export const MOQ_PARAMETER_SUBSCRIBER_PRIORITY = 0x20;
export const MOQ_PARAMETER_SUBSCRIPTION_FILTER = 0x21;
export const MOQ_PARAMETER_GROUP_ORDER = 0x22;
export const MOQ_PARAMETER_NEW_GROUP_REQUEST = 0x32;
export const MOQ_PARAMETER_MAX_CACHE_DURATION = 0x04;

export const MOQ_MAX_PARAMS = 256;
export const MOQ_MAX_ARRAY_LENGTH = 1024;
export const MOQ_MAX_TUPLE_PARAMS = 32;
export const MOQ_MAX_REQUEST_ID_NUM = 128;

// REQUEST_ERROR codes (draft-16 §13.4.2) — subset used by this app.
export const MOQ_REQUEST_ERROR_INTERNAL = 0x0;
export const MOQ_REQUEST_ERROR_UNAUTHORIZED = 0x1;
export const MOQ_REQUEST_ERROR_NOT_SUPPORTED = 0x3;
export const MOQ_REQUEST_ERROR_DOES_NOT_EXIST = 0x10;
export const MOQ_REQUEST_ERROR_INVALID_RANGE = 0x11;
// Back-compat alias used by the session layer when rejecting a SUBSCRIBE.
export const MOQ_SUBSCRIPTION_ERROR_INTERNAL = MOQ_REQUEST_ERROR_INTERNAL;

// MOQ FILTER TYPES (unchanged)
export const MOQ_FILTER_TYPE_NEXT_GROUP_START = 0x1;
export const MOQ_FILTER_TYPE_LARGEST_OBJECT = 0x2;
export const MOQ_FILTER_TYPE_ABSOLUTE_START = 0x3;
export const MOQ_FILTER_TYPE_ABSOLUTE_RANGE = 0x4;

// Object datagram type bits (draft-16 §10.3.1). Form 0b00X0XXXX.
const MOQ_DATAGRAM_BIT_EXTENSIONS = 0x01;
const MOQ_DATAGRAM_BIT_END_OF_GROUP = 0x02;
const MOQ_DATAGRAM_BIT_ZERO_OBJECT_ID = 0x04;
const MOQ_DATAGRAM_BIT_DEFAULT_PRIORITY = 0x08;
const MOQ_DATAGRAM_BIT_STATUS = 0x20;
const MOQ_DATAGRAM_ALLOWED_BITS = 0x2f; // 0x10 must be clear

// Subgroup header type bits (draft-16 §10.4.2). Form 0b00X1XXXX (bit 0x10 set,
// bits 0x40/0x80 clear — draft-16 has no FIRST_OBJECT bit and no 0x50-0x7F range).
const MOQ_SUBGROUP_BIT_EXTENSIONS = 0x01;
const MOQ_SUBGROUP_SUBGROUP_ID_MODE_MASK = 0x06; // bits 1-2
const MOQ_SUBGROUP_BIT_REQUIRED = 0x10;
const MOQ_SUBGROUP_BIT_END_OF_GROUP = 0x08;
const MOQ_SUBGROUP_BIT_DEFAULT_PRIORITY = 0x20;
const MOQ_SUBGROUP_FORBIDDEN_BITS = 0xc0; // bits 6-7 must be clear
const MOQ_SUBGROUP_ID_MODE_ABSENT_FIRST_OBJ = 1;
const MOQ_SUBGROUP_ID_MODE_PRESENT = 2;

// MOQ Messages (draft-16 §9 Table 1).
export const MOQ_MESSAGE_CLIENT_SETUP = 0x20;
export const MOQ_MESSAGE_SERVER_SETUP = 0x21;
export const MOQ_MESSAGE_GOAWAY = 0x10;
export const MOQ_MESSAGE_MAX_REQUEST_ID = 0x15;
export const MOQ_MESSAGE_REQUESTS_BLOCKED = 0x1a;
export const MOQ_MESSAGE_REQUEST_OK = 0x7;
export const MOQ_MESSAGE_REQUEST_ERROR = 0x5;
export const MOQ_MESSAGE_REQUEST_UPDATE = 0x2;
export const MOQ_MESSAGE_SUBSCRIBE = 0x3;
export const MOQ_MESSAGE_SUBSCRIBE_OK = 0x4;
export const MOQ_MESSAGE_UNSUBSCRIBE = 0xa;
export const MOQ_MESSAGE_PUBLISH = 0x1d;
export const MOQ_MESSAGE_PUBLISH_OK = 0x1e;
export const MOQ_MESSAGE_PUBLISH_DONE = 0xb;
export const MOQ_MESSAGE_FETCH = 0x16;
export const MOQ_MESSAGE_FETCH_OK = 0x18;
export const MOQ_MESSAGE_FETCH_CANCEL = 0x17;
export const MOQ_MESSAGE_TRACK_STATUS = 0xd;
export const MOQ_MESSAGE_PUBLISH_NAMESPACE = 0x6;
export const MOQ_MESSAGE_NAMESPACE = 0x8;
export const MOQ_MESSAGE_PUBLISH_NAMESPACE_DONE = 0x9;
export const MOQ_MESSAGE_NAMESPACE_DONE = 0xe;
export const MOQ_MESSAGE_PUBLISH_NAMESPACE_CANCEL = 0xc;
export const MOQ_MESSAGE_SUBSCRIBE_NAMESPACE = 0x11;

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

// Object status (draft-16 §10.2.1.1). NOT_EXISTS (0x1) and END_OF_SUBGROUP (0x5)
// were removed in the draft-15..16 cleanup.
export const MOQ_OBJ_STATUS_NORMAL = 0x0;
export const MOQ_OBJ_STATUS_END_OF_GROUP = 0x3;
export const MOQ_OBJ_STATUS_END_OF_TRACK_AND_GROUP = 0x4;

// Extension headers (Even types: value is a single varint. Odd types: value is a
// length-prefixed byte buffer). draft-16 delta-encodes the Type (§1.4.2).
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

// Authorization Token Alias Type (draft-16 §13.1)
export const MOQ_TOKEN_DELETE = 0x0;
export const MOQ_TOKEN_REGISTER = 0x1;
export const MOQ_TOKEN_USE_ALIAS = 0x2;
export const MOQ_TOKEN_USE_VALUE = 0x3;

// Token type
export const MOQ_TOKEN_TYPE_NEGOTIATED_OUT_OF_BAND = 0x0;

// PUBLISH_DONE status codes (draft-16 §13.4.3)
export const MOQ_STATUS_INTERNAL_ERROR = 0x0;
export const MOQ_STATUS_UNAUTHORIZED = 0x1;
export const MOQ_STATUS_TRACK_ENDED = 0x2;
export const MOQ_STATUS_SUBSCRIPTION_ENDED = 0x3;
export const MOQ_STATUS_GOING_AWAY = 0x4;
export const MOQ_STATUS_EXPIRED = 0x5;
export const MOQ_STATUS_TOO_FAR_BEHIND = 0x6;

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
  extensionsPresent: boolean;
  isEndOfGroup: boolean;
  isObjIdPresent: boolean;
  isDefaultPriority: boolean;
}

export interface StreamHeaderOptions {
  extensionsPresent: boolean;
  isEndOfGroup: boolean;
  subGroupIdPresent: boolean;
  isSubgroupIdFirstObjectId: boolean;
  isDefaultPriority: boolean;
}

// Parsed control messages (draft-16)

export interface ParsedServerSetup {
  parameters: KvPair[];
}

export interface ParsedSubscribe {
  requestId: number;
  namespace: string[];
  trackName: string;
  parameters: KvPair[];
}

export interface ParsedSubscribeOk {
  requestId: number;
  trackAlias: number;
  last?: Location;
  parameters: KvPair[];
  extensions: KvPair[];
}

export interface ParsedPublish {
  requestId: number;
  namespace: string[];
  trackName: string;
  trackAlias: number;
  parameters: KvPair[];
  extensions: KvPair[];
}

export interface ParsedPublishOk {
  reqId: number;
  parameters: KvPair[];
}

export interface ParsedPublishDone {
  requestId: number;
  statusCode: number;
  streamCount: number;
  errorReason: string;
}

export interface ParsedRequestOk {
  requestId: number;
  parameters: KvPair[];
}

export interface ParsedRequestError {
  requestId: number;
  errorCode: number;
  retryInterval: number;
  errorReason: string;
}

export interface ParsedRequestUpdate {
  requestId: number;
  existingRequestId: number;
  parameters: KvPair[];
}

export interface ParsedUnsubscribe {
  requestId: number;
}

export interface ParsedMaxRequestId {
  maxRequestId: number;
}

export interface ParsedUnknown {
  raw: Uint8Array;
}

export type MoqMessageData =
  | ParsedServerSetup
  | ParsedSubscribe
  | ParsedSubscribeOk
  | ParsedPublish
  | ParsedPublishOk
  | ParsedPublishDone
  | ParsedRequestOk
  | ParsedRequestError
  | ParsedRequestUpdate
  | ParsedUnsubscribe
  | ParsedMaxRequestId
  | ParsedUnknown;

export interface MoqMessage {
  type: number;
  // `data` is one of the Parsed* shapes above, discriminated at runtime by `type`.
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
  controlStream: WebTransportBidirectionalStream | null;
  controlWriter: WritableStream<Uint8Array> | null;
  controlReader: ReadableStream<Uint8Array> | null;
  multiObjectWritter: Record<string, WritableStreamDefaultWriter<Uint8Array>>;
  datagramsReader: ReadableStreamDefaultReader<Uint8Array> | null;
}

export function moqCreate(): MoqtState {
  return {
    wt: null,
    controlStream: null,
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
    await moqt.wt.close();
  }
  moqt.wt = null;
  moqt.controlStream = null;
  moqt.controlReader = null;
  moqt.datagramsReader = null;
}

// MOQ control stream — draft-16 keeps a client-initiated bidirectional stream.
export async function moqCreateControlStream(moqt: MoqtState): Promise<void> {
  if (moqt.wt === null) {
    throw new Error('WT session is NULL when we tried to create MOQ');
  }
  if (moqt.controlReader != null || moqt.controlWriter != null) {
    throw new Error('controlReader/controlWriter not null, dirty state from a previous session');
  }
  moqt.controlStream = await moqt.wt.createBidirectionalStream();
  moqt.controlWriter = moqt.controlStream.writable;
  moqt.controlReader = moqt.controlStream.readable;
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

// ---- CLIENT_SETUP / SERVER_SETUP --------------------------------------------

function moqCreateClientSetupMessageBytes(): Uint8Array {
  const params: KvPair[] = [
    moqCreateKvPair(MOQ_SETUP_PARAMETER_MAX_REQUEST_ID, MOQ_MAX_REQUEST_ID_NUM),
    moqCreateKvPair(MOQ_SETUP_PARAMETER_MOQT_IMPLEMENTATION, MOQ_IMPLEMENTATION_NAME),
  ];
  return frameControlMessage(MOQ_MESSAGE_CLIENT_SETUP, [moqCreateParametersBytes(params)]);
}

export async function moqSendClientSetup(
  writerStream: WritableStream<Uint8Array>
): Promise<void> {
  return moqSendToStream(writerStream, moqCreateClientSetupMessageBytes());
}

function moqParseServerSetup(r: BufReader): ParsedServerSetup {
  return { parameters: moqReadParameters(r) };
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
  pushAuthParam(params, authInfo);

  const msg: Uint8Array[] = [
    numberToVarInt(reqId),
    moqCreateTupleBytes(namespace),
    moqCreateStringBytes(name),
    numberToVarInt(trackAlias),
    moqCreateParametersBytes(params),
    // Track Extensions (empty)
  ];
  return frameControlMessage(MOQ_MESSAGE_PUBLISH, msg);
}

function moqParsePublish(r: BufReader): ParsedPublish {
  const requestId = r.readVarint();
  const namespace = r.readNamespace();
  const trackName = r.readString();
  const trackAlias = r.readVarint();
  const parameters = moqReadParameters(r);
  const extensions = moqReadKvpListRest(r);
  return { requestId, namespace, trackName, trackAlias, parameters, extensions };
}

// ---- PUBLISH_NAMESPACE ------------------------------------------------------

export async function moqSendPublishNamespace(
  writerStream: WritableStream<Uint8Array>,
  reqId: number,
  namespace: string[],
  authInfo: string | number | undefined,
): Promise<void> {
  const params: KvPair[] = [];
  pushAuthParam(params, authInfo);
  const msg: Uint8Array[] = [
    numberToVarInt(reqId),
    moqCreateTupleBytes(namespace),
    moqCreateParametersBytes(params),
  ];
  return moqSendToStream(writerStream, frameControlMessage(MOQ_MESSAGE_PUBLISH_NAMESPACE, msg));
}

// ---- PUBLISH_OK (parsed; sent by the subscriber peer) -----------------------

function moqParsePublishOk(r: BufReader): ParsedPublishOk {
  const reqId = r.readVarint();
  const parameters = moqReadParameters(r);
  return { reqId, parameters };
}

// ---- PUBLISH_DONE -----------------------------------------------------------

export async function moqSendPublishDone(
  writerStream: WritableStream<Uint8Array>,
  requestId: number,
  statusCode: number,
  streamCount: number,
  reason: string,
): Promise<void> {
  const msg: Uint8Array[] = [
    numberToVarInt(requestId),
    numberToVarInt(statusCode),
    numberToVarInt(streamCount),
    moqCreateStringBytes(reason),
  ];
  return moqSendToStream(writerStream, frameControlMessage(MOQ_MESSAGE_PUBLISH_DONE, msg));
}

function moqParsePublishDone(r: BufReader): ParsedPublishDone {
  return {
    requestId: r.readVarint(),
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
    moqCreateKvPair(
      MOQ_PARAMETER_SUBSCRIPTION_FILTER,
      numberToVarInt(MOQ_FILTER_TYPE_LARGEST_OBJECT),
    ),
  );
  pushAuthParam(params, authInfo);

  const msg: Uint8Array[] = [
    numberToVarInt(requestId),
    moqCreateTupleBytes(trackNamespace),
    moqCreateStringBytes(trackName),
    moqCreateParametersBytes(params),
  ];
  return frameControlMessage(MOQ_MESSAGE_SUBSCRIBE, msg);
}

function moqParseSubscribe(r: BufReader): ParsedSubscribe {
  const requestId = r.readVarint();
  const namespace = r.readNamespace();
  const trackName = r.readString();
  const parameters = moqReadParameters(r);
  return { requestId, namespace, trackName, parameters };
}

// ---- SUBSCRIBE_OK -----------------------------------------------------------

export async function moqSendSubscribeOk(
  writerStream: WritableStream<Uint8Array>,
  requestId: number,
  trackAlias: number,
  lastGroupSent?: number,
  lastObjSent?: number,
): Promise<void> {
  return moqSendToStream(
    writerStream,
    moqCreateSubscribeOkMessageBytes(requestId, trackAlias, lastGroupSent, lastObjSent),
  );
}

function moqCreateSubscribeOkMessageBytes(
  requestId: number,
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
    numberToVarInt(requestId),
    numberToVarInt(trackAlias),
    moqCreateParametersBytes(params),
    // Track Extensions (empty)
  ];
  return frameControlMessage(MOQ_MESSAGE_SUBSCRIBE_OK, msg);
}

function moqParseSubscribeOk(r: BufReader): ParsedSubscribeOk {
  const requestId = r.readVarint();
  const trackAlias = r.readVarint();
  const parameters = moqReadParameters(r);
  const extensions = moqReadKvpListRest(r);
  const ret: ParsedSubscribeOk = { requestId, trackAlias, parameters, extensions };
  const largest = parameters.find((p) => p.name === MOQ_PARAMETER_LARGEST_OBJECT);
  if (largest !== undefined) {
    ret.last = largest.val as Location;
  }
  return ret;
}

// ---- REQUEST_OK / REQUEST_ERROR --------------------------------------------

export async function moqSendRequestOk(
  writerStream: WritableStream<Uint8Array>,
  requestId: number,
): Promise<void> {
  const msg: Uint8Array[] = [numberToVarInt(requestId), moqCreateParametersBytes([])];
  return moqSendToStream(writerStream, frameControlMessage(MOQ_MESSAGE_REQUEST_OK, msg));
}

function moqParseRequestOk(r: BufReader): ParsedRequestOk {
  const requestId = r.readVarint();
  const parameters = moqReadParameters(r);
  return { requestId, parameters };
}

export async function moqSendRequestError(
  writerStream: WritableStream<Uint8Array>,
  requestId: number,
  errorCode: number,
  reason: string,
): Promise<void> {
  const msg: Uint8Array[] = [
    numberToVarInt(requestId),
    numberToVarInt(errorCode),
    numberToVarInt(0), // Retry Interval: 0 => do not retry
    moqCreateStringBytes(reason),
  ];
  return moqSendToStream(writerStream, frameControlMessage(MOQ_MESSAGE_REQUEST_ERROR, msg));
}

function moqParseRequestError(r: BufReader): ParsedRequestError {
  return {
    requestId: r.readVarint(),
    errorCode: r.readVarint(),
    retryInterval: r.readVarint(),
    errorReason: r.readString(),
  };
}

// ---- REQUEST_UPDATE ---------------------------------------------------------

function moqParseRequestUpdate(r: BufReader): ParsedRequestUpdate {
  return {
    requestId: r.readVarint(),
    existingRequestId: r.readVarint(),
    parameters: moqReadParameters(r),
  };
}

// ---- UNSUBSCRIBE ------------------------------------------------------------

export async function moqSendUnSubscribe(
  writerStream: WritableStream<Uint8Array>,
  requestId: number,
): Promise<void> {
  const msg: Uint8Array[] = [numberToVarInt(requestId)];
  return moqSendToStream(writerStream, frameControlMessage(MOQ_MESSAGE_UNSUBSCRIBE, msg));
}

function moqParseUnSubscribe(r: BufReader): ParsedUnsubscribe {
  return { requestId: r.readVarint() };
}

// ---- MAX_REQUEST_ID ---------------------------------------------------------

function moqParseMaxRequestId(r: BufReader): ParsedMaxRequestId {
  return { maxRequestId: r.readVarint() };
}

// ---- UNKNOWN ----------------------------------------------------------------

function moqParseUnknown(r: BufReader): ParsedUnknown {
  return { raw: r.readBytes(r.remaining()) };
}

// ---- control message dispatch ----------------------------------------------

export async function moqParseMsg(readerStream: ReadableStream<Uint8Array>): Promise<MoqMessage> {
  const msgType = await varIntToNumberOrThrow(readerStream);
  const len = await moqIntReadBytesOrThrow(readerStream, 2);
  const payload = len > 0 ? await buffReadOrThrow(readerStream, len) : new Uint8Array(0);
  const r = new BufReader(payload);

  let data: MoqMessageData;
  switch (msgType) {
    case MOQ_MESSAGE_SERVER_SETUP:
      data = moqParseServerSetup(r);
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
    case MOQ_MESSAGE_PUBLISH_OK:
      data = moqParsePublishOk(r);
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
    case MOQ_MESSAGE_UNSUBSCRIBE:
      data = moqParseUnSubscribe(r);
      break;
    case MOQ_MESSAGE_MAX_REQUEST_ID:
      data = moqParseMaxRequestId(r);
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
  // Extensions present (MoQMI always carries them), subgroup id present,
  // explicit priority. draft-16 has no FIRST_OBJECT bit.
  const type = getSubgroupHeaderType({ extensionsPresent: true, subGroupIdPresent: true });
  return concatBuffer([
    numberToVarInt(type),
    numberToVarInt(trackAlias),
    numberToVarInt(groupSeq),
    numberToVarInt(groupSeq), // Subgroup ID
    numberToSingleByteArray(publisherPriority),
  ]);
}

function moqCreateObjectEndOfGroupBytes(objSeqDelta: number, extensionHeaders: KvPair[]): Uint8Array {
  return concatBuffer([
    numberToVarInt(objSeqDelta), // Object ID delta
    moqCreateExtensionsBytes(extensionHeaders), // length-prefixed (0 when empty)
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
  msg.push(moqCreateExtensionsBytes(extensionHeaders)); // header has EXTENSIONS bit set
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

  const type = getDatagramType({ isStatus: !hasData, extensionsPresent: hasHeaders, isEndOfGroup });

  msg.push(numberToVarInt(type));
  msg.push(numberToVarInt(trackAlias));
  msg.push(numberToVarInt(groupSeq));
  msg.push(numberToVarInt(objSeq));
  msg.push(numberToSingleByteArray(publisherPriority));
  if (hasHeaders) {
    msg.push(moqCreateExtensionsBytes(extensionHeaders));
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
      ret.extensionHeaders = await moqReadExtensionsFromStream(readerStream);
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
    extensionHeaders = await moqReadExtensionsFromStream(readerStream);
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

// Frame a control message: [type varint][u16 length][body...].
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

function pushAuthParam(params: KvPair[], authInfo: string | number | undefined): void {
  if (authInfo != undefined && authInfo != '') {
    params.push(
      moqCreateKvPair(
        MOQ_PARAMETER_AUTHORIZATION_TOKEN,
        moqCreateUseValueTokenFromString(authInfo as string),
      ),
    );
  }
}

// ---- Key-Value-Pairs (draft-16 §1.4.2) -------------------------------------
//
// Delta-type encoded; Length present only when the (absolute) Type is odd. Used
// for Setup/Message Parameters (count-bounded) and Extension Headers
// (length-bounded). Even types carry a varint; odd types carry length+bytes.

function moqEncodeKvpList(kvParams: KvPair[]): Uint8Array {
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
  // Odd type: length-prefixed bytes (string, raw bytes, Token, or Location).
  let bytes: Uint8Array;
  if (name === MOQ_PARAMETER_AUTHORIZATION_TOKEN && isToken(val)) {
    bytes = moqSerializeTokenStruct(val);
  } else if (name === MOQ_PARAMETER_LARGEST_OBJECT && isLocation(val)) {
    bytes = concatBuffer([numberToVarInt(val.group), numberToVarInt(val.obj)]);
  } else if (typeof val === 'string') {
    bytes = new TextEncoder().encode(val);
  } else if (val instanceof Uint8Array) {
    bytes = val;
  } else if (val instanceof ArrayBuffer) {
    bytes = new Uint8Array(val);
  } else {
    throw new Error(`Odd KVP type ${name} must carry a string/byte/Token/Location value`);
  }
  return concatBuffer([numberToVarInt(bytes.byteLength), bytes]);
}

function decodeKvpValue(r: BufReader, type: number): KvPairValue {
  if (type % 2 === 0) {
    return r.readVarint();
  }
  const len = r.readVarint();
  const bytes = r.readBytes(len);
  if (type === MOQ_PARAMETER_AUTHORIZATION_TOKEN) {
    return moqParseTokenStruct(bytes);
  }
  if (type === MOQ_PARAMETER_LARGEST_OBJECT) {
    const lr = new BufReader(bytes);
    return lr.readLocation();
  }
  // Return a standalone ArrayBuffer (copied out of the shared view). Consumers
  // such as the MoQMI packager read these values via varIntToNumbeFromBuffer /
  // DataView, which require an ArrayBuffer rather than a typed-array view.
  return bytes.slice().buffer;
}

// Parameters: a varint count followed by delta-encoded KVPs.
function moqCreateParametersBytes(kvParams: KvPair[]): Uint8Array {
  return concatBuffer([numberToVarInt(kvParams.length), moqEncodeKvpList(kvParams)]);
}

function moqReadParameters(r: BufReader): KvPair[] {
  const count = r.readVarint();
  const out: KvPair[] = [];
  let prevType = 0;
  for (let i = 0; i < count; i++) {
    const type = prevType + r.readVarint();
    prevType = type;
    out.push(moqCreateKvPair(type, decodeKvpValue(r, type)));
  }
  return out;
}

// Extension Headers: a varint byte-length followed by delta-encoded KVPs.
function moqCreateExtensionsBytes(kvParams: KvPair[]): Uint8Array {
  const inner = moqEncodeKvpList(kvParams);
  return concatBuffer([numberToVarInt(inner.byteLength), inner]);
}

function moqReadKvpListByteLen(r: BufReader, byteLen: number): KvPair[] {
  const out: KvPair[] = [];
  const end = r.off + byteLen;
  let prevType = 0;
  while (r.off < end) {
    const type = prevType + r.readVarint();
    prevType = type;
    out.push(moqCreateKvPair(type, decodeKvpValue(r, type)));
  }
  return out;
}

// Track Extensions span the rest of the control message.
function moqReadKvpListRest(r: BufReader): KvPair[] {
  return moqReadKvpListByteLen(r, r.remaining());
}

// Object Extension Headers read from a data stream (length-prefixed delta KVPs).
async function moqReadExtensionsFromStream(
  readerStream: ReadableStream<Uint8Array>,
): Promise<KvPair[]> {
  const totalLen = await varIntToNumberOrThrow(readerStream);
  if (totalLen <= 0) {
    return [];
  }
  const buf = await buffReadOrThrow(readerStream, totalLen);
  return moqReadKvpListByteLen(new BufReader(buf), buf.byteLength);
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

function isToken(val: KvPairValue): val is Token {
  return typeof val === 'object' && val !== null && 'aliasType' in val && 'tokenType' in val;
}

function isLocation(val: KvPairValue): val is Location {
  return typeof val === 'object' && val !== null && 'group' in val && 'obj' in val;
}

function moqCreateUseValueTokenFromString(str: string): Token {
  return {
    aliasType: MOQ_TOKEN_USE_VALUE,
    tokenType: MOQ_TOKEN_TYPE_NEGOTIATED_OUT_OF_BAND,
    value: new TextEncoder().encode(str),
  };
}

// Token struct (no outer length; the KVP Length provides it).
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
    extensionsPresent: (type & MOQ_DATAGRAM_BIT_EXTENSIONS) !== 0,
    isEndOfGroup: (type & MOQ_DATAGRAM_BIT_END_OF_GROUP) !== 0,
    isObjIdPresent: (type & MOQ_DATAGRAM_BIT_ZERO_OBJECT_ID) === 0,
    isDefaultPriority: (type & MOQ_DATAGRAM_BIT_DEFAULT_PRIORITY) !== 0,
  };
}

function getDatagramType(opts: {
  isStatus: boolean;
  extensionsPresent: boolean;
  isEndOfGroup: boolean;
  objIdPresent?: boolean;
  defaultPriority?: boolean;
}): number {
  let type = 0;
  if (opts.isStatus) type |= MOQ_DATAGRAM_BIT_STATUS;
  if (opts.isEndOfGroup) type |= MOQ_DATAGRAM_BIT_END_OF_GROUP;
  if (opts.objIdPresent === false) type |= MOQ_DATAGRAM_BIT_ZERO_OBJECT_ID;
  if (opts.defaultPriority) type |= MOQ_DATAGRAM_BIT_DEFAULT_PRIORITY;
  if (opts.extensionsPresent) type |= MOQ_DATAGRAM_BIT_EXTENSIONS;
  if (!isMoqObjectDatagramType(type)) {
    throw new Error(`Datagram header to create type ${type} does not make sense`);
  }
  return type;
}

export function isMoqObjectStreamHeaderType(type: number): boolean {
  if ((type & MOQ_SUBGROUP_BIT_REQUIRED) === 0) {
    return false; // bit 0x10 must be set
  }
  if ((type & MOQ_SUBGROUP_FORBIDDEN_BITS) !== 0) {
    return false; // bits 6-7 must be clear (form 0b00X1XXXX)
  }
  if (((type & MOQ_SUBGROUP_SUBGROUP_ID_MODE_MASK) >> 1) === 3) {
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
    extensionsPresent: (type & MOQ_SUBGROUP_BIT_EXTENSIONS) !== 0,
    isEndOfGroup: (type & MOQ_SUBGROUP_BIT_END_OF_GROUP) !== 0,
    subGroupIdPresent: mode === MOQ_SUBGROUP_ID_MODE_PRESENT,
    isSubgroupIdFirstObjectId: mode === MOQ_SUBGROUP_ID_MODE_ABSENT_FIRST_OBJ,
    isDefaultPriority: (type & MOQ_SUBGROUP_BIT_DEFAULT_PRIORITY) !== 0,
  };
}

function getSubgroupHeaderType(opts: {
  extensionsPresent?: boolean;
  isEndOfGroup?: boolean;
  subGroupIdPresent?: boolean;
  isSubgroupIdFirstObjectId?: boolean;
  isDefaultPriority?: boolean;
}): number {
  let type = MOQ_SUBGROUP_BIT_REQUIRED;
  if (opts.subGroupIdPresent) {
    type |= MOQ_SUBGROUP_ID_MODE_PRESENT << 1;
  } else if (opts.isSubgroupIdFirstObjectId) {
    type |= MOQ_SUBGROUP_ID_MODE_ABSENT_FIRST_OBJ << 1;
  }
  if (opts.extensionsPresent) type |= MOQ_SUBGROUP_BIT_EXTENSIONS;
  if (opts.isEndOfGroup) type |= MOQ_SUBGROUP_BIT_END_OF_GROUP;
  if (opts.isDefaultPriority) type |= MOQ_SUBGROUP_BIT_DEFAULT_PRIORITY;
  if (!isMoqObjectStreamHeaderType(type)) {
    throw new Error(`Subgroup header to create type ${type} does not make sense`);
  }
  return type;
}
