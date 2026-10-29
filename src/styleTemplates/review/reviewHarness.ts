import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { resolveColorGradeV2 } from "../../color/gradeV2";
import { gradeV2LutFilters, gradeV2SpatialChains } from "../../color/gradeV2Ffmpeg";
import { bakeResolvedGradeLut, ffmpegRenderCubeText } from "../../color/gradeLutBake";
import { resolveMotionLibraryTools } from "../../motionLibrary/render/renderItem";
import { compileStylePlanV1, type StyleCompileProject, type StyleCompileResultV1, type StyleFootageClip } from "../compiler";
import { styleLookFor, styleLookGrade } from "../components/finish";
import { greyBackgroundSampler, type GreyFrames } from "../backgroundSampler";
import { renderStyleJob, type StyleJobRenderResult } from "../render/renderStyleJob";
import type { StylePlanV1, StyleTemplateV1 } from "../types";

/**
 * Review harness (brief §8): real footage + a style plan → an MP4 preview and
 * contact sheets, for Claude's art review only. NOT the product path: the product
 * applies the compiled commands and pending clips in Editkin and renders there.
 *
 * Mirrors the product stages so the preview reads like the export:
 * - footage: each shot is fitted to the frame, graded with the template look (the
 *   same baked grade LUT and spatial finishing chains Editkin's FFmpeg export uses)
 *   and given the compiled punch-in keyframes (linear, as the editor interpolates);
 * - finish track: opaque light-leak clips composited with screen;
 * - titles and captions: the rendered ProRes 4444 job clips, overlaid at their frames.
 */

export interface ReviewShot {
  readonly id: string;
  readonly source: string;
  /** Source in-point and duration (s). */
  readonly in: number;
  readonly duration: number;
  /** Portrait sources cropped for 16:9: the normalized vertical centre of the band (default 0.5). */
  readonly landscapeCenterY?: number;
  readonly genre?: string;
  /**
   * How the source fills the frame. "cover" (default) fills it (portrait sources are cropped to a band for 16:9).
   * "card": a landscape source (a screen recording) in a portrait frame, scaled to the frame width at cardCenterY over
   * a blurred, darkened, enlarged copy of itself; in Editkin that is the UI clip over a copy with studio_backdrop_soft.
   */
  readonly fit?: "cover" | "card";
  readonly cardCenterY?: number;
}

export interface ReviewInput {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly shots: readonly ReviewShot[];
  readonly audio: { readonly path: string; readonly start: number };
  readonly template: StyleTemplateV1;
  readonly plan: StylePlanV1;
  /** Big outputs (base edit, job clips, preview): keep off the nearly full D: drive. */
  readonly outDir: string;
  readonly cacheRoot: string;
  readonly tempRoot: string;
  readonly jobConcurrency?: number;
}

export interface ReviewResult {
  readonly preview: string;
  readonly sheets: readonly string[];
  readonly compile: StyleCompileResultV1;
  readonly renders: readonly StyleJobRenderResult[];
  readonly timings: Record<string, number>;
}

