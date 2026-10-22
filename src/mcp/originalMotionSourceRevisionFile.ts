import { canonicalJson } from "../shared/canonicalJson";
import type { EditProject } from "../domain/types";
import { prepareOriginalMotionSourceRevisionEvidence, originalMotionSourceRevisionSetSchema,
  prepareOriginalPaintedMediaSourceRevisionEvidence, originalPaintedMediaSourceRevisionSetSchema } from "../application/originalMotionSourceRevision";
import { readOriginalMotionAuthoringSource, originalMotionTextProvider, type OriginalMotionAuthoringFile } from "./originalMotionSourceFile";
import type { OriginalMotionSourceEvidence } from "../application/originalMotionSourceEvidence";

export type PaintedMediaRevisionScope = "painted_authored_overlay_preserve_media";
export function assertOriginalRevisionFile(evidence: OriginalMotionSourceEvidence, payload: OriginalMotionAuthoringFile,
  revisionScope?: PaintedMediaRevisionScope): void {
  if (revisionScope !== undefined && revisionScope !== "painted_authored_overlay_preserve_media") throw new Error("Original revision file scope is invalid");
  const painted = revisionScope === "painted_authored_overlay_preserve_media";
  if (canonicalJson(evidence.authoring) !== canonicalJson(payload.authoring)
    || canonicalJson(evidence.rights) !== canonicalJson(payload.rights)
    || evidence.project.fps !== payload.fps
    || payload.usage !== (painted ? "authored_overlay" : "standalone") || payload.audio !== (painted ? "preserve_source_audio" : "silent")
    || painted && payload.authoring.elements.some(element => element.paintV1?.schema !== "editkin.motion-paint/v2"
      || element.paintV1.colorIntent !== "display_rec709_sdr")) {
    throw new Error("Original revision file payload/rights/usage differs from the actual compilation");
  }
  const actual = evidence.graphicBindings.flatMap(binding => binding.physicalFont ? [{ graphicId: binding.graphicId,
    faceId: binding.physicalFont.faceId, fontSha256: binding.physicalFont.fontSha256,
    manifestSha256: binding.physicalFont.manifestSha256, parserVersion: binding.physicalFont.parserVersion }] : []);
  const byId = (a: { graphicId: string }, b: { graphicId: string }) => a.graphicId.localeCompare(b.graphicId, "en");
  if (canonicalJson(actual.sort(byId)) !== canonicalJson([...payload.fontBindings].sort(byId))) {
    throw new Error("Original revision file font pins differ from actual physical compilation");
  }
}

export interface OriginalMotionRevisionFileOptions { workspace: string; fontRoot: string; signal?: AbortSignal; revisionScope?: PaintedMediaRevisionScope }
function filePreparationV1(prepared: Awaited<ReturnType<typeof prepareOriginalMotionSourceRevisionEvidence>>) {
  return { schema: "editkin.original-motion-source-file-revision-preparation/v1" as const,
    sourceSet: originalMotionSourceRevisionSetSchema.parse({ schema: "editkin.original-motion-source/v2", sources: [prepared.evidence] }), ...prepared };
}
function filePreparationV2(prepared: Awaited<ReturnType<typeof prepareOriginalPaintedMediaSourceRevisionEvidence>>) {
  return { schema: "editkin.original-motion-source-file-revision-preparation/v2" as const,
    sourceSet: originalPaintedMediaSourceRevisionSetSchema.parse({ schema: "editkin.original-motion-source/v3", sources: [prepared.evidence] }), ...prepared };
}

/** Two immutable authored files, with literal historical authoring revisions.
 * The comparison compiler never deletes/re-adds an owner in the live project. */
export function prepareOriginalMotionSourceRevisionFile(project: EditProject, beforeSourcePath: string, afterSourcePath: string,
  commandIndexOffset: number, options: OriginalMotionRevisionFileOptions & { revisionScope?: undefined }): Promise<ReturnType<typeof filePreparationV1>>;
export function prepareOriginalMotionSourceRevisionFile(project: EditProject, beforeSourcePath: string, afterSourcePath: string,
  commandIndexOffset: number, options: OriginalMotionRevisionFileOptions & { revisionScope: PaintedMediaRevisionScope }): Promise<ReturnType<typeof filePreparationV2>>;
export function prepareOriginalMotionSourceRevisionFile(project: EditProject, beforeSourcePath: string, afterSourcePath: string,
  commandIndexOffset: number, options: OriginalMotionRevisionFileOptions): Promise<ReturnType<typeof filePreparationV1> | ReturnType<typeof filePreparationV2>>;
export async function prepareOriginalMotionSourceRevisionFile(project: EditProject, beforeSourcePath: string,
  afterSourcePath: string, commandIndexOffset: number, options: OriginalMotionRevisionFileOptions) {
  options.signal?.throwIfAborted();
  if (options.revisionScope !== undefined && options.revisionScope !== "painted_authored_overlay_preserve_media") throw new Error("Original revision file scope is invalid");
  if (beforeSourcePath === afterSourcePath) throw new Error("Original revision requires distinct immutable before/after files");
  const before = await readOriginalMotionAuthoringSource(beforeSourcePath, options.workspace);
  const after = await readOriginalMotionAuthoringSource(afterSourcePath, options.workspace);
  if (before.payload.fps !== project.fps || after.payload.fps !== project.fps) throw new Error("Original revision file fps differs from current project");
  const provider = originalMotionTextProvider(options.fontRoot);
  try {
    const input = {
      before: { authoring: before.payload.authoring, rights: before.payload.rights, authoringSource: before.source },
      after: { authoring: after.payload.authoring, rights: after.payload.rights, authoringSource: after.source },
    };
    const runtime = { prepareText: async (face: string, text: string) => {
      options.signal?.throwIfAborted(); const run = await provider(face, text); options.signal?.throwIfAborted(); return run;
    } };
    const prepared = options.revisionScope === "painted_authored_overlay_preserve_media"
      ? await prepareOriginalPaintedMediaSourceRevisionEvidence(project, input, commandIndexOffset, runtime)
      : await prepareOriginalMotionSourceRevisionEvidence(project, input, commandIndexOffset, runtime);
    assertOriginalRevisionFile(prepared.evidence.before, before.payload, options.revisionScope);
    assertOriginalRevisionFile(prepared.evidence.after, after.payload, options.revisionScope);
    for (const loaded of [before, after]) {
      const current = await readOriginalMotionAuthoringSource(loaded.source.sourcePath, options.workspace);
      if (canonicalJson(current) !== canonicalJson(loaded)) throw new Error("Original revision source file changed during preparation");
    }
    options.signal?.throwIfAborted();
    if (prepared.evidence.schema === "editkin.original-motion-source-revision-evidence/v2") {
      return filePreparationV2({ ...prepared, evidence: prepared.evidence,
        preparation: { ...prepared.preparation, schema: "editkin.original-motion-source-revision-preparation/v2" } });
    }
    return filePreparationV1({ ...prepared, evidence: prepared.evidence,
      preparation: { ...prepared.preparation, schema: "editkin.original-motion-source-revision-preparation/v1" } });
  } finally { provider.dispose(); }
}
