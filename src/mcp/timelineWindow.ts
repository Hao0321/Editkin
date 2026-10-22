import type { EditProject } from "../domain/types";

/** The bounded agent view: editing state and effect summaries, without media paths or full effect payloads. */
export function timelineWindow(project: EditProject, start: number, end: number, maxItems: number) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || !Number.isInteger(maxItems) || maxItems < 1 || maxItems > 200) {
    throw new Error("時間窗或項目上限無效");
  }
  const names = new Map(project.assets.map(asset => [asset.id, { name: asset.name, kind: asset.kind }]));
  const clips = project.tracks.flatMap(track => track.clips
    .filter(clip => clip.timelineStart < end && clip.timelineStart + clip.duration > start)
    .map(clip => ({
      id: clip.id, trackId: track.id, trackName: track.name, trackKind: track.kind,
      assetId: clip.assetId, asset: names.get(clip.assetId), timelineStart: clip.timelineStart,
      sourceStart: clip.sourceStart, duration: clip.duration, volume: clip.volume,
      transform: { ...clip.transform },
      effects: { lookPresetId: clip.creative?.lookPresetId, effectPresetIds: [...(clip.creative?.effectPresetIds ?? [])],
        nativeEffectCount: clip.creative?.nativeEffectInstances?.length ?? 0, maskCount: clip.masks?.length ?? 0,
        keyframeCount: clip.keyframes.length, hasGradeV2: Boolean(clip.gradeV2), hasChromaKey: Boolean(clip.chromaKey),
        transitionIn: clip.creative?.transitionIn, transitionOut: clip.creative?.transitionOut },
    })));
  const captions = project.captions.filter(caption => caption.start < end && caption.start + caption.duration > start)
    .map(caption => ({ id: caption.id, start: caption.start, duration: caption.duration, text: caption.text, translation: caption.translation }));
  const markers = project.director.markers.filter(marker => marker.time >= start && marker.time < end)
    .map(marker => ({ id: marker.id, time: marker.time, title: marker.title, note: marker.note, kind: marker.kind, status: marker.status }));
  const combined = [
    ...clips.map(item => ({ type: "clip" as const, time: item.timelineStart, item })),
    ...captions.map(item => ({ type: "caption" as const, time: item.start, item })),
    ...markers.map(item => ({ type: "marker" as const, time: item.time, item })),
  ].sort((left, right) => left.time - right.time);
  const page = combined.slice(0, maxItems);
  return {
    status: "GREEN", window: { start, end }, totalItems: combined.length, returnedItems: page.length,
    hasMore: combined.length > page.length,
    tracks: project.tracks.map(track => ({ id: track.id, name: track.name, kind: track.kind,
      locked: track.locked, muted: track.muted, hidden: track.hidden ?? false,
      solo: (track as typeof track & { solo?: boolean }).solo ?? false })),
    clips: page.filter(entry => entry.type === "clip").map(entry => entry.item),
    captions: page.filter(entry => entry.type === "caption").map(entry => entry.item),
    markers: page.filter(entry => entry.type === "marker").map(entry => entry.item),
  };
}
