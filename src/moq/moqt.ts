/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import { numberToVarInt, varIntToNumberOrThrow, varIntToNumberAndLengthOrThrow } from './varint.js';
import { numberTo2BytesArray, numberToSingleByteArray } from './byte_utils.js';
import {
  concatBuffer,
  buffRead,
  ReadStreamClosed,
  getArrayBufferByteLength,
} from './buffer_utils.js';

// MOQ definitions
// https://datatracker.ietf.org/doc/draft-ietf-moq-transport/
export const MOQ_DRAFT01_VERSION = 0xff000001;
export const MOQ_DRAFT02_VERSION = 0xff000002;
export const MOQ_DRAFT03_VERSION = 0xff000003;
export const MOQ_DRAFT04_VERSION = 0xff000004;
export const MOQ_DRAFT07exp2_VERSION = 0xff070002;
export const MOQ_DRAFT07_VERSION = 0xff000007;
export const MOQ_DRAFT08_VERSION_EXP9 = 0xff080009;
export const MOQ_DRAFT08_VERSION = 0xff000008;
export const MOQ_DRAFT12_VERSION = 0xff00000c;
export const MOQ_DRAFT14_VERSION = 0xff00000e;

export const MOQ_CURRENT_VERSION = MOQ_DRAFT14_VERSION;
export const MOQ_SUPPORTED_VERSIONS = [MOQ_CURRENT_VERSION];

export const MOQ_USE_LITTLE_ENDIAN = false; // MoQ is big endian

// Setup params
// export const MOQ_SETUP_PARAMETER_ROLE = 0x0 removed in version 8
export const MOQ_SETUP_PARAMETER_PATH = 0x1;
export const MOQ_SETUP_PARAMETER_MAX_REQUEST_ID = 0x2;
export const MOQ_SETUP_MAX_AUTH_TOKEN_CACHE_SIZE = 0x4;

//MOQ general params
export const MOQ_PARAMETER_DELIVERY_TIMEOUT = 0x2;
export const MOQ_PARAMETER_AUTHORIZATION_TOKEN = 0x3;
export const MOQ_PARAMETER_MAX_CACHE_DURATION = 0x4;

export const MOQ_MAX_PARAMS = 256;
export const MOQ_MAX_ARRAY_LENGTH = 1024;
export const MOQ_MAX_TUPLE_PARAMS = 32;
export const MOQ_MAX_REQUEST_ID_NUM = 128;

// MOQ SUBSCRIPTION CODES
export const MOQ_SUBSCRIPTION_ERROR_INTERNAL = 0;
export const MOQ_SUBSCRIPTION_RETRY_TRACK_ALIAS = 0x2;

// MOQ FILTER TYPES
export const MOQ_FILTER_TYPE_NEXT_GROUP_START = 0x1;
export const MOQ_FILTER_TYPE_LARGEST_OBJECT = 0x2;
export const MOQ_FILTER_TYPE_ABSOLUTE_START = 0x3; // With location
export const MOQ_FILTER_TYPE_ABSOLUTE_RANGE = 0x4; // With location

// MOQ object headers
// Datagrams
export const MOQ_MESSAGE_OBJECT_DATAGRAM_TYPES = [
  0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x20, 0x21,
];
export const MOQ_MESSAGE_OBJECT_DATAGRAM_TYPES_STATUS = [0x20, 0x21];

export const MOQ_MESSAGE_STREAM_HEADER_SUBGROUP_TYPES = [
  0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d,
];

// Streamgroup
export const MOQ_MESSAGE_STREAM_HEADER_SUBGROUP_TYPE_MIN = 0x10;
export const MOQ_MESSAGE_STREAM_HEADER_SUBGROUP_TYPE_MAX = 0x1d;

// MOQ Messages
export const MOQ_MESSAGE_CLIENT_SETUP = 0x20;
export const MOQ_MESSAGE_SERVER_SETUP = 0x21;

export const MOQ_MESSAGE_SUBSCRIBE_UPDATE = 0x2;
export const MOQ_MESSAGE_SUBSCRIBE = 0x3;
export const MOQ_MESSAGE_SUBSCRIBE_OK = 0x4;
export const MOQ_MESSAGE_SUBSCRIBE_ERROR = 0x5;
export const MOQ_MESSAGE_UNSUBSCRIBE = 0xa;
export const MOQ_MESSAGE_SUBSCRIBE_DONE = 0xb;

// PUBLISH
export const MOQ_MESSAGE_PUBLISH = 0x1d;
export const MOQ_MESSAGE_PUBLISH_OK = 0x1e;
export const MOQ_MESSAGE_PUBLISH_ERROR = 0x1f;
export const MOQ_MESSAGE_PUBLISH_DONE = 0xb;
export const MOQ_MESSAGE_PUBLISH_NAMESPACE = 0x6;
export const MOQ_MESSAGE_PUBLISH_NAMESPACE_OK = 0x7;
export const MOQ_MESSAGE_PUBLISH_NAMESPACE_ERROR = 0x8;

// MAX REQUEST ID
export const MOQ_MESSAGE_MAX_REQUEST_ID = 0x15;

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

// Object status
export const MOQ_OBJ_STATUS_NORMAL = 0x0;
export const MOQ_OBJ_STATUS_NOT_EXISTS = 0x1;
export const MOQ_OBJ_STATUS_END_OF_GROUP = 0x3;
export const MOQ_OBJ_STATUS_END_OF_TRACK_AND_GROUP = 0x4;
export const MOQ_OBJ_STATUS_END_OF_SUBGROUP = 0x5;

// Extension headers (Even types indicate value coded by a single varint. Odd types idicates value is byte buffer with prefixed varint to indicate lenght)
export const MOQ_EXT_HEADER_TYPE_MOQMI_MEDIA_TYPE = 0x0a;
export const MOQ_EXT_HEADER_TYPE_MOQMI_VIDEO_H264_IN_AVCC_METADATA = 0x15;
export const MOQ_EXT_HEADER_TYPE_MOQMI_VIDEO_H264_IN_AVCC_EXTRADATA = 0x0d;
export const MOQ_EXT_HEADER_TYPE_MOQMI_AUDIO_OPUS_METADATA = 0x0f;
export const MOQ_EXT_HEADER_TYPE_MOQMI_TEXT_UTF8_METADATA = 0x11;
export const MOQ_EXT_HEADER_TYPE_MOQMI_AUDIO_AACLC_MPEG4_METADATA = 0x13;

