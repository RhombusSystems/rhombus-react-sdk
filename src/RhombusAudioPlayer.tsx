import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ErrorEvent as DashErrorEvent,
  MediaPlayerClass,
} from "dashjs";
import { MediaPlayer } from "./dashjsRuntime.js";
import { AudioPcmEngine } from "./audioPcmEngine.js";
import {
  AUDIO_FRAME_DURATION_MS,
  buildHistoricalAudioSegmentUrl,
  formatAudioVodMpdUri,
  getHistoricalAudioSegmentNumber,
  isReconnectMessage,
  parseAudioTlvMessage,
  parseHistoricalAudioSegment,
  resolveAudioMediaUris,
  supportsOpusWebmMse,
  withFederatedAudioAuth,
  type ResolvedAudioMediaUris,
} from "./audioPlayback.js";
import { getDefaultRhombusVodDashSettings } from "./dashSettings.js";
import { RhombusAudioPlayerControls } from "./RhombusAudioPlayerControls.js";
import { Timeline } from "./Timeline.js";
import { chooseVodAnchor } from "./playerVodTime.js";
import {
  DEFAULT_RHOMBUS_API_BASE_URL,
  fetchFederatedSessionToken,
  getBrowserOrigin,
  getFederatedTokenRefreshDelayMs,
  mergeRequestHeaders,
} from "./rhombusPlayback.js";
import type {
  RhombusAudioPlayerHandle,
  RhombusAudioPlayerProps,
  RhombusAudioPlayerState,
  RhombusAudioTransport,
  RhombusPlayerMode,
} from "./types.js";
import {
  getRhombusPlaybackControllerInternals,
  useRhombusPlaybackController,
} from "./useRhombusPlaybackController.js";
import { appendFederatedAuthQueryParams, joinUrl } from "./urlAuth.js";

const DEFAULT_VOD_WINDOW_SEC = 7_200;
const DEFAULT_LIVE_EDGE_TOLERANCE_SEC = 5;
const INITIAL_RETRY_MS = 2_000;
const PROGRESS_INTERVAL_MS = 250;
let participantSequence = 0;

export const RhombusAudioPlayer = forwardRef<
  RhombusAudioPlayerHandle,
  RhombusAudioPlayerProps
