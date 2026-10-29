import { canonicalJson } from "../shared/canonicalJson";
import { applyCommand } from "../domain/commands";
import type { EditorCommand } from "../domain/commandTypes";
import { MOTION_LIBRARY_AUTO_TRACKS_V1 } from "../domain/motionLibraryCommandsV1";
import { STYLE_TEMPLATE_AUTO_TRACK_V1 } from "../domain/styleTemplateCommandsV1";
import type { EditProject } from "../domain/types";
import { isGeneratedRenderAssetV1 } from "./generatedRenderAssetsV1";
import { parseProject, PROJECT_MAX_BYTES } from "./projectCodec";
import { LongformPlanSetRefusal, type LongformChapterRangeV1 } from "./longformPlanSetV1";

/**
 * Plan-set merge (design E3). Every chapter batch was audited alone against the same base: C_k = apply(base, batch_k).
 * Its footprint F_k is every entity, project-wide field or base ordering that C_k changes. Footprints must stay inside
 * their chapter range and apart from each other; project-wide state is decided by the first chapter only. The batches
 * are then folded into one project M, and each chapter's effect inside M must equal its effect alone (commutativity).
 */

export interface LongformMergeChapterV1 {
  chapterId: string;
  range: LongformChapterRangeV1;
  commands: readonly EditorCommand[];
  /** C_k, the audit candidate: this chapter's batch applied alone to the base. */
  candidate: EditProject;
}

export interface LongformMergeOptionsV1 {
  /** Tests may lower the 64 MiB project-file cap to exercise the overflow refusal. */
  maxProjectBytes?: number;
}

export interface LongformMergeResultV1 {
  merged: EditProject;
  chapters: Array<{ chapterId: string; footprint: { created: number; changed: number; removed: number; projectWide: string[]; restated: string[] } }>;
  summary: { chapterCount: number; changedKeys: number; projectBytes: number; assets: number; clips: number; captions: number; motionGraphics: number; markers: number };
}

type Interval = { start: number; end: number; point?: true };
interface EntityState { record: string; interval?: Interval | null }
interface ProjectView { entities: Map<string, EntityState>; orders: Map<string, string[]> }

const NOT_ROOT_FIELDS = new Set(["id", "revision", "updatedAt", "assets", "tracks", "compositions", "captions", "motionTracks", "motionGraphics",
  "motionScenes", "referenceMotionInstances", "timelineTransitions", "director"]);
const FORMAT_FIELDS = new Set(["global:width", "global:height", "global:fps"]);
const BASE_SHARED_PREFIXES = ["asset:", "track:", "composition:"];
const NATIVE_ASSEMBLY_ROLE = "native-assembly-chapter";
const EPSILON_FRAMES = 1e-6;
/** Writes resolve each relative asset URI to an absolute workspace path; leave room for it under the 64 MiB cap. */
const ASSET_PATH_MARGIN_BYTES = 1024;
const LAYER_ORDER_KEY = "global:unifiedLayerOrderV1";
/** Tracks placed by `autoTrack` (style templates, Motion Library text and backgrounds): the base id or `<base>-N`. */
const AUTO_TRACK_KEY = new RegExp(`^track:(?:${[STYLE_TEMPLATE_AUTO_TRACK_V1.base, MOTION_LIBRARY_AUTO_TRACKS_V1.text.base, MOTION_LIBRARY_AUTO_TRACKS_V1.background.base]
  .join("|")})(?:-[1-9][0-9]{0,5})?$`);

function seconds(start: number, duration: number): Interval { return { start, end: start + duration }; }

