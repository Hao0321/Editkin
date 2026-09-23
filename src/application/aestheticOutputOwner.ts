import type { EditProject } from "../domain/types";
import type { RenderArtifactIdentity } from "../render/renderArtifactIdentity";
import { renderReviewContentJson } from "../shared/renderReviewContent";

const SHA256 = /^[a-f0-9]{64}$/;

export function isRenderArtifactIdentity(value: unknown): value is RenderArtifactIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row.schema === "editkin.render-artifact-identity/v1"
    && typeof row.outputSha256 === "string" && SHA256.test(row.outputSha256)
    && typeof row.projectContentSha256 === "string" && SHA256.test(row.projectContentSha256)
    && typeof row.bytes === "number" && Number.isSafeInteger(row.bytes) && row.bytes > 0
    && typeof row.fps === "number" && Number.isFinite(row.fps) && row.fps > 0
    && typeof row.durationFrames === "number" && Number.isSafeInteger(row.durationFrames) && row.durationFrames > 0
    && Number.isFinite(row.durationFrames / row.fps);
}

/** In-memory output ownership, not human provenance or certification.
 * Call bind only with the renderer's result.artifactIdentity, never review.artifact.
 * App must reset on session replacement, even when the new project has the same ID/content. */
export function createAestheticOutputOwner(subtle: Pick<SubtleCrypto, "digest"> = globalThis.crypto.subtle) {
  let generation = 0;
  let retained: { content: string; artifact: RenderArtifactIdentity } | undefined;
  return {
    reset(): void { generation += 1; retained = undefined; },
    async bind(project: EditProject, artifact: unknown): Promise<boolean> {
      const token = ++generation;
      retained = undefined;
      if (!isRenderArtifactIdentity(artifact)) return false;
      const snapshot = structuredClone(artifact);
      const content = renderReviewContentJson(project);
      try {
        const digest = await subtle.digest("SHA-256", new TextEncoder().encode(content));
        const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
        if (token !== generation || hash !== snapshot.projectContentSha256) return false;
        retained = { content, artifact: snapshot };
        return true;
      } catch {
        // Do not let an older failed digest clear a newer successful binding.
        if (token === generation) retained = undefined;
        return false;
      }
    },
    get(project: EditProject): RenderArtifactIdentity | undefined {
      if (!retained || retained.content !== renderReviewContentJson(project)) return undefined;
      return structuredClone(retained.artifact);
    },
  };
}