//Audio AAC-LC in MPEG4 bitstream data header extension (Header extension type = 0x13)

export const MOQ_EXT_HEADERS_SUPPORTED = [
  MOQ_EXT_HEADER_TYPE_MOQMI_MEDIA_TYPE,
  MOQ_EXT_HEADER_TYPE_MOQMI_VIDEO_H264_IN_AVCC_METADATA,
  MOQ_EXT_HEADER_TYPE_MOQMI_VIDEO_H264_IN_AVCC_EXTRADATA,
  MOQ_EXT_HEADER_TYPE_MOQMI_AUDIO_OPUS_METADATA,
  MOQ_EXT_HEADER_TYPE_MOQMI_TEXT_UTF8_METADATA,
  MOQ_EXT_HEADER_TYPE_MOQMI_AUDIO_AACLC_MPEG4_METADATA,
];

// Token Alias type
export const MOQ_TOKEN_DELETE = 0x0;
export const MOQ_TOKEN_REGISTER = 0x1;
export const MOQ_TOKEN_USE_ALIAS = 0x2;
export const MOQ_TOKEN_USE_VALUE = 0x3;

// Token type
export const MOQ_TOKEN_TYPE_NEGOTIATED_OUT_OF_BAND = 0x0;

// Status code
export const MOQ_STATUS_UNAUTHORIZED = 0x1;
export const MOQ_STATUS_TRACK_ENDED = 0x2;
export const SUBSCRIPTION_ENDED = 0x3;
export const GOING_AWAY = 0x4;
export const MOQ_STATUS_EXPIRED = 0x5;
export const MOQ_STATUS_TOO_FAR_BEHIND = 0x6;

// Protocol value types

export interface Token {
  aliasType: number;
  tokenType: number;
  value: Uint8Array;
}

export type KvPairValue = number | string | Uint8Array | ArrayBuffer | Token;

export interface KvPair<T extends KvPairValue = KvPairValue> {
  name: number;
  val: T;
}

export interface Location {
  group: number;
  obj: number;
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
}

export interface StreamHeaderOptions {
  extensionsPresent: boolean;
  isEndOfGroup: boolean;
  subGroupIdPresent: boolean;
  isSubgroupIdFirstObjectId: boolean;
}

// Parsed control messages

export interface ParsedServerSetup {
  version: number;
  parameters: KvPair[];
}

export interface ParsedSubscribe {
  requestId: number;
  namespace: string[];
  trackName: string;
  subscriberPriority: number;
  groupOrder: number;
  forward: number;
  filter: Filter;
  parameters: KvPair[];
}

export interface ParsedSubscribeOk {
  requestId: number;
  trackAlias: number;
  expires: number;
  groupOrder: number;
  last?: Location;
  parameters: KvPair[];
}

export interface ParsedSubscribeError {
  requestId: number;
  errorCode: number;
  errorReason: string;
}

export interface ParsedUnsubscribe {
  subscriptionRequestId: number;
}

export interface ParsedSubscribeUpdate {
  requestId: number;
  subscriptionRequestId: number;
  start: Location;
  end: RangeEnd;
  subscriberPriority: number;
  forward: number;
  parameters: KvPair[];
}

export interface ParsedPublishOk {
  reqId: number;
  forward: number;
  subscriberPriority: number;
  groupOrder: number;
  filter: Filter;
  parameters: KvPair[];
}

export interface ParsedPublishError {
  reqId: number;
  errorCode: number;
  reason: string;
}

export interface ParsedPublishDone {
  requestId: number;
  statusCode: number;
  streamCount: number;
  errorReason: string;
}

export interface ParsedPublishNamespaceOk {
  reqId: number;
}

export interface ParsedPublishNamespaceError {
  reqId: number;
  errorCode: number;
  reason: string;
}

export interface ParsedUnknown {
  data: { eof: boolean; buff: Uint8Array } | null;
}

export type MoqMessageData =
  | ParsedServerSetup
  | ParsedSubscribe
  | ParsedSubscribeOk
  | ParsedSubscribeError
  | ParsedUnsubscribe
  | ParsedSubscribeUpdate
  | ParsedPublishOk
  | ParsedPublishError
  | ParsedPublishDone
  | ParsedPublishNamespaceOk
  | ParsedPublishNamespaceError
  | ParsedUnknown;

export interface MoqMessage {
  type: number;
  // `data` is one of the Parsed* shapes above, discriminated at runtime by
  // `type`. It is typed `any` because callers select fields based on `type`
  // without narrowing; each individual parser is still strongly typed.
  data: any;
}

// Parsed object header. The fields present depend on `options`; datagram-only
// fields (objSeq, extensionHeaders) and subgroup-only fields (subGroupSeq) are
// therefore optional on this single shared shape.
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
  // Kept loose: callers invoke `wt.createUnidirectionalStream(...)` with a
  // non-standard options shape (see docs/moqt-review.md). Typing this as
  // `WebTransport` would not compile against the existing caller code, which is
  // out of scope for this types-only change.
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
    // The writer may still be locked (an in-flight send). Closing the
    // WebTransport session below tears it down regardless.
    if (!moqt.controlWriter.locked) {
      await moqt.controlWriter.close();
    }
    moqt.controlWriter = null;
  }
  // TODO: We need to cancel the reader (https://developer.mozilla.org/en-US/docs/Web/API/ReadableStreamBYOBReader)
  if (moqt.controlReader != null) {
    // The control loop holds a reader lock while blocked in read(); skip the
    // cancel in that case and let wt.close() error the pending read.
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
  moqt.controlStream = null;
  moqt.controlReader = null;
  moqt.datagramsReader = null;
}

// MOQ control stream

export async function moqCreateControlStream(moqt: MoqtState): Promise<void> {
  if (moqt.wt === null) {
    throw new Error('WT session is NULL when we tried to create MOQ');
  }
  if (moqt.controlReader != null || moqt.controlWriter != null) {
    throw new Error(
      'controlReader OR controlWriter are NOT null this indicates there are some dirt from previous sessions when we tried to create MOQ',
    );
  }

  moqt.controlStream = await moqt.wt.createBidirectionalStream();
  moqt.controlWriter = moqt.controlStream.writable;
  moqt.controlReader = moqt.controlStream.readable;
}

// SETUP CLIENT

