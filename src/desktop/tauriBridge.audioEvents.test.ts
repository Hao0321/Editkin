import { afterEach, describe, expect, it, vi } from "vitest";
import type { HaoDesktopApi, NativeAudioPreviewStatus } from "./types";

const ipc = vi.hoisted(() => ({ invoke: vi.fn(async (_command: string, _args?: unknown) => undefined) }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: ipc.invoke,
  convertFileSrc: (path: string) => path,
  Channel: class {
    constructor(public onmessage: (status: NativeAudioPreviewStatus) => void) {}
  },
}));

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); ipc.invoke.mockClear(); });

describe("Tauri native audio event wiring", () => {
  it("queries the retained owner without calling legacy status or mutating playback", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    await import("./tauriBridge");
    const api = (window as unknown as { haoDesktop: HaoDesktopApi }).haoDesktop;
    ipc.invoke.mockClear();
    await api.residentAudio!.status!(23);
    expect(ipc.invoke.mock.calls).toEqual([["resident_audio_status", { ownerId: 23 }]]);
  });
  it("passes a request-scoped channel and generation-scoped stop through the real adapter", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    await import("./tauriBridge");
    const api = (window as unknown as { haoDesktop: HaoDesktopApi }).haoDesktop;
    expect(api.nativeAudioPreviewPushEvents).toBe(true);
    const received = vi.fn();
    const project = {} as Parameters<NonNullable<HaoDesktopApi["startNativeAudioPreview"]>>[0];
    await api.startNativeAudioPreview!(project, 3, received);
    const [command, args] = ipc.invoke.mock.calls.at(-1) as unknown as [string, {
      project: unknown; timelineStartSeconds: number; onEvent: { onmessage: (status: NativeAudioPreviewStatus) => void };
    }];
    expect(command).toBe("start_native_audio_preview");
    expect(args.project).toBe(project);
    expect(args.timelineStartSeconds).toBe(3);
    const status: NativeAudioPreviewStatus = { generation: 7, active: true };
    args.onEvent.onmessage(status);
    expect(received).toHaveBeenCalledWith(status);
    await api.stopNativeAudioPreview!(7);
    expect(ipc.invoke).toHaveBeenLastCalledWith("stop_native_audio_preview", { expectedGeneration: 7 });
    expect(ipc.invoke.mock.calls.some(([name]) => name === "native_audio_preview_status")).toBe(false);
  });
});