function run(executable: string, args: string[], timeoutMs = 1_800_000): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    execFile(executable, args, { encoding: "buffer", maxBuffer: 512 * 1024 * 1024, timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${executable.split(/[\\/]/).pop()} failed: ${error.message}\n${stderr.toString().slice(-4000)}`));
      else resolvePromise({ stdout, stderr: stderr.toString() });
    });
  });
}

const filterPath = (path: string) => path.replaceAll("\\", "/").replace(":", "\\:").replaceAll("'", "\\'");
const n = (value: number) => Number(value.toFixed(6)).toString();

/** Piecewise-linear FFmpeg expression of the punch-in scale/offset keys over the segment-local frame index `on`. */
function piecewise(keys: ReadonlyArray<{ time: number; value: number }>, fps: number, variable: string): string {
  if (!keys.length) return "1";
  let expr = n(keys[keys.length - 1].value);
  for (let index = keys.length - 1; index >= 1; index -= 1) {
    const a = keys[index - 1], b = keys[index];
    const fa = a.time * fps, fb = b.time * fps;
    const segment = fb > fa ? `${n(a.value)}+(${n(b.value - a.value)})*(${variable}-${n(fa)})/${n(fb - fa)}` : n(b.value);
    expr = `if(lt(${variable},${n(fb)}),${segment},${expr})`;
  }
  return `if(lt(${variable},${n(keys[0].time * fps)}),${n(keys[0].value)},${expr})`;
}

export async function runStyleReview(input: ReviewInput): Promise<ReviewResult> {
  const timings: Record<string, number> = {};
  const tick = (label: string, started: number) => { timings[label] = Math.round(performance.now() - started); };
  const tools = await resolveMotionLibraryTools();
  const out = resolve(input.outDir, input.name);
  await mkdir(out, { recursive: true });
  const { width: W, height: H, fps } = input;
  const portrait = H > W;

  // 1. Footage clips on the timeline.
  let cursor = 0;
  const footage: StyleFootageClip[] = input.shots.map(shot => {
    const clip = { clipId: shot.id, timelineStart: cursor, duration: shot.duration, ...(shot.genre ? { genre: shot.genre } : {}) };
    cursor += shot.duration;
    return clip;
  });
  const totalDuration = cursor;

  // 2. Compile once without luminance to know the punch-ins, build the base, sample it, compile again with readability.
  const project0: StyleCompileProject = { width: W, height: H, fps, footage };
  const first = compileStylePlanV1(input.template, input.plan, project0);
  let started = performance.now();
  const base = await buildBase(input, tools.ffmpeg, out, footage, first);
  tick("baseMs", started);
  started = performance.now();
  const grey = await extractGreyFrames(tools.ffmpeg, base, W, H);
  await writeFile(join(out, "background.grey"), grey.data);
  await writeFile(join(out, "background.json"), JSON.stringify({ rate: grey.rate, columns: grey.columns, rows: grey.rows, width: W, height: H }));
  tick("sampleMs", started);
  const compile = compileStylePlanV1(input.template, input.plan, { ...project0, sampleBackground: greyBackgroundSampler(grey) });
  await writeFile(join(out, "compile.json"), JSON.stringify({ ...compile, jobs: compile.jobs.map(job => ({ ...job, params: job.params })) }, null, 1));

  // 3. Render every job clip (cached by key).
  started = performance.now();
  const concurrency = Math.max(1, input.jobConcurrency ?? 3);
  const renders: StyleJobRenderResult[] = new Array(compile.jobs.length);
  let nextJob = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (nextJob < compile.jobs.length) {
      const index = nextJob++;
      renders[index] = await renderStyleJob(compile.jobs[index], { cacheRoot: input.cacheRoot, tempRoot: input.tempRoot, schedule: task => task() });
    }
  }));
  tick("jobsMs", started);

  // 4. Composite: footage → screen(light leaks) → titles → captions; VO audio.
  started = performance.now();
  const preview = join(out, `${input.name}.mp4`);
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", base];
  const filters: string[] = [`[0:v]format=gbrp[v0]`];
  let current = "v0", inputIndex = 1;
  const leaks = compile.jobs.map((job, index) => ({ job, render: renders[index] })).filter(entry => entry.job.output === "opaque");
  const overlays = compile.jobs.map((job, index) => ({ job, render: renders[index] })).filter(entry => entry.job.output === "alpha")
    .sort((a, b) => (a.job.track === b.job.track ? a.job.startFrame - b.job.startFrame : a.job.track === "titles" ? -1 : 1));
  if (leaks.length) {
    filters.push(`color=c=black:s=${W}x${H}:r=${fps}:d=${n(totalDuration)},format=gbrp[k0]`);
    let leakCurrent = "k0";
    for (const [index, { job, render }] of leaks.entries()) {
      args.push("-i", render.path);
      filters.push(`[${inputIndex}:v]format=gbrp,setpts=PTS-STARTPTS+${n(job.startFrame / fps)}/TB[lk${index}]`);
      filters.push(`[${leakCurrent}][lk${index}]overlay=eof_action=pass:repeatlast=0:format=gbrp[k${index + 1}]`);
      leakCurrent = `k${index + 1}`;
      inputIndex += 1;
    }
    filters.push(`[${current}][${leakCurrent}]blend=all_mode=screen[lit]`);
    current = "lit";
  }
  for (const [index, { job, render }] of overlays.entries()) {
    args.push("-i", render.path);
    filters.push(`[${inputIndex}:v]setpts=PTS-STARTPTS+${n(job.startFrame / fps)}/TB[ov${index}]`);
    filters.push(`[${current}][ov${index}]overlay=eof_action=pass:repeatlast=0:format=gbrp[c${index}]`);
    current = `c${index}`;
    inputIndex += 1;
  }
  filters.push(`[${current}]format=yuv420p[vout]`);
  args.push("-ss", n(input.audio.start), "-t", n(totalDuration), "-i", input.audio.path);
  const graphPath = join(out, "composite.filtergraph");
  await writeFile(graphPath, filters.join(";\n"));
  args.push("-filter_complex_script", graphPath, "-map", "[vout]", "-map", `${inputIndex}:a:0`, "-t", n(totalDuration),
    "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
    "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", preview);
  await run(tools.ffmpeg, args);
  tick("compositeMs", started);

  // 5. Contact sheets.
  started = performance.now();
  const sheets = await contactSheets(tools.ffmpeg, preview, out, input, compile);
  tick("sheetsMs", started);
  await writeFile(join(out, "review.json"), JSON.stringify({ preview, sheets, timings, issues: compile.issues, look: compile.look, captionReadability: compile.captionReadability,
    renders: renders.map(render => ({ jobId: render.jobId, cacheHit: render.cacheHit, frames: render.frameCount, timings: render.timings })) }, null, 1));
  return { preview, sheets, compile, renders, timings };

  // -------------------------------------------------------------------------

  async function buildBase(review: ReviewInput, ffmpeg: string, dir: string, clips: readonly StyleFootageClip[], compiled: StyleCompileResultV1): Promise<string> {
    const segments: string[] = [];
    const lutDir = join(dir, "luts");
    await mkdir(lutDir, { recursive: true });
    for (const [index, shot] of review.shots.entries()) {
      const clip = clips[index];
      const choice = shot.genre ? styleLookFor(review.template, shot.genre) : styleLookFor(review.template, review.plan.genre);
      const resolved = resolveColorGradeV2(choice ? styleLookGrade(choice) : { schema: "editkin.color-grade/v2" }, "rec709_display");
      const lutPath = join(lutDir, choice ? `${choice.filmLookId}-${choice.strength}.cube` : "identity.cube");
      await writeFile(lutPath, ffmpegRenderCubeText(bakeResolvedGradeLut(resolved), `style review ${choice?.filmLookId ?? "ungraded"}`, false));
      const lut = choice ? `,${gradeV2LutFilters(lutPath, false).join(",")}` : "";
      const keys = compiled.punchIns.find(entry => entry.clipId === clip.clipId)?.keys;
      const chains: string[] = [];
      if (shot.fit === "card") {
        const cardY = Math.round((shot.cardCenterY ?? 0.5) * H);
        chains.push(`[0:v]fps=${fps},split=2[bgsrc][fgsrc]`,
          `[bgsrc]scale=${W}:${H}:force_original_aspect_ratio=increase:flags=bicubic,crop=${W}:${H},gblur=sigma=30:steps=3,colorchannelmixer=rr=0.68:gg=0.68:bb=0.68,setsar=1[bg]`,
          `[fgsrc]scale=${W}:-2:flags=lanczos,setsar=1[fg]`,
          `[bg][fg]overlay=x=0:y=${cardY}-h/2${lut}[g]`);
      } else {
        const fit = portrait
          ? `scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H},setsar=1`
          : `crop=iw:trunc(iw*${H}/${W}/2)*2:0:trunc((ih-iw*${H}/${W})*${n(shot.landscapeCenterY ?? 0.5)}/2)*2,scale=${W}:${H}:flags=lanczos,setsar=1`;
        chains.push(`[0:v]${fit},fps=${fps}${lut}[g]`);
      }
      let label = "g";
      if (resolved.finishing) {
        chains.push(...gradeV2SpatialChains("g", "f", resolved.finishing, { space: "rec709_display", canvasHeight: H, labelPrefix: "fin" }));
        label = "f";
      }
      if (keys?.length) {
        // Scale about the frame centre then translate, exactly as the editor's clip transform: zoompan crop of size W/s.
        const scale = piecewise(keys.map(key => ({ time: key.time, value: key.pose.scale })), fps, "in");
        const dx = piecewise(keys.map(key => ({ time: key.time, value: key.pose.x })), fps, "in");
        const dy = piecewise(keys.map(key => ({ time: key.time, value: key.pose.y })), fps, "in");
        // Visible window top-left in source px: (W - W/s)/2 - dx/s.
        chains.push(`[${label}]format=yuv420p,zoompan=z='${scale}':x='(iw-iw/zoom)/2-(${dx})/zoom':y='(ih-ih/zoom)/2-(${dy})/zoom':d=1:s=${W}x${H}:fps=${fps}[p]`);
        label = "p";
      }
      // Backdrop beats (R1): the same gblur + dim as Editkin's studio_backdrop_soft export filter, only inside the range.
      const ranges = compiled.backdrops.map(range => [range.from - clip.timelineStart, range.to - clip.timelineStart])
        .filter(([a, b]) => b > 0 && a < shot.duration);
      if (ranges.length) {
        const enable = ranges.map(([a, b]) => `between(t,${n(Math.max(0, a))},${n(b - 1 / fps / 2)})`).join("+");
        chains.push(`[${label}]format=gbrp,gblur=sigma=30:steps=3:enable='${enable}',colorchannelmixer=rr=0.68:gg=0.68:bb=0.68:enable='${enable}'[bd]`);
        label = "bd";
      }
      chains.push(`[${label}]format=yuv420p[out]`);
      const segment = join(dir, `seg-${String(index).padStart(2, "0")}.mp4`);
      segments.push(segment);
      // Re-runs reuse a segment whose exact inputs (shot, frame, look LUT, finishing, punch keys) are unchanged.
      const segmentKey = JSON.stringify({ shot, W, H, fps, look: choice, finishing: resolved.finishing ?? null, keys: keys ?? null, chains });
      const previousKey = await readFile(`${segment}.key`, "utf8").catch(() => "");
      if (previousKey === segmentKey && await stat(segment).then(() => true, () => false)) continue;
      await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-ss", n(shot.in), "-t", n(shot.duration), "-i", shot.source,
        "-filter_complex", chains.join(";"), "-map", "[out]", "-frames:v", String(Math.round(shot.duration * fps)), "-an",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "12", "-pix_fmt", "yuv420p", segment]);
      await writeFile(`${segment}.key`, segmentKey);
    }
    const list = join(dir, "segments.txt");
    await writeFile(list, segments.map(path => `file '${path.replaceAll("\\", "/")}'`).join("\n"));
    const basePath = join(dir, "base.mp4");
    await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", basePath]);
    return basePath;
  }
}

/** A 4 fps low-res grey copy of the graded base (the real pixels under the text) for the background sampler. */
export async function extractGreyFrames(ffmpeg: string, base: string, width: number, height: number): Promise<GreyFrames> {
  const columns = width >= height ? 96 : 54, rows = width >= height ? 54 : 96, rate = 4;
  const { stdout } = await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", base, "-vf", `fps=${rate},scale=${columns}:${rows}:flags=area,format=gray`,
    "-f", "rawvideo", "-"]);
  return { rate, columns, rows, width, height, data: new Uint8Array(stdout.buffer, stdout.byteOffset, stdout.byteLength) };
}

/** Contact sheets: keyword holds, staggered entries (frame by frame) and a placement debug sheet with subject/text boxes. */
async function contactSheets(ffmpeg: string, preview: string, dir: string, input: ReviewInput, compile: StyleCompileResultV1): Promise<string[]> {
  const { width: W, height: H, fps } = input;
  const portrait = H > W;
  const cellW = portrait ? 270 : 480, cellH = portrait ? 480 : 270;
  const captions = compile.jobs.filter(job => job.component === "caption");
  const others = compile.jobs.filter(job => job.component !== "caption");
  const holdTimes: number[] = [];
  for (const job of captions) {
    if (job.params.component !== "caption") continue;
    const keyword = job.params.words.find(word => word.role === "keyword");
    const lastWord = job.params.words[job.params.words.length - 1];
    const t = job.timelineStart + Math.min(job.params.exit.at - 0.05, Math.max(keyword ? keyword.t0 + 0.45 : 0, lastWord.t0 + 0.3));
    holdTimes.push(t);
  }
  for (const job of others) holdTimes.push(job.timelineStart + (job.component === "lightLeak" ? job.frameCount / fps * 0.42 : Math.min(0.9, job.frameCount / fps * 0.5)));
  holdTimes.sort((a, b) => a - b);
  // Entry strips: the first caption with a keyword, frame by frame around the keyword's arrival, plus a section entry.
  const entryTimes: number[] = [];
  const withKeyword = captions.filter(job => job.params.component === "caption" && job.params.words.some(word => word.role === "keyword"));
  for (const job of withKeyword.slice(0, 2)) {
    if (job.params.component !== "caption") continue;
    const keyword = job.params.words.find(word => word.role === "keyword")!;
    const start = job.timelineStart + job.params.words[0].t0;
    entryTimes.push(start, start + 2 / fps, start + 4 / fps);
    const k = job.timelineStart + keyword.t0;
    for (const frames of [0, 1, 2, 3, 5]) entryTimes.push(k + frames / fps);
  }
  const section = others.find(job => job.component === "section");
  if (section) for (const frames of [1, 4, 8, 14]) entryTimes.push(section.timelineStart + frames / fps);
  const sheets: string[] = [];
  const build = async (name: string, times: number[], debug: boolean) => {
    const columns = 4, rows = Math.ceil(times.length / columns);
    if (!times.length) return;
    const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y"];
    for (const t of times) args.push("-ss", n(Math.max(0, t)), "-i", preview);
    const scaled = times.map((t, index) => {
      let chain = `[${index}:v]trim=end_frame=1`;
      if (debug) {
        for (const subject of input.plan.subjects ?? []) {
          if (subject.from <= t && subject.to > t) chain += `,drawbox=x=${Math.round(subject.box[0] * W)}:y=${Math.round(subject.box[1] * H)}:w=${Math.round((subject.box[2] - subject.box[0]) * W)}:h=${Math.round((subject.box[3] - subject.box[1]) * H)}:color=red@0.9:t=6`;
        }
      }
      return `${chain},scale=${cellW}:${cellH},setsar=1[c${index}]`;
    });
    const inputsList = times.map((_, index) => `[c${index}]`).join("");
    const layout = times.map((_, index) => `${(index % columns) * cellW}_${Math.floor(index / columns) * cellH}`).join("|");
    const path = join(dir, `${name}.jpg`);
    args.push("-filter_complex", `${scaled.join(";")};${inputsList}xstack=inputs=${times.length}:layout=${layout}:fill=black[o]`, "-map", "[o]", "-frames:v", "1", "-q:v", "3", path);
    await run(ffmpeg, args);
    sheets.push(path);
    await writeFile(join(dir, `${name}.times.json`), JSON.stringify({ columns, rows, times: times.map(t => Number(t.toFixed(3))) }));
  };
  await build("sheet-holds", holdTimes.slice(0, 24), false);
  await build("sheet-entries", entryTimes.slice(0, 24), false);
  await build("sheet-placement", holdTimes.slice(0, 16), true);
  return sheets;
}

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}
