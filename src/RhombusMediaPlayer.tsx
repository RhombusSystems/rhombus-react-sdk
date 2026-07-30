import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from "react";
import { RhombusAudioPlayer } from "./RhombusAudioPlayer.js";
import { RhombusPlayer } from "./RhombusPlayer.js";
import { RhombusTalkback } from "./RhombusTalkback.js";
import type {
  RhombusAudioPlayerHandle,
  RhombusMediaBaseProps,
  RhombusMediaPlayerHandle,
  RhombusMediaPlayerProps,
  RhombusPlayerHandle,
  RhombusTalkbackHandle,
} from "./types.js";
import { useRhombusPlaybackController } from "./useRhombusPlaybackController.js";

const STYLE_ID = "rhombus-media-player-styles";
const MEDIA_PLAYER_CSS = `
:where(.rhombus-media-player){display:grid;gap:12px;min-width:0;}
:where(.rhombus-media-player-video),
:where(.rhombus-media-player-audio),
:where(.rhombus-media-player-talkback){min-width:0;}
:where(.rhombus-media-player-talkback){display:flex;align-items:center;padding:12px;border:1px solid rgba(148,163,184,.2);border-radius:10px;background:#0b1220;}
`;

type SharedMediaProps = Omit<RhombusMediaBaseProps, "className" | "style">;

export const RhombusMediaPlayer = forwardRef<
  RhombusMediaPlayerHandle,
  RhombusMediaPlayerProps
>(function RhombusMediaPlayer(props, ref) {
  const {
    audioSource,
    cameraUuid,
    playbackController: externalController,
    playbackOptions,
    talkback = true,
    disableTalkbackInVod = false,
    videoProps,
    audioProps,
    talkbackProps,
    className,
    style,
    classNames,
    styles,
    connectionMode,
    apiOverrideBaseUrl,
    rhombusApiBaseUrl,
    paths,
    federatedSessionToken,
    tokenDurationSec,
    headers,
    getRequestHeaders,
    maxRetryIntervalMs,
    stallTimeoutMs,
    onRecoveryAttempt,
    onError,
  } = props;

  const internalController = useRhombusPlaybackController(playbackOptions);
  const playbackController = externalController ?? internalController;
  const videoRef = useRef<RhombusPlayerHandle>(null);
  const audioRef = useRef<RhombusAudioPlayerHandle>(null);
  const talkbackRef = useRef<RhombusTalkbackHandle>(null);
  const resolvedCameraUuid = cameraUuid?.trim() ?? "";
  const hasVideo = resolvedCameraUuid.length > 0;

  useEffect(() => {
    if (
      externalController &&
      playbackOptions !== undefined &&
      typeof console !== "undefined"
    ) {
      console.warn(
        "[RhombusMediaPlayer] playbackController overrides playbackOptions"
      );
    }
  }, [externalController, playbackOptions]);
  useEffect(() => {
    if (!hasVideo && videoProps !== undefined && typeof console !== "undefined") {
      console.warn(
        "[RhombusMediaPlayer] videoProps are ignored without cameraUuid"
      );
    }
  }, [hasVideo, videoProps]);
  useEffect(() => {
    if (!talkback && talkbackProps !== undefined && typeof console !== "undefined") {
      console.warn(
        "[RhombusMediaPlayer] talkbackProps are ignored when talkback is false"
      );
    }
  }, [talkback, talkbackProps]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    let styleElement = document.getElementById(
      STYLE_ID
    ) as HTMLStyleElement | null;
    if (!styleElement) {
      styleElement = document.createElement("style");
      styleElement.id = STYLE_ID;
      document.head.appendChild(styleElement);
    }
    if (styleElement.textContent !== MEDIA_PLAYER_CSS) {
      styleElement.textContent = MEDIA_PLAYER_CSS;
    }
  }, []);

  const sharedMediaProps = useMemo<SharedMediaProps>(
    () => ({
      connectionMode,
      apiOverrideBaseUrl,
      rhombusApiBaseUrl,
      paths,
      federatedSessionToken,
      tokenDurationSec,
      headers,
      getRequestHeaders,
      maxRetryIntervalMs,
      stallTimeoutMs,
      onRecoveryAttempt,
      onError,
    }),
    [
      apiOverrideBaseUrl,
      connectionMode,
      federatedSessionToken,
      getRequestHeaders,
      headers,
      maxRetryIntervalMs,
      onError,
      onRecoveryAttempt,
      paths,
      rhombusApiBaseUrl,
      stallTimeoutMs,
      tokenDurationSec,
    ]
  );

  useImperativeHandle(
    ref,
    () => ({
      playbackController,
      getVideoPlayer: () => videoRef.current,
      getAudioPlayer: () => audioRef.current,
      getTalkback: () => talkbackRef.current,
    }),
    [playbackController]
  );

  const resolvedAudioControls =
    audioProps?.controls ?? (hasVideo ? ["volume"] : undefined);

  return (
    <div
      className={cx(
        "rhombus-media-player",
        classNames?.root,
        className
      )}
      style={{ ...styles?.root, ...style }}
      data-rhombus-media-player
      data-rhombus-media-has-video={hasVideo ? "true" : "false"}
      data-rhombus-media-audio-source={audioSource.type}
      data-rhombus-media-talkback={talkback ? "true" : "false"}
    >
      {hasVideo ? (
        <div
          className={cx(
            "rhombus-media-player-video",
            classNames?.video
          )}
          style={styles?.video}
        >
          <RhombusPlayer
            {...videoProps}
            {...sharedMediaProps}
            ref={videoRef}
            cameraUuid={resolvedCameraUuid}
            playbackController={playbackController}
          />
        </div>
      ) : null}

      <div
        className={cx(
          "rhombus-media-player-audio",
          classNames?.audio
        )}
        style={styles?.audio}
      >
        <RhombusAudioPlayer
          {...audioProps}
          {...sharedMediaProps}
          ref={audioRef}
          source={audioSource}
          playbackController={playbackController}
          controls={resolvedAudioControls}
        />
      </div>

      {talkback ? (
        <div
          className={cx(
            "rhombus-media-player-talkback",
            classNames?.talkback
          )}
          style={styles?.talkback}
        >
          <RhombusTalkback
            {...talkbackProps}
            {...sharedMediaProps}
            ref={talkbackRef}
            source={audioSource}
            playbackController={playbackController}
            disableTalkbackInVod={disableTalkbackInVod}
          />
        </div>
      ) : null}
    </div>
  );
});

function cx(...values: Array<string | undefined | false>): string {
  return values.filter(Boolean).join(" ");
}