function viewOf(project: EditProject): ProjectView {
  const entities = new Map<string, EntityState>(), orders = new Map<string, string[]>();
  const add = (key: string, value: unknown, interval?: Interval | null) => {
    if (value === undefined) return;
    if (entities.has(key)) throw new LongformPlanSetRefusal("LONGFORM_SET_DUPLICATE_ENTITY_ID", `${key} appears twice in one project`, [{ key, chapterIds: [] }]);
    entities.set(key, { record: canonicalJson(value), interval });
  };
  const clipIntervals = new Map<string, Interval>();
  for (const asset of project.assets) add(`asset:${asset.id}`, asset);
  orders.set("assets", project.assets.map(asset => asset.id));
  for (const track of project.tracks) {
    const { clips, ...meta } = track;
    add(`track:${track.id}`, meta);
    for (const clip of clips) {
      const interval = seconds(clip.timelineStart, clip.duration);
      clipIntervals.set(clip.id, interval);
      add(`clip:${clip.id}`, { track: track.id, clip }, interval);
    }
    orders.set(`clips@${track.id}`, clips.map(clip => clip.id));
  }
  orders.set("tracks", project.tracks.map(track => track.id));
  for (const caption of project.captions) add(`caption:${caption.id}`, caption, seconds(caption.start, caption.duration));
  orders.set("captions", project.captions.map(caption => caption.id));
  for (const graphic of project.motionGraphics) add(`motionGraphic:${graphic.id}`, graphic, seconds(graphic.timelineStart, graphic.duration));
  orders.set("motionGraphics", project.motionGraphics.map(graphic => graphic.id));
  for (const scene of project.motionScenes ?? []) add(`motionScene:${scene.id}`, scene, seconds(scene.startFrame / scene.fps, scene.durationFrames / scene.fps));
  orders.set("motionScenes", (project.motionScenes ?? []).map(scene => scene.id));
  for (const instance of project.referenceMotionInstances ?? []) {
    add(`referenceMotionInstance:${instance.id}`, instance, seconds(instance.input.startFrame / instance.frameFormat.fps, instance.input.durationFrames / instance.frameFormat.fps));
  }
  orders.set("referenceMotionInstances", (project.referenceMotionInstances ?? []).map(instance => instance.id));
  for (const marker of project.director.markers) add(`marker:${marker.id}`, marker, { start: marker.time, end: marker.time, point: true });
  orders.set("markers", project.director.markers.map(marker => marker.id));
  // A transition belongs to the chapter whose cut it dresses: the frame its incoming clip starts (VA's `atFrame`). Its
  // before/after window may reach into the neighbouring chapter; the fold re-validates the handles it needs there.
  for (const transition of project.timelineTransitions ?? []) {
    const cut = clipIntervals.get(transition.toClipId)?.start;
    add(`timelineTransition:${transition.id}`, transition, cut === undefined ? null : { start: cut, end: cut, point: true });
  }
  orders.set("timelineTransitions", (project.timelineTransitions ?? []).map(transition => transition.id));
  for (const track of project.motionTracks) add(`motionTrack:${track.id}`, track, clipIntervals.get(track.clipId) ?? null);
  orders.set("motionTracks", project.motionTracks.map(track => track.id));
  for (const composition of project.compositions) add(`composition:${composition.id}`, composition);
  orders.set("compositions", project.compositions.map(composition => composition.id));
  // Timestamps are not decisions: the director's own clock is left out like the project's updatedAt.
  const { markers: _markers, updatedAt: _directorUpdatedAt, ...director } = project.director;
  add("global:director", director);
  for (const [field, value] of Object.entries(project)) if (!NOT_ROOT_FIELDS.has(field)) add(`global:${field}`, value);
  return { entities, orders };
}

function restrict(order: readonly string[], keep: ReadonlySet<string>): string[] { return order.filter(id => keep.has(id)); }

interface Footprint { keys: Set<string>; created: Set<string>; changed: Set<string>; removed: Set<string> }

function footprintOf(base: ProjectView, candidate: ProjectView): Footprint {
  const footprint: Footprint = { keys: new Set(), created: new Set(), changed: new Set(), removed: new Set() };
  for (const [key, state] of candidate.entities) {
    const before = base.entities.get(key);
    if (!before) footprint.created.add(key);
    else if (before.record !== state.record) footprint.changed.add(key);
  }
  for (const key of base.entities.keys()) if (!candidate.entities.has(key)) footprint.removed.add(key);
  for (const set of [footprint.created, footprint.changed, footprint.removed]) for (const key of set) footprint.keys.add(key);
  for (const name of new Set([...base.orders.keys(), ...candidate.orders.keys()])) {
    const baseOrder = base.orders.get(name) ?? [], candidateOrder = candidate.orders.get(name) ?? [];
    if (!sameRelativeOrder(baseOrder, candidateOrder)) footprint.keys.add(`order:${name}`);
  }
  return footprint;
}

