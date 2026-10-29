import type { ColorManagementSettings, EditProject, TimelineClip } from "../domain/types";
import { compositePixelContract, type CompositePixelContract } from "./highBitDepthAlphaDelivery";
import { compositeFrameClock } from "./compositeFrameClock";
import { aces16AlphaOverGraphV1 } from "./aces16AlphaCompositeV1";
import { blendKernelColourGraphV1, isBlendModeV1 } from "./blendKernelV1";
import { animatedGeometryCanvas } from "./animatedGeometryCanvas";
import { composedTransformExpressions, escapeExpression, finite } from "./ffmpegExpressions";
import { transitionScaleExpression, transitionXExpression } from "./creativeFilters";

/** Old saved ACES recipes are deliberately independent of the new working precision. */
export function usesOpaqueAces16V1(management?: ColorManagementSettings): boolean {
  return management?.mode === "aces2" && management.rec709DisplayPolicy === "phone-bt1886";
}

/** Working precision and transparent delivery are separate contracts. */
export function acesCompositeWorkingPixelsV1(management: ColorManagementSettings | undefined, preserveAlpha: boolean): CompositePixelContract {
  return {
    ...compositePixelContract(preserveAlpha || usesOpaqueAces16V1(management)),
    encodedPixelFormat: compositePixelContract(preserveAlpha).encodedPixelFormat,
  };
}

interface PlanePlan { width: number; height: number; fps: number; duration: number }

function label(value: string): string {
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(value)) throw Error("Invalid internal ACES plane label");
  return value;
}

function count(plan: PlanePlan): number {
  const frames = Math.ceil(plan.duration * plan.fps);
  if (![plan.width, plan.height].every(v => Number.isSafeInteger(v) && v > 0)
    || !Number.isSafeInteger(frames) || frames < 1) throw Error("Invalid ACES plane dimensions or clock");
  return frames;
}

/** Dimensions of the existing fitted/layout/affine layer, before its placement. */
export function aces16LayerExtentV1(project: EditProject, clip: TimelineClip, plan: PlanePlan, trackMatteSource = false): { width: string; height: string } {
  const fixed = trackMatteSource ? undefined : animatedGeometryCanvas(project, clip, plan.width, plan.height);
  if (fixed) return { width: String(fixed.width), height: String(fixed.height) };
  const composed = composedTransformExpressions(project, clip, "T", plan.fps);
  const localTime = clip.timelineStart === 0 ? "T" : `(T-${finite(clip.timelineStart)})`;
  const transitionScale = trackMatteSource ? "1" : transitionScaleExpression(clip, localTime);
  const scale = trackMatteSource ? composed.scale : `((${composed.scale})*(${transitionScale}))`;
  const baseWidth = !trackMatteSource && !clip.floatingFrame && clip.layout ? Math.max(2, Math.round(plan.width * clip.layout.viewport.width)) : plan.width;
  const baseHeight = !trackMatteSource && !clip.floatingFrame && clip.layout ? Math.max(2, Math.round(plan.height * clip.layout.viewport.height)) : plan.height;
  const spatialMatte = clip.keyframes.length > 0 || Object.keys(clip.expressions ?? {}).length > 0
    || clip.transform.scale !== 1 || clip.transform.rotation !== 0 || Boolean(clip.layer?.parentClipId);
  const scaled = trackMatteSource ? spatialMatte : composed.scale !== "1" || transitionScale !== "1";
  const width = scaled ? `max(1,trunc(${baseWidth}*(${scale})))` : String(baseWidth);
  const height = scaled ? `max(1,trunc(${baseHeight}*(${scale})))` : String(baseHeight);
  const rotated = trackMatteSource ? spatialMatte : composed.rotation !== "0";
  if (!rotated) return { width, height };
  if (/\b(?:T|N|t|n)\b/.test(composed.rotation)) {
    const diagonal = `ceil(hypot(${width},${height})/2)*2`;
    return { width: diagonal, height: diagonal };
  }
  const radians = `((${composed.rotation})*PI/180)`;
  return {
    width: `ceil((abs(${width}*cos(${radians}))+abs(${height}*sin(${radians})))/2)*2`,
    height: `ceil((abs(${width}*sin(${radians}))+abs(${height}*cos(${radians})))/2)*2`,
  };
}

