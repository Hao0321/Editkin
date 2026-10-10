import * as z from "zod/v4";
import type { EditProject, MotionGraphic, MotionVectorV2 } from "../domain/types";
import type { EditorCommand } from "../domain/commands";
import { applyCommand } from "../domain/commands";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { createMotionGraphic } from "../motion/composition";
import { motionGraphicV2LayoutReceipt } from "../motion/compositionV2";
import { assertContinuityVectorFrameRange } from "../domain/motionContinuityContract";
import type { SpringGeometryTrack } from "../motion/springGeometryTrack";
import type { SpringTargetTrack } from "../motion/springTargetTrack";
import { canonicalJson } from "../shared/canonicalJson";
import { motionPresetOverridesSchema, type MotionPresetVariant } from "../domain/schema";
import type { EditorialPlan } from "./editorialPlan";

const properties = ["left", "top", "right", "bottom", "cornerRadius"] as const;
const dynamicsSchema = z.strictObject({ stiffness: z.number().finite().min(1).max(1000),
  damping: z.number().finite().min(0).max(100), mass: z.number().finite().min(.05).max(10) });
const value = z.number().finite().min(0).max(4096);

/** The caller authors local pixel targets and supplies their actual visual purpose. */
export const nativeGeometryMotionSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(), graphicId: z.string().trim().min(1).max(80).optional(),
  range: z.strictObject({ startFrame: z.number().int().nonnegative(), endFrame: z.number().int().positive() }),
  position: z.strictObject({ x: z.number().finite().min(0).max(1), y: z.number().finite().min(0).max(1) }),
  fixedEnvelope: z.strictObject({ width: z.number().finite().min(16).max(4096), height: z.number().finite().min(1).max(4096) }),
  initial: z.strictObject({ left: value, top: value, right: value, bottom: value, cornerRadius: value }),
  dynamics: dynamicsSchema,
  propertyDynamics: z.strictObject({ left: dynamicsSchema.optional(), top: dynamicsSchema.optional(),
    right: dynamicsSchema.optional(), bottom: dynamicsSchema.optional(), cornerRadius: dynamicsSchema.optional() }).optional(),
  targets: z.array(z.strictObject({ property: z.enum(properties), frame: z.number().int().nonnegative(), target: value })).max(32),
  purpose: z.string().trim().min(1).max(500),
  evidenceRefs: z.array(z.string().trim().min(1).max(160)).min(1).max(8),
  fillColor: z.string().regex(/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i).optional(),
});
export type NativeGeometryMotionInput = z.infer<typeof nativeGeometryMotionSchema>;

async function sha(value: unknown): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("此環境沒有 Web Crypto SHA-256，無法建立幾何識別");
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function geometryFor(input: NativeGeometryMotionInput, id: string, fps: number): SpringGeometryTrack {
  const tracks = Object.fromEntries(properties.map(property => {
    const track: SpringTargetTrack = { fps, initialPosition: input.initial[property], initialTarget: input.initial[property],
      initialVelocity: 0, spring: structuredClone(input.propertyDynamics?.[property] ?? input.dynamics),
      // Preserve authored order so duplicate or descending frames fail closed.
      events: input.targets.filter(event => event.property === property).map(({ frame, target }) => ({ frame, target })) };
    return [property, track];
  })) as Pick<SpringGeometryTrack, typeof properties[number]>;
  return { localId: id, envelope: { x: 0, y: 0, ...input.fixedEnvelope }, ...tracks };
}

/**
 * Read-only preparation; persistence remains in the current v4 audit/apply lane.
 * New authoring follows the registered variant width floor: max(16px, 1% canvas).
 * Existing saved geometry retains its independent 16px envelope floor.
 */
