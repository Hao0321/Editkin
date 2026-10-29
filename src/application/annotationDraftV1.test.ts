import { describe, expect, it } from "vitest";
import { createHistory, dispatchCommand, undo } from "../domain/history";
import { shapeBounds } from "../motion/vectorGeometry";
import { canonicalJson } from "../shared/canonicalJson";
import { annotationWorkflowFixtureV1 } from "./__fixtures__/annotationWorkflowV1.fixture";
import { admitAnnotationTargetV1, annotationCanvasPointV1, buildAnnotationDraftV1, prepareAnnotationCommandV1, ANNOTATION_STYLE_PROPOSAL_V1, type AnnotationTargetV1 } from "./annotationDraftV1";

const target = (): AnnotationTargetV1 => ({ clipId: "selected", frame: 60, range: { startFrame: 30, endFrame: 90 }, style: { ...ANNOTATION_STYLE_PROPOSAL_V1 }, purpose: "Synthetic authoring control", evidenceRefs: ["synthetic:annotation"] });
describe("canvas drag to existing original stroke command", () => {
  it.each(["arrow", "circle", "underline"] as const)("authors %s in a tight canvas-pixel box through the original geometry owner", kind => {
    const p = annotationWorkflowFixtureV1(), before = canonicalJson(p), t = target(); admitAnnotationTargetV1(p, t);
    const draft = buildAnnotationDraftV1(p, t, kind, { x: 80, y: 60 }, { x: 240, y: 180 }, "annotation", kind);
    const prepared = prepareAnnotationCommandV1(p, t, draft), g = prepared.command.graphic;
    expect(draft.guide.paths.length).toBeGreaterThan(0); expect(draft.guide.source).toContain("authoring_guide");
    expect(g.vectorV2?.schema).toBe("editkin.motion-vector-stroke/v1"); expect(g.timelineStart).toBe(1); expect(g.duration).toBe(2);
    expect(g.x * p.width).toBe(draft.request.box.x); expect(g.y * p.height).toBe(draft.request.box.y);
    expect(draft.request.box.width).toBeLessThan(p.width); expect(draft.request.box.height).toBeLessThan(p.height);
    if (g.vectorV2?.kind !== "stroke") throw Error("Expected original stroke");
    const b = shapeBounds(g.vectorV2.commands); expect(b.x0).toBeGreaterThanOrEqual(2); expect(b.y0).toBeGreaterThanOrEqual(2);
    const h = dispatchCommand(createHistory(p), prepared.command); expect(h.past).toHaveLength(1); expect(undo(h).present).toEqual(p); expect(canonicalJson(p)).toBe(before);
    expect(prepared.defaultEnabled).toBe(false); expect(prepared.qualityState).toBe("ART_PENDING_CLAUDE");
  });
  it.each(["anchor", "surface"] as const)("binds %s to clip-local time, independent of movie source-in", mode => {
    const p = annotationWorkflowFixtureV1(), t = { ...target(), tracking: { trackId: "manual-track", mode } };
    const d = buildAnnotationDraftV1(p, t, "underline", { x: 60, y: 100 }, { x: 250, y: 100 }, "bound", "Bound control"), g = prepareAnnotationCommandV1(p, t, d).command.graphic;
    expect(g.vectorTrackingV1?.referenceTime).toBe(1); expect(p.tracks[0].clips[0].sourceStart).toBe(2);
    expect(g.vectorV2?.schema).toBe("editkin.motion-vector-tracked-stroke/v1");
  });
  it("reversed drag preserves the directed arrow and rectangle-defined ellipse", () => {
    const p = annotationWorkflowFixtureV1(), t = target(), a = { x: 240, y: 180 }, b = { x: 80, y: 60 };
    const arrow = buildAnnotationDraftV1(p, t, "arrow", a, b, "a", "A"), circle = buildAnnotationDraftV1(p, t, "circle", a, b, "c", "C");
    const g = arrow.request.geometry; expect(g.kind).toBe("arrow"); if (g.kind === "arrow") expect(g.start.x).toBeGreaterThan(g.end.x);
    expect(circle.request.geometry).toMatchObject({ kind: "circle", radiusX: 80, radiusY: 60 });
  });
  it.each(["locked", "hidden", "outside", "frame", "budget", "canvas", "track", "disabled-clip"])("refuses %s target without touching history", reason => {
    const p = annotationWorkflowFixtureV1(), t = target();
    if (reason === "locked") p.tracks[0].locked = true; if (reason === "hidden") p.tracks[0].hidden = true;
    if (reason === "outside") t.range.startFrame = 29; if (reason === "frame") t.frame = 90;
    if (reason === "budget") t.range.endFrame = 1831; if (reason === "canvas") p.width = 8192;
    if (reason === "track") t.tracking = { trackId: "absent", mode: "anchor" };
    if (reason === "disabled-clip") p.tracks[0].clips[0].layer = { enabled: false } as never;
    const before = canonicalJson(p); expect(() => admitAnnotationTargetV1(p, t)).toThrow(); expect(canonicalJson(p)).toBe(before);
  });
  it("uses real point units and rejects initial letterbox/outside/nonfinite points without squeezing a shape", () => {
    expect(annotationCanvasPointV1({ x: 160, y: 120 }, 320, 240)).toEqual({ x: 160, y: 120 });
    expect(() => annotationCanvasPointV1({ x: -1, y: 120 }, 320, 240)).toThrow("OUTSIDE");
    expect(annotationCanvasPointV1({ x: -20, y: 300 }, 320, 240, true)).toEqual({ x: 0, y: 240 });
    expect(() => annotationCanvasPointV1({ x: NaN, y: 120 }, 320, 240, true)).toThrow("COORDINATES");
    const p = annotationWorkflowFixtureV1();
    expect(() => buildAnnotationDraftV1(p, target(), "circle", { x: 80, y: 80 }, { x: 200, y: 80 }, "c", "C")).toThrow("DEGENERATE");
    expect(() => buildAnnotationDraftV1(p, target(), "underline", { x: 0, y: 100 }, { x: 200, y: 100 }, "u", "U")).toThrow("INK_OUTSIDE");
  });
  it("keeps unsupported tracked retiming and lost references refused by the original contract", () => {
    const p = annotationWorkflowFixtureV1(), t = { ...target(), tracking: { trackId: "manual-track", mode: "anchor" as const } };
    const d = buildAnnotationDraftV1(p, t, "underline", { x: 60, y: 100 }, { x: 250, y: 100 }, "x", "X");
    p.tracks[0].clips[0].speed = 2; expect(() => prepareAnnotationCommandV1(p, t, d)).toThrow("GEOMETRY_UNSUPPORTED");
    delete p.tracks[0].clips[0].speed; p.motionTracks[0].points[1].status = "lost"; expect(() => prepareAnnotationCommandV1(p, t, d)).toThrow("REFERENCE_LOST");
  });
});
