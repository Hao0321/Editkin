import { canonicalJson } from "../shared/canonicalJson";
import { findStyleSlotTemplateV1 } from "../styleTemplates/slots/slotCatalog";
import { StyleSlotRefusalV1, validateStyleSlotValuesV1 } from "../styleTemplates/slots/slotSchema";
import type { EditorCommand } from "./commandTypes";
import { EditGraphError } from "./editGraphError";
import { StyleJobRefusalV1, type StyleJobClipV1 } from "./styleJobFieldsV1";
import { STYLE_TEMPLATE_CLIP_ENGINE_VERSION_V1, assertStyleJobSlotAssetsV1, parseStyleJobFieldV1 } from "./styleJobV1";
import { TRACK_LOCKED_MESSAGE } from "./trackLock";
import { DEFAULT_CLIP_LAYER, type EditProject, type MediaAsset, type TimelineClip, type TimelineTrack } from "./types";
import { reconcileUnifiedLayerOrderInPlaceV1 } from "./unifiedLayerEditsV1";

/**
 * add_style_template_clip / update_style_template_clip: an editable style-template clip, one Undo each.
 *
 * Both are pure over the project: rendering happens before dispatch (styleTemplates/slots/renderTemplateClip.ts, in the
 * module's prepare or the GUI's render host), and the command carries the rendered asset and the `styleJob` field. Here
 * the field is checked against what only the command can see: the current clip engine, the template's current revision
 * and component, and the slot values against the template's declarations (unknown slots, over-long or invalid text,
 * missing required text, invalid colours and image framing are refused). Picture slots may bring the image file they
 * use (`slotAssets`, imported in the same Undo). The full field and asset binding (slot hash, cache key, size, frame
 * count, alpha, slot sources) is enforced by validateProject when the command finishes (styleJobV1.ts).
 */

/** Template clips placed with `autoTrack`: on the picture stack's top, ids `styletpl`, `styletpl-2`, … */
export const STYLE_TEMPLATE_AUTO_TRACK_V1 = { base: "styletpl", name: "模板" } as const;
const OVERLAP_EPSILON = 1e-6;

/** The field must be the current engine's, for the template's current revision and component, with valid canonical slots. */
export function assertCurrentStyleJobFieldV1(value: unknown): StyleJobClipV1 {
  const field = parseStyleJobFieldV1(value);
  if (field.engineVersion !== STYLE_TEMPLATE_CLIP_ENGINE_VERSION_V1) {
    throw new StyleJobRefusalV1("STYLE_JOB_ENGINE_VERSION_STALE", `${field.engineVersion} is not ${STYLE_TEMPLATE_CLIP_ENGINE_VERSION_V1}; re-render first`);
  }
  const template = findStyleSlotTemplateV1(field.template.id);
  if (!template) throw new StyleJobRefusalV1("STYLE_JOB_TEMPLATE_UNKNOWN", field.template.id);
  const component = template.clip.component;
  if (field.template.revision !== template.revision || field.component.id !== component.id || field.component.renderer !== component.renderer
    || field.component.revision !== component.revision || field.output !== template.clip.output) {
    throw new StyleJobRefusalV1("STYLE_JOB_TEMPLATE_MISMATCH", `${field.template.id} r${field.template.revision} ${field.component.id}/${field.component.revision}; re-render with r${template.revision}`);
  }
  if (!template.implemented) throw new StyleJobRefusalV1("STYLE_JOB_COMPONENT_NOT_IMPLEMENTED", `${component.id} (${component.renderer})`);
  const canonical = validateStyleSlotValuesV1(template, field.slots);
  if (canonicalJson(canonical) !== canonicalJson(field.slots)) throw new StyleSlotRefusalV1("STYLE_SLOT_VALUES_INVALID", "slot values are not in canonical form");
  return field;
}

function renderedIdentity(asset: MediaAsset) {
  return JSON.stringify([asset.kind, asset.uri, asset.width, asset.height, asset.duration, asset.alphaMode, asset.compositionId, asset.imageSequence]);
}

/** Adds the asset unless the same file is already registered under its id; a different file is a conflict. */
function ensureAsset(project: EditProject, asset: MediaAsset): void {
  if (!asset || typeof asset !== "object" || typeof asset.id !== "string") throw new StyleJobRefusalV1("STYLE_JOB_ASSET_MISSING", "the command carries no asset");
  const existing = project.assets.find(candidate => candidate.id === asset.id);
  if (existing) {
    if (renderedIdentity(existing) !== renderedIdentity(asset)) throw new StyleJobRefusalV1("STYLE_JOB_ASSET_CONFLICT", asset.id);
    return;
  }
  project.assets.push(structuredClone(asset));
}

/** Image files a picture slot brings along (an imported file): plain image assets only. */
function slotAssetsOf(command: { slotAssets?: MediaAsset[] }): MediaAsset[] {
  const assets = command.slotAssets ?? [];
  if (!Array.isArray(assets) || assets.length > 6) throw new StyleJobRefusalV1("STYLE_JOB_FIELD_INVALID", "slotAssets");
  for (const asset of assets) {
    if (!asset || asset.kind !== "image" || asset.compositionId !== undefined || asset.imageSequence !== undefined) {
      throw new StyleJobRefusalV1("STYLE_JOB_SLOT_ASSET_KIND", `${String(asset?.id)} is not an image file`);
    }
  }
  return assets;
}

