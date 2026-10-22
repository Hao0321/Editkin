import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PRORES_4444, resolveMotionLibraryTools } from "../../motionLibrary/render/renderItem";
import { styleKey } from "../jobs";
import { renderStyleJob, type StyleJobRenderResult } from "../render/renderStyleJob";
import type { StyleTemplateV1 } from "../types";
import { compileUiCardPlanV1, type UiCardCompileResultV1, type UiCardShotInput } from "./compile";
import { analyzeScreen, renderCardLayer } from "./nodeRender";
import type { UiCardPlanInputV1 } from "./plan";
import type { RoiHeat } from "./roi";

/**
 * S1 v2 review harness (art review only; the product binds the same jobs and card layers in Editkin):
 * analyze each screen recording → compile → render overlay jobs and chrome stills → draw the card layer →
 * composite backdrop · cards · overlays + the VO → MP4, a 24-frame contact sheet and style-frame comparisons.
 */

export interface UiCardReviewShot { readonly id: string; readonly file: string; readonly in: number; readonly duration: number }

export interface UiCardReviewInput {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly shots: readonly UiCardReviewShot[];
  readonly audio: { readonly path: string; readonly start: number };
  readonly template: StyleTemplateV1;
  readonly plan: UiCardPlanInputV1;
  readonly outDir: string;
  readonly cacheRoot: string;
  readonly tempRoot: string;
  readonly jobConcurrency?: number;
  /** Style frames to compare against: [image path, timeline second]. */
  readonly compare?: ReadonlyArray<{ readonly image: string; readonly at: number; readonly name: string }>;
  readonly sheetTimes?: readonly number[];
}

