import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  TalkbackPcmEncoder,
  buildTalkbackControlPacket,
  resolveAudioTalkbackUri,
  resolveTalkbackCapability,
} from "./audioTalkback.js";
import { RhombusMicrophoneControl } from "./RhombusMicrophoneControl.js";
import {
  DEFAULT_RHOMBUS_API_BASE_URL,
  fetchFederatedSessionToken,
  getBrowserOrigin,
  getFederatedTokenRefreshDelayMs,
  mergeRequestHeaders,
} from "./rhombusPlayback.js";
import type {
  RhombusMicrophonePermission,
  RhombusResolvedTalkbackInteractionMode,
  RhombusTalkbackBlockedReason,
  RhombusTalkbackCapability,
  RhombusTalkbackHandle,
  RhombusTalkbackProps,
  RhombusTalkbackState,
  RhombusTalkbackStatus,
} from "./types.js";
import { getRhombusPlaybackControllerInternals } from "./useRhombusPlaybackController.js";
import { joinUrl } from "./urlAuth.js";
import { withFederatedAudioAuth } from "./audioPlayback.js";

const INITIAL_RETRY_MS = 2_000;
const MAX_PENDING_FRAMES = 10;
// Match Rhombus Console's established talk-down gain.
const DEFAULT_MICROPHONE_GAIN = 6.623413251903491;
let talkbackSequence = 0;

type MicrophoneCapture = {
  destroy: () => Promise<void>;
};

export const RhombusTalkback = forwardRef<
  RhombusTalkbackHandle,
  RhombusTalkbackProps