>(function RhombusAudioPlayer(props, ref) {
  const {
    source,
    connectionMode = "wan",
    playbackController: externalController,
    playing,
    positionMs,
    playbackRate,
    muted,
    volume,
    initialMode = "live",
    initialStartTimeMs,
    vodWindowSec = DEFAULT_VOD_WINDOW_SEC,
    defaultRewindSec = 15,
    liveEdgeToleranceSec = DEFAULT_LIVE_EDGE_TOLERANCE_SEC,
    autoGoLiveAtEdge = false,
    controls,
    classNames,
    renderControls,
    timeline,
    className,
    style,
    maxRetryIntervalMs = 30_000,
    stallTimeoutMs = 12_000,
  } = props;

  const internalController = useRhombusPlaybackController({
    initialMode,
    initialPositionMs:
      initialMode === "vod" ? initialStartTimeMs ?? Date.now() - 60_000 : Date.now(),
    initialPlaying: true,
    initialPlaybackRate: 1,
    initialMuted: true,
    initialVolume: 1,
    defaultRewindSec,
    liveEdgeToleranceSec,
    autoGoLiveAtEdge,
  });
  const controller = externalController ?? internalController;
  const controllerInternals = getRhombusPlaybackControllerInternals(controller);
  const controllerState = controller.state;

  const participantIdRef = useRef<string>();
  if (!participantIdRef.current) {
    participantSequence++;
    participantIdRef.current = `rhombus-audio-${participantSequence}`;
  }
  const participantId = participantIdRef.current;

  const [transport, setTransport] = useState<RhombusAudioTransport>("opus-live");
  const [mediaUris, setMediaUris] = useState<ResolvedAudioMediaUris | null>(null);
  const [mediaRefreshKey, setMediaRefreshKey] = useState(0);
  const [token, setToken] = useState(props.federatedSessionToken ?? "");
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const [requestHeaders, setRequestHeaders] = useState<HeadersInit>();
  const [forceDecodedVod, setForceDecodedVod] = useState(false);
  const [decodedResetKey, setDecodedResetKey] = useState(0);
  const [participantRevision, setParticipantRevision] = useState(0);
  const [vodAnchor, setVodAnchor] = useState(() =>
    chooseVodAnchor({
      targetMs: controllerState.positionMs,
      windowSec: vodWindowSec,
      nowMs: Date.now(),
    })
  );
  const engineRef = useRef<AudioPcmEngine | null>(null);
  const audioElementRef = useRef<HTMLAudioElement>(null);
  const dashPlayerRef = useRef<MediaPlayerClass | null>(null);
  const previousModeRef = useRef<RhombusPlayerMode>(controllerState.mode);
  const previousSeekSequenceRef = useRef(controllerState.seekSequence);
  const previousStateRef = useRef<RhombusAudioPlayerState | null>(null);
  const lastHardSyncAtRef = useRef(0);
  const propsRef = useRef(props);
  propsRef.current = props;

  const reportError = useCallback(
    (error: unknown) => {
      const normalized = error instanceof Error ? error : new Error(String(error));
      controllerInternals.reportStatus(participantId, "error");
      propsRef.current.onError?.(normalized);
    },
    [controllerInternals, participantId]
  );

  useEffect(() => {
    setForceDecodedVod(false);
  }, [connectionMode, source.type, source.uuid]);

  useEffect(() => {
    if (!externalController) return;
    const conflicts = [
      playing !== undefined ? "playing" : "",
      positionMs !== undefined ? "positionMs" : "",
      playbackRate !== undefined ? "playbackRate" : "",
      muted !== undefined ? "muted" : "",
      volume !== undefined ? "volume" : "",
    ].filter(Boolean);
    if (conflicts.length > 0 && typeof console !== "undefined") {
      console.warn(
        `[RhombusAudioPlayer] playbackController overrides: ${conflicts.join(", ")}`
      );
    }
  }, [externalController, muted, playbackRate, playing, positionMs, volume]);

  // Controlled props drive the component's private controller. A supplied shared controller wins.
  useEffect(() => {
    if (externalController || playing === undefined) return;
    if (playing) controller.play();
    else controller.pause();
  }, [controller, externalController, playing]);
  useEffect(() => {
    if (externalController || positionMs === undefined) return;
    if (Math.abs(positionMs - controller.state.positionMs) > 750) {
      controller.seekTo(positionMs);
    }
  }, [controller, externalController, positionMs]);
  useEffect(() => {
    if (externalController || playbackRate === undefined) return;
    controller.setPlaybackRate(playbackRate);
  }, [controller, externalController, playbackRate]);
  useEffect(() => {
    if (externalController || muted === undefined) return;
    controller.setMuted(muted);
  }, [controller, externalController, muted]);
  useEffect(() => {
    if (externalController || volume === undefined) return;
    controller.setVolume(volume);
  }, [controller, externalController, volume]);

  useEffect(
    () => controllerInternals.subscribeParticipants(() => setParticipantRevision(value => value + 1)),
    [controllerInternals]
  );

  const dr40VideoOwnsAudio =
    source.type === "dr40" &&
    controllerInternals.hasMatchingDr40VideoOwner(source.uuid);
  void participantRevision;

  useEffect(() => {
    return controllerInternals.registerParticipant({
      id: participantId,
      kind: "audio",
      sourceUuid: source.uuid,
      audioSource: source,
      mode: controllerState.mode,
      audioTransport: transport,
    });
  }, [controllerInternals, participantId, source.type, source.uuid]);
  useEffect(() => {
    controllerInternals.updateParticipant(participantId, {
      sourceUuid: source.uuid,
      audioSource: source,
      mode: controllerState.mode,
      audioTransport: transport,
    });
  }, [
    controllerInternals,
    controllerState.mode,
    participantId,
    source.type,
    source.uuid,
    transport,
  ]);

  // Resolve/refresh the federated token.
  useEffect(() => {
    let cancelled = false;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const provided = props.federatedSessionToken;
    if (provided !== undefined) {
      if (!provided.trim()) {
        reportError(new Error("federatedSessionToken must be a non-empty string"));
      } else {
        setToken(provided);
      }
      return;
    }

    const load = async () => {
      try {
        const headers = await mergeRequestHeaders(props.headers, props.getRequestHeaders);
        if (cancelled) return;
        setRequestHeaders(headers);
        const tokenBase = props.apiOverrideBaseUrl?.trim() || getBrowserOrigin();
        const tokenPath = props.paths?.federatedToken ?? "/api/federated-token";
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

  // Headers are still needed in consumer-provided-token proxy mode.
  useEffect(() => {
    if (props.federatedSessionToken === undefined) return;
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
    props.federatedSessionToken,
    props.getRequestHeaders,
    props.headers,
    reportError,
  ]);

  // Resolve media whenever identity, network, endpoint, or token changes.
  useEffect(() => {
    if (!token || !requestHeaders) return;
    let cancelled = false;
    controllerInternals.reportStatus(participantId, "connecting");
    void resolveAudioMediaUris({
      source,
      connectionMode,
      apiOverrideBaseUrl: props.apiOverrideBaseUrl,
      rhombusApiBaseUrl:
        props.rhombusApiBaseUrl?.trim() || DEFAULT_RHOMBUS_API_BASE_URL,
      paths: props.paths,
      federatedSessionToken: token,
      requestHeaders,
    })
      .then(resolved => {
        if (!cancelled) setMediaUris(resolved);
      })
      .catch(error => {
        if (!cancelled) reportError(error);
      });
    return () => {
      cancelled = true;
    };
  }, [
    connectionMode,
    controllerInternals,
    props.apiOverrideBaseUrl,
    props.paths?.audioGatewayMediaUris,
    props.paths?.audioMediaUris,
    props.paths?.dr40MediaUris,
    props.rhombusApiBaseUrl,
    reportError,
    requestHeaders,
    source.type,
    source.uuid,
    token,
    mediaRefreshKey,
  ]);

  useEffect(() => {
    if (controllerState.mode !== "vod") return;
    setVodAnchor(
      chooseVodAnchor({
        targetMs: controllerState.positionMs,
        windowSec: vodWindowSec,
        nowMs: Date.now(),
      })
    );
  }, [controllerState.mode, controllerState.seekSequence, vodWindowSec]);

  const resolvedTransport: RhombusAudioTransport =
    dr40VideoOwnsAudio
      ? "embedded-dr40"
      : controllerState.mode === "live"
        ? "opus-live"
        : forceDecodedVod || !supportsOpusWebmMse()
          ? "decoded-vod"
          : "dash-vod";
  useEffect(() => {
    if (transport === resolvedTransport) return;
    setTransport(resolvedTransport);
    propsRef.current.onTransportChange?.(resolvedTransport);
  }, [resolvedTransport, transport]);
  useEffect(() => {
    if (resolvedTransport === "embedded-dr40") {
      controllerInternals.reportStatus(participantId, "ready");
    }
  }, [controllerInternals, participantId, resolvedTransport]);

  // Live Opus WebSocket transport.
  useEffect(() => {
    if (resolvedTransport !== "opus-live" || !mediaUris || !token) return;
    let cancelled = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let stallTimer: ReturnType<typeof setInterval> | undefined;
    let retryMs = INITIAL_RETRY_MS;
    let attempt = 0;
    let lastMessageAt = Date.now();
    let lastTimestamp: number | undefined;
    let consecutiveMalformedMessages = 0;

    const engine = new AudioPcmEngine({
      muted: controller.state.muted,
      volume: controller.state.volume,
      playbackRate: 1,
      onError: reportError,
    });
    engineRef.current = engine;

    const connect = () => {
      if (cancelled) return;
      controllerInternals.reportStatus(
        participantId,
        attempt === 0 ? "connecting" : "reconnecting"
      );
      const next = new WebSocket(
        withFederatedAudioAuth(mediaUris.liveOpusUri, tokenRef.current)
      );
      socket = next;
      next.binaryType = "arraybuffer";
      next.onopen = () => {
        if (cancelled || socket !== next) return;
        lastMessageAt = Date.now();
        retryMs = INITIAL_RETRY_MS;
        controllerInternals.reportStatus(participantId, "ready");
        propsRef.current.onReady?.();
      };
      next.onmessage = event => {
        if (cancelled || socket !== next) return;
        lastMessageAt = Date.now();
        if (isReconnectMessage(event.data)) {
          setMediaRefreshKey(value => value + 1);
          next.close();
          return;
        }
        if (!(event.data instanceof ArrayBuffer)) return;
        try {
          const message = parseAudioTlvMessage(event.data);
          consecutiveMalformedMessages = 0;
          if (message.timestampMs != null) lastTimestamp = message.timestampMs;
          message.frames.forEach((frame, index) => {
            engine.enqueueOpus(
              frame.data,
              lastTimestamp == null
                ? undefined
                : lastTimestamp + index * AUDIO_FRAME_DURATION_MS
            );
          });
          if (message.frames.length > 0 && lastTimestamp != null) {
            lastTimestamp += message.frames.length * AUDIO_FRAME_DURATION_MS;
          }
        } catch (error) {
          if (
            error instanceof Error &&
            error.message.startsWith("Malformed audio TLV")
          ) {
            consecutiveMalformedMessages++;
            // A100 streams can emit one non-TLV binary packet immediately after
            // their JSON init message. The legacy player discarded incomplete
            // packets, so tolerate isolated framing failures but recover if the
            // stream remains corrupt.
            if (consecutiveMalformedMessages < 3) return;
            reportError(
              new Error(
                "Live audio stream sent three consecutive malformed TLV messages"
              )
            );
            next.close();
            return;
          }
          reportError(error);
        }
      };
      next.onerror = () => {
        if (cancelled || socket !== next) return;
        next.close();
      };
      next.onclose = () => {
        if (cancelled || socket !== next) return;
        socket = null;
        if (maxRetryIntervalMs <= 0) return;
        attempt++;
        const error = new Error("Live audio WebSocket disconnected");
        propsRef.current.onRecoveryAttempt?.(attempt, error);
        controllerInternals.reportStatus(participantId, "reconnecting");
        reconnectTimer = setTimeout(connect, retryMs);
        retryMs = Math.min(retryMs * 2, maxRetryIntervalMs);
      };
    };

    void engine
      .ready()
      .then(async () => {
        if (cancelled) return;
        if (
          controller.state.playing &&
          controller.state.status !== "buffering"
        ) {
          await engine.play();
        }
        connect();
      })
      .catch(reportError);

    if (stallTimeoutMs > 0) {
      stallTimer = setInterval(() => {
        if (
          socket?.readyState === WebSocket.OPEN &&
          Date.now() - lastMessageAt > stallTimeoutMs
        ) {
          socket.close();
        }
      }, Math.max(1_000, stallTimeoutMs / 2));
    }

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (stallTimer) clearInterval(stallTimer);
      socket?.close();
      engineRef.current = null;
      void engine.destroy();
    };
  }, [
    controller,
    controllerInternals,
    maxRetryIntervalMs,
    mediaUris,
    reportError,
    resolvedTransport,
    stallTimeoutMs,
    token,
  ]);

  // Dash.js historical transport.
  useEffect(() => {
    if (
      resolvedTransport !== "dash-vod" ||
      !mediaUris ||
      !token ||
      !audioElementRef.current
    ) {
      return;
    }
    const element = audioElementRef.current;
    const player = MediaPlayer().create();
    dashPlayerRef.current = player;
    const onError = (_event: DashErrorEvent) => {
      setForceDecodedVod(true);
    };
    player.extend(
      "RequestModifier",
      () => ({
        modifyRequestURL: (url: string) =>
          appendFederatedAuthQueryParams(url, tokenRef.current),
      }),
      true
    );
    player.updateSettings(getDefaultRhombusVodDashSettings());
    player.on(MediaPlayer.events.ERROR, onError, undefined);
    const manifest = withFederatedAudioAuth(
      formatAudioVodMpdUri(
        mediaUris.vodMpdUriTemplate,
        Math.floor(vodAnchor.anchorMs / 1000),
        vodWindowSec
      ),
      token
    );
    player.initialize(element, undefined, false);
    player.attachSource(manifest, vodAnchor.seekOffsetSec || undefined);
    const onCanPlay = () => {
      controllerInternals.reportStatus(participantId, "ready");
      propsRef.current.onReady?.();
      if (
        controller.state.playing &&
        controller.state.status !== "buffering"
      ) {
        void element.play().catch(reportError);
      }
    };
    const onWaiting = () =>
      controllerInternals.reportStatus(participantId, "buffering");
    element.addEventListener("canplay", onCanPlay);
    element.addEventListener("waiting", onWaiting);
    return () => {
      element.removeEventListener("canplay", onCanPlay);
      element.removeEventListener("waiting", onWaiting);
      try {
        player.off(MediaPlayer.events.ERROR, onError, undefined);
        player.reset();
      } catch {
        // Ignore Dash teardown errors.
      }
      dashPlayerRef.current = null;
    };
  }, [
    controller,
    controllerInternals,
    mediaUris,
    reportError,
    resolvedTransport,
    token,
    vodAnchor,
    vodWindowSec,
  ]);

  // Decoded historical segment transport.
  useEffect(() => {
    if (resolvedTransport !== "decoded-vod" || !mediaUris || !token) return;
    let cancelled = false;
    const abort = new AbortController();
    const engine = new AudioPcmEngine({
      muted: controller.state.muted,
      volume: controller.state.volume,
      playbackRate: controller.state.playbackRate,
      onError: reportError,
    });
    engineRef.current = engine;

    const run = async () => {
      await engine.ready();
      if (cancelled) return;
      await engine.reset(controller.state.positionMs);
      if (
        controller.state.playing &&
        controller.state.status !== "buffering"
      ) {
        await engine.play();
      }
      controllerInternals.reportStatus(participantId, "buffering");
      let segmentNumber = getHistoricalAudioSegmentNumber(
        vodAnchor.anchorMs,
        controller.state.positionMs
      );
      const maximumSegmentNumber = Math.ceil(vodWindowSec / 2);
      let previousTimestamp: number | undefined;
      let first = true;
      while (!cancelled) {
        if (segmentNumber > maximumSegmentNumber) {
          await delay(500);
          continue;
        }
        if (engine.getBufferedDurationSec() > 10) {
          await delay(250);
          continue;
        }
        const url = withFederatedAudioAuth(
          buildHistoricalAudioSegmentUrl(
            mediaUris.vodMpdUriTemplate,
            Math.floor(vodAnchor.anchorMs / 1000),
            vodWindowSec,
            segmentNumber
          ),
          tokenRef.current
        );
        const response = await fetch(url, {
          method: "GET",
          signal: abort.signal,
          credentials: "include",
        });
        if (!response.ok) {
          throw new Error(
            `Historical audio segment ${segmentNumber} failed: ${response.status}`
          );
        }
        const parsed = parseHistoricalAudioSegment(
          await response.arrayBuffer(),
          segmentNumber,
          vodAnchor.anchorMs,
          previousTimestamp
        );
        previousTimestamp = parsed.timestampMs;
        for (const frame of parsed.frames) {
          if (first && frame.timestampMs < controller.state.positionMs) continue;
          first = false;
          engine.enqueueOpus(frame.data, frame.timestampMs);
        }
        controllerInternals.reportStatus(participantId, "ready");
        segmentNumber++;
      }
    };
    void run().catch(error => {
      if (!cancelled && !(error instanceof DOMException && error.name === "AbortError")) {
        reportError(error);
      }
    });
    return () => {
      cancelled = true;
      abort.abort();
      engineRef.current = null;
      void engine.destroy();
    };
  }, [
    controller,
    controllerInternals,
    mediaUris,
    reportError,
    resolvedTransport,
    token,
    vodAnchor,
    vodWindowSec,
    decodedResetKey,
  ]);

  // Apply common playback state to the active engine/element.
  useEffect(() => {
    const shouldPlay =
      controllerState.playing && controllerState.status !== "buffering";
    const engine = engineRef.current;
    engine?.setMuted(controllerState.muted);
    engine?.setVolume(controllerState.volume);
    engine?.setPlaybackRate(controllerState.playbackRate);
    const element = audioElementRef.current;
    if (element) {
      element.muted = controllerState.muted;
      element.volume = controllerState.volume;
      element.playbackRate = controllerState.mode === "vod" ? controllerState.playbackRate : 1;
      if (resolvedTransport === "dash-vod") {
        if (shouldPlay) void element.play().catch(() => {});
        else element.pause();
      }
    }
    if (engine) {
      if (shouldPlay) void engine.play().catch(reportError);
      else void engine.pause().catch(reportError);
    }
  }, [
    controllerState.mode,
    controllerState.muted,
    controllerState.playbackRate,
    controllerState.playing,
    controllerState.volume,
    reportError,
    resolvedTransport,
  ]);

  // Progress and follower drift correction.
  useEffect(() => {
    if (resolvedTransport === "embedded-dr40") return;
    const interval = setInterval(() => {
      let wallClockMs: number | null = null;
      if (resolvedTransport === "dash-vod" && audioElementRef.current) {
        wallClockMs = vodAnchor.anchorMs + audioElementRef.current.currentTime * 1000;
      } else if (engineRef.current) {
        wallClockMs = engineRef.current.getWallClockMs();
      }
      if (wallClockMs == null) {
        if (controller.state.mode === "live") wallClockMs = Date.now();
        else return;
      }
      controllerInternals.reportProgress(
        participantId,
        wallClockMs,
        controller.state.mode
      );
      propsRef.current.onProgress?.(wallClockMs, controller.state.mode);

      if (externalController && controller.state.mode === "vod") {
        const driftMs = controller.state.positionMs - wallClockMs;
        if (resolvedTransport === "dash-vod" && audioElementRef.current) {
          if (Math.abs(driftMs) > 750) {
            audioElementRef.current.currentTime = Math.max(
              0,
              (controller.state.positionMs - vodAnchor.anchorMs) / 1000
            );
          } else {
            audioElementRef.current.playbackRate =
              controller.state.playbackRate *
              (Math.abs(driftMs) > 80 ? (driftMs > 0 ? 1.03 : 0.97) : 1);
          }
        } else if (
          engineRef.current &&
          Math.abs(driftMs) > 750 &&
          Date.now() - lastHardSyncAtRef.current > 2_000
        ) {
          lastHardSyncAtRef.current = Date.now();
          setDecodedResetKey(value => value + 1);
        } else if (engineRef.current) {
          engineRef.current.setPlaybackRate(
            controller.state.playbackRate *
              (Math.abs(driftMs) > 80 ? (driftMs > 0 ? 1.03 : 0.97) : 1)
          );
        }
      }
    }, PROGRESS_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [
    controller,
    controllerInternals,
    externalController,
    participantId,
    resolvedTransport,
    vodAnchor.anchorMs,
  ]);

  const state = useMemo<RhombusAudioPlayerState>(
    () => ({
      source,
      mode: controllerState.mode,
      transport: resolvedTransport,
      playing: controllerState.playing,
      playbackRate: controllerState.playbackRate,
      muted: controllerState.muted,
      volume: controllerState.volume,
      currentWallClockMs: controllerState.positionMs,
      isAtLiveEdge: controllerState.isAtLiveEdge,
      status:
        resolvedTransport === "embedded-dr40" ? "ready" : controllerState.status,
    }),
    [controllerState, resolvedTransport, source.type, source.uuid]
  );

  const handle = useMemo<RhombusAudioPlayerHandle>(
    () => ({
      play: controller.play,
      pause: controller.pause,
      goLive: controller.goLive,
      seekTo: controller.seekTo,
      rewind: controller.rewind,
      setPlaybackRate: controller.setPlaybackRate,
      setMuted: controller.setMuted,
      setVolume: controller.setVolume,
      getState: () => previousStateRef.current ?? state,
    }),
    [controller, state]
  );
  useImperativeHandle(ref, () => handle, [handle]);

  useEffect(() => {
    propsRef.current.onPlayingChange?.(controllerState.playing);
  }, [controllerState.playing]);
  useEffect(() => {
    propsRef.current.onPlaybackRateChange?.(controllerState.playbackRate);
  }, [controllerState.playbackRate]);
  useEffect(() => {
    propsRef.current.onMutedChange?.(controllerState.muted);
  }, [controllerState.muted]);
  useEffect(() => {
    propsRef.current.onVolumeChange?.(controllerState.volume);
  }, [controllerState.volume]);
  useEffect(() => {
    propsRef.current.onStatusChange?.(state.status);
  }, [state.status]);
  useEffect(() => {
    if (previousModeRef.current !== controllerState.mode) {
      previousModeRef.current = controllerState.mode;
      propsRef.current.onModeChange?.(
        controllerState.mode,
        controllerState.positionMs
      );
    }
  }, [controllerState.mode, controllerState.positionMs]);
  useEffect(() => {
    if (previousSeekSequenceRef.current === controllerState.seekSequence) return;
    previousSeekSequenceRef.current = controllerState.seekSequence;
    propsRef.current.onSeek?.(
      controllerState.positionMs,
      controllerState.mode
    );
  }, [
    controllerState.mode,
    controllerState.positionMs,
    controllerState.seekSequence,
  ]);
  useEffect(() => {
    previousStateRef.current = state;
    propsRef.current.onStateChange?.(state);
  }, [state]);

  const now = Date.now();
  const timelineSpanMs = (timeline?.windowSec ?? 86_400) * 1000;
  const timelineEndMs = Math.max(now, controllerState.positionMs + timelineSpanMs / 2);
  const timelineStartMs = timelineEndMs - timelineSpanMs;

  return (
    <div className={className} style={style} data-rhombus-audio-transport={resolvedTransport}>
      <audio ref={audioElementRef} preload="auto" />
      <RhombusAudioPlayerControls
        api={handle}
        state={state}
        controls={controls}
        classNames={classNames}
        renderControls={renderControls}
      >
        {(controls === undefined || controls.includes("timeline")) && (
          <Timeline
            className={classNames?.timeline}
            playbackController={controller}
            rangeStartMs={timelineStartMs}
            rangeEndMs={timelineEndMs}
            fetchSeekPoints={false}
            marks={timeline?.marks}
            colors={timeline?.colors}
            height={timeline?.height}
          />
        )}
      </RhombusAudioPlayerControls>
    </div>
  );
});

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