function moqCreateClientSetupMessageBytes(version: number): Uint8Array {
  const msg: Uint8Array[] = [];

  // Number of supported versions
  msg.push(numberToVarInt(1));
  // Version[0]
  msg.push(numberToVarInt(version));
  const kv_params = [moqCreateKvPair(MOQ_SETUP_PARAMETER_MAX_REQUEST_ID, MOQ_MAX_REQUEST_ID_NUM)];
  msg.push(moqCreateParametersBytes(kv_params));

  // Length
  const totalLength = getArrayBufferByteLength(msg);

  return concatBuffer([
    numberToVarInt(MOQ_MESSAGE_CLIENT_SETUP),
    numberTo2BytesArray(totalLength, MOQ_USE_LITTLE_ENDIAN),
    ...msg,
  ]);
}

export async function moqSendClientSetup(
  writerStream: WritableStream<Uint8Array>,
  version: number = MOQ_CURRENT_VERSION,
): Promise<void> {
  return moqSendToStream(writerStream, moqCreateClientSetupMessageBytes(version));
}

// SETUP SERVER

async function moqParseSetupResponse(
  readerStream: ReadableStream<Uint8Array>,
): Promise<ParsedServerSetup> {
  const ret = {} as ParsedServerSetup;
  await moqIntReadBytesOrThrow(readerStream, 2); // Length

  ret.version = await varIntToNumberOrThrow(readerStream);
  if (!MOQ_SUPPORTED_VERSIONS.includes(ret.version)) {
    throw new Error(
      `version sent from server NOT supported. Supported versions ${JSON.stringify(MOQ_SUPPORTED_VERSIONS)}, got from server ${JSON.stringify(ret.version)}`,
    );
  }
  ret.parameters = await moqReadParameters(readerStream);

  return ret;
}

// PUBLISH

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
  const msg: Uint8Array[] = [];

  // RequestID
  msg.push(numberToVarInt(reqId));
  // Namespace
  msg.push(moqCreateTupleBytes(namespace));
  // Name
  msg.push(moqCreateStringBytes(name));
  // TrackAlias
  msg.push(numberToVarInt(trackAlias));
  // Group order
  msg.push(numberToSingleByteArray(MOQ_GROUP_ORDER_ASCENDING));
  // Context exists
  msg.push(numberToSingleByteArray(0)); // Nothing has been published before
  // Forward
  msg.push(numberToSingleByteArray(forward)); // Start sending now
  // Parameters
  let kv_params: KvPair[] = [];
  if (authInfo != undefined && authInfo != '') {
    kv_params = [
      moqCreateKvPair(
        MOQ_PARAMETER_AUTHORIZATION_TOKEN,
        moqCreateUseValueTokenFromString(authInfo as string),
      ),
    ];
  }
  msg.push(moqCreateParametersBytes(kv_params));

  // Length
  const lengthBytes = numberTo2BytesArray(getArrayBufferByteLength(msg), MOQ_USE_LITTLE_ENDIAN);

  return concatBuffer([numberToVarInt(MOQ_MESSAGE_PUBLISH), lengthBytes, ...msg]);
}

// PUBLISH NAMESPACE

export async function moqSendPublishNamespace(
  writerStream: WritableStream<Uint8Array>,
  reqId: number,
  namespace: string[],
  authInfo: string | number | undefined,
): Promise<void> {
  return moqSendToStream(
    writerStream,
    moqCreatePublishNamespaceMessageBytes(reqId, namespace, authInfo),
  );
}

function moqCreatePublishNamespaceMessageBytes(
  reqId: number,
  namespace: string[],
  authInfo: string | number | undefined,
): Uint8Array {
  const msg: Uint8Array[] = [];

  // RequestID
  msg.push(numberToVarInt(reqId));
  // Namespace
  msg.push(moqCreateTupleBytes(namespace));
  // Parameters
  let kv_params: KvPair[] = [];
  if (authInfo != undefined && authInfo != '') {
    kv_params = [
      moqCreateKvPair(
        MOQ_PARAMETER_AUTHORIZATION_TOKEN,
        moqCreateUseValueTokenFromString(authInfo as string),
      ),
    ];
  }
  msg.push(moqCreateParametersBytes(kv_params));

  // Length
  const lengthBytes = numberTo2BytesArray(getArrayBufferByteLength(msg), MOQ_USE_LITTLE_ENDIAN);

  return concatBuffer([numberToVarInt(MOQ_MESSAGE_PUBLISH_NAMESPACE), lengthBytes, ...msg]);
}

// PUBLISH NAMESPACE OK

async function moqParsePublishNamespaceOk(
  readerStream: ReadableStream<Uint8Array>,
): Promise<ParsedPublishNamespaceOk> {
  const ret = {} as ParsedPublishNamespaceOk;

  await moqIntReadBytesOrThrow(readerStream, 2); // Length

  ret.reqId = await varIntToNumberOrThrow(readerStream);

  return ret;
}

// PUBLISH NAMESPACE ERROR

async function moqParsePublishNamespaceError(
  readerStream: ReadableStream<Uint8Array>,
): Promise<ParsedPublishNamespaceError> {
  const ret = {} as ParsedPublishNamespaceError;

  await moqIntReadBytesOrThrow(readerStream, 2); // Length

  ret.reqId = await varIntToNumberOrThrow(readerStream);
  ret.errorCode = await varIntToNumberOrThrow(readerStream);
  ret.reason = await moqStringReadOrThrow(readerStream);

  return ret;
}

// PUBLISH OK

async function moqParsePublishOk(
  readerStream: ReadableStream<Uint8Array>,
): Promise<ParsedPublishOk> {
  const ret = {} as ParsedPublishOk;

  await moqIntReadBytesOrThrow(readerStream, 2); // Length

  ret.reqId = await varIntToNumberOrThrow(readerStream);
  ret.forward = await moqIntReadBytesOrThrow(readerStream, 1);
  ret.subscriberPriority = await moqIntReadBytesOrThrow(readerStream, 1);
  ret.groupOrder = await moqIntReadBytesOrThrow(readerStream, 1);
  ret.filter = await moqDecodeFilterLocation(readerStream);
  ret.parameters = await moqReadParameters(readerStream);

  return ret;
}

// PUBLISH ERROR

async function moqParsePublishError(
  readerStream: ReadableStream<Uint8Array>,
): Promise<ParsedPublishError> {
  const ret = {} as ParsedPublishError;

  await moqIntReadBytesOrThrow(readerStream, 2); // Length

  ret.reqId = await varIntToNumberOrThrow(readerStream);
  ret.errorCode = await varIntToNumberOrThrow(readerStream);
  ret.reason = await moqStringReadOrThrow(readerStream);

  return ret;
}

