import { describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { compileBeatMontageInputSchema, compileBeatMontageReadOnly } from "./montageTools";

function fixture() {
  const project = createEmptyProject("MCP montage", { id: "mcp-montage", fps: 30 });
  project.revision = 17;
  project.assets.push(
    { id: "setup", name: "Setup", kind: "video", uri: "setup.mp4", duration: 8 },
    { id: "payoff", name: "Payoff", kind: "video", uri: "payoff.mp4", duration: 8 },
  );
  return project;
}

const validInput = {
  projectPath: "demo.editkin.json",
  targetTrackId: "video-main",
  beatTimes: [0, 1, 2],
  candidates: [
    { shotId: "setup", assetId: "setup", sourceStart: 0, sourceEnd: 4, salience: .8, storyOrder: 1 },
    { shotId: "payoff", assetId: "payoff", sourceStart: 1, sourceEnd: 5, salience: .9, storyOrder: 2 },
  ],
  clipIds: ["montage-setup", "montage-payoff"],
};

describe("compile_beat_montage MCP boundary", () => {
  it("reads one project and returns a revision-bound command without mutating it", async () => {
    const project = fixture();
    const snapshot = structuredClone(project);
    const paths: string[] = [];
    const result = await compileBeatMontageReadOnly(validInput, {
      readProject: async (projectPath) => { paths.push(projectPath); return project; },
    });
    expect(paths).toEqual(["demo.editkin.json"]);
    expect(project).toEqual(snapshot);
    expect(result).toMatchObject({
      status: "DRAFT_COMMAND_CANDIDATE",
      mutationPerformed: false,
      evidenceAuthority: "caller_asserted_unverified",
      projectId: "mcp-montage",
      projectRevision: 17,
      executionBoundary: "compile_only_v4_plan_audit_atomic_apply_required",
      directApplyAllowed: false,
      guarantees: { shotSelection: true, cutPointsOnBeat: true, pairwiseTransitions: false, timeRemap: false, splitAudioEdits: false },
      command: { type: "batch" },
    });
    expect(result.command.commands).toHaveLength(2);
  });

  it("uses a strict bounded Zod contract", () => {
    const { targetTrackId: _targetTrackId, ...withoutTargetTrack } = validInput;
    expect(compileBeatMontageInputSchema.parse(withoutTargetTrack).targetTrackId).toBe("video-main");
    expect(compileBeatMontageInputSchema.safeParse({ ...validInput, bypassApply: true }).success).toBe(false);
    expect(compileBeatMontageInputSchema.safeParse({ ...validInput, beatTimes: Array.from({ length: 66 }, (_, index) => index) }).success).toBe(false);
    expect(compileBeatMontageInputSchema.safeParse({ ...validInput, candidates: Array.from({ length: 513 }, (_, index) => ({
      shotId: `shot-${index}`, assetId: "setup", sourceStart: 0, sourceEnd: 4, salience: .5, storyOrder: index,
    })) }).success).toBe(false);
    expect(compileBeatMontageInputSchema.safeParse({ ...validInput, candidates: [{ ...validInput.candidates[0], hiddenCommand: "apply" }] }).success).toBe(false);
  });

  it("fails closed when caller clipIds cannot bind every beat slot", async () => {
    await expect(compileBeatMontageReadOnly({ ...validInput, clipIds: ["only-one"] }, { readProject: async () => fixture() }))
      .rejects.toThrow(/clipIds/);
  });

  it("compiles onto an explicitly selected non-default video track", async () => {
    const project = fixture();
    project.tracks.push({ id: "video-pip", name: "畫中畫", kind: "video", locked: false, muted: false, clips: [] });
    const result = await compileBeatMontageReadOnly({ ...validInput, targetTrackId: "video-pip" }, { readProject: async () => project });
    expect(result.targetTrackId).toBe("video-pip");
    expect(result.command.commands.every((command) => command.type === "add_clip" && command.clip.trackId === "video-pip")).toBe(true);
  });
});
