import type { EditProject, MotionGraphic } from "../domain/types";
import type { EditorialPlan } from "./editorialPlan";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { buildReferenceMotionTemplateCommands } from "./referenceMotionTemplateCommands";
import type { ReferenceMotionTemplateInput } from "../motion/referenceMotionTemplates";
import { referenceMotionTemplateInputSchema, DEFAULT_REFERENCE_MOTION_STYLE, DEFAULT_REFERENCE_NETWORK_COLORS } from "../motion/referenceMotionTemplates";
import { validateMotionSceneStyle } from "../domain/motionSceneStyle";
import { motionGraphicV2PhysicalLayoutReceipt } from "../motion/compositionV2";
import { resolveBundledFontFace } from "../typography/fontFaces";
import { assertPreparedGlyphRun, type PreparedGlyphRun } from "../typography/preparedGlyphRun";
import { canonicalJson } from "../shared/canonicalJson";

export const REFERENCE_MOTION_PREPARATION_MAX_GLYPH_RUNS = 64;
export const REFERENCE_MOTION_PREPARATION_TIMEOUT_MS = 10_000;
export const REFERENCE_MOTION_INSTANCE_RECIPE_VERSION = "editkin.reference-motion-recipes/semantic-roles-v1";
export type NormalizedReferenceMotionTemplateInput = ReturnType<typeof normalizeReferenceMotionTemplateInput>;
/** Freeze effective defaults, including the network palette's original style-presence rule. */
export function normalizeReferenceMotionTemplateInput(raw: ReferenceMotionTemplateInput) {
  const input = referenceMotionTemplateInputSchema.parse(structuredClone(raw));
  for (const key of ["kicker", "subtitle", "previousText", "primaryLabel"] as const) if (input[key] === "") delete input[key];
  if (input.items) input.items = input.items.map(item => ({ label: item.label, ...(item.detail ? { detail: item.detail } : {}) }));
  const hadStyle = input.style !== undefined;
  const style = validateMotionSceneStyle(input.style ?? (input.templateId === "kinetic_network"
    ? { ...DEFAULT_REFERENCE_MOTION_STYLE, typography: { ...DEFAULT_REFERENCE_MOTION_STYLE.typography, headingFamily: "Noto Sans TC" } }
    : DEFAULT_REFERENCE_MOTION_STYLE));
  return { ...input, style, ...(input.templateId === "kinetic_network" ? { network: {
    seed: input.network?.seed ?? 32021, points: input.network?.points ?? 32,
    ...input.network,
    groupColors: input.network?.groupColors ?? (hadStyle
      ? [style.palette.accent, style.palette.muted, style.palette.separator] as [string, string, string]
      : [...DEFAULT_REFERENCE_NETWORK_COLORS] as [string, string, string]),
  } } : {}) };
}
export interface ReferenceMotionTemplatePreparationDependencies {
  prepareText: (faceId: string, text: string) => Promise<PreparedGlyphRun>;
  signal?: AbortSignal;
}

// Only this private compiler suspension is resumable. Font, layout, source and
// graph errors propagate unchanged and cannot select the estimated compiler.
class NeedGlyph extends Error {
  constructor(readonly faceId: string, readonly text: string, readonly key: string) {
    super("Template compilation requires a verified physical glyph run");
  }
}

