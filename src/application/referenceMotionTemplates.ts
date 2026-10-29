import type { EditProject, MotionGraphic } from "../domain/types";
import type { EditorialPlan } from "./editorialPlan";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { buildReferenceMotionTemplateCommands } from "./referenceMotionTemplateCommands";
import type { ReferenceMotionTemplateInput } from "../motion/referenceMotionTemplates";
import { referenceMotionTemplateInputSchema, DEFAULT_REFERENCE_MOTION_STYLE, designThemeDefaultStyle, DEFAULT_REFERENCE_NETWORK_COLORS } from "../motion/referenceMotionTemplates";
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
  const style = validateMotionSceneStyle(input.style ?? (input.designSystem !== undefined ? designThemeDefaultStyle(input.designSystem) : input.templateId === "kinetic_network"
    ? { ...DEFAULT_REFERENCE_MOTION_STYLE, typography: { ...DEFAULT_REFERENCE_MOTION_STYLE.typography, headingFamily: "Noto Sans TC" } }
    : DEFAULT_REFERENCE_MOTION_STYLE));
  // Design-system networks derive their colours from the editable palette unless the caller names them.
  return { ...input, style, ...(input.templateId === "kinetic_network" && input.designSystem !== undefined ? { network: {
    seed: input.network?.seed ?? 32021, points: input.network?.points ?? 32, ...input.network } }
    : input.templateId === "kinetic_network" ? { network: {
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
  const runs = new Map<string, PreparedGlyphRun>(), layouts = new Map<string, ReturnType<typeof motionGraphicV2PhysicalLayoutReceipt>>();
  const deepFreeze = (value: unknown): void => {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  };
  const ids = new Map<string, { prefix: string; parentId?: string; value: string }>();
  // The caller's project and input can only change while caller code runs: an awaited provider (any await) or the id
  // factory. The generation signature is compared at the next check after such a point, and is not recomputed between
  // purely internal synchronous steps, where it cannot differ (the same mutations are detected at the same checks).
  let callerMayHaveRun = true;
  const checkCurrent = () => {
    if (dependencies.signal?.aborted) throw new Error("Motion template preparation cancelled; no commands were applied");
    if (performance.now() >= deadline) throw new Error("Motion template preparation exceeded its original 10-second deadline");
    if (!callerMayHaveRun) return;
    if (canonicalJson(project) !== projectSignature || canonicalJson(input) !== inputSignature) {
      throw new Error("Motion template source generation changed during preparation; re-read the current project and input");
    }
    callerMayHaveRun = false;
  };
  const callerIds = (prefix: string, roleKey?: string) => {
    callerMayHaveRun = true;
    return roleKey === undefined ? idFactory(prefix) : idFactory(prefix, roleKey);
  };
  const stableId = (role: { key: string; parentId?: string }, prefix: string) => {
    const previous = ids.get(role.key);
    if (previous) {
      if (previous.prefix !== prefix || previous.parentId !== role.parentId) throw new Error("Motion template compiler semantic identity changed during preparation");
      return previous.value;
    }
    const value = callerIds(prefix, role.key);
    ids.set(role.key, { prefix, parentId: role.parentId, value });
    return value;
  };
  const bounded = <T>(promise: Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
    const onAbort = () => finish(() => reject(new Error("Motion template preparation cancelled; no commands were applied")));
    const timer = setTimeout(() => finish(() => reject(new Error("Motion template preparation exceeded its original 10-second deadline"))), Math.max(0, deadline - performance.now()));
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      // Any await yields to other code (the provider included): the next check compares the generation again.
      settled = true; callerMayHaveRun = true; clearTimeout(timer); dependencies.signal?.removeEventListener("abort", onAbort); action();
    };
    dependencies.signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
    if (dependencies.signal?.aborted) onAbort();
  });
  // A compiler pass is synchronous: the project and input cannot change inside it, so every layout request only checks
  // cancellation and the deadline; the full generation signature is checked around every await and pass.
  const checkLive = () => {
    if (dependencies.signal?.aborted) throw new Error("Motion template preparation cancelled; no commands were applied");
    if (performance.now() >= deadline) throw new Error("Motion template preparation exceeded its original 10-second deadline");
  };
  const layoutForGraphic = (graphic: MotionGraphic) => {
    checkLive();
    const face = resolveBundledFontFace(graphic.fontFamily ?? "Noto Sans TC", graphic.fontWeight ?? 700);
    if (!face) throw new Error("FONT_BYTES_REQUIRED: unsupported template font family");
    const text = graphic.text.replaceAll("\r", ""), key = canonicalJson([face.faceId, text]);
    const run = runs.get(key);
    if (!run) throw new NeedGlyph(face.faceId, text, key);
    // A run may be shared by equal text, but geometry depends on this graphic's current style, slot, size and ID. Within
    // one preparation the owned project is fixed, so an identical graphic (every field, ID included) has an identical
    // receipt: compiler passes resumed after a new glyph run reuse it, deep-frozen, instead of re-deriving every contour.
    // The key is the graphic's plain JSON: equal JSON is an identical graphic (the compiler builds each one the same way on
    // every pass); a differently ordered copy only misses the memo and derives the same receipt again.
    const memoKey = `${key}\u0000${JSON.stringify(graphic)}`, known = layouts.get(memoKey);
    // A graphic the compiler already placed on an earlier pass gets the owned, frame-ready copy it made of this receipt,
    // so a resumed pass does not copy and re-hash every glyph contour again (identical values, identical binding checks).
    if (known) return preparedLayouts.get(known) ?? known;
    const receipt = motionGraphicV2PhysicalLayoutReceipt(ownedProject, graphic, run);
    deepFreeze(receipt); layouts.set(memoKey, receipt); memoized.add(receipt);
    return receipt;
  };
  const memoized = new WeakSet<object>();
  const preparedLayouts = new WeakMap<object, ReturnType<typeof motionGraphicV2PhysicalLayoutReceipt>>();
  const rememberPreparedLayout = (supplied: ReturnType<typeof motionGraphicV2PhysicalLayoutReceipt>, prepared: ReturnType<typeof motionGraphicV2PhysicalLayoutReceipt>) => {
    if (supplied !== prepared && memoized.has(supplied)) preparedLayouts.set(supplied, prepared);
  };
  checkCurrent();
  let compiled: ReturnType<typeof buildReferenceMotionTemplateCommands>;
  for (;;) {
    checkCurrent();
    try {
      compiled = buildReferenceMotionTemplateCommands(ownedProject, ownedInput, prefix => callerIds(prefix),
        { generation: 2, layoutForGraphic, allocateRoleId: stableId, rememberPreparedLayout });
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