// PUBLISH DONE

export async function moqSendPublishDone(
  writerStream: WritableStream<Uint8Array>,
  requestId: number,
  statusCode: number,
  streamCount: number,
  reason: string,
): Promise<void> {
  return moqSendToStream(
    writerStream,
    moqCreatePublishDoneMessageBytes(requestId, statusCode, streamCount, reason),
  );
}

function moqCreatePublishDoneMessageBytes(
  requestId: number,
  statusCode: number,
  streamCount: number,
  reason: string,
): Uint8Array {
  const msg: Uint8Array[] = [];

  // Request ID
  msg.push(numberToVarInt(requestId));
  // Status code
  msg.push(numberToVarInt(statusCode));
  // Stream count
  msg.push(numberToVarInt(streamCount));
  // Error reason
  msg.push(moqCreateStringBytes(reason));

  // Length
  const lengthBytes = numberTo2BytesArray(getArrayBufferByteLength(msg), MOQ_USE_LITTLE_ENDIAN);

  return concatBuffer([numberToVarInt(MOQ_MESSAGE_PUBLISH_DONE), lengthBytes, ...msg]);
}

async function moqParsePublishDone(
  readerStream: ReadableStream<Uint8Array>,
): Promise<ParsedPublishDone> {
  const ret = {} as ParsedPublishDone;

  await moqIntReadBytesOrThrow(readerStream, 2); // Length
  ret.requestId = await varIntToNumberOrThrow(readerStream);
  ret.statusCode = await varIntToNumberOrThrow(readerStream);
  ret.streamCount = await varIntToNumberOrThrow(readerStream);
  ret.errorReason = await moqStringReadOrThrow(readerStream);

  return ret;
}

// SUBSCRIBE
// Always subscribe from start next group

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
  const msg: Uint8Array[] = [];

  // reuqestID
  msg.push(numberToVarInt(requestId));
  // Track namespace
  msg.push(moqCreateTupleBytes(trackNamespace));
  // Track name
  msg.push(moqCreateStringBytes(trackName));
  // Subscriber priority
  msg.push(numberToSingleByteArray(MOQ_USECASE_SUBSCRIBER_PRIORITY_DEFAULT));
  // Group order
  msg.push(numberToSingleByteArray(MOQ_GROUP_ORDER_FOLLOW_PUBLISHER));
  // Forward
  msg.push(numberToSingleByteArray(MOQ_FORWARD_TRUE));
  // Filter type (request latest object)
  msg.push(numberToVarInt(MOQ_FILTER_TYPE_LARGEST_OBJECT));

  // NO need to add StartGroup, StartObject, EndGroup

  // Params
  let kv_params: KvPair[] = [];
  if (authInfo != undefined && authInfo != '') {
    kv_params = [
      moqCreateKvPair(
        MOQ_PARAMETER_AUTHORIZATION_TOKEN,
        moqCreateUseValueTokenFromString(authInfo as string),
      ),
    ];
  }
  msg.push(moqCreateParametersBytes(kv_params));

  // Length
  const lengthBytes = numberTo2BytesArray(getArrayBufferByteLength(msg), MOQ_USE_LITTLE_ENDIAN);

  return concatBuffer([numberToVarInt(MOQ_MESSAGE_SUBSCRIBE), lengthBytes, ...msg]);
}

async function moqParseSubscribe(
  readerStream: ReadableStream<Uint8Array>,
): Promise<ParsedSubscribe> {
  const ret = {} as ParsedSubscribe;

  await moqIntReadBytesOrThrow(readerStream, 2); // Length
  ret.requestId = await varIntToNumberOrThrow(readerStream);
  ret.namespace = await moqTupleReadOrThrow(readerStream);
  ret.trackName = await moqStringReadOrThrow(readerStream);
  ret.subscriberPriority = await moqIntReadBytesOrThrow(readerStream, 1);
  ret.groupOrder = await moqIntReadBytesOrThrow(readerStream, 1);
  ret.forward = await moqIntReadBytesOrThrow(readerStream, 1);
  ret.filter = await moqDecodeFilterLocation(readerStream);
  ret.parameters = await moqReadParameters(readerStream);

  return ret;
}

// SUBSCRIBE OK

export async function moqSendSubscribeOk(
  writerStream: WritableStream<Uint8Array>,
  requestId: number,
  trackAlias: number,
  expiresMs: number,
  lastGroupSent: number | undefined,
  lastObjSent: number | undefined,
  authInfo: string | number | undefined,
): Promise<void> {
  return moqSendToStream(
    writerStream,
    moqCreateSubscribeOkMessageBytes(
      requestId,
      trackAlias,
      expiresMs,
      lastGroupSent,
      lastObjSent,
      authInfo,
    ),
  );
}

function moqCreateSubscribeOkMessageBytes(
  requestId: number,
  trackAlias: number,
  expiresMs: number,
  lastGroupSent: number | undefined,
  lastObjSent: number | undefined,
  authInfo: string | number | undefined,
): Uint8Array {
  const msg: Uint8Array[] = [];

  // RequestID
  msg.push(numberToVarInt(requestId));
  // Trackalias
  msg.push(numberToVarInt(trackAlias));
  // Expires MS
  msg.push(numberToVarInt(expiresMs));
  // Group order
  msg.push(numberToSingleByteArray(MOQ_GROUP_ORDER_DESCENDING)); // Live streaming app (so new needs to be send first)

  if (lastGroupSent != undefined && lastObjSent != undefined) {
    // Content exists
    msg.push(numberToSingleByteArray(1));
    // Location
    msg.push(moqCreateLocationBytes(lastGroupSent, lastObjSent));
  } else {
    // Content exists
    msg.push(numberToSingleByteArray(0));
  }

  // Params
  let kv_params: KvPair[] = [];
  if (authInfo != undefined && authInfo != '') {
    kv_params = [
      moqCreateKvPair(
        MOQ_PARAMETER_AUTHORIZATION_TOKEN,
        moqCreateUseValueTokenFromString(authInfo as string),
      ),
    ];
  }
  msg.push(moqCreateParametersBytes(kv_params));

  // Length
  const lengthBytes = numberTo2BytesArray(getArrayBufferByteLength(msg), MOQ_USE_LITTLE_ENDIAN);

  return concatBuffer([numberToVarInt(MOQ_MESSAGE_SUBSCRIBE_OK), lengthBytes, ...msg]);
}

