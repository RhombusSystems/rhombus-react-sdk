import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMediaUrisRequestBody } from "./rhombusPlayback.js";
import { fetchPresenceWindows } from "./rhombusPresence.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildMediaUrisRequestBody", () => {
  it("sends cameraUuid for cameras in both modes", () => {
    expect(buildMediaUrisRequestBody("cam-1", undefined, "direct")).toEqual({
      cameraUuid: "cam-1",
    });
    expect(buildMediaUrisRequestBody("cam-1", "camera", "override")).toEqual({
      cameraUuid: "cam-1",
    });
  });

  it("speaks the doorbell endpoint's deviceUuid shape in direct mode", () => {
    expect(buildMediaUrisRequestBody("dr40-1", "doorbell", "direct")).toEqual({
      deviceUuid: "dr40-1",
    });
  });

  it("keeps cameraUuid and tags deviceType for proxy routing in override mode", () => {
    expect(buildMediaUrisRequestBody("dr40-1", "doorbell", "override")).toEqual({
      cameraUuid: "dr40-1",
      deviceType: "doorbell",
    });
  });
});

describe("fetchPresenceWindows deviceType routing", () => {
  function stubFetch() {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ presenceWindows: {} }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("targets /doorbellcamera/getPresenceWindows with deviceUuid in direct mode", async () => {
    const fetchMock = stubFetch();
    await fetchPresenceWindows({
      cameraUuid: "dr40-1",
      deviceType: "doorbell",
      startTimeSec: 100,
      durationSec: 60,
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/doorbellcamera/getPresenceWindows");
    expect(JSON.parse(init.body as string)).toEqual({
      deviceUuid: "dr40-1",
      startTimeSec: 100,
      durationSec: 60,
    });
  });

  it("keeps the proxy path and tags the body with deviceType in override mode", async () => {
    const fetchMock = stubFetch();
    await fetchPresenceWindows({
      apiOverrideBaseUrl: "https://proxy.example",
      cameraUuid: "dr40-1",
      deviceType: "doorbell",
      startTimeSec: 100,
      durationSec: 60,
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://proxy.example/api/presence-windows");
    expect(JSON.parse(init.body as string)).toEqual({
      cameraUuid: "dr40-1",
      deviceType: "doorbell",
      startTimeSec: 100,
      durationSec: 60,
    });
  });

  it("leaves camera requests untouched", async () => {
    const fetchMock = stubFetch();
    await fetchPresenceWindows({
      apiOverrideBaseUrl: "https://proxy.example",
      cameraUuid: "cam-1",
      startTimeSec: 100,
      durationSec: 60,
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      cameraUuid: "cam-1",
      startTimeSec: 100,
      durationSec: 60,
    });
  });
});
