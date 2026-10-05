import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject } from "../domain/types";
import { floatingVideoFramePresetV2 } from "../motion/floatingVideoFrame";
import { probeMedia, runProcess } from "./ffmpegMedia";
import { renderComposite } from "./ffmpegComposite";
import { buildRenderPlan } from "./planner";

// The real planner and compositor run; only external probe/process I/O is
// replaced. Literal filter ordering proves wiring, not decoded pixel parity.
vi.mock("./ffmpegMedia", async importOriginal => {
  const actual = await importOriginal<typeof import("./ffmpegMedia")>();
  return { ...actual, probeMedia: vi.fn(), runProcess: vi.fn() };
});

let args: string[];
let graph: string;
beforeEach(() => {
  args = []; graph = "";
  vi.mocked(probeMedia).mockReset(); vi.mocked(runProcess).mockReset();
  vi.mocked(probeMedia).mockResolvedValue({ duration: 5, width: 640, height: 360, encodedWidth: 640, encodedHeight: 360,
    sampleAspectRatio: 1, displayAspectRatio: 16 / 9, hasVideo: true, hasAudio: false,
    colorPrimaries: "bt709", colorTransfer: "bt709", colorMatrix: "bt709", colorRange: "tv" });
  vi.mocked(runProcess).mockImplementation(async (_executable, captured) => {
    args = [...captured]; const inline = args.indexOf("-filter_complex"), script = args.indexOf("-filter_complex_script");
    graph = inline >= 0 ? args[inline + 1] : await readFile(args[script + 1], "utf8");
    return { stdout: "", stderr: "" };
  });
});

function fixture(): EditProject {
  const project = createEmptyProject("Actual source-aware filter consumer", { width: 360, height: 640, fps: 30 });
  project.assets.push({ id: "owned", name: "Owned landscape", uri: "owned-source.mkv", kind: "video", duration: 5,
    width: 640, height: 360, displayAspectRatio: 16 / 9, color: { interpretation: "rec709" } });
  project.tracks[0].clips.push({ id: "clip", trackId: "video-main", assetId: "owned", timelineStart: .5, sourceStart: .4,
    duration: 2, volume: 0, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [],
    floatingFrame: floatingVideoFramePresetV2("matte") });
  return project;
}

async function construct(project: EditProject) {
  await renderComposite("owned-ffmpeg", "owned-ffprobe", join(tmpdir(), `floating-v2-${randomUUID()}.mp4`),
    project, buildRenderPlan(project, uri => uri), undefined, "libx264", 30000);
}

function chain(): string {
  const label = "[vclip0]";
  const start = graph.indexOf("[2:v]"), end = graph.indexOf(label, start);
  expect(start).toBeGreaterThanOrEqual(0); expect(end).toBeGreaterThan(start);
  return graph.slice(start, end + label.length);
}

describe("actual compositor v2 source geometry and local phase wiring", () => {
  it("fits the true landscape source without crop and applies phases only after project-fps local rebasing", async () => {
    const project = fixture(), before = structuredClone(project); await construct(project);
    const value = chain(), localClock = value.indexOf("fps=30/1,trim=end_frame=60,settb=expr=1/30,setpts=PTS-STARTPTS+0");
    expect(localClock).toBeGreaterThanOrEqual(0);
    expect(value.indexOf("scale=", localClock)).toBeGreaterThan(localClock);
    expect(value).not.toContain("crop="); expect(value).not.toContain("force_original_aspect_ratio=increase");
    expect(value).not.toContain("pad=360:640:(ow-iw)/2:(oh-ih)/2");
    expect(value).toContain("if(between(N,0,59)"); expect(value).toContain("59-on");
    expect(value).toContain("sense=destination:interpolation=cubic:eval=frame");
    expect(value).toContain("setpts=PTS-STARTPTS+15[vclip0]");
    expect(args).toEqual(expect.arrayContaining(["-ss", "0.4", "-i", "owned-source.mkv"]));
    expect(project).toEqual(before);
  });

  it("consumes actual non-square SAR DAR instead of using encoded raster ratio", async () => {
    const project = fixture(); project.assets[0].width = 720; project.assets[0].height = 576; project.assets[0].displayAspectRatio = 5 / 3;
    vi.mocked(probeMedia).mockResolvedValue({ duration: 5, width: 720, height: 576, encodedWidth: 720, encodedHeight: 576,
      sampleAspectRatio: 4 / 3, displayAspectRatio: 5 / 3, hasVideo: true, hasAudio: false });
    await construct(project);
    expect(chain()).toContain("scale=190:106:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos:reset_sar=1");
    expect(chain()).toContain("pad=208:124:9:9");
    expect(chain()).not.toContain("crop=");
  });

  it("checks persisted upright geometry against a rotated encoded source before generating filters", async () => {
    const project = fixture(); project.assets[0].width = 360; project.assets[0].height = 640; project.assets[0].displayAspectRatio = 9 / 16;
    vi.mocked(probeMedia).mockResolvedValue({ duration: 5, width: 640, height: 360, encodedWidth: 640, encodedHeight: 360,
      displayRotationDegrees: -90, sampleAspectRatio: 1, displayAspectRatio: 9 / 16, hasVideo: true, hasAudio: false });
    await construct(project);
    expect(chain()).toContain("scale=190:352:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos:reset_sar=1");
    expect(chain()).toContain("pad=208:370:9:9");
    expect(vi.mocked(runProcess)).toHaveBeenCalledTimes(1);
  });

  it("rejects changed physical display ratio before any encoder call", async () => {
    vi.mocked(probeMedia).mockResolvedValue({ duration: 5, width: 640, height: 360, encodedWidth: 640, encodedHeight: 360,
      sampleAspectRatio: 4 / 3, displayAspectRatio: 64 / 27, hasVideo: true, hasAudio: false });
    await expect(construct(fixture())).rejects.toThrow(/展示比例.*矛盾/);
    expect(vi.mocked(runProcess)).not.toHaveBeenCalled();
  });

  it("rejects encoded dimensions that no longer match the saved upright source", async () => {
    vi.mocked(probeMedia).mockResolvedValue({ duration: 5, width: 1280, height: 720, sampleAspectRatio: 1,
      displayAspectRatio: 16 / 9, hasVideo: true, hasAudio: false });
    await expect(construct(fixture())).rejects.toThrow(/展示尺寸.*矛盾/);
    expect(vi.mocked(runProcess)).not.toHaveBeenCalled();
  });

  it("rejects unknown SAR when explicit saved DAR needs physical re-verification", async () => {
    vi.mocked(probeMedia).mockResolvedValue({ duration: 5, width: 640, height: 360, hasVideo: true, hasAudio: false });
    await expect(construct(fixture())).rejects.toThrow(/未提供已知 SAR/);
    expect(vi.mocked(runProcess)).not.toHaveBeenCalled();
  });

  it("admits a legacy square-pixel source only while any known actual DAR remains consistent", async () => {
    const project = fixture(); delete project.assets[0].displayAspectRatio;
    await construct(project); expect(chain()).not.toContain("crop=");
    vi.mocked(runProcess).mockClear();
    vi.mocked(probeMedia).mockResolvedValue({ duration: 5, width: 640, height: 360, sampleAspectRatio: 4 / 3,
      displayAspectRatio: 64 / 27, hasVideo: true, hasAudio: false });
    await expect(construct(project)).rejects.toThrow(/展示比例.*矛盾/);
    expect(vi.mocked(runProcess)).not.toHaveBeenCalled();
  });
});