async function moqParseSubscribeOk(
  readerStream: ReadableStream<Uint8Array>,
): Promise<ParsedSubscribeOk> {
  const ret = {} as ParsedSubscribeOk;

  await moqIntReadBytesOrThrow(readerStream, 2); // Length
  ret.requestId = await varIntToNumberOrThrow(readerStream);
  ret.trackAlias = await varIntToNumberOrThrow(readerStream);
  ret.expires = await varIntToNumberOrThrow(readerStream);
  ret.groupOrder = await moqIntReadBytesOrThrow(readerStream, 1);
  const contentExists = await moqIntReadBytesOrThrow(readerStream, 1);
  if (contentExists > 0) {
    ret.last = await moqDecodeLocation(readerStream);
  }
  ret.parameters = await moqReadParameters(readerStream);

  return ret;
}

// SUBSCRIBE ERROR

export async function moqSendSubscribeError(
  writerStream: WritableStream<Uint8Array>,
  requestId: number,
  errorCode: number,
  reason: string,
): Promise<void> {
  return moqSendToStream(
    writerStream,
    moqCreateSubscribeErrorMessageBytes(requestId, errorCode, reason),
  );
}

function moqCreateSubscribeErrorMessageBytes(
  requestId: number,
  errorCode: number,
  reason: string,
): Uint8Array {
  const msg: Uint8Array[] = [];

  // Request Id
  msg.push(numberToVarInt(requestId));
  // errorCode
  msg.push(numberToVarInt(errorCode));
  // Reason
  msg.push(moqCreateStringBytes(reason));

  // Length
  const lengthBytes = numberTo2BytesArray(getArrayBufferByteLength(msg), MOQ_USE_LITTLE_ENDIAN);

  return concatBuffer([numberToVarInt(MOQ_MESSAGE_SUBSCRIBE_ERROR), lengthBytes, ...msg]);
}

async function moqParseSubscribeError(
  readerStream: ReadableStream<Uint8Array>,
): Promise<ParsedSubscribeError> {
  const ret = {} as ParsedSubscribeError;

  await moqIntReadBytesOrThrow(readerStream, 2); // Length
  ret.requestId = await varIntToNumberOrThrow(readerStream);
  ret.errorCode = await varIntToNumberOrThrow(readerStream);
  ret.errorReason = await moqStringReadOrThrow(readerStream);

  return ret;
}

// UNSUBSCRIBE

export async function moqSendUnSubscribe(
  writerStream: WritableStream<Uint8Array>,
  subscribeId: number,
): Promise<void> {
  return moqSendToStream(writerStream, moqCreateUnSubscribeMessageBytes(subscribeId));
}

function moqCreateUnSubscribeMessageBytes(requestId: number): Uint8Array {
  const msg: Uint8Array[] = [];

  // Subscribe Id
  msg.push(numberToVarInt(requestId));

  // Length
  const lengthBytes = numberTo2BytesArray(getArrayBufferByteLength(msg), MOQ_USE_LITTLE_ENDIAN);

  return concatBuffer([numberToVarInt(MOQ_MESSAGE_UNSUBSCRIBE), lengthBytes, ...msg]);
}

async function moqParseUnSubscribe(
  readerStream: ReadableStream<Uint8Array>,
): Promise<ParsedUnsubscribe> {
  const ret = {} as ParsedUnsubscribe;

  await moqIntReadBytesOrThrow(readerStream, 2); // Length

  // requestId
  ret.subscriptionRequestId = await varIntToNumberOrThrow(readerStream);

  return ret;
}

// SUBSCRIBE UPDATE

async function moqParseSubscribeUpdate(
  readerStream: ReadableStream<Uint8Array>,
): Promise<ParsedSubscribeUpdate> {
  const ret = {} as ParsedSubscribeUpdate;

  await moqIntReadBytesOrThrow(readerStream, 2); // Length
  ret.requestId = await varIntToNumberOrThrow(readerStream);
  ret.subscriptionRequestId = await varIntToNumberOrThrow(readerStream);
  ret.start = await moqDecodeLocation(readerStream);
  ret.end = {} as RangeEnd;
  ret.end.group = await varIntToNumberOrThrow(readerStream);
  ret.subscriberPriority = await moqIntReadBytesOrThrow(readerStream, 1);
  ret.forward = await moqIntReadBytesOrThrow(readerStream, 1);
  ret.parameters = await moqReadParameters(readerStream);

  return ret;
}

// UNKNOWN

async function moqParseUnknown(
  readerStream: ReadableStream<Uint8Array>,
): Promise<ParsedUnknown> {
  const ret = {} as ParsedUnknown;

  const size = await moqIntReadBytesOrThrow(readerStream, 2); // Length
  ret.data = await buffRead(readerStream, size);

  return ret;
}

// PARSE MESSAGES

export async function moqParseMsg(
  readerStream: ReadableStream<Uint8Array>,
): Promise<MoqMessage> {
  const msgType = await varIntToNumberOrThrow(readerStream);
  let data: MoqMessageData = null as unknown as MoqMessageData;
  if (msgType === MOQ_MESSAGE_SUBSCRIBE) {
    data = await moqParseSubscribe(readerStream);
  } else if (msgType === MOQ_MESSAGE_UNSUBSCRIBE) {
    data = await moqParseUnSubscribe(readerStream);
  } else if (msgType === MOQ_MESSAGE_PUBLISH_DONE) {
    data = await moqParsePublishDone(readerStream);
  } else if (msgType === MOQ_MESSAGE_SERVER_SETUP) {
    data = await moqParseSetupResponse(readerStream);
  } else if (msgType === MOQ_MESSAGE_SUBSCRIBE_OK) {
    data = await moqParseSubscribeOk(readerStream);
  } else if (msgType === MOQ_MESSAGE_SUBSCRIBE_ERROR) {
    data = await moqParseSubscribeError(readerStream);
  } else if (msgType == MOQ_MESSAGE_PUBLISH_OK) {
    data = await moqParsePublishOk(readerStream);
  } else if (msgType == MOQ_MESSAGE_PUBLISH_ERROR) {
    data = await moqParsePublishError(readerStream);
  } else if (msgType == MOQ_MESSAGE_SUBSCRIBE_UPDATE) {
    data = await moqParseSubscribeUpdate(readerStream);
  } else if (msgType == MOQ_MESSAGE_PUBLISH_NAMESPACE_OK) {
    data = await moqParsePublishNamespaceOk(readerStream);
  } else if (msgType == MOQ_MESSAGE_PUBLISH_NAMESPACE_ERROR) {
    data = await moqParsePublishNamespaceError(readerStream);
  } else {
    data = await moqParseUnknown(readerStream);
  }
  return { type: msgType, data: data };
}