export async function prepareNativeGeometryMotion(project: EditProject, raw: NativeGeometryMotionInput,
  idFactory: () => string = () => {
    if (!globalThis.crypto?.randomUUID) throw new Error("此環境沒有安全的 graphic ID 產生器，請提供 idFactory");
    return globalThis.crypto.randomUUID();
  }) {
  const input = nativeGeometryMotionSchema.parse(raw);
  if (project.revision !== input.expectedRevision) throw new Error("連續輪廓的專案版本過期，請重新讀取目前專案");
  const projectRevision = project.revision;
  const durationFrames = input.range.endFrame - input.range.startFrame;
  if (durationFrames < 2 || durationFrames > 1800) throw new Error("連續輪廓範圍必須為 2 至 1800 影格");
  if (input.targets.some(event => event.frame >= durationFrames)) throw new Error("目標事件必須位於圖形的本地有效影格內");
  const existing = input.graphicId ? project.motionGraphics.find(graphic => graphic.id === input.graphicId) : undefined;
  if (input.graphicId && (!existing || existing.schema !== "hao.motion-composition/v2"
    || existing.vectorV2?.kind !== "spring_panel" || existing.compositeLayer === "background")) {
    throw new Error("修訂對象必須是目前專案的前景連續輪廓面板");
  }
  if (!existing && input.fixedEnvelope.width / project.width < .01) throw new Error("建立輪廓的寬度須至少 16px 且達畫布 1%，以符合既有 preset variant 規則");
  const preset = existing ? undefined : findMotionGraphicPreset("reel_native_panel");
  const id = existing?.id ?? idFactory();
  if (!id?.trim() || id.length > 80 || (!existing && project.motionGraphics.some(graphic => graphic.id === id))) {
    throw new Error("連續輪廓需要唯一且有效的 graphic id");
  }
  if (existing?.vectorV2?.kind === "spring_panel") {
    const start = Math.round(existing.timelineStart * project.fps), end = start + Math.round(existing.duration * project.fps);
    if (input.range.startFrame !== start || input.range.endFrame !== end
      || input.position.x !== existing.x || input.position.y !== existing.y
      || input.fixedEnvelope.width !== existing.vectorV2.geometry.envelope.width
      || input.fixedEnvelope.height !== existing.vectorV2.geometry.envelope.height) {
      throw new Error("幾何修訂必須保留既有範圍、位置與固定 envelope");
    }
    if (input.fillColor !== undefined && input.fillColor !== existing.backgroundColor) throw new Error("幾何修訂不可混入填色變更");
  }
  const geometry = geometryFor(input, id, project.fps);
  const vector: MotionVectorV2 = { schema: "editkin.motion-vector-continuity/v1", kind: "spring_panel",
    heightPixels: input.fixedEnvelope.height, revealFrames: 1, geometry };
  const passivePhase = { durationFrames: 1, offsetXPixels: 0, offsetYPixels: 0, scale: 1, opacity: 1, easing: { type: "linear" as const } };
  const graphic: MotionGraphic = existing ? { ...structuredClone(existing), vectorV2: vector }
    : createMotionGraphic(id, "card", "", input.range.startFrame / project.fps, durationFrames / project.fps, undefined,
      { ...preset!.seed, name: "連續輪廓面板", x: input.position.x, y: input.position.y,
        width: input.fixedEnvelope.width / project.width, vectorV2: vector, compositeLayer: "foreground",
        backgroundColor: input.fillColor ?? "#175CD3", textColor: "#FFFFFF", accentColor: "#FFFFFF", outlineWidth: 0,
        motionV2: { sequence: { unit: "all", order: "forward", exitOrder: "forward", staggerFrames: 0 },
          entrance: { ...passivePhase }, exit: { ...passivePhase } } });
  assertContinuityVectorFrameRange(graphic, project.fps);
  const before = existing?.vectorV2 ? structuredClone(existing.vectorV2) : null;
  if (before && canonicalJson(before) === canonicalJson(vector)) throw new Error("幾何修訂沒有任何變更");
  const command: EditorCommand = existing ? { type: "update_motion_graphic", graphicId: id, patch: { vectorV2: vector } }
    : { type: "add_motion_graphic", graphic };
  const applied = applyCommand(project, command);
  const afterGraphic = applied.motionGraphics.find(item => item.id === id)!;
  const receipt = motionGraphicV2LayoutReceipt(applied, afterGraphic);
  const stock = preset ? createMotionGraphic(id, preset.seed.kind ?? "card", "", graphic.timelineStart, graphic.duration, undefined, preset.seed) : undefined;
  const actualFields = graphic as unknown as Record<string, unknown>, stockFields = stock as unknown as Record<string, unknown> | undefined;
  const overrides = stockFields ? motionPresetOverridesSchema.parse(Object.fromEntries(Object.keys(motionPresetOverridesSchema.shape)
    .filter(key => canonicalJson(actualFields[key]) !== canonicalJson(stockFields[key]))
    .map(key => [key, structuredClone(actualFields[key])]))) : undefined;
  const [beforeVectorSha256, afterVectorSha256, basePresetSha256] = await Promise.all([before ? sha(before) : null, sha(vector),
    preset ? sha({ id: preset.id, renderer: preset.renderer, seed: preset.seed }) : null]);
  const presetVariant: MotionPresetVariant | undefined = preset && overrides ? { schema: "editkin.motion-preset-variant/v1",
    basePresetSha256: basePresetSha256!, reason: "原創連續輪廓：保留同一物件身份與固定畫布，依宣告用途配置邊緣目標及彈簧", overrides } : undefined;
  const editorialGraphics: EditorialPlan["graphics"] = presetVariant ? [{ id, presetId: preset!.id, presetVariant,
    range: { ...input.range }, kind: "native_shape", purpose: "context", message: "", evidenceRefs: [...input.evidenceRefs] }] : [];
  if (project.revision !== projectRevision) throw new Error("建立幾何識別期間專案版本已改變，請重新準備");
  return { schema: "editkin.native-geometry-motion/v1" as const, status: "PREPARED_NOT_APPLIED" as const,
    readOnly: true as const, projectRevision, operation: existing ? "update" as const : "create" as const,
    graphicId: id, range: input.range, purpose: input.purpose, evidenceRefs: input.evidenceRefs,
    before, after: structuredClone(vector), commands: [command], presetVariant, editorialGraphics,
    v4Binding: { visibleFamily: "motion" as const, visibleFamilies: existing ? ["motion"] as const : ["cards", "motion"] as const,
      commandIndex: 0, graphicId: id, purpose: input.purpose,
      evidenceRefs: input.evidenceRefs, createsGraphic: !existing, requiresCurrentDesignIdentity: true as const },
    invalidates: { affectedFrameRange: input.range, beforeVectorSha256, afterVectorSha256, layoutReceiptId: receipt.receiptId },
    preserved: { localId: id, fixedEnvelope: structuredClone(geometry.envelope), position: { x: graphic.x, y: graphic.y },
      compositeLayer: "foreground" as const },
    next: "Bind every visibleFamilies entry to the actual v4 design evidence (creation requires both cards and motion), audit/apply, then inspect the rendered contour in continuous motion. Preparation does not certify pixels or art quality." };
}
