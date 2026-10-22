/**
 * Motion Library contact sheets for art review (Claude certifies items from these).
 *
 * Each sheet is built from a REAL render: the item is rendered through
 * renderMotionLibraryItem (SVG frames → bundled FFmpeg/librsvg → ProRes), the
 * cached clip is decoded and 12 frames spread across the duration are tiled
 * 4×3 and labelled with frame index and time.
 *   text        → rendered with the item's showcase plate (params.plate = showcasePlate, ART_DIRECTION §9),
 *                 composited over the palette background (only visible if the plate were "none")
 *   transition  → out = mix(A, B, matte) ⊕ overlay over the ART_DIRECTION §6 demo planes:
 *                 A = paper with an ink 「A」, B = accent with a paper 「B」; frames on the transition clock
 *   background  → the opaque clip itself
 *
 * Usage (from the app root):
 *   vendor/node/win32-x64/node.exe node_modules/tsx/dist/cli.mjs scripts/motion-library-contact-sheet.ts --out <folder>
 *     [--ids T01,X01,B01]            default: every implemented item
 *     [--formats portrait,landscape] default: both
 *     [--portrait 540x960] [--landscape 960x540] [--fps 30]
 *     [--cache <folder>]             default: <out>/.cache (removed afterwards unless --keep-cache)
 *     [--keep-cache]                 clips are keyed by item id + revision + params/size/fps/fonts/engine
 *                                    version, NOT by source code: with a kept cache, a code change that
 *                                    did not bump the item's revision reuses a stale clip (a warning is printed)
 *     [--window 0.95-1.6]            sample the 12 frames from this time window (item clock, s) instead of the whole clip
 *     [--suffix burst]               output name suffix for a window sheet (default w<start>-<end>)
 * Output: <out>/<id>_<format>.png (or <id>_<format>_<suffix>.png with --window) plus one JSON summary line per sheet on stdout.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { runConversionProcess } from "../src/application/mediaConversion";
import { getMotionLibraryItem, listImplemented } from "../src/motionLibrary/catalog";
import { itemFrameTime, motionFrameRate } from "../src/motionLibrary/frames";
import { renderMotionLibraryItem, resolveMotionLibraryTools } from "../src/motionLibrary/render/renderItem";
import { createSvgDocument, path, rect, roundRect, transform, tf } from "../src/motionLibrary/svg/document";
import { layoutLine } from "../src/motionLibrary/svg/glyphs";
import type { MotionFrameSize, MotionLibraryItem } from "../src/motionLibrary/types";

const COLUMNS = 4, ROWS = 3, CELLS = COLUMNS * ROWS;
const MARGIN = 24, PADDING = 12, HEADER = 96;
const SHEET_BACKGROUND = "#1A1A1F";

function parseSize(value: string, label: string): MotionFrameSize {
  const match = /^(\d+)x(\d+)$/.exec(value);
  if (!match) throw new Error(`--${label} must look like 540x960`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

/** 12 frame indices spread across the candidates (default: the whole clip), first and last included. */
function sampleIndices(frameCount: number, candidates?: readonly number[]): number[] {
  const pool = candidates ?? Array.from({ length: frameCount }, (_, index) => index);
  if (pool.length <= CELLS) return [...pool];
  return Array.from({ length: CELLS }, (_, index) => pool[Math.round((index * (pool.length - 1)) / (CELLS - 1))]);
}

function parseWindow(value: string | undefined): { start: number; end: number } | undefined {
  if (value === undefined) return undefined;
  const match = /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/.exec(value);
  if (!match || !(Number(match[2]) > Number(match[1]))) throw new Error("--window must look like 0.95-1.6 (start < end, seconds)");
  return { start: Number(match[1]), end: Number(match[2]) };
}

function cellOrigin(index: number, size: MotionFrameSize): { x: number; y: number } {
  const column = index % COLUMNS, row = Math.floor(index / COLUMNS);
  return { x: MARGIN + column * (size.width + PADDING), y: HEADER + MARGIN + row * (size.height + PADDING) };
}

function sheetSize(size: MotionFrameSize): MotionFrameSize {
  return { width: 2 * MARGIN + COLUMNS * size.width + (COLUMNS - 1) * PADDING, height: HEADER + 2 * MARGIN + ROWS * size.height + (ROWS - 1) * PADDING };
}