/** Straight-alpha layer on the complete project canvas and exact project clock. */
export function aces16PositionedLayerGraphV1(input: string, output: string, clip: TimelineClip, plan: PlanePlan, project: EditProject, trackMatteSource = false, sourceTimelineStart = clip.timelineStart): string[] {
  label(input); label(output);
  const frames = count(plan), clock = compositeFrameClock(plan.fps), start = compositeFrameClock(plan.fps, sourceTimelineStart).startFrame;
  const prefix = `${output}aces16`, padded = `${prefix}padded`, xmap = `${prefix}x`, ymap = `${prefix}y`;
  const extent = aces16LayerExtentV1(project, clip, plan, trackMatteSource);
  const composed = composedTransformExpressions(project, clip, "T", plan.fps);
  const localTime = clip.timelineStart === 0 ? "T" : `(T-${finite(clip.timelineStart)})`;
  const transitionX = transitionXExpression(clip, plan.width, localTime);
  const centerX = clip.layout ? finite(plan.width * (clip.layout.viewport.x + clip.layout.viewport.width / 2)) : "W/2";
  const centerY = clip.layout ? finite(plan.height * (clip.layout.viewport.y + clip.layout.viewport.height / 2)) : "H/2";
  const x = `trunc((${centerX})-(${extent.width})/2+(${composed.x})+(${transitionX}))`;
  const y = `trunc((${centerY})-(${extent.height})/2+(${composed.y}))`;
  const maps = [[xmap, `X-(${x})`], [ymap, `Y-(${y})`]].map(([name, coordinate]) => {
    // 65535 is outside every supported source raster; remap fills it with transparent black.
    const expression = `if(between((${coordinate}),0,65534),(${coordinate}),65535)`;
    const cache = /\b(?:T|N|t|n)\b/.test(coordinate) ? "" : ",trim=end_frame=1,loop=loop=-1:size=1:start=0";
    return `color=c=black:s=${plan.width}x${plan.height}:r=${clock.rate}:d=${finite(plan.duration)},format=gray16le,geq=lum='${escapeExpression(expression)}'${cache},${clock.timestampFilters},trim=end_frame=${frames}[${name}]`;
  });
  return [
    // Do not synthesize source positions: keep the already sampled source frames,
    // add transparent project ticks before/after them, then align maps to those ticks.
    `[${input}]format=gbrap16le,${clock.timestampFilters},tpad=start=${start}:stop=-1:start_mode=add:stop_mode=add:color=black@0,trim=end_frame=${frames},${clock.timestampFilters}[${padded}]`,
    ...maps,
    `[${padded}][${xmap}][${ymap}]remap=fill=black@0,format=gbrap16le[${output}]`,
  ];
}

/** Alpha weighted normal blend over an opaque working canvas, without overlay's 10-bit ceiling. */
export function aces16OverOpaqueGraphV1(base: string, foreground: string, output: string): string[] {
  label(base); label(foreground); label(output);
  const rgb = `${output}aces16rgb`, alpha = `${output}aces16alpha`, mask = `${output}aces16mask`;
  return [
    `[${foreground}]split[${rgb}][${alpha}]`,
    `[${alpha}]geq=r='alpha(X,Y)':g='alpha(X,Y)':b='alpha(X,Y)':a=65535:interpolation=nearest[${mask}]`,
    `[${base}][${rgb}][${mask}]maskedmerge=planes=7,format=gbrap16le[${output}]`,
  ];
}

export function aces16OverlayGraphV1(base: string, input: string, output: string, clip: TimelineClip, plan: PlanePlan, project: EditProject, trackMatteSource = false, preserveAlpha = false): string[] {
  const positioned = `${output}aces16placed`;
  return [...aces16PositionedLayerGraphV1(input, positioned, clip, plan, project, trackMatteSource), ...(preserveAlpha ? aces16AlphaOverGraphV1(base, positioned, output) : aces16OverOpaqueGraphV1(base, positioned, output))];
}

/**
 * Colour blending does not change an opaque composite's alpha. Thin wrapper over the blend kernel's 16-bit colour
 * stage (W3C operand order and soft light). The export no longer blends ACEScct codes with it: ACES 2 layers blend in
 * scene-linear (blendKernelSceneLinearV1).
 */
export function aces16BlendFilterV1(base: string, layer: string, output: string, mode: string): string {
  label(base); label(layer); label(output);
  if (!isBlendModeV1(mode) || mode === "normal") throw Error("Invalid internal ACES blend mode");
  return blendKernelColourGraphV1(base, layer, output, mode, 16).join(";");
}
