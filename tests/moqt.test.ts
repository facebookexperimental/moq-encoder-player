/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import {
  moqCreate,
  moqCloseWrttingStreams,
  getTrackFullName,
  getFullTrackName,
  moqCreateKvPair,
  isMoqObjectDatagramType,
  isMoqObjectStreamHeaderType,
  moqDecodeDatagramType,
  moqDecodeStreamHeaderType,
  getAuthInfofromParameters,
  moqParseMsg,
  moqParseObjectHeader,
  moqParseObjectFromSubgroupHeader,
  moqSendClientSetup,
  moqSendSubscribe,
  moqSendSubscribeOk,
  moqSendPublish,
  moqSendPublishDone,
  moqSendRequestOk,
  moqSendRequestError,
  moqSendUnSubscribe,
  moqSendSubgroupHeader,
  moqSendObjectSubgroupToWriter,
  moqSendObjectEndOfGroupToWriter,
  moqSendObjectPerDatagramToWriter,
  MOQ_MESSAGE_CLIENT_SETUP,
  MOQ_MESSAGE_SERVER_SETUP,
  MOQ_MESSAGE_SUBSCRIBE,
  MOQ_MESSAGE_SUBSCRIBE_OK,
  MOQ_MESSAGE_PUBLISH,
  MOQ_MESSAGE_PUBLISH_OK,
  MOQ_MESSAGE_PUBLISH_DONE,
  MOQ_MESSAGE_REQUEST_OK,
  MOQ_MESSAGE_REQUEST_ERROR,
  MOQ_MESSAGE_UNSUBSCRIBE,
  MOQ_PARAMETER_SUBSCRIPTION_FILTER,
  MOQ_FORWARD_TRUE,
  MOQ_OBJ_STATUS_END_OF_GROUP,
  MOQ_EXT_HEADER_TYPE_MOQMI_MEDIA_TYPE,
  MOQ_EXT_HEADER_TYPE_MOQMI_VIDEO_H264_IN_AVCC_METADATA,
} from '../src/moq/moqt.js';
import { numberToVarInt, varIntToNumbeFromBuffer } from '../src/moq/varint.js';
import { numberTo2BytesArray } from '../src/moq/byte_utils.js';
import { concatBuffer, getArrayBufferByteLength } from '../src/moq/buffer_utils.js';

// The subgroup header type the encoder always emits (draft-16, no FIRST_OBJECT):
// extensions present + subgroup id present => 0x10 | 0x01 | 0x04 = 0x15
const SUBGROUP_HEADER_TYPE = 0x15;

// --- Test doubles ------------------------------------------------------------

function createCaptureStream() {
  const chunks: Uint8Array[] = [];
  const writer = {
    write(b: Uint8Array) {
      chunks.push(b);
      return Promise.resolve();
    },
    ready: Promise.resolve(),
    releaseLock() {},
    close() {
      return Promise.resolve();
    },
  };
  const writerStream = { getWriter: () => writer };
  return {
    writerStream: writerStream as unknown as WritableStream<Uint8Array>,
    writer: writer as unknown as WritableStreamDefaultWriter<Uint8Array>,
    getBytes: () => concatBuffer(chunks),
  };
}

function createByobReadable(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let pos = 0;
  const stream = {
    getReader() {
      return {
        read(view: Uint8Array) {
          const remaining = bytes.length - pos;
          const n = Math.min(view.byteLength, remaining);
          for (let i = 0; i < n; i++) {
            view[i] = bytes[pos + i];
          }
          pos += n;
          return Promise.resolve({
            value: new Uint8Array(view.buffer, view.byteOffset, n),
            done: n === 0,
          });
        },
        releaseLock() {},
        cancel() {
          return Promise.resolve();
        },
      };
    },
  };
  return stream as unknown as ReadableStream<Uint8Array>;
}