/** Labels drawn with the library's own glyph outlines (no <text>). */
function labelSvg(item: MotionLibraryItem, size: MotionFrameSize, fpsText: string, frames: number, indices: number[], timeOf: (index: number) => number,
  format: string, cacheHit: boolean, plate: string | undefined, revision: number): string {
  const sheet = sheetSize(size);
  const doc = createSvgDocument(sheet);
  const parts: string[] = [];
  const title = layoutLine(`${item.id}  ${item.names.en} / ${item.names.zh}`, { font: "display", weight: 700, size: 34 });
  parts.push(path(title.pathD, { fill: "#F3EFE6", transform: tf.translate(MARGIN, 46) }));
  const kindLabel = item.kind === "text" ? `text, showcase plate ${plate}` : item.kind === "transition" ? "A→B: mix(A,B,matte)+overlay" : "background clip";
  const meta = layoutLine(`${format} ${size.width}x${size.height} · ${fpsText} fps · ${frames} frames · ${kindLabel} · real render${cacheHit ? " (cached)" : ""} · r${revision} · art ${item.artStatus}`,
    { font: "mono", size: 20 });
  parts.push(path(meta.pathD, { fill: "#A9B0BC", transform: tf.translate(MARGIN, 80) }));
  indices.forEach((frame, cell) => {
    const origin = cellOrigin(cell, size), t = timeOf(frame);
    const progress = item.kind === "transition" && frames > 1 ? ` · ${Math.round((frame / (frames - 1)) * 100)}%` : "";
    const text = layoutLine(`f${frame} · ${t.toFixed(2)}s${progress}`, { font: "mono", size: Math.max(14, Math.round(size.width / 30)) });
    const pad = 8, width = text.width + pad * 2, height = text.size * 1.5;
    parts.push(roundRect(origin.x + 8, origin.y + 8, width, height, height / 2, { fill: "#000000", "fill-opacity": 0.62 }));
    parts.push(path(text.pathD, { fill: "#FFFFFF", transform: tf.translate(origin.x + 8 + pad, origin.y + 8 + height * 0.7) }));
  });
  return doc.render(parts);
}

/** A flat demo plane with a large outlined letter. */
function demoPlaneSvg(size: MotionFrameSize, fill: string, letter: string, letterFill: string): string {
  const doc = createSvgDocument(size, { background: fill });
  const glyphSize = Math.min(size.width, size.height) * 0.5;
  const line = layoutLine(letter, { font: "latin", size: glyphSize });
  const ink = line.inkBox ?? { x0: 0, y0: -glyphSize, x1: line.width, y1: 0 };
  const x = size.width / 2 - (ink.x0 + ink.x1) / 2, y = size.height / 2 - (ink.y0 + ink.y1) / 2;
  return doc.render(path(line.pathD, { fill: letterFill, transform: transform(tf.translate(x, y)) }),
    rect(0, 0, size.width, size.height, { fill: "none", stroke: letterFill, "stroke-opacity": 0.25, "stroke-width": 4 }));
}

