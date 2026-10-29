import type { EditProject, MediaAsset, TimelineClip } from "../domain/types";
import { compileClipAlphaPlan, ffmpegRationalRate, rationalRate, pixelMatteOperation } from "../domain/clipAlphaPlan";
import { compositorVideoFilters } from "./ffmpegComposite";
import { compositeFrameClock } from "./compositeFrameClock";
import { aces16AlphaPlaneJoinV1 } from "./aces16AlphaPlanesV1";
import type { MediaProbe } from "./ffmpegContracts";
import type { RenderPlan } from "./planner";
import { buildSubjectStickerFiltersV1, type SubjectStickerStyleV1 } from "./subjectStickerV1";
import { buildSubjectSheenFiltersV1, type SubjectSheenStyleV1 } from "./subjectSheenV1";

export type SubjectOverlayEffectV1 = { kind: "sticker"; style: SubjectStickerStyleV1 }
  | { kind: "sheen"; style: SubjectSheenStyleV1; range: { startFrame: number; endFrame: number } };
export interface SubjectOverlaySourceStageV1 {
  project: EditProject; clip: TimelineClip; asset: MediaAsset; plan: RenderPlan; frames: number; clipStartFrame: number;
}
/** Render data only. The Node caller verifies the original source and native plane physically.
 * Existing compositor/kernel sources remain the sole owners of their pixel semantics. */
