import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createEmptyProject } from "../domain/editGraph";
import { applyCommand } from "../domain/commands";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import { buildReferenceMotionTemplateCommands } from "../application/referenceMotionTemplateCommands";
import { renderComposite } from "./ffmpegComposite";
import { buildRenderPlan } from "./planner";

const app = fileURLToPath(new URL("../../", import.meta.url));
const ff = resolve(app, "vendor/ffmpeg/win32-x64/ffmpeg.exe"), fp = resolve(app, "vendor/ffmpeg/win32-x64/ffprobe.exe");

it("decodes the authored small → full-frame → small handoff without first-frame cropping or drift", async () => {
  const base = resolve(app, ".rd/tmp"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(resolve(base, "motion-growth-")), width = 256, height = 456, fps = 30, frames = 150;
  const run = (args: string[]) => {
    const child = spawnSync(ff, args, { windowsHide: true, timeout: 30000, maxBuffer: 24 * 1024 * 1024 });
    if (child.status !== 0 || child.error) throw Error(child.stderr?.toString() || String(child.error));
    return child.stdout;
  };
  const source = resolve(root, "white.mp4"), output = resolve(root, "growth.mp4");
  run(["-v", "error", "-f", "lavfi", "-i", `color=white:s=${width}x${height}:r=${fps}:d=5`, "-c:v", "libx264", "-pix_fmt", "yuv420p", source]);
  const project = createEmptyProject("Growth regression", { id: "growth", width, height, fps });
  project.assets = [{ id: "white", name: "White subject", kind: "video", uri: source, width, height, duration: 5, color: { interpretation: "rec709" } }];
  project.tracks[0].clips.push({ id: "main", trackId: project.tracks[0].id, assetId: "white", sourceStart: 0, timelineStart: 0, duration: 5, volume: 0,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] });
  let id = 0;
  const packet = buildReferenceMotionTemplateCommands(project, { templateId: "evidence_takeover", clipId: "main", startFrame: 0, durationFrames: frames,
    title: "細節", sources: [], purpose: "Decoded geometry regression", evidenceRefs: ["synthetic:known-white-subject"] }, p => `${p}-${id++}`);
  const scene = applyCommand(project, { type: "batch", commands: packet.commands });
  // Measure the scene's real media geometry independently of foreground text.
  scene.motionGraphics = [];
  await renderComposite(ff, fp, output, scene, buildRenderPlan(scene, p => p), undefined, "libx264", 30000);
  const raw = run(["-v", "error", "-i", output, "-an", "-fps_mode", "passthrough", "-pix_fmt", "gray", "-f", "rawvideo", "-"]);
  expect(raw.length).toBe(width * height * frames);
  const bounds = Array.from({ length: frames }, (_, frame) => {
    let left = width, top = height, right = -1, bottom = -1, area = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (raw[frame * width * height + y * width + x] > 150) {
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); area++;
    }
    return { frame, left, top, right, bottom, area };
  });
  const holds = packet.phases.filter(p => p.role === "hold"), full = holds[1];
  for (let frame = full.startFrame + 1; frame < full.endFrame; frame++) {
    const b = bounds[frame];
    expect(b.area / (width * height), `${root} frame ${frame}`).toBeGreaterThan(.98);
    expect(Math.abs((b.left + b.right) / 2 - (width - 1) / 2)).toBeLessThanOrEqual(1.5);
    expect(Math.abs((b.top + b.bottom) / 2 - (height - 1) / 2)).toBeLessThanOrEqual(1.5);
  }
  const initial = bounds[holds[0].startFrame + 1], returned = bounds[holds[2].startFrame + 1];
  expect(initial.area / (width * height)).toBeGreaterThan(.44); expect(initial.area / (width * height)).toBeLessThan(.48);
  for (const key of ["left", "top", "right", "bottom"] as const) expect(Math.abs(initial[key] - returned[key])).toBeLessThanOrEqual(1);
  for (const hold of holds) for (let frame = hold.startFrame + 1; frame < hold.endFrame; frame++) {
    for (const key of ["left", "top", "right", "bottom"] as const) expect(bounds[frame][key]).toBe(bounds[hold.startFrame + 1][key]);
  }
  await writeFile(resolve(root, "decoded-bounds.json"), JSON.stringify({ scope: "compiled 2D scene, production FFmpeg, decoded geometry only; not art approval", root, phases: packet.phases, bounds }, null, 2));
}, 30000);
