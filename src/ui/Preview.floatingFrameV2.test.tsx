import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { activeMediaLayers } from "../application/previewMedia";
import { createEmptyProject, validateProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject } from "../domain/types";
import { floatingVideoFramePreset, floatingVideoFramePresetV2 } from "../motion/floatingVideoFrame";
import { Preview } from "./Preview";

function fixture(): EditProject {
  const project = createEmptyProject("Original floating preview consumer", { width: 360, height: 640, fps: 30 });
  project.assets.push({ id: "owned-landscape", name: "Owned landscape", kind: "video", uri: "owned.mp4", duration: 5,
    width: 640, height: 360, displayAspectRatio: 16 / 9, color: { interpretation: "rec709" } });
  project.tracks[0].clips.push({ id: "actual-clip", trackId: "video-main", assetId: "owned-landscape",
    timelineStart: .5, sourceStart: .4, duration: 2, volume: 0, transform: { ...DEFAULT_TRANSFORM },
    color: { ...DEFAULT_COLOR }, keyframes: [], floatingFrame: floatingVideoFramePresetV2("matte") });
  return project;
}

function markup(project: EditProject, playhead: number, playing = false): string {
  return renderToStaticMarkup(<Preview project={project} layers={activeMediaLayers(project, playhead, {}, "video")} audioLayers={[]}
    projectWidth={project.width} projectHeight={project.height} projectFps={project.fps} projectDuration={2.5}
    playhead={playhead} captions={[]} captionStyle={project.captionStyle} playing={playing}
    onPlayingChange={() => {}} onPlayheadChange={() => {}} />);
}

function numberAttribute(html: string, name: string): number {
  const value = html.match(new RegExp(`${name}="([^"]+)"`));
  if (!value) throw new Error(`Missing actual consumer attribute ${name}`);
  return Number(value[1]);
}

