import { describe, expect, it, vi } from "vitest";
import { createEngineTaskHostV1 } from "../desktop/engineTaskHostV1";
import { MOTION_LIBRARY_CANCELLED_V1, MOTION_LIBRARY_ENGINE_OUTDATED_V1, desktopMotionLibraryRenderHostV1, motionLibraryProgressFractionV1 } from "./motionLibraryRenderHostV1";
import { createMotionLibraryUiStoreV1, parseTransitionPresetV1 } from "./motionLibraryUiStoreV1";

const input = { itemId: "T01", params: {}, width: 1080, height: 1920, fps: 30 };

describe("desktop render route (engine task motion_library_render_v1)", () => {
  it("sends only item/params/frame size (no paths), filters progress by kind and binds the reply to the request", async () => {
    let receive: (event: unknown) => void = () => undefined;
    let resolve!: (value: unknown) => void;
    const invoke = vi.fn((command: string, _args: Record<string, unknown>) => command === "run_engine_task_v1" ? new Promise(done => { resolve = done; }) : Promise.resolve({}));
    const api = createEngineTaskHostV1(invoke as never, callback => { receive = callback; return {}; });
    const onProgress = vi.fn();
    const pending = api.runMotionLibraryRenderTaskV1({ operationId: "motion-library-test-1", ...input }, { onProgress });
    const sent = (invoke.mock.calls[0][1] as { request: Record<string, unknown> }).request;
    expect(sent).toEqual({ schema: "editkin.engine-task/v1", kind: "motion_library_render_v1", input: { operationId: "motion-library-test-1", ...input } });
    receive({ schema: "editkin.engine-task-progress/v1", kind: "motion_library_render_v1", operationId: "motion-library-test-1", progress: { stage: "generate", completed: 3, total: 10 } });
    receive({ schema: "editkin.engine-task-progress/v1", kind: "auto_reframe_v1", operationId: "motion-library-test-1", progress: { stage: "verify", completed: 1, total: 1 } });
    receive({ schema: "editkin.engine-task-progress/v1", kind: "motion_library_render_v1", operationId: "motion-library-test-1", progress: { stage: "unknown", completed: 1, total: 1 } });
    expect(onProgress).toHaveBeenCalledOnce();
    resolve({ schema: "editkin.engine-task-reply/v1", kind: "motion_library_render_v1", operationId: "motion-library-test-1",
      result: { schema: "editkin.motion-library-render-reply/v1", request: { operationId: "motion-library-test-1", ...input }, itemId: "T02" } });
    await expect(pending).rejects.toThrow("ENGINE_TASK_REPLY_BINDING_CHANGED");
  });

  it("maps an engine without the kind to a plain update message and a cancellation to the cancel code", async () => {
    const outdated = desktopMotionLibraryRenderHostV1({ renderMotionLibraryV1: async () => { throw new Error("ENGINE_TASK_KIND_UNSUPPORTED"); } })!;
    await expect(outdated.render(input, { signal: new AbortController().signal, onProgress: () => undefined })).rejects.toThrow(MOTION_LIBRARY_ENGINE_OUTDATED_V1);
    const controller = new AbortController();
    const cancelled = desktopMotionLibraryRenderHostV1({ renderMotionLibraryV1: async () => { controller.abort(); throw new Error("ENGINE_TASK_CANCELLED"); } })!;
    await expect(cancelled.render(input, { signal: controller.signal, onProgress: () => undefined })).rejects.toThrow(MOTION_LIBRARY_CANCELLED_V1);
    expect(desktopMotionLibraryRenderHostV1({})).toBeUndefined();
    expect(motionLibraryProgressFractionV1("generate", 5, 10)).toBeCloseTo(0.41);
    expect(motionLibraryProgressFractionV1("done", 1, 1)).toBe(1);
  });

  it("remembers the last transition per viewer and rejects malformed presets", () => {
    const saved = new Map<string, string>();
    const storage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { saved.set(key, value); } };
    const store = createMotionLibraryUiStoreV1({ storage });
    expect(store.getSnapshot().lastTransition).toEqual({ kind: "dissolve" });
    store.rememberTransition({ kind: "matte", itemId: "X17", params: { energy: "hype" } });
    expect(createMotionLibraryUiStoreV1({ storage }).getSnapshot().lastTransition).toEqual({ kind: "matte", itemId: "X17", params: { energy: "hype" } });
    expect(parseTransitionPresetV1({ kind: "matte", itemId: "T01" })).toBeUndefined();
    expect(parseTransitionPresetV1({ kind: "wipe" })).toBeUndefined();
    store.openPanel({ tab: "transition", focusCut: { trackId: "v", fromClipId: "a", toClipId: "b" } });
    expect(store.getSnapshot()).toMatchObject({ tab: "transition", panelRequest: 1, focusCut: { fromClipId: "a" } });
  });
});
