import { describe, expect, it } from "vitest";
import { pairFixtureV1 } from "../domain/timelineTransitionV1.fixture";
import { buildEngineRenderGraph } from "./engineGraph";
import type { NativeTimelinePairSpecV1 } from "./timelineTransitionNativeV1";

describe("versioned native paired graph source and authored clocks", () => {
  const options = { nativeTimelineTransitionVersion: 1 as const };
  it("retains every nominal source and authored transform while declaring actual handles", () => {
    const { project, transition } = pairFixtureV1(); project.timelineTransitions = [transition];
    const original = structuredClone(project), graph = buildEngineRenderGraph(project, options);
    const node = graph.nodes.find(node => node.kind === "timeline_transition_v1")!;
    const pair = (node.plans as NativeTimelinePairSpecV1[])[0];
    expect(pair).toMatchObject({ id: "cut", startFrame: 48, cutFrame: 60, endFrame: 72,
      from: { sourceStartSeconds: 1, nominal: { timelineStartFrame: 0, sourceStartFrame: 30, durationFrames: 60 } },
      to: { sourceStartSeconds: 4, nominal: { timelineStartFrame: 60, sourceStartFrame: 120, durationFrames: 60 } } });
    expect(graph.nodes.find(node => node.id === pair.to.sourceNodeId)?.timeline).toEqual(pair.to.nominal);
    expect(project).toEqual(original);
  });
  it("keeps the exact previous graph JSON for projects without pairs", () => {
    const { project } = pairFixtureV1();
    expect(JSON.stringify(buildEngineRenderGraph(project, options))).toBe(JSON.stringify(buildEngineRenderGraph(project)));
  });
  it("keeps the explicit unavailable-runtime guard unless the versioned path is requested", () => {
    const { project, transition } = pairFixtureV1(); project.timelineTransitions = [transition];
    expect(() => buildEngineRenderGraph(project)).toThrow("TIMELINE_TRANSITION_NATIVE_SHADER_NOT_CONNECTED");
  });
  it("does not reorder an unsorted track or shift its original keyframes", () => {
    const { project, transition } = pairFixtureV1(); project.timelineTransitions = [transition];
    project.tracks[0].clips.reverse(); const original = structuredClone(project);
    const graph = buildEngineRenderGraph(project, options), node = graph.nodes.find(node => node.kind === "timeline_transition_v1")!;
    const pair = (node.plans as NativeTimelinePairSpecV1[])[0];
    expect(node.inputs.at(-1)).toBe(pair.to.branchNodeId); expect(project).toEqual(original);
    const normal = buildEngineRenderGraph({ ...project, timelineTransitions: undefined });
    expect(graph.nodes.filter(node => node.kind === "transform2d")).toEqual(normal.nodes.filter(node => node.kind === "transform2d"));
  });
  it("retains both non-overlapping cuts at their original incoming stack slots", () => {
    const { project, transition } = pairFixtureV1(); const [a, b] = project.tracks[0].clips;
    const c = { ...structuredClone(b), id: "third", timelineStart: 4, sourceStart: 6 };
    project.tracks[0].clips = [a, c, b];
    project.timelineTransitions = [transition, { ...transition, id: "second-cut", fromClipId: b.id, toClipId: c.id }];
    const graph = buildEngineRenderGraph(project, options), nodes = graph.nodes.filter(node => node.kind === "timeline_transition_v1");
    expect(nodes).toHaveLength(2);
    expect(nodes.flatMap(node => (node.plans as NativeTimelinePairSpecV1[]).map(plan => plan.id)).sort()).toEqual(["cut", "second-cut"]);
    for (const node of nodes) for (const plan of node.plans as NativeTimelinePairSpecV1[]) expect(node.inputs.at(-1)).toBe(plan.to.branchNodeId);
  });
  it("rejects hidden or disabled endpoints before producing a usable graph", () => {
    const { project, transition } = pairFixtureV1(); project.timelineTransitions = [transition]; project.tracks[0].hidden = true;
    expect(() => buildEngineRenderGraph(project, options)).toThrow("TIMELINE_TRANSITION_NATIVE_SOURCE_INVALID");
  });
});
