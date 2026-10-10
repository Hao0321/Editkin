import * as z from "zod/v4";
import { referenceMotionTemplateInputSchema } from "../motion/referenceMotionTemplates";
import { motionSceneStyleSchema } from "./motionSceneStyle";
import type { MotionPhysicalFontIdentity } from "../motion/compositionV2";
import type { ClipLayout, EditProject } from "./types";

export const REFERENCE_MOTION_INSTANCE_LIMITS = Object.freeze({ instances: 32, roles: 128, roleKeyLength: 120,
  idLength: 160, fonts: 16, presetHashes: 32, instanceBytes: 128 * 1024, projectBytes: 1024 * 1024 });
const id = z.string().min(1).max(REFERENCE_MOTION_INSTANCE_LIMITS.idLength).refine(value => value.trim() === value, "Instance identities cannot contain surrounding whitespace");
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const safeFrame = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const nonemptyPatch = (value: object) => Object.values(value).some(item => item !== undefined);
const optionalCopy = z.string().trim().max(24).nullable().optional();

/** Revision vocabulary deliberately excludes source windows, clocks, topology and animation speed. */
export const referenceMotionTemplateRevisionPatchSchema = z.strictObject({
  strikePresentation: z.enum(["legacy_layout", "semantic_replace_v1"]).optional(),
  strikeSurface: referenceMotionTemplateInputSchema.shape.strikeSurface,
  brandMark: z.string().trim().max(32).refine(value => Array.from(value).length <= 16, "文字字標最多 16 字").nullable().optional(),
  graphicCadence: referenceMotionTemplateInputSchema.shape.graphicCadence,
  // Explicit promotion only. A saved display recipe cannot be downgraded by a
  // revision, and unrelated copy edits never silently promote scene artwork.
  graphicPresentation: z.literal("native_paint_display_v2").describe("Explicit one-way level_bridge upgrade to display-referred Rec.709 SDR native paint; independently recompile current physical glyphs and all managed commands.").optional(),
  title: z.string().trim().min(1).max(32).optional(), kicker: optionalCopy,
  subtitle: z.string().trim().max(40).nullable().optional(), previousText: optionalCopy,
  primaryLabel: z.string().trim().max(20).nullable().optional(),
  items: z.array(z.strictObject({ label: z.string().trim().min(1).max(24), detail: z.string().trim().max(40).nullable().optional() })).min(2).max(4).optional(),
  network: z.strictObject({ labels: z.tuple([z.string().trim().min(1).max(6), z.string().trim().min(1).max(6), z.string().trim().min(1).max(6)]).nullable().optional(),
    hubLabel: z.string().trim().min(1).max(6).nullable().optional() }).refine(nonemptyPatch, "Network patch is empty").optional(),
  style: z.strictObject({
    palette: motionSceneStyleSchema.shape.palette.partial().refine(nonemptyPatch, "Palette patch is empty").optional(),
    typography: motionSceneStyleSchema.shape.typography.partial().refine(nonemptyPatch, "Typography patch is empty").optional(),
  }).refine(nonemptyPatch, "Style patch is empty").optional(),
}).refine(nonemptyPatch, "Reference Motion revision patch is empty");
export type ReferenceMotionTemplateRevisionPatch = z.infer<typeof referenceMotionTemplateRevisionPatchSchema>;

export const referenceMotionInstanceRoleSchema = z.strictObject({
  key: z.string().min(1).max(REFERENCE_MOTION_INSTANCE_LIMITS.roleKeyLength).refine(value => value.trim() === value, "Semantic role keys cannot contain surrounding whitespace"),
  kind: z.enum(["graphic", "clip", "track", "mask", "keyframe"]), id, parentId: id.optional(),
}).superRefine((role, context) => {
  const child = role.kind === "clip" || role.kind === "mask" || role.kind === "keyframe";
  if (child !== (role.parentId !== undefined) || role.parentId === role.id) context.addIssue({ code: "custom", message: "Child roles require a distinct parent; graphic and track roles have no parent" });
});
export type ReferenceMotionInstanceRole = z.infer<typeof referenceMotionInstanceRoleSchema>;

const rect = z.strictObject({ x: z.number().finite().min(0).max(1), y: z.number().finite().min(0).max(1),
  width: z.number().finite().positive().max(1), height: z.number().finite().positive().max(1) })
  .refine(value => value.x + value.width <= 1 + 1e-9 && value.y + value.height <= 1 + 1e-9, "Stored primary layout exceeds source/canvas bounds");
const primaryLayout: z.ZodType<ClipLayout> = z.strictObject({ crop: rect, viewport: rect });
const fontIdentity: z.ZodType<MotionPhysicalFontIdentity> = z.strictObject({ schema: z.literal("editkin.motion-physical-layout/v1"), faceId: id,
  fontSha256: sha256, manifestSha256: sha256, parserVersion: z.literal("opentype.js@1.3.4") });