>(function RhombusTalkback(props, ref) {
  const {
    source,
    connectionMode = "wan",
    playbackController,
    viewingMode: explicitViewingMode,
    disableTalkbackInVod = false,
    interactionMode: requestedInteractionMode = "auto",
    disabled = false,
    microphoneGain = DEFAULT_MICROPHONE_GAIN,
    microphoneConstraints,
    capability: providedCapability,
    className,
    style,
    classNames,
    styles,
    renderControl,
    maxRetryIntervalMs = 30_000,
  } = props;

  const propsRef = useRef(props);
  propsRef.current = props;
  const talkbackIdRef = useRef<string>();
  if (!talkbackIdRef.current) {
    talkbackSequence++;
    talkbackIdRef.current = `rhombus-talkback-${talkbackSequence}`;
  }
  const talkbackId = talkbackIdRef.current;

  const viewingMode =
    playbackController?.state.mode ?? explicitViewingMode ?? "live";
  const capabilitySourceKey = `${source.type}:${source.uuid}`;
  const mediaSourceKey = `${capabilitySourceKey}:${connectionMode}`;
  const controllerInternals = playbackController
    ? getRhombusPlaybackControllerInternals(playbackController)
    : null;

  const [fetchedCapability, setFetchedCapability] = useState<{
    sourceKey: string;
    value: RhombusTalkbackCapability;
  } | null>(null);
  const capability =
    providedCapability ??
    (fetchedCapability?.sourceKey === capabilitySourceKey
      ? fetchedCapability.value
      : null);
  const capabilityAllowsTalk = Boolean(
    capability?.canTalk &&
      capability.authorized &&
      capability.licensed &&
      capability.speakerEnabled &&
      capability.connected !== false
  );
  const [localStatus, setLocalStatus] =
    useState<RhombusTalkbackStatus>("loading-capability");
  const [talking, setTalking] = useState(false);
  const talkingRef = useRef(false);
  const [microphonePermission, setMicrophonePermission] =
    useState<RhombusMicrophonePermission>("unknown");
  const [requestHeaders, setRequestHeaders] = useState<HeadersInit>();
  const [token, setToken] = useState(props.federatedSessionToken ?? "");
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const [mediaRefreshKey, setMediaRefreshKey] = useState(0);
  const mediaResolutionKey = `${mediaSourceKey}:${mediaRefreshKey}`;
  const [resolvedMedia, setResolvedMedia] = useState<{
    sourceKey: string;
    uri: string;
  } | null>(null);
  const talkbackUri =
    resolvedMedia?.sourceKey === mediaResolutionKey ? resolvedMedia.uri : "";
  const talkbackUriRef = useRef(talkbackUri);
  talkbackUriRef.current = talkbackUri;

  const intentRef = useRef(false);
  const generationRef = useRef(0);
  const currentMediaSourceKeyRef = useRef(mediaSourceKey);
  currentMediaSourceKeyRef.current = mediaSourceKey;
  const activeMediaSourceKeyRef = useRef("");
  const socketRef = useRef<WebSocket | null>(null);
  const captureRef = useRef<MicrophoneCapture | null>(null);
  const captureReadyRef = useRef(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const retryMsRef = useRef(INITIAL_RETRY_MS);
  const attemptRef = useRef(0);
  const didSendControlRef = useRef(false);
  const pendingFramesRef = useRef<Int16Array[]>([]);
  const stateRef = useRef<RhombusTalkbackState>();

  const reportError = useCallback((error: unknown) => {
    const normalized =
      error instanceof Error ? error : new Error(String(error));
    setLocalStatus("error");
    propsRef.current.onError?.(normalized);
  }, []);

  useEffect(() => {
    if (
      playbackController &&
      explicitViewingMode !== undefined &&
      typeof console !== "undefined"
    ) {
      console.warn(
        "[RhombusTalkback] playbackController overrides viewingMode"
      );
    }
  }, [explicitViewingMode, playbackController]);
  useEffect(() => {
    if (
      disableTalkbackInVod &&
      !playbackController &&
      explicitViewingMode === undefined &&
      typeof console !== "undefined"
    ) {
      console.warn(
        "[RhombusTalkback] disableTalkbackInVod requires playbackController or viewingMode"
      );
    }
  }, [
    disableTalkbackInVod,
    explicitViewingMode,
    playbackController,
  ]);

  useEffect(() => {
    if (!controllerInternals) return;
    return controllerInternals.registerTalkback(talkbackId, source);
  }, [controllerInternals, source.type, source.uuid, talkbackId]);
  useEffect(() => {
    controllerInternals?.updateTalkback(
      talkbackId,
      source,
      talking
    );
  }, [
    controllerInternals,
    source.type,
    source.uuid,
    talking,
    talkbackId,
  ]);

  useEffect(() => {
    if (providedCapability) {
      return;
    }
    const base = props.apiOverrideBaseUrl?.trim();
    if (!base) {
      setFetchedCapability(null);
      reportError(
        new Error(
          "RhombusTalkback requires apiOverrideBaseUrl and an application-owned audio talkback capability proxy"
        )
      );
      return;
    }
    let cancelled = false;
    const abort = new AbortController();
    setLocalStatus("loading-capability");
    void mergeRequestHeaders(props.headers, props.getRequestHeaders)
      .then(headers => {
        if (cancelled) return null;
        setRequestHeaders(headers);
        return resolveTalkbackCapability({
          source,
          apiOverrideBaseUrl: base,
          path: props.paths?.audioTalkbackCapabilities,
          requestHeaders: headers,
          signal: abort.signal,
        });
      })
      .then(resolved => {
        if (!cancelled && resolved) {
          setFetchedCapability({
            sourceKey: capabilitySourceKey,
            value: resolved,
          });
        }
      })
      .catch(error => {
        if (
          !cancelled &&
          !(error instanceof DOMException && error.name === "AbortError")
        ) {
          reportError(error);
        }
      });
    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [
    props.apiOverrideBaseUrl,
    props.getRequestHeaders,
    props.headers,
    props.paths?.audioTalkbackCapabilities,
    providedCapability,
    reportError,
    capabilitySourceKey,
    source.type,
    source.uuid,
  ]);

  useEffect(() => {
    if (!providedCapability || requestHeaders) return;
    let cancelled = false;
    void mergeRequestHeaders(props.headers, props.getRequestHeaders)
      .then(headers => {
        if (!cancelled) setRequestHeaders(headers);
      })
      .catch(reportError);
    return () => {
      cancelled = true;
    };
  }, [
    props.getRequestHeaders,
    props.headers,
    providedCapability,
    reportError,
    requestHeaders,
  ]);

  useEffect(() => {
    let cancelled = false;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const provided = props.federatedSessionToken;
    if (provided !== undefined) {
      if (!provided.trim()) {
        reportError(
          new Error("federatedSessionToken must be a non-empty string")
        );
      } else {
        setToken(provided);
      }
      return;
    }

    const load = async () => {
      try {
        const headers = await mergeRequestHeaders(
          props.headers,
          props.getRequestHeaders
        );
        if (cancelled) return;
        setRequestHeaders(headers);
        const tokenBase =
          props.apiOverrideBaseUrl?.trim() || getBrowserOrigin();
        const tokenPath =
          props.paths?.federatedToken ?? "/api/federated-token";
        const fetchedAtMs = Date.now();
        const result = await fetchFederatedSessionToken(
          joinUrl(tokenBase, tokenPath),
          headers,
          props.tokenDurationSec ?? 86_400,
          props.paths?.federatedToken === undefined
        );
        if (cancelled) return;
        setToken(result.federatedSessionToken);
        refreshTimer = setTimeout(
          load,
          getFederatedTokenRefreshDelayMs({
            requestedDurationSec: props.tokenDurationSec ?? 86_400,
            fetchedAtMs,
            expiryHint: result,
          })
        );
      } catch (error) {
        if (!cancelled) reportError(error);
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (refreshTimer) clearTimeout(refreshTimer);
    };
  }, [
    props.apiOverrideBaseUrl,
    props.federatedSessionToken,
    props.getRequestHeaders,
    props.headers,
    props.paths?.federatedToken,
    props.tokenDurationSec,
    reportError,
  ]);

  useEffect(() => {
    if (!capabilityAllowsTalk || !token || !requestHeaders) return;
    let cancelled = false;
    const abort = new AbortController();
    void resolveAudioTalkbackUri({
      source,
      connectionMode,
      apiOverrideBaseUrl: props.apiOverrideBaseUrl,
      rhombusApiBaseUrl:
        props.rhombusApiBaseUrl?.trim() || DEFAULT_RHOMBUS_API_BASE_URL,
      paths: props.paths,
      federatedSessionToken: token,
      requestHeaders,
      signal: abort.signal,
    })
      .then(uri => {
        if (cancelled) return;
        setResolvedMedia({ sourceKey: mediaResolutionKey, uri });
        setLocalStatus("ready");
        propsRef.current.onReady?.();
      })
      .catch(error => {
        if (
          !cancelled &&
          !(error instanceof DOMException && error.name === "AbortError")
        ) {
          reportError(error);
        }
      });
    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [
    capabilityAllowsTalk,
    connectionMode,
    mediaRefreshKey,
    props.apiOverrideBaseUrl,
    props.paths?.audioGatewayMediaUris,
    props.paths?.audioMediaUris,
    props.paths?.dr40MediaUris,
    props.rhombusApiBaseUrl,
    reportError,
    requestHeaders,
    mediaResolutionKey,
    source.type,
    source.uuid,
    token,
  ]);

  const resolvedInteractionMode: RhombusResolvedTalkbackInteractionMode =
    requestedInteractionMode === "auto"
      ? capability?.interactionMode ?? "hold"
      : requestedInteractionMode;
  const blockedReason: RhombusTalkbackBlockedReason | null =
    disabled
      ? "disabled"
      : disableTalkbackInVod && viewingMode === "vod"
        ? "vod"
        : capability && !capabilityAllowsTalk
          ? capability.reason ??
            (!capability.authorized
              ? "not-authorized"
              : !capability.licensed
                ? "license-required"
                : !capability.speakerEnabled
                  ? "speaker-disabled"
                  : capability.connected === false
                    ? "device-unavailable"
                    : "capability-unavailable")
          : null;
  const canTalk =
    blockedReason === null &&
    Boolean(capabilityAllowsTalk && token && talkbackUri);
  const preparing =
    capability === null ||
    (capabilityAllowsTalk && (!token || !talkbackUri));
  const status: RhombusTalkbackStatus =
    blockedReason !== null
      ? "blocked"
      : preparing && localStatus !== "error"
        ? "loading-capability"
        : localStatus;

  const publishTalking = useCallback(
    (next: boolean) => {
      if (talkingRef.current === next) return;
      talkingRef.current = next;
      setTalking(next);
      propsRef.current.onTalkingChange?.(next);
      controllerInternals?.updateTalkback(
        talkbackId,
        source,
        next
      );
    },
    [
      controllerInternals,
      source.type,
      source.uuid,
      talkbackId,
    ]
  );

  const transmitFrame = useCallback((frame: Int16Array, generation: number) => {
    if (
      !intentRef.current ||
      generationRef.current !== generation ||
      activeMediaSourceKeyRef.current !== currentMediaSourceKeyRef.current
    ) {
      return;
    }
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      pendingFramesRef.current.push(frame);
      if (pendingFramesRef.current.length > MAX_PENDING_FRAMES) {
        pendingFramesRef.current.shift();
      }
      return;
    }
    try {
      if (!didSendControlRef.current) {
        socket.send(buildTalkbackControlPacket());
        didSendControlRef.current = true;
      }
      socket.send(frame);
    } catch (error) {
      reportError(error);
      socket.close();
    }
  }, [reportError]);

  const connectSocket = useCallback(
    (generation: number) => {
      if (
        !intentRef.current ||
        generationRef.current !== generation ||
        activeMediaSourceKeyRef.current !== currentMediaSourceKeyRef.current ||
        !talkbackUriRef.current ||
        !tokenRef.current
      ) {
        return;
      }
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = undefined;
      }
      const previous = socketRef.current;
      if (previous) {
        previous.onclose = null;
        previous.close();
      }
      setLocalStatus(attemptRef.current === 0 ? "connecting" : "reconnecting");
      const socket = new WebSocket(
        withFederatedAudioAuth(
          talkbackUriRef.current,
          tokenRef.current
        )
      );
      socket.binaryType = "arraybuffer";
      socketRef.current = socket;
      didSendControlRef.current = false;
      socket.onopen = () => {
        if (
          !intentRef.current ||
          generationRef.current !== generation ||
          socketRef.current !== socket
        ) {
          socket.close();
          return;
        }
        retryMsRef.current = INITIAL_RETRY_MS;
        attemptRef.current = 0;
        if (captureReadyRef.current) {
          setLocalStatus("talking");
          publishTalking(true);
        } else {
          setLocalStatus("requesting-permission");
        }
        const pending = pendingFramesRef.current;
        pendingFramesRef.current = [];
        for (const frame of pending) transmitFrame(frame, generation);
      };
      socket.onmessage = event => {
        if (typeof event.data !== "string") return;
        try {
          const message = JSON.parse(event.data) as { action?: unknown };
          if (message.action === "reconnect") {
            setMediaRefreshKey(value => value + 1);
            socket.close();
          }
        } catch {
          // Initialization text and downstream audio are irrelevant to TX.
        }
      };
      socket.onerror = () => {
        socket.close();
      };
      socket.onclose = () => {
        if (
          generationRef.current !== generation ||
          socketRef.current !== socket
        ) {
          return;
        }
        socketRef.current = null;
        publishTalking(false);
        if (!intentRef.current) return;
        if (maxRetryIntervalMs <= 0) {
          reportError(new Error("Audio talkback WebSocket disconnected"));
          return;
        }
        attemptRef.current++;
        const error = new Error("Audio talkback WebSocket disconnected");
        propsRef.current.onRecoveryAttempt?.(attemptRef.current, error);
        setLocalStatus("reconnecting");
        reconnectTimerRef.current = setTimeout(
          () => connectSocket(generation),
          retryMsRef.current
        );
        retryMsRef.current = Math.min(
          retryMsRef.current * 2,
          maxRetryIntervalMs
        );
      };
    },
    [
      maxRetryIntervalMs,
      publishTalking,
      reportError,
      transmitFrame,
    ]
  );

  const previousSocketAuthRef = useRef({ token: "", uri: "" });
  useEffect(() => {
    const previous = previousSocketAuthRef.current;
    previousSocketAuthRef.current = { token, uri: talkbackUri };
    if (
      !intentRef.current ||
      !token ||
      !talkbackUri ||
      (previous.token === token && previous.uri === talkbackUri)
    ) {
      return;
    }
    connectSocket(generationRef.current);
  }, [connectSocket, talkbackUri, token]);

  const stopTalking = useCallback(() => {
    intentRef.current = false;
    generationRef.current++;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = undefined;
    }
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket) {
      socket.onclose = null;
      socket.close();
    }
    const capture = captureRef.current;
    captureRef.current = null;
    captureReadyRef.current = false;
    activeMediaSourceKeyRef.current = "";
    if (capture) void capture.destroy().catch(() => {});
    pendingFramesRef.current = [];
    didSendControlRef.current = false;
    retryMsRef.current = INITIAL_RETRY_MS;
    attemptRef.current = 0;
    publishTalking(false);
    setLocalStatus("ready");
  }, [publishTalking]);

  const setPermission = useCallback(
    (permission: RhombusMicrophonePermission) => {
      setMicrophonePermission(permission);
      propsRef.current.onPermissionChange?.(permission);
    },
    []
  );

  const startTalking = useCallback(async () => {
    const current = stateRef.current;
    if (intentRef.current || !current?.canTalk) return;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    intentRef.current = true;
    activeMediaSourceKeyRef.current = mediaSourceKey;
    captureReadyRef.current = false;
    pendingFramesRef.current = [];
    didSendControlRef.current = false;
    retryMsRef.current = INITIAL_RETRY_MS;
    attemptRef.current = 0;
    setLocalStatus("requesting-permission");
    setPermission("prompt");
    connectSocket(generation);

    try {
      const capture = await startMicrophoneCapture({
        constraints: microphoneConstraints,
        gain: microphoneGain,
        onFrame: frame => transmitFrame(frame, generation),
      });
      if (!intentRef.current || generationRef.current !== generation) {
        await capture.destroy();
        return;
      }
      captureRef.current = capture;
      captureReadyRef.current = true;
      setPermission("granted");
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        setLocalStatus("talking");
        publishTalking(true);
      } else {
        setLocalStatus("connecting");
      }
    } catch (error) {
      if (generationRef.current !== generation) return;
      stopTalking();
      if (isPermissionDenied(error)) setPermission("denied");
      reportError(error);
    }
  }, [
    connectSocket,
    mediaSourceKey,
    microphoneConstraints,
    microphoneGain,
    reportError,
    setPermission,
    stopTalking,
    transmitFrame,
  ]);

  const toggleTalking = useCallback(async () => {
    if (intentRef.current) {
      stopTalking();
      return;
    }
    await startTalking();
  }, [startTalking, stopTalking]);

  const requestMicrophonePermission = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      const error = new Error(
        "Browser microphone capture is unavailable; use HTTPS and a supported browser"
      );
      reportError(error);
      throw error;
    }
    setPermission("prompt");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: buildMicrophoneConstraints(microphoneConstraints),
        video: false,
      });
      stream.getTracks().forEach(track => track.stop());
      setPermission("granted");
    } catch (error) {
      if (isPermissionDenied(error)) setPermission("denied");
      reportError(error);
      throw error;
    }
  }, [microphoneConstraints, reportError, setPermission]);

  useEffect(() => {
    const onWindowBlur = () => stopTalking();
    const onVisibility = () => {
      if (document.visibilityState !== "visible") stopTalking();
    };
    if (typeof window !== "undefined") {
      window.addEventListener("blur", onWindowBlur);
    }
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }
    return () => {
      window.removeEventListener("blur", onWindowBlur);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [stopTalking]);
  useEffect(() => {
    if (
      disabled ||
      (capability !== null && !capabilityAllowsTalk) ||
      (disableTalkbackInVod && viewingMode === "vod")
    ) {
      stopTalking();
    }
  }, [
    capabilityAllowsTalk,
    disabled,
    disableTalkbackInVod,
    stopTalking,
    viewingMode,
  ]);
  const previousMediaSourceKeyRef = useRef(mediaSourceKey);
  useEffect(() => {
    const previous = previousMediaSourceKeyRef.current;
    previousMediaSourceKeyRef.current = mediaSourceKey;
    if (previous !== mediaSourceKey) {
      stopTalking();
    }
  }, [mediaSourceKey, stopTalking]);
  useEffect(() => () => stopTalking(), [stopTalking]);

  const state = useMemo<RhombusTalkbackState>(
    () => ({
      source,
      status,
      talking,
      interactionMode: resolvedInteractionMode,
      canTalk,
      blockedReason,
      microphonePermission,
      viewingMode,
      capability,
    }),
    [
      blockedReason,
      canTalk,
      capability,
      microphonePermission,
      resolvedInteractionMode,
      source.type,
      source.uuid,
      status,
      talking,
      viewingMode,
    ]
  );
  stateRef.current = state;

  const handle = useMemo<RhombusTalkbackHandle>(
    () => ({
      startTalking,
      stopTalking,
      toggleTalking,
      requestMicrophonePermission,
      getState: () => stateRef.current ?? state,
    }),
    [
      requestMicrophonePermission,
      startTalking,
      state,
      stopTalking,
      toggleTalking,
    ]
  );
  useImperativeHandle(ref, () => handle, [handle]);
  useEffect(() => {
    propsRef.current.onStateChange?.(state);
  }, [state]);

  return (
    <div
      className={className}
      style={style}
      data-rhombus-talkback-status={state.status}
      data-rhombus-talkback-source={source.type}
    >
      {renderControl ? (
        renderControl(handle, state)
      ) : (
        <RhombusMicrophoneControl
          api={handle}
          state={state}
          classNames={classNames}
          styles={styles}
        />
      )}
    </div>
  );
});