/** Whether the ids both orders contain appear in the same relative order. */
function sameRelativeOrder(left: readonly string[], right: readonly string[]): boolean {
  const inRight = new Set(right), common = new Set(left.filter(id => inRight.has(id)));
  return canonicalJson(restrict(left, common)) === canonicalJson(restrict(right, common));
}

const NO_KEYS: ReadonlySet<string> = new Set();

/** Project-wide state: root fields, base orderings, and records every chapter shares (existing assets, tracks, compositions).
 * `owned` lists base records one chapter alone may remove (chapterOwnedRemovals). */
function isProjectWide(key: string, base: ProjectView, owned: ReadonlySet<string> = NO_KEYS): boolean {
  if (owned.has(key)) return false;
  return key.startsWith("global:") || key.startsWith("order:") || (BASE_SHARED_PREFIXES.some(prefix => key.startsWith(prefix)) && base.entities.has(key));
}

/**
 * A base asset a chapter removes is that chapter's own when it is a render Editkin made (a style template or Motion
 * Library cache file) and every base record that names it (its clips, a transition's matte) is one this chapter changes or
 * removes inside its own range. Original media, and renders another record still names, stay project-wide.
 */
function chapterOwnedRemovals(base: EditProject, baseView: ProjectView, footprint: Footprint): string[] {
  const owned: string[] = [];
  for (const key of footprint.removed) {
    if (!key.startsWith("asset:")) continue;
    const asset = base.assets.find(candidate => `asset:${candidate.id}` === key);
    if (!asset || !isGeneratedRenderAssetV1(asset)) continue;
    const token = JSON.stringify(asset.id);
    const users = [...baseView.entities].filter(([other, state]) => other !== key && state.record.includes(token)).map(([other]) => other);
    if (users.length && users.every(other => footprint.keys.has(other))) owned.push(key);
  }
  return owned;
}

function setsLayerOrder(commands: readonly EditorCommand[]): boolean {
  return commands.some(command => command.type === "set_unified_layer_order" || (command.type === "batch" && setsLayerOrder(command.commands)));
}
const layerIds = (project: EditProject) => (project.unifiedLayerOrderV1?.layers ?? []).map(layer => `${layer.kind}:${layer.id}`);

/**
 * A layer order the editor saved (unifiedLayerOrderV1) is extended by reconcile whenever a chapter adds or removes a
 * layer (domain/unifiedLayerEditsV1.ts): its new layers go on top, base layers keep their order. That change is derived
 * from the chapter's own edits, not a project-wide decision, unless the chapter sets the order or reorders base layers.
 */
function derivesLayerOrder(base: EditProject, chapter: LongformMergeChapterV1, footprint: Footprint): boolean {
  return footprint.keys.has(LAYER_ORDER_KEY) && base.unifiedLayerOrderV1 != null && chapter.candidate.unifiedLayerOrderV1 != null
    && !setsLayerOrder(chapter.commands) && sameRelativeOrder(layerIds(base), layerIds(chapter.candidate));
}

/** The value a chapter leaves behind for a project-wide key: a record, its absence, or the base order it chose. */
function afterValue(key: string, base: ProjectView, view: ProjectView): string {
  if (key.startsWith("order:")) {
    const name = key.slice("order:".length), baseOrder = base.orders.get(name) ?? [], order = view.orders.get(name) ?? [];
    return canonicalJson(restrict(order, new Set(baseOrder)));
  }
  return view.entities.get(key)?.record ?? "<absent>";
}

function insideRange(interval: Interval, range: LongformChapterRangeV1, fps: number): boolean {
  const start = interval.start * fps, end = interval.end * fps;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  if (interval.point) return start >= range.startFrame - EPSILON_FRAMES && start < range.endFrame - EPSILON_FRAMES;
  return start >= range.startFrame - EPSILON_FRAMES && end <= range.endFrame + EPSILON_FRAMES && end >= start;
}

