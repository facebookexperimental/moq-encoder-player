/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import {
  // state / lifecycle
  moqCreate,
  moqCloseWrttingStreams,
  // pure helpers
  getTrackFullName,
  getFullTrackName,
  moqCreateKvPair,
  isMoqObjectDatagramType,
  isMoqObjectStreamHeaderType,
  moqDecodeDatagramType,
  moqDecodeStreamHeaderType,
  getAuthInfofromParameters,
  // parse
  moqParseMsg,
  moqParseObjectHeader,
  moqParseObjectFromSubgroupHeader,
  // send (encoders)
  moqSendClientSetup,
  moqSendPublish,
  moqSendPublishNamespace,
  moqSendPublishDone,
  moqSendSubscribe,
  moqSendSubscribeOk,
  moqSendSubscribeError,
  moqSendUnSubscribe,
  moqSendSubgroupHeader,
  moqSendObjectSubgroupToWriter,
  moqSendObjectEndOfGroupToWriter,
  moqSendObjectPerDatagramToWriter,
  // constants
  MOQ_CURRENT_VERSION,
  MOQ_DRAFT01_VERSION,
  MOQ_MESSAGE_CLIENT_SETUP,
  MOQ_MESSAGE_PUBLISH,
  MOQ_MESSAGE_PUBLISH_NAMESPACE,
  MOQ_MESSAGE_SUBSCRIBE,
  MOQ_MESSAGE_SUBSCRIBE_OK,
  MOQ_MESSAGE_SUBSCRIBE_ERROR,
  MOQ_MESSAGE_UNSUBSCRIBE,
  MOQ_MESSAGE_PUBLISH_DONE,
  MOQ_MESSAGE_SERVER_SETUP,
  MOQ_MESSAGE_PUBLISH_OK,
  MOQ_MESSAGE_PUBLISH_ERROR,
  MOQ_MESSAGE_SUBSCRIBE_UPDATE,
  MOQ_MESSAGE_PUBLISH_NAMESPACE_OK,
  MOQ_MESSAGE_PUBLISH_NAMESPACE_ERROR,
  MOQ_MAX_REQUEST_ID_NUM,
  MOQ_MAX_TUPLE_PARAMS,
  MOQ_GROUP_ORDER_ASCENDING,
  MOQ_GROUP_ORDER_FOLLOW_PUBLISHER,
  MOQ_GROUP_ORDER_DESCENDING,
  MOQ_FORWARD_TRUE,
  MOQ_FILTER_TYPE_LARGEST_OBJECT,
  MOQ_USECASE_SUBSCRIBER_PRIORITY_DEFAULT,
  MOQ_PARAMETER_AUTHORIZATION_TOKEN,
  MOQ_SETUP_PARAMETER_MAX_REQUEST_ID,
  MOQ_EXT_HEADER_TYPE_MOQMI_MEDIA_TYPE,
  MOQ_OBJ_STATUS_END_OF_GROUP,
  MOQ_TOKEN_DELETE,
} from '../src/utils/moqt.js';
import { numberToVarInt, varIntToNumbeFromBuffer } from '../src/utils/varint.js';
import { numberTo2BytesArray, numberToSingleByteArray } from '../src/utils/utils.js';
import { concatBuffer, getArrayBufferByteLength } from '../src/utils/buffer_utils.js';

// The subgroup header type the encoder always emits:
// getSubgroupHeaderType(extensions=true, endOfGroup=false, subGroupId=true, firstObjId=false)
const SUBGROUP_HEADER_TYPE = 0x15;

// --- Test doubles ------------------------------------------------------------

// A WritableStream-like double that records every chunk written through it.
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
// `varint.ts` / `buffer_utils.ts` read via getReader({ mode: 'byob' }).
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
          // done is true ONLY once the source is exhausted; the read that
          // delivers the last byte still returns done:false so the varint
          // reader does not mistake a complete read for EOF.
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

// Walks a captured byte buffer to assert encoder output field-by-field.
class ByteReader {
  private buf: Uint8Array;
  pos = 0;
  constructor(buf: Uint8Array) {
    this.buf = buf;
  }
  varint(): number {
    const r = varIntToNumbeFromBuffer(this.buf.buffer as ArrayBuffer, this.buf.byteOffset + this.pos);
    this.pos += r.byteLength;
    return r.num as number;
  }
  byte(): number {
    return this.buf[this.pos++];
  }
  u16(): number {
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 2).getUint16(0, false);
    this.pos += 2;
    return v;
  }
  string(): string {
    const len = this.varint();
    const s = new TextDecoder().decode(this.buf.subarray(this.pos, this.pos + len));
    this.pos += len;
    return s;
  }
  tuple(): string[] {
    const n = this.varint();
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      out.push(this.string());
    }
    return out;
  }
  remaining(): number {
    return this.buf.byteLength - this.pos;
  }
}

