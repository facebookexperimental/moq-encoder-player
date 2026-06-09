# `src/utils/moqt.ts` review

Review of the partial MoQ Transport implementation in `src/utils/moqt.ts`
(targets `draft-ietf-moq-transport-14`, `MOQ_CURRENT_VERSION = 0xff00000e`).

Scope of the accompanying change was **types + tests only** — everything below
is documented but intentionally **not** fixed, to keep the emitted JavaScript
byte-for-byte identical. Each item notes severity and a suggested follow-up.

## Correctness findings

### 1. Datagram type 0x1 cannot express "no extensions" — extension bit collision
**Severity: medium (latent interop bug).**
`getDatagramType()` uses `0x1` as the base type for a normal (non-status,
non-end-of-group) object datagram, then sets the extension flag with `type |= 0x1`:

```ts
if (isStatus) type = 0x20;
else type = isEndOfGroup ? 0x2 : 0x1;   // base already has bit0 set
if (hasExternsionHeaders) type |= 0x1;  // no-op for the 0x1 base
```

But `moqDecodeDatagramType()` treats **bit 0 as "extensions present"**. So:

| has ext | end-of-group | encoded type | decoded `extensionsPresent` |
|--------|--------------|--------------|------------------------------|
| no     | no           | `0x1`        | **true** ❌                  |
| yes    | no           | `0x1`        | true ✅                      |

Encoding a normal datagram **without** extension headers produces `0x1`, which
the decoder reads as "extensions present" and then consumes the following bytes
(the object payload) as an extension block — corrupting the parse. A datagram
only round-trips when extension headers are actually present. (Verified in
`tests/moqt.test.ts`, which therefore round-trips the per-datagram case *with*
an extension header.) The subgroup path is unaffected because it always writes
an explicit extension-length prefix.
**Follow-up:** align `getDatagramType` with the draft type table (normal base
`0x0`, end-of-group `0x2`, OR-in `0x1` for extensions) and re-verify against
`moqDecodeDatagramType`.

### 2. `MOQ_MESSAGE_PUBLISH_DONE` and `MOQ_MESSAGE_SUBSCRIBE_DONE` share value `0xb`
**Severity: low/medium (confirm against spec).**
Both constants are `0xb`. `moqParseMsg` maps `0xb → moqParsePublishDone`, so a
`SUBSCRIBE_DONE` would never reach a subscribe-specific parser.
**Follow-up:** confirm the draft-14 code points; if they genuinely differ,
disambiguate; if they're the same message, drop the duplicate constant.

### 3. End-of-group datagram is encoded as a *status* datagram when it has no payload
**Severity: low.**
`moqCreateObjectPerDatagramBytes` derives `isStatus = !hasData` and passes it to
`getDatagramType`, which ignores `isEndOfGroup` whenever `isStatus` is true. A
payload-less end-of-group datagram therefore becomes a status type (`0x20/0x21`)
rather than an end-of-group type (`0x2/0x3`), despite the `isEndOfFGroup`
argument. Today the only end-of-group sender uses the subgroup-stream path, so
this is latent.

### 4. Message length prefix is read but never used to bound parsing
**Severity: low (robustness).**
Every `moqParse*` starts with `await moqIntReadBytesOrThrow(readerStream, 2); //
Length` and discards the result. Because the length is not used to delimit the
message, a malformed or over-long field reads straight into the next message on
the control stream instead of failing cleanly.
**Follow-up:** read the declared length into a bounded sub-reader (or validate
bytes-consumed against it) so a bad message can't desynchronize the stream.

### 5. `moqIntReadBytesOrThrow` has an implicit `undefined` return path
**Severity: low (latent).**
Signature is `Promise<number>`, but the guard only rejects `length < 0`; calling
it with `length === 0` falls through all `if` branches and resolves to
`undefined`. Safe today (every caller passes 1–4). Kept typed as
`Promise<number>` to match the declared contract.

