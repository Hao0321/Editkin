import { createEmptyProject } from "../../domain/editGraph";
import { createPhoneProjectV1 } from "../../application/phoneProjectV1";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type ColorAdjustments, type EditProject, type LayerBlendMode, type TimelineClip, type TrackMatteMode } from "../../domain/types";
import { BLEND_MODES_V1 } from "../blendKernelV1";

/**
 * Parity harness fixtures v1 (P4). One small synthetic fixture set shared by every renderer: the export
 * (renderComposite + FFmpeg), the native image preview shader, the CSS compatible preview and the CPU reference.
 *
 * Canvas 64×48 at 30 fps; images are 8×8 patches (8 columns × 6 rows) sampled at patch centres, so chroma
 * subsampling and resampling never mix two patches. Images are exactly canvas-sized (no scaling).
 */
export const PARITY_CANVAS_V1 = Object.freeze({ width: 64, height: 48, patch: 8, columns: 8, rows: 6, fps: 30, duration: 0.2 });

export type ParityRgbaV1 = readonly [number, number, number, number];
export interface ParityImageV1 { name: ParityImageNameV1; width: number; height: number; /** straight RGBA, 8 bit */ data: Uint8Array }
export type ParityImageNameV1 = "backdrop" | "source" | "target" | "matte";
export type ParityColourV1 = "rec709" | "aces2-phone";

const grey = (value: number, alpha = 255): ParityRgbaV1 => [value, value, value, alpha];
const rgb = (r: number, g: number, b: number, alpha = 255): ParityRgbaV1 => [r, g, b, alpha];

/** Rows 4–5 of backdrop and blend layer hold the grey pairs of the 2026-10-22 audit table (§1.3) and the extremes. */
const AUDIT_BACKDROP: readonly (readonly ParityRgbaV1[])[] = [[153, 204, 102, 102, 77, 64, 191, 51].map(v => grey(v)), [153, 153, 153, 102, 0, 255, 128, 26].map(v => grey(v))];
const AUDIT_SOURCE: readonly (readonly ParityRgbaV1[])[] = [[51, 51, 153, 77, 204, 191, 64, 128].map(v => grey(v)), [204, 255, 0, 255, 0, 255, 128, 230].map(v => grey(v))];

/** Opaque backdrop: greys and extremes, saturated primaries, mid colours, a per-pixel colour gradient, audit pairs. */
const BACKDROP_ROWS: readonly (readonly ParityRgbaV1[] | undefined)[] = [
  [grey(0), grey(255), grey(51), grey(102), grey(128), grey(153), grey(204), grey(230)],
  [rgb(255, 0, 0), rgb(0, 255, 0), rgb(0, 0, 255), rgb(255, 255, 0), rgb(0, 255, 255), rgb(255, 0, 255), rgb(192, 128, 96), rgb(30, 90, 200)],
  [rgb(204, 51, 51), rgb(51, 204, 102), rgb(64, 64, 191), rgb(240, 220, 40), rgb(128, 0, 128), rgb(90, 200, 180), rgb(250, 128, 114), rgb(47, 79, 79)],
  undefined, ...AUDIT_BACKDROP,
];
/**
 * Blend layer (straight alpha): greys against the backdrop greys (including the 0/1 singularities of dodge and burn),
 * saturated colours (including a black "light leak" over skin tone), the same colours at α 128, and an α ramp
 * of the warm leak colour (feathered edge).
 */