// Encode a length-prefixed string the way the wire format expects.
function strBytes(s: string): Uint8Array {
  const enc = new TextEncoder().encode(s);
  return concatBuffer([numberToVarInt(enc.byteLength), enc]);
}

// Frame a control message: [type][u16 length][...body].
function frame(type: number, ...parts: (Uint8Array | ArrayBuffer)[]): Uint8Array {
  const len = getArrayBufferByteLength(parts);
  return concatBuffer([numberToVarInt(type), numberTo2BytesArray(len, false), ...parts]);
}

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

  it('isMoqObjectDatagramType / isMoqObjectStreamHeaderType classify types', () => {
    expect(isMoqObjectDatagramType(0x1)).toBe(true);
    expect(isMoqObjectDatagramType(0x20)).toBe(true);
    expect(isMoqObjectDatagramType(0x99)).toBe(false);
    expect(isMoqObjectStreamHeaderType(0x10)).toBe(true);
    expect(isMoqObjectStreamHeaderType(SUBGROUP_HEADER_TYPE)).toBe(true);
    expect(isMoqObjectStreamHeaderType(0x1)).toBe(false);
  });
});

describe('moqDecodeDatagramType', () => {
  it('decodes a plain object datagram (with extensions bit)', () => {
    expect(moqDecodeDatagramType(0x1)).toEqual({
      isStatus: false,
      extensionsPresent: true,
      isEndOfGroup: false,
      isObjIdPresent: true,
    });
  });

  it('decodes an end-of-group datagram', () => {
    const d = moqDecodeDatagramType(0x2);
    expect(d.isEndOfGroup).toBe(true);
    expect(d.isObjIdPresent).toBe(true);
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

describe('moqDecodeStreamHeaderType', () => {
  it('decodes the canonical subgroup header type 0x15', () => {
    expect(moqDecodeStreamHeaderType(SUBGROUP_HEADER_TYPE)).toEqual({
      extensionsPresent: true,
      isEndOfGroup: false,
      subGroupIdPresent: true,
      isSubgroupIdFirstObjectId: false,
    });
  });

  it('throws on non-stream-header types', () => {
    expect(() => moqDecodeStreamHeaderType(0x1)).toThrow();
  });

  it('throws on reserved/invalid subgroup types (0x16, 0x17, > 0x1d)', () => {
    expect(() => moqDecodeStreamHeaderType(0x16)).toThrow();
    expect(() => moqDecodeStreamHeaderType(0x17)).toThrow();
    expect(() => moqDecodeStreamHeaderType(0x1e)).toThrow();
  });
});

describe('getAuthInfofromParameters', () => {
  it('returns undefined when there is no auth token', () => {
    expect(getAuthInfofromParameters([])).toBeUndefined();
    expect(getAuthInfofromParameters([{ name: 99, val: 1 }])).toBeUndefined();
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

// --- Encoder -> parser round trips (control messages) ------------------------

describe('control message round trips via moqParseMsg', () => {
  it('SUBSCRIBE round-trips, including the auth token', async () => {
    const cap = createCaptureStream();
    await moqSendSubscribe(cap.writerStream, 42, ['ns', 'a'], 'video', 'secret');
    const parsed = await moqParseMsg(createByobReadable(cap.getBytes()));

    expect(parsed.type).toBe(MOQ_MESSAGE_SUBSCRIBE);
    expect(parsed.data.requestId).toBe(42);
    expect(parsed.data.namespace).toEqual(['ns', 'a']);
    expect(parsed.data.trackName).toBe('video');
    expect(parsed.data.subscriberPriority).toBe(MOQ_USECASE_SUBSCRIBER_PRIORITY_DEFAULT);
    expect(parsed.data.groupOrder).toBe(MOQ_GROUP_ORDER_FOLLOW_PUBLISHER);
    expect(parsed.data.forward).toBe(MOQ_FORWARD_TRUE);
    expect(parsed.data.filter.type).toBe(MOQ_FILTER_TYPE_LARGEST_OBJECT);
    expect(getAuthInfofromParameters(parsed.data.parameters)).toBe('secret');
  });

  it('SUBSCRIBE without auth carries no parameters', async () => {
    const cap = createCaptureStream();
    await moqSendSubscribe(cap.writerStream, 1, ['ns'], 'audio', undefined);
    const parsed = await moqParseMsg(createByobReadable(cap.getBytes()));
    expect(parsed.data.parameters).toEqual([]);
    expect(getAuthInfofromParameters(parsed.data.parameters)).toBeUndefined();
  });

  it('SUBSCRIBE_OK round-trips with a content location', async () => {
    const cap = createCaptureStream();
    await moqSendSubscribeOk(cap.writerStream, 7, 99, 1000, 5, 3, undefined);
    const parsed = await moqParseMsg(createByobReadable(cap.getBytes()));

    expect(parsed.type).toBe(MOQ_MESSAGE_SUBSCRIBE_OK);
    expect(parsed.data.requestId).toBe(7);
    expect(parsed.data.trackAlias).toBe(99);
    expect(parsed.data.expires).toBe(1000);
    expect(parsed.data.groupOrder).toBe(MOQ_GROUP_ORDER_DESCENDING);
    expect(parsed.data.last).toEqual({ group: 5, obj: 3 });
  });

  it('SUBSCRIBE_OK without a location omits `last`', async () => {
    const cap = createCaptureStream();
    await moqSendSubscribeOk(cap.writerStream, 7, 99, 1000, undefined, undefined, undefined);
    const parsed = await moqParseMsg(createByobReadable(cap.getBytes()));
    expect(parsed.data.last).toBeUndefined();
  });

  it('SUBSCRIBE_ERROR round-trips', async () => {
    const cap = createCaptureStream();
    await moqSendSubscribeError(cap.writerStream, 11, 3, 'nope');
    const parsed = await moqParseMsg(createByobReadable(cap.getBytes()));
    expect(parsed.type).toBe(MOQ_MESSAGE_SUBSCRIBE_ERROR);
    expect(parsed.data.requestId).toBe(11);
    expect(parsed.data.errorCode).toBe(3);
    expect(parsed.data.errorReason).toBe('nope');
  });

  it('UNSUBSCRIBE round-trips', async () => {
    const cap = createCaptureStream();
    await moqSendUnSubscribe(cap.writerStream, 1234);
    const parsed = await moqParseMsg(createByobReadable(cap.getBytes()));
    expect(parsed.type).toBe(MOQ_MESSAGE_UNSUBSCRIBE);
    expect(parsed.data.subscriptionRequestId).toBe(1234);
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
});

// --- Encoders without a matching parser: structural byte assertions ----------

describe('control message encoders (structural)', () => {
  it('moqSendClientSetup emits version + max-request-id parameter', async () => {
    const cap = createCaptureStream();
    await moqSendClientSetup(cap.writerStream);
    const r = new ByteReader(cap.getBytes());

    expect(r.varint()).toBe(MOQ_MESSAGE_CLIENT_SETUP);
    const len = r.u16();
    const bodyStart = r.pos;
    expect(r.varint()).toBe(1); // number of supported versions
    expect(r.varint()).toBe(MOQ_CURRENT_VERSION);
    expect(r.varint()).toBe(1); // number of params
    expect(r.varint()).toBe(MOQ_SETUP_PARAMETER_MAX_REQUEST_ID);
    expect(r.varint()).toBe(MOQ_MAX_REQUEST_ID_NUM);
    expect(r.pos - bodyStart).toBe(len); // declared length matches the body
  });

  it('moqSendPublish emits the expected header fields', async () => {
    const cap = createCaptureStream();
    await moqSendPublish(cap.writerStream, 5, ['ns', 'x'], 'name', 77, undefined, MOQ_FORWARD_TRUE);
    const r = new ByteReader(cap.getBytes());

    expect(r.varint()).toBe(MOQ_MESSAGE_PUBLISH);
    r.u16(); // length
    expect(r.varint()).toBe(5); // requestId
    expect(r.tuple()).toEqual(['ns', 'x']); // namespace
    expect(r.string()).toBe('name'); // name
    expect(r.varint()).toBe(77); // trackAlias
    expect(r.byte()).toBe(MOQ_GROUP_ORDER_ASCENDING);
    expect(r.byte()).toBe(0); // context exists
    expect(r.byte()).toBe(MOQ_FORWARD_TRUE);
    expect(r.varint()).toBe(0); // params count (no auth)
  });

  it('moqSendPublishNamespace emits requestId + namespace', async () => {
    const cap = createCaptureStream();
    await moqSendPublishNamespace(cap.writerStream, 9, ['root', 'sub'], undefined);
    const r = new ByteReader(cap.getBytes());

    expect(r.varint()).toBe(MOQ_MESSAGE_PUBLISH_NAMESPACE);
    r.u16();
    expect(r.varint()).toBe(9);
    expect(r.tuple()).toEqual(['root', 'sub']);
    expect(r.varint()).toBe(0); // params count
  });

  it('moqSendPublish throws when the namespace tuple is too long', async () => {
    const cap = createCaptureStream();
    const tooLong = new Array(MOQ_MAX_TUPLE_PARAMS + 1).fill('x');
    await expect(
      moqSendPublish(cap.writerStream, 1, tooLong, 'n', 1, undefined, MOQ_FORWARD_TRUE),
    ).rejects.toThrow();
  });
});

// --- Parsers without an encoder: build wire bytes by hand --------------------

describe('parsers exercised with hand-built bytes', () => {
  it('SERVER_SETUP parses a supported version', async () => {
    const bytes = frame(MOQ_MESSAGE_SERVER_SETUP, numberToVarInt(MOQ_CURRENT_VERSION), numberToVarInt(0));
    const parsed = await moqParseMsg(createByobReadable(bytes));
    expect(parsed.type).toBe(MOQ_MESSAGE_SERVER_SETUP);
    expect(parsed.data.version).toBe(MOQ_CURRENT_VERSION);
    expect(parsed.data.parameters).toEqual([]);
  });

  it('SERVER_SETUP rejects an unsupported version', async () => {
    const bytes = frame(MOQ_MESSAGE_SERVER_SETUP, numberToVarInt(MOQ_DRAFT01_VERSION), numberToVarInt(0));
    await expect(moqParseMsg(createByobReadable(bytes))).rejects.toThrow();
  });

  it('PUBLISH_OK parses', async () => {
    const bytes = frame(
      MOQ_MESSAGE_PUBLISH_OK,
      numberToVarInt(3), // reqId
      numberToSingleByteArray(MOQ_FORWARD_TRUE), // forward
      numberToSingleByteArray(2), // subscriber priority
      numberToSingleByteArray(MOQ_GROUP_ORDER_ASCENDING), // group order
      numberToVarInt(MOQ_FILTER_TYPE_LARGEST_OBJECT), // filter
      numberToVarInt(0), // params
    );
    const parsed = await moqParseMsg(createByobReadable(bytes));
    expect(parsed.type).toBe(MOQ_MESSAGE_PUBLISH_OK);
    expect(parsed.data.reqId).toBe(3);
    expect(parsed.data.forward).toBe(MOQ_FORWARD_TRUE);
    expect(parsed.data.subscriberPriority).toBe(2);
    expect(parsed.data.groupOrder).toBe(MOQ_GROUP_ORDER_ASCENDING);
    expect(parsed.data.filter.type).toBe(MOQ_FILTER_TYPE_LARGEST_OBJECT);
  });

  it('PUBLISH_ERROR parses', async () => {
    const bytes = frame(
      MOQ_MESSAGE_PUBLISH_ERROR,
      numberToVarInt(4),
      numberToVarInt(7),
      strBytes('boom'),
    );
    const parsed = await moqParseMsg(createByobReadable(bytes));
    expect(parsed.type).toBe(MOQ_MESSAGE_PUBLISH_ERROR);
    expect(parsed.data.reqId).toBe(4);
    expect(parsed.data.errorCode).toBe(7);
    expect(parsed.data.reason).toBe('boom');
  });

  it('SUBSCRIBE_UPDATE parses start/end locations', async () => {
    const bytes = frame(
      MOQ_MESSAGE_SUBSCRIBE_UPDATE,
      numberToVarInt(1), // requestId
      numberToVarInt(2), // subscriptionRequestId
      numberToVarInt(10), // start.group
      numberToVarInt(20), // start.obj
      numberToVarInt(30), // end.group
      numberToSingleByteArray(4), // subscriber priority
      numberToSingleByteArray(MOQ_FORWARD_TRUE), // forward
      numberToVarInt(0), // params
    );
    const parsed = await moqParseMsg(createByobReadable(bytes));
    expect(parsed.type).toBe(MOQ_MESSAGE_SUBSCRIBE_UPDATE);
    expect(parsed.data.requestId).toBe(1);
    expect(parsed.data.subscriptionRequestId).toBe(2);
    expect(parsed.data.start).toEqual({ group: 10, obj: 20 });
    expect(parsed.data.end.group).toBe(30);
    expect(parsed.data.subscriberPriority).toBe(4);
    expect(parsed.data.forward).toBe(MOQ_FORWARD_TRUE);
  });

  it('PUBLISH_NAMESPACE_OK / _ERROR parse', async () => {
    const ok = await moqParseMsg(
      createByobReadable(frame(MOQ_MESSAGE_PUBLISH_NAMESPACE_OK, numberToVarInt(12))),
    );
    expect(ok.type).toBe(MOQ_MESSAGE_PUBLISH_NAMESPACE_OK);
    expect(ok.data.reqId).toBe(12);

    const err = await moqParseMsg(
      createByobReadable(
        frame(MOQ_MESSAGE_PUBLISH_NAMESPACE_ERROR, numberToVarInt(12), numberToVarInt(1), strBytes('no')),
      ),
    );
    expect(err.type).toBe(MOQ_MESSAGE_PUBLISH_NAMESPACE_ERROR);
    expect(err.data.reqId).toBe(12);
    expect(err.data.errorCode).toBe(1);
    expect(err.data.reason).toBe('no');
  });

  it('unknown message types fall through to the raw-data parser', async () => {
    // CLIENT_SETUP has no parser in moqParseMsg, so it hits moqParseUnknown.
    const parsed = await moqParseMsg(
      createByobReadable(frame(MOQ_MESSAGE_CLIENT_SETUP)),
    );
    expect(parsed.type).toBe(MOQ_MESSAGE_CLIENT_SETUP);
    expect(parsed.data.data).toBeDefined();
  });

  it('rejects a token whose alias type is not USE_VALUE', async () => {
    // SUBSCRIBE carrying one AUTH parameter holding a DELETE-alias token.
    const token = numberToVarInt(MOQ_TOKEN_DELETE); // first field read by the token parser
    const authParam = concatBuffer([
      numberToVarInt(MOQ_PARAMETER_AUTHORIZATION_TOKEN),
      numberToVarInt(token.byteLength),
      token,
    ]);
    const bytes = frame(
      MOQ_MESSAGE_SUBSCRIBE,
      numberToVarInt(1), // requestId
      numberToVarInt(0), // empty namespace tuple
      strBytes('t'), // track name
      numberToSingleByteArray(1), // subscriber priority
      numberToSingleByteArray(0), // group order
      numberToSingleByteArray(1), // forward
      numberToVarInt(MOQ_FILTER_TYPE_LARGEST_OBJECT),
      numberToVarInt(1), // 1 parameter
      authParam,
    );
    await expect(moqParseMsg(createByobReadable(bytes))).rejects.toThrow(/USE_VALUE/);
  });

  it('rejects a truncated stream', async () => {
    await expect(moqParseMsg(createByobReadable(new Uint8Array(0)))).rejects.toThrow();
  });
});

// --- Object/datagram path ----------------------------------------------------

describe('object and datagram headers', () => {
  it('subgroup header round-trips through moqParseObjectHeader', async () => {
    const cap = createCaptureStream();
    await moqSendSubgroupHeader(cap.writer, 50, 9, 0x0a);
    const parsed = await moqParseObjectHeader(createByobReadable(cap.getBytes()));

    expect(parsed.type).toBe(SUBGROUP_HEADER_TYPE);
    expect(parsed.trackAlias).toBe(50);
    expect(parsed.groupSeq).toBe(9);
    expect(parsed.subGroupSeq).toBe(9); // subgroup id mirrors group id
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
    await moqSendObjectEndOfGroupToWriter(cap.writer, 6, [], false);
    const parsed = await moqParseObjectFromSubgroupHeader(
      createByobReadable(cap.getBytes()),
      SUBGROUP_HEADER_TYPE,
    );

    expect(parsed.objSeq).toBe(6);
    expect(parsed.payloadLength).toBe(0);
    expect(parsed.status).toBe(MOQ_OBJ_STATUS_END_OF_GROUP);
  });

  it('per-datagram object (with extension headers) round-trips its header', async () => {
    const cap = createCaptureStream();
    const ext = [moqCreateKvPair(MOQ_EXT_HEADER_TYPE_MOQMI_MEDIA_TYPE, 5)];
    await moqSendObjectPerDatagramToWriter(
      cap.writer,
      12, // trackAlias
      3, // groupSeq
      4, // objSeq
      0x0a, // priority
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
});
