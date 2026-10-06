import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type MediaAsset } from "../domain/types";
import { MEDIA_UTILITY_SELF_CONTAINED_FORMATS } from "../application/mediaUtilityInputPolicy";
import { renderMesh3dVideo } from "./mesh3dRender";

const spawned = vi.hoisted(() => [] as Array<{ command: string; args: string[] }>);
// Record the real argv, then run a small Node stand-in: no FFmpeg binary is executed.
vi.mock("node:child_process", async importOriginal => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const spawn = (command: string, args: readonly string[], options: import("node:child_process").SpawnOptions) => {
    spawned.push({ command, args: [...args] });
    const after = (flag: string) => args[args.indexOf(flag) + 1] ?? "";
    const [, width, height] = /scale=(\d+):(\d+)/.exec(after("-vf")) ?? [];
    const script = command === "fixture-ffprobe"
      ? `process.stdout.write(${JSON.stringify(JSON.stringify({ streams: [{ codec_type: "video", width: 8, height: 8, color_transfer: "bt709" }], format: { duration: "1" } }))})`
      : args.includes("pipe:0") ? "process.stdin.resume()"
      : `process.stdout.write(Buffer.alloc(${Number(width) * Number(height) * 4 * Number(after("-frames:v"))}))`;
    return real.spawn(process.execPath, ["-e", script], options);
  };
  return { ...real, spawn };
});

const roots: string[] = [];
afterEach(async () => {
  spawned.length = 0;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(fileName: string, kind: MediaAsset["kind"]) {
  const root = await mkdtemp(join(tmpdir(), "editkin-mesh-input-policy-")); roots.push(root);
  const source = join(root, fileName);
  await writeFile(source, "fixture bytes; the FFmpeg stand-in never decodes them");
  const project = createEmptyProject("mesh input policy", { width: 32, height: 32, fps: 30 });
  project.assets.push({ id: "source", name: fileName, kind, uri: source, duration: 1, color: { interpretation: "rec709" } });
  project.tracks[0].clips.push({ id: "footage", assetId: "source", trackId: project.tracks[0].id, timelineStart: 0, sourceStart: 0, duration: 1,
    volume: 0, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] });
  project.scene3d = { schema: "editkin.mesh-scene/v1", enabled: true, background: { color: "#FFFFFF", gridColor: "#E0EAF8", spacing: 72, grid: false },
    light: { direction: [-.4, .7, 1], ambient: .68, intensity: .36 },
    segments: [{ id: "segment", name: "segment", timelineStart: 0, duration: 2 / 30, cameraKeyframes: [],
      camera: { position: [0, 0, 6], target: [0, 0, 0], verticalFovDegrees: 42, near: .1, far: 40 },
      objects: [{ id: "screen", name: "screen", geometry: { kind: "curved_video", radius: 10, width: 3, height: 3, segments: 4 },
        pose: { position: [0, 0, 0], rotationDegrees: [0, 0, 0], scale: [1, 1, 1] }, keyframes: [],
        material: { color: "#FFFFFF", unlit: true, clipId: "footage" } }] }] };
  return { root, source, project };
}

const policy = ["-format_whitelist", MEDIA_UTILITY_SELF_CONTAINED_FORMATS.join(","), "-protocol_whitelist", "file"];

describe("mesh 3D texture inputs use the self-contained local media policy", () => {
  it.each([
    ["clip.mp4", "video", policy, 2],
    ["still.jpg", "image", [...policy, "-f", "jpeg_pipe"], 1],
  ] as const)("%s: probe and decoder restrict formats/protocols; the raw encoder pipe stays unrestricted", async (fileName, kind, expected, frames) => {
    const { root, source, project } = await fixture(fileName, kind);
    const receipt = await renderMesh3dVideo(project, join(root, "mesh.mp4"), { ffmpegPath: "fixture-ffmpeg", ffprobePath: "fixture-ffprobe", timeoutMs: 30_000 });
    expect(receipt.frameCount).toBe(2);
    const probe = spawned.find(call => call.command === "fixture-ffprobe")!;
    expect(probe.args.slice(0, 2 + expected.length)).toEqual(["-v", "error", ...expected]);
    expect(probe.args.at(-1)).toBe(source);
    const decoder = spawned.find(call => call.command === "fixture-ffmpeg" && call.args.includes(source))!;
    const input = decoder.args.indexOf("-i");
    expect(decoder.args.slice(input - expected.length, input + 2)).toEqual([...expected, "-i", source]);
    expect(decoder.args[decoder.args.indexOf("-frames:v") + 1]).toBe(String(frames));
    const encoder = spawned.find(call => call.args.includes("pipe:0"))!;
    expect(encoder.args).not.toContain("-protocol_whitelist");
    expect(encoder.args).not.toContain("-format_whitelist");
  });
});
