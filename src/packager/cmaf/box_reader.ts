/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

// Minimal ISOBMFF box walker, the read side of ./box_writer.ts. It only needs
// to find boxes and hand back their payload; parsing the payload itself is the
// caller's job (see ./cmaf_depackager.ts).

/** One box: its type, where it starts, and the bytes after its header. */
export interface Box {
  type: string;
  // Offset of the box header inside the buffer it was parsed from.
  start: number;
  size: number;
  payload: Uint8Array;
}

// Boxes whose children do not start at the beginning of the payload: `stsd` has
// a FullBox header + entry_count, and a sample entry has its fixed fields
// before the codec configuration box.
const CHILD_OFFSETS: Record<string, number> = {
  stsd: 8,
  avc1: 78,
  avc3: 78,
  Opus: 28,
  mp4a: 28,
};

/**
 * Top-level boxes of a buffer. Stops at the first malformed / truncated box
 * rather than throwing: a partially received object still yields the boxes that
 * did arrive.
 */
export function parseBoxes(buf: Uint8Array): Box[] {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const boxes: Box[] = [];
  let pos = 0;
  while (pos + 8 <= buf.byteLength) {
    let size = view.getUint32(pos);
    let headerLength = 8;
    if (size === 1) {
      // 64 bit largesize, in the 8 bytes after the type.
      if (pos + 16 > buf.byteLength) {
        break;
      }
      size = Number(view.getBigUint64(pos + 8));
      headerLength = 16;
    } else if (size === 0) {
      // "Box extends to the end of the buffer".
      size = buf.byteLength - pos;
    }
    if (size < headerLength || pos + size > buf.byteLength) {
      break;
    }
    boxes.push({
      type: new TextDecoder().decode(buf.subarray(pos + 4, pos + 8)),
      start: pos,
      size,
      payload: buf.subarray(pos + headerLength, pos + size),
    });
    pos += size;
  }
  return boxes;
}

/** Boxes contained in a container box (or in a sample entry). */
export function childBoxes(box: Box): Box[] {
  return parseBoxes(box.payload.subarray(CHILD_OFFSETS[box.type] ?? 0));
}

/**
 * Look a box up by a '/' separated path, e.g. 'moov/trak/mdia/mdhd'.
 * Returns undefined when any step of the path is missing.
 */
export function findBox(buf: Uint8Array, path: string): Box | undefined {
  const types = path.split('/');
  let boxes = parseBoxes(buf);
  let found: Box | undefined;
  for (let i = 0; i < types.length; i++) {
    found = boxes.find((b) => b.type === types[i]);
    if (found === undefined) {
      return undefined;
    }
    if (i < types.length - 1) {
      boxes = childBoxes(found);
    }
  }
  return found;
}
