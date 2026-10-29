import { beforeEach, describe, expect, it, vi } from "vitest";
import fixture from "./__fixtures__/timeRemapCacheReceiptV1.fixture.json";
import { createDemoProject } from "../domain/demo";
import { createClipMask } from "../domain/masks";
import { canonicalJson } from "../shared/canonicalJson";
import { buildRenderPlan } from "./planner";
import { timeRemapCacheDigestV1, timeRemapCacheKeyV1, parseTimeRemapCacheReceiptV1, TIME_REMAP_CACHE_POLICY_V1 } from "./timeRemapCacheContractV1";
const control = vi.hoisted(() => ({ get: vi.fn(), leases: [] as Array<() => Promise<void>>, audio: false }));
vi.mock("./timeRemapCacheServiceV1", () => ({ getTimeRemapRenderCacheV1: control.get }));
import { materializeTimeRemapClipsV1, selectTimeRemapPreviewSourceV1 } from "./materializeTimeRemapClipsV1";
const runtime = { policy: TIME_REMAP_CACHE_POLICY_V1, ffmpegPath: "D:/host/ffmpeg.exe", ffprobePath: "D:/host/ffprobe.exe", helperTemporaryRoot: "D:/host/owned-temp" };
function project() {
  const p = createDemoProject(); p.width = 64; p.height = 40; p.fps = 8; p.assets[0].width = 64; p.assets[0].height = 40; p.assets[0].duration = 4;
  const c = p.tracks[0].clips[0]; c.duration = 2; c.sourceStart = .25; c.speed = 1; c.volume = .7;
  c.transform.x = 18; c.color.saturation = 1.2; c.gradeV2 = { schema: "editkin.color-grade/v2", nodes: [{ id: "grade", saturation: .9 }] };
  c.masks = [createClipMask("mask", "rectangle")];
  c.keyframes = [{ id: "pose", time: 1, easing: "linear", transform: { ...c.transform, x: 40 }, color: { ...c.color, saturation: 1.1 } }];
  p.assets[0].derivatives = { sourceSha256: "1".repeat(64), proxyUri: "D:/host/preview-proxy.mp4", generatedAt: "2026-10-17T00:00:00.000Z" };
  return p;
}
beforeEach(() => {
  vi.clearAllMocks(); control.leases = []; control.audio = false;
  control.get.mockImplementation(async input => {
    const p = input.project, c = p.tracks.flatMap((t: any) => t.clips).find((v: any) => v.id === input.clipId), a = p.assets.find((v: any) => v.id === c.assetId);
    const r: any = structuredClone(fixture);
    Object.assign(r.keyInputs, { sourceSha256: input.expectedSourceSha256, sourceStart: c.sourceStart, duration: c.duration, speed: c.speed ?? null, timeRemap: c.timeRemap ?? null,
      width: a.width, height: a.height, fps: { numerator: p.fps, denominator: 1 }, audio: control.audio ? "shared-phase-pcm" : "absent" });
    Object.assign(r, { width: a.width, height: a.height, fps: p.fps, duration: c.duration, frames: Math.round(c.duration * p.fps), audio: control.audio ? "shared_phase_constant_pcm_f32_candidate" : "absent" });
    r.producer.originalAudio = r.audio; r.pixels.frames = r.frames; r.pixels.bytes = r.frames * r.width * r.height * 4;
    r.key = timeRemapCacheKeyV1(r.keyInputs); const { digest: _old, ...body } = r; r.digest = timeRemapCacheDigestV1(body);
    const receipt = parseTimeRemapCacheReceiptV1(r), release = vi.fn(async () => {}); control.leases.push(release);
    return { state: "ready", root: "D:/owned-cache", cacheHit: true, mediaPath: `D:/owned-cache/${r.key}/clip.mkv`, receipt, release };
  });
});
describe("source-clock cache substitution into a render clone", () => {
  it("retains authored effects and original sources, removes only the clone clock, and builds an ordinary plan", async () => {
    const p = project(), original = structuredClone(p), c = p.tracks[0].clips[0];
    const out = await materializeTimeRemapClipsV1(p, { projectRoot: "D:/project", sourceSha256ByAssetId: { [p.assets[0].id]: "1".repeat(64) } }, runtime);
    expect(p).toEqual(original); const rendered = out.project.tracks[0].clips[0];
    expect(rendered).toMatchObject({ sourceStart: 0, duration: c.duration, timelineStart: c.timelineStart, volume: 0, transform: c.transform, color: c.color, gradeV2: c.gradeV2, masks: c.masks, keyframes: c.keyframes });
    expect(rendered.speed).toBeUndefined(); expect(rendered.timeRemap).toBeUndefined();
    const asset = out.project.assets.find(a => a.id === rendered.assetId)!; expect(asset.uri).toContain("owned-cache"); expect(asset.derivatives).toBeUndefined();
    expect(out.project.assets[0]).toEqual(original.assets[0]);
    const plan = buildRenderPlan(out.project, uri => uri); expect(plan.audioClips).toHaveLength(0); expect(plan.duration).toBe(c.duration);
    await out.release(); await out.release(); expect(control.leases[0]).toHaveBeenCalledTimes(1);
  });
  it("preserves user volume when the cached source contains shared-phase PCM", async () => {
    control.audio = true; const p = project();
    const out = await materializeTimeRemapClipsV1(p, { projectRoot: "D:/project", sourceSha256ByAssetId: { [p.assets[0].id]: "1".repeat(64) } }, runtime);
    expect(out.project.tracks[0].clips[0].volume).toBe(.7); expect(buildRenderPlan(out.project, x => x).audioClips).toHaveLength(1); await out.release();
  });
  it("does not merge source-specific rights when identical pixels have different source asset records", async () => {
    const p = project(), a = p.assets[0]; a.license = "creator-owned"; a.rightsBasis = "creator_owned";
    const other = { ...structuredClone(a), id: "other", license: "different source licence", rightsBasis: "permission" }; p.assets.push(other);
    const second = structuredClone(p.tracks[0].clips[0]); second.id = "second"; second.assetId = other.id; second.timelineStart = 2;
    second.masks?.forEach(m => { m.id = `${m.id}-second`; }); second.keyframes.forEach(k => { k.id = `${k.id}-second`; }); p.tracks[0].clips.push(second);
    const out = await materializeTimeRemapClipsV1(p, { projectRoot: "D:/project", sourceSha256ByAssetId: { [a.id]: "1".repeat(64), other: "1".repeat(64) } }, runtime);
    const [c1, c2] = out.project.tracks[0].clips;
    expect(c1.assetId).not.toBe(c2.assetId); expect(out.project.assets.find(v => v.id === c1.assetId)?.license).toBe(a.license);
    expect(out.project.assets.find(v => v.id === c2.assetId)?.license).toBe(other.license); await out.release();
  });
  it("rejects missing source identities before starting any producer", async () => {
    await expect(materializeTimeRemapClipsV1(project(), { projectRoot: "D:/project", sourceSha256ByAssetId: {} }, runtime)).rejects.toThrow("SOURCE_AND_SHA"); expect(control.get).not.toHaveBeenCalled();
  });
  it("rejects nested clocks rather than allowing their old1x preview", async () => {
    const p = project(); p.compositions.push({ tracks: [structuredClone(p.tracks[0])] } as (typeof p.compositions)[number]);
    await expect(materializeTimeRemapClipsV1(p, { projectRoot: "D:/project", sourceSha256ByAssetId: { [p.assets[0].id]: "1".repeat(64) } }, runtime)).rejects.toThrow("NESTED_CLOCK"); expect(control.get).not.toHaveBeenCalled();
  });
  it("releases a returned cache lease when the project changed during async work", async () => {
    const p = project(), getter = control.get.getMockImplementation()!;
    control.get.mockImplementation(async input => { const result = await getter(input); p.name = "changed"; return result; });
    await expect(materializeTimeRemapClipsV1(p, { projectRoot: "D:/project", sourceSha256ByAssetId: { [p.assets[0].id]: "1".repeat(64) } }, runtime)).rejects.toThrow("PROJECT_CHANGED"); expect(control.leases[0]).toHaveBeenCalledTimes(1);
  });
  it("refuses a valid but wrong-window receipt and releases it", async () => {
    const p = project(), getter = control.get.getMockImplementation()!;
    control.get.mockImplementation(input => getter({ ...input, project: { ...input.project, tracks: input.project.tracks.map((t: any) => ({ ...t, clips: t.clips.map((c: any) => ({ ...c, sourceStart: .5 })) })) } }));
    await expect(materializeTimeRemapClipsV1(p, { projectRoot: "D:/project", sourceSha256ByAssetId: { [p.assets[0].id]: "1".repeat(64) } }, runtime)).rejects.toThrow("WRONG_CLIP_CLOCK"); expect(control.leases[0]).toHaveBeenCalledTimes(1);
  });
  it("never substitutes the original URI while preview is pending or failed", () => {
    expect(selectTimeRemapPreviewSourceV1({ status: "pending" })).toMatchObject({ status: "pending", uri: undefined });
    expect(selectTimeRemapPreviewSourceV1({ status: "failed", reason: "refused" })).toEqual({ status: "failed", reason: "refused", uri: undefined });
  });
});
