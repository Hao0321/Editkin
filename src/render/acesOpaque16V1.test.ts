import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type ColorManagementSettings, type TimelineClip } from "../domain/types";
import { compileClipAlphaPlan } from "../domain/clipAlphaPlan";
import { compositorVideoFilters, overlayPositionedFilter } from "./ffmpegComposite";
import { aces16BlendFilterV1, aces16OverOpaqueGraphV1, aces16PositionedLayerGraphV1, acesCompositeWorkingPixelsV1, usesOpaqueAces16V1 } from "./acesOpaque16V1";
import { buildRenderPlan } from "./planner";

const colorRoot = fileURLToPath(new URL("../../public/color/aces2", import.meta.url));
const management: ColorManagementSettings = { mode: "aces2", workingSpace: "ACEScct", outputTransform: "rec709_sdr", configId: "studio-config-v4.0.0_aces-v2.0_ocio-v2.5", rec709DisplayPolicy: "phone-bt1886" };
function fixture() {
  const project = createEmptyProject("Working precision", { width: 64, height: 32, fps: 30 });
  project.colorManagement = management;
  project.assets.push({ id: "a", name: "Owned", uri: "owned.mkv", kind: "video", duration: 3, width: 64, height: 32, color: { interpretation: "acescct" } });
  const clip: TimelineClip = { id: "c", trackId: project.tracks[0].id, assetId: "a", timelineStart: 2 / 30, sourceStart: 0, duration: 2 / 30, volume: 0, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] };
  project.tracks[0].clips.push(clip);
  return { project, clip, plan: buildRenderPlan(project, u => u) };
}
describe("opaque ACES working precision is separate from delivery", () => {
  it("uses16 only for the explicitly new recipe and retains opaque H264 delivery", () => {
    expect(usesOpaqueAces16V1(management)).toBe(true);
    expect(acesCompositeWorkingPixelsV1(management, false)).toMatchObject({ rgba: "gbrap16le", grayMaximum: 65535, encodedPixelFormat: "yuv420p" });
    for (const old of [undefined, { ...management, mode: "rec709" as const }, { ...management, rec709DisplayPolicy: undefined }, { ...management, rec709DisplayPolicy: "legacy-grade-v2" as const }]) {
      expect(usesOpaqueAces16V1(old)).toBe(false);
      expect(acesCompositeWorkingPixelsV1(old, false)).toMatchObject({ rgba: "rgba", grayMaximum: 255, encodedPixelFormat: "yuv420p" });
    }
    expect(acesCompositeWorkingPixelsV1(undefined, true)).toMatchObject({ rgba: "gbrap16le", grayMaximum: 65535, encodedPixelFormat: "yuva444p10le" });
  });
  it("does not send the new photograph through low-depth overlay, eq or hue", () => {
    const { project, clip, plan } = fixture(); clip.color.saturation = 1.1; clip.color.hue = 10;
    const graph = compositorVideoFilters({ clip, alphaPlan: compileClipAlphaPlan(project, clip, "formal"), asset: project.assets[0], assetPath: "owned.mkv", inputIndex: 2, probe: { duration: 3, hasVideo: true, hasAudio: false } }, "clip", plan, project, colorRoot).join(";");
    expect(graph).toContain("format=yuva444p16le"); expect(graph).not.toMatch(/(?:^|[,;])eq=/); expect(graph).not.toContain("hue=");
    expect(overlayPositionedFilter("base", "clip", "result", clip, plan, project)).toContain("maskedmerge=planes=7");
    expect(overlayPositionedFilter("base", "clip", "result", clip, plan, project)).not.toContain("overlay=");
    const old = { ...project, colorManagement: { ...management, rec709DisplayPolicy: undefined } };
    const legacy = compositorVideoFilters({ clip, alphaPlan: compileClipAlphaPlan(old, clip, "formal"), asset: old.assets[0], assetPath: "owned.mkv", inputIndex: 2, probe: { duration: 3, hasVideo: true, hasAudio: false } }, "clip", plan, old, colorRoot).join(";");
    expect(legacy).toMatch(/(?:^|[,;])eq=/); expect(legacy).toContain("hue="); expect(legacy).not.toContain("aces16");
    expect(overlayPositionedFilter("base", "clip", "result", clip, plan, old)).toContain("overlay=");
  });
  it("pads exact project ticks before and after a delayed clip, then keeps straight-alpha placement", () => {
    const { project, clip, plan } = fixture(); const before = structuredClone(project);
    const graph = aces16PositionedLayerGraphV1("in", "out", clip, plan, project).join(";");
    expect(graph).toContain("tpad=start=2:stop=-1:start_mode=add:stop_mode=add:color=black@0");
    expect(graph).toContain("trim=end_frame=4"); expect(graph).toContain("remap=fill=black@0"); expect(graph).not.toContain("maskedmerge");
    expect(project).toEqual(before);
  });
  it("colour blend preserves opaque alpha and validates internal graph labels", () => {
    expect(aces16BlendFilterV1("b", "f", "o", "multiply")).toContain("c3_mode=normal");
    expect(aces16OverOpaqueGraphV1("b", "f", "o").join(";")).toContain("maskedmerge=planes=7");
    expect(() => aces16BlendFilterV1("b", "f", "o", "x;null")).toThrow();
    expect(() => aces16OverOpaqueGraphV1("b]", "f", "o")).toThrow();
  });
});