// OBJECT

function moqCreateSubgroupHeaderBytes(
  trackAlias: number,
  groupSeq: number,
  publisherPriority: number,
): Uint8Array {
  const msg: Uint8Array[] = [];

  const type = getSubgroupHeaderType(true, false, true, false);
  // Message type
  msg.push(numberToVarInt(type));
  msg.push(numberToVarInt(trackAlias)); // Track Alias
  msg.push(numberToVarInt(groupSeq)); // Group ID
  msg.push(numberToVarInt(groupSeq)); // Subgroup ID
  msg.push(numberToSingleByteArray(publisherPriority)); // Publisher priority

  return concatBuffer(msg);
}

function moqCreateObjectEndOfGroupBytes(objSeq: number, extensionHeaders: KvPair[]): Uint8Array {
  const msg: Uint8Array[] = [];

  msg.push(numberToVarInt(objSeq)); // Object ID
  if (extensionHeaders == undefined || extensionHeaders.length <= 0) {
    msg.push(numberToVarInt(0)); // Extension headers count
  } else {
    msg.push(moqCreateExtensionsBytes(extensionHeaders)); // Extension headers
  }
  msg.push(numberToVarInt(0)); // Size = 0
  msg.push(numberToVarInt(MOQ_OBJ_STATUS_END_OF_GROUP));

  return concatBuffer(msg);
}