async function main() {
  const { values } = parseArgs({ options: {
    out: { type: "string" }, ids: { type: "string" }, formats: { type: "string" }, portrait: { type: "string" }, landscape: { type: "string" },
    fps: { type: "string" }, cache: { type: "string" }, "keep-cache": { type: "boolean" }, window: { type: "string" }, suffix: { type: "string" },
  } });
  if (!values.out) throw new Error("--out <folder> is required");
  const window = parseWindow(values.window);
  if (values.suffix !== undefined && !/^[A-Za-z0-9._-]{1,40}$/.test(values.suffix)) throw new Error("--suffix may use letters, digits, . _ - only");
  const suffix = window ? `_${values.suffix ?? `w${window.start}-${window.end}`}` : "";
  const out = resolve(values.out);
  const sizes: Record<string, MotionFrameSize> = {
    portrait: parseSize(values.portrait ?? "540x960", "portrait"),
    landscape: parseSize(values.landscape ?? "960x540", "landscape"),
  };
  const formats = (values.formats ?? "portrait,landscape").split(",").map(value => value.trim()).filter(Boolean);
  for (const format of formats) if (!sizes[format]) throw new Error(`Unknown format ${format} (portrait|landscape)`);
  const fps = motionFrameRate(Number(values.fps ?? 30));
  const items = values.ids ? values.ids.split(",").map(id => getMotionLibraryItem(id.trim())) : [...listImplemented()];
  const cacheRoot = resolve(values.cache ?? join(out, ".cache"));
  const persistentCache = values.cache !== undefined || Boolean(values["keep-cache"]);
  if (persistentCache) {
    console.error(`warning: reusing the clip cache ${cacheRoot}. Clips are keyed by item id + revision (+ params, size, fps, fonts, engine version), `
      + "not by source code: if an item's code changed without bumping its revision, its sheet shows a stale clip. Bump the revision or delete the cache.");
  }
  await mkdir(out, { recursive: true });
  const work = await mkdtemp(join(tmpdir(), "editkin-motionlib-sheet-"));
  const tools = await resolveMotionLibraryTools();
  try {
    for (const item of items) {
      if (!item.implemented) { console.error(`skip ${item.id}: not implemented yet`); continue; }
      for (const format of formats) {
        const size = sizes[format], started = performance.now();
        // Text items render with their showcase plate (ART_DIRECTION §9): the real plate path, not a composite.
        const plate = item.kind === "text" ? item.showcasePlate : undefined;
        const render = await renderMotionLibraryItem({ item, size, fps, cacheRoot, ...(plate ? { params: { plate } } : {}) });
        if (persistentCache && render.cacheHit) {
          console.error(`warning: ${item.id} r${render.itemRevision} ${format}: clip reused from the cache; it is stale if ${item.id}'s code changed without a revision bump`);
        }
        const timeOf = (index: number) => itemFrameTime(item.kind, index, render.frameCount, fps, render.params.durationSeconds);
        const inWindow = window ? Array.from({ length: render.frameCount }, (_, index) => index)
          .filter(index => timeOf(index) >= window.start - 1e-9 && timeOf(index) <= window.end + 1e-9) : undefined;
        if (inWindow && !inWindow.length) throw new Error(`--window ${values.window} holds no frame of ${item.id} (${render.params.durationSeconds} s)`);
        const indices = sampleIndices(render.frameCount, inWindow);
        const select = `select='${indices.map(index => `eq(n,${index})`).join("+")}',setpts=N/(FRAME_RATE*TB)`;
        const tile = `tile=${COLUMNS}x${ROWS}:margin=${MARGIN}:padding=${PADDING}:color=${SHEET_BACKGROUND}`;
        const sheet = sheetSize(size);
        const labels = join(work, `${item.id}_${format}_labels.svg`);
        await writeFile(labels, labelSvg(item, size, fps.text, render.frameCount, indices, timeOf, format, render.cacheHit, plate, render.itemRevision));
        const output = join(out, `${item.id}_${format}${suffix}.png`);
        const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y"];
        let graph: string, labelInput: number;
        if (item.kind === "text") {
          args.push("-i", render.outputs.clip!.path);
          labelInput = 1;
          graph = `color=c=${render.params.palette.bg}:s=${size.width}x${size.height}:r=${fps.text}[bg];[bg][0:v]overlay=shortest=1:format=auto[comp]`;
        } else if (item.kind === "transition") {
          const a = join(work, `${item.id}_${format}_A.svg`), b = join(work, `${item.id}_${format}_B.svg`);
          // ART_DIRECTION §6 demo convention: A = paper with an ink 「A」, B = accent with a paper 「B」.
          const palette = render.params.palette;
          await writeFile(a, demoPlaneSvg(size, palette.paper, "A", palette.ink));
          await writeFile(b, demoPlaneSvg(size, palette.accent, "B", palette.paper));
          args.push("-i", render.outputs.matte!.path, "-loop", "1", "-framerate", fps.text, "-i", a, "-loop", "1", "-framerate", fps.text, "-i", b);
          const overlay = render.outputs.overlay;
          if (overlay) args.push("-i", overlay.path);
          labelInput = overlay ? 4 : 3;
          graph = `[0:v]alphaextract[ma];[2:v]format=rgba[bp];[bp][ma]alphamerge[bm];[1:v][bm]overlay=shortest=1:format=auto${overlay ? "[ab];[ab][3:v]overlay=shortest=1:format=auto" : ""}[comp]`;
        } else {
          args.push("-i", render.outputs.clip!.path);
          labelInput = 1;
          graph = "[0:v]null[comp]";
        }
        args.push("-i", labels);
        graph += `;[comp]${select},${tile},pad=iw:ih+${HEADER}:0:${HEADER}:color=${SHEET_BACKGROUND}[grid]`
          + `;[${labelInput}:v]setparams=alpha_mode=premultiplied,format=gbrap,unpremultiply=inplace=1[labels]`
          + `;[grid][labels]overlay=format=auto,format=rgb24[sheet]`;
        args.push("-filter_complex", graph, "-map", "[sheet]", "-frames:v", "1", "-fps_mode", "passthrough", "-update", "1", output);
        await runConversionProcess(tools.ffmpeg, args, undefined, 300_000);
        console.log(JSON.stringify({ item: item.id, revision: render.itemRevision, format, size: `${size.width}x${size.height}`, sheet: `${sheet.width}x${sheet.height}`,
          output, frames: render.frameCount, cacheHit: render.cacheHit, timings: render.timings, sheetMs: Math.round(performance.now() - started) }));
      }
    }
  } finally {
    await rm(work, { recursive: true, force: true });
    if (!values["keep-cache"] && !values.cache) await rm(cacheRoot, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
