import { exportCaptionDelivery, type CaptionDeliveryMode } from "./captionDelivery";
import { projectDuration } from "./editGraph";
import type { EditProject } from "./types";

export const LONGFORM_SIDECAR_LIMITS_V1 = Object.freeze({ markers: 10_000, chapters: 200, idCharacters: 160, titleBytes: 512, chapterBytes: 64 * 1024 });
export const LONGFORM_SIDECAR_POLICY_V1 = Object.freeze({
  clock: "project_timeline_seconds", chapterSelection: "explicit_existing_marker_ids",
  chapterTimestampFormat: "HH:MM:SS.mmm", timestampRounding: "nearest_millisecond_no_timeline_shift",
  platformEligibilityVerified: false,
});
const encoder = new TextEncoder(), decoder = new TextDecoder("utf-8", { fatal: true });
const utf8 = (text: string) => encoder.encode(text).byteLength;
function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= LONGFORM_SIDECAR_LIMITS_V1.idCharacters
    && value === value.trim() && !/[\u0000-\u001f\u007f-\u009f]/u.test(value) && decoder.decode(encoder.encode(value)) === value;
}
function stamp(milliseconds: number) {
  return `${String(Math.floor(milliseconds / 3600000)).padStart(2, "0")}:${String(Math.floor(milliseconds / 60000) % 60).padStart(2, "0")}:${String(Math.floor(milliseconds / 1000) % 60).padStart(2, "0")}.${String(milliseconds % 1000).padStart(3, "0")}`;
}

/** Uses final project timeline markers selected by the caller, never narration-local alignment offsets or all notes. */
export function prepareLongformSidecarBundleV1(project: EditProject, chapterMarkerIds: readonly string[], mode: CaptionDeliveryMode) {
  if (!Array.isArray(chapterMarkerIds) || !chapterMarkerIds.length || chapterMarkerIds.length > LONGFORM_SIDECAR_LIMITS_V1.chapters
    || chapterMarkerIds.some(id => !identifier(id)) || new Set(chapterMarkerIds).size !== chapterMarkerIds.length)
    throw Error("SIDECAR_CHAPTER_SELECTION: select 1–200 distinct existing marker IDs");
  const markers = project.director?.markers;
  if (!Array.isArray(markers) || markers.length > LONGFORM_SIDECAR_LIMITS_V1.markers) throw Error("SIDECAR_MARKER_BUDGET: at most 10000 project markers");
  const byId = new Map<string, (typeof markers)[number]>();
  for (const marker of markers) {
    if (!marker || !identifier(marker.id) || byId.has(marker.id)) throw Error("SIDECAR_MARKER_ID: invalid or ambiguous project marker ID");
    byId.set(marker.id, marker);
  }
  // Reuse the established SRT serializer, including its text/translation/errors/rounding. No cue retiming.
  const srt = exportCaptionDelivery(project, "srt", mode), duration = projectDuration(project);
  if (!Number.isFinite(duration) || duration <= 0) throw Error("SIDECAR_TIMELINE_DURATION");
  const chapters = chapterMarkerIds.map(id => {
    const marker = byId.get(id);
    if (!marker) throw Error(`SIDECAR_UNKNOWN_CHAPTER: ${id}`);
    if (typeof marker.title !== "string" || !marker.title || marker.title !== marker.title.trim()
      || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(marker.title) || utf8(marker.title) > LONGFORM_SIDECAR_LIMITS_V1.titleBytes
      || decoder.decode(encoder.encode(marker.title)) !== marker.title) throw Error("SIDECAR_CHAPTER_TITLE: a nonempty single-line UTF-8 title within 512 bytes is required");
    if (!Number.isFinite(marker.time) || marker.time < 0 || marker.time >= duration || marker.time >= 86400)
      throw Error("SIDECAR_CHAPTER_TIME: chapter must be on the existing project timeline, before its end and within 24 hours");
    const roundedMilliseconds = Math.round(marker.time * 1000);
    return { markerId: marker.id, title: marker.title, sourceTimeSeconds: marker.time, roundedMilliseconds, timestamp: stamp(roundedMilliseconds) };
  }).sort((a, b) => a.sourceTimeSeconds - b.sourceTimeSeconds || a.markerId.localeCompare(b.markerId));
  for (let index = 1; index < chapters.length; index++) {
    if (chapters[index].roundedMilliseconds <= chapters[index - 1].roundedMilliseconds)
      throw Error("SIDECAR_CHAPTER_PRECISION_COLLISION: keep distinct chapter boundaries; no merge or timeline shift");
  }
  const chapterText = chapters.map(chapter => `${chapter.timestamp} ${chapter.title}\n`).join("");
  if (utf8(chapterText) > LONGFORM_SIDECAR_LIMITS_V1.chapterBytes) throw Error("SIDECAR_CHAPTER_OUTPUT_BUDGET: at most 64 KiB");
  return { schema: "editkin.longform-sidecar-content/v1" as const, policy: LONGFORM_SIDECAR_POLICY_V1, captionMode: mode,
    cueCount: srt.cueCount, captionWarnings: srt.warnings, timelineDurationSeconds: duration, chapters,
    files: [{ name: "captions.srt" as const, text: srt.text, utf8Bytes: srt.utf8Bytes },
      { name: "chapters.txt" as const, text: chapterText, utf8Bytes: utf8(chapterText) }],
    projectModified: false as const, boundary: "sidecars_only_no_video_render_or_platform_publication" as const };
}
