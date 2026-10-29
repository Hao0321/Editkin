import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PNG } from "pngjs";
import { activeMediaLayers } from "../../application/previewMedia";
import { createEmptyProject } from "../../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject } from "../../domain/types";
import { Preview } from "../../ui/Preview";
import { renderComposite } from "../ffmpegComposite";
import { buildRenderPlan } from "../planner";
import { FFMPEG_CRISP_PREVIEW_FILTER_V1 } from "../unsharpPreviewFilterV1";
import { CdpClient } from "./blendParityCssRendererV1";
import { writePngV1 } from "./blendParityHarnessV1";

const run = promisify(execFile);
const APP_ROOT = resolve(fileURLToPath(new URL("../../../", import.meta.url)));

/**
 * scanline_focus preview ↔ export parity (2026-10-23). The export is the reference: its `unsharp` sharpen is what
 * saved projects deliver. Every ffmpeg-crisp preset has the same preview filter and the same export argument
 * (unsharpPreviewFilterV1.test.ts), so this measures all of them. Each frame is one full-canvas image clip; both
 * sides run the real code:
 * - export: renderComposite (FFV1, delivered yuv420p) decoded to RGB, with and without the effect;
 * - preview: the real `Preview` component (server-rendered) drawn by headless Chromium at device scale 1, with the
 *   current filter, with the former `contrast(1.1)` (same markup, that one value swapped) and without the effect;
 *   each capture then goes through the export's own delivery as a plain image clip (like the blend harness's
 *   reference), so both sides share the yuv420p stage and the numbers measure the effect, not chroma subsampling.
 * Differences are full-frame per-channel absolute 8-bit RGB differences. `effectDelta` compares what the effect
 * changes on each side ((export with − without) vs (preview with − without)).
 * `halfSize` (informational): both as the editor shows them at half size (the preview stage at W/2; the export
 * frame drawn by the same browser at W/2, undelivered preview vs delivered export), because the preview sharpens
 * in display pixels.
 */
export interface ParityDiffStatsV1 { max: number; p999: number; p99: number; mean: number }
export interface ScanlineFocusParityFrameV1 {
  frame: string; width: number; height: number;
  /** Current preview vs export, both with scanline_focus (preview through the export's delivery). */
  preview: ParityDiffStatsV1;
  /** Former contrast(1.1) preview vs export. */
  formerPreview: ParityDiffStatsV1;
  /** Without the effect on either side (should be 0: same picture, same delivery). */
  floor: ParityDiffStatsV1;
  /** Current preview capture without the delivery stage vs export (includes yuv420p chroma subsampling). */
  undeliveredPreview: ParityDiffStatsV1;
  effectDelta: ParityDiffStatsV1;
  formerEffectDelta: ParityDiffStatsV1;
  halfSize: { preview: ParityDiffStatsV1; formerPreview: ParityDiffStatsV1; noEffectPreview: ParityDiffStatsV1 };
}
export interface ScanlineFocusParityFrameInputV1 { name: string; path: string; width: number; height: number }

/** Full-frame statistics of |a − b| over R, G, B (a and b are RGB or RGBA, row-major, same size). */
export function parityDiffStatsV1(a: Uint8Array, aChannels: 3 | 4, b: Uint8Array, bChannels: 3 | 4, width: number, height: number): ParityDiffStatsV1 {
  const histogram = new Float64Array(256);
  let sum = 0, count = 0;
  for (let index = 0; index < width * height; index += 1) for (let channel = 0; channel < 3; channel += 1) {
    const difference = Math.abs(a[index * aChannels + channel] - b[index * bChannels + channel]);
    histogram[difference] += 1; sum += difference; count += 1;
  }
  const percentile = (fraction: number) => {
    let seen = 0;
    for (let value = 0; value < 256; value += 1) { seen += histogram[value]; if (seen >= fraction * count) return value; }
    return 255;
  };
  let max = 0;
  for (let value = 255; value >= 0; value -= 1) if (histogram[value]) { max = value; break; }
  return { max, p999: percentile(0.999), p99: percentile(0.99), mean: Number((sum / count).toFixed(3)) };
}

/** Statistics of |(export with − without) − (preview with − without)| (all four delivered RGB). */
function effectDeltaStats(exportWith: Uint8Array, exportWithout: Uint8Array, previewWith: Uint8Array, previewWithout: Uint8Array, width: number, height: number): ParityDiffStatsV1 {
  const residual = new Uint8Array(width * height * 3);
  for (let index = 0; index < width * height; index += 1) for (let channel = 0; channel < 3; channel += 1) {
    const exportChange = exportWith[index * 3 + channel] - exportWithout[index * 3 + channel];
    const previewChange = previewWith[index * 3 + channel] - previewWithout[index * 3 + channel];
    residual[index * 3 + channel] = Math.min(255, Math.abs(exportChange - previewChange));
  }
  return parityDiffStatsV1(residual, 3, new Uint8Array(width * height * 3), 3, width, height);
}

