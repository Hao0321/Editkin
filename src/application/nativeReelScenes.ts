import type { EditProject } from "../domain/types";
import type { EditorialPlan } from "./editorialPlan";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { motionPresetSeedSha256 } from "./motionPresetVariant";
import { buildNativeReelSceneCommands, type NativeReelSceneInput } from "./nativeReelSceneCommands";

export type { NativeReelSceneInput } from "./nativeReelSceneCommands";

/** Backend-only evidence binding; execution still requires the existing v4 audit. */
export function prepareNativeReelScene(project: EditProject, input: NativeReelSceneInput, idFactory: (prefix: string) => string) {
  const { bindings, ...scene } = buildNativeReelSceneCommands(project, input, idFactory);
  const editorialGraphics: EditorialPlan["graphics"] = bindings.map(({ graphic, presetId, overrides, offsetFrames }) => ({
    id: graphic.id, presetId,
    range: { startFrame: input.startFrame + offsetFrames, endFrame: input.startFrame + input.durationFrames },
    kind: graphic.vectorV2 ? "native_shape" : graphic.kind === "title" ? "title_card" : "context_card",
    purpose: "context", message: graphic.text, evidenceRefs: [...input.evidenceRefs],
    ...(Object.keys(overrides).length ? { presetVariant: {
      schema: "editkin.motion-preset-variant/v1" as const,
      basePresetSha256: motionPresetSeedSha256(findMotionGraphicPreset(presetId)),
      reason: "已核對 scene 素材與資訊層級的原生版型", overrides,
    } } : {}),
  }));
  return { ...scene, editorialGraphics };
}
