import { describe, expect, it } from "vitest";
import { canvasResolutionForAsset, isStarterDemo } from "./sourceOrientation";
import { createDemoProject } from "../domain/demo";

describe("source orientation auto canvas", () => {
  it("maps portrait, landscape and square footage to stable delivery canvases", () => {
    expect(canvasResolutionForAsset({ kind: "video", width: 1080, height: 1920 })).toMatchObject({ width: 1080, height: 1920, orientation: "portrait", label: "9:16" });
    expect(canvasResolutionForAsset({ kind: "video", width: 3840, height: 2160 })).toMatchObject({ width: 1920, height: 1080, orientation: "landscape", label: "16:9" });
    expect(canvasResolutionForAsset({ kind: "image", width: 1024, height: 1024 })).toMatchObject({ width: 1080, height: 1080, orientation: "square", label: "1:1" });
    expect(canvasResolutionForAsset({ kind: "audio" })).toBeUndefined();
  });

  it("recognizes only the untouched starter demo", () => {
    const demo = createDemoProject();
    expect(isStarterDemo(demo)).toBe(true);
    demo.tracks[0].clips[0].duration = 3;
    expect(isStarterDemo(demo)).toBe(true);
    demo.assets.push({ id: "real", name: "real", kind: "video", uri: "real.mp4", duration: 1 });
    expect(isStarterDemo(demo)).toBe(false);
  });
});
