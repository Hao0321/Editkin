import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createDemoProject } from "../domain/demo";
import type { ProofStillV1 } from "../domain/proofStillV1";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject } from "../domain/types";
import { materializeNativeEffectSegments } from "../plugins/nativeEffectMaterialization";
import { buildAces2DisplayVideoRenderRequest } from "./aces2SdrVideo";
import { renderGopSourceCopyProjectV2 } from "./gopSourceCopyExportV2";
import { renderGopSourceCopyProjectV3 } from "./gopSourceCopyExportV3";
import { renderMesh3dVideo } from "./mesh3dRender";
import { renderMuxedPacketCopyProjectV1 } from "./muxedPacketCopyExportV1";
import { buildOpenExrSequenceRenderRequest } from "./openExrSequence";
import { renderPacketCopyProjectV1 } from "./packetCopyExportV1";
import { buildRenderPlan } from "./planner";
import { assertProofStillRouteV1, PROOF_STILL_GUARDED_ROUTES_V1 } from "./proofStillRouteV1";
import { renderResidentSceneLinearAces2VideoProject } from "./residentSceneLinearVideoProject";
import { renderSourcePreservingProjectV1 } from "./sourcePreservingExportV1";
import { renderTimeRemapSourceProjectV1 } from "./timeRemapSourceRenderV1";

const proofStill: ProofStillV1 = { schema: "editkin.proof-still/v1", sourceSha256: "e".repeat(64), sourceWidth: 640, sourceHeight: 360,
  crop: { x: 0, y: 0, width: 640, height: 360 }, redactions: [{ id: "phone", rect: { x: 20, y: 20, width: 120, height: 24 }, fill: "#000000" }],
  hold: "static", confirmation: { by: "user", note: "Phone number row." } };

