import { proceduralSfxPlacementRequestV1Schema, type ResolvedProceduralSfxV1 } from "../domain/proceduralSfxLibraryContractV1";
import { DEFAULT_CLIP_LAYER, DEFAULT_COLOR, DEFAULT_TRANSFORM, type MediaAsset, type TimelineClip, type TimelineTrack } from "../domain/types";
import type { EditorCommand } from "../domain/commandTypes";
import { dispatchCommandSafely } from "../domain/history";
import type { ProjectSession, ProjectTask } from "./projectSession";
export interface ProceduralSfxPlacementResolverV1 {
  resolve: (payload: { id: string; sha256: string }, signal?: AbortSignal) => Promise<Pick<ResolvedProceduralSfxV1, "entry" | "absolutePath">>;
}

export interface PreparedProceduralSfxPlacementV1 {
  command: EditorCommand;
  sourceBindings: { id: string; sha256: string; sourceSha256: string; absolutePath: string }[];
  certification: "AUDIO_PENDING_HAO_CLAUDE";
  defaultEnabled: false;
}
const packets = new WeakMap<PreparedProceduralSfxPlacementV1, { session: ProjectSession; task: ProjectTask; library: ProceduralSfxPlacementResolverV1; fingerprint: string;
  command: EditorCommand; sourceBindings: PreparedProceduralSfxPlacementV1["sourceBindings"] }>();
// Exact process-owned comparison is sufficient; the UI helper must not import a Node crypto runtime.
const fingerprint = (value: PreparedProceduralSfxPlacementV1) => JSON.stringify(structuredClone(value));

/** Prepare a complete existing-command batch before touching the editor. Whole-file audio remains editable. */
export async function prepareProceduralSfxPlacementV1(session: ProjectSession, library: ProceduralSfxPlacementResolverV1, payload: unknown, signal?: AbortSignal): Promise<PreparedProceduralSfxPlacementV1> {
  const request = proceduralSfxPlacementRequestV1Schema.parse(payload), project = session.getSnapshot().history.present, task = session.beginTask(project);
  const existingTrack = project.tracks.find(t => t.id === request.trackId);
  if (request.newTrack && existingTrack) throw new Error("SFX_NEW_TRACK_ID_CONFLICT");
  const track: TimelineTrack | undefined = request.newTrack ? { id: request.trackId, name: request.newTrack.name, kind: "audio", locked: false, muted: false, clips: [] } : existingTrack;
  if (!track || track.kind !== "audio" || track.locked || track.muted || project.tracks.some(t => t.solo) && !track.solo) throw new Error("SFX_TARGET_TRACK_UNAVAILABLE");
  if (!Number.isFinite(project.fps) || project.fps < 1 || project.fps > 240) throw new Error("SFX_PROJECT_CLOCK_INVALID");
  const bindings: PreparedProceduralSfxPlacementV1["sourceBindings"] = [], commands: EditorCommand[] = [], assets = new Map<string, MediaAsset>(), clips: TimelineClip[] = [];
  if (request.newTrack) commands.push({ type: "add_track", track });
  for (let i = 0; i < request.hits.length; i++) {
    signal?.throwIfAborted(); if (!task.isCurrent()) throw new Error("SFX_PREPARATION_PROJECT_CHANGED");
    const hit = request.hits[i]; let asset = assets.get(hit.id);
    if (!asset) {
      const resolved = await library.resolve({ id: hit.id, sha256: hit.sha256 }, signal), metadata = resolved.entry;
      if (!task.isCurrent()) throw new Error("SFX_PREPARATION_PROJECT_CHANGED");
      if (!metadata.contentVerified || metadata.defaultEnabled || metadata.redistributable || metadata.id !== hit.id || metadata.sha256 !== hit.sha256) throw new Error("SFX_RESOLVED_REPLY_INVALID");
      const assetId = `${request.idPrefix}-asset-${assets.size + 1}`;
      if (project.assets.some(a => a.id === assetId)) throw new Error("SFX_PLACEMENT_ID_CONFLICT");
      asset = { id: assetId, name: metadata.name, kind: "audio", uri: resolved.absolutePath, duration: metadata.durationSeconds, role: "sound-effect",
        license: "Original; private-owner-only", provenance: `${hit.id}; wav-sha256=${hit.sha256}; source-sha256=${metadata.sourceSha256}`,
        rightsBasis: metadata.rightsBasis, distributionScope: metadata.distributionScope, redistributable: false };
      assets.set(hit.id, asset); commands.push({ type: "import_asset", asset });
      bindings.push({ id: hit.id, sha256: hit.sha256, sourceSha256: metadata.sourceSha256, absolutePath: resolved.absolutePath });
    } else if (bindings.find(b => b.id === hit.id)!.sha256 !== hit.sha256) throw new Error("SFX_PLACEMENT_REFERENCE_CONFLICT");
    const clipId = `${request.idPrefix}-clip-${i + 1}`, start = hit.frame / project.fps, end = start + asset.duration;
    if (project.tracks.some(t => t.clips.some(c => c.id === clipId))) throw new Error("SFX_PLACEMENT_ID_CONFLICT");
    if (!Number.isFinite(start) || end > 86_400) throw new Error("SFX_PLACEMENT_CLOCK_INVALID");
    if ([...track.clips, ...clips].some(c => start < c.timelineStart + c.duration - 1e-8 && end > c.timelineStart + 1e-8)) throw new Error("SFX_TARGET_TRACK_OCCUPIED");
    const clip: TimelineClip = { id: clipId, assetId: asset.id, trackId: track.id, timelineStart: start, sourceStart: 0, duration: asset.duration,
      volume: hit.gain, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, layer: { ...DEFAULT_CLIP_LAYER }, keyframes: [], expressions: {} };
    clips.push(clip); commands.push({ type: "add_clip", clip });
  }
  signal?.throwIfAborted(); if (!task.isCurrent()) throw new Error("SFX_PREPARATION_PROJECT_CHANGED");
  const packet: PreparedProceduralSfxPlacementV1 = { command: { type: "batch", commands }, sourceBindings: bindings, certification: "AUDIO_PENDING_HAO_CLAUDE", defaultEnabled: false };
  packets.set(packet, { session, task, library, fingerprint: fingerprint(packet), command: structuredClone(packet.command), sourceBindings: structuredClone(bindings) });
  return packet;
}

