// Binary frame for PTY data over MessagePort. The PTY Host posts these to a
// renderer port with the frame's underlying ArrayBuffer in the transfer list
// (`postMessage(frame, [frame])`), giving zero-copy delivery on the hot path —
// the bytes never touch the `main` thread and aren't structured-cloned.
//
// Layout (single contiguous ArrayBuffer, so exactly one transferable):
//   [0..4)             uint32 BE — paneId UTF-8 byte length
//   [4..4+idLen)       paneId UTF-8 bytes
//   [4+idLen..end)     payload bytes (raw PTY output, possibly multiple
//                                      coalesced chunks from PaneDataBuffer)
//
// Why not JSON / structured-clone:
//   - structured-cloning a {paneId,data} object would clone the Uint8Array
//     (copy its bytes), defeating the transfer optimization.
//   - One ArrayBuffer = one transfer list entry per flush — the renderer
//     receives the bytes as the same memory page the host wrote.

const HEADER_BYTES = 4;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

export function encodeFrame(paneId: string, payload: Uint8Array): ArrayBuffer {
  const idBytes = encoder.encode(paneId);
  const total = HEADER_BYTES + idBytes.byteLength + payload.byteLength;
  const ab = new ArrayBuffer(total);
  const view = new DataView(ab);
  view.setUint32(0, idBytes.byteLength, false);
  new Uint8Array(ab, HEADER_BYTES, idBytes.byteLength).set(idBytes);
  if (payload.byteLength > 0) {
    new Uint8Array(ab, HEADER_BYTES + idBytes.byteLength, payload.byteLength).set(payload);
  }
  return ab;
}

export interface DecodedFrame {
  readonly paneId: string;
  readonly payload: Uint8Array;
}

export function decodeFrame(ab: ArrayBuffer): DecodedFrame {
  const view = new DataView(ab);
  const idLen = view.getUint32(0, false);
  const idBytes = new Uint8Array(ab, HEADER_BYTES, idLen);
  const paneId = decoder.decode(idBytes);
  const payloadStart = HEADER_BYTES + idLen;
  // Subarray over the same ArrayBuffer — zero copy. Lifetime is tied to the
  // frame ArrayBuffer; renderer hands the view straight to xterm.write().
  const payload = new Uint8Array(ab, payloadStart, ab.byteLength - payloadStart);
  return { paneId, payload };
}
