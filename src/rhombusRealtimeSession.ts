import { RhombusH264StreamParser } from "./stream/rhombusH264StreamParser.js";

const RECONNECT_COMMAND_MS = 10_000;
const DEFAULT_MAX_RETRY_INTERVAL_MS = 30_000;
const INITIAL_RECONNECT_DELAY_MS = 2_000;
const DEFAULT_STALL_TIMEOUT_MS = 12_000;
const STALL_CHECK_INTERVAL_MS = 1_000;
const HEALTHY_PLAYBACK_RESET_MS = 30_000;
/** Max time to wait for `WebSocket.onopen` before treating the attempt as failed. */
const CONNECT_TIMEOUT_MS = 8_000;

export type RhombusRealtimeSessionOptions = {
  wsUrl: string;
  canvas: HTMLCanvasElement;
  onError: (error: Error) => void;
  onReady?: () => void;
  /**
   * Called before each auto-reconnect attempt (server-initiated reconnects, transport errors,
   * or stall-detected reconnects). `attempt` is a 1-based counter that resets after sustained
   * healthy playback (~30 s of decoded frames).
   */
  onRecoveryAttempt?: (attempt: number, error: Error) => void;
  /**
   * Ceiling for the reconnect backoff in milliseconds. Backoff doubles starting at 2 s
   * (2 → 4 → 8 → 16 → … → cap). Default {@link DEFAULT_MAX_RETRY_INTERVAL_MS} (30 s).
   * Set to `0` to disable auto-reconnect entirely.
   */
  maxRetryIntervalMs?: number;
  /**
   * Stall watchdog in milliseconds: if the WebSocket is open but no decoded video frame is
   * produced within this window, the SDK closes the socket and reconnects. Most "WAN live
   * black screen until refresh" cases are caught here. Default {@link DEFAULT_STALL_TIMEOUT_MS}
   * (12 s). Set to `0` to disable the watchdog.
   */
  stallTimeoutMs?: number;
};

/**
 * WebSocket H.264 realtime session using WebCodecs (main thread).
 * Mirrors Rhombus console RealtimeWebsocket + RealtimeDecoder behavior in simplified form.
 */