async function sha(value: unknown): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("Web Crypto SHA-256 is required for template authoring identity");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Latest-only authoring. The legacy synchronous compiler remains separately readable. */
export async function prepareReferenceMotionTemplate(project: EditProject, input: ReferenceMotionTemplateInput,
  idFactory: (prefix: string, roleKey?: string) => string, dependencies: ReferenceMotionTemplatePreparationDependencies) {
  if (typeof dependencies?.prepareText !== "function") throw new Error("FONT_BYTES_REQUIRED: template preparation requires a true physical glyph provider");
  const projectSignature = canonicalJson(project), inputSignature = canonicalJson(input);
  const ownedProject = structuredClone(project), ownedInput = structuredClone(input);
  const deadline = performance.now() + REFERENCE_MOTION_PREPARATION_TIMEOUT_MS;
  const runs = new Map<string, PreparedGlyphRun>();
  const ids = new Map<string, { prefix: string; parentId?: string; value: string }>();
  const checkCurrent = () => {
    if (dependencies.signal?.aborted) throw new Error("Motion template preparation cancelled; no commands were applied");
    if (performance.now() >= deadline) throw new Error("Motion template preparation exceeded its original 10-second deadline");
    if (canonicalJson(project) !== projectSignature || canonicalJson(input) !== inputSignature) {
      throw new Error("Motion template source generation changed during preparation; re-read the current project and input");
    }
  };
  const stableId = (role: { key: string; parentId?: string }, prefix: string) => {
    const previous = ids.get(role.key);
    if (previous) {
      if (previous.prefix !== prefix || previous.parentId !== role.parentId) throw new Error("Motion template compiler semantic identity changed during preparation");
      return previous.value;
    }
    const value = idFactory(prefix, role.key);
    ids.set(role.key, { prefix, parentId: role.parentId, value });
    return value;
  };
  const bounded = <T>(promise: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    const onAbort = () => finish(() => reject(new Error("Motion template preparation cancelled; no commands were applied")));
    const timer = setTimeout(() => finish(() => reject(new Error("Motion template preparation exceeded its original 10-second deadline"))), Math.max(0, deadline - performance.now()));
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true; clearTimeout(timer); dependencies.signal?.removeEventListener("abort", onAbort); action();
    };
    dependencies.signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
    if (dependencies.signal?.aborted) onAbort();
  });
  const layoutForGraphic = (graphic: MotionGraphic) => {
    checkCurrent();
    const face = resolveBundledFontFace(graphic.fontFamily ?? "Noto Sans TC", graphic.fontWeight ?? 700);
    if (!face) throw new Error("FONT_BYTES_REQUIRED: unsupported template font family");
    const text = graphic.text.replaceAll("\r", ""), key = canonicalJson([face.faceId, text]);
    const run = runs.get(key);
    if (!run) throw new NeedGlyph(face.faceId, text, key);
    // A run may be shared by equal text, but geometry depends on this graphic's
    // current style, slot, size and ID on every compiler entry.
    return motionGraphicV2PhysicalLayoutReceipt(ownedProject, graphic, run);
  };
  checkCurrent();
  let compiled: ReturnType<typeof buildReferenceMotionTemplateCommands>;
  for (;;) {
    checkCurrent();
    try {
      compiled = buildReferenceMotionTemplateCommands(ownedProject, ownedInput, prefix => idFactory(prefix), { generation: 2, layoutForGraphic, allocateRoleId: stableId });
      checkCurrent(); break;
    } catch (error) {
      if (!(error instanceof NeedGlyph)) throw error;
      if (runs.size >= REFERENCE_MOTION_PREPARATION_MAX_GLYPH_RUNS) throw new Error("Motion template exceeded 64 distinct physical glyph requests");
      checkCurrent();
      const run = await bounded(dependencies.prepareText(error.faceId, error.text));
      checkCurrent(); assertPreparedGlyphRun(run);
      if (run.faceId !== error.faceId || run.text !== error.text) throw new Error("Physical glyph provider returned a different font or text");
      runs.set(error.key, run);
    }
  }
  const { bindings, ...packet } = compiled;
  const presetHashes = new Map<string, string>();
  for (const { presetId } of bindings) {
    if (presetHashes.has(presetId)) continue;
    const preset = findMotionGraphicPreset(presetId);
    // Registered seed keys are ASCII, matching the existing Node guard's
    // canonical ordering without importing Node into the browser authoring UI.
    presetHashes.set(presetId, await bounded(sha({ id: preset.id, renderer: preset.renderer, seed: preset.seed })));
    checkCurrent();
  }
  const editorialGraphics: EditorialPlan["graphics"] = bindings.map(({ graphic, presetId, overrides, startFrame, endFrame }) => ({
    id: graphic.id, presetId, range: { startFrame, endFrame },
    kind: graphic.vectorV2 ? "native_shape" : graphic.kind === "title" ? "title_card" : "context_card",
    purpose: "context", message: graphic.text, evidenceRefs: [...ownedInput.evidenceRefs],
    presetVariant: { schema: "editkin.motion-preset-variant/v1", basePresetSha256: presetHashes.get(presetId)!,
      reason: ownedInput.purpose, overrides },
  }));
  const [projectSha256, inputSha256] = await bounded(Promise.all([sha(ownedProject), sha(ownedInput)]));
  checkCurrent();
  return { ...packet, editorialGraphics,
    sourceGeneration: { projectId: ownedProject.id, projectRevision: ownedProject.revision, projectSha256, inputSha256 },
    physicalLayoutBindings: packet.layouts.filter(layout => layout.physicalFont).map(layout => ({
      graphicId: layout.graphicId, layoutReceiptId: layout.receiptId, sourceSignature: layout.sourceSignature, physicalFont: layout.physicalFont!,
    })),
    preparation: { schema: "editkin.reference-motion-template-preparation/v2" as const,
      physicalGlyphRequests: runs.size, maximumPhysicalGlyphRequests: REFERENCE_MOTION_PREPARATION_MAX_GLYPH_RUNS,
      deadlineMs: REFERENCE_MOTION_PREPARATION_TIMEOUT_MS, applied: false as const },
  };
}
