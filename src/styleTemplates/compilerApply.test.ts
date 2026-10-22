import { describe, expect, it } from "vitest";
import { applyCommand } from "../domain/commands";
import { createEmptyProject } from "../domain/editGraph";
import { validateProject } from "../domain/projectValidation";
import { DEFAULT_COLOR, type EditProject, type MediaAsset, type TimelineClip } from "../domain/types";
import { bindStyleJobClip, compileStylePlanV1 } from "./compiler";
import { fixturePlan, fixtureProject } from "./styleTemplates.fixture";
import { getStyleTemplateV1 } from "./templates";

/**
 * The compiler's commands are ordinary EditorCommands: they apply to a real
 * Editkin project and the result validates (looks via set_clip_grade_v2,
 * punch-ins via add_keyframe, rendered jobs via import_asset + add_clip with the
 * light leak on a screen-blend layer).
 */
function footageProject(): EditProject {
  let project = createEmptyProject("style test", { width: 1080, height: 1920, fps: 30 });
  for (const [index, id] of ["clip-a", "clip-b"].entries()) {
    const asset: MediaAsset = { id: `asset-${id}`, name: `${id}.mp4`, kind: "video", uri: `file:///footage/${id}.mp4`, duration: 5, width: 1080, height: 1920 };
    const clip: TimelineClip = { id, assetId: asset.id, trackId: "video-main", timelineStart: index * 5, sourceStart: 0, duration: 5, volume: 1,
      transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, color: { ...DEFAULT_COLOR }, keyframes: [] };
    project = applyCommand(project, { type: "import_asset", asset });
    project = applyCommand(project, { type: "add_clip", clip });
  }
  for (const [id, name] of [["style-finish", "風格・光效"], ["style-titles", "風格・標題"], ["style-captions", "風格・字幕"]]) {
    project = applyCommand(project, { type: "add_track", track: { id, name, kind: "video", locked: false, muted: false, clips: [] } });
  }
  return project;
}

describe("compiled commands apply to an Editkin project", () => {
  for (const id of ["S1_explainer_ui", "S2_story_illustrated", "S3_lifestyle_promo"]) {
    it(`applies ${id}`, () => {
      const template = getStyleTemplateV1(id);
      const result = compileStylePlanV1(template, fixturePlan(id), fixtureProject());
      expect(result.ok).toBe(true);
      let project = footageProject();
      for (const command of result.commands) project = applyCommand(project, command);
      for (const pending of result.pendingClips) {
        const job = result.jobs.find(candidate => candidate.id === pending.jobId)!;
        const rendered = { assetId: `style-${job.key}`, uri: `file:///cache/styletpl/${job.component}/${job.key}.mov`, width: 1080, height: 1920, durationSeconds: job.frameCount / job.fps };
        for (const command of bindStyleJobClip(pending, rendered, job.output)) project = applyCommand(project, command);
      }
      expect(() => validateProject(project)).not.toThrow();
      const clips = project.tracks.flatMap(track => track.clips);
      expect(clips.find(clip => clip.id === "clip-a")?.gradeV2?.look?.id).toBe(template.components.look.filmLookId);
      expect(clips.find(clip => clip.id === "clip-a")!.keyframes.length).toBeGreaterThan(2);
      expect(clips.filter(clip => clip.trackId === "style-captions")).toHaveLength(3);
      expect(clips.find(clip => clip.trackId === "style-finish")?.layer?.blendMode).toBe("screen");
      // S1 (R1): the footage under the bleed title becomes a blurred, darkened copy through an existing effect preset.
      const backdrop = clips.filter(clip => clip.creative?.effectPresetIds?.includes("studio_backdrop_soft"));
      if (id === "S1_explainer_ui") {
        expect(backdrop).toHaveLength(1);
        expect(backdrop[0].timelineStart).toBeCloseTo(5, 6);
        expect(backdrop[0].duration).toBeCloseTo(0.9, 6);
      } else expect(backdrop).toHaveLength(0);
    });
  }

  it("never grades screen recordings (Hao Film Looks are for camera footage)", () => {
    const template = getStyleTemplateV1("S1_explainer_ui");
    const plan = { ...fixturePlan(template.id), genre: "screen_recording" };
    const result = compileStylePlanV1(template, plan, fixtureProject());
    expect(result.look).toBeUndefined();
    expect(result.commands.some(command => command.type === "set_clip_grade_v2")).toBe(false);
  });
});