function run(executable: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(executable, args, { maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: 3_600_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${executable.split(/[\\/]/).pop()} failed: ${error.message}\n${String(stderr).slice(-3000)}`));
      else resolvePromise(String(stdout));
    });
  });
}

const n = (value: number) => Number(value.toFixed(6)).toString();

export async function runUiCardReview(input: UiCardReviewInput): Promise<{ preview: string; sheets: string[]; compile: UiCardCompileResultV1; timings: Record<string, number> }> {
  const timings: Record<string, number> = {};
  const tick = (label: string, started: number) => { timings[label] = Math.round(performance.now() - started); };
  const tools = await resolveMotionLibraryTools();
  const out = resolve(input.outDir, input.name);
  await mkdir(out, { recursive: true });
  const { width: W, height: H, fps } = input;

  // 1. Measure every screen recording (cached by its span).
  let started = performance.now();
  const shots: UiCardShotInput[] = [];
  let cursor = 0;
  for (const shot of input.shots) {
    const probe = JSON.parse(await run(tools.ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", shot.file])) as
      { streams: Array<{ width: number; height: number }>; format: { duration: string } };
    const source = { width: probe.streams[0].width, height: probe.streams[0].height };
    const tail = Math.max(0, Math.min(0.5, Number(probe.format.duration) - shot.in - shot.duration));
    const cacheFile = join(out, `heat-${styleKey({ v: 2, file: shot.file, in: shot.in, d: shot.duration, tail }).slice(0, 16)}.json`);
    let heat: RoiHeat;
    try {
      const cached = JSON.parse(await readFile(cacheFile, "utf8")) as Omit<RoiHeat, "frames" | "detail"> & { frames: number[][]; detail?: number[] };
      heat = { rate: cached.rate, source: cached.source, content: cached.content, cols: cached.cols, rows: cached.rows,
        frames: cached.frames.map(frame => Float32Array.from(frame)), ...(cached.detail ? { detail: Float32Array.from(cached.detail) } : {}) };
    } catch {
      heat = await analyzeScreen(tools.ffmpeg, shot.file, shot.in, shot.duration + tail + 0.2, source);
      await writeFile(cacheFile, JSON.stringify({ ...heat, frames: heat.frames.map(frame => Array.from(frame, value => Math.round(value))),
        ...(heat.detail ? { detail: Array.from(heat.detail, value => Math.round(value)) } : {}) }));
    }
    shots.push({ clipId: shot.id, timelineStart: cursor, duration: shot.duration, sourceStart: shot.in, source, heat, tail });
    cursor += shot.duration;
  }
  tick("analyzeMs", started);

  // 2. Compile.
  const compile = compileUiCardPlanV1(input.template, input.plan, { width: W, height: H, fps, shots });
  await writeFile(join(out, "compile.json"), JSON.stringify({ ...compile, layers: compile.layers.map(layer => ({ ...layer, frames: layer.frames.length })) }, null, 1));

  // 3. Render jobs (cached by key).
  started = performance.now();
  const renders: StyleJobRenderResult[] = new Array(compile.jobs.length);
  let nextJob = 0;
  await Promise.all(Array.from({ length: Math.max(1, input.jobConcurrency ?? 4) }, async () => {
    while (nextJob < compile.jobs.length) {
      const index = nextJob++;
      renders[index] = await renderStyleJob(compile.jobs[index], { cacheRoot: input.cacheRoot, tempRoot: input.tempRoot, schedule: task => task() });
    }
  }));
  tick("jobsMs", started);
  const renderOf = new Map(compile.jobs.map((job, index) => [job.id, renders[index]]));

  // 4. Card layer (cached by its exact layers and sources).
  started = performance.now();
  const sources = new Map(input.shots.map(shot => [shot.id, { file: shot.file, width: shots.find(s => s.clipId === shot.id)!.source.width, height: shots.find(s => s.clipId === shot.id)!.source.height }]));
  const layerKey = styleKey({ v: 4, layers: compile.layers, sources: [...sources.entries()], frame: compile.frame });
  const cardLayer = join(input.cacheRoot, "uicard", `${layerKey}.mov`);
  await mkdir(join(input.cacheRoot, "uicard"), { recursive: true });
  if (!(await stat(cardLayer).then(() => true, () => false))) {
    const partial = `${cardLayer}.partial.mov`;
    await renderCardLayer(compile, { ffmpeg: tools.ffmpeg, output: partial, sources, encodeArgs: PRORES_4444,
      chrome: new Map(compile.layers.flatMap(layer => [[layer.under, renderOf.get(layer.under)!.path], [layer.over, renderOf.get(layer.over)!.path]] as Array<[string, string]>)),
      onProgress: (frame, total, spent) => console.log(`  card layer ${frame}/${total} ${new Date().toISOString().slice(11, 19)} ${JSON.stringify(spent ?? {})}`) });
    const { rename } = await import("node:fs/promises");
    await rename(partial, cardLayer);
  }
  tick("cardLayerMs", started);

  // 5. Composite: backdrop → card layer → overlays (by track, then time) + VO.
  started = performance.now();
  const total = compile.frame.frames / fps;
  const preview = join(out, `${input.name}.mp4`);
  const backdrop = compile.jobs.find(job => job.component === "uiBackdrop")!;
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-loop", "1", "-framerate", String(fps), "-t", n(total), "-i", renderOf.get(backdrop.id)!.path, "-i", cardLayer];
  const filters = [`[0:v]format=gbrp,setsar=1[b0]`, `[1:v]setpts=PTS-STARTPTS[cl]`, `[b0][cl]overlay=eof_action=pass:repeatlast=0:format=gbrp[v0]`];
  let current = "v0", inputIndex = 2;
  const overlays = compile.jobs.filter(job => job.output === "alpha").sort((a, b) => a.startFrame - b.startFrame);
  for (const [index, job] of overlays.entries()) {
    args.push("-i", renderOf.get(job.id)!.path);
    filters.push(`[${inputIndex}:v]setpts=PTS-STARTPTS+${n(job.startFrame / fps)}/TB[o${index}]`);
    filters.push(`[${current}][o${index}]overlay=eof_action=pass:repeatlast=0:format=gbrp[c${index}]`);
    current = `c${index}`;
    inputIndex += 1;
  }
  filters.push(`[${current}]format=yuv420p[vout]`);
  args.push("-ss", n(input.audio.start), "-t", n(total), "-i", input.audio.path);
  const graphPath = join(out, "composite.filtergraph");
  await writeFile(graphPath, filters.join(";\n"));
  args.push("-filter_complex_script", graphPath, "-map", "[vout]", "-map", `${inputIndex}:a:0`, "-t", n(total),
    "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
    "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", preview);
  await run(tools.ffmpeg, args);
  tick("compositeMs", started);

  // 6. Sheets: 24 frames (4 × 6) and style-frame comparisons at full size.
  started = performance.now();
  const sheets: string[] = [];
  const times = input.sheetTimes ?? Array.from({ length: 24 }, (_, i) => (i + 0.5) * total / 24);
  const sheetArgs = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y"];
  for (const t of times) sheetArgs.push("-ss", n(t), "-i", preview);
  const portrait = H > W, columns = portrait ? 6 : 4;
  const cellW = portrait ? 270 : 480, cellH = portrait ? 480 : 270;
  const scaled = times.map((_, i) => `[${i}:v]trim=end_frame=1,scale=${cellW}:${cellH},setsar=1[s${i}]`);
  const layout = times.map((_, i) => `${(i % columns) * cellW}_${Math.floor(i / columns) * cellH}`).join("|");
  const sheet = join(out, "sheet-24.jpg");
  sheetArgs.push("-filter_complex", `${scaled.join(";")};${times.map((_, i) => `[s${i}]`).join("")}xstack=inputs=${times.length}:layout=${layout}:fill=black[o]`, "-map", "[o]", "-frames:v", "1", "-q:v", "3", sheet);
  await run(tools.ffmpeg, sheetArgs);
  sheets.push(sheet);
  await writeFile(join(out, "sheet-24.times.json"), JSON.stringify(times.map(t => Number(t.toFixed(3)))));
  for (const item of input.compare ?? []) {
    const file = join(out, `compare-${item.name}.png`);
    await run(tools.ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", item.image, "-ss", n(item.at), "-i", preview,
      "-filter_complex", `[0:v]scale=${W}:${H},setsar=1[a];[1:v]trim=end_frame=1,setsar=1[b];[a][b]hstack=inputs=2[o]`, "-map", "[o]", "-frames:v", "1", file]);
    sheets.push(file);
  }
  tick("sheetsMs", started);
  await writeFile(join(out, "review.json"), JSON.stringify({ preview, sheets, timings, issues: compile.issues, phrases: compile.phrases, hiddenWords: compile.hiddenWords, editorial: compile.editorial }, null, 1));
  return { preview, sheets, compile, timings };
}
