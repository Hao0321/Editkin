// D1 invariance (design §(d) D1): a SHORT render calls the legacy lifetime/work-root wrappers with exactly the legacy
// arguments and never reaches the LONG runner; the LONG single-graph route of the same project runs today's graph
// with identical arguments, so its bytes equal the legacy output. Pass-through observers only; real FFmpeg.
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { useTempRoots } from "../test/tempRoot.mjs";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject } from "../domain/types";
import { renderProject, type RenderOptions } from "./ffmpeg";

const spies = vi.hoisted(() => ({ lifetime: [] as unknown[][], workRoot: [] as unknown[][], runner: [] as unknown[][] }));
vi.mock("./renderLifetime", async original => {
  const actual = await original<typeof import("./renderLifetime")>();
  return { ...actual, withRenderLifetime: (...args: Parameters<typeof actual.withRenderLifetime>) => { spies.lifetime.push(args); return actual.withRenderLifetime(...args); } };
});
vi.mock("./renderWorkspace", async original => {
  const actual = await original<typeof import("./renderWorkspace")>();
  return { ...actual, withRenderWorkRoot: (...args: Parameters<typeof actual.withRenderWorkRoot>) => { spies.workRoot.push(args); return actual.withRenderWorkRoot(...args); } };
});
vi.mock("./longRenderRunnerV1", async original => {
  const actual = await original<typeof import("./longRenderRunnerV1")>();
  return { ...actual, runLongRenderV1: (...args: Parameters<typeof actual.runLongRenderV1>) => { spies.runner.push(args); return actual.runLongRenderV1(...args); } };
});

const run = promisify(execFile);
const ffmpeg = resolve("vendor/ffmpeg/win32-x64/ffmpeg.exe"), ffprobe = resolve("vendor/ffmpeg/win32-x64/ffprobe.exe");
const temp = useTempRoots();
let root = "", source = "";

beforeAll(async () => {
  root = await temp.create("long-invariance-");
  source = join(root, "source.mp4");
  await run(ffmpeg, ["-n", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=2", "-f", "lavfi", "-i", "sine=f=330:r=48000:d=2",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p", "-g", "30", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
    "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", source], { windowsHide: true, timeout: 60_000 });
}, 60_000);

function project(): EditProject {
  const value = createEmptyProject("D1 invariance", { id: "d1-invariance", width: 320, height: 180, fps: 30 });
  value.updatedAt = "2026-10-15T00:00:00.000Z"; value.director.updatedAt = value.updatedAt;
  value.assets.push({ id: "src", name: "source", kind: "video", uri: source, duration: 2, width: 320, height: 180, color: { interpretation: "rec709", primaries: "bt709", transfer: "bt709", matrix: "bt709", range: "tv" } });
  value.tracks[0].clips.push({ id: "clip", assetId: "src", trackId: value.tracks[0].id, timelineStart: 0, sourceStart: 0, duration: 2, volume: 1,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR, contrast: 1.1, saturation: 1.05 }, keyframes: [] });
  value.captions.push({ id: "cap", text: "D1", start: .2, duration: 1.2 });
  return value;
}

describe("D1: SHORT renders keep the legacy path; the LONG single graph keeps legacy bytes", () => {
  it("SHORT: identical legacy wrapper arguments and no LONG runner; forced LONG: runner only, byte-identical output", async () => {
    const work = join(root, "configured-work"); await mkdir(work);
    const controller = new AbortController();
    const options: RenderOptions = { ffmpegPath: ffmpeg, ffprobePath: ffprobe, preferGpu: false, fontRoot: resolve("public/fonts"), timeoutMs: 180_000, stallTimeoutMs: 600_000, signal: controller.signal, workRoot: work };
    const shortOutput = join(root, "out", "short.mp4");
    const short = await renderProject(project(), shortOutput, options);
    expect(spies.runner).toHaveLength(0);
    expect(spies.lifetime[0][0]).toEqual({ signal: controller.signal, timeoutMs: 180_000, workSeconds: 2, stallMs: 600_000 });
    expect(spies.workRoot).toHaveLength(1);
    expect(spies.workRoot[0].slice(0, 2)).toEqual([shortOutput, work]);
    expect(short.longRender).toBeUndefined();
    spies.lifetime.length = 0; spies.workRoot.length = 0;

    const registry = join(root, "registry");
    const longOutput = join(root, "out", "long.mp4");
    const long = await renderProject(project(), longOutput, { ...options, longRender: { forceClass: "long", journalRegistryRoot: registry } });
    expect(spies.runner).toHaveLength(1);
    expect(spies.workRoot).toHaveLength(0);
    expect(spies.lifetime[0][0]).toEqual({ signal: controller.signal, timeoutMs: 180_000, workSeconds: 2, stallMs: 600_000 });
    expect(long.longRender).toMatchObject({ route: "ffmpeg-single-graph", classification: { class: "long", reason: "forced-long" }, workRoot: { path: work, source: "configured" },
      cleanup: { leftovers: [] } });
    expect(long.longRender!.publish.checks.every(check => check.ok)).toBe(true);
    expect(long.planner).toBe(short.planner);
    expect(await readFile(longOutput)).toEqual(await readFile(shortOutput));
    expect((await readdir(join(root, "out"))).sort()).toEqual(["long.mp4", "short.mp4"]);
    expect(await readdir(work)).toEqual([]);
    expect(await readdir(registry)).toEqual([]);
  }, 300_000);
});