/** Re-resolve file and owner identity, then commit synchronously as one Undo. No published recipe/default changes. */
export async function applyPreparedProceduralSfxPlacementV1(session: ProjectSession, packet: PreparedProceduralSfxPlacementV1, signal?: AbortSignal) {
  const owned = packets.get(packet);
  if (!owned || owned.session !== session || owned.fingerprint !== fingerprint(packet)) throw new Error("SFX_PREPARED_PACKET_INVALID");
  signal?.throwIfAborted(); if (!owned.task.isCurrent()) throw new Error("SFX_PREPARATION_PROJECT_CHANGED");
  for (const source of owned.sourceBindings) {
    const resolved = await owned.library.resolve({ id: source.id, sha256: source.sha256 }, signal);
    if (resolved.absolutePath !== source.absolutePath || resolved.entry.sourceSha256 !== source.sourceSha256) throw new Error("SFX_PREPARED_SOURCE_CHANGED");
    if (!owned.task.isCurrent()) throw new Error("SFX_PREPARATION_PROJECT_CHANGED");
  }
  signal?.throwIfAborted();
  if (owned.fingerprint !== fingerprint(packet) || !owned.task.isCurrent()) throw new Error("SFX_PREPARED_PACKET_INVALID");
  const previous = session.getSnapshot().history, result = dispatchCommandSafely(previous, structuredClone(owned.command));
  if (result.error) throw new Error(result.error);
  session.setHistory(result.state); packets.delete(packet);
  return { importedSounds: owned.sourceBindings.length, insertedHits: owned.command.type === "batch" ? owned.command.commands.filter(c => c.type === "add_clip").length : 0,
    undoSteps: 1, certification: "AUDIO_PENDING_HAO_CLAUDE", defaultEnabled: false };
}