type StartMicrophoneCaptureOptions = {
  constraints?: MediaTrackConstraints;
  gain: number;
  onFrame: (frame: Int16Array) => void;
};

async function startMicrophoneCapture(
  options: StartMicrophoneCaptureOptions
): Promise<MicrophoneCapture> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error(
      "Browser microphone capture is unavailable; use HTTPS and a supported browser"
    );
  }
  const AudioContextConstructor =
    globalThis.AudioContext ??
    (globalThis as typeof globalThis & {
      webkitAudioContext?: typeof AudioContext;
    }).webkitAudioContext;
  if (!AudioContextConstructor) {
    throw new Error("Web Audio is unavailable in this browser");
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: buildMicrophoneConstraints(options.constraints),
    video: false,
  });
  let context: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let processor: AudioNode | null = null;
  let silentGain: GainNode | null = null;
  try {
    try {
      context = new AudioContextConstructor({
        latencyHint: "interactive",
        sampleRate: 48_000,
      });
    } catch {
      context = new AudioContextConstructor({
        latencyHint: "interactive",
      });
    }
    const encoder = new TalkbackPcmEncoder(options.gain);
    source = context.createMediaStreamSource(stream);
    silentGain = context.createGain();
    silentGain.gain.value = 0;

    if (context.audioWorklet && typeof AudioWorkletNode !== "undefined") {
      try {
        processor = await createCaptureWorklet(context, samples => {
          for (const frame of encoder.push(samples, context?.sampleRate ?? 48_000)) {
            options.onFrame(frame);
          }
        });
      } catch {
        processor = null;
      }
    }
    if (!processor) {
      const script = context.createScriptProcessor(1024, 1, 1);
      script.onaudioprocess = event => {
        const samples = event.inputBuffer.getChannelData(0);
        for (const frame of encoder.push(samples, event.inputBuffer.sampleRate)) {
          options.onFrame(frame);
        }
        const output = event.outputBuffer.getChannelData(0);
        output.fill(0);
      };
      processor = script;
    }

    source.connect(processor);
    processor.connect(silentGain);
    silentGain.connect(context.destination);
    await context.resume();
    const resolvedContext = context;
    const resolvedSource = source;
    const resolvedProcessor = processor;
    const resolvedSilentGain = silentGain;
    return {
      async destroy() {
        if (
          typeof ScriptProcessorNode !== "undefined" &&
          resolvedProcessor instanceof ScriptProcessorNode
        ) {
          resolvedProcessor.onaudioprocess = null;
        } else if (
          typeof AudioWorkletNode !== "undefined" &&
          resolvedProcessor instanceof AudioWorkletNode
        ) {
          resolvedProcessor.port.onmessage = null;
        }
        try {
          resolvedSource.disconnect();
          resolvedProcessor.disconnect();
          resolvedSilentGain.disconnect();
        } catch {
          // Nodes may already be disconnected during browser teardown.
        }
        stream.getTracks().forEach(track => track.stop());
        if (resolvedContext.state !== "closed") {
          await resolvedContext.close();
        }
      },
    };
  } catch (error) {
    stream.getTracks().forEach(track => track.stop());
    if (context && context.state !== "closed") {
      await context.close().catch(() => {});
    }
    throw error;
  }
}

