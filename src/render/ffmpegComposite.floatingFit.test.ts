import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject } from "../domain/types";
import { floatingVideoFramePreset } from "../motion/floatingVideoFrame";
import { probeMedia, runProcess } from "./ffmpegMedia";
import { renderComposite } from "./ffmpegComposite";
import { buildRenderPlan } from "./planner";

// Exercise the real planner/compositor construction, replacing only external
// process I/O. These controls do not decode video or assert renderer pixels.
vi.mock("./ffmpegMedia", async importOriginal => {
  const actual = await importOriginal<typeof import("./ffmpegMedia")>();
  return { ...actual, probeMedia: vi.fn(), runProcess: vi.fn() };
});

let capturedArgs: string[];
let capturedGraph: string;

beforeEach(() => {
  vi.mocked(probeMedia).mockReset();
  vi.mocked(runProcess).mockReset();
  capturedArgs = [];
  capturedGraph = "";
  vi.mocked(probeMedia).mockResolvedValue({ duration: 2, width: 1920, height: 1080, hasVideo: true, hasAudio: false,
    colorPrimaries: "bt709", colorTransfer: "bt709", colorMatrix: "bt709", colorRange: "tv" });
  vi.mocked(runProcess).mockImplementation(async (_executable, args) => {
    capturedArgs = [...args];
    const inline = args.indexOf("-filter_complex");
    const script = args.indexOf("-filter_complex_script");
    capturedGraph = inline >= 0 ? args[inline + 1] : await readFile(args[script + 1], "utf8");
    return { stdout: "", stderr: "" };
  });
});

function projectFixture(sourceWidth = 1920, sourceHeight = 1080, width = 1080, height = 1920, floating = true): EditProject {
  const project = createEmptyProject("Owned mixed-aspect command fixture", { id: "fit-project", width, height, fps: 30 });
  project.assets.push({ id: "real-source", name: "Owned diagnostic source", uri: "owned-source.mp4", kind: "video",
    duration: 2, width: sourceWidth, height: sourceHeight, color: { interpretation: "rec709" } });
  project.tracks[0].clips.push({ id: "actual-clip", assetId: "real-source", trackId: project.tracks[0].id,
    timelineStart: .5, sourceStart: .5, duration: 1, volume: 0,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [],
    ...(floating ? { floatingFrame: floatingVideoFramePreset("matte") } : {}),
  });
  return project;
}

async function construct(project: EditProject, preserveAlpha = false): Promise<void> {
  const plan = buildRenderPlan(project, uri => uri);
  await renderComposite("owned-ffmpeg", "owned-ffprobe", join(tmpdir(), `floating-fit-${randomUUID()}${preserveAlpha ? ".mov" : ".mp4"}`),
    project, plan, undefined, preserveAlpha ? "prores_ks" : "libx264", 30000,
    undefined, undefined, undefined, undefined, preserveAlpha);
}

