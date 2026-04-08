import { parseRhombusH264BinaryMessage } from "./parseRhombusH264Binary.js";

/**
 * Wraps {@link parseRhombusH264BinaryMessage} with third-party timestamp alignment for b-frames.
 */
export class RhombusH264StreamParser {
  private rhombusKeyframeTimestamp = 0;
  private thirdPartyKeyframeTimestamp = 0;

  parseMessage(
    data: ArrayBufferLike,
    onFrame: (data: Uint8Array, timestamp: number) => void,
    onTimestamp?: (ts: number) => void,
    log?: (...args: unknown[]) => void
  ): number {
    const onFrameWrapper = (
      frameData: Uint8Array,
      timestamp: number,
      thirdPartyTimestamp: number,
      isKeyFrame: boolean
    ) => {
      if (!thirdPartyTimestamp) {
        onFrame(frameData, timestamp);
      } else if (isKeyFrame) {
        this.rhombusKeyframeTimestamp = timestamp;
        this.thirdPartyKeyframeTimestamp = thirdPartyTimestamp;
        onFrame(frameData, timestamp);
      } else {
        const adjustedTs =
          this.rhombusKeyframeTimestamp +
          (thirdPartyTimestamp - this.thirdPartyKeyframeTimestamp);
        onFrame(frameData, adjustedTs);
      }
    };
    return parseRhombusH264BinaryMessage(data, onFrameWrapper, onTimestamp, log);
  }
}
