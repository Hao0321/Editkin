import * as z from "zod/v4";
import { createHash } from "node:crypto";
import { canonicalJson } from "../shared/canonicalJson";
import { applyCommand, type EditorCommand } from "../domain/commands";
import { validateProject } from "../domain/editGraph";
import { editorCommandSchema } from "../domain/schema";
import type { EditProject } from "../domain/types";
import { assertScopedPaletteRevisionEffects, isPaletteTargetManaged } from "./scopedPaletteRevision";

export const PALETTE_ROLES = ["background", "ink", "muted", "primary", "accent", "grid", "outline"] as const;
const hexColor = z.string().regex(/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i);
const role = z.enum(PALETTE_ROLES);
export const paletteRoleSchema = z.strictObject({ background: hexColor, ink: hexColor, muted: hexColor, primary: hexColor, accent: hexColor, grid: hexColor, outline: hexColor });
const colorBindings = z.strictObject({ textColor: role.optional(), backgroundColor: role.optional(), accentColor: role.optional() }).refine(value => Object.keys(value).length > 0, "At least one color field is required");
export const paletteRevisionInputSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(), expectedProjectSha256: z.string().regex(/^[0-9a-f]{64}$/),
  palette: paletteRoleSchema,
  bindings: z.array(z.strictObject({ graphicId: z.string().min(1).max(160), colors: colorBindings, alphaMode: z.enum(["retain_target", "use_role"]).default("retain_target") })).min(1).max(32),
  minimumTextContrast: z.number().min(4.5).max(21).default(4.5),
});
export const paletteRevisionHash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
export function listPaletteRoles() {
  return { schema: "editkin.palette-role-catalog/v1", roles: PALETTE_ROLES,
    example: { background: "#F7F8FA", ink: "#111827", muted: "#64748B", primary: "#175CD3", accent: "#A9E9F7", grid: "#175CD31C", outline: "#111827" },
    editable: true, alphaModes: ["retain_target", "use_role"], maximumTargets: 32,
    scope: "Explicit color roles for existing unowned v2 Motion graphics on a real-media plan; saved templates/scenes use their owner recompiler. Example colors are editable, not a quality score or a website-brand claim." };
}
type Rgba = { rgb: number[]; alpha: number };
function rgba(value: string): Rgba {
  if (!/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(value)) throw new Error("Palette revision requires explicit hex RGBA colors");
  return { rgb: [1, 3, 5].map(offset => Number.parseInt(value.slice(offset, offset + 2), 16)), alpha: value.length === 9 ? Number.parseInt(value.slice(7), 16) / 255 : 1 };
}
function compose(foreground: Rgba, opaqueBackground: number[]) { return foreground.rgb.map((channel, index) => channel * foreground.alpha + opaqueBackground[index] * (1 - foreground.alpha)); }
function luminance(rgb: number[]) {
  const linear = rgb.map(channel => { const s = channel / 255; return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4; });
  return linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
}
function contrast(foreground: number[], background: number[]) { const a = luminance(foreground), b = luminance(background); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05); }

export function preparePaletteRevision(project: EditProject, input: unknown, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const json = JSON.stringify(input);
  if (!json || Buffer.byteLength(json, "utf8") > 65_536) throw new Error("Palette payload exceeds 64 KiB");
  const request = paletteRevisionInputSchema.parse(input);
  const projectSha256 = paletteRevisionHash(project);
  if (request.expectedRevision !== project.revision || request.expectedProjectSha256 !== projectSha256) throw new Error("Stale palette project revision or identity");
  const canvas = rgba(request.palette.background);
  if (canvas.alpha !== 1) throw new Error("Declared palette canvas background must be opaque");
  const ids = new Set<string>(), commands: EditorCommand[] = [];
  const changes: { graphicId: string; fields: Record<string, string>; textContrast: number | null }[] = [];
  for (const binding of request.bindings) {
    signal?.throwIfAborted();
    if (ids.has(binding.graphicId)) throw new Error("Duplicate palette target");
    ids.add(binding.graphicId);
    const graphic = project.motionGraphics.find(item => item.id === binding.graphicId);
    if (!graphic) throw new Error("Missing palette graphic target: " + binding.graphicId);
    if (isPaletteTargetManaged(project, graphic)) throw new Error("Palette target is owner-managed; recompile its authored source/template through the dedicated owner");
    if (graphic.schema !== "hao.motion-composition/v2") throw new Error("Palette preparation needs an existing v2 target; upgrade the legacy template through its authoring route first");
    const patch: Record<string, string> = {};
    for (const [field, colorRole] of Object.entries(binding.colors) as [keyof typeof binding.colors, z.infer<typeof role>][]) {
      const token = request.palette[colorRole], previous = graphic[field];
      rgba(previous);
      patch[field] = binding.alphaMode === "retain_target" ? token.slice(0, 7) + (previous.length === 9 ? previous.slice(7) : "") : token;
    }
    const candidate = { ...graphic, ...patch };
    let ratio: number | null = null;
    if (candidate.text.trim()) {
      const background = compose(rgba(candidate.backgroundColor), canvas.rgb);
      ratio = contrast(compose(rgba(candidate.textColor), background), background);
      if (ratio < request.minimumTextContrast) throw new Error(`Insufficient declared text contrast for ${graphic.id}: ${ratio.toFixed(2)}`);
    }
    commands.push(editorCommandSchema.parse({ type: "update_motion_graphic", graphicId: graphic.id, patch }));
    changes.push({ graphicId: graphic.id, fields: patch, textContrast: ratio });
  }
  validateProject(structuredClone(project));
  assertScopedPaletteRevisionEffects(project, commands);
  validateProject(applyCommand(structuredClone(project), { type: "batch", commands }));
  signal?.throwIfAborted();
  if (paletteRevisionHash(project) !== projectSha256) throw new Error("Palette preparation mutated its input");
  const body = { schema: "editkin.agent-palette-revision/v1", status: "PALETTE_GRAPH_PREFLIGHT_ONLY", projectId: project.id, projectRevision: project.revision, projectSha256,
    commands, commandsSha256: paletteRevisionHash(commands), paletteSha256: paletteRevisionHash(request.palette), changes,
    sourceMutation: false, auditReceipt: false, applyReceipt: false,
    contrastScope: "RGBA color computation over declared canvas only; no footage, physical glyph, preview/export pixel or aesthetic acceptance is asserted.",
    next: "Bind these existing-layer command indexes to the same real-media revision6/V4 designEvidence and motionTreatment.color; do not add existing targets to editorial.graphics. Standalone original-source revision is unsupported. Audit, atomic apply, render and artifact review remain required." };
  return { ...body, preparationSha256: paletteRevisionHash(body) };
}
