import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createEmptyProject, projectDuration, validateProject } from "../domain/editGraph";
import { createDemoProject } from "../domain/demo";
import type { EditProject } from "../domain/types";
import type { SpringTargetTrack } from "../domain/motionContinuity";
import { createMotionGraphic } from "../motion/composition";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { activeMediaLayers } from "../application/previewMedia";
import { Preview } from "./Preview";

const track = (position: number, targets: readonly { frame: number; target: number }[] = []): SpringTargetTrack => ({
  fps: 30, initialPosition: position, initialTarget: position, initialVelocity: 0,
  spring: { stiffness: 100, damping: 20, mass: 1 }, events: targets,
});

/** Complete editable 18-second source fixture only: no media, render or art claim. */
function originalSequence(): EditProject {
  const project = createEmptyProject("Original 18-second sequence source fixture", { width: 1080, height: 1920, fps: 30 });
  const graphic = createMotionGraphic("persistent-object", "card", "", 0, 18, undefined,
    findMotionGraphicPreset("reel_native_disc").seed);
  graphic.x = .3; graphic.y = .45; graphic.width = .25;
  if (!graphic.vectorV2) throw new Error("Genuine original vector preset required");
  graphic.vectorV2.heightPixels = 120;
  graphic.vectorV2.revealFrames = 1;
  project.motionGraphics = [graphic];
  project.motionScenes = [{ schema: "editkin.motion-scene-2d/v1", id: "complete-original-scene", startFrame: 0,
    durationFrames: 540, fps: 30, graphicIds: [graphic.id],
    camera: { centerX: track(540, [{ frame: 180, target: 560 }, { frame: 360, target: 520 }]),
      centerY: track(960), zoom: track(1, [{ frame: 180, target: 1.08 }, { frame: 360, target: 1 }]) },
    safeArea: { left: 48, right: 48, top: 72, bottom: 72 },
    semanticCues: [
      { id: "introduce", frame: 0, purpose: "Introduce the persistent original object", graphicIds: [graphic.id], evidenceRefs: ["authoring:opening"] },
      { id: "focus", frame: 180, purpose: "Focus the same object through a continuous camera target", graphicIds: [graphic.id], evidenceRefs: ["authoring:focus"] },
      { id: "resolve", frame: 360, purpose: "Settle the complete closing interval", graphicIds: [graphic.id], evidenceRefs: ["authoring:closing"] },
    ] }];
  return validateProject(project);
}

function markup(project: EditProject, playhead = 0) {
  return renderToStaticMarkup(<Preview project={project} layers={activeMediaLayers(project, playhead, {}, "video")}
    audioLayers={[]} projectWidth={project.width} projectHeight={project.height} projectFps={project.fps}
    projectDuration={projectDuration(project)} playhead={playhead} captions={project.captions} captionStyle={project.captionStyle}
    playing={false} onPlayingChange={() => undefined} onPlayheadChange={() => undefined} />);
}

describe("original motion-only preview canvas (source SSR, not rendered/art proof)", () => {
  it("keeps the complete editable 540-frame sequence black without fake media or empty-project instructions", () => {
    const project = originalSequence(), before = JSON.stringify(project);
    expect(project.assets).toEqual([]);
    expect(project.tracks.flatMap(value => value.clips)).toEqual([]);
    expect(projectDuration(project)).toBe(18);
    expect(project.motionScenes![0].durationFrames).toBe(540);
    for (const time of [0, 6, 12, 539 / 30]) {
      const html = markup(project, time);
      expect(html).toContain('data-preview-motion-canvas="original"');
      expect(html).toContain("background:black");
      expect(html).not.toContain("先從左側加入影片或照片");
      expect(html).not.toContain('class="empty-preview"');
      expect(html).not.toContain('data-testid="preview-video"');
    }
    expect(markup(JSON.parse(before) as EditProject, 6)).toBe(markup(project, 6));
    expect(JSON.stringify(project)).toBe(before);
  });

  it("preserves a saved background vector above the black base without inventing a media clip", () => {
    const project = originalSequence();
    const background = structuredClone(project.motionGraphics[0]);
    background.id = "authored-background";
    background.compositeLayer = "background";
    background.x = 0; background.y = 0; background.width = 1;
    if (background.vectorV2?.kind !== "ellipse") throw new Error("Actual ellipse preset required for the background stage fixture");
    background.vectorV2.schema = "editkin.motion-vector-stage/v1";
    background.vectorV2.heightPixels = project.height;
    project.motionGraphics.push(background);
    validateProject(project);
    const html = markup(project, 9);
    expect(html).toContain('data-preview-motion-canvas="original"');
    expect(html).toContain("background:black");
    expect(html).not.toContain("先從左側加入影片或照片");
    expect(project.motionGraphics.find(value => value.id === "authored-background")?.compositeLayer).toBe("background");
    expect(project.tracks.flatMap(value => value.clips)).toEqual([]);
    // Lazy SSR does not prove that the background path has been painted.
  });

  it("retains the genuine empty-project instructions and refuses to treat an orphan scene shell as artwork", () => {
    const empty = createEmptyProject("Empty"), html = markup(empty);
    expect(html).toContain("先從左側加入影片或照片");
    expect(html).toContain('class="empty-preview"');
    expect(html).not.toContain("data-preview-motion-canvas");
    const orphan = originalSequence();
    orphan.motionGraphics = [];
    const orphanHtml = markup(orphan);
    expect(orphanHtml).toContain("先從左側加入影片或照片");
    expect(orphanHtml).not.toContain("data-preview-motion-canvas");
  });

  it("preserves the existing media route when the project contains a real timeline video fixture", () => {
    const mediaProject = createDemoProject();
    mediaProject.motionGraphics = originalSequence().motionGraphics;
    const html = markup(mediaProject);
    expect(html).toContain('data-testid="preview-video"');
    expect(html).not.toContain("data-preview-motion-canvas");
    expect(html).not.toContain("background:black");
    expect(mediaProject.tracks.flatMap(value => value.clips).length).toBeGreaterThan(0);
  });
});