### 6. `subscribeUpdate` parser is missing `publisherRequestId`
**Severity: low (confirm against spec).**
`src/sender/moq_sender.ts` reads `subscribeUpdate.publisherRequestId`, but
`moqParseSubscribeUpdate` never populates it (it reads `requestId` and
`subscriptionRequestId` only). Either the field is absent from the wire parse or
the caller field name is wrong. Surfaced while typing `MoqMessage.data`.

### 7. Latent caller bug surfaced by stricter `MoqtState.wt` typing (kept loose)
**Severity: low (out of scope to fix here).**
Typing `MoqtState.wt` as `WebTransport` makes the TypeScript compiler reject
`moq_sender.ts`:
```ts
moqt.wt.createUnidirectionalStream({ options: { sendOrder } })
```
`WebTransportSendStreamOptions` has no `options` member — the extra nesting means
`sendOrder` is silently ignored, so unidirectional stream send-order is never
actually applied. `wt` was left as `any` (with a comment) to avoid editing the
caller in this types-only change.
**Follow-up:** change the call to `createUnidirectionalStream({ sendOrder })` and
tighten `MoqtState.wt` to `WebTransport`.

## Performance suggestions (not applied)

- **Reuse `TextEncoder`/`TextDecoder`.** They are re-instantiated per call in
  `moqCreateStringBytes`, `moqStringReadOrThrow`, `moqCreateUseValueTokenFromString`,
  `moqParseTokenBytes`, and `getAuthInfofromParameters`. Hoist a single
  module-scoped instance of each.
- **Reduce allocations on the hot object path.** `moqCreateObjectSubgroupBytes`
  and `moqCreateObjectPerDatagramBytes` build many tiny `Uint8Array`s and then
  `concatBuffer` them (which iterates the array twice and allocates once more).
  For per-object encoding, writing varints directly into one pre-sized buffer
  would cut allocations. Measure before optimizing — control-message builders are
  cold and not worth changing.
- **`numberToVarInt` (in `varint.ts`)** allocates a `DataView` per call; minor,
  but it is on the per-object path.

## Simplification suggestions (not applied)

These reduce duplication without changing behavior:

- **Extract `moqCreateAuthParams(authInfo)`.** The block that builds the optional
  `MOQ_PARAMETER_AUTHORIZATION_TOKEN` parameter is duplicated verbatim in
  `moqCreatePublishMessageBytes`, `moqCreatePublishNamespaceMessageBytes`,
  `moqCreateSubscribeMessageBytes`, and `moqCreateSubscribeOkMessageBytes`.
- **Extract `moqFrameMessage(type, parts)`.** The framing tail
  `concatBuffer([numberToVarInt(type), numberTo2BytesArray(len, ...), ...parts])`
  is repeated in ~9 encoders (and mirrored by the `frame()` helper in the tests).
- **Extract `skipMessageLength(reader)`.** Replaces the repeated
  `await moqIntReadBytesOrThrow(readerStream, 2); // Length` at the top of every
  parser (and pairs naturally with finding #4).
- **Dispatch table for `moqParseMsg`.** The long `if/else if` chain on `msgType`
  could be a `Map<number, parser>` for readability (negligible perf impact).

## Typing notes (applied in this change)

- All `any` parameters/returns were replaced with concrete types or DOM stream
  types (`ReadableStream<Uint8Array>`, `WritableStream<Uint8Array>`,
  `WritableStreamDefaultWriter<Uint8Array>`), plus new exported interfaces:
  `KvPair`, `Token`, `Location`, `Filter`, `DatagramTypeOptions`,
  `StreamHeaderOptions`, the `Parsed*` message shapes, `ObjectHeader`, and
  `SubgroupObject`.
- Two boundaries were deliberately left permissive to avoid editing caller files
  (out of scope) and to match how callers actually consume the values:
  - `MoqMessage.data` is `any` — callers select fields by runtime `type` without
    narrowing. Each individual parser is still strongly typed.
  - `MoqtState.wt` is `any` — see finding #7.
- `authInfo` parameters are typed `string | number | undefined` because the
  keep-alive caller passes `0` to mean "no auth".