function moqCreateObjectSubgroupBytes(
  objSeqDelta: number,
  data: BufferSource | undefined,
  extensionHeaders: KvPair[],
): Uint8Array {
  const msg: Array<Uint8Array | BufferSource> = [];

  msg.push(numberToVarInt(objSeqDelta)); // Object ID delta
  if (extensionHeaders == undefined || extensionHeaders.length <= 0) {
    msg.push(numberToVarInt(0)); // Extension headers count
  } else {
    msg.push(moqCreateExtensionsBytes(extensionHeaders)); // Extension headers
  }
  if (data != undefined && data.byteLength > 0) {
    msg.push(numberToVarInt(data.byteLength)); // Data size
    msg.push(data);
  } else {
    msg.push(numberToVarInt(0)); // Data size
    msg.push(numberToVarInt(MOQ_OBJ_STATUS_NORMAL)); // Obj status
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
  isEndOfFGroup: boolean,
): Uint8Array {
  const msg: Array<Uint8Array | BufferSource> = [];
  const hasHeaders = extensionHeaders != undefined && extensionHeaders.length > 0;
  const hasData = data != undefined && data.byteLength > 0;

  const type = getDatagramType(!hasData, hasHeaders, isEndOfFGroup);

  // Message type
  msg.push(numberToVarInt(type));
  msg.push(numberToVarInt(trackAlias));
  msg.push(numberToVarInt(groupSeq));
  msg.push(numberToVarInt(objSeq));
  msg.push(numberToSingleByteArray(publisherPriority));
  if (hasHeaders) {
    msg.push(moqCreateExtensionsBytes(extensionHeaders)); // Extension headers
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
  objSeq: number,
  extensionHeaders: KvPair[],
  closeStream?: boolean,
): Promise<void> {
  return moqSendToWriter(
    writer,
    moqCreateObjectEndOfGroupBytes(objSeq, extensionHeaders),
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
  isEndOfFGroup: boolean,
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
      isEndOfFGroup,
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

  let ret = undefined as unknown as ObjectHeader;
  if (isMoqObjectDatagramType(type)) {
    ret = { type } as ObjectHeader;
    ret.options = moqDecodeDatagramType(type);
    ret.trackAlias = await varIntToNumberOrThrow(readerStream);
    ret.groupSeq = await varIntToNumberOrThrow(readerStream);
    if ((ret.options as DatagramTypeOptions).isObjIdPresent) {
      ret.objSeq = await varIntToNumberOrThrow(readerStream);
    }
    ret.publisherPriority = await moqIntReadBytesOrThrow(readerStream, 1);
    if (ret.options.extensionsPresent) {
      ret.extensionHeaders = await moqReadHeaderExtensions(readerStream);
    }
  } else if (isMoqObjectStreamHeaderType(type)) {
    ret = { type } as ObjectHeader;
    ret.options = moqDecodeStreamHeaderType(type);
    ret.trackAlias = await varIntToNumberOrThrow(readerStream);
    ret.groupSeq = await varIntToNumberOrThrow(readerStream);
    if ((ret.options as StreamHeaderOptions).subGroupIdPresent) {
      ret.subGroupSeq = await varIntToNumberOrThrow(readerStream);
    }
    ret.publisherPriority = await moqIntReadBytesOrThrow(readerStream, 1);
  }
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
    extensionHeaders = await moqReadHeaderExtensions(readerStream);
  }
  const payloadLength = await varIntToNumberOrThrow(readerStream);
  const ret: SubgroupObject = { objSeq, payloadLength, extensionHeaders };
  if (payloadLength == 0) {
    ret.status = await varIntToNumberOrThrow(readerStream);
  }
  return ret;
}

// Helpers

export function getTrackFullName(namespace: string, trackName: string): string {
  return namespace + trackName;
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
  return { name: name, val: val };
}

function moqCreateParametersBytes(kv_params: KvPair[]): Uint8Array {
  const msg: Uint8Array[] = [];
  msg.push(numberToVarInt(kv_params.length));
  for (let i = 0; i < kv_params.length; i++) {
    const param = kv_params[i];
    msg.push(moqCreateKvParamBytes(param.name, param.val, false));
  }
  return concatBuffer(msg);
}

function moqCreateExtensionsBytes(kv_params: KvPair[]): Uint8Array {
  const msg: Uint8Array[] = [];
  for (let i = 0; i < kv_params.length; i++) {
    const param = kv_params[i];
    msg.push(moqCreateKvParamBytes(param.name, param.val, true));
  }
  // Length
  const lengthBytes = getArrayBufferByteLength(msg);

  return concatBuffer([numberToVarInt(lengthBytes), ...msg]);
}

function moqCreateKvParamBytes(
  name: number,
  val: KvPairValue,
  isExtensionHeaders: boolean,
): Uint8Array {
  const msg: Array<Uint8Array | BufferSource> = [];
  msg.push(numberToVarInt(name));
  if (typeof val === 'number') {
    if (name % 2 != 0) {
      // Even types indicate value coded by a single varint
      throw new Error('Params with odd name needs to be followed by string or buffer');
    }
    msg.push(numberToVarInt(val));
  } else if (typeof val === 'string') {
    if (name % 2 == 0) {
      // Odd types are followed by varint or buffer
      throw new Error('Params with even name needs to be followed by number');
    }
    msg.push(moqCreateStringBytes(val));
  } else if (
    typeof val === 'object' &&
    !isExtensionHeaders &&
    name === MOQ_PARAMETER_AUTHORIZATION_TOKEN
  ) {
    msg.push(moqCreateTokenBytes(val as Token));
  } else if (typeof val === 'object' && isExtensionHeaders) {
    if (name % 2 == 0) {
      // Odd types are followed by varint or buffer
      throw new Error('Params with even name needs to be followed by number');
    }
    if (!(val instanceof Uint8Array) && !(val instanceof ArrayBuffer)) {
      throw new Error(`Trying to write an non Uint8Array/ArrayBuffer as buffer`);
    }
    msg.push(numberToVarInt(val.byteLength));
    msg.push(val);
  } else {
    throw new Error(`Not supported MOQT param/extension type ${typeof val}`);
  }
  return concatBuffer(msg);
}

async function moqStringReadOrThrow(readerStream: ReadableStream<Uint8Array>): Promise<string> {
  const size = await varIntToNumberOrThrow(readerStream);
  const ret = await buffRead(readerStream, size);
  if (ret.eof) {
    throw new ReadStreamClosed(`Connection closed while reading data`);
  }
  return new TextDecoder().decode(ret.buff);
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
  if (length > 2) return new DataView(ret.buff, 0, length).getUint32(0, MOQ_USE_LITTLE_ENDIAN);
}

async function moqTupleReadOrThrow(readerStream: ReadableStream<Uint8Array>): Promise<string[]> {
  const ret: string[] = [];
  const size = await varIntToNumberOrThrow(readerStream);
  let i = 0;
  while (i < size) {
    const element = await moqStringReadOrThrow(readerStream);
    ret.push(element);
    i++;
  }
  return ret;
}

async function moqReadParameters(readerStream: ReadableStream<Uint8Array>): Promise<KvPair[]> {
  const ret: KvPair[] = [];
  const count = await varIntToNumberOrThrow(readerStream);
  for (let i = 0; i < count; i++) {
    const param = await moqReadKeyValuePair(readerStream, false);
    ret.push(param.val);
  }
  return ret;
}

async function moqReadHeaderExtensions(readerStream: ReadableStream<Uint8Array>): Promise<KvPair[]> {
  const ret: KvPair[] = [];
  let remainingBytes = await varIntToNumberOrThrow(readerStream);
  while (remainingBytes > 0) {
    const param = await moqReadKeyValuePair(readerStream, true);
    ret.push(param.val);

    remainingBytes = remainingBytes - param.byteLength;
  }
  return ret;
}

async function moqReadKeyValuePair(
  readerStream: ReadableStream<Uint8Array>,
  isExtensionHeaders: boolean,
): Promise<{ val: KvPair; byteLength: number }> {
  const param: { val: KvPair; byteLength: number } = { val: undefined as unknown as KvPair, byteLength: 0 };

  const name = await varIntToNumberAndLengthOrThrow(readerStream);
  param.byteLength = param.byteLength + name.byteLength;

  if (name.num % 2 == 0) {
    // Even are followed by varint
    const intValue = await varIntToNumberAndLengthOrThrow(readerStream);
    param.byteLength = param.byteLength + intValue.byteLength;
    param.val = moqCreateKvPair(name.num, intValue.num);
  } else {
    // Odd are followed by length and buffer
    const size = await varIntToNumberAndLengthOrThrow(readerStream);
    param.byteLength = param.byteLength + size.byteLength;
    if (name.num == MOQ_PARAMETER_AUTHORIZATION_TOKEN && !isExtensionHeaders) {
      const token = await moqParseTokenBytes(readerStream, size.num);
      param.byteLength = param.byteLength + size.num;
      param.val = moqCreateKvPair(name.num, token);
    } else {
      const buffRet = await buffRead(readerStream, size.num);
      if (buffRet.eof) {
        throw new ReadStreamClosed(`Connection closed while reading data`);
      }
      param.byteLength = param.byteLength + size.num;
      param.val = moqCreateKvPair(name.num, buffRet.buff);
    }
  }
  return param;
}

function moqCreateUseValueTokenFromString(str: string): Token {
  return {
    aliasType: MOQ_TOKEN_USE_VALUE,
    tokenType: MOQ_TOKEN_TYPE_NEGOTIATED_OUT_OF_BAND,
    value: new TextEncoder().encode(str),
  };
}

function moqCreateTokenBytes(token: Token): Uint8Array {
  const msg: Array<Uint8Array | BufferSource> = [];

  if (token.aliasType != MOQ_TOKEN_USE_VALUE) {
    throw new Error('Only USE_VALUE token supported');
  }
  msg.push(numberToVarInt(token.aliasType));

  if (token.tokenType != MOQ_TOKEN_TYPE_NEGOTIATED_OUT_OF_BAND) {
    throw new Error('Only TYPE_NEGOTIATED_OUT_OF_BAND token type supported');
  }
  msg.push(numberToVarInt(token.tokenType));
  msg.push(token.value); // Already a buffer

  // Length
  const totalLength = getArrayBufferByteLength(msg);

  return concatBuffer([numberToVarInt(totalLength), ...msg]);
}

async function moqParseTokenBytes(
  readerStream: ReadableStream<Uint8Array>,
  total_size: number,
): Promise<Token> {
  const token = {} as Token;
  let remaining_size = total_size;
  const read_data_aliasType = await varIntToNumberAndLengthOrThrow(readerStream);
  token.aliasType = read_data_aliasType.num;
  remaining_size = remaining_size - read_data_aliasType.byteLength;
  if (token.aliasType != MOQ_TOKEN_USE_VALUE) {
    throw new Error('Only USE_VALUE token supported');
  }
  const read_data_tokenType = await varIntToNumberAndLengthOrThrow(readerStream);
  token.tokenType = read_data_tokenType.num;
  remaining_size = remaining_size - read_data_tokenType.byteLength;
  if (token.tokenType != MOQ_TOKEN_TYPE_NEGOTIATED_OUT_OF_BAND) {
    throw new Error('Only TYPE_NEGOTIATED_OUT_OF_BAND token type supported');
  }

  if (remaining_size > 0) {
    const buffRet = await buffRead(readerStream, remaining_size);
    if (buffRet.eof) {
      throw new ReadStreamClosed(`Connection closed while reading data`);
    }
    token.value = buffRet.buff;
  } else if (remaining_size < 0) {
    throw new Error('Corrupted token size');
  }

  return token;
}

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
    } else {
      return Promise.resolve();
    }
  });
}

