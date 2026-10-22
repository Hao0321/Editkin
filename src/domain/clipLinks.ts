import type { EditProject, TimelineClip } from "./types";

export const CLIP_LINK_ID_LIMIT = 160;

/** A group belongs to this project. Legacy clips never receive an invented id. */
export function linkedClipIds(project: Pick<EditProject, "tracks">, clipId: string): string[] {
  const clips = project.tracks.flatMap(track => track.clips), selected = clips.find(clip => clip.id === clipId);
  return selected?.linkGroupId ? clips.filter(clip => clip.linkGroupId === selected.linkGroupId).map(clip => clip.id) : selected ? [clipId] : [];
}

export function expandLinkedClipIds(project: Pick<EditProject, "tracks">, ids: readonly string[]): string[] {
  return [...new Set(ids.flatMap(id => linkedClipIds(project, id)))];
}

export function unusedLinkGroupId(project: Pick<EditProject, "tracks">, seed: string): string {
  const used = new Set(project.tracks.flatMap(track => track.clips.map(clip => clip.linkGroupId)));
  const base = `link-${seed}`.slice(0, CLIP_LINK_ID_LIMIT - 12);
  for (let index = 0; ; index++) {
    const id = index ? `${base}-${index}` : base;
    if (!used.has(id)) return id;
  }
}

/** Only a group affected by removal is cleaned; unrelated old authored fields keep their shape. */
export function cleanRemovedClipLinks(before: EditProject, after: EditProject): void {
  const old = before.tracks.flatMap(track => track.clips), clips = after.tracks.flatMap(track => track.clips);
  const remaining = new Set(clips.map(clip => clip.id));
  const affected = new Set(old.filter(clip => clip.linkGroupId && !remaining.has(clip.id)).map(clip => clip.linkGroupId!));
  for (const group of affected) {
    const members = clips.filter(clip => clip.linkGroupId === group);
    if (members.length === 1) delete members[0].linkGroupId;
  }
}

export function clipLinkMembers(project: Pick<EditProject, "tracks">, clipId: string): TimelineClip[] {
  const ids = new Set(linkedClipIds(project, clipId));
  return project.tracks.flatMap(track => track.clips).filter(clip => ids.has(clip.id));
}

export function linkedClipRepresentative(project: Pick<EditProject, "tracks">, clipId: string): string {
  const members = clipLinkMembers(project, clipId);
  return (members.find(clip => clip.trackId === "video-main")
    ?? members.find(clip => project.tracks.find(track => track.id === clip.trackId)?.kind === "video")
    ?? members.find(clip => clip.id === clipId))?.id ?? clipId;
}
