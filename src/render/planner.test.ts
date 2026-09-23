import { describe, expect, it } from "vitest";
import { applyCommand } from "../domain/commands";
import { createDemoProject } from "../domain/demo";
import { buildRenderPlan } from "./planner";

describe("render planner", () => {
  it("preserves clips and inserts tail for captions", () => {
    let project = createDemoProject();
    project = applyCommand(project, { type: "add_caption", caption: { id: "caption-1", text: "完成", start: 11, duration: 3 } });
    const plan = buildRenderPlan(project, (uri) => uri);
    expect(plan.duration).toBe(14);
    expect(plan.videoLayers[0].segments).toHaveLength(2);
    expect(plan.videoLayers[0].segments[1]).toMatchObject({ kind: "gap", start: 12, duration: 2 });
    expect(plan.captions).toHaveLength(1);
  });

  it("preserves cross-track video overlap as two compositor layers", () => {
    const project = createDemoProject();
    project.tracks.push({ ...project.tracks[0], id: "video-overlay", name: "Overlay", clips: [{ ...project.tracks[0].clips[0], id: "overlay", trackId: "video-overlay" }] });
    const plan = buildRenderPlan(project, (uri) => uri);
    expect(plan.videoLayers).toHaveLength(2);
    expect(plan.videoLayers[1].segments[0]).toMatchObject({ kind: "clip", start: 0, duration: 12 });
  });

  it("keeps a Null controller available to export parenting without adding media audio", () => {
    const project = createDemoProject();
    project.tracks[0].clips[0].layer = { enabled: true, blendMode: "normal", role: "controller" };
    project.tracks.push({ ...structuredClone(project.tracks[0]), id: "video-child", name: "Child", clips: [{ ...structuredClone(project.tracks[0].clips[0]), id: "child", trackId: "video-child", layer: { enabled: true, blendMode: "normal", role: "content", parentClipId: "clip-demo" } }] });
    const plan = buildRenderPlan(project, (uri) => uri);
    expect(plan.videoLayers).toHaveLength(2);
    expect(plan.audioClips.map((item) => item.clip.id)).toEqual(["child"]);
  });
});