/** v1 sets carry no owner-revision authority: any proof a chapter's verification produced is refused. */
export function assertNoLongformOwnerProofsV1(chapterId: string, proofs: Readonly<Record<string, unknown>>): void {
  const present = Object.entries(proofs).filter(([, proof]) => proof !== undefined).map(([name]) => name);
  if (present.length) {
    throw new LongformPlanSetRefusal("LONGFORM_SET_OWNER_REVISION_REFUSED", `chapter ${chapterId} needs owner-revision authority (${present.join(", ")}); v1 sets refuse it`,
      [{ key: present[0], chapterIds: [chapterId] }]);
  }
}

/** An import of an asset an earlier chapter already brought in, byte for byte, is a no-op in the fold. */
function withoutRepeatedImports(commands: readonly EditorCommand[], current: EditProject): EditorCommand[] {
  const existing = new Map(current.assets.map(asset => [asset.id, canonicalJson(asset)]));
  const keep = (list: readonly EditorCommand[]): EditorCommand[] => list.flatMap((command): EditorCommand[] => {
    if (command.type === "import_asset" && existing.get(command.asset.id) === canonicalJson({ ...command.asset })) return [];
    if (command.type === "batch") return [{ ...command, commands: keep(command.commands) }];
    return [command];
  });
  return keep(commands);
}