export function getFullTrackName(ns: string[], name: string): string {
  return `[${ns.join('/')}]/${name}`;
}

export function getAuthInfofromParameters(parameters: KvPair[]): string | undefined {
  let ret: string | undefined = undefined;
  let i = 0;
  while (ret == undefined && i < parameters.length) {
    const param = parameters[i];
    if (param.name == MOQ_PARAMETER_AUTHORIZATION_TOKEN) {
      const token = param.val as Token;
      if (
        token.aliasType == MOQ_TOKEN_USE_VALUE &&
        token.tokenType == MOQ_TOKEN_TYPE_NEGOTIATED_OUT_OF_BAND
      ) {
        ret = new TextDecoder().decode(token.value);
      }
    }
    i++;
  }
  return ret;
}

export function moqDecodeDatagramType(type: number): DatagramTypeOptions {
  if (!isMoqObjectDatagramType(type)) {
    throw new Error(`No valid datagram type ${type}, it can NOT be decoded`);
  }
  const ret = {
    isStatus: false,
    extensionsPresent: false,
    isEndOfGroup: false,
    isObjIdPresent: false,
  };
  if (MOQ_MESSAGE_OBJECT_DATAGRAM_TYPES_STATUS.includes(type)) {
    ret.isStatus = true;
    ret.isObjIdPresent = true;
  } else {
    if (type == 0x2 || type == 0x3) {
      ret.isEndOfGroup = true;
    }
    if ((type & 0x4) == 0) {
      ret.isObjIdPresent = true;
    }
  }
  if ((type & 0x1) > 0) {
    ret.extensionsPresent = true;
  }
  return ret;
}

export function isMoqObjectDatagramType(type: number): boolean {
  return MOQ_MESSAGE_OBJECT_DATAGRAM_TYPES.includes(type);
}

export function isMoqObjectStreamHeaderType(type: number): boolean {
  return MOQ_MESSAGE_STREAM_HEADER_SUBGROUP_TYPES.includes(type);
}

function getDatagramType(
  isStatus: boolean,
  hasExternsionHeaders: boolean,
  isEndOfGroup: boolean,
): number {
  let type = 0;

  if (isStatus) {
    type = 0x20;
  } else {
    if (isEndOfGroup) {
      type = 0x2;
    } else {
      type = 0x1;
    }
  }
  if (hasExternsionHeaders) {
    type = type | 0x1;
  }
  return type;
}

function getSubgroupHeaderType(
  extensionsPresent: boolean,
  isEndOfGroup: boolean,
  subGroupIdPresent: boolean,
  isSubgroupIdFirstObjectId: boolean,
): number {
  let type = 0x10;
  if (isEndOfGroup) {
    type = type | 0x8;
  }
  if (subGroupIdPresent) {
    type = type | 0x4;
  }
  if (isSubgroupIdFirstObjectId) {
    type = type | 0x2;
  }
  if (extensionsPresent) {
    type = type | 0x1;
  }
  if (type == 0x16 || type == 0x17 || type > 0x1d) {
    throw new Error(`Subgroup header to create type ${type} does not make sense`);
  }
  return type;
}

export function moqDecodeStreamHeaderType(type: number): StreamHeaderOptions {
  if (!isMoqObjectStreamHeaderType(type)) {
    throw new Error(`No valid stream header type ${type}, it can NOT be decoded`);
  }
  if (type == 0x16 || type == 0x17 || type > 0x1d) {
    throw new Error(`Subgroup received header type ${type} does not make sense`);
  }
  const ret = {
    extensionsPresent: false,
    isEndOfGroup: false,
    subGroupIdPresent: false,
    isSubgroupIdFirstObjectId: false,
  };
  if ((type & 0x1) > 0) {
    ret.extensionsPresent = true;
  }
  if ((type & 0x2) > 0) {
    ret.isSubgroupIdFirstObjectId = true;
  }
  if ((type & 0x4) > 0) {
    ret.subGroupIdPresent = true;
  }
  if ((type & 0x8) > 0) {
    ret.isEndOfGroup = true;
  }
  return ret;
}

async function moqDecodeFilterLocation(readerStream: ReadableStream<Uint8Array>): Promise<Filter> {
  const ret = {} as Filter;

  ret.type = await varIntToNumberOrThrow(readerStream);
  if (
    ret.type != MOQ_FILTER_TYPE_ABSOLUTE_START &&
    ret.type != MOQ_FILTER_TYPE_ABSOLUTE_RANGE &&
    ret.type != MOQ_FILTER_TYPE_NEXT_GROUP_START &&
    ret.type != MOQ_FILTER_TYPE_LARGEST_OBJECT
  ) {
    throw new Error(`Not supported filter type ${ret.type}`);
  }
  if (ret.type === MOQ_FILTER_TYPE_ABSOLUTE_START || ret.type === MOQ_FILTER_TYPE_ABSOLUTE_RANGE) {
    ret.start = await moqDecodeLocation(readerStream);
  }
  if (ret.type === MOQ_FILTER_TYPE_ABSOLUTE_RANGE) {
    ret.end = {} as RangeEnd;
    ret.end.group = await varIntToNumberOrThrow(readerStream);
  }

  return ret;
}

async function moqDecodeLocation(readerStream: ReadableStream<Uint8Array>): Promise<Location> {
  const ret = {} as Location;

  ret.group = await varIntToNumberOrThrow(readerStream);
  ret.obj = await varIntToNumberOrThrow(readerStream);

  return ret;
}

function moqCreateLocationBytes(lastGroupSent: number, lastObjSent: number): Uint8Array {
  const msg: Uint8Array[] = [];

  // Final group
  msg.push(numberToVarInt(lastGroupSent));
  // Final object
  msg.push(numberToVarInt(lastObjSent));

  return concatBuffer(msg);
}
