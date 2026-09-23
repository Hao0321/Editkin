import { createHash, webcrypto } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createAestheticOutputOwner } from "./aestheticOutputOwner";
import { createDemoProject } from "../domain/demo";
import { resolveAestheticSystem, scoreAestheticReview } from "./editkinAesthetic";
import { AESTHETIC_BENCHMARKS, BENCHMARK_AXES } from "../domain/aestheticBenchmarks";
import { applyCommand, type EditorCommandContext } from "../domain/commands";
import { renderReviewContentJson } from "../shared/renderReviewContent";
import { createAppRenderActions } from "./appRenderActions";
import { createProjectSession } from "./projectSession";
import type { AestheticBenchmarkReview } from "../domain/types";
import type { HaoDesktopApi } from "../desktop/types";

async function fixture() {
  const project = createDemoProject(); project.aestheticSystem = resolveAestheticSystem("gaming", "shorts");
  const artifact = { schema: "editkin.render-artifact-identity/v1" as const, outputSha256: "a".repeat(64), bytes: 40000, fps: 30, durationFrames: 300,
    projectContentSha256: createHash("sha256").update(renderReviewContentJson(project)).digest("hex") };
  const owner = createAestheticOutputOwner(webcrypto.subtle as unknown as SubtleCrypto);
  await owner.bind(project, artifact);
  const benchmarkReview: AestheticBenchmarkReview = { schema: "editkin.aesthetic-benchmark-review/v1", artifact,
    axes: Object.fromEntries(BENCHMARK_AXES.map(axis => [axis, Object.fromEntries(AESTHETIC_BENCHMARKS[axis].map(item => [item.id, {
      rating: 5, evidence: [{ fromFrame: 0, toFrame: 30, observation: "Synthetic integration fixture; not real human approval" }],
    }]))])) };
  const review = scoreAestheticReview(project.aestheticSystem, Object.fromEntries(project.aestheticSystem.dimensions.map(d => [d.id, 5])), { complete: true, benchmarkReview, currentArtifact: owner.get(project) });
  const context: EditorCommandContext = { currentAestheticArtifact: candidate => owner.get(candidate) };
  return { project, artifact, owner, review, context };
}

describe("output-bound aesthetic review journey (not certification)", () => {
  it("accepts complete current review only via application-owned output context", async () => {
    const f = await fixture();
    expect(applyCommand(f.project, { type: "set_aesthetic_review", review: f.review }).aestheticSystem!.review.status).toBe("REVIEW");
    const next = applyCommand(f.project, { type: "set_aesthetic_review", review: f.review }, f.context);
    expect(next.aestheticSystem!.review.status).toBe("PASSED");
    expect(next.director.reviewState).not.toBe("certified_95");
    expect(f.project.aestheticSystem!.review.status).toBe("REVIEW");
  });
  it("invalidates fast-path edits without mutating Undo history, and retains the old evidence", async () => {
    const f = await fixture();
    const accepted = applyCommand(f.project, { type: "set_aesthetic_review", review: f.review }, f.context);
    const edited = applyCommand(accepted, { type: "set_clip_volume", clipId: accepted.tracks[0].clips[0].id, volume: .4 }, f.context);
    expect(edited.aestheticSystem!.review.status).toBe("REVIEW");
    expect(accepted.aestheticSystem!.review.status).toBe("PASSED");
    expect(edited.aestheticSystem!.review.benchmarkReview).toEqual(accepted.aestheticSystem!.review.benchmarkReview);
  });
  it("cannot preserve acceptance with a later edit in the same batch", async () => {
    const f = await fixture();
    const next = applyCommand(f.project, { type: "batch", commands: [{ type: "set_aesthetic_review", review: f.review }, { type: "set_caption_style", patch: { color: "#FF0000" } }] }, f.context);
    expect(next.aestheticSystem!.review.status).toBe("REVIEW");
  });
  it("allows review notes but refuses stale/reset output ownership", async () => {
    const f = await fixture();
    const accepted = applyCommand(f.project, { type: "set_aesthetic_review", review: f.review }, f.context);
    expect(applyCommand(accepted, { type: "set_director_review_state", reviewState: "reviewing" }, f.context).aestheticSystem!.review.status).toBe("PASSED");
    f.owner.reset();
    expect(applyCommand(accepted, { type: "set_aesthetic_review", review: f.review }, f.context).aestheticSystem!.review.status).toBe("REVIEW");
  });
  it("does not bind a completed render to a project edited while the renderer ran", async () => {
    const f = await fixture(); const session = createProjectSession(f.project); const setStatus = vi.fn(); const bind = vi.fn();
    let finish!: (value: unknown) => void;
    const api = { renderProject: () => new Promise(resolve => { finish = resolve; }) } as unknown as HaoDesktopApi;
    const action = createAppRenderActions({ project: f.project, api, session, setStatus, onArtifactReady: bind });
    const running = action.renderVideo();
    session.setHistory(state => ({ ...state, present: applyCommand(state.present, { type: "rename_project", name: "later edit" }) }));
    finish({ canceled: false, outputPath: "candidate.mp4", artifactIdentity: f.artifact }); await running;
    expect(bind).not.toHaveBeenCalled();
    expect(setStatus.mock.lastCall?.[0]).toContain("不會套用到新版美感審查");
  });
  it("binds a current successful render but explicitly keeps human quality uncertified", async () => {
    const f = await fixture(); const session = createProjectSession(f.project); const setStatus = vi.fn(); const bind = vi.fn().mockResolvedValue(true);
    const api = { renderProject: async () => ({ canceled: false, outputPath: "candidate.mp4", encoder: "libx264", artifactIdentity: f.artifact }) } as unknown as HaoDesktopApi;
    await createAppRenderActions({ project: f.project, api, session, setStatus, onArtifactReady: bind }).renderVideo();
    expect(bind).toHaveBeenCalledWith(f.project, f.artifact);
    expect(setStatus.mock.lastCall?.[0]).toContain("尚未取得人工品質認證");
  });
});