export function startRhombusRealtimeSession(options: RhombusRealtimeSessionOptions): () => void {
  const { canvas, onError, onReady, onRecoveryAttempt } = options;
  const wsUrl = options.wsUrl;
  const maxRetryIntervalMs = options.maxRetryIntervalMs ?? DEFAULT_MAX_RETRY_INTERVAL_MS;
  const stallTimeoutMs = options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
  const autoReconnectEnabled = maxRetryIntervalMs > 0;

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
  let reconnectTimeoutId: ReturnType<typeof setTimeout> | null = null;
  let connectTimeoutId: ReturnType<typeof setTimeout> | null = null;
  let stallIntervalId: ReturnType<typeof setInterval> | null = null;
  let healthyTimeoutId: ReturnType<typeof setTimeout> | null = null;

  let reconnectAttempt = 0;
  let reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
  let lastFrameAtMs = 0;

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
        lastFrameAtMs = Date.now();
        scheduleHealthyReset();
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

  const clearConnectTimeout = () => {
    if (connectTimeoutId != null) {
      clearTimeout(connectTimeoutId);
      connectTimeoutId = null;
    }
  };

  const clearReconnectTimeout = () => {
    if (reconnectTimeoutId != null) {
      clearTimeout(reconnectTimeoutId);
      reconnectTimeoutId = null;
    }
  };

  const clearStallChecker = () => {
    if (stallIntervalId != null) {
      clearInterval(stallIntervalId);
      stallIntervalId = null;
    }
  };

  const clearHealthyTimer = () => {
    if (healthyTimeoutId != null) {
      clearTimeout(healthyTimeoutId);
      healthyTimeoutId = null;
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
    clearConnectTimeout();
    clearReconnectTimeout();
    clearStallChecker();
    clearHealthyTimer();
    closeWebSocket();
    try {
      if (decoder.state !== "closed") {
        decoder.close();
      }
    } catch {
      /* ignore */
    }
  };

  function scheduleHealthyReset() {
    if (reconnectAttempt === 0 && reconnectDelayMs === INITIAL_RECONNECT_DELAY_MS) return;
    if (healthyTimeoutId != null) return;
    healthyTimeoutId = setTimeout(() => {
      healthyTimeoutId = null;
      if (destroyed) return;
      reconnectAttempt = 0;
      reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
    }, HEALTHY_PLAYBACK_RESET_MS);
  }

  function scheduleReconnect(error: Error) {
    if (destroyed) return;
    if (!autoReconnectEnabled) {
      onError(error);
      return;
    }
    if (reconnectTimeoutId != null) return;

    clearConnectTimeout();
    clearStallChecker();
    clearHealthyTimer();
    closeWebSocket();
    acceptDeltaFrame = false;

    const delay = reconnectDelayMs;
    reconnectDelayMs = Math.min(delay * 2, maxRetryIntervalMs);
    reconnectAttempt++;
    onError(error);
    onRecoveryAttempt?.(reconnectAttempt, error);

    reconnectTimeoutId = setTimeout(() => {
      reconnectTimeoutId = null;
      if (!destroyed) createWebSocket();
    }, delay);
  }

  function startStallChecker() {
    clearStallChecker();
    if (stallTimeoutMs <= 0) return;
    lastFrameAtMs = Date.now();
    stallIntervalId = setInterval(() => {
      if (destroyed) return;
      if (!webSocket || webSocket.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastFrameAtMs > stallTimeoutMs) {
        scheduleReconnect(
          new Error(`Realtime stream stalled for ${stallTimeoutMs}ms; reconnecting`)
        );
      }
    }, STALL_CHECK_INTERVAL_MS);
  }

  const handleTextCommand = (command: string) => {
    let cmd: { action?: string; width?: number; height?: number; framerate?: number };
    try {
      cmd = JSON.parse(command) as typeof cmd;
    } catch {
      return;
    }
    if (cmd.action === "reconnect") {
      // Server-initiated graceful reconnect: not a failure, so don't bump backoff.
      clearStallChecker();
      clearHealthyTimer();
      clearConnectTimeout();
      closeWebSocket();
      acceptDeltaFrame = false;
      clearReconnectTimeout();
      reconnectTimeoutId = setTimeout(() => {
        reconnectTimeoutId = null;
        if (!destroyed) createWebSocket();
      }, RECONNECT_COMMAND_MS);
      return;
    }
    if (cmd.action === "init" && typeof cmd.width === "number" && typeof cmd.height === "number") {
      canvas.width = cmd.width;
      canvas.height = cmd.height;
    }
  };

  let firstReadyFired = false;

  const createWebSocket = () => {
    if (destroyed) return;

    clearConnectTimeout();
    clearStallChecker();
    closeWebSocket();
    acceptDeltaFrame = false;

    let connected = false;
    const socket = new WebSocket(wsUrl);
    webSocket = socket;
    socket.binaryType = "arraybuffer";

    socket.onopen = () => {
      if (destroyed || webSocket !== socket) return;
      connected = true;
      clearConnectTimeout();
      startStallChecker();
      if (!firstReadyFired) {
        firstReadyFired = true;
        onReady?.();
      }
    };

    socket.onmessage = (event: MessageEvent) => {
      if (destroyed || webSocket !== socket) return;
      if (typeof event.data === "string") {
        handleTextCommand(event.data);
        return;
      }
      streamParser.parseMessage(event.data, decodeFrame);
    };

    socket.onerror = () => {
      if (destroyed || webSocket !== socket) return;
      // Some browsers fire onerror without onclose; only act on the post-connect case here
      // (pre-connect failures are caught by onclose / connect timeout below).
      if (connected) {
        scheduleReconnect(new Error("Realtime WebSocket transport error"));
      }
    };

    socket.onclose = (event: CloseEvent) => {
      if (destroyed || webSocket !== socket) return;
      const reason = event.reason ? `: ${event.reason}` : "";
      scheduleReconnect(
        new Error(
          `Realtime WebSocket closed (code ${event.code}${reason})`
        )
      );
    };

    connectTimeoutId = setTimeout(() => {
      connectTimeoutId = null;
      if (destroyed || webSocket !== socket) return;
      if (!connected) {
        scheduleReconnect(
          new Error(`Realtime WebSocket did not open within ${CONNECT_TIMEOUT_MS}ms`)
        );
      }
    }, CONNECT_TIMEOUT_MS);
  };

  createWebSocket();

  return destroy;
}
