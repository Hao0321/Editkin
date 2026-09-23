// @vitest-environment node
import {resolve} from "node:path";
import {describe, expect, it, vi} from "vitest";
import {createDemoProject} from "../domain/demo";
import {compileNativeAudioProjectPlan} from "./nativeAudioProjectPlan";

function fixture(count = 12) {
  const project = createDemoProject();
  project.captions = []; project.motionGraphics = [];
  const clip = project.tracks[0].clips[0];
  project.assets = [{...project.assets[0], id: "a", kind: "audio", uri: resolve("one/a.wav"), role: "dialogue"},
    {...project.assets[0], id: "b", kind: "audio", uri: resolve("two/b.wav"), role: "dialogue"}];
  project.tracks = [{...project.tracks[0], id: "t", kind: "audio", muted: false,
    clips: Array.from({length: count}, (_, i) => ({...clip, id: `c${i}`, assetId: i % 2 ? "a" : "b", trackId: "t", timelineStart: i * 3,
      sourceStart: 0.25, duration: 2.5, volume: 1, layer: undefined}))}];
  const resolver = vi.fn(async (asset: typeof project.assets[number]) => ({path: asset.uri, sha256: "a".repeat(64), bytes: 1024, hasAudio: true}));
  return {project, resolver, options: {generation: 1, timelineStartSeconds: 0, resolveSource: resolver, silentMediaRoot: resolve("cache")}};
}
describe("whole-project native compressed audio plan", () => {
  it("keeps more than eight sequential clips, multiple roots and the full duration", async () => {
    const {project, options, resolver} = fixture(40);
    const result = await compileNativeAudioProjectPlan(project, options);
    expect(result.plan.sources).toHaveLength(40);
    expect(result.plan.frameCount).toBe(119.5 * 48000);
    expect(result.plan.mediaRoots).toHaveLength(2);
    expect(result.peakActiveSources).toBe(1);
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(result.plan.graph.nodes.length).toBeLessThan(8);
    expect(result.bindings[39].clipId).toBe("c39");
  });
  it("preserves full-catalog positions when starting in the middle", async () => {
    const {project, options} = fixture();
    const result = await compileNativeAudioProjectPlan(project, {...options, timelineStartSeconds: 32.125});
    expect(result.plan.sources).toHaveLength(12);
    expect(result.plan.startFrame).toBe(1542000);
    expect(result.plan.sources[11].sourceStartFrame).toBe(12000);
    expect(result.plan.frameCount).toBe(Math.round((35.5 - 32.125) * 48000));
  });
  it("keeps silence, mutes and disabled layers explicit", async () => {
    const {project, options} = fixture(4);
    project.tracks[0].clips[0].volume = 0;
    project.tracks[0].clips[1].layer = {enabled: false} as NonNullable<typeof project.tracks[0]["clips"][number]["layer"]>;
    project.assets[0].kind = "image";
    const result = await compileNativeAudioProjectPlan(project, options);
    expect(result.plan.sources).toHaveLength(1);
    expect(result.omitted).toHaveLength(3);
    project.tracks[0].muted = true;
    const silent = await compileNativeAudioProjectPlan(project, options);
    expect(silent.plan.sources).toEqual([]);
    expect(silent.plan.frameCount).toBe(11.5 * 48000);
    expect(silent.plan.mediaRoots).toEqual([resolve("cache")]);
  });
  it("uses the existing music fade and bus/ducking semantics", async () => {
    const {project, options} = fixture(); project.assets[0].role = "background-music";
    const result = await compileNativeAudioProjectPlan(project, options);
    const music = result.plan.sources[1];
    expect(music.bus).toBe("music");
    expect(music.gainAutomation?.points[0]).toEqual({sample: 144000, value: -144, interpolation: "linear"});
    expect(music.gainAutomation!.points.every(p => p.sample >= 144000 && p.sample < 264000)).toBe(true);
    expect(result.plan.graph.nodes.find(n => n.id === "ducked-music")?.operation.kind).toBe("ducker");
  });
  it("distinguishes sixteen overlapping sources from a forty-clip catalog", async () => {
    const {project, options} = fixture(17);
    for (const clip of project.tracks[0].clips) clip.timelineStart = 0;
    await expect(compileNativeAudioProjectPlan(project, options)).rejects.toThrow("同時播放 16");
    project.tracks[0].clips.pop();
    expect((await compileNativeAudioProjectPlan(project, options)).peakActiveSources).toBe(16);
  });
  it("does not silently omit nested audio, unresolved assets or invalid source identities", async () => {
    const {project, options} = fixture(); project.assets[0].compositionId = "nested";
    await expect(compileNativeAudioProjectPlan(project, options)).rejects.toThrow("巢狀合成");
    delete project.assets[0].compositionId;
    await expect(compileNativeAudioProjectPlan(project, {...options, resolveSource: async a => ({path: a.uri, sha256: "bad", bytes: 8, hasAudio: true})})).rejects.toThrow("來源缺少");
    project.tracks[0].clips[0].assetId = "missing";
    await expect(compileNativeAudioProjectPlan(project, options)).rejects.toThrow("找不到素材");
  });
  it("bounds timeline and generation and respects cancellation", async () => {
    const {project, options} = fixture();
    await expect(compileNativeAudioProjectPlan(project, {...options, generation: 0})).rejects.toThrow("generation");
    await expect(compileNativeAudioProjectPlan(project, {...options, timelineStartSeconds: NaN})).rejects.toThrow("起點");
    await expect(compileNativeAudioProjectPlan(project, {...options, signal: AbortSignal.abort()})).rejects.toThrow();
    project.tracks[0].clips[0].duration = 86401;
    await expect(compileNativeAudioProjectPlan(project, options)).rejects.toThrow("24 小時");
  });
});