/** The demo project plus one proof-still clip on its own track. */
function withProofStill(project: EditProject = createDemoProject()): EditProject {
  project.assets.push({ id: "shot", name: "Shot", kind: "image", uri: "C:/fixtures/shot.png", duration: 5, width: 640, height: 360 });
  project.tracks.push({ id: "proof-track", name: "Proof", kind: "video", locked: false, muted: false, clips: [{ id: "proof", assetId: "shot", trackId: "proof-track",
    timelineStart: 0, sourceStart: 0, duration: 2, volume: 0, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [],
    layout: { crop: { x: 0, y: 0, width: 1, height: 1 }, viewport: { x: 0, y: 0, width: 1, height: 1 } }, proofStill: structuredClone(proofStill) }] });
  return project;
}
const refused = (route: string) => new RegExp(`^PROOF_STILL_ROUTE_REFUSED: ${route} `);
const output = (name: string) => join(tmpdir(), `editkin-proof-route-${process.pid}-${name}`);
async function absent(path: string) { await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" }); }

describe("alternative output routes refuse proof stills instead of leaking (design P3)", () => {
  it("the shared guard passes every project without a proof still and refuses one with it, on every route id", () => {
    const plain = createDemoProject(), proof = withProofStill();
    for (const route of PROOF_STILL_GUARDED_ROUTES_V1) {
      expect(() => assertProofStillRouteV1(plain, route)).not.toThrow();
      expect(() => assertProofStillRouteV1(proof, route)).toThrow(refused(route));
    }
    const nested = createDemoProject();
    nested.compositions.push({ schema: "editkin.composition/v1", id: "c", name: "c", width: 640, height: 360, fps: 30, duration: 2,
      tracks: withProofStill(createDemoProject()).tracks, captions: [], captionStyle: nested.captionStyle, motionTracks: [], motionGraphics: [],
      director: nested.director, updatedAt: nested.updatedAt });
    expect(() => assertProofStillRouteV1(nested, "packet-copy-v1")).toThrow(refused("packet-copy-v1"));
  });

  it.each([
    ["packet-copy-v1", (deps: { run: ReturnType<typeof vi.fn>; readPackets: ReturnType<typeof vi.fn> }, out: string) =>
      renderPacketCopyProjectV1(withProofStill(), out, {} as never, deps as never)],
    ["muxed-packet-copy-v1", (deps: { run: ReturnType<typeof vi.fn>; readPackets: ReturnType<typeof vi.fn> }, out: string) =>
      renderMuxedPacketCopyProjectV1(withProofStill(), out, {} as never, deps as never)],
    ["gop-source-copy-v2", (deps: { run: ReturnType<typeof vi.fn>; readPackets: ReturnType<typeof vi.fn> }, out: string) =>
      renderGopSourceCopyProjectV2(withProofStill(), out, {} as never, deps as never)],
    ["gop-source-copy-v3", (deps: { run: ReturnType<typeof vi.fn>; readPackets: ReturnType<typeof vi.fn> }, out: string) =>
      renderGopSourceCopyProjectV3(withProofStill(), out, {} as never, deps as never)],
    ["source-preserving-v1", (deps: { run: ReturnType<typeof vi.fn>; readPackets: ReturnType<typeof vi.fn> }, out: string) =>
      renderSourcePreservingProjectV1(withProofStill(), out, {} as never, { run: deps.run } as never)],
  ])("%s refuses at its entry: no process, no output", async (route, call) => {
    const deps = { run: vi.fn(), readPackets: vi.fn() }, out = output(`${route}.mp4`);
    await expect(call(deps, out)).rejects.toThrow(refused(route));
    expect(deps.run).not.toHaveBeenCalled(); expect(deps.readPackets).not.toHaveBeenCalled();
    await absent(out);
  });

  it("the time-remap source route, the mesh3d pass and the resident scene-linear video route refuse at their entry", async () => {
    const out = output("routes.mp4"), dependencies = { runProcess: vi.fn(), renderAudioBed: vi.fn(), probeMedia: vi.fn(), encoderArgs: vi.fn(), finite: vi.fn() };
    await expect(renderTimeRemapSourceProjectV1(withProofStill(), out, {} as never)).rejects.toThrow(refused("time-remap-source-v1"));
    await expect(renderMesh3dVideo(withProofStill(), out, {})).rejects.toThrow(refused("mesh3d"));
    const project = withProofStill();
    await expect(renderResidentSceneLinearAces2VideoProject(project, {} as never, out, buildRenderPlan(project, uri => uri), { gpuCompositorPath: "owned-gpu" } as never,
      "libx264", 1000, dependencies as never)).rejects.toThrow(refused("resident-scene-linear-video"));
    for (const spy of Object.values(dependencies)) expect(spy).not.toHaveBeenCalled();
    await absent(out);
  });

  it("the OpenEXR sequence request and the scene-linear ACES display request refuse", () => {
    expect(() => buildOpenExrSequenceRenderRequest(withProofStill())).toThrow(refused("openexr-sequence"));
    const project = withProofStill();
    project.colorManagement = { mode: "aces2", workingSpace: "ACEScct", outputTransform: "rec709_sdr", configId: "studio-config-v4.0.0_aces-v2.0_ocio-v2.5" };
    project.assets.push({ id: "plate", name: "Plate", kind: "image", uri: "C:/fixtures/plate.exr", duration: 5, width: 640, height: 360, color: { interpretation: "linear_rec709" } });
    project.tracks[0].clips[0].assetId = "plate";
    expect(() => buildAces2DisplayVideoRenderRequest(project)).toThrow(refused("openexr-sequence"));
  });

  it("native effect materialization refuses only when it would actually run, before reading any source", async () => {
    const project = withProofStill(), runtime = { ffmpegPath: "owned-ffmpeg", nativeCorePath: "owned-core", pluginRoots: [], workspace: output("effects"), timeoutMs: 1000 };
    expect(await materializeNativeEffectSegments(project, buildRenderPlan(project, uri => uri), runtime)).toBeUndefined();
    // A different clip carries the effect; its GPU pass may composite overlays from the raw source.
    project.tracks[0].clips[0].creative = { effectPresetIds: [], nativeEffectInstances: [{ id: "gpu-effect", pluginId: "creator.gpu", capabilityId: "gain",
      pluginVersion: "1.0.0", manifestSha256: "a".repeat(64), runtimeType: "gpu_effect_graph", enabled: true, parameters: { gain: .8 } }] };
    await expect(materializeNativeEffectSegments(project, buildRenderPlan(project, uri => uri), runtime)).rejects.toThrow(refused("native-effect-materialization"));
    await absent(runtime.workspace);
  });

  it("the desktop preview declines to the compatible preview and guards the offscreen PNG route at its call", async () => {
    const source = await readFile(fileURLToPath(new URL("../desktop/useResidentGpuPreview.ts", import.meta.url)), "utf8");
    expect(source).toMatch(/!enabled \? "disabled"\s*\/\/[^\n]*\n\s*: projectContainsProofStillV1\(project\) \? "compatible"/);
    const branch = source.slice(source.indexOf('} else if (next.kind === "engine-video-frame") {'));
    expect(branch.indexOf('assertProofStillRouteV1(project,"offscreen-png-preview");')).toBeGreaterThan(0);
    expect(branch.indexOf('assertProofStillRouteV1(project,"offscreen-png-preview");')).toBeLessThan(branch.indexOf("renderResidentEngineVideoPng("));
  });
});