async function createCaptureWorklet(
  context: AudioContext,
  onSamples: (samples: Float32Array) => void
): Promise<AudioWorkletNode> {
  const source = `
class RhombusTalkbackCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.size = Math.max(128, options.processorOptions.samplesPerDelivery || 960);
    this.buffer = new Float32Array(this.size);
    this.offset = 0;
  }
  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;
    let sourceOffset = 0;
    while (sourceOffset < input.length) {
      const count = Math.min(this.size - this.offset, input.length - sourceOffset);
      this.buffer.set(input.subarray(sourceOffset, sourceOffset + count), this.offset);
      this.offset += count;
      sourceOffset += count;
      if (this.offset === this.size) {
        const samples = this.buffer;
        this.port.postMessage({ samples }, [samples.buffer]);
        this.buffer = new Float32Array(this.size);
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor("rhombus-talkback-capture", RhombusTalkbackCapture);
`;
  const moduleUrl = URL.createObjectURL(
    new Blob([source], { type: "text/javascript" })
  );
  try {
    await context.audioWorklet.addModule(moduleUrl);
  } finally {
    URL.revokeObjectURL(moduleUrl);
  }
  const node = new AudioWorkletNode(context, "rhombus-talkback-capture", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: {
      samplesPerDelivery: Math.max(128, Math.round(context.sampleRate / 50)),
    },
  });
  node.port.onmessage = event => {
    const samples = event.data?.samples;
    if (samples instanceof Float32Array) onSamples(samples);
  };
  return node;
}

function buildMicrophoneConstraints(
  overrides?: MediaTrackConstraints
): MediaTrackConstraints {
  return {
    channelCount: 1,
    sampleSize: 16,
    sampleRate: 48_000,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    ...overrides,
  };
}

function isPermissionDenied(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    ((error as { name?: unknown }).name === "NotAllowedError" ||
      (error as { name?: unknown }).name === "SecurityError")
  );
}