/** Placed with autoTrack: the first unlocked, visible template track where the clip fits, else a new one on top (same Undo). */
function resolveAutoTrack(project: EditProject, clip: TimelineClip): string {
  const { base, name } = STYLE_TEMPLATE_AUTO_TRACK_V1;
  if (clip.trackId !== base) throw new StyleJobRefusalV1("STYLE_JOB_TRACK_INVALID", `an autoTrack clip names ${base}, not ${clip.trackId}`);
  const ordinal = (trackId: string) => {
    if (trackId === base) return 1;
    const match = /^-([1-9][0-9]{0,5})$/.exec(trackId.startsWith(base) ? trackId.slice(base.length) : "");
    return match && Number(match[1]) >= 2 ? Number(match[1]) : undefined;
  };
  const start = clip.timelineStart, end = clip.timelineStart + clip.duration;
  const fits = (track: TimelineTrack) => track.clips.every(other => other.timelineStart + other.duration <= start + OVERLAP_EPSILON || end <= other.timelineStart + OVERLAP_EPSILON);
  const reusable = project.tracks
    .filter(track => track.kind === "video" && !track.locked && track.hidden !== true && ordinal(track.id) !== undefined)
    .sort((a, b) => ordinal(a.id)! - ordinal(b.id)!)
    .find(fits);
  if (reusable) return reusable.id;
  const taken = new Set(project.tracks.map(track => track.id));
  let index = 1;
  while (taken.has(index === 1 ? base : `${base}-${index}`)) index += 1;
  project.tracks.push({ id: index === 1 ? base : `${base}-${index}`, name: index === 1 ? name : `${name} ${index}`, kind: "video", locked: false, muted: false, clips: [] });
  return project.tracks[project.tracks.length - 1].id;
}

export function applyStyleTemplateCommandV1(project: EditProject, command: EditorCommand): boolean {
  if (command.type === "add_style_template_clip") {
    const field = assertCurrentStyleJobFieldV1(command.clip?.styleJob);
    if (command.autoTrack !== undefined && command.autoTrack !== true) throw new StyleJobRefusalV1("STYLE_JOB_TRACK_INVALID", "autoTrack is true or absent");
    if (command.clip.assetId !== command.asset?.id) {
      throw new StyleJobRefusalV1("STYLE_JOB_ASSET_BINDING_MISMATCH", `clip ${command.clip.id} must use asset ${String(command.asset?.id)}`);
    }
    if (project.tracks.some(candidate => candidate.clips.some(existing => existing.id === command.clip.id))) throw new EditGraphError(`重複片段 id：${command.clip.id}`);
    const slotAssets = slotAssetsOf(command);
    // Every refusal that can be known before a track is created comes first, so a refused command leaves nothing behind.
    assertStyleJobSlotAssetsV1([...project.assets, ...slotAssets], field.slots);
    for (const asset of slotAssets) ensureAsset(project, asset);
    ensureAsset(project, command.asset);
    const clip = command.autoTrack ? { ...command.clip, trackId: resolveAutoTrack(project, command.clip) } : command.clip;
    const track = project.tracks.find(candidate => candidate.id === clip.trackId);
    if (!track) throw new EditGraphError(`找不到軌道：${clip.trackId}`);
    if (track.locked) throw new EditGraphError(TRACK_LOCKED_MESSAGE);
    if (track.kind !== "video") throw new StyleJobRefusalV1("STYLE_JOB_TRACK_INVALID", `${clip.id} is on a ${track.kind} track`);
    track.clips.push({ ...structuredClone(clip), layer: { ...DEFAULT_CLIP_LAYER, ...clip.layer }, expressions: { ...clip.expressions } });
    track.clips.sort((a, b) => a.timelineStart - b.timelineStart);
    reconcileUnifiedLayerOrderInPlaceV1(project, { type: "add_clip", clip });
    return true;
  }
  if (command.type === "update_style_template_clip") {
    const track = project.tracks.find(candidate => candidate.clips.some(clip => clip.id === command.clipId));
    const clip: TimelineClip | undefined = track?.clips.find(candidate => candidate.id === command.clipId);
    if (!track || !clip) throw new EditGraphError(`找不到片段：${command.clipId}`);
    if (track.locked) throw new EditGraphError(TRACK_LOCKED_MESSAGE);
    if (!clip.styleJob) throw new StyleJobRefusalV1("STYLE_JOB_FIELD_REQUIRED", clip.id);
    if (!command.expected || command.expected.assetId !== clip.assetId || command.expected.key !== clip.styleJob.key) throw new StyleJobRefusalV1("STYLE_JOB_UPDATE_STALE", clip.id);
    const field = assertCurrentStyleJobFieldV1(command.styleJob);
    if (field.template.id !== clip.styleJob.template.id) throw new StyleJobRefusalV1("STYLE_JOB_TEMPLATE_MISMATCH", `${clip.id} is a ${clip.styleJob.template.id} clip`);
    if (command.asset?.id === undefined) throw new StyleJobRefusalV1("STYLE_JOB_ASSET_MISSING", "the command carries no asset");
    const slotAssets = slotAssetsOf(command);
    assertStyleJobSlotAssetsV1([...project.assets, ...slotAssets], field.slots);
    for (const asset of slotAssets) ensureAsset(project, asset);
    ensureAsset(project, command.asset);
    clip.assetId = command.asset.id;
    clip.styleJob = structuredClone(field);
    if (command.sourceStart !== undefined) clip.sourceStart = command.sourceStart;
    if (command.duration !== undefined) clip.duration = command.duration;
    return true;
  }
  return false;
}