/** Saved inputs contain actual authoring defaults, rather than regenerating defaults on reopen. */
export const referenceMotionInstanceInputSchema = referenceMotionTemplateInputSchema.safeExtend({
  clipId: id, sources: referenceMotionTemplateInputSchema.shape.sources.removeDefault(),
  intent: z.enum(["shortform", "standalone_showcase"]), style: motionSceneStyleSchema,
});

export const referenceMotionInstanceSchema = z.strictObject({
  schema: z.literal("editkin.reference-motion-instance/v1"), id, authoringGeneration: z.literal(2), instanceRevision: safeFrame.positive(),
  input: referenceMotionInstanceInputSchema,
  frameFormat: z.strictObject({ width: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), height: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), fps: z.number().finite().positive().max(240) }),
  roles: z.array(referenceMotionInstanceRoleSchema).min(1).max(REFERENCE_MOTION_INSTANCE_LIMITS.roles),
  primaryBefore: z.strictObject({ layout: primaryLayout.nullable() }), appliedScopeSha256: sha256,
  dependencies: z.strictObject({ recipeVersion: z.string().min(1).max(120),
    presetHashes: z.array(z.strictObject({ presetId: id, sha256 })).max(REFERENCE_MOTION_INSTANCE_LIMITS.presetHashes),
    fonts: z.array(fontIdentity).max(REFERENCE_MOTION_INSTANCE_LIMITS.fonts) }),
}).superRefine((instance, context) => {
  if (!Number.isSafeInteger(instance.input.startFrame + instance.input.durationFrames)) context.addIssue({ code: "custom", message: "Instance frame range is unsafe" });
  const keys = new Set<string>(), ids = new Set<string>();
  for (const role of instance.roles) {
    if (keys.has(role.key) || ids.has(role.id)) context.addIssue({ code: "custom", message: "Instance role keys and identities must be unique" });
    keys.add(role.key); ids.add(role.id);
    if ((role.kind === "mask" || role.kind === "keyframe") && !instance.roles.some(parent => parent.kind === "clip" && parent.id === role.parentId)) context.addIssue({ code: "custom", message: "Mask/keyframe role requires a declared clip role" });
  }
  const primary = instance.roles.find(role => role.key === "source:0:clip");
  if (primary && (primary.kind !== "clip" || primary.id !== instance.input.clipId)) context.addIssue({ code: "custom", message: "Primary source role must retain the input clip identity" });
  for (const list of [instance.dependencies.presetHashes.map(row => row.presetId), instance.dependencies.fonts.map(row => row.faceId)]) {
    if (new Set(list).size !== list.length) context.addIssue({ code: "custom", message: "Instance dependency identities must be unique" });
  }
  if (referenceMotionInstanceBytes(instance) > REFERENCE_MOTION_INSTANCE_LIMITS.instanceBytes) context.addIssue({ code: "custom", message: "Reference Motion instance metadata exceeds 128KiB" });
});

export type ReferenceMotionTemplateInstance = z.infer<typeof referenceMotionInstanceSchema>;
export type ReferenceMotionInstanceDependencies = ReferenceMotionTemplateInstance["dependencies"];

export function referenceMotionInstanceBytes(value: unknown): number { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }

/** Metadata validation is structural only. Manual graph drift remains saveable and is inspected by authoring. */
export function assertReferenceMotionInstances(project: Pick<EditProject, "schemaVersion" | "referenceMotionInstances" | "compositions">): void {
  if (project.schemaVersion !== 10 && Object.prototype.hasOwnProperty.call(project, "referenceMotionInstances")) throw new Error("Reference Motion instances require schema 10");
  for (const composition of project.compositions) if (Object.prototype.hasOwnProperty.call(composition, "referenceMotionInstances")) throw new Error("Reference Motion instances are root project metadata only");
  if (project.referenceMotionInstances === undefined) return;
  const instances = z.array(referenceMotionInstanceSchema).max(REFERENCE_MOTION_INSTANCE_LIMITS.instances).parse(project.referenceMotionInstances);
  const ids = new Set<string>(), owners = new Set<string>();
  for (const instance of instances) {
    if (ids.has(instance.id)) throw new Error("Duplicate Reference Motion instance identity");
    ids.add(instance.id);
    for (const role of instance.roles) {
      if (owners.has(role.id)) throw new Error("Reference Motion role identity is owned by more than one instance");
      owners.add(role.id);
    }
  }
  if (referenceMotionInstanceBytes(instances) > REFERENCE_MOTION_INSTANCE_LIMITS.projectBytes) throw new Error("Reference Motion project metadata exceeds 1MiB");
}