export function mergeLongformPlanSetV1(base: EditProject, chapters: readonly LongformMergeChapterV1[], options: LongformMergeOptionsV1 = {}): LongformMergeResultV1 {
  if (!chapters.length) throw new LongformPlanSetRefusal("LONGFORM_SET_INVALID", "a plan set needs at least one chapter");
  const fps = base.fps;
  const baseView = viewOf(base);
  const views = chapters.map(chapter => viewOf(chapter.candidate));
  const footprints = views.map(view => footprintOf(baseView, view));
  const ids = chapters.map(chapter => chapter.chapterId);
  // Derived layer-order extensions leave the key set (they are re-checked against the fold below); renders a chapter
  // removes with all their users become that chapter's records.
  const derivedLayerOrder = chapters.map((chapter, index) => derivesLayerOrder(base, chapter, footprints[index]));
  for (const [index, derived] of derivedLayerOrder.entries()) if (derived) footprints[index].keys.delete(LAYER_ORDER_KEY);
  const owned = new Set(footprints.flatMap(footprint => chapterOwnedRemovals(base, baseView, footprint)));
  const projectWide = (key: string) => isProjectWide(key, baseView, owned);

  // Every chapter is authored on the base canvas and frame rate; none may change them.
  for (const key of FORMAT_FIELDS) {
    const touching = footprints.flatMap((footprint, index) => footprint.keys.has(key) ? [index] : []);
    if (touching.length) {
      throw new LongformPlanSetRefusal("LONGFORM_SET_PROJECT_FORMAT_REFUSED", `chapter ${ids[touching[0]]} changes ${key.slice("global:".length)}; every chapter is authored on the base format`,
        [{ key, chapterIds: touching.map(index => ids[index]) }]);
    }
  }

  // Ranges: each touched timeline entity, before and after, stays inside its own chapter.
  for (const [index, chapter] of chapters.entries()) {
    for (const key of footprints[index].keys) {
      if (projectWide(key)) continue;
      for (const state of [baseView.entities.get(key), views[index].entities.get(key)]) {
        if (!state || state.interval === undefined) continue;
        if (state.interval === null || !insideRange(state.interval, chapter.range, fps)) {
          throw new LongformPlanSetRefusal("LONGFORM_SET_ENTITY_OUTSIDE_RANGE", `chapter ${chapter.chapterId} touches ${key} outside its range ${chapter.range.startFrame}–${chapter.range.endFrame}`,
            [{ key, chapterIds: [chapter.chapterId] }]);
        }
      }
    }
  }

  // Project-wide state is decided once, by the first chapter. A later chapter may only restate the identical value
  // (every v4 plan must carry its own set_aesthetic_system). A schema upgrade may come from any chapter that agrees.
  const restated = chapters.map(() => [] as string[]);
  const projectWideKeys = new Set(footprints.flatMap(footprint => [...footprint.keys].filter(key => projectWide(key))));
  for (const key of [...projectWideKeys].sort()) {
    const touching = footprints.flatMap((footprint, index) => footprint.keys.has(key) ? [index] : []);
    const first = touching[0];
    if (key !== "global:schemaVersion" && first !== 0) {
      throw new LongformPlanSetRefusal("LONGFORM_SET_GLOBAL_SETTER_NOT_FIRST", `chapter ${ids[first]} changes project-wide ${key}; only the first chapter may`,
        [{ key, chapterIds: touching.map(index => ids[index]) }]);
    }
    const expected = afterValue(key, baseView, views[first]);
    for (const index of touching.slice(1)) {
      if (afterValue(key, baseView, views[index]) !== expected) {
        throw new LongformPlanSetRefusal("LONGFORM_SET_GLOBAL_SETTER_REPEATED", `chapters ${ids[first]} and ${ids[index]} both set ${key} to different values`,
          [{ key, chapterIds: [ids[first], ids[index]] }]);
      }
      restated[index].push(key);
    }
  }

  // Footprints are pairwise disjoint. Two exceptions: the same new asset imported byte for byte (a render reused in
  // several chapters), and the same auto-placed template track (`styletpl`, `motionlib-text`, `motionlib-bg`) that each
  // chapter alone had to create; the fold creates it once and the later chapters' autoTrack clips reuse it.
  const owners = new Map<string, number>();
  const sharedAssetIds = new Set<string>();
  for (const [index, footprint] of footprints.entries()) {
    for (const key of footprint.keys) {
      if (projectWide(key)) continue;
      const owner = owners.get(key);
      if (owner === undefined) { owners.set(key, index); continue; }
      const conflict = [{ key, chapterIds: [ids[owner], ids[index]] }];
      const created = !baseView.entities.has(key);
      const sameRecord = views[owner].entities.get(key)?.record === views[index].entities.get(key)?.record;
      if (key.startsWith("asset:") && created) {
        if (sameRecord) { sharedAssetIds.add(key.slice("asset:".length)); continue; }
        throw new LongformPlanSetRefusal("LONGFORM_SET_ASSET_RECORD_CONFLICT", `chapters ${ids[owner]} and ${ids[index]} import ${key} with different records`, conflict);
      }
      if (created && sameRecord && AUTO_TRACK_KEY.test(key)) continue;
      if (created) throw new LongformPlanSetRefusal("LONGFORM_SET_DUPLICATE_ENTITY_ID", `chapters ${ids[owner]} and ${ids[index]} both create ${key}`, conflict);
      throw new LongformPlanSetRefusal("LONGFORM_SET_FOOTPRINT_OVERLAP", `chapters ${ids[owner]} and ${ids[index]} both change ${key}`, conflict);
    }
  }

  // Fold the chapter batches into one project, in chapter order.
  let merged = base;
  for (const chapter of chapters) {
    try { merged = applyCommand(merged, { type: "batch", commands: structuredClone(withoutRepeatedImports(chapter.commands, merged)) }); }
    catch (error) {
      throw new LongformPlanSetRefusal("LONGFORM_SET_COMMUTATIVITY", `chapter ${chapter.chapterId} does not apply on top of the earlier chapters: ${error instanceof Error ? error.message : String(error)}`,
        [{ key: "fold", chapterIds: [chapter.chapterId] }]);
    }
  }

  // Commutativity: restrict(diff(base, M), F_k) == diff(base, C_k), every change in M is some chapter's, and each
  // chapter keeps its own relative order of shared collections.
  const mergedView = viewOf(merged);
  const attributed = new Set(footprints.flatMap(footprint => [...footprint.keys]));
  if (derivedLayerOrder.some(Boolean)) attributed.add(LAYER_ORDER_KEY);
  // Asset order has no picture meaning; a render several chapters share sits where the first chapter put it.
  const ownOrder = (name: string, order: readonly string[]) => name === "assets" ? order.filter(id => !sharedAssetIds.has(id)) : order;
  for (const [index, footprint] of footprints.entries()) {
    for (const key of footprint.keys) {
      if (afterValue(key, baseView, mergedView) !== afterValue(key, baseView, views[index])) {
        throw new LongformPlanSetRefusal("LONGFORM_SET_COMMUTATIVITY", `chapter ${ids[index]}'s ${key} differs once the other chapters are applied`, [{ key, chapterIds: [ids[index]] }]);
      }
    }
    for (const [name, order] of views[index].orders) {
      if (!sameRelativeOrder(ownOrder(name, order), ownOrder(name, mergedView.orders.get(name) ?? []))) {
        throw new LongformPlanSetRefusal("LONGFORM_SET_COMMUTATIVITY", `chapter ${ids[index]}'s ${name} order differs once the other chapters are applied`, [{ key: `order:${name}`, chapterIds: [ids[index]] }]);
      }
    }
    // A derived layer-order extension must keep this chapter's own stacking inside the merged order.
    if (derivedLayerOrder[index] && !sameRelativeOrder(layerIds(chapters[index].candidate), layerIds(merged))) {
      throw new LongformPlanSetRefusal("LONGFORM_SET_COMMUTATIVITY", `chapter ${ids[index]}'s layer order differs once the other chapters are applied`, [{ key: LAYER_ORDER_KEY, chapterIds: [ids[index]] }]);
    }
  }
  const mergedFootprint = footprintOf(baseView, mergedView);
  for (const key of mergedFootprint.keys) {
    if (!attributed.has(key)) throw new LongformPlanSetRefusal("LONGFORM_SET_COMMUTATIVITY", `the merged project changes ${key}, which no chapter changes alone`, [{ key, chapterIds: [] }]);
  }

  // Caps: M must parse as a project and fit the 64 MiB file.
  let parsed: EditProject;
  try { parsed = parseProject(structuredClone(merged)); }
  catch (error) { throw new LongformPlanSetRefusal("LONGFORM_SET_CAP_OVERFLOW", `the merged project does not fit the project caps: ${(error instanceof Error ? error.message : String(error)).slice(0, 2000)}`); }
  const projectBytes = Buffer.byteLength(`${JSON.stringify(parsed, null, 2)}\n`, "utf8") + parsed.assets.length * ASSET_PATH_MARGIN_BYTES;
  const maxBytes = options.maxProjectBytes ?? PROJECT_MAX_BYTES;
  if (projectBytes > maxBytes) throw new LongformPlanSetRefusal("LONGFORM_SET_CAP_OVERFLOW", `the merged project needs about ${projectBytes} bytes; the project file cap is ${maxBytes}`);

  // Anti-burn guard: a pre-rendered native assembly chapter would burn captions a second time.
  const assembly = merged.assets.find(asset => asset.role === NATIVE_ASSEMBLY_ROLE);
  if (assembly) {
    throw new LongformPlanSetRefusal("LONGFORM_SET_NATIVE_ASSEMBLY_REFUSED", `asset ${assembly.id} is a pre-rendered assembly chapter; a set keeps captions editable and burns them only at final render`,
      [{ key: `asset:${assembly.id}`, chapterIds: [] }]);
  }

  return {
    merged,
    chapters: chapters.map((chapter, index) => ({ chapterId: chapter.chapterId, footprint: {
      created: footprints[index].created.size, changed: footprints[index].changed.size, removed: footprints[index].removed.size,
      projectWide: [...footprints[index].keys].filter(key => projectWide(key)).sort(), restated: restated[index] } })),
    summary: { chapterCount: chapters.length, changedKeys: mergedFootprint.keys.size, projectBytes, assets: merged.assets.length,
      clips: merged.tracks.reduce((total, track) => total + track.clips.length, 0), captions: merged.captions.length,
      motionGraphics: merged.motionGraphics.length, markers: merged.director.markers.length },
  };
}