// Frame a control message: [type varint][u16 length][...body].
function frame(type: number, ...parts: (Uint8Array | ArrayBuffer)[]): Uint8Array {
  const len = getArrayBufferByteLength(parts);
  return concatBuffer([numberToVarInt(type), numberTo2BytesArray(len, false), ...parts]);
}

// --- Pure helpers ------------------------------------------------------------

describe('moqt pure helpers', () => {
  it('getTrackFullName / getFullTrackName / moqCreateKvPair', () => {
    expect(getTrackFullName('ns', 'track')).toBe('nstrack');
    expect(getFullTrackName(['a', 'b'], 'name')).toBe('[a/b]/name');
    expect(moqCreateKvPair(3, 7)).toEqual({ name: 3, val: 7 });
  });

  it('classifies datagram and subgroup stream types (draft-16 bit layout)', () => {
    expect(isMoqObjectDatagramType(0x0)).toBe(true);
    expect(isMoqObjectDatagramType(0x1)).toBe(true);
    expect(isMoqObjectDatagramType(0x20)).toBe(true);
    expect(isMoqObjectDatagramType(0x10)).toBe(false); // subgroup, not datagram
    expect(isMoqObjectDatagramType(0x22)).toBe(false); // STATUS + END_OF_GROUP invalid
    expect(isMoqObjectStreamHeaderType(0x10)).toBe(true);
    expect(isMoqObjectStreamHeaderType(SUBGROUP_HEADER_TYPE)).toBe(true);
    expect(isMoqObjectStreamHeaderType(0x1)).toBe(false);
    expect(isMoqObjectStreamHeaderType(0x16)).toBe(false); // reserved subgroup-id mode
    expect(isMoqObjectStreamHeaderType(0x50)).toBe(false); // draft-16 has no 0x50 range
  });

  it('getAuthInfofromParameters returns undefined when there is no auth token', () => {
    expect(getAuthInfofromParameters([])).toBeUndefined();
    expect(getAuthInfofromParameters([{ name: 99, val: 1 }])).toBeUndefined();
  });
});

describe('moqDecodeDatagramType (draft-16)', () => {
  it('decodes a plain object datagram', () => {
    expect(moqDecodeDatagramType(0x0)).toEqual({
      isStatus: false,
      extensionsPresent: false,
      isEndOfGroup: false,
      isObjIdPresent: true,
      isDefaultPriority: false,
    });
  });

  it('decodes extensions + end-of-group, and status', () => {
    const d = moqDecodeDatagramType(0x03); // EXTENSIONS | END_OF_GROUP
    expect(d.extensionsPresent).toBe(true);
    expect(d.isEndOfGroup).toBe(true);
    const s = moqDecodeDatagramType(0x20);
    expect(s.isStatus).toBe(true);
  });

  it('throws on a non-datagram type', () => {
    expect(() => moqDecodeDatagramType(0x10)).toThrow();
  });
});

describe('moqDecodeStreamHeaderType (draft-16)', () => {
  it('decodes the canonical subgroup header type 0x15', () => {
    expect(moqDecodeStreamHeaderType(SUBGROUP_HEADER_TYPE)).toEqual({
      extensionsPresent: true,
      isEndOfGroup: false,
      subGroupIdPresent: true,
      isSubgroupIdFirstObjectId: false,
      isDefaultPriority: false,
    });
  });

  it('throws on non-stream-header / reserved types', () => {
    expect(() => moqDecodeStreamHeaderType(0x1)).toThrow();
    expect(() => moqDecodeStreamHeaderType(0x16)).toThrow();
  });
});

// --- State lifecycle ---------------------------------------------------------

