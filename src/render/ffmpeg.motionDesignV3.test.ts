import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MOTION_DESIGN_V3_PRESETS } from "../creative/motionDesignV3Presets";
import { createDemoProject } from "../domain/demo";
import { DEFAULT_COLOR_MANAGEMENT, type ColorManagementSettings, type MotionGraphic } from "../domain/types";
import { renderProject } from "./ffmpeg";

const controls = vi.hoisted(() => ({ run: vi.fn(), probe: vi.fn(), encoder: vi.fn(), identity: vi.fn() }));
vi.mock("./ffmpegMedia", async original => ({
  ...await original<typeof import("./ffmpegMedia")>(), runProcess: controls.run, probeMedia: controls.probe,
}));
vi.mock("./ffmpegComposite", async original => ({
  ...await original<typeof import("./ffmpegComposite")>(), chooseEncoder: controls.encoder,
}));
vi.mock("./renderArtifactIdentity", () => ({ collectRenderArtifactIdentity: controls.identity }));

// v3 draws display-referred ASS ops: in an ACES 2 Rec.709 SDR project they must be burned after the ACES output
// transform (mocked media; this checks route admission and graph order, not pixels).
function fixture(colorManagement: ColorManagementSettings) {
  const project = createDemoProject();
  project.width = 1080; project.height = 1920; project.fps = 30;
  project.colorManagement = colorManagement;
  project.captions = []; project.motionTracks = [];
  Object.assign(project.assets[0], { uri: "C:/explicit-source-control/hlg.mov", width: 1080, height: 1920, duration: 2,
    color: { interpretation: "hlg", primaries: "bt2020", transfer: "arib-std-b67", matrix: "bt2020nc", range: "tv" } });
  const clip = project.tracks[0].clips[0];
  Object.assign(clip, { timelineStart: 0, sourceStart: 0, duration: 1.2 });
  project.tracks[0].clips = [clip];
  const preset = MOTION_DESIGN_V3_PRESETS.find(item => item.id === "v3_location_pin")!;
  project.motionGraphics = [{ ...preset.seed, id: "v3-location", timelineStart: 0, duration: 1.2 } as MotionGraphic];
  return project;
}

let graph = "";
beforeEach(() => {
  vi.clearAllMocks();
  graph = "";
  controls.encoder.mockResolvedValue("libx264");
  controls.identity.mockResolvedValue({ schema: "editkin.render-artifact-identity/v1" });
  controls.probe.mockResolvedValue({ hasVideo: true, hasAudio: true, duration: 1.2, width: 1080, height: 1920, encodedWidth: 1080, encodedHeight: 1920,
    sampleAspectRatio: 1, colorPrimaries: "bt2020", colorTransfer: "arib-std-b67", colorMatrix: "bt2020nc", colorRange: "tv" });
  controls.run.mockImplementation(async (_executable: string, args: string[]) => {
    const inline = args.indexOf("-filter_complex");
    if (inline >= 0) { graph = args[inline + 1]; await writeFile(args[args.length - 1], ""); }
    return { stdout: "ffmpeg version source-control", stderr: "" };
  });
});

async function render(colorManagement: ColorManagementSettings) {
  const directory = await mkdtemp(join(tmpdir(), "editkin-v3-aces2-"));
  try {
    return await renderProject(fixture(colorManagement), join(directory, "not-a-film.mp4"),
      { fontRoot: resolve("public/fonts"), colorRoot: resolve("public/color/aces2"), preferGpu: false });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("Motion Design v3 formal render admission", () => {
  it("renders v3 in an ACES 2 Rec.709 SDR project and burns it after the ACES output transform", async () => {
    const result = await render({ ...DEFAULT_COLOR_MANAGEMENT, mode: "aces2", outputTransform: "rec709_sdr" });
    expect((result as { planner?: string }).planner).toBe("typescript-motion-design-v3-ass/v3");
    const display = graph.indexOf("[displayout]");
    expect(display).toBeGreaterThan(0);
    expect(graph.indexOf("subtitles=", display)).toBeGreaterThan(display);
    expect(graph.slice(0, display)).not.toContain("subtitles=");
  });

  it("refuses v3 for HDR output, which burns no ASS", async () => {
    await expect(render({ ...DEFAULT_COLOR_MANAGEMENT, mode: "aces2", outputTransform: "rec2100_pq_1000" })).rejects.toThrow(/motion-composition\/v3/u);
  });
});
