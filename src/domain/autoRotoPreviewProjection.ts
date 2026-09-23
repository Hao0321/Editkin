import type { EditProject, RotoMatteSequence } from "./types";

function visitMatteSequences(project: EditProject, visitor: (sequence: RotoMatteSequence) => void): void {
  // The native open/save boundary still accepts schema 1-7 projects. Keep the
  // URL scrubber migration-safe so a legacy object cannot crash before the
  // authoritative native parser upgrades it to schema 8.
  const legacySafe = project as Partial<EditProject>;
  const tracks = [...(legacySafe.tracks ?? []), ...(legacySafe.compositions ?? []).flatMap((composition) => composition.tracks)];
  for (const track of tracks) {
    for (const clip of track.clips) {
      for (const mask of clip.masks ?? []) {
        if (mask.matteSequence) visitor(mask.matteSequence);
      }
    }
  }
}

/** Returns a durable clone that never persists process-local Tauri asset URLs. */
export function dehydrateAutoRotoFramePreviews(project: EditProject): EditProject {
  const durable = structuredClone(project);
  visitMatteSequences(durable, (sequence) => {
    sequence.framePreviewUris = undefined;
  });
  return durable;
}

/** Hydrates only paths that the native host already admitted to its file scope. */
export function hydrateAutoRotoFramePreviews(
  project: EditProject,
  allowedPaths: readonly string[],
  convert: (path: string) => string,
): EditProject {
  const hydrated = structuredClone(project);
  const allowed = new Set(allowedPaths);
  visitMatteSequences(hydrated, (sequence) => {
    if (sequence.staleReason !== "clip-time-range-changed"
      && sequence.frameArtifactUris?.length === sequence.frameCount
      && sequence.frameArtifactUris.every((path) => allowed.has(path))) {
      sequence.framePreviewUris = sequence.frameArtifactUris.map(convert);
    } else {
      sequence.framePreviewUris = undefined;
    }
  });
  return hydrated;
}
