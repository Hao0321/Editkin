import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { compileClipAlphaPlan } from "../domain/clipAlphaPlan";
import { createEmptyProject } from "../domain/editGraph";
import { createClipMask } from "../domain/masks";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type TimelineClip } from "../domain/types";
import { compileFixedTemplateWindowMaskV3 } from "../application/fixedTemplateWindowV3";
import { encodeProjectBytes } from "../application/projectCodec";
import { REPO_TMP, useTempRoots } from "../test/tempRoot.mjs";
import { buildClipMaskAlphaFilters } from "./maskFilters";
import { compositeFrameClock } from "./compositeFrameClock";
import { withRenderLifetime } from "./renderLifetime";
import { removeRenderWorkDirectory, withRenderWorkRoot } from "./renderWorkspace";
import { appendFixedWindowMaskInputsV3, prepareFixedWindowMaskPlanesV3 } from "./fixedWindowMaskRasterV3";
import { renderComposite } from "./ffmpegComposite";
import { buildRenderPlan } from "./planner";

const ff = resolve("vendor/ffmpeg/win32-x64/ffmpeg.exe"), fp = resolve("vendor/ffmpeg/win32-x64/ffprobe.exe");
const width = 64, height = 48, frames = 12, temp = useTempRoots();
function fixture() {
  const project = createEmptyProject("Raster fixture", { id: "raster-v3", width, height, fps: 30 });
  project.assets.push({ id: "source", name: "Owned fixture", kind: "image", uri: "D:/owned/source.png", width, height, duration: 1 });
  const clip: TimelineClip = { id: "main", assetId: "source", trackId: project.tracks[0].id, timelineStart: .1, sourceStart: 0, duration: frames / 30, volume: 0,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [0, .2, 11 / 30].map((time, i) => ({
      id: `pose-${i}`, time, transform: { ...DEFAULT_TRANSFORM, scale: i === 1 ? 1.096 : 1 }, color: { ...DEFAULT_COLOR }, easing: "linear" as const })),
    layout: { crop: { x: 0, y: 0, width: 1, height: 1 }, viewport: { x: 0, y: 0, width: 1, height: 1 } } };
  const mask = createClipMask("window", "polygon"); mask.feather = .02; mask.expansion = .013; mask.refine.edgeShift = -.007;
  mask.path = [[.1, .1], [.8, .1], [.9, .5], [.5, .4], [.8, .9], [.1, .8]].map(([x, y], i) => ({ id: `p${i}`, x, y }));
  mask.fixedWindowV3 = { schema: "editkin.fixed-template-window/v3" }; clip.masks = [mask]; project.tracks[0].clips.push(clip);
  return { project, clip, mask };
}
function run(args: string[], input?: Buffer): Buffer {
  const child = spawnSync(ff, ["-v", "error", "-nostdin", ...args], { input, windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  expect(child.error).toBeUndefined(); expect(child.status, child.stderr.toString()).toBe(0); return child.stdout;
}

describe.each([255, 65535] as const)("fixed-window PNG masks at maximum %s", maximum => {
  it.each(["binary", "feathered", "inverted"] as const)("matches all GEQ pixels through source alpha and an authored stack: %s", async kind => {
    const root = await temp.create("fixed-mask-plane-", { parent: REPO_TMP }), { project, clip, mask } = fixture();
    mask.opacity = kind === "binary" ? 1 : .67; mask.feather = kind === "binary" ? 0 : .02; mask.inverted = kind === "inverted";
    const cut = createClipMask("cut", "rectangle"); cut.feather = 0; cut.mode = "subtract"; cut.opacity = kind === "binary" ? 1 : .5;
    cut.path = [[.5, 0], [1, 0], [1, 1], [.5, 1]].map(([x, y], i) => ({ id: `c${i}`, x, y })); clip.masks!.push(cut);
    const before = encodeProjectBytes(project), plan = compileClipAlphaPlan(project, clip), format = maximum === 255 ? "gray" : "gray16le";
    const source = Buffer.alloc(width * height * frames * (maximum === 255 ? 1 : 2));
    for (let pixel = 0; pixel < width * height * frames; pixel += 1) {
      const value = Math.floor((pixel % width) / (width - 1) * maximum);
      if (maximum === 255) source[pixel] = value; else source.writeUInt16LE(value, pixel * 2);
    }
    const sourcePath = join(root, "source.gray"); await writeFile(sourcePath, source);
    await withRenderWorkRoot(join(root, "out.mp4"), join(root, "work"), async () => {
      const cached = await prepareFixedWindowMaskPlanesV3(project, [clip], maximum);
      try {
        expect(cached.planesByClip.get(clip.id)).toHaveLength(1);
        const base = ["-f", "rawvideo", "-pixel_format", format, "-video_size", `${width}x${height}`, "-framerate", "30", "-i", sourcePath];
        const graph = (labels?: ReadonlyMap<string, string>) => buildClipMaskAlphaFilters(plan, {
          sourceAlphaLabel: "0:v", outputLabel: "out", vectorPlaneLabels: labels, width, height, pixelMaximum: maximum,
        }).join(";");
        const referenceGraph = join(root, "reference.filter"); await writeFile(referenceGraph, graph());
        const reference = run([...base, "-filter_complex_script", referenceGraph, "-map", "[out]", "-frames:v", String(frames), "-pix_fmt", format, "-f", "rawvideo", "-"]);
        const clock = compositeFrameClock(project.fps), args = [...base];
        const inputs = appendFixedWindowMaskInputsV3(args, cached.planesByClip.get(clip.id), 1, clock.rate), labels = new Map<string, string>();
        const opening = [...inputs.inputIndexes!].map(([id, index], ordinal) => {
          const label = `cached${ordinal}`; labels.set(id, label); return `[${index}:v]format=${format},${clock.timestampFilters}[${label}]`;
        });
        const actualGraph = join(root, "actual.filter"); await writeFile(actualGraph, [...opening, graph(labels)].join(";"));
        const actual = run([...args, "-filter_complex_script", actualGraph, "-map", "[out]", "-frames:v", String(frames), "-pix_fmt", format, "-f", "rawvideo", "-"]);
        expect(actual.length).toBe(source.length); expect(actual.equals(reference)).toBe(true); expect(encodeProjectBytes(project)).toEqual(before);
        await writeFile(join(root, "RESULT.json"), JSON.stringify({ maximum, kind, frames, everyPixelExact: true, ffmpegSha256: createHash("sha256").update(await readFile(ff)).digest("hex") }));
      } finally { if (cached.workDirectory) await removeRenderWorkDirectory(cached.workDirectory); }
    });
  }, 30000);
});

describe("fixed-window raster ownership and production integration", () => {
  it("keeps legacy and fractional hard-mask rendering on the original path without a cache directory", async () => {
    const { project, clip, mask } = fixture(); delete mask.fixedWindowV3;
    expect((await prepareFixedWindowMaskPlanesV3(project, [clip])).workDirectory).toBeUndefined();
    mask.fixedWindowV3 = { schema: "editkin.fixed-template-window/v3" }; mask.feather = 0; mask.opacity = .67;
    expect((await prepareFixedWindowMaskPlanesV3(project, [clip])).workDirectory).toBeUndefined();
  });
  it("aborts during cache generation and removes only its owned work directory", async () => {
    const root = await temp.create("fixed-mask-cancel-", { parent: REPO_TMP }), { project, clip } = fixture();
    const controller = new AbortController(), reason = new Error("owned cancellation");
    await writeFile(join(root, "author.txt"), "preserve");
    await withRenderWorkRoot(join(root, "out.mp4"), root, async () => {
      await expect(withRenderLifetime({ signal: controller.signal }, async () => {
        const pending = prepareFixedWindowMaskPlanesV3(project, [clip]); controller.abort(reason); return pending;
      })).rejects.toThrow("owned cancellation");
    });
    expect(await readFile(join(root, "author.txt"), "utf8")).toBe("preserve");
    expect((await readdir(root)).filter(name => name.startsWith("editkin-filtergraph-"))).toEqual([]);
  });
  it("renders the cached window identically to explicit materialized masks at a nonzero timeline start", async () => {
    const root = await temp.create("fixed-mask-render-", { parent: REPO_TMP }), { project, clip, mask } = fixture();
    const source = join(root, "source.png");
    run(["-f", "rawvideo", "-pixel_format", "rgba", "-video_size", `${width}x${height}`, "-i", "pipe:0", "-frames:v", "1", source], Buffer.alloc(width * height * 4, 255));
    project.assets[0].uri = source;
    const reference = structuredClone(project); reference.tracks[0].clips[0].masks = [compileFixedTemplateWindowMaskV3(project, clip, mask)];
    const before = encodeProjectBytes(project), actualOutput = join(root, "actual.mp4"), referenceOutput = join(root, "reference.mp4");
    for (const [p, output] of [[project, actualOutput], [reference, referenceOutput]] as const) {
      await withRenderWorkRoot(output, join(root, "work"), () => renderComposite(ff, fp, output, p, buildRenderPlan(p, path => path), undefined, "libx264", 30000));
    }
    const decode = (path: string) => run(["-i", path, "-an", "-fps_mode", "passthrough", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"]);
    const actual = decode(actualOutput); expect(actual.length).toBe(width * height * 3 * 15); expect(actual.equals(decode(referenceOutput))).toBe(true);
    expect(encodeProjectBytes(project)).toEqual(before); expect(await readdir(join(root, "work"))).toEqual([]);
  }, 30000);
});