describe('moqCreate / moqCloseWrttingStreams', () => {
  it('moqCreate returns a clean initial state', () => {
    expect(moqCreate()).toEqual({
      wt: null,
      controlStream: null,
      controlWriter: null,
      controlReader: null,
      multiObjectWritter: {},
      datagramsReader: null,
    });
  });

  it('moqCloseWrttingStreams closes and clears all object writers', async () => {
    const closeA = jest.fn().mockResolvedValue(undefined);
    const closeB = jest.fn().mockResolvedValue(undefined);
    const moqt = moqCreate();
    moqt.multiObjectWritter = {
      a: { close: closeA } as unknown as WritableStreamDefaultWriter<Uint8Array>,
      b: { close: closeB } as unknown as WritableStreamDefaultWriter<Uint8Array>,
    };
    await moqCloseWrttingStreams(moqt);
    expect(closeA).toHaveBeenCalledTimes(1);
    expect(closeB).toHaveBeenCalledTimes(1);
    expect(moqt.multiObjectWritter).toEqual({});
  });
});

// --- Control message round trips via moqParseMsg -----------------------------

describe('control message round trips via moqParseMsg', () => {
  it('CLIENT_SETUP emits the CLIENT_SETUP type (no version field in draft-16)', async () => {
    const cap = createCaptureStream();
    await moqSendClientSetup(cap.writerStream);
    const bytes = cap.getBytes();
    expect(bytes[0]).toBe(MOQ_MESSAGE_CLIENT_SETUP); // 0x20 fits one varint byte
  });

  it('SERVER_SETUP parses (no version, empty params)', async () => {
    const parsed = await moqParseMsg(
      createByobReadable(frame(MOQ_MESSAGE_SERVER_SETUP, numberToVarInt(0))),
    );
    expect(parsed.type).toBe(MOQ_MESSAGE_SERVER_SETUP);
    expect(parsed.data.parameters).toEqual([]);
  });

  it('SUBSCRIBE round-trips, including the filter and auth token', async () => {
    const cap = createCaptureStream();
    await moqSendSubscribe(cap.writerStream, 42, ['ns', 'a'], 'video', 'secret');
    const parsed = await moqParseMsg(createByobReadable(cap.getBytes()));
    expect(parsed.type).toBe(MOQ_MESSAGE_SUBSCRIBE);
    expect(parsed.data.requestId).toBe(42);
    expect(parsed.data.namespace).toEqual(['ns', 'a']);
    expect(parsed.data.trackName).toBe('video');
    expect(
      parsed.data.parameters.some((p: any) => p.name === MOQ_PARAMETER_SUBSCRIPTION_FILTER),
    ).toBe(true);
    expect(getAuthInfofromParameters(parsed.data.parameters)).toBe('secret');
  });

  it('SUBSCRIBE without auth still carries the filter parameter', async () => {
    const cap = createCaptureStream();
    await moqSendSubscribe(cap.writerStream, 1, ['ns'], 'audio', undefined);
    const parsed = await moqParseMsg(createByobReadable(cap.getBytes()));
    expect(getAuthInfofromParameters(parsed.data.parameters)).toBeUndefined();
    expect(parsed.data.parameters).toHaveLength(1);
  });

  it('SUBSCRIBE_OK round-trips with a largest-object location', async () => {
    const cap = createCaptureStream();
    await moqSendSubscribeOk(cap.writerStream, 7, 99, 5, 3);
    const parsed = await moqParseMsg(createByobReadable(cap.getBytes()));
    expect(parsed.type).toBe(MOQ_MESSAGE_SUBSCRIBE_OK);
    expect(parsed.data.requestId).toBe(7);
    expect(parsed.data.trackAlias).toBe(99);
    expect(parsed.data.last).toEqual({ group: 5, obj: 3 });
  });

  it('SUBSCRIBE_OK without a location omits `last`', async () => {
    const cap = createCaptureStream();
    await moqSendSubscribeOk(cap.writerStream, 7, 99);
    const parsed = await moqParseMsg(createByobReadable(cap.getBytes()));
    expect(parsed.data.last).toBeUndefined();
  });

  it('PUBLISH round-trips, including the auth token', async () => {
    const cap = createCaptureStream();
    await moqSendPublish(cap.writerStream, 5, ['ns', 'x'], 'name', 77, 'secret', MOQ_FORWARD_TRUE);
    const parsed = await moqParseMsg(createByobReadable(cap.getBytes()));
    expect(parsed.type).toBe(MOQ_MESSAGE_PUBLISH);
    expect(parsed.data.requestId).toBe(5);
    expect(parsed.data.namespace).toEqual(['ns', 'x']);
    expect(parsed.data.trackName).toBe('name');
    expect(parsed.data.trackAlias).toBe(77);
    expect(getAuthInfofromParameters(parsed.data.parameters)).toBe('secret');
    expect(parsed.data.extensions).toEqual([]);
  });

  it('PUBLISH_OK parses', async () => {
    const parsed = await moqParseMsg(
      createByobReadable(frame(MOQ_MESSAGE_PUBLISH_OK, numberToVarInt(3), numberToVarInt(0))),
    );
    expect(parsed.type).toBe(MOQ_MESSAGE_PUBLISH_OK);
    expect(parsed.data.reqId).toBe(3);
    expect(parsed.data.parameters).toEqual([]);
  });

  it('PUBLISH_DONE round-trips', async () => {
    const cap = createCaptureStream();
    await moqSendPublishDone(cap.writerStream, 8, 2, 16, 'bye');
    const parsed = await moqParseMsg(createByobReadable(cap.getBytes()));
    expect(parsed.type).toBe(MOQ_MESSAGE_PUBLISH_DONE);
    expect(parsed.data.requestId).toBe(8);
    expect(parsed.data.statusCode).toBe(2);
    expect(parsed.data.streamCount).toBe(16);
    expect(parsed.data.errorReason).toBe('bye');
  });

  it('REQUEST_OK round-trips', async () => {
    const cap = createCaptureStream();
    await moqSendRequestOk(cap.writerStream, 12);
    const parsed = await moqParseMsg(createByobReadable(cap.getBytes()));
    expect(parsed.type).toBe(MOQ_MESSAGE_REQUEST_OK);
    expect(parsed.data.requestId).toBe(12);
    expect(parsed.data.parameters).toEqual([]);
  });

  it('REQUEST_ERROR round-trips', async () => {
    const cap = createCaptureStream();
    await moqSendRequestError(cap.writerStream, 11, 3, 'nope');
    const parsed = await moqParseMsg(createByobReadable(cap.getBytes()));
    expect(parsed.type).toBe(MOQ_MESSAGE_REQUEST_ERROR);
    expect(parsed.data.requestId).toBe(11);
    expect(parsed.data.errorCode).toBe(3);
    expect(parsed.data.retryInterval).toBe(0);
    expect(parsed.data.errorReason).toBe('nope');
  });

  it('UNSUBSCRIBE round-trips', async () => {
    const cap = createCaptureStream();
    await moqSendUnSubscribe(cap.writerStream, 1234);
    const parsed = await moqParseMsg(createByobReadable(cap.getBytes()));
    expect(parsed.type).toBe(MOQ_MESSAGE_UNSUBSCRIBE);
    expect(parsed.data.requestId).toBe(1234);
  });

  it('rejects a truncated stream', async () => {
    await expect(moqParseMsg(createByobReadable(new Uint8Array(0)))).rejects.toThrow();
  });
});

