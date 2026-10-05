import { afterEach, describe, expect, it, vi } from "vitest";
import { importBrowserMedia } from "./browserMedia";

afterEach(() => vi.unstubAllGlobals());
function fixture(width = 640, height = 360) {
  let source = "";
  const element = { duration: 9, videoWidth: width, videoHeight: height, preload: "",
    onloadedmetadata: null as (() => void) | null, onerror: null as (() => void) | null,
    get src() { return source; },
    set src(value: string) { source = value; queueMicrotask(() => element.onloadedmetadata?.()); } };
  const create = vi.fn(() => "blob:owned-browser-geometry"), revoke = vi.fn();
  vi.stubGlobal("document", { createElement: vi.fn(() => element) });
  vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: revoke });
  return { element, create, revoke };
}
describe("browser media producer intrinsic geometry (source fixture, not decoder observation)", () => {
  it("carries intrinsic video DAR without changing the file, local URI, clock or owned URL", async () => {
    const f = fixture(), file = new File(["original bytes"], "owned source.mp4", { type: "video/mp4" });
    const before = await file.text(), imported = await importBrowserMedia(file);
    expect(imported.asset).toMatchObject({ kind: "video", duration: 9, width: 640, height: 360,
      displayAspectRatio: 16 / 9, uri: "local://owned%20source.mp4" });
    expect(imported.runtimeUrl).toBe("blob:owned-browser-geometry"); expect(f.element.src).toBe(imported.runtimeUrl);
    expect(await file.text()).toBe(before); expect(f.create).toHaveBeenCalledExactlyOnceWith(file);
    expect(f.revoke).not.toHaveBeenCalled();
  });
  it("does not manufacture video DAR for audio metadata", async () => {
    fixture(); const imported = await importBrowserMedia(new File(["audio"], "voice.wav", { type: "audio/wav" }));
    expect(imported.asset.kind).toBe("audio"); expect(imported.asset.displayAspectRatio).toBeUndefined();
    expect(imported.asset.width).toBeUndefined(); expect(imported.asset.height).toBeUndefined();
  });
  it("rejects missing intrinsic geometry and releases its newly prepared URL", async () => {
    const f = fixture(0, 360);
    await expect(importBrowserMedia(new File(["original"], "unknown.mp4", { type: "video/mp4" }))).rejects.toThrow(/展示尺寸/);
    expect(f.revoke).toHaveBeenCalledExactlyOnceWith("blob:owned-browser-geometry");
  });
});
