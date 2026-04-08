import { RhombusH264StreamParser } from "./stream/rhombusH264StreamParser.js";

const RECONNECT_COMMAND_MS = 10_000;
const CONNECT_POLL_MS = 5000;

export type RhombusRealtimeSessionOptions = {
  wsUrl: string;
  canvas: HTMLCanvasElement;
  onError: (error: Error) => void;
  onReady?: () => void;
};

/**
 * WebSocket H.264 realtime session using WebCodecs (main thread).
 * Mirrors Rhombus console RealtimeWebsocket + RealtimeDecoder behavior in simplified form.
 */
export function startRhombusRealtimeSession(options: RhombusRealtimeSessionOptions): () => void {
  const { canvas, onError, onReady } = options;
  const wsUrl = options.wsUrl;

  if (typeof VideoDecoder === "undefined") {
    onError(
      new Error(
        "WebCodecs VideoDecoder is not available in this browser. Use Chrome, Edge, or a recent Safari."
      )
    );
    return () => {};
  }

  let destroyed = false;
  let webSocket: WebSocket | null = null;
  let connectPollId: ReturnType<typeof setInterval> | null = null;
  let reconnectTimeoutId: ReturnType<typeof setTimeout> | null = null;

  const streamParser = new RhombusH264StreamParser();
  let acceptDeltaFrame = false;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    onError(new Error("Could not get 2d canvas context"));
    return () => {};
  }

  let decoder: VideoDecoder;
  try {
    decoder = new VideoDecoder({
      output: (frame: VideoFrame) => {
        if (destroyed) {
          frame.close();
          return;
        }
        if (frame.displayHeight !== canvas.height || frame.displayWidth !== canvas.width) {
          canvas.width = frame.displayWidth;
          canvas.height = frame.displayHeight;
        }
        ctx.drawImage(frame, 0, 0);
        frame.close();
      },
      error: e => {
        if (!destroyed) {
          onError(e instanceof Error ? e : new Error(String(e)));
        }
      },
    });
    decoder.configure({
      codec: "avc1.640032",
      hardwareAcceleration: "prefer-software",
      optimizeForLatency: true,
    });
  } catch (e) {
    onError(e instanceof Error ? e : new Error(String(e)));
    return () => {};
  }

  const decodeFrame = (data: Uint8Array, timestamp: number) => {
    if (destroyed || decoder.state === "closed") return;
    if (data.length < 5) return;

    const naluType = data[4]! & 0x1f;
    const isKeyFrame = naluType === 7;
    if (!acceptDeltaFrame) {
      if (!isKeyFrame) return;
      acceptDeltaFrame = true;
    }

    try {
      const chunk = new EncodedVideoChunk({
        timestamp: timestamp * 1000,
        type: isKeyFrame ? "key" : "delta",
        data,
      });
      decoder.decode(chunk);
    } catch (e) {
      if (!destroyed) {
        onError(e instanceof Error ? e : new Error(String(e)));
      }
    }
  };

  const clearConnectPoll = () => {
    if (connectPollId != null) {
      clearInterval(connectPollId);
      connectPollId = null;
    }
  };

  const closeWebSocket = () => {
    if (!webSocket) return;
    webSocket.onopen = null;
    webSocket.onmessage = null;
    webSocket.onclose = null;
    webSocket.onerror = null;
    try {
      webSocket.close(4001);
    } catch {
      /* ignore */
    }
    webSocket = null;
  };

  const destroy = () => {
    destroyed = true;
    clearConnectPoll();
    if (reconnectTimeoutId != null) {
      clearTimeout(reconnectTimeoutId);
      reconnectTimeoutId = null;
    }
    closeWebSocket();
    try {
      if (decoder.state !== "closed") {
        decoder.close();
      }
    } catch {
      /* ignore */
    }
  };

  const handleTextCommand = (command: string) => {
    let cmd: { action?: string; width?: number; height?: number; framerate?: number };
    try {
      cmd = JSON.parse(command) as typeof cmd;
    } catch {
      return;
    }
    if (cmd.action === "reconnect") {
      closeWebSocket();
      reconnectTimeoutId = setTimeout(() => {
        reconnectTimeoutId = null;
        if (!destroyed) {
          createWebSocket();
        }
      }, RECONNECT_COMMAND_MS);
      return;
    }
    if (cmd.action === "init" && typeof cmd.width === "number" && typeof cmd.height === "number") {
      canvas.width = cmd.width;
      canvas.height = cmd.height;
    }
  };

  let wsErrorReported = false;

  const createWebSocket = () => {
    if (destroyed) return;

    clearConnectPoll();
    closeWebSocket();

    let connected = false;
    const socket = new WebSocket(wsUrl);
    webSocket = socket;
    socket.binaryType = "arraybuffer";

    socket.onopen = () => {
      connected = true;
      clearConnectPoll();
      onReady?.();
    };

    socket.onmessage = (event: MessageEvent) => {
      if (destroyed) return;
      if (typeof event.data === "string") {
        handleTextCommand(event.data);
        return;
      }
      streamParser.parseMessage(event.data, decodeFrame);
    };

    socket.onerror = () => {
      if (!destroyed && !connected && !wsErrorReported) {
        wsErrorReported = true;
        onError(new Error("WebSocket connection error"));
      }
    };

    socket.onclose = () => {
      connected = false;
    };

    connectPollId = setInterval(() => {
      if (destroyed) {
        clearConnectPoll();
        return;
      }
      if (!connected && webSocket === socket) {
        closeWebSocket();
        createWebSocket();
      } else {
        clearConnectPoll();
      }
    }, CONNECT_POLL_MS);
  };

  createWebSocket();

  return destroy;
}