const SOURCE_ROWS: readonly (readonly ParityRgbaV1[] | undefined)[] = [
  [grey(255), grey(0), grey(51), grey(153), grey(204), grey(64), grey(128), grey(191)],
  [rgb(0, 0, 255), rgb(255, 0, 0), rgb(0, 255, 0), rgb(255, 106, 26), grey(128), grey(255), grey(0), rgb(240, 220, 40)],
  [rgb(51, 204, 102, 128), rgb(204, 51, 51, 128), rgb(255, 106, 26, 128), rgb(30, 90, 200, 128), grey(255, 128), grey(0, 128), rgb(255, 255, 0, 128), rgb(192, 128, 96, 128)],
  [0, 36, 73, 109, 146, 182, 219, 255].map(alpha => rgb(255, 106, 26, alpha)),
  ...AUDIT_SOURCE,
];
/** Opaque matte target. */
const TARGET_ROWS: readonly (readonly ParityRgbaV1[] | undefined)[] = [
  [grey(250), rgb(255, 0, 0), rgb(0, 128, 255), rgb(255, 200, 0), grey(250), rgb(0, 200, 120), rgb(255, 106, 26), grey(250)],
];
/** Matte source (straight alpha): colours for luma, an α ramp of white, half-transparent colours, and a grey gradient. */
const MATTE_ROWS: readonly (readonly ParityRgbaV1[] | undefined)[] = [
  [grey(255), grey(0), rgb(255, 0, 0), rgb(0, 255, 0), rgb(0, 0, 255), grey(128), grey(64), grey(192)],
  [0, 36, 73, 109, 146, 182, 219, 255].map(alpha => grey(255, alpha)),
  [rgb(255, 0, 0, 128), rgb(0, 255, 0, 128), rgb(0, 0, 255, 128), grey(255, 128), rgb(255, 106, 26), rgb(192, 128, 96), rgb(30, 90, 200), rgb(240, 220, 40)],
];

function patchImage(name: ParityImageNameV1, rows: readonly (readonly ParityRgbaV1[] | undefined)[], gradient: (x: number) => ParityRgbaV1): ParityImageV1 {
  const { width, height, patch } = PARITY_CANVAS_V1;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const row = Math.floor(y / patch), column = Math.floor(x / patch);
    const colour = rows[row]?.[column] ?? gradient(x);
    data.set(colour, (y * width + x) * 4);
  }
  return { name, width, height, data };
}

/** The four fixture images; any row a table does not define is a per-pixel gradient. */
export function parityImagesV1(): Record<ParityImageNameV1, ParityImageV1> {
  const ramp = (x: number) => Math.round(x * 255 / (PARITY_CANVAS_V1.width - 1));
  return {
    backdrop: patchImage("backdrop", BACKDROP_ROWS, x => rgb(ramp(x), 128, 255 - ramp(x))),
    source: patchImage("source", SOURCE_ROWS, () => grey(0, 0)),
    target: patchImage("target", TARGET_ROWS, x => rgb(250, ramp(x), 60)),
    matte: patchImage("matte", MATTE_ROWS, x => grey(ramp(x))),
  };
}

/** Patch-centre sample points (row-major), each with its patch label. */
export function paritySamplePointsV1(): Array<{ x: number; y: number; label: string }> {
  const { columns, rows, patch } = PARITY_CANVAS_V1;
  const points: Array<{ x: number; y: number; label: string }> = [];
  for (let row = 0; row < rows; row += 1) for (let column = 0; column < columns; column += 1) {
    points.push({ x: column * patch + patch / 2, y: row * patch + patch / 2, label: `r${row}c${column}` });
  }
  return points;
}

export type ParityFixtureV1 =
  | { id: string; kind: "blend"; mode: LayerBlendMode; opacity: number; bottom: boolean; colour: ParityColourV1 }
  | { id: string; kind: "matte"; matte: TrackMatteMode; sourceHidden: boolean; colour: ParityColourV1 }
  | { id: string; kind: "adjustment"; color: Partial<ColorAdjustments>; gated: boolean; colour: ParityColourV1 };

