/**
 * Parses Rhombus H.264 TLV messages (WebSocket or HTTP chunk stream).
 * Each message may contain multiple timestamps and NAL units.
 * @returns Timestamp from the last 0x02 block in this chunk (ms from firmware).
 */
export function parseRhombusH264BinaryMessage(
  data: ArrayBufferLike,
  onFrame: (
    data: Uint8Array,
    timestamp: number,
    thirdPartyTimestamp: number,
    isKeyframe: boolean
  ) => void,
  onTimestamp?: (ts: number) => void,
  log?: (...args: unknown[]) => void
): number {
  const stream = new Uint8Array(data);
  let nalFrameCount = 0;

  let index = 0;
  let ts = 0;
  let tts = 0;
  while (index < stream.length) {
    const tlvType = stream[index];
    let tlvLen = 0;
    index++;
    if (stream.length - index >= 3) {
      tlvLen =
        ((stream[index] & 0xff) << 16) |
        ((stream[index + 1] & 0xff) << 8) |
        (stream[index + 2] & 0xff);
      index += 3;

      if (stream.length - index >= tlvLen) {
        if (tlvType === 0x00 || tlvType === 0x01) {
          onFrame(stream.subarray(index, index + tlvLen), ts, tts, tlvType === 0);
          nalFrameCount++;
        } else if (tlvType === 0x02) {
          ts = parseEightByteInt(stream, index);
          onTimestamp?.(ts);
        } else if (tlvType === 0x03) {
          tts = parseEightByteInt(stream, index) / 1000;
        }
        index += tlvLen;
      } else {
        log?.(
          `Only ${stream.length - index} bytes left in stream and expected ${tlvLen} byte value`
        );
        index = stream.length;
      }
    } else {
      log?.(`Only ${stream.length - index} bytes left in stream and expected 3 byte length`);
      index = stream.length;
    }
  }

  if (nalFrameCount > 1) {
    log?.(`${stream.length} byte WS message contained ${nalFrameCount} NAL frames`);
  }

  return ts;
}

function parseEightByteInt(stream: Uint8Array, index: number): number {
  let ts = 0;
  ts += 2 ** 56 * stream[index]!;
  ts += 2 ** 48 * stream[index + 1]!;
  ts += 2 ** 40 * stream[index + 2]!;
  ts += 2 ** 32 * stream[index + 3]!;
  ts += 2 ** 24 * stream[index + 4]!;
  ts += 2 ** 16 * stream[index + 5]!;
  ts += 2 ** 8 * stream[index + 6]!;
  ts += stream[index + 7]!;
  return ts;
}
