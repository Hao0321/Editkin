import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoProject } from "../domain/demo";
import { floatingVideoFramePresetV2 } from "../motion/floatingVideoFrame";
import { renderProject } from "./ffmpeg";

const controls = vi.hoisted(() => ({ resident: vi.fn(), encoder: vi.fn(), identity: vi.fn(), probe: vi.fn() }));
vi.mock("./residentSceneLinearVideoProject", async original => ({
  ...await original<typeof import("./residentSceneLinearVideoProject")>(), renderResidentSceneLinearAces2VideoProject: controls.resident,
}));
vi.mock("./ffmpegComposite", async original => ({
  ...await original<typeof import("./ffmpegComposite")>(), chooseEncoder: controls.encoder,
}));
vi.mock("./renderArtifactIdentity", () => ({ collectRenderArtifactIdentity: controls.identity }));
vi.mock("./ffmpegMedia", async original => ({
  ...await original<typeof import("./ffmpegMedia")>(), probeMedia: controls.probe,
}));

// Absolute on every platform; neither path is opened because probe and the resident route are mocked.
const controlSource = resolve("explicit-source-control/landscape.mp4"), controlOutput = resolve("explicit-source-control/not-a-film.mp4");
function fixture() {
  const project = createDemoProject();
  project.width = 360; project.height = 640; project.fps = 30;
  project.captions = []; project.motionGraphics = [];
  project.colorManagement = { ...project.colorManagement!, mode: "aces2", outputTransform: "rec709_sdr" };
  Object.assign(project.assets[0], { uri: controlSource, width: 1280, height: 720,
    displayAspectRatio: 16 / 9, duration: 6, color: { interpretation: "rec709", primaries: "bt709", transfer: "bt709", matrix: "bt709" } });
  const clip = project.tracks[0].clips[0];
  Object.assign(clip, { timelineStart: 0, sourceStart: 0, duration: 1, floatingFrame: floatingVideoFramePresetV2("matte") });
  return project;
}
const options = { fontRoot: resolve("public/fonts"), gpuCompositorPath: "explicit-not-real-control.exe", preferGpu: false };
beforeEach(() => {
  vi.clearAllMocks();
  controls.encoder.mockResolvedValue("libx264");
  controls.identity.mockResolvedValue({ schema: "editkin.render-artifact-identity/v1" });
  controls.probe.mockResolvedValue({ hasVideo: true, hasAudio: false, duration: 6, width: 1280, height: 720,
    encodedWidth: 1280, encodedHeight: 720, sampleAspectRatio: 1, colorPrimaries: "bt709", colorTransfer: "bt709", colorMatrix: "bt709" });
  controls.resident.mockImplementation(async (_project, _graph, outputPath) => ({ outputPath, duration: 1, encoder: "libx264",
    planner: "editkin-resident-video-scene-linear-aces2-formal-sequence/v1", ffmpegVersion: "source-control" }));
});

describe("actual formal floating caller admission (mocked media, not output certification)", () => {
  it("prepares the literal same-project floating descriptor and uses the resident route without mutating the authored project", async () => {
    const project = fixture(), before = JSON.stringify(project);
    await renderProject(project, controlOutput, options);
    expect(controls.probe).toHaveBeenCalledTimes(1);
    expect(controls.resident).toHaveBeenCalledTimes(1);
    const graph = controls.resident.mock.calls[0][1].graph;
    const node = graph.nodes.find((item: { kind: string }) => item.kind === "floating_video_frame_2d");
    expect(node.spec.source).toEqual({ width: 1280, height: 720, displayAspectRatio: 16 / 9 });
    expect(node.spec.timeline).toEqual({ timelineStartFrame: 0, sourceStartFrame: 0, durationFrames: 30 });
    expect(graph.nodes.some((item: { kind: string; processor?: string }) => item.kind === "color"
      && item.processor === "editkin-ocio-aces2-linear-rec709-to-rec709-sdr/v1")).toBe(true);
    expect(JSON.stringify(project)).toBe(before);
  });
  it.each(["rotation180", "unknownSAR", "nonSquareSAR", "codedDrift", "HDR"])("refuses actual %s before encoder and resident execution", async defect => {
    const probe = await controls.probe(); controls.probe.mockClear();
    if (defect === "rotation180") probe.displayRotationDegrees = 180;
    if (defect === "unknownSAR") delete probe.sampleAspectRatio;
    if (defect === "nonSquareSAR") probe.sampleAspectRatio = 2;
    if (defect === "codedDrift") probe.encodedWidth = 1920;
    if (defect === "HDR") probe.colorTransfer = "arib-std-b67";
    controls.probe.mockResolvedValue(probe);
    await expect(renderProject(fixture(), controlOutput, options)).rejects.toThrow();
    expect(controls.encoder).not.toHaveBeenCalled(); expect(controls.resident).not.toHaveBeenCalled();
  });
});
