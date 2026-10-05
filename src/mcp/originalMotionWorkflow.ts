import type { EditProject } from "../domain/types";
import { getPlanOriginalMotionSources, autopilotCommands, type CurrentAutopilotPlan } from "../application/autopilotPlan";
import { originalMotionSourceAuthoringSchema, verifyOriginalMotionSourceEvidence } from "../application/originalMotionSourceEvidence";
import { type CanonicalOriginalMotionSourceSet } from "../application/originalMotionSourceSets";
import { verifyOriginalMotionSourceRevisionEvidence, verifyOriginalPaintedMediaSourceRevisionEvidence } from "../application/originalMotionSourceRevision";
import { issueOriginalSourceOwnerRevisionProof, type OriginalSourceOwnerRevisionProof } from "../domain/originalSourceOwnerRevision";
import type { EditorCommand } from "../domain/commandTypes";
import { assertOriginalRevisionFile } from "./originalMotionSourceRevisionFile";
import { sha256Canonical } from "../application/autopilotInvocationIdentity";
import { readOriginalMotionAuthoringSource, originalMotionTextProvider } from "./originalMotionSourceFile";
import { workspaceRoot } from "./storage";
import { resolve } from "node:path";
import { readBundledFontFace } from "../render/bundledFontSource";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { PREPARED_GLYPH_PARSER_VERSION } from "../typography/preparedGlyphRun";

const fontRoot = () => process.env.EDITKIN_FONT_ROOT ?? resolve(import.meta.dirname, "../../public/fonts");

/** Authored file fields are compared with the manifest, not only its declared SHA. */
export async function verifyOriginalMotionFiles(set: CanonicalOriginalMotionSourceSet, project: EditProject, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const rows = set.schema === "editkin.original-motion-source/v1" ? set.sources : set.sources.flatMap(source => [source.before, source.after]);
  for (const evidence of rows) {
    if (!evidence.authoringSource) throw new Error("Original Motion source file binding is required");
    const current = await readOriginalMotionAuthoringSource(evidence.authoringSource.sourcePath, workspaceRoot());
    if (sha256Canonical(current.source) !== sha256Canonical(evidence.authoringSource)
      || sha256Canonical(originalMotionSourceAuthoringSchema.parse(current.payload.authoring)) !== sha256Canonical(evidence.authoring)
      || sha256Canonical(current.payload.rights) !== sha256Canonical(evidence.rights) || current.payload.fps !== project.fps
      || current.payload.usage !== (evidence.authoring.intent === "standalone_showcase" ? "standalone" : "authored_overlay")) throw new Error("Original Motion authored file and manifest differ");
    const actualFonts = evidence.graphicBindings.filter(row => row.physicalFont).map(row => {
      const { schema: _schema, ...font } = row.physicalFont!;
      return { graphicId: row.graphicId, ...font };
    });
    const sortById = (left: { graphicId: string }, right: { graphicId: string }) => left.graphicId.localeCompare(right.graphicId, "en");
    if (sha256Canonical(actualFonts.sort(sortById)) !== sha256Canonical([...current.payload.fontBindings].sort(sortById))) throw new Error("Original Motion authoring font intent differs from prepared physical font identities");
    if (set.schema === "editkin.original-motion-source/v2" || set.schema === "editkin.original-motion-source/v3") {
      assertOriginalRevisionFile(evidence, current.payload, set.schema === "editkin.original-motion-source/v3" ? "painted_authored_overlay_preserve_media" : undefined);
      // A before-only face may no longer appear in the committed graphics.
      // Verify both real source faces here, including the render readback lane.
      for (const binding of evidence.graphicBindings) {
        if (!binding.physicalFont) continue;
        const element = evidence.authoring.elements.find(row => row.id === binding.graphicId);
        if (!element || element.kind !== "text") throw new Error("Original revision physical font has no actual source text");
        signal?.throwIfAborted();
        // The font reader verifies the real manifest and selected binary hash.
        // Glyph/layout compilation belongs to the independent compiler below;
        // repeating it here would inflate every audit/apply barrier.
        const spec = bundledFontFaceSpec(binding.physicalFont.faceId);
        await readBundledFontFace(fontRoot(), binding.physicalFont.faceId);
        if (spec.faceId !== binding.physicalFont.faceId || spec.sha256 !== binding.physicalFont.fontSha256
          || spec.manifestSha256 !== binding.physicalFont.manifestSha256 || PREPARED_GLYPH_PARSER_VERSION !== binding.physicalFont.parserVersion) {
          throw new Error("Original revision actual font bytes changed from the source binding");
        }
      }
      const afterPhysicalRead = await readOriginalMotionAuthoringSource(evidence.authoringSource.sourcePath, workspaceRoot());
      if (sha256Canonical(afterPhysicalRead) !== sha256Canonical(current)) throw new Error("Original revision source changed during physical font verification");
    }
  }
  signal?.throwIfAborted();
}

export async function verifyCurrentOriginalMotionEvidence(plan: CurrentAutopilotPlan, project: EditProject, signal?: AbortSignal,
  revisionAuthority?: { batch: EditorCommand; capture: (proof: OriginalSourceOwnerRevisionProof) => void }) {
  signal?.throwIfAborted();
  const set = getPlanOriginalMotionSources(plan);
  if (!set) return undefined;
  const projectSha256Before = sha256Canonical(project);
  if (plan.materialEvidence.schema !== "hao.editkin.material-intelligence/v1" && (project.assets.length || project.tracks.some(track => track.clips.length) || project.captions.length || project.scene3d?.enabled || project.scene25d?.enabled)) throw new Error("Standalone original run requires a genuinely media-free foreground project");
  await verifyOriginalMotionFiles(set, project, signal);
  const provider = originalMotionTextProvider(fontRoot());
  try {
    if (set.schema === "editkin.original-motion-source/v2" || set.schema === "editkin.original-motion-source/v3") {
      const runtime = {
        prepareText: async (face: string, text: string) => { signal?.throwIfAborted(); const run = await provider(face, text); signal?.throwIfAborted(); return run; },
      };
      const result = set.schema === "editkin.original-motion-source/v3"
        ? await verifyOriginalPaintedMediaSourceRevisionEvidence(set, project, autopilotCommands(plan), plan.editorial, runtime)
        : await verifyOriginalMotionSourceRevisionEvidence(set, project, autopilotCommands(plan), plan.editorial, runtime);
      await verifyOriginalMotionFiles(set, project, signal);
      signal?.throwIfAborted();
      if (sha256Canonical(project) !== projectSha256Before) throw new Error("Original revision project changed during independent file verification");
      if (revisionAuthority) {
        if (sha256Canonical(revisionAuthority.batch) !== sha256Canonical({ type: "batch", commands: autopilotCommands(plan) })) throw new Error("Original revision authority batch differs from independently recompiled plan");
        revisionAuthority.capture(issueOriginalSourceOwnerRevisionProof(project, revisionAuthority.batch));
      }
      return result;
    }
    return await verifyOriginalMotionSourceEvidence(set, project, autopilotCommands(plan), plan.editorial, {
      prepareText: provider,
      resolveAuthoringSource: async expected => (await readOriginalMotionAuthoringSource(expected.sourcePath, workspaceRoot())).source,
    });
  } finally { provider.dispose(); }
}
