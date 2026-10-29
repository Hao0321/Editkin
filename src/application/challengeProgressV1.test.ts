import { describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_TRANSFORM, DEFAULT_COLOR } from "../domain/types";
import { canonicalJson } from "../shared/canonicalJson";
import { motionGraphicV3Frame, motionGraphicV3Layout } from "../motion/compositionV3";
import { createProjectSession } from "./projectSession";
import { prepareChallengeProgressV1 } from "./challengeProgressV1";
import { applyPreparedEditorialDataGraphicsV1 } from "./editorialDataGraphicsV1";
import { undo, redo } from "../domain/history";

function fixture() {
  const p = createEmptyProject("Synthetic progress data", { id: "data-control", fps: 30, width: 640, height: 360 });
  p.assets = [{ id: "source", kind: "video", name: "Synthetic graph; not real footage", uri: "D:/synthetic/data.mov", duration: 30, width: 640, height: 360 }];
  p.tracks[0].clips = [{ id: "primary", assetId: "source", trackId: p.tracks[0].id, timelineStart: 0, sourceStart: 1, duration: 9, volume: 0,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] }]; return p;
}
function request() { return { schema: "editkin.challenge-progress/v1", expectedRevision: 0, idPrefix: "progress", clipId: "primary", presetId: "v3_progress_bar", total: "3", percentDecimals: 2,
  states: ["0", "1", "3"].map((completed, i) => ({ startFrame: i * 90, endFrame: (i + 1) * 90, completed, label: "挑戰進度", evidenceRefs: ["synthetic:state-" + i] })) }; }

describe("challenge data to frozen progress-bar states", () => {
  it("reads final value events from actual compiled frames, applies one Undo and preserves the source clip", async () => {
    const p = fixture(), source = canonicalJson(p), session = createProjectSession(p), plan = await prepareChallengeProgressV1(session, request());
    expect(plan.hooks.map(h => h.text)).toEqual(["0.00%", "33.33%", "100.00%"]);
    expect(plan.hooks.map(h => h.frame)).toEqual([4, 131, 222]); expect(canonicalJson(p)).toBe(source);
    expect(plan.sound).toBeNull(); expect(plan.qualityState).toBe("ART_PENDING_CLAUDE"); expect(plan.defaultEnabled).toBe(false);
    await applyPreparedEditorialDataGraphicsV1(session, plan);
    const h = session.getSnapshot().history; expect(h.past).toHaveLength(1); expect(h.present.tracks).toEqual(p.tracks); expect(h.present.assets).toEqual(p.assets);
    for (const hook of plan.hooks) {
      const g = h.present.motionGraphics.find(g => g.id === hook.graphicId)!, layout = motionGraphicV3Layout(p, g);
      const text = (f: number) => motionGraphicV3Frame(p, g, f, layout).ops.find(o => o.kind === "text" && o.id === "value");
      const final = text(hook.frame); expect(final?.kind === "text" && final.text).toBe(hook.text);
      if (hook.text !== "0.00%") { const before = text(hook.frame - 1); expect(before?.kind === "text" && before.text).not.toBe(hook.text); }
    }
    expect(canonicalJson(undo(h).present)).toBe(source); expect(redo(undo(h)).present).toEqual(h.present);
    await expect(applyPreparedEditorialDataGraphicsV1(session, plan)).rejects.toThrow("PACKET_INVALID");
  });
  it.each(["wrong-preset", "zero-total", "too-many-completed", "decreasing", "overlap", "outside-clip", "short-final", "duplicate-id", "locked", "hidden", "subframe-clip", "revision", "copy-injection", "extra-field", "frame-cap"])("rejects %s with no partial edit", async reason => {
    const p = fixture(), r = request();
    if (reason === "wrong-preset") r.presetId = "v3_stat_counter";
    if (reason === "zero-total") r.total = "0"; if (reason === "too-many-completed") r.states[2].completed = "4";
    if (reason === "decreasing") r.states[2].completed = "0"; if (reason === "overlap") r.states[1].startFrame = 89;
    if (reason === "outside-clip") r.states[2].endFrame = 271;
    if (reason === "short-final") { r.states = [{ ...r.states[2], startFrame: 0, endFrame: 30 }]; }
    if (reason === "duplicate-id") p.motionGraphics = [{ id: "progress-state-1" } as never];
    if (reason === "locked") p.tracks[0].locked = true; if (reason === "hidden") p.tracks[0].hidden = true;
    if (reason === "subframe-clip") p.tracks[0].clips[0].timelineStart = .001; if (reason === "revision") r.expectedRevision = 1;
    if (reason === "copy-injection") r.states[0].label = "{\\pos(1,2)}"; if (reason === "extra-field") Object.assign(r, { defaultEnabled: true });
    const before = canonicalJson(p), session = createProjectSession(p);
    await expect(prepareChallengeProgressV1(session, r, undefined, reason === "frame-cap" ? { maximumCompiledFrames: 269 } : {})).rejects.toThrow();
    expect(canonicalJson(p)).toBe(before); expect(session.getSnapshot().history.past).toHaveLength(0);
  });
  it("retains exact large integer counts and explicit rounding metadata", async () => {
    const r = request(); r.total = "9007199254740994"; r.states = [{ ...r.states[0], completed: "9007199254740993" }];
    const plan = await prepareChallengeProgressV1(createProjectSession(fixture()), r);
    expect(plan.hooks[0].text).toBe("100.00%");
    const d = plan.descriptor as { states: { completed: string }[]; diagnostics: unknown[]; storedWholeFrames: number };
    expect(d.states[0].completed).toBe("9007199254740993"); expect(d.diagnostics).toHaveLength(8); expect(d.storedWholeFrames).toBe(0);
  });
  it("preserves frame coordinates 20 hours into a project without scanning its empty prefix", async () => {
    const p = fixture(), r = request(), offset = 2160000; p.tracks[0].clips[0].timelineStart = offset / p.fps;
    r.states = r.states.map(s => ({ ...s, startFrame: offset + s.startFrame, endFrame: offset + s.endFrame }));
    const plan = await prepareChallengeProgressV1(createProjectSession(p), r); expect(plan.hooks[2].frame).toBe(offset + 222);
    expect((plan.descriptor as { analyzedFrames: number }).analyzedFrames).toBe(270);
  });
  it("yields to event-loop cancellation and rejects an in-place source mutation during progress", async () => {
    const p = fixture(), controller = new AbortController(), reason = Error("progress-stop");
    await expect(prepareChallengeProgressV1(createProjectSession(p), request(), undefined, { signal: controller.signal, onProgress: e => { if (e.completed === 64) setTimeout(() => controller.abort(reason), 0); } })).rejects.toBe(reason);
    const session = createProjectSession(p);
    await expect(prepareChallengeProgressV1(session, request(), undefined, { onProgress: () => { p.tracks[0].clips[0].sourceStart = 2; } })).rejects.toThrow("PROJECT_CHANGED");
    expect(session.getSnapshot().history.past).toHaveLength(0);
  });
});