describe("Preview v2 source-aware floating consumer", () => {
  it("uses landscape source DAR inside a portrait canvas with contain instead of canvas-shaped cover", () => {
    const project = fixture(), before = structuredClone(project);
    const html = markup(project, .5 + 6 / 30);
    expect(html).toContain('data-floating-frame-schema="editkin.floating-video-frame/v2"');
    expect(html).toContain("object-fit:contain");
    expect(html).not.toContain("object-fit:cover");
    expect(numberAttribute(html, "data-floating-inner-width")).toBeGreaterThan(numberAttribute(html, "data-floating-inner-height"));
    expect(numberAttribute(html, "data-floating-inner-width") / numberAttribute(html, "data-floating-inner-height")).toBeCloseTo(16 / 9, 1);
    const mediaStyle = html.match(/<video[^>]*style="([^"]+)"/)![1];
    expect(mediaStyle).toContain("position:absolute");
    const left = Number(mediaStyle.match(/left:([\d.]+)%/)![1]), top = Number(mediaStyle.match(/top:([\d.]+)%/)![1]);
    const mediaWidth = Number(mediaStyle.match(/width:([\d.]+)%/)![1]), mediaHeight = Number(mediaStyle.match(/height:([\d.]+)%/)![1]);
    expect(left).toBeGreaterThan(0); expect(top).toBeGreaterThan(0);
    expect(mediaWidth).toBeLessThan(100); expect(mediaHeight).toBeLessThan(100);
    expect(2 * left + mediaWidth).toBeCloseTo(100, 10);
    expect(2 * top + mediaHeight).toBeCloseTo(100, 10);
    expect(html).toContain("background-color:#121516");
    expect(project).toEqual(before);
  });

  it("gives explicit physical DAR priority over stored square-pixel raster dimensions", () => {
    const project = fixture();
    project.assets[0].width = 720; project.assets[0].height = 576; project.assets[0].displayAspectRatio = 5 / 3;
    const explicit = markup(project, 1);
    delete project.assets[0].displayAspectRatio;
    const legacyDimensions = markup(project, 1);
    expect(numberAttribute(explicit, "data-floating-inner-width") / numberAttribute(explicit, "data-floating-inner-height")).toBeCloseTo(5 / 3, 1);
    expect(numberAttribute(legacyDimensions, "data-floating-inner-width") / numberAttribute(legacyDimensions, "data-floating-inner-height")).toBeCloseTo(5 / 4, 1);
  });

  it("uses clip-local integer frames for pause, seek and the last real frame independently of source offset", () => {
    const project = fixture();
    expect(numberAttribute(markup(project, .5), "data-floating-opacity")).toBe(0);
    const paused = markup(project, .5 + 3 / 30), playing = markup(project, .5 + 3 / 30, true);
    expect(numberAttribute(paused, "data-floating-local-frame")).toBe(3);
    expect(numberAttribute(paused, "data-floating-opacity")).toBe(.5);
    expect(numberAttribute(playing, "data-floating-opacity")).toBe(.5);
    expect(numberAttribute(markup(project, .5 + 6 / 30), "data-floating-opacity")).toBe(1);
    expect(numberAttribute(markup(project, .5 + 59 / 30), "data-floating-opacity")).toBe(0);
    expect(markup(project, .5 - 1 / 30)).not.toContain('data-testid="preview-floating-video-frame"');
    expect(markup(project, 2.5)).not.toContain('data-testid="preview-floating-video-frame"');
  });

  it("reports missing or invalid explicit source metadata without showing canvas fallback video", () => {
    const project = fixture();
    delete project.assets[0].displayAspectRatio; delete project.assets[0].width; delete project.assets[0].height;
    const missing = markup(project, 1);
    expect(missing).toContain('data-testid="preview-floating-frame-unavailable"');
    expect(missing).toContain("請重新讀取素材資訊");
    expect(missing).not.toContain('data-testid="preview-video"');
    project.assets[0].width = 640; project.assets[0].height = 360; project.assets[0].displayAspectRatio = NaN;
    expect(markup(project, 1)).toContain('data-testid="preview-floating-frame-unavailable"');
  });

  it("matches rounded export start for both admitted sub-microframe noise signs without changing the saved clip", () => {
    const aligned = fixture();
    for (const noiseFrames of [.5e-6, -.5e-6]) {
      const noisy = fixture(); noisy.tracks[0].clips[0].timelineStart += noiseFrames / noisy.fps;
      expect(() => validateProject(noisy)).not.toThrow();
      const before = structuredClone(noisy);
      for (const localFrame of [1, 3, 6, 57, 59]) {
        const playhead = (15 + localFrame) / noisy.fps;
        const reference = markup(aligned, playhead), actual = markup(noisy, playhead);
        expect(numberAttribute(actual, "data-floating-local-frame")).toBe(localFrame);
        expect(numberAttribute(actual, "data-floating-opacity")).toBe(numberAttribute(reference, "data-floating-opacity"));
        expect(actual.match(/matrix3d\([^)]*\)/)![0]).toBe(reference.match(/matrix3d\([^)]*\)/)![0]);
      }
      expect(noisy).toEqual(before);
      expect(noisy.tracks[0].clips[0].sourceStart).toBe(.4);
    }
  });

  it("keeps saved v1 cover and fully visible first frame without requiring new source metadata", () => {
    const project = fixture(); project.tracks[0].clips[0].floatingFrame = floatingVideoFramePreset("matte");
    delete project.assets[0].displayAspectRatio; delete project.assets[0].width; delete project.assets[0].height;
    const html = markup(project, .5);
    expect(html).toContain('data-floating-frame-schema="editkin.floating-video-frame/v1"');
    expect(html).toContain("object-fit:cover");
    expect(numberAttribute(html, "data-floating-opacity")).toBe(1);
    expect(html).not.toContain("preview-floating-frame-unavailable");
  });

  it("keeps portrait orbit as an explicit portrait plane while containing the whole landscape source", () => {
    const project = fixture(); project.tracks[0].clips[0].floatingFrame = floatingVideoFramePresetV2("portrait_orbit");
    const html = markup(project, 1);
    expect(numberAttribute(html, "data-floating-inner-width")).toBeLessThan(numberAttribute(html, "data-floating-inner-height"));
    expect(html).toContain("object-fit:contain");
  });
});
