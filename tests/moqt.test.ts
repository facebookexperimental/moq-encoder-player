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
  moqSendSetup,
  moqSendSubscribe,
  moqSendSubscribeOk,
  moqSendPublish,
  moqSendPublishDone,
  moqSendRequestOk,
  moqSendRequestError,
  moqSendSubgroupHeader,
  moqSendObjectSubgroupToWriter,
  moqSendObjectEndOfGroupToWriter,
  moqSendObjectPerDatagramToWriter,
  MOQ_MESSAGE_SETUP,
  MOQ_MESSAGE_SUBSCRIBE,
  MOQ_MESSAGE_SUBSCRIBE_OK,
  MOQ_MESSAGE_PUBLISH,
  MOQ_MESSAGE_PUBLISH_DONE,
  MOQ_MESSAGE_REQUEST_OK,
  MOQ_MESSAGE_REQUEST_ERROR,
  MOQ_PARAMETER_SUBSCRIPTION_FILTER,
  MOQ_FORWARD_TRUE,
  MOQ_OBJ_STATUS_END_OF_GROUP,
  MOQ_SETUP_OPTION_MOQT_IMPLEMENTATION,
  MOQ_IMPLEMENTATION_NAME,
} from '../src/moq/moqt.js';
import { concatBuffer } from '../src/moq/buffer_utils.js';

// The subgroup header type the encoder always emits:
// props present + subgroup id present + first object => 0x10|0x01|0x04|0x40 = 0x55
const SUBGROUP_HEADER_TYPE = 0x55;

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
  const writerStream = {
    getWriter() {
      return writer;
    },
  };
  return {
    writerStream: writerStream as unknown as WritableStream<Uint8Array>,
    writer: writer as unknown as WritableStreamDefaultWriter<Uint8Array>,
    getBytes: () => concatBuffer(chunks),
  };
}

// A ReadableStream-like double exposing a BYOB reader over a fixed byte array.
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

const decodeStr = (b: Uint8Array | ArrayBuffer) =>
  new TextDecoder().decode(b instanceof Uint8Array ? b : new Uint8Array(b));

// --- Pure helpers ------------------------------------------------------------

describe('moqt pure helpers', () => {
  it('getTrackFullName concatenates namespace and track name', () => {
    expect(getTrackFullName('ns', 'track')).toBe('nstrack');
  });

  it('getFullTrackName formats a tuple namespace', () => {
    expect(getFullTrackName(['a', 'b'], 'name')).toBe('[a/b]/name');
    expect(getFullTrackName([], 'name')).toBe('[]/name');
  });

  it('moqCreateKvPair builds a {name, val} pair', () => {
    expect(moqCreateKvPair(3, 7)).toEqual({ name: 3, val: 7 });
  });

  it('classifies datagram and subgroup stream types (draft-18 bit layout)', () => {
    expect(isMoqObjectDatagramType(0x0)).toBe(true);
    expect(isMoqObjectDatagramType(0x1)).toBe(true);
    expect(isMoqObjectDatagramType(0x20)).toBe(true);
    expect(isMoqObjectDatagramType(0x10)).toBe(false); // subgroup, not datagram
    expect(isMoqObjectDatagramType(0x22)).toBe(false); // STATUS + END_OF_GROUP invalid
    expect(isMoqObjectStreamHeaderType(0x10)).toBe(true);
    expect(isMoqObjectStreamHeaderType(SUBGROUP_HEADER_TYPE)).toBe(true);
    expect(isMoqObjectStreamHeaderType(0x1)).toBe(false);
    expect(isMoqObjectStreamHeaderType(0x16)).toBe(false); // reserved subgroup-id mode
  });

  it('getAuthInfofromParameters returns undefined when there is no auth token', () => {
    expect(getAuthInfofromParameters([])).toBeUndefined();
    expect(getAuthInfofromParameters([{ name: 99, val: 1 }])).toBeUndefined();
  });
});

describe('moqDecodeDatagramType (draft-18)', () => {
  it('decodes a plain object datagram', () => {
    expect(moqDecodeDatagramType(0x0)).toEqual({
      isStatus: false,
      extensionsPresent: false,
      isEndOfGroup: false,
      isObjIdPresent: true,
      isDefaultPriority: false,
    });
  });

  it('decodes the properties + end-of-group bits', () => {
    const d = moqDecodeDatagramType(0x03); // PROPERTIES | END_OF_GROUP
    expect(d.extensionsPresent).toBe(true);
    expect(d.isEndOfGroup).toBe(true);
    expect(d.isStatus).toBe(false);
  });

  it('decodes a status datagram', () => {
    const d = moqDecodeDatagramType(0x20);
    expect(d.isStatus).toBe(true);
    expect(d.isObjIdPresent).toBe(true);
  });

  it('throws on a non-datagram type', () => {
    expect(() => moqDecodeDatagramType(0x10)).toThrow();
  });
});

