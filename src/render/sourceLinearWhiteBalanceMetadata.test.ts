import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type MediaAsset } from "../domain/types";
import { createEmptyProject } from "../domain/editGraph";
import { linearWhiteBalanceInput, whiteBalanceAssetWithMetadata } from "./sourceLinearWhiteBalance";
import { renderComposite } from "./ffmpegComposite";
import { buildRenderPlan } from "./planner";
import { probeMedia } from "./ffmpegMedia";

const app = fileURLToPath(new URL("../../", import.meta.url));
const ffmpeg = join(app, "vendor/ffmpeg/win32-x64/ffmpeg.exe"), ffprobe = join(app, "vendor/ffmpeg/win32-x64/ffprobe.exe");
const asset: MediaAsset = { id: "untagged", name: "Unknown interpretation", uri: "owned-fixture", kind: "video", duration: .2 };
let workspace: string, source: string;
beforeAll(async () => {
  await mkdir(join(app, ".rd/tmp"), { recursive: true });
  workspace = await mkdtemp(join(app, ".rd/tmp/wb-input-metadata-")); source = join(workspace, "untagged.mp4");
  const result = spawnSync(ffmpeg, ["-v", "error", "-nostdin", "-f", "lavfi", "-i", "color=c=gray:s=64x64:r=10:d=0.2",
    "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", source], { windowsHide: true, timeout: 15000 });
  expect(result.error).toBeUndefined(); expect(result.status, result.stderr.toString()).toBe(0);
}, 20000);

describe("new physical WB requires a resolved input convention", () => {
  it.each([undefined, { interpretation: "auto" as const }, { interpretation: "auto" as const, primaries: "bt709" }])("rejects auto without a resolved transfer: %j", color => {
    expect(() => linearWhiteBalanceInput({ ...asset, color })).toThrow(/Input Transform|解讀|Transfer/);
  });
  it("keeps explicit Rec709 interpretation and actual tagged auto sources usable", () => {
    expect(linearWhiteBalanceInput({ ...asset, color: { interpretation: "rec709" } })).toBe("rec709");
    expect(linearWhiteBalanceInput({ ...asset, color: { interpretation: "auto", transfer: "bt709" } })).toBe("rec709");
    expect(linearWhiteBalanceInput({ ...asset, color: { interpretation: "auto", transfer: "arib-std-b67", primaries: "bt2020", matrix: "bt2020nc", range: "tv" } })).toBe("hlg");
    expect(linearWhiteBalanceInput({ ...asset, color: { interpretation: "auto", transfer: "smpte2084", primaries: "bt2020", matrix: "bt2020nc", range: "tv" } })).toBe("pq");
    expect(() => linearWhiteBalanceInput({ ...asset, color: { interpretation: "log_unresolved" } })).toThrow();
    expect(() => whiteBalanceAssetWithMetadata({ ...asset, color: { interpretation: "rec709" } }, { transfer: "arib-std-b67" })).toThrow();
  });
  it("fails visibly on actual untagged MP4, while explicit author interpretation renders", async () => {
    const original = await readFile(source), probe = await probeMedia(source, ffprobe);
    expect([probe.colorPrimaries, probe.colorTransfer, probe.colorMatrix, probe.colorRange]).toEqual([undefined, undefined, undefined, undefined]);
    const project = createEmptyProject("Owned unknown metadata control", { width: 64, height: 64, fps: 10 });
    project.assets.push({ ...asset, uri: source });
    project.tracks[0].clips.push({ id: "clip", assetId: asset.id, trackId: project.tracks[0].id, sourceStart: 0, timelineStart: 0,
      duration: .2, volume: 0, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR, whiteBalanceRed: .2 }, keyframes: [] });
    const unknownOutput = join(workspace, "must-not-render.mp4");
    await expect(renderComposite(ffmpeg, ffprobe, unknownOutput, project, buildRenderPlan(project, uri => uri), undefined, "libx264", 15000)).rejects.toThrow(/Input Transform|解讀|Transfer/);
    await expect(stat(unknownOutput)).rejects.toMatchObject({ code: "ENOENT" });
    project.assets[0].color = { interpretation: "rec709" };
    const explicitOutput = join(workspace, "explicit-rec709.mp4");
    await renderComposite(ffmpeg, ffprobe, explicitOutput, project, buildRenderPlan(project, uri => uri), undefined, "libx264", 15000);
    const decoded = spawnSync(ffmpeg, ["-v", "error", "-i", explicitOutput, "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"], { windowsHide: true, timeout: 15000 });
    expect(decoded.error).toBeUndefined(); expect(decoded.status, decoded.stderr.toString()).toBe(0);
    expect(decoded.stdout.length).toBe(64 * 64 * 3);
    expect((await readFile(source)).equals(original)).toBe(true);
  }, 45000);
});
