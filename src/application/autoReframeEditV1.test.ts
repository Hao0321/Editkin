import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../shared/canonicalJson";
import { createHistory, dispatchCommand, undo, redo } from "../domain/history";
import { createAutoReframeSparseV2 } from "./autoReframeSparseV2";
import { admitAutoReframePlanV1, autoReframeJobRequestV1, autoReframeProjectDigestV1, autoReframeRequestSchemaV1, autoReframeTargetV1,
  beginAutoReframeEditV1, takeAutoReframeApplicationV1, settleAutoReframeApplicationV1, type AutoReframeReplyV1 } from "./autoReframeEditV1";
import { autoReframeWorkflowFixtureV1, instrumentOnlyWorkflowReplyV1, workflowIdentityV1 } from "./__fixtures__/autoReframeWorkflowV1.fixture";

async function fixture(mode: "current_portrait" | "new_portrait_project" = "current_portrait", unknown = false) {
  const p = autoReframeWorkflowFixtureV1(mode === "current_portrait"), job = await beginAutoReframeEditV1(p, "selected", { operationId: "unit-operation", mode,
    outputWidth: 90, outputHeight: 160, subject: { kind: "saliency" }, ...(mode === "new_portrait_project" ? { newProject: workflowIdentityV1() } : {}) });
  const request = autoReframeJobRequestV1(p, job), target = autoReframeTargetV1(p, request).project;
  const sink = createAutoReframeSparseV2(target, { clipId: "selected", outputWidth: 90, outputHeight: 160, expectedSourceSha256: request.expectedSourceSha256 }); sink.initialize(64, 40);
  for (let frame = 0; frame < 5; frame++) sink.consume({ frame, time: frame / 4, sceneCut: frame === 0 || frame === 3, pixelSha256: "c".repeat(64),
    ...(!unknown ? { subject: { rect: { x: frame < 3 ? .25 : .6, y: .4, width: .1, height: .2 }, confidence: 1, origin: "saliency" as const } } : {}) });
  return { p, job, request, target, reply: instrumentOnlyWorkflowReplyV1(request, sink.finish()) };
}
describe("bounded, project/source-bound auto-reframe edit plan", () => {
  it.each(["current_portrait", "new_portrait_project"] as const)("supports %s with one reversible existing camera batch", async mode => {
    const f = await fixture(mode), before = canonicalJson(f.p), plan = admitAutoReframePlanV1(f.p, f.job, f.reply), a = takeAutoReframeApplicationV1(f.p, plan);
    expect(a.kind).toBe(mode === "current_portrait" ? "command" : "new_project");
    const base = a.kind === "new_project" ? a.baseProject : f.p, h = dispatchCommand(createHistory(base), a.command);
    expect(h.past).toHaveLength(1); expect(undo(h).present).toEqual(base); expect(redo(undo(h)).present.tracks).toEqual(h.present.tracks);
    expect(h.present.tracks[0].clips[0].keyframes.length).toBeGreaterThan(1); expect(h.present.tracks[0].clips[0].volume).toBe(.7);
    expect(canonicalJson(f.p)).toBe(before); expect(plan.preview.points.some(p => p.jump)).toBe(true); settleAutoReframeApplicationV1(plan);
    expect(() => takeAutoReframeApplicationV1(f.p, plan)).toThrow("USED_OR_FOREIGN");
  });
  it("matches Node canonical SHA exactly and serializes undefined diagnostics normally", async () => {
    const f = await fixture(); expect(await autoReframeProjectDigestV1(f.p)).toBe(createHash("sha256").update(canonicalJson(f.p)).digest("hex"));
    const roundTrip = JSON.parse(JSON.stringify(f.reply)); expect(() => admitAutoReframePlanV1(f.p, f.job, roundTrip)).not.toThrow();
  });
  it("cannot change the private camera batch by mutating public preview/reply objects", async () => {
    const f = await fixture(), plan = admitAutoReframePlanV1(f.p, f.job, f.reply), original = structuredClone(f.reply.prepared.commands);
    plan.preview.points[0].x = 999; plan.preview.sourceWidth = 999;
    if (f.reply.prepared.commands[0].type === "add_keyframe") f.reply.prepared.commands[0].keyframe.transform.x = 999;
    expect(takeAutoReframeApplicationV1(f.p, plan).command).toEqual({ type: "batch", commands: original });
  });
  it("does not mint two independent apply capabilities from the same analysis job", async () => {
    const f = await fixture("new_portrait_project"); admitAutoReframePlanV1(f.p, f.job, f.reply);
    expect(() => admitAutoReframePlanV1(f.p, f.job, f.reply)).toThrow("ALREADY_ADMITTED");
  });
  it("keeps zero valid subjects unknown instead of inventing 100% coverage", async () => {
    const f = await fixture("current_portrait", true), plan = admitAutoReframePlanV1(f.p, f.job, f.reply);
    expect(plan.preview).toMatchObject({ validSubjects: 0, unknownFrames: 5, central60Ratio: null });
    const bad = structuredClone(f.reply); bad.prepared.metrics.measuredCentral60Ratio = 1; expect(() => admitAutoReframePlanV1(f.p, f.job, bad)).toThrow("METRICS");
  });
  it("refuses stale, foreign, cancelled and reused capabilities before any write", async () => {
    const f = await fixture(), clone = { ...f.job };
    expect(() => admitAutoReframePlanV1(f.p, clone, f.reply)).toThrow("FOREIGN");
    expect(() => takeAutoReframeApplicationV1(f.p, { schema: "editkin.auto-reframe-plan/v1" } as never)).toThrow("FOREIGN");
    const plan = admitAutoReframePlanV1(f.p, f.job, f.reply); takeAutoReframeApplicationV1(f.p, plan); expect(() => takeAutoReframeApplicationV1(f.p, plan)).toThrow("USED");
    settleAutoReframeApplicationV1(plan, true); expect(takeAutoReframeApplicationV1(f.p, plan).kind).toBe("command"); settleAutoReframeApplicationV1(plan);
    f.p.captions[0].text = "new source edit"; expect(() => admitAutoReframePlanV1(f.p, f.job, f.reply)).toThrow("STALE");
    const c = new AbortController(); c.abort(Error("explicit-stop")); await expect(beginAutoReframeEditV1(f.p, "selected", { operationId: "x", mode: "current_portrait", outputWidth: 90, outputHeight: 160, subject: { kind: "saliency" } }, c.signal)).rejects.toThrow("explicit-stop");
  });
  const mutations: Record<string, (r: AutoReframeReplyV1) => void> = {
    "request revision": r => { r.request.sourceRevision++; }, "target digest": r => { r.prepared.projectSha256 = "0".repeat(64); },
    "source digest": r => { r.prepared.sourceSha256 = "0".repeat(64); }, "source URI": r => { r.prepared.source.uri = "proxy.mp4"; },
    "source window": r => { r.prepared.source.sourceStart += .25; }, "source geometry": r => { r.prepared.source.width = 65; },
    "quality promotion": r => { r.prepared.subjectQualityCertified = true as never; }, "mutation claim": r => { r.prepared.mutationPerformed = true as never; },
    "full observation allocation": r => { r.prepared.observations = Array(9).fill(r.prepared.observations[0]); },
    "full camera allocation": r => { r.prepared.frames = Array(9).fill(r.prepared.frames[0]); },
    "command allocation": r => { r.prepared.commands = Array(4097).fill(r.prepared.commands[0]); },
    "diagnostic NaN": r => { r.prepared.compression.maximumDiagnosticRows = NaN; },
    "metric arithmetic": r => { r.prepared.metrics.unknownFrames++; }, "metric ratio": r => { r.prepared.metrics.measuredCentral60Ratio = -.1; },
    "invented certification": r => { r.prepared.metrics.actualCompressedHumanCoverageCertified = true as never; },
    "model download": r => { r.prepared.analysis.modelsDownloaded = 1; }, "raw movie file": r => { r.prepared.analysis.rawMoviePixelFiles = 1; },
    "implicit matte": r => { r.prepared.analysis.matte = { subjectConfirmationSha256: "b".repeat(64) } as never; },
    "observation SHA": r => { r.prepared.observationSha256 = "wrong"; }, "diagnostic PTS": r => { r.prepared.observations[0].time = 99; },
    "diagnostic frame order": r => { r.prepared.frames[0].frame = 3; }, "diagnostic rectangle": r => { r.prepared.observations[0].subject!.rect.width = 2; },
    "scene cut disagreement": r => { r.prepared.frames[3].sceneCut = false; }, "camera range": r => { r.prepared.camera.maximumPanSpeed = 3; },
    "resize command": r => { r.prepared.commands[0] = { type: "set_project_resolution", width: 1920, height: 1080 }; },
    "volume command": r => { r.prepared.commands[0] = { type: "set_clip_volume", clipId: "selected", volume: 0 } as never; },
    "foreign clip": r => { if (r.prepared.commands[0].type === "add_keyframe") r.prepared.commands[0].clipId = "outside"; },
    "hidden command field": r => { Object.assign(r.prepared.commands[0], { unexpected: true }); },
    "null keyframe": r => { if (r.prepared.commands[0].type === "add_keyframe") r.prepared.commands[0].keyframe = null as never; },
    "hidden keyframe field": r => { if (r.prepared.commands[0].type === "add_keyframe") Object.assign(r.prepared.commands[0].keyframe, { unexpected: true }); },
    "wrong keyframe ID": r => { if (r.prepared.commands[0].type === "add_keyframe") r.prepared.commands[0].keyframe.id = "authored"; },
    "colour edit": r => { if (r.prepared.commands[0].type === "add_keyframe") r.prepared.commands[0].keyframe.color.exposure = 1; },
    "opacity edit": r => { if (r.prepared.commands[0].type === "add_keyframe") r.prepared.commands[0].keyframe.transform.opacity = .1; },
    "scale edit": r => { if (r.prepared.commands[0].type === "add_keyframe") r.prepared.commands[0].keyframe.transform.scale = 1; },
    "out of crop": r => { if (r.prepared.commands[0].type === "add_keyframe") r.prepared.commands[0].keyframe.transform.x = 10000; },
    "subframe clock": r => { if (r.prepared.commands[0].type === "add_keyframe") r.prepared.commands[0].keyframe.time = .01; },
    "missing endpoint": r => { r.prepared.commands.pop(); r.prepared.compression.outputKeyframes--; },
  };
  it.each(Object.entries(mutations))("rejects %s packet tampering", async (_name, mutate) => {
    const f = await fixture(), before = canonicalJson(f.p); mutate(f.reply); expect(() => admitAutoReframePlanV1(f.p, f.job, f.reply)).toThrow(); expect(canonicalJson(f.p)).toBe(before);
  });
  it("strict request parsing rejects client source paths, force, wrong identity mode and nonportrait sizes", async () => {
    const f = await fixture();
    for (const fields of [{ sourcePath: "elsewhere" }, { force: true }, { newProject: workflowIdentityV1() }, { outputWidth: 160 }])
      expect(() => autoReframeRequestSchemaV1.parse({ ...f.request, ...fields })).toThrow();
  });
});