describe('moqDecodeStreamHeaderType (draft-18)', () => {
  it('decodes the canonical subgroup header type 0x55', () => {
    expect(moqDecodeStreamHeaderType(SUBGROUP_HEADER_TYPE)).toEqual({
      extensionsPresent: true,
      isEndOfGroup: false,
      subGroupIdPresent: true,
      isSubgroupIdFirstObjectId: false,
      isDefaultPriority: false,
      isFirstObject: true,
    });
  });

  it('throws on non-stream-header types and reserved subgroup-id mode', () => {
    expect(() => moqDecodeStreamHeaderType(0x1)).toThrow();
    expect(() => moqDecodeStreamHeaderType(0x16)).toThrow();
  });
});

// --- State lifecycle ---------------------------------------------------------

describe('moqCreate / moqCloseWrttingStreams', () => {
  it('moqCreate returns a clean initial state', () => {
    expect(moqCreate()).toEqual({
      wt: null,
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
  it('SETUP round-trips and carries the implementation option', async () => {
    const cap = createCaptureStream();
    await moqSendSetup(cap.writerStream);
    const parsed = await moqParseMsg(createByobReadable(cap.getBytes()));
    expect(parsed.type).toBe(MOQ_MESSAGE_SETUP);
    const impl = parsed.data.options.find(
      (o: any) => o.name === MOQ_SETUP_OPTION_MOQT_IMPLEMENTATION,
    );
    expect(impl).toBeDefined();
    expect(decodeStr(impl.val)).toBe(MOQ_IMPLEMENTATION_NAME);
  });

  it('SUBSCRIBE round-trips, including the largest-object filter and auth token', async () => {
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
    await moqSendSubscribeOk(cap.writerStream, 99, 5, 3);
    const parsed = await moqParseMsg(createByobReadable(cap.getBytes()));
    expect(parsed.type).toBe(MOQ_MESSAGE_SUBSCRIBE_OK);
    expect(parsed.data.trackAlias).toBe(99);
    expect(parsed.data.last).toEqual({ group: 5, obj: 3 });
  });

  it('SUBSCRIBE_OK without a location omits `last`', async () => {
    const cap = createCaptureStream();
    await moqSendSubscribeOk(cap.writerStream, 99);
    const parsed = await moqParseMsg(createByobReadable(cap.getBytes()));
    expect(parsed.data.trackAlias).toBe(99);
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
    expect(parsed.data.properties).toEqual([]);
  });

  it('PUBLISH_DONE round-trips', async () => {
    const cap = createCaptureStream();
    await moqSendPublishDone(cap.writerStream, 2, 16, 'bye');
    const parsed = await moqParseMsg(createByobReadable(cap.getBytes()));
    expect(parsed.type).toBe(MOQ_MESSAGE_PUBLISH_DONE);
    expect(parsed.data.statusCode).toBe(2);
    expect(parsed.data.streamCount).toBe(16);
    expect(parsed.data.errorReason).toBe('bye');
  });

  it('REQUEST_OK round-trips', async () => {
    const cap = createCaptureStream();
    await moqSendRequestOk(cap.writerStream);
    const parsed = await moqParseMsg(createByobReadable(cap.getBytes()));
    expect(parsed.type).toBe(MOQ_MESSAGE_REQUEST_OK);
    expect(parsed.data.parameters).toEqual([]);
    expect(parsed.data.properties).toEqual([]);
  });

  it('REQUEST_ERROR round-trips', async () => {
    const cap = createCaptureStream();
    await moqSendRequestError(cap.writerStream, 3, 'nope');
    const parsed = await moqParseMsg(createByobReadable(cap.getBytes()));
    expect(parsed.type).toBe(MOQ_MESSAGE_REQUEST_ERROR);
    expect(parsed.data.errorCode).toBe(3);
    expect(parsed.data.retryInterval).toBe(0);
    expect(parsed.data.errorReason).toBe('nope');
  });

  it('rejects a truncated stream', async () => {
    await expect(moqParseMsg(createByobReadable(new Uint8Array(0)))).rejects.toThrow();
  });
});

// --- Object/datagram path ----------------------------------------------------

describe('object and datagram headers (draft-18)', () => {
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
    const payload = new Uint8Array([1, 2, 3]);
    await moqSendObjectSubgroupToWriter(cap.writer, 4, payload, []);
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

  it('per-datagram object (with properties) round-trips its header', async () => {
    const cap = createCaptureStream();
    // An even property type carries a varint value (see encodeKvpValue).
    const PROPERTY_TYPE = 0x0a;
    const ext = [moqCreateKvPair(PROPERTY_TYPE, 5)];
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
      { name: PROPERTY_TYPE, val: 5 },
    ]);
  });

  it('moqParseObjectHeader throws on an unknown object type', async () => {
    const { numberToVarInt } = await import('../src/moq/varint.js');
    await expect(moqParseObjectHeader(createByobReadable(numberToVarInt(0x7f)))).rejects.toThrow();
  });
});
