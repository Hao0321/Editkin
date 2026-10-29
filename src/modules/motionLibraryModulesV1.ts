import * as z from "zod/v4";
import {
  assertMotionLibraryProjectFilesV1, motionLibraryAddClipCommandV1, motionLibraryTransitionCommandsV1, motionLibraryUpdateClipCommandV1, renderMotionLibraryForProjectV1,
  resolveMotionLibraryCacheRootV1,
  type MotionLibraryProjectRenderV1,
} from "../application/motionLibraryClipsV1";
import { generatedRemovalCommandsV1 } from "../application/generatedRenderAssetsV1";
import { applyCommand } from "../domain/commands";
import type { EditorCommand } from "../domain/commandTypes";
import { motionLibraryFrameRateV1, motionLibraryClipSecondsV1 } from "../domain/motionLibraryV1";
import type { EditProject, TimelineClip } from "../domain/types";
import { MOTION_LIBRARY_CATALOG, findMotionLibraryItem } from "../motionLibrary/catalog";
import {
  MOTION_ENERGIES, MOTION_PALETTE_THEMES, MOTION_TEXT_FONT_ROLES, MOTION_TEXT_PLATES, MOTION_TRANSITION_DIRECTIONS,
  type MotionLibraryItem, type MotionLibraryKind,
} from "../motionLibrary/types";
import { readProject, resolveProjectPath, workspaceRoot } from "../mcp/storage";
import type { ModuleCall, ModuleFormat, ModuleRuntimeAdapterV2, ModuleVariant } from "./moduleTypes";

/**
 * Motion Library modules for Video Autopilot (PHASE3_CORE_BRIEF decision 5):
 *   graphic.text_motion (T01–T80) · transition.motion_pair (X01–X40) · background.motion_loop (B01–B40).
 *
 * prepare_editkin_module renders the item inside prepare (progress and cancel through the request), verifies the
 * rendered files, applies the commands to an in-memory copy (the same domain validation apply will run) and returns
 * flat commands. It never mutates the project.
 *
 * Variant choice: without variantId the module auto-picks, and auto-pick only ever takes an implemented item whose
 * artStatus is "certified" (catalog.ts reads certifications.ts, revision-pinned) and that is not a VA exclusion (T24,
 * tagged no_va_default; Hao's ruling). A pending item can be used only by naming it; the result says "uncertified".
 *
 * M10 (never invent numbers or facts): text items need the caller's own `lines` (MOTION_LIBRARY_TEXT_LINES_REQUIRED);
 * the catalog's sample text (T29 12,480, T48 3/2/1, …) is for manual browsing only. A transition that burns in a
 * fixed word (X20 「轉場」, tag "text") is never auto-picked; named, its result reports the word as `fixedText`.
 *
 * Placement: without `trackId`, text and background clips are placed by the command itself (`autoTrack`), so any number
 * of prepares sealed against one saved project compose in one plan (domain/motionLibraryCommandsV1.ts).
 */

export const MOTION_LIBRARY_MODULE_IDS_V1 = { text: "graphic.text_motion", transition: "transition.motion_pair", background: "background.motion_loop" } as const;
const ROLE_TAGS: ReadonlySet<string> = new Set(["hook", "impact", "emphasis", "chapter", "title", "intro", "opening", "ending", "exit", "entrance", "teaching",
  "stats", "countdown", "lyrics", "caption", "news", "game", "travel", "music_video", "explainer", "logo"]);
const INTENSITY: Readonly<Record<string, string>> = {
  impact: "high", drama: "high", play: "medium", rhythm: "medium", switch: "medium", style: "medium", physics: "medium", depth: "medium", flow: "low", mood: "low",
  fluid_impact: "high", mosaic: "high", sweep: "medium", panel: "medium", shape: "medium",
  halftone: "medium", grid: "medium", lines: "medium", shapes: "medium", minimal: "low",
};
const FORMATS: ModuleFormat[] = ["portrait", "landscape", "square"];
const VA_EXCLUDED = "no_va_default";
/** Transitions whose picture burns in a fixed word (no text param; src/motionLibrary is frozen here). */
const FIXED_TEXT: Readonly<Record<string, string>> = { X20: "轉場" };
const burnsFixedText = (item: MotionLibraryItem) => item.kind === "transition" && (FIXED_TEXT[item.id] !== undefined || item.tags.includes("text"));