function fixtures(): ParityFixtureV1[] {
  const list: ParityFixtureV1[] = [];
  for (const colour of ["rec709", "aces2-phone"] as const) for (const mode of BLEND_MODES_V1) for (const opacity of [1, 0.5]) {
    list.push({ id: `${colour}/blend/${mode}/op${opacity}`, kind: "blend", mode, opacity, bottom: false, colour });
  }
  for (const mode of ["multiply", "screen", "difference", "overlay"] as const) {
    list.push({ id: `rec709/bottom/${mode}`, kind: "blend", mode, opacity: 1, bottom: true, colour: "rec709" });
  }
  for (const matte of ["alpha", "alpha_inverted", "luma", "luma_inverted"] as const) for (const sourceHidden of [false, true]) {
    list.push({ id: `rec709/matte/${matte}/${sourceHidden ? "source-hidden" : "source-visible"}`, kind: "matte", matte, sourceHidden, colour: "rec709" });
  }
  list.push({ id: "rec709/adjustment/identity", kind: "adjustment", color: {}, gated: true, colour: "rec709" });
  list.push({ id: "rec709/adjustment/brightness", kind: "adjustment", color: { brightness: 0.1 }, gated: false, colour: "rec709" });
  list.push({ id: "rec709/adjustment/saturation-contrast", kind: "adjustment", color: { saturation: 0.5, contrast: 1.2 }, gated: false, colour: "rec709" });
  return list;
}

export const PARITY_FIXTURES_V1: readonly ParityFixtureV1[] = Object.freeze(fixtures());

function clip(id: string, assetId: string, trackId: string, extra: Partial<TimelineClip> = {}): TimelineClip {
  return { id, assetId, trackId, timelineStart: 0, sourceStart: 0, duration: PARITY_CANVAS_V1.duration, volume: 0,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [], ...extra };
}

function track(project: EditProject, id: string, clips: TimelineClip[], hidden = false): void {
  project.tracks.push({ id, name: id, kind: "video", locked: false, muted: false, ...(hidden ? { hidden: true } : {}), clips });
}

/** The fixture as an Editkin project. `uri` maps an image to the URI each renderer reads (a path or a file URL). */
export function parityFixtureProjectV1(fixture: ParityFixtureV1, uri: (image: ParityImageNameV1) => string): EditProject {
  const { width, height, fps } = PARITY_CANVAS_V1;
  const options = { id: `parity-${fixture.id.replaceAll("/", "-").replaceAll(".", "_")}`, width, height, fps };
  const project = fixture.colour === "aces2-phone" ? createPhoneProjectV1("Parity fixture", options) : createEmptyProject("Parity fixture", options);
  if (fixture.colour === "aces2-phone") project.colorManagement = { ...project.colorManagement!, mode: "aces2", outputTransform: "rec709_sdr" };
  const asset = (name: ParityImageNameV1) => ({ id: name, name, uri: uri(name), kind: "image" as const, duration: 5, width, height });
  if (fixture.kind === "blend") {
    project.assets.push(asset("backdrop"), asset("source"));
    const layer = { enabled: true, blendMode: fixture.mode, role: "content" as const };
    const transform = { ...DEFAULT_TRANSFORM, opacity: fixture.opacity };
    if (fixture.bottom) project.tracks[0].clips.push(clip("layer", "source", project.tracks[0].id, { transform, layer }));
    else {
      project.tracks[0].clips.push(clip("base", "backdrop", project.tracks[0].id));
      track(project, "blend", [clip("layer", "source", "blend", { transform, layer })]);
    }
  } else if (fixture.kind === "matte") {
    project.assets.push(asset("backdrop"), asset("target"), asset("matte"));
    project.tracks[0].clips.push(clip("base", "backdrop", project.tracks[0].id));
    track(project, "target", [clip("target", "target", "target", { layer: { enabled: true, blendMode: "normal", role: "content", trackMatte: { sourceClipId: "matte", mode: fixture.matte } } })]);
    track(project, "matte", [clip("matte", "matte", "matte")], fixture.sourceHidden);
  } else {
    project.assets.push(asset("backdrop"), asset("source"));
    project.tracks[0].clips.push(clip("base", "backdrop", project.tracks[0].id));
    track(project, "over", [clip("layer", "source", "over")]);
    track(project, "adjust", [clip("adjust", "backdrop", "adjust", { color: { ...DEFAULT_COLOR, ...fixture.color }, layer: { enabled: true, blendMode: "normal", role: "adjustment" } })]);
  }
  return project;
}
