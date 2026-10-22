import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { findEffectPreset, findLookPreset, findTransitionPreset } from "../creative/corePack";
import { createDemoProject } from "../domain/demo";
import { renderProject } from "./ffmpeg";

const controls = vi.hoisted(() => ({ run: vi.fn(), probe: vi.fn(), encoder: vi.fn(), identity: vi.fn() }));
vi.mock("./ffmpegMedia", async original => ({
  ...await original<typeof import("./ffmpegMedia")>(), runProcess: controls.run, probeMedia: controls.probe,
}));
vi.mock("./ffmpegComposite", async original => ({
  ...await original<typeof import("./ffmpegComposite")>(), chooseEncoder: controls.encoder,
}));
vi.mock("./renderArtifactIdentity", () => ({ collectRenderArtifactIdentity: controls.identity }));

// A desktop service or MCP child that renders a saved project never mounts the Inspector or the preset browser,
// so the render path itself must register the shipped Studio looks, effects and transitions before it resolves
// the project's clips. Unknown presets throw instead of rendering without them.
const STUDIO_LOOK = "studio_food_amber";

function fixture() {
  const project = createDemoProject();
  project.width = 320; project.height = 180; project.fps = 30;
  project.captions = []; project.motionGraphics = []; project.motionTracks = [];
  Object.assign(project.assets[0], { uri: "C:/explicit-source-control/studio-look.mp4", width: 320, height: 180, duration: 2 });
  const clip = project.tracks[0].clips[0];
  Object.assign(clip, { timelineStart: 0, sourceStart: 0, duration: 1, creative: { lookPresetId: STUDIO_LOOK, effectPresetIds: [] } });
  project.tracks[0].clips = [clip];
  return project;
}

let graph = "";
beforeEach(() => {
  vi.clearAllMocks();
  graph = "";
  controls.encoder.mockResolvedValue("libx264");
  controls.identity.mockResolvedValue({ schema: "editkin.render-artifact-identity/v1" });
  controls.probe.mockResolvedValue({ hasVideo: true, hasAudio: true, duration: 1, width: 320, height: 180,
    encodedWidth: 320, encodedHeight: 180, sampleAspectRatio: 1, colorPrimaries: "bt709", colorTransfer: "bt709", colorMatrix: "bt709", colorRange: "tv" });
  controls.run.mockImplementation(async (_executable: string, args: string[]) => {
    const inline = args.indexOf("-filter_complex");
    if (inline >= 0) graph = args[inline + 1];
    // Stand in for the encoder's output file so the render can promote it; its bytes are not examined.
    if (inline >= 0) await writeFile(args[args.length - 1], "");
    return { stdout: "ffmpeg version source-control", stderr: "" };
  });
});

describe("render-time creative registry (mocked media, not output certification)", () => {
  it("renders a saved Studio look although no UI registered the Studio pack in this process", async () => {
    expect(() => findLookPreset(STUDIO_LOOK)).toThrow(/找不到 look preset/u);
    const directory = await mkdtemp(join(tmpdir(), "editkin-studio-registry-"));
    try {
      await renderProject(fixture(), join(directory, "not-a-film.mp4"), { fontRoot: resolve("public/fonts"), preferGpu: false });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    expect(findLookPreset(STUDIO_LOOK).color.contrast).toBe(1.08);
    // studio_food_amber: brightness +.02, contrast x1.08, saturation x1.12, hue -7 on top of the neutral clip grade.
    expect(graph).toContain("eq=brightness='(0)+(0.02)+(0)':contrast='(1)*(1.08)':saturation='(1)*(1.12)'");
    expect(graph).toContain("hue=h='(0)+(-7)'");
    // The same registration also makes the Studio effects and transitions resolvable for later clips.
    expect(() => findEffectPreset("studio_vignette_soft")).not.toThrow();
    expect(() => findTransitionPreset("studio_action_match")).not.toThrow();
  });
});
