import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const boot = vi.hoisted(() => ({ loadApp: undefined as (() => Promise<unknown>) | undefined }));
vi.mock("react", async importOriginal => ({
  ...await importOriginal<typeof import("react")>(),
  lazy: (loadApp: () => Promise<unknown>) => {
    boot.loadApp = loadApp;
    return () => null;
  },
}));
vi.mock("react-dom/client", () => ({ createRoot: () => ({ render: () => undefined }) }));
vi.mock("./desktop/tauriBridge", () => ({}));

beforeEach(() => {
  vi.resetModules();
  boot.loadApp = undefined;
  vi.stubGlobal("document", { getElementById: () => ({}) });
});
afterEach(() => { vi.unstubAllGlobals(); vi.doUnmock("./App"); });

describe("editor startup", () => {
  it("can preview reopened studio and Wave 2 transitions before the lazy Inspector loads", async () => {
    vi.doMock("./App", async () => {
      const { createDemoProject } = await import("./domain/demo");
      const { previewTransitionState } = await import("./creative/corePack");
      // Exercise Preview's real preset lookup when App first becomes available,
      // without importing Inspector or any preset picker as a side effect.
      const previews = ["cine_short_fade_through_base", "exp26w2_public_transition_01"].map(presetId => {
        const clip = createDemoProject().tracks[0].clips[0];
        clip.creative = { effectPresetIds: [], transitionIn: { presetId, duration: .2 } };
        return previewTransitionState(clip, .1);
      });
      return { default: () => null, previews };
    });
    await import("./main");
    expect(boot.loadApp).toBeTypeOf("function");
    const loaded = await boot.loadApp!() as { previews: { opacity: number }[] };
    expect(loaded.previews).toHaveLength(2);
    for (const preview of loaded.previews) {
      expect(preview.opacity).toBeGreaterThan(0);
      expect(preview.opacity).toBeLessThan(1);
    }
  });
});