// --- Object/datagram path ----------------------------------------------------

describe('object and datagram headers (draft-16)', () => {
  it('subgroup header round-trips through moqParseObjectHeader', async () => {
    const cap = createCaptureStream();
    await moqSendSubgroupHeader(cap.writer, 50, 9, 0x0a);
    const parsed = await moqParseObjectHeader(createByobReadable(cap.getBytes()));
    expect(parsed.type).toBe(SUBGROUP_HEADER_TYPE);
    expect(parsed.trackAlias).toBe(50);
    expect(parsed.groupSeq).toBe(9);
    expect(parsed.subGroupSeq).toBe(9);
    expect(parsed.publisherPriority).toBe(0x0a);
    expect(parsed.options.extensionsPresent).toBe(true);
  });

  it('subgroup object round-trips through moqParseObjectFromSubgroupHeader', async () => {
    const cap = createCaptureStream();
    await moqSendObjectSubgroupToWriter(cap.writer, 4, new Uint8Array([1, 2, 3]), []);
    const parsed = await moqParseObjectFromSubgroupHeader(
      createByobReadable(cap.getBytes()),
      SUBGROUP_HEADER_TYPE,
    );
    expect(parsed.objSeq).toBe(4);
    expect(parsed.payloadLength).toBe(3);
    expect(parsed.extensionHeaders).toEqual([]);
    expect(parsed.status).toBeUndefined();
  });

  it('end-of-group object carries the END_OF_GROUP status', async () => {
    const cap = createCaptureStream();
    await moqSendObjectEndOfGroupToWriter(cap.writer, 0, [], false);
    const parsed = await moqParseObjectFromSubgroupHeader(
      createByobReadable(cap.getBytes()),
      SUBGROUP_HEADER_TYPE,
    );
    expect(parsed.payloadLength).toBe(0);
    expect(parsed.status).toBe(MOQ_OBJ_STATUS_END_OF_GROUP);
  });

  it('per-datagram object (with extensions) round-trips its header', async () => {
    const cap = createCaptureStream();
    const ext = [moqCreateKvPair(MOQ_EXT_HEADER_TYPE_MOQMI_MEDIA_TYPE, 5)];
    await moqSendObjectPerDatagramToWriter(
      cap.writer,
      12,
      3,
      4,
      0x0a,
      new Uint8Array([9, 9]),
      ext,
      false,
    );
    const parsed = await moqParseObjectHeader(createByobReadable(cap.getBytes()));
    expect(parsed.trackAlias).toBe(12);
    expect(parsed.groupSeq).toBe(3);
    expect(parsed.objSeq).toBe(4);
    expect(parsed.publisherPriority).toBe(0x0a);
    expect(parsed.options.extensionsPresent).toBe(true);
    expect(parsed.extensionHeaders).toEqual([
      { name: MOQ_EXT_HEADER_TYPE_MOQMI_MEDIA_TYPE, val: 5 },
    ]);
  });

  it('moqParseObjectHeader throws on an unknown object type', async () => {
    await expect(moqParseObjectHeader(createByobReadable(numberToVarInt(0x7f)))).rejects.toThrow();
  });

  // Regression: odd-typed extension header values must decode to an ArrayBuffer,
  // since the MoQMI packager reads them via varIntToNumbeFromBuffer / DataView.
  it('decodes odd-typed extension header values as an ArrayBuffer', async () => {
    const cap = createCaptureStream();
    const blob = concatBuffer([numberToVarInt(7), numberToVarInt(258)]); // two varints
    const ext = [moqCreateKvPair(MOQ_EXT_HEADER_TYPE_MOQMI_VIDEO_H264_IN_AVCC_METADATA, blob)];
    await moqSendObjectSubgroupToWriter(cap.writer, 0, new Uint8Array([1]), ext);

    const parsed = await moqParseObjectFromSubgroupHeader(
      createByobReadable(cap.getBytes()),
      SUBGROUP_HEADER_TYPE,
    );
    expect(parsed.extensionHeaders).toHaveLength(1);
    const val = parsed.extensionHeaders[0].val as ArrayBuffer;
    expect(val instanceof ArrayBuffer).toBe(true);
    const r0 = varIntToNumbeFromBuffer(val, 0);
    expect(r0.num).toBe(7);
    expect(varIntToNumbeFromBuffer(val, r0.byteLength).num).toBe(258);
  });
});
