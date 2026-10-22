import { describe, expect, it, vi } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import type { EditorCommand } from "../domain/commands";
import type { OriginalSourceOwnerRevisionProof } from "../domain/originalSourceOwnerRevision";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type MotionGraphic } from "../domain/types";
import { canonicalJson } from "../shared/canonicalJson";
import type { CurrentAutopilotPlan } from "./autopilotPlan";
import { verifyCurrentAutopilotMaterialEvidence, type AutopilotMaterialPredictionAuthority } from "./autopilotMaterialEvidence";

// These controls exercise only the real pre-I/O prediction authority boundary.
// They issue no trusted proof and claim no physical/font/media/render acceptance.
function fixture() {
  const project = createEmptyProject("New painted revision prediction negatives", { id: "prediction-owner", width: 640, height: 360, fps: 30 });
  project.assets.push({ id: "prediction-media", name: "Unread negative-control media", uri: "unread-prediction-media.mp4", kind: "video", duration: 5 });
  project.tracks[0].clips.push({ id: "prediction-clip", assetId: "prediction-media", trackId: project.tracks[0].id,
    sourceStart: 0, duration: 5, timelineStart: 0, volume: 1,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] });
  const graphic: MotionGraphic = { schema: "hao.motion-composition/v2", id: "prediction-title", name: "Original title", kind: "title",
    text: "原創標題", timelineStart: 0, duration: 5, x: .1, y: .2, width: .8, fontSize: 40,
    fontFamily: "Noto Sans TC", fontWeight: 700, textColor: "#172033", backgroundColor: "#FFFFFF00", accentColor: "#175CD3",
    visualStyle: "native_paint", paintV1: { schema: "editkin.motion-paint/v2", colorIntent: "display_rec709_sdr",
      fill: { kind: "solid", color: "#175CD3" }, clips: [] }, animation: "fade", offsetX: 0, offsetY: 0 };
  project.motionGraphics.push(graphic);
  const command: Extract<EditorCommand, { type: "revise_original_motion_scene_graphic" }> = {
    type: "revise_original_motion_scene_graphic", sceneId: "prediction-scene", expectedGraphic: structuredClone(graphic),
    graphic: { ...structuredClone(graphic), text: "改為更長的原創標題" },
  };
  const batch: Extract<EditorCommand, { type: "batch" }> = { type: "batch", commands: [command] };
  const evidence: Extract<CurrentAutopilotPlan["materialEvidence"], { schema: "hao.editkin.material-intelligence/v1" }> = {
    schema: "hao.editkin.material-intelligence/v1", receipts: [{ materialId: "a".repeat(64), sourceSha256: "b".repeat(64),
      assetId: "prediction-media", clipId: "prediction-clip", semanticReceiptSha256: "c".repeat(64) }],
  };
  const audio: CurrentAutopilotPlan["editorial"]["audio"] = { mode: "silent_media", dialoguePriority: true,
    blanketWhooshEveryCut: false, layers: [], impactFrames: [], breathFrames: [] };
  const resolveSource = vi.fn(async (_assetId: string): Promise<string> => { throw new Error("Prediction negative must reject before source I/O"); });
  const runtime = { cacheRoot: "unused-prediction-negative-cache", resolveSource };
  const before = canonicalJson(project);
  const verify = (authority?: AutopilotMaterialPredictionAuthority) => verifyCurrentAutopilotMaterialEvidence(
    evidence, project, runtime, [], { audio, commands: batch.commands }, authority);
  return { project, batch, resolveSource, before, verify };
}

describe("painted media revision private prediction authority", () => {
  it("rejects a host batch differing from the complete plan before looking up proof or media", async () => {
    const f = fixture(), mismatched = structuredClone(f.batch);
    const command = mismatched.commands[0];
    if (command.type !== "revise_original_motion_scene_graphic") throw new Error("Negative fixture command differs");
    command.graphic.text = "另一份命令";
    // This intentionally unissued object must never become execution authority.
    const forged = Object.freeze(Object.create(null)) as OriginalSourceOwnerRevisionProof;
    await expect(f.verify({ batch: mismatched, originalSourceOwnerRevisionProof: forged })).rejects.toThrow(/prediction authority batch differs/);
    expect(canonicalJson(f.project)).toBe(f.before);
    expect(f.resolveSource).not.toHaveBeenCalled();
  });

  it("rejects a matching batch with a forged proof at the real domain boundary", async () => {
    const f = fixture();
    const forged = Object.freeze(Object.create(null)) as OriginalSourceOwnerRevisionProof;
    await expect(f.verify({ batch: f.batch, originalSourceOwnerRevisionProof: forged })).rejects.toThrow(/ORIGINAL_SOURCE_OWNER_RECOMPILE_REQUIRED/);
    expect(canonicalJson(f.project)).toBe(f.before);
    expect(f.resolveSource).not.toHaveBeenCalled();
  });

  it("keeps raw source revisions refused when the host supplies no opaque authority", async () => {
    const f = fixture();
    await expect(f.verify()).rejects.toThrow(/ORIGINAL_SOURCE_OWNER_RECOMPILE_REQUIRED/);
    expect(canonicalJson(f.project)).toBe(f.before);
    expect(f.resolveSource).not.toHaveBeenCalled();
  });
});