export type MotionLibraryArtStatusV1 = "certified" | "pending";
export interface MotionLibraryModuleVariantV1 extends ModuleVariant { artStatus: MotionLibraryArtStatusV1 }

/** Module variants derived from the live catalog (the checked-in snapshot motionLibraryModuleVariantsV1.json must equal it). */
export function motionLibraryModuleVariantSnapshotV1() {
  const variants = (kind: MotionLibraryKind): MotionLibraryModuleVariantV1[] => MOTION_LIBRARY_CATALOG.filter(item => item.kind === kind).map(item => {
    const roles = [...new Set([...(kind === "text" ? [] : [kind]), item.category, ...item.tags.filter(tag => ROLE_TAGS.has(tag))])];
    const notes = [
      ...(item.kind === "text" ? [`必須自己傳 lines；範例字只示範格式，不可當內容：${item.defaultParams.lines.join(" / ")}`] : []),
      ...(FIXED_TEXT[item.id] ? [`畫面固定出現「${FIXED_TEXT[item.id]}」，不會被自動選到，只能點名使用`] : []),
      ...(item.implemented ? [] : ["尚未實作，不能使用"]),
      ...(item.tags.includes(VA_EXCLUDED) ? ["不是 VA 預設（Hao 裁定），只能點名使用"] : []),
    ];
    return { id: item.id, name: item.names.zh, family: item.category, roles, formats: [...FORMATS], intensity: INTENSITY[item.category] ?? "medium",
      use: notes.join("；"), artStatus: item.artStatus };
  });
  return { schema: "editkin.motion-library-module-variants/v1" as const, text: variants("text"), transition: variants("transition"), background: variants("background") };
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

const hex = z.string().regex(/^#[0-9A-Fa-f]{6}$/);
const palette = z.strictObject({ theme: z.enum(MOTION_PALETTE_THEMES).optional(), bg: hex.optional(), ink: hex.optional(), paper: hex.optional(),
  accent: hex.optional(), accent2: hex.optional() });
const id = z.string().min(1).max(160).refine(value => value.trim() === value && !/[\u0000\r\n]/.test(value));
const look = { palette: palette.optional(), energy: z.enum(MOTION_ENERGIES).optional(), seed: z.number().int().min(0).max(2_147_483_647).optional(),
  /** Auto-pick filters (ignored when variantId names the item): a category (family) and/or a role from the variant list. */
  family: z.string().min(1).max(60).optional(), role: z.string().min(1).max(60).optional() };

/** Edit an existing clip instead of adding one (L1/G6, G7). */
const edit = {
  /** Re-render this Motion Library clip in place (update_motion_library_clip, one Undo); inputs not passed keep the clip's values. */
  updateClipId: id.optional(),
  /** Remove this Motion Library clip, and its render when nothing else uses it (delete_clip + delete_asset, one Undo). */
  removeClipId: id.optional(),
};
export const textMotionModuleInputSchemaV1 = z.strictObject({
  /** Where the clip starts (frames): required to add. */
  startFrame: z.number().int().min(0).optional(), durationFrames: z.number().int().min(1).optional(),
  trackId: id.optional(), clipId: id.optional(), ...edit,
  /** Required to add (M10): the caller's own words; the catalog sample text is never used as content. Update: new words, or keep the clip's. */
  lines: z.array(z.string().min(1).max(96)).min(1).max(4).optional(), font: z.enum(MOTION_TEXT_FONT_ROLES).optional(), plate: z.enum(MOTION_TEXT_PLATES).optional(),
  ...look,
});
export const transitionMotionModuleInputSchemaV1 = z.strictObject({
  /** Required to add: two adjacent clips on one video track. */
  fromClipId: id.optional(), toClipId: id.optional(), durationFrames: z.number().int().min(2).optional(),
  beforeFrames: z.number().int().min(0).optional(), afterFrames: z.number().int().min(0).optional(), transitionId: id.optional(),
  direction: z.enum(MOTION_TRANSITION_DIRECTIONS).optional(),
  /** Remove this Motion Library transition, and its matte/overlay renders when nothing else uses them (one Undo). */
  removeTransitionId: id.optional(),
  ...look,
});
export const backgroundMotionModuleInputSchemaV1 = z.strictObject({
  /** Where the clip starts (frames): required to add. */
  startFrame: z.number().int().min(0).optional(), durationFrames: z.number().int().min(1).optional(), trackId: id.optional(), clipId: id.optional(), ...edit,
  speed: z.number().finite().min(0.25).max(2).optional(), density: z.number().finite().min(0.5).max(2).optional(),
  ...look,
});

// ---------------------------------------------------------------------------
// Choice
// ---------------------------------------------------------------------------

export class MotionLibraryModuleRefusalV1 extends Error {
  constructor(readonly code: "MOTION_LIBRARY_NO_CERTIFIED_VARIANT" | "MOTION_LIBRARY_ITEM_NOT_IMPLEMENTED" | "MOTION_LIBRARY_VARIANT_KIND_MISMATCH" | "MOTION_LIBRARY_PLACEMENT_INVALID"
    | "MOTION_LIBRARY_TEXT_LINES_REQUIRED" | "MOTION_LIBRARY_TARGET_INVALID",
    detail: string) { super(`${code}: ${detail}`); this.name = "MotionLibraryModuleRefusalV1"; }
}

/** Auto-pick: certified, implemented, not a VA exclusion, no burned-in fixed word; filtered by family/role/direction; first in catalog order. */
export function motionLibraryAutoPickCandidatesV1(kind: MotionLibraryKind, filter: { family?: string; role?: string; direction?: string } = {}): MotionLibraryItem[] {
  return MOTION_LIBRARY_CATALOG.filter(item => item.kind === kind && item.implemented && item.artStatus === "certified" && !item.tags.includes(VA_EXCLUDED) && !burnsFixedText(item)
    && (filter.family === undefined || item.category === filter.family)
    && (filter.role === undefined || item.category === filter.role || item.tags.includes(filter.role))
    && (filter.direction === undefined || (item.kind === "transition" && (item.supportedDirections ?? []).includes(filter.direction as never))));
}

function choose(kind: MotionLibraryKind, variantId: string | undefined, filter: { family?: string; role?: string; direction?: string }) {
  if (variantId !== undefined) {
    const item = findMotionLibraryItem(variantId);
    if (!item || item.kind !== kind) throw new MotionLibraryModuleRefusalV1("MOTION_LIBRARY_VARIANT_KIND_MISMATCH", `${variantId} is not a ${kind} item`);
    if (!item.implemented) throw new MotionLibraryModuleRefusalV1("MOTION_LIBRARY_ITEM_NOT_IMPLEMENTED", variantId);
    return { item, autoPicked: false, candidates: [] as string[] };
  }
  const candidates = motionLibraryAutoPickCandidatesV1(kind, filter);
  if (!candidates.length) throw new MotionLibraryModuleRefusalV1("MOTION_LIBRARY_NO_CERTIFIED_VARIANT", `no certified ${kind} item matches ${JSON.stringify(filter)}`);
  return { item: candidates[0], autoPicked: true, candidates: candidates.slice(0, 12).map(item => item.id) };
}

// ---------------------------------------------------------------------------
// Prepare
// ---------------------------------------------------------------------------

const defined = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
function uniqueId(project: EditProject, base: string, taken: (id: string) => boolean): string {
  const stem = base.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 120);
  for (let index = 0; ; index += 1) { const candidate = index ? `${stem}-${index + 1}` : stem; if (!taken(candidate)) return candidate; }
}
const clipTaken = (project: EditProject) => (candidate: string) => project.tracks.some(track => track.clips.some(clip => clip.id === candidate));
/** Clip ids carry the render's key, so prepares sealed against the same saved project do not collide on the same frame. */
const defaultClipId = (project: EditProject, render: MotionLibraryProjectRenderV1, startFrame: number) =>
  uniqueId(project, `motionlib-${render.item.id}-${startFrame}-${render.result.cacheKey.slice(0, 8)}`, clipTaken(project));

async function renderFor(call: ModuleCall, project: EditProject, itemId: string, params: Record<string, unknown>): Promise<MotionLibraryProjectRenderV1> {
  const cacheRoot = await resolveMotionLibraryCacheRootV1({ projectPath: await resolveProjectPath(call.projectPath), workspaceRoot: workspaceRoot() });
  const tools = { ffmpegPath: call.environment.HAO_FFMPEG_PATH || call.environment.EDITKIN_FFMPEG_PATH || undefined,
    ffprobePath: call.environment.HAO_FFPROBE_PATH || call.environment.EDITKIN_FFPROBE_PATH || undefined };
  return renderMotionLibraryForProjectV1({ project, cacheRoot, itemId, params, signal: call.signal, ...(tools.ffmpegPath && tools.ffprobePath ? tools : {}),
    onProgress: progress => call.onProgress?.({ progress: Math.round(progress.fraction * 1000) / 10, total: 100, message: `${itemId} ${progress.phase}` }) });
}

/** The same domain validation apply runs, on an in-memory copy, plus the pre-dispatch file check. */
async function verified(project: EditProject, commands: EditorCommand[]): Promise<void> {
  const candidate = applyCommand(project, { type: "batch", commands: structuredClone(commands) });
  await assertMotionLibraryProjectFilesV1(candidate);
}

function carrier(render: MotionLibraryProjectRenderV1, choice: ReturnType<typeof choose>) {
  const { item, result } = render;
  return { schema: "editkin.motion-library-invocation/v1", itemId: item.id, kind: item.kind, revision: result.itemRevision,
    artStatus: item.artStatus === "certified" ? "certified" : "uncertified", autoPicked: choice.autoPicked, ...(choice.autoPicked ? { candidates: choice.candidates } : {}),
    ...(FIXED_TEXT[item.id] ? { fixedText: [FIXED_TEXT[item.id]] } : {}),
    cacheKey: result.cacheKey, cacheHit: result.cacheHit, engineVersion: result.engineVersion, frameCount: result.frameCount, fps: result.fps,
    outputs: Object.fromEntries(Object.entries(result.outputs).map(([role, output]) => [role, output!.path])) };
}

type EditInputs = { startFrame?: number; trackId?: string; clipId?: string; updateClipId?: string; removeClipId?: string };

/** Exactly one of add (startFrame), update (updateClipId) or remove (removeClipId); remove takes nothing else. */
function editMode(input: EditInputs, raw: object): "add" | "update" | "remove" {
  const chosen = [input.startFrame !== undefined, input.updateClipId !== undefined, input.removeClipId !== undefined].filter(Boolean).length;
  if (chosen !== 1) throw new MotionLibraryModuleRefusalV1("MOTION_LIBRARY_PLACEMENT_INVALID", "pass exactly one of startFrame (add), updateClipId (re-render) or removeClipId (remove)");
  if (input.removeClipId !== undefined && Object.keys(raw).some(key => key !== "removeClipId")) {
    throw new MotionLibraryModuleRefusalV1("MOTION_LIBRARY_PLACEMENT_INVALID", "removeClipId takes no other inputs");
  }
  if (input.updateClipId !== undefined && (input.trackId !== undefined || input.clipId !== undefined)) {
    throw new MotionLibraryModuleRefusalV1("MOTION_LIBRARY_PLACEMENT_INVALID", "trackId and clipId only place a new clip; an update keeps the clip where it is");
  }
  return input.removeClipId !== undefined ? "remove" : input.updateClipId !== undefined ? "update" : "add";
}

/** The clip an update or removal names: a Motion Library clip of this kind. */
function targetClip(project: EditProject, clipId: string, kind: "text" | "background"): TimelineClip {
  const clip = project.tracks.flatMap(track => track.clips).find(candidate => candidate.id === clipId);
  if (!clip?.motionLibrary || clip.motionLibrary.kind !== kind) throw new MotionLibraryModuleRefusalV1("MOTION_LIBRARY_TARGET_INVALID", `${clipId} is not a Motion Library ${kind} clip`);
  return clip;
}

/** Removal: the clip, and its render when nothing else uses it, in one batch (one Undo). */
function removal(project: EditProject, commands: EditorCommand[], detail: { kind: string; itemId: string; clipId?: string; transitionId?: string }) {
  applyCommand(project, { type: "batch", commands: structuredClone(commands) });
  return { status: "PREPARED", projectRevision: project.revision, commands, motionLibrary: { schema: "editkin.motion-library-invocation/v1", action: "remove", ...detail,
    removedAssets: commands.flatMap(command => command.type === "delete_asset" ? [command.assetId] : []) } };
}

/** Update params: the clip's resolved params, overridden by what the caller passes (a palette replaces the palette). */
const updatedParams = (clip: TimelineClip, overrides: Record<string, unknown>) => ({ ...clip.motionLibrary!.params, ...defined(overrides) });

async function addOrUpdate(call: ModuleCall, project: EditProject, kind: "text" | "background", input: EditInputs & { durationFrames?: number }, params: Record<string, unknown>) {
  const rate = motionLibraryFrameRateV1(project.fps);
  const durationSeconds = input.durationFrames === undefined ? undefined : motionLibraryClipSecondsV1(input.durationFrames, rate);
  if (input.updateClipId !== undefined) {
    const clip = targetClip(project, input.updateClipId, kind);
    const choice = choose(kind, call.variantId ?? clip.motionLibrary!.itemId, {});
    const render = await renderFor(call, project, choice.item.id, updatedParams(clip, { ...withoutFilters(params), durationSeconds }));
    // Without a new length the clip keeps its timing (a trim made in the editor survives the re-render).
    const commands: EditorCommand[] = [motionLibraryUpdateClipCommandV1(project, clip, render, { keepTiming: input.durationFrames === undefined })];
    await verified(project, commands);
    return { status: "PREPARED", projectRevision: project.revision, commands, motionLibrary: { ...carrier(render, choice), action: "update", clipId: clip.id } };
  }
  const choice = choose(kind, call.variantId, params as { family?: string; role?: string });
  const render = await renderFor(call, project, choice.item.id, defined({ ...withoutFilters(params), durationSeconds }));
  const clipId = input.clipId ?? defaultClipId(project, render, input.startFrame!);
  const commands: EditorCommand[] = [motionLibraryAddClipCommandV1(project, render, { clipId, trackId: input.trackId, startFrame: input.startFrame! })];
  await verified(project, commands);
  return { status: "PREPARED", projectRevision: project.revision, commands, motionLibrary: carrier(render, choice) };
}
const withoutFilters = ({ family: _family, role: _role, ...rest }: Record<string, unknown>) => rest;

export async function prepareTextMotionModuleV1(call: ModuleCall) {
  // M10: refused before anything is read or rendered; the catalog sample text is never a fallback. An update may keep
  // the clip's own words; a removal shows none.
  const raw = call.inputs as { lines?: unknown; updateClipId?: unknown; removeClipId?: unknown } | undefined;
  const adds = !raw || typeof raw !== "object" || (raw.updateClipId === undefined && raw.removeClipId === undefined);
  if (!raw || typeof raw !== "object" || (adds || raw.lines !== undefined) && (!Array.isArray(raw.lines) || raw.lines.length === 0)) {
    throw new MotionLibraryModuleRefusalV1("MOTION_LIBRARY_TEXT_LINES_REQUIRED", "pass the words to show as lines (1–4); the item's sample text is not content");
  }
  const input = textMotionModuleInputSchemaV1.parse(call.inputs);
  const project = await readProject(call.projectPath);
  if (editMode(input, raw) === "remove") {
    const clip = targetClip(project, input.removeClipId!, "text");
    return removal(project, generatedRemovalCommandsV1(project, { type: "delete_clip", clipId: clip.id }, [clip.assetId]), { kind: "text", itemId: clip.motionLibrary!.itemId, clipId: clip.id });
  }
  return addOrUpdate(call, project, "text", input, { lines: input.lines, font: input.font, plate: input.plate, palette: input.palette, energy: input.energy, seed: input.seed,
    family: input.family, role: input.role });
}

export async function prepareBackgroundMotionModuleV1(call: ModuleCall) {
  const input = backgroundMotionModuleInputSchemaV1.parse(call.inputs);
  const project = await readProject(call.projectPath);
  if (editMode(input, call.inputs as object) === "remove") {
    const clip = targetClip(project, input.removeClipId!, "background");
    return removal(project, generatedRemovalCommandsV1(project, { type: "delete_clip", clipId: clip.id }, [clip.assetId]), { kind: "background", itemId: clip.motionLibrary!.itemId, clipId: clip.id });
  }
  return addOrUpdate(call, project, "background", input, { palette: input.palette, energy: input.energy, seed: input.seed, speed: input.speed, density: input.density,
    family: input.family, role: input.role });
}

export async function prepareTransitionMotionModuleV1(call: ModuleCall) {
  const input = transitionMotionModuleInputSchemaV1.parse(call.inputs);
  const project = await readProject(call.projectPath);
  if (input.removeTransitionId !== undefined) {
    if (Object.keys(call.inputs as object).some(key => key !== "removeTransitionId")) throw new MotionLibraryModuleRefusalV1("MOTION_LIBRARY_PLACEMENT_INVALID", "removeTransitionId takes no other inputs");
    const transition = (project.timelineTransitions ?? []).find(candidate => candidate.id === input.removeTransitionId);
    if (!transition?.motionLibrary) throw new MotionLibraryModuleRefusalV1("MOTION_LIBRARY_TARGET_INVALID", `${input.removeTransitionId} is not a Motion Library transition`);
    const renders = [transition.motionLibrary.matteAssetId, ...(transition.motionLibrary.overlayAssetId ? [transition.motionLibrary.overlayAssetId] : [])];
    return removal(project, generatedRemovalCommandsV1(project, { type: "delete_timeline_transition", transitionId: transition.id }, renders),
      { kind: "transition", itemId: transition.motionLibrary.itemId, transitionId: transition.id });
  }
  if (input.fromClipId === undefined || input.toClipId === undefined) throw new MotionLibraryModuleRefusalV1("MOTION_LIBRARY_PLACEMENT_INVALID", "fromClipId and toClipId are required to add a transition");
  const choice = choose("transition", call.variantId, input);
  const track = project.tracks.find(candidate => candidate.clips.some(clip => clip.id === input.fromClipId));
  if (!track || !track.clips.some(clip => clip.id === input.toClipId)) throw new MotionLibraryModuleRefusalV1("MOTION_LIBRARY_PLACEMENT_INVALID", "fromClipId and toClipId must be adjacent clips on one track");
  const total = input.beforeFrames !== undefined && input.afterFrames !== undefined ? input.beforeFrames + input.afterFrames
    : input.durationFrames ?? Math.max(2, Math.round(0.5 * project.fps));
  const beforeFrames = input.beforeFrames ?? (input.afterFrames !== undefined ? total - input.afterFrames : Math.floor(total / 2));
  const afterFrames = total - beforeFrames;
  if (beforeFrames < 0 || afterFrames < 0 || total < 2 || (input.durationFrames !== undefined && input.durationFrames !== total)) {
    throw new MotionLibraryModuleRefusalV1("MOTION_LIBRARY_PLACEMENT_INVALID", "beforeFrames + afterFrames must equal durationFrames and be at least 2");
  }
  const rate = motionLibraryFrameRateV1(project.fps);
  const render = await renderFor(call, project, choice.item.id, defined({ palette: input.palette, energy: input.energy, seed: input.seed, direction: input.direction,
    durationSeconds: motionLibraryClipSecondsV1(total, rate) }));
  const transitionId = input.transitionId ?? uniqueId(project, `motionlib-${choice.item.id}-${input.fromClipId}`, candidate => (project.timelineTransitions ?? []).some(t => t.id === candidate));
  const commands = motionLibraryTransitionCommandsV1(project, render, { transitionId, trackId: track.id, fromClipId: input.fromClipId, toClipId: input.toClipId, beforeFrames, afterFrames });
  await verified(project, commands);
  return { status: "PREPARED", projectRevision: project.revision, commands, motionLibrary: carrier(render, choice) };
}

export const textMotionModuleAdapterV1: ModuleRuntimeAdapterV2 = { inputSchema: textMotionModuleInputSchemaV1, prepare: prepareTextMotionModuleV1 };
export const transitionMotionModuleAdapterV1: ModuleRuntimeAdapterV2 = { inputSchema: transitionMotionModuleInputSchemaV1, prepare: prepareTransitionMotionModuleV1 };
export const backgroundMotionModuleAdapterV1: ModuleRuntimeAdapterV2 = { inputSchema: backgroundMotionModuleInputSchemaV1, prepare: prepareBackgroundMotionModuleV1 };
