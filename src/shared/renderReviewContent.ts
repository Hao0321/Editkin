import type { EditProject } from "../domain/types";
import { DEFAULT_CLIP_LAYER } from "../domain/types";
import { canonicalJson } from "./canonicalJson";

/** Browser-safe canonical encoding; hash these UTF-8 bytes with SHA-256.
 * Excludes review metadata, not editing content. Does not authenticate source file bytes. */
export function renderReviewContentJson(project: EditProject): string {
  const { director: _director, revision: _revision, updatedAt: _updatedAt, aestheticSystem, ...content } = project;
  const aesthetic = aestheticSystem ? (({ review: _review, ...standard }) => standard)(aestheticSystem) : undefined;
  // Renderer defaults: planner enabled !== false / role ?? content;
  // ffmpegComposite blendMode ?? normal and expressions ?? {}.
  // Commands materialize these defaults even for review-only changes.
  const normalizeTracks = (tracks: EditProject["tracks"]) => tracks.map(track => ({ ...track,
    clips: track.clips.map(clip => ({ ...clip, layer: { ...DEFAULT_CLIP_LAYER, ...clip.layer }, expressions: clip.expressions ?? {} })),
  }));
  return canonicalJson({ ...content, tracks: normalizeTracks(content.tracks),
    compositions: content.compositions.map(composition => ({ ...composition, tracks: normalizeTracks(composition.tracks) })),
    aestheticSystem: aesthetic });
}
