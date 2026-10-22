import { describe, expect, it } from "vitest";
import { dispatchCommandSafely, undo, redo } from "../domain/history";
import { canonicalJson } from "../shared/canonicalJson";
import { annotationWorkflowFixtureV1 } from "./__fixtures__/annotationWorkflowV1.fixture";
import { ANNOTATION_STYLE_PROPOSAL_V1 } from "./annotationDraftV1";
import { createProjectSession } from "./projectSession";
import { createAnnotationInteractionV1, type AnnotationApplicationV1, type AnnotationContextV1 } from "./annotationInteractionV1";

function fixture() {
  const project = annotationWorkflowFixtureV1(), session = createProjectSession(project), owner = {}, records: AnnotationApplicationV1[] = [];
  const context: AnnotationContextV1 = { project, projectSession: session, hostReady: true, commandOwner: owner,
    target: { clipId: "selected", frame: 60, range: { startFrame: 30, endFrame: 90 }, style: { ...ANNOTATION_STYLE_PROPOSAL_V1 }, purpose: "Synthetic interaction", evidenceRefs: ["synthetic:interaction"] } };
  const apply = (a: AnnotationApplicationV1) => { records.push(a); if (!a.guard.isCurrent()) return { status: "cancelled" as const };
    const result = dispatchCommandSafely(session.getSnapshot().history, a.command); if (result.error) throw Error(result.error); session.setHistory(result.state); return { status: "applied" as const }; };
  let pauses = 0;
  const options = { read: () => context, apply, makeId: () => "annotation", name: () => "Synthetic annotation", onPause: () => { pauses++; } };
  return { project, session, records, context, options, pauses: () => pauses };
}
function draw(driver: ReturnType<typeof createAnnotationInteractionV1>) { expect(driver.arm("arrow")).toBe(true); expect(driver.begin({ x: 80, y: 80 }, 1)).toBe(true); driver.move({ x: 220, y: 120 }, 1); expect(driver.finish({ x: 240, y: 140 }, 1)).toBe(true); }
describe("source-bound annotation interaction", () => {
  it("draws a private guide, nudges in exact canvas pixels and commits only one existing command", async () => {
    const f = fixture(), before = canonicalJson(f.project), driver = createAnnotationInteractionV1(f.options); draw(driver);
    const d = driver.getState().draft!; expect(driver.nudge(1, 0)).toBe(true); expect(driver.getState().draft!.request.box.x).toBe(d.request.box.x + 1);
    expect(driver.nudge(0, 10)).toBe(true); expect(driver.getState().draft!.request.box.y).toBe(d.request.box.y + 10);
    expect(f.pauses()).toBe(1); expect(f.records).toHaveLength(0); expect(canonicalJson(f.project)).toBe(before);
    expect(await driver.commit()).toBe(true); const h = f.session.getSnapshot().history; expect(h.past).toHaveLength(1); expect(f.records).toHaveLength(1);
    expect(canonicalJson(undo(h).present)).toBe(before); expect(redo(undo(h)).present).toEqual(h.present); expect(driver.getState().status).toBe("done");
    expect(await driver.commit()).toBe(false); expect(f.records).toHaveLength(1);
  });
  it.each(["escape", "pointer-cancel", "wrong-pointer", "outside-start", "nonfinite"])("handles %s without an edit", async mode => {
    const f = fixture(), d = createAnnotationInteractionV1(f.options); d.arm("underline");
    if (mode === "outside-start") expect(d.begin({ x: -10, y: 100 }, 1)).toBe(false);
    else { d.begin({ x: 60, y: 100 }, 1); if (mode === "wrong-pointer") expect(d.finish({ x: 240, y: 100 }, 2)).toBe(false);
      else if (mode === "nonfinite") expect(d.move({ x: NaN, y: 10 }, 1)).toBe(false);
      else { d.finish({ x: 240, y: 100 }, 1); if (mode === "escape") d.cancel(); else { d.begin({ x: 70, y: 120 }, 2); d.cancelPointer(2); } } }
    expect(await d.commit()).toBe(false); expect(f.records).toHaveLength(0); expect(f.session.getSnapshot().history.past).toHaveLength(0);
  });
  it.each(["new-session", "in-place", "selection", "frame", "style", "callback", "disabled", "unmount"])("rejects %s changes before the real command owner", async mode => {
    const f = fixture(), d = createAnnotationInteractionV1(f.options); draw(d);
    if (mode === "new-session") f.session.replaceProject(structuredClone(f.project)); if (mode === "in-place") f.project.name = "Changed";
    if (mode === "selection") f.context.target.clipId = "different"; if (mode === "frame") f.context.target.frame++;
    if (mode === "style") f.context.target.style.widthPixels++; if (mode === "callback") f.context.commandOwner = {};
    if (mode === "disabled") f.context.disabled = true; if (mode === "unmount") d.dispose();
    expect(await d.commit()).toBe(false); expect(f.records).toHaveLength(0); expect(f.session.getSnapshot().history.past).toHaveLength(0);
  });
  it("rejects missing host and locked targets before arming, and preserves a draft when a nudge would move ink outside", () => {
    const f = fixture(), d = createAnnotationInteractionV1(f.options); f.context.hostReady = false; expect(d.arm("arrow")).toBe(false);
    f.context.hostReady = true; f.project.tracks[0].locked = true; expect(d.arm("arrow")).toBe(false); f.project.tracks[0].locked = false;
    draw(d); const before = d.getState().draft; expect(d.nudge(100, 0)).toBe(false); expect(d.getState().draft).toEqual(before);
  });
  it("invalidates an armed draft with a plain stale error and ignores late pointer callbacks", () => {
    const f = fixture(), d = createAnnotationInteractionV1(f.options); draw(d); f.context.target.frame++; d.invalidate();
    expect(d.getState().status).toBe("failed"); expect(String(d.getState().error)).toContain("PROJECT_CHANGED");
    expect(d.move({ x: 150, y: 120 }, 1)).toBe(false); expect(d.getState().status).toBe("failed");
  });
  it("passes the actual live guard across an asynchronous host boundary and refuses duplicate/late writes", async () => {
    const f = fixture(); let release!: () => void, calls = 0;
    const d = createAnnotationInteractionV1({ ...f.options, apply: async a => { calls++; await new Promise<void>(resolve => { release = resolve; }); return f.options.apply(a); } });
    draw(d); const pending = d.commit(); await Promise.resolve(); expect(await d.commit()).toBe(false); f.context.target.frame++; d.invalidate(); release();
    expect(await pending).toBe(false); expect(calls).toBe(1); expect(f.session.getSnapshot().history.past).toHaveLength(0);
  });
  it("never replays an uncertain host failure or a timed-out acknowledgement", async () => {
    const f = fixture(); let calls = 0;
    const d = createAnnotationInteractionV1({ ...f.options, apply: () => { calls++; throw Error("host lost acknowledgement"); } }); draw(d);
    expect(await d.commit()).toBe(false); expect(String(d.getState().error)).toContain("OUTCOME_UNKNOWN"); expect(await d.commit()).toBe(false); expect(calls).toBe(1);
    const timed = createAnnotationInteractionV1({ ...f.options, writeTimeoutMs: 10, apply: () => new Promise(() => {}) }); draw(timed);
    expect(await timed.commit()).toBe(false); expect(String(timed.getState().error)).toContain("OUTCOME_UNKNOWN"); expect(await timed.commit()).toBe(false);
  });
});