/** Deterministic opaque test pictures: grey steps, 1–2 px lines and glyph-like strokes; saturated colour edges and noise. */
export function scanlineFocusParityImagesV1(): Array<{ name: string; width: number; height: number; data: Uint8Array }> {
  const width = 320, height = 180;
  let seed = 0x2545f491;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  const edges = new Uint8Array(width * height * 4), colour = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    // Rows: grey steps; 1 px light and 2 px dark lines; glyph-like dark strokes on white; 4 px checkerboard; grey ramp.
    let value = Math.round(40 + 170 * x / (width - 1));
    const cell = x % 40;
    if (y < 40) value = [0, 32, 96, 160, 224, 255][Math.floor(x / (width / 6))];
    else if (y < 80) value = x % 16 === 3 ? 250 : x % 16 === 9 || x % 16 === 10 ? 20 : 120;
    else if (y < 120) value = (cell >= 6 && cell <= 9 && y >= 86 && y < 114) || (y >= 98 && y <= 101 && cell >= 6 && cell <= 30) || (cell >= 26 && cell <= 28 && y >= 88 && y < 114) ? 24 : 236;
    else if (y < 150) value = (Math.floor(x / 4) + Math.floor(y / 4)) % 2 ? 200 : 60;
    edges.set([value, value, value, 255], (y * width + x) * 4);
    const bands: Array<[number, number, number]> = [[255, 0, 0], [0, 200, 0], [0, 0, 255], [255, 220, 0], [0, 220, 220], [230, 0, 200], [224, 172, 140], [30, 40, 60]];
    let pixel: [number, number, number];
    if (y < 70) pixel = bands[Math.floor(x / (width / bands.length))];
    else if (y < 120) pixel = x + (y - 70) * 2 < width / 2 ? [200, 40, 40] : [40, 90, 210];
    else pixel = [Math.round(128 + 90 * (random() - 0.5)), Math.round(110 + 70 * (random() - 0.5)), Math.round(90 + 110 * (random() - 0.5))];
    colour.set([...pixel, 255], (y * width + x) * 4);
  }
  return [{ name: "grey-edges-lines-glyphs", width, height, data: edges }, { name: "colour-edges-noise", width, height, data: colour }];
}