export function buildSubjectOverlayGraphV1(stage: SubjectOverlaySourceStageV1, probe: MediaProbe,
  native: { width: number; height: number; fps: number; frameCount: number; bits: 8 | 16 }, effect: SubjectOverlayEffectV1,
  legacyMatteInputIndex?: number) {
  const { project, clip, asset, plan, frames } = stage, width = plan.width, height = plan.height, pose = clip.transform;
  if (![width, height].every(n => Number.isSafeInteger(n) && n >= 16 && n <= 8192) || width * height > 2073600
    || !Number.isSafeInteger(frames) || frames < 1 || frames > 28800 || pose.opacity !== 1 || pose.x !== 0 || pose.y !== 0 || pose.scale !== 1 || pose.rotation !== 0 || pose.flipX || pose.flipY
    || clip.layout || clip.gradeV2 || clip.creative || clip.keyframes.length) throw Error("SUBJECT_OVERLAY_PRIVATE_STAGE_OR_RASTER_BUDGET");
  if (![native.width, native.height].every(n => Number.isSafeInteger(n) && n >= 16) || native.width * native.height > 2073600
    || !Number.isFinite(native.fps) || native.fps < 1 || native.fps > 60 || !Number.isSafeInteger(native.frameCount) || native.frameCount < 1 || native.frameCount > 1440
    || ![8, 16].includes(native.bits)) throw Error("SUBJECT_OVERLAY_NATIVE_PLANE_CONTRACT");
  const alphaPlan = compileClipAlphaPlan(project, clip, "formal"), legacy = pixelMatteOperation(alphaPlan);
  if (legacy && legacyMatteInputIndex === undefined || legacyMatteInputIndex !== undefined && (!Number.isSafeInteger(legacyMatteInputIndex) || legacyMatteInputIndex < 2 || legacyMatteInputIndex > 16)) throw Error("SUBJECT_OVERLAY_LEGACY_MATTE_INPUT_REQUIRED");
  const source = compositorVideoFilters({ clip, alphaPlan, asset, assetPath: asset.uri, inputIndex: 0, probe,
    ...(legacy ? { matteInputIndex: legacyMatteInputIndex } : {}) }, "ovBase", plan, project, undefined, true);
  // Preserve the original owner's mask math, order and timing. Its legacy SDR
  // alphamerge negotiates gray8 even when the expressions use65535, erasing masks.
  // Bind only this private bake's two join edges to the existing16-bit plane owner.
  const colorEdge = "[ovBasesourcecolor]format=gbrp16le[ovBasesourcergb]";
  const alphaEdge = "[ovBasesourcergb][ovBasecombinedalpha]alphamerge[ovBasemerged]";
  if (alphaPlan.operations.length && (source.filter(f => f === colorEdge).length !== 1 || source.filter(f => f === alphaEdge).length !== 1)) throw Error("SUBJECT_OVERLAY_SOURCE_JOIN_OWNER_CHANGED");
  const bakeSource = source.map(f => f === colorEdge ? "[ovBasesourcecolor]format=gbrap16le[ovBasesourcergb]"
    : f === alphaEdge ? aces16AlphaPlaneJoinV1("ovBasesourcergb", "ovBasecombinedalpha", "ovBasemerged") : f);
  const clock = compositeFrameClock(plan.fps).timestampFilters;
  const filters = [...bakeSource,
    `[ovBase]format=gbrap16le,${clock},split=2[ovRgbAlpha][ovAlpha]`,
    `[ovRgbAlpha]format=gbrp16le[ovRgb]`, `[ovAlpha]alphaextract,format=gray16le[ovAuthoredAlpha]`,
    `[1:v]fps=${ffmpegRationalRate(rationalRate(plan.fps))}:round=up:start_time=0:eof_action=pass,trim=end_frame=${frames},${clock},split=2[ovNativeHash][ovNativeFit]`,
    `[ovNativeFit]scale=${width}:${height}:force_original_aspect_ratio=decrease,format=gray16le,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[ovNativeCanvas]`,
    `[ovAuthoredAlpha][ovNativeCanvas]blend=all_expr='A*B/65535':shortest=1[ovEffectiveAlpha]`,
  ];
  let pixelFormat: "bgra" | "gbrap16le", activeFrames: number;
  if (effect.kind === "sticker") {
    filters.push("[ovRgb]format=rgb24[ovStickerRgb]", "[ovEffectiveAlpha]format=gray[ovStickerAlpha]");
    filters.push(...buildSubjectStickerFiltersV1({ sourceRgbLabel: "ovStickerRgb", effectiveAlphaLabel: "ovStickerAlpha", outputLabel: "ovEffect",
      width, height, frameOffset: 0, style: effect.style }).filters); pixelFormat = "bgra"; activeFrames = frames;
  } else {
    const first = effect.range.startFrame - stage.clipStartFrame, last = effect.range.endFrame - stage.clipStartFrame, count = last - first;
    if (![first, last].every(Number.isSafeInteger) || first < 0 || last > frames || count < 3 || count > 240) throw Error("SUBJECT_OVERLAY_SHEEN_INTERVAL");
    filters.push("[ovRgb]nullsink", `[ovEffectiveAlpha]trim=start_frame=${first}:end_frame=${last},${clock}[ovSheenAlpha]`);
    filters.push(...buildSubjectSheenFiltersV1({ alphaLabel: "ovSheenAlpha", outputLabel: "ovSweep", width, height, totalFrames: count, frameOffset: 0, style: effect.style }).filters);
    filters.push(`[ovSweep]tpad=start=${first}:stop=${frames - last}:start_mode=add:stop_mode=add:color=white@0,trim=end_frame=${frames},${clock}[ovEffect]`);
    pixelFormat = "gbrap16le"; activeFrames = count;
  }
  filters.push(`[ovEffect]format=${pixelFormat},setparams=range=full:color_primaries=bt709:color_trc=bt709:colorspace=0[ovOutput]`);
  if (filters.join(";").length > 1048576) throw Error("SUBJECT_OVERLAY_GRAPH_TEXT_BUDGET");
  return { schema: "editkin.subject-overlay-graph/v1" as const, filters, outputLabel: "ovOutput", nativeHashLabel: "ovNativeHash",
    pixelFormat, width, height, frames, activeFrames, originalCompositorFilters: source, bakeCompositorFilters: bakeSource, existingAuthoredAlphaPlan: alphaPlan,
    pixelContract: "opaque-original source alpha/keyer/full authored mask stack, then confirmed v2 alpha exactly once" as const,
    appearanceContract: "original colour/grade/layout/effects/pose retained on ordinary derivative, not baked or doubled" as const,
    qualityState: "ART_PENDING_CLAUDE" as const, defaultEnabled: false as const };
}