function sourceChain(): string {
  const start = capturedGraph.indexOf("[2:v]");
  const end = capturedGraph.indexOf("[vclip0]", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return capturedGraph.slice(start, end);
}

function expectRawPanelFit(chain: string): void {
  const cover = chain.indexOf("force_original_aspect_ratio=increase");
  const crop = chain.indexOf("crop=");
  expect(cover).toBeGreaterThan(0);
  expect(crop).toBeGreaterThan(cover);
  expect(chain.slice(0, cover)).not.toContain("force_original_aspect_ratio=decrease");
  expect(chain.slice(0, cover)).not.toContain("pad=");
  expect(chain.slice(0, cover)).not.toContain("setsar=");
  expect(chain.slice(cover, crop)).toContain("reset_sar=1");
}

describe("actual compositor raw floating source fit", () => {
  it("fits landscape source directly into a portrait floating panel before canvas padding", async () => {
    const project = projectFixture();
    const before = structuredClone(project);
    await construct(project);
    const chain = sourceChain();
    expectRawPanelFit(chain);
    expect(chain.indexOf("pad=")).toBeGreaterThan(chain.indexOf("crop="));
    expect(chain).toContain("fps=30/1,trim=duration=1");
    expect(chain).toContain("setpts=PTS-STARTPTS+15");
    expect(chain).toContain("perspective=");
    expect(capturedArgs).toEqual(expect.arrayContaining(["-ss", "0.5", "-i", "owned-source.mp4"]));
    expect(project).toEqual(before);
  });

  it("fits portrait source directly into a landscape panel without promoting transparent canvas bars", async () => {
    await construct(projectFixture(1080, 1920, 1920, 1080));
    expectRawPanelFit(sourceChain());
    expect(sourceChain()).not.toContain("pad=1920:1080:(ow-iw)/2:(oh-ih)/2");
    expect(vi.mocked(runProcess)).toHaveBeenCalledTimes(1);
  });

  it("retains source SAR until the proportional panel scale converts to square pixels", async () => {
    // MediaProbe does not expose SAR. The actual decoder's SAR must reach the
    // scale expression unchanged; a physical SAR fixture is a renderer gate.
    await construct(projectFixture(720, 576, 1080, 1920));
    const chain = sourceChain();
    expectRawPanelFit(chain);
    expect(chain.match(/reset_sar=1/g)).toHaveLength(1);
    expect(chain).toMatch(/scale=\d+:\d+:force_original_aspect_ratio=increase:flags=lanczos:reset_sar=1,crop=/);
    expect(chain).not.toContain("setsar=1");
  });

  it("preserves ordinary canvas contain, transparent padding and SAR-reset order", async () => {
    await construct(projectFixture(1920, 1080, 1080, 1920, false));
    const chain = sourceChain();
    expect(chain).toBe("[2:v]scale=1080:1920:force_original_aspect_ratio=decrease,format=rgba,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black@0,setsar=1,fps=30/1,trim=duration=1,format=rgba,format=rgba,settb=expr=1/30,setpts=PTS-STARTPTS+15");
    expect(chain).not.toContain("reset_sar=");
    expect(capturedArgs).toEqual(expect.arrayContaining(["-pix_fmt", "yuv420p"]));
  });

  it("retains SDR exposure exactly once before raw panel fitting", async () => {
    const project = projectFixture();
    project.tracks[0].clips[0].color.exposure = -.5;
    await construct(project);
    const chain = sourceChain();
    expectRawPanelFit(chain);
    expect(chain.match(/exposure=exposure=-0\.5:black=0/g)).toHaveLength(1);
    expect(chain.indexOf("exposure=exposure=-0.5:black=0")).toBeLessThan(chain.indexOf("force_original_aspect_ratio=increase"));
    expect(chain).not.toContain("tonemap=");
  });

  it("retains source-domain linear white balance and rejects contradictory discovered metadata", async () => {
    const project = projectFixture();
    project.assets[0].color = { interpretation: "rec709", primaries: "bt709", transfer: "bt709", matrix: "bt709", range: "tv" };
    project.tracks[0].clips[0].color.whiteBalanceRed = .2;
    await construct(project);
    const chain = sourceChain();
    expectRawPanelFit(chain);
    expect(chain).toContain("format=gbrapf32le");
    expect(chain.indexOf("color_trc=linear")).toBeLessThan(chain.indexOf("force_original_aspect_ratio=increase"));
    vi.mocked(runProcess).mockClear();
    vi.mocked(probeMedia).mockResolvedValue({ duration: 2, hasVideo: true, hasAudio: false,
      colorPrimaries: "bt2020", colorTransfer: "arib-std-b67", colorMatrix: "bt2020nc", colorRange: "tv" });
    await expect(construct(project)).rejects.toThrow(/來源|不一致/);
    expect(vi.mocked(runProcess)).not.toHaveBeenCalled();
  });

  it("preserves premultiplied source alpha and ordinary high-bit-depth alpha delivery", async () => {
    const floating = projectFixture();
    floating.assets[0].alphaMode = "premultiplied";
    await construct(floating);
    const chain = sourceChain();
    expectRawPanelFit(chain);
    expect(chain.indexOf("unpremultiply=inplace=1")).toBeLessThan(chain.indexOf("force_original_aspect_ratio=increase"));
    const ordinary = projectFixture(1920, 1080, 1080, 1920, false);
    ordinary.assets[0].alphaMode = "opaque";
    await construct(ordinary, true);
    expect(sourceChain()).toContain("format=gbrap16le,lut=a=65535,pad=1080:1920");
    expect(sourceChain()).not.toContain("reset_sar=");
    expect(capturedArgs).toEqual(expect.arrayContaining(["-c:v", "prores_ks", "-pix_fmt", "yuva444p10le", "-c:a", "pcm_s24le"]));
  });

  it("keeps floating HDR, ACES and layout mixtures blocked at real project admission", async () => {
    const hdr = projectFixture();
    hdr.assets[0].color = { interpretation: "hlg", primaries: "bt2020", transfer: "arib-std-b67", matrix: "bt2020nc", range: "tv" };
    await expect(construct(hdr)).rejects.toThrow(/Rec\.709/);
    const aces = projectFixture();
    aces.colorManagement!.mode = "aces2";
    await expect(construct(aces)).rejects.toThrow(/Rec\.709/);
    const layout = projectFixture();
    layout.tracks[0].clips[0].layout = { crop: { x: 0, y: 0, width: 1, height: 1 }, viewport: { x: 0, y: 0, width: 1, height: 1 } };
    await expect(construct(layout)).rejects.toThrow(/Rec\.709/);
    expect(vi.mocked(probeMedia)).not.toHaveBeenCalled();
    expect(vi.mocked(runProcess)).not.toHaveBeenCalled();
  });

  it("keeps animated source white balance blocked before any decoder or encoder call", async () => {
    const project = projectFixture();
    project.tracks[0].clips[0].keyframes.push({ id: "wb-change", time: .5, easing: "linear", transform: { ...DEFAULT_TRANSFORM },
      color: { ...DEFAULT_COLOR, whiteBalanceRed: .3 } });
    await expect(construct(project)).rejects.toThrow(/動畫線性白平衡/);
    expect(vi.mocked(probeMedia)).not.toHaveBeenCalled();
    expect(vi.mocked(runProcess)).not.toHaveBeenCalled();
  });
});
