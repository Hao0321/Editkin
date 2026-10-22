import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import { probeMedia, runProcess } from "./ffmpegMedia";
import { renderComposite } from "./ffmpegComposite";
import { buildRenderPlan } from "./planner";

vi.mock("./ffmpegMedia", async original => ({ ...await original<typeof import("./ffmpegMedia")>(), probeMedia: vi.fn(), runProcess: vi.fn() }));
let graph = "", args: string[] = [];
beforeEach(() => {
  graph = ""; args = []; vi.mocked(probeMedia).mockReset(); vi.mocked(runProcess).mockReset();
  vi.mocked(probeMedia).mockResolvedValue({ duration: 5, width: 640, height: 360, encodedWidth: 640, encodedHeight: 360,
    sampleAspectRatio: 4 / 3, hasVideo: true, hasAudio: false });
  vi.mocked(runProcess).mockImplementation(async (_exe, argv) => {
    args = [...argv]; const inline = args.indexOf("-filter_complex"), script = args.indexOf("-filter_complex_script");
    graph = inline >= 0 ? args[inline + 1] : await readFile(args[script + 1], "utf8");
    return { stdout: "", stderr: "" };
  });
});
function fixture() {
  const project = createEmptyProject("Physical ordinary source", { width: 360, height: 640, fps: 30 });
  project.assets.push({ id: "own", name: "Owned", uri: "owned-source.mkv", kind: "video", duration: 5,
    width: 640, height: 360, displayAspectRatio: 64 / 27, color: { interpretation: "rec709" } });
  project.tracks[0].clips.push({ id: "clip", trackId: project.tracks[0].id, assetId: "own", timelineStart: 0, sourceStart: .4,
    duration: 2, volume: 0, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] });
  return project;
}
async function compile(project: ReturnType<typeof fixture>) {
  return renderComposite("owned-ffmpeg", "owned-ffprobe", join(tmpdir(), `ordinary-dar-${randomUUID()}.mp4`),
    project, buildRenderPlan(project, uri => uri), undefined, "libx264", 30000);
}
describe("real ordinary compositor physical canvas wiring", () => {
  it("checks current physical probe and converts actual SAR before canvas padding without changing source time", async () => {
    const project = fixture(), before = structuredClone(project); await compile(project);
    const physical = graph.indexOf("scale=360:640:force_original_aspect_ratio=decrease:force_divisible_by=2:reset_sar=1");
    expect(physical).toBeGreaterThanOrEqual(0);
    expect(graph.indexOf("pad=360:640", physical)).toBeGreaterThan(physical);
    expect(args).toEqual(expect.arrayContaining(["-ss", "0.4", "-i", "owned-source.mkv"]));
    expect(project).toEqual(before);
  });
  it("rejects a changed current-file DAR before the ordinary encoder is called", async () => {
    vi.mocked(probeMedia).mockResolvedValue({ duration: 5, width: 640, height: 360, sampleAspectRatio: 1, hasVideo: true, hasAudio: false });
    await expect(compile(fixture())).rejects.toThrow(/展示比例.*矛盾/);
    expect(runProcess).not.toHaveBeenCalled();
  });
  it("rejects unknown current SAR for an explicitly saved ordinary display ratio", async () => {
    vi.mocked(probeMedia).mockResolvedValue({ duration: 5, width: 640, height: 360, hasVideo: true, hasAudio: false });
    await expect(compile(fixture())).rejects.toThrow(/SAR/);
    expect(runProcess).not.toHaveBeenCalled();
  });
});
