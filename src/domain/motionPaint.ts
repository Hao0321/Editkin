import * as z from "zod/v4";
import type { EditProject, MotionGraphic } from "./types";

const coordinate = z.number().finite().min(-4).max(4);
const point = z.strictObject({ x: coordinate, y: coordinate });
const hex = z.string().regex(/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i);
const stops = z.array(z.strictObject({ at: z.number().finite().min(0).max(1), color: hex })).min(2).max(16)
  .superRefine((values, context) => {
    if (values[0].at !== 0 || values.at(-1)!.at !== 1 || values.some((stop, i) => i > 0 && stop.at <= values[i - 1].at)) {
      context.addIssue({ code: "custom", message: "Paint stops must increase strictly from 0 to 1" });
    }
  });
const fill = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("solid"), color: hex }),
  z.strictObject({ kind: z.literal("linear"), start: point, end: point, stops }),
  z.strictObject({ kind: z.literal("radial"), center: point, radius: z.number().finite().min(.001).max(4), stops }),
]).superRefine((value, context) => {
  if (value.kind === "linear" && Math.hypot(value.end.x - value.start.x, value.end.y - value.start.y) < .0001) {
    context.addIssue({ code: "custom", message: "Paint linear gradient has zero length" });
  }
});
const command = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("M"), x: coordinate, y: coordinate }),
  z.strictObject({ type: z.literal("L"), x: coordinate, y: coordinate }),
  z.strictObject({ type: z.literal("Q"), x1: coordinate, y1: coordinate, x: coordinate, y: coordinate }),
  z.strictObject({ type: z.literal("C"), x1: coordinate, y1: coordinate, x2: coordinate, y2: coordinate, x: coordinate, y: coordinate }),
  z.strictObject({ type: z.literal("Z") }),
]);
const clip = z.strictObject({ fillRule: z.enum(["non_zero", "even_odd"]), commands: z.array(command).min(4).max(8192) })
  .superRefine((value, context) => {
    let valid = true, open = false, edges = 0;
    for (const item of value.commands) {
      if (item.type === "M") { if (open) { valid = false; break; } open = true; edges = 0; }
      else if (!open) { valid = false; break; }
      else if (item.type === "Z") { if (edges < 2) { valid = false; break; } open = false; }
      else edges++;
    }
    if (!valid || open) context.addIssue({ code: "custom", message: "Paint clip needs complete closed nondegenerate contours" });
  });

/** Authoring coordinates are fractions of the current graphic box. Exact glyph
 * contours stay factory-owned runtime data; projects never attest font paths. */
const paintFields = {
  fill,
  clips: z.array(clip).max(8),
  stroke: z.strictObject({ color: hex, widthPixels: z.number().finite().min(.25).max(24) }).optional(),
  // Gaussian sigma in the graphic's own pixel coordinates. Native rasterization
  // truncates at three sigma and accounts for the current camera/graphic scale.
  shadow: z.strictObject({ color: hex,
    offsetXPixels: z.number().finite().min(-128).max(128),
    offsetYPixels: z.number().finite().min(-128).max(128),
    blurPixels: z.number().finite().min(0).max(32) }).optional(),
};
export const motionPaintV1Schema = z.strictObject({
  schema: z.literal("editkin.motion-paint/v1"), ...paintFields,
}).superRefine((value, context) => {
  if (value.clips.reduce((total, item) => total + item.commands.length, 0) > 65536) {
    context.addIssue({ code: "custom", message: "Paint clip command budget exceeded" });
  }
});
export type MotionPaintV1 = z.infer<typeof motionPaintV1Schema>;
/** Display artwork is an explicit new descriptor. V1 continues to mean scene
 * paint, including on reopen; omission never promotes an old graphic. */
export const motionPaintV2Schema = z.strictObject({
  schema: z.literal("editkin.motion-paint/v2"),
  colorIntent: z.literal("display_rec709_sdr"), ...paintFields,
}).superRefine((value, context) => {
  if (value.clips.reduce((total, item) => total + item.commands.length, 0) > 65536) {
    context.addIssue({ code: "custom", message: "Paint clip command budget exceeded" });
  }
});
export type MotionPaintV2 = z.infer<typeof motionPaintV2Schema>;
export const motionPaintDescriptorSchema = z.discriminatedUnion("schema", [motionPaintV1Schema, motionPaintV2Schema]);
export type MotionPaintDescriptor = z.infer<typeof motionPaintDescriptorSchema>;
const staticPaintVector = z.strictObject({
  schema: z.enum(["editkin.motion-vector/v1", "editkin.motion-vector-stage/v1"]),
  kind: z.enum(["panel", "ellipse", "rule"]),
  heightPixels: z.number().finite().min(1).max(4096),
  revealFrames: z.literal(1),
});

export function assertMotionPaintContract(graphic: MotionGraphic): void {
  const selected = graphic.visualStyle === "native_paint";
  if (selected !== (graphic.paintV1 !== undefined)) throw new Error("Native paint needs both its style discriminator and versioned descriptor");
  if (!selected) return;
  motionPaintDescriptorSchema.parse(graphic.paintV1);
  if (graphic.paintV1!.schema === "editkin.motion-paint/v2" && (graphic.compositeLayer ?? "foreground") !== "foreground") {
    throw new Error("Display Rec.709 paint requires foreground composition");
  }
  if (graphic.schema !== "hao.motion-composition/v2") throw new Error("Native paint requires physical v2 text or a typed static vector");
  if (graphic.vectorV2) {
    if (graphic.text !== "" || !staticPaintVector.safeParse(graphic.vectorV2).success) {
      throw new Error("Native paint vector requires empty text and an explicit static panel, ellipse or rule");
    }
  } else if (!graphic.text.trim()) throw new Error("Native paint text requires actual nonempty physical glyphs");
  if (!/^#[0-9a-f]{6}00$/i.test(graphic.backgroundColor) || (graphic.shadowDepth ?? 0) !== 0 || (graphic.outlineWidth ?? 0) !== 0) {
    throw new Error("Native paint requires a transparent legacy panel and zero legacy shadow/outline; declare stroke and shadow in paintV1");
  }
}

/** Saved templates and semantic camera scenes retain their recompiler ownership. */
export function assertMotionPaintEditOwner(project: EditProject, graphic: MotionGraphic, trustedReferenceGraphicIds?: ReadonlySet<string>): void {
  if (graphic.templateOwner || project.motionScenes?.some(scene => scene.graphicIds.includes(graphic.id))
    || project.referenceMotionInstances?.some(instance => instance.roles.some(role => role.kind === "graphic" && role.id === graphic.id))
      && !trustedReferenceGraphicIds?.has(graphic.id)) {
    throw new Error("Native paint target is owner-managed; recompile through its owning template or scene");
  }
}