/** One decoded frame of a video fixture at `seconds`, resampled to width×height, as a chunk-free PNG. */
export async function extractParityVideoFrameV1(ffmpegPath: string, source: string, seconds: number, width: number, height: number, output: string): Promise<string> {
  const { stdout } = await run(ffmpegPath, ["-v", "error", "-ss", String(seconds), "-i", source, "-frames:v", "1", "-vf", `scale=${width}:${height}:flags=bicubic,format=rgba`,
    "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  if (stdout.length < width * height * 4) throw new Error(`frame of ${source} too short`);
  await writePngV1(output, width, height, stdout.subarray(0, width * height * 4));
  return output;
}

function frameProject(frame: ScanlineFocusParityFrameInputV1, uri: string, effect: boolean): EditProject {
  const project = createEmptyProject("scanline_focus parity", { id: `scanline-parity-${frame.name}`, width: frame.width, height: frame.height, fps: 30 });
  project.assets.push({ id: "frame", name: frame.name, uri, kind: "image", duration: 5, width: frame.width, height: frame.height });
  project.tracks[0].clips.push({ id: "clip", assetId: "frame", trackId: project.tracks[0].id, timelineStart: 0, sourceStart: 0, duration: 0.2, volume: 0,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [], ...(effect ? { creative: { effectPresetIds: ["scanline_focus"] } } : {}) });
  return project;
}

async function exportFrame(options: { ffmpegPath: string; ffprobePath: string }, project: EditProject, output: string): Promise<Uint8Array> {
  await renderComposite(options.ffmpegPath, options.ffprobePath, output, project, buildRenderPlan(project, uri => uri), undefined, "ffv1", 180_000);
  const { stdout } = await run(options.ffmpegPath, ["-v", "error", "-i", output, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
    { encoding: "buffer", maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  if (stdout.length < project.width * project.height * 3) throw new Error("exported frame too short");
  return new Uint8Array(stdout.subarray(0, project.width * project.height * 3));
}

interface BrowserSession { client: CdpClient; sessionId: string; child: ChildProcess; profile: string }

async function startBrowser(browserPath: string, workDirectory: string, timeoutMs: number): Promise<BrowserSession> {
  const profile = join(workDirectory, `chrome-profile-${process.pid}`);
  await mkdir(profile, { recursive: true });
  const child = spawn(browserPath, ["--headless=new", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--force-color-profile=srgb", "--no-first-run",
    "--no-default-browser-check", "--disable-extensions", "--disable-background-networking", "--disable-sync", "--disable-component-update", "--disable-default-apps",
    "--mute-audio", "--hide-scrollbars", "--allow-file-access-from-files", "about:blank"], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  const endpoint = await new Promise<string>((resolveEndpoint, rejectEndpoint) => {
    let text = "";
    const timer = setTimeout(() => rejectEndpoint(new Error("headless browser did not report a DevTools endpoint")), timeoutMs);
    child.stderr!.on("data", chunk => {
      text += String(chunk);
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(text);
      if (match) { clearTimeout(timer); resolveEndpoint(match[1]); }
    });
    child.once("exit", code => { clearTimeout(timer); rejectEndpoint(new Error(`headless browser exited (${code})`)); });
  });
  const client = await CdpClient.connect(endpoint);
  const { targetId } = await client.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await client.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
  await client.send("Page.enable", {}, sessionId);
  return { client, sessionId, child, profile };
}

async function stopBrowser(session: BrowserSession): Promise<void> {
  session.client.close();
  if (session.child.exitCode === null) await new Promise<void>(done => { session.child.once("exit", () => done()); session.child.kill(); setTimeout(done, 5_000); });
  await rm(session.profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
}

/** Loads `html`, waits for images, captures `width`×`height` at the page origin, device scale 1. Returns RGBA. */
async function capture(session: BrowserSession, html: string, page: string, width: number, height: number, timeoutMs: number): Promise<Uint8Array> {
  await session.client.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, session.sessionId);
  await writeFile(page, html, "utf8");
  const loaded = session.client.waitFor("Page.loadEventFired", session.sessionId, timeoutMs);
  await session.client.send("Page.navigate", { url: pathToFileURL(page).href }, session.sessionId);
  await loaded;
  const settled = await session.client.send<{ result: { value?: string } }>("Runtime.evaluate", {
    expression: `(async () => { await Promise.all([...document.images].map(image => image.decode().catch(() => undefined)));
      await new Promise(done => setTimeout(done, 150)); await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
      const blocked = document.querySelector("[role=alert], .empty-preview"); return blocked ? "blocked:" + blocked.textContent : "ok"; })()`,
    awaitPromise: true, returnByValue: true,
  }, session.sessionId);
  if (settled.result.value !== "ok") throw new Error(`preview did not draw: ${settled.result.value}`);
  const shot = await session.client.send<{ data: string }>("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width, height, scale: 1 } }, session.sessionId);
  const png = PNG.sync.read(Buffer.from(shot.data, "base64"));
  if (png.width !== width || png.height !== height) throw new Error(`capture ${png.width}x${png.height}, expected ${width}x${height}`);
  return new Uint8Array(png.data);
}

function previewPage(project: EditProject, stageWidth: number, stageHeight: number, swap?: { from: string; to: string }): string {
  const layers = activeMediaLayers(project, 0, {}, "video");
  let markup = renderToStaticMarkup(createElement(Preview, {
    layers, audioLayers: [], projectWidth: project.width, projectHeight: project.height, playhead: 0, projectDuration: 0.2,
    projectFps: project.fps, captions: [], captionStyle: project.captionStyle, project, playing: false,
    onPlayingChange: () => undefined, onPlayheadChange: () => undefined,
  }));
  if (swap) {
    const occurrences = markup.split(swap.from).length - 1;
    if (occurrences !== 1) throw new Error(`expected the preview filter once in the markup, found ${occurrences}`);
    markup = markup.replace(swap.from, swap.to);
  }
  const css = ["src/styles.css", "src/ui/captionPreview.css"].map(path => `<link rel="stylesheet" href="${pathToFileURL(join(APP_ROOT, path)).href}">`).join("");
  const overrides = `html, body { margin: 0; padding: 0; background: #000; }
    #parity-root .preview-viewport { position: fixed; left: 0; top: 0; width: ${stageWidth}px; height: ${stageHeight}px; }
    #parity-root .preview-stage { border-radius: 0; box-shadow: none; }
    #parity-root .preview-play, #parity-root .playback-controls, #parity-root [data-testid="playback-controls"] { display: none !important; }`;
  return `<!doctype html><html><head><meta charset="utf-8">${css}<style>${overrides}</style></head><body><div id="parity-root">${markup}</div></body></html>`;
}

/** Runs one frame through both routes. `browserPath`: a Chromium-family browser for headless rendering. */
export async function measureScanlineFocusParityFrameV1(frame: ScanlineFocusParityFrameInputV1, options: {
  ffmpegPath: string; ffprobePath: string; browserPath: string; workDirectory: string; timeoutMs?: number;
}): Promise<ScanlineFocusParityFrameV1> {
  const timeoutMs = options.timeoutMs ?? 60_000, directory = join(options.workDirectory, frame.name);
  await mkdir(directory, { recursive: true });
  const { width, height } = frame;
  const exportWith = await exportFrame(options, frameProject(frame, frame.path, true), join(directory, "export-scanline.mkv"));
  const exportWithout = await exportFrame(options, frameProject(frame, frame.path, false), join(directory, "export-none.mkv"));
  const exportPng = join(directory, "export-scanline.png");
  const rgba = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) rgba.set([exportWith[index * 3], exportWith[index * 3 + 1], exportWith[index * 3 + 2], 255], index * 4);
  await writePngV1(exportPng, width, height, rgba);
  const uri = pathToFileURL(frame.path).href;
  const escapedFilter = FFMPEG_CRISP_PREVIEW_FILTER_V1.replaceAll("\"", "&quot;");
  const swap = { from: escapedFilter, to: "contrast(1.1)" };
  const session = await startBrowser(options.browserPath, directory, timeoutMs);
  let shots: Record<"with" | "former" | "without" | "exportHalf" | "halfWith" | "halfFormer" | "halfWithout", Uint8Array>;
  const halfWidth = Math.round(width / 2), halfHeight = Math.round(height / 2);
  try {
    const shot = (html: string, name: string, w = width, h = height) => capture(session, html, join(directory, `${name}.html`), w, h, timeoutMs);
    const withEffect = frameProject(frame, uri, true), withoutEffect = frameProject(frame, uri, false);
    const exportHalfHtml = `<!doctype html><html><body style="margin:0;background:#000"><img src="${pathToFileURL(exportPng).href}" style="display:block;width:${halfWidth}px;height:${halfHeight}px"></body></html>`;
    shots = {
      with: await shot(previewPage(withEffect, width, height), "preview-scanline"),
      former: await shot(previewPage(withEffect, width, height, swap), "preview-former"),
      without: await shot(previewPage(withoutEffect, width, height), "preview-none"),
      exportHalf: await shot(exportHalfHtml, "export-half", halfWidth, halfHeight),
      halfWith: await shot(previewPage(withEffect, halfWidth, halfHeight), "half-preview-scanline", halfWidth, halfHeight),
      halfFormer: await shot(previewPage(withEffect, halfWidth, halfHeight, swap), "half-preview-former", halfWidth, halfHeight),
      halfWithout: await shot(previewPage(withoutEffect, halfWidth, halfHeight), "half-preview-none", halfWidth, halfHeight),
    };
  } finally {
    await stopBrowser(session);
  }
  // Each preview picture goes through the export's own delivery (an effect-free image clip, yuv420p), so the
  // comparison measures the effect, not the delivery's chroma subsampling.
  const deliver = async (rgba: Uint8Array, name: string) => {
    const path = join(directory, `${name}.png`);
    await writePngV1(path, width, height, rgba);
    return exportFrame(options, frameProject({ ...frame, name }, path, false), join(directory, `${name}.mkv`));
  };
  const previewWith = await deliver(shots.with, "delivered-preview-scanline");
  const previewFormer = await deliver(shots.former, "delivered-preview-former");
  const previewWithout = await deliver(shots.without, "delivered-preview-none");
  return {
    frame: frame.name, width, height,
    preview: parityDiffStatsV1(previewWith, 3, exportWith, 3, width, height),
    formerPreview: parityDiffStatsV1(previewFormer, 3, exportWith, 3, width, height),
    floor: parityDiffStatsV1(previewWithout, 3, exportWithout, 3, width, height),
    undeliveredPreview: parityDiffStatsV1(shots.with, 4, exportWith, 3, width, height),
    effectDelta: effectDeltaStats(exportWith, exportWithout, previewWith, previewWithout, width, height),
    formerEffectDelta: effectDeltaStats(exportWith, exportWithout, previewFormer, previewWithout, width, height),
    halfSize: {
      preview: parityDiffStatsV1(shots.halfWith, 4, shots.exportHalf, 4, halfWidth, halfHeight),
      formerPreview: parityDiffStatsV1(shots.halfFormer, 4, shots.exportHalf, 4, halfWidth, halfHeight),
      noEffectPreview: parityDiffStatsV1(shots.halfWithout, 4, shots.exportHalf, 4, halfWidth, halfHeight),
    },
  };
}
