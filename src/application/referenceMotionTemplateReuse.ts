import * as z from "zod/v4";
import type { EditProject, MediaAsset, TimelineClip } from "../domain/types";
import { applyCommand } from "../domain/commands";
import { validateProject } from "../domain/editGraph";
import { referenceMotionTemplateInputSchema } from "../motion/referenceMotionTemplates";
import { canonicalJson } from "../shared/canonicalJson";
import { inspectReferenceMotionTemplateInstance, prepareReferenceMotionTemplateInstance,
  type ReferenceMotionTemplateInstanceIdFactory } from "./referenceMotionTemplateInstances";
import { REFERENCE_MOTION_PREPARATION_TIMEOUT_MS,
  type ReferenceMotionTemplatePreparationDependencies } from "./referenceMotionTemplates";

const id = z.string().min(1).max(160).refine(value => value.trim() === value, "Reuse identities cannot contain surrounding whitespace");
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** A new source selection is required even for a recipe with zero extra slots.
 * There are deliberately no copy/style/clock/QA overrides in this vocabulary. */
export const referenceMotionTemplateReuseRequestSchema = z.strictObject({
  sourceInstanceId: id,
  expectedInstanceRevision: revision.positive(),
  expectedProjectRevision: revision,
  targetClipId: id,
  purpose: referenceMotionTemplateInputSchema.shape.purpose,
  evidenceRefs: referenceMotionTemplateInputSchema.shape.evidenceRefs,
  sources: referenceMotionTemplateInputSchema.shape.sources.removeDefault(),
  focusRegion: referenceMotionTemplateInputSchema.shape.focusRegion,
});
export type ReferenceMotionTemplateReuseRequest = z.input<typeof referenceMotionTemplateReuseRequestSchema>;
export type ReferenceMotionTemplateReuseDependencies = ReferenceMotionTemplatePreparationDependencies;
export interface ReferenceMotionTemplateReuseOrigin {
  sourceInstanceId: string;
  expectedInstanceRevision: number;
  sourceScopeSha256: string;
}

function exactFrame(seconds: number, fps: number, label: string): number {
  const frames = seconds * fps, rounded = Math.round(frames);
  if (!Number.isFinite(seconds) || seconds < 0 || !Number.isSafeInteger(rounded)
    || Math.abs(frames - rounded) > 1e-7) throw new Error(`Saved reuse ${label} must already be an exact safe project frame`);
  return rounded;
}

/** This is a graph selector check, not byte measurement or a rights verifier.
 * The existing material/source authority must still observe the new source. */
export function referenceMotionReuseSourceIdentity(uri: string): string {
  if (typeof uri !== "string" || !uri || uri.trim() !== uri || /[\u0000\r\n]/.test(uri)) {
    throw new Error("Saved reuse requires an existing source URI");
  }
  try {
    let path = uri.replace(/\\/g, "/"), prefix = "file:";
    if (/^file:/i.test(path)) {
      const url = new URL(path);
      path = `${url.hostname && url.hostname !== "localhost" ? `//${url.hostname}` : ""}${decodeURIComponent(url.pathname)}`;
      if (/^\/[a-z]:\//i.test(path)) path = path.slice(1);
    } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
      const url = new URL(path);
      prefix = `${url.protocol}//${url.host}/`;
      path = decodeURIComponent(url.pathname);
      prefix += `${url.search}${url.hash}|`;
    } else path = decodeURIComponent(path);
    path = path.replace(/\\/g, "/");
    if (/[\u0000\r\n]/.test(path)) throw new Error("Invalid decoded source path");
    const unc = path.startsWith("//"), absolute = path.startsWith("/") || /^[a-z]:\//i.test(path);
    const parts: string[] = [], floor = unc ? 2 : /^[a-z]:\//i.test(path) ? 1 : 0;
    for (const part of path.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") {
        if (parts.length > floor && parts.at(-1) !== "..") parts.pop();
        else if (!absolute) parts.push(part);
        else throw new Error("Source path escapes its lexical root");
      } else parts.push(part);
    }
    return `${prefix}${unc ? "//" : absolute && floor === 0 ? "/" : ""}${parts.join("/")}`.toLowerCase();
  }
  catch { throw new Error("Saved reuse source URI is malformed"); }
}
const sourceIdentity = (asset: MediaAsset) => referenceMotionReuseSourceIdentity(asset.uri);

function targetWindow(project: EditProject, clip: TimelineClip, asset: MediaAsset) {
  if (!Number.isFinite(project.fps) || project.fps <= 0 || project.fps > 240) throw new Error("Saved reuse requires the current valid project frame rate");
  const startFrame = exactFrame(clip.timelineStart, project.fps, "timeline start");
  const sourceStartFrame = exactFrame(clip.sourceStart, project.fps, "source start");
  const durationFrames = exactFrame(clip.duration, project.fps, "duration");
  if (!Number.isSafeInteger(startFrame + durationFrames) || !Number.isSafeInteger(sourceStartFrame + durationFrames)
    || !durationFrames || !Number.isFinite(asset.duration) || asset.duration <= 0
    || clip.sourceStart + clip.duration > asset.duration + 1e-7 / project.fps) {
    throw new Error("Saved reuse target has an unsafe or out-of-source frame window");
  }
  return { startFrame, sourceStartFrame, durationFrames };
}

/** Pure, unapplied creation of a separate owner on a different imported clip.
 * Source bytes, source rights and current artwork are NOT inherited or verified
 * here. Returned commands still require current v4 audit/apply and new material. */
export async function prepareReferenceMotionTemplateReuse(project: EditProject,
  rawRequest: ReferenceMotionTemplateReuseRequest, idFactory: ReferenceMotionTemplateInstanceIdFactory,
  dependencies: ReferenceMotionTemplateReuseDependencies) {
  const deadline = performance.now() + REFERENCE_MOTION_PREPARATION_TIMEOUT_MS;
  if (typeof dependencies?.prepareText !== "function") throw new Error("FONT_BYTES_REQUIRED: saved reuse requires a true physical glyph provider");
  if (typeof idFactory !== "function") throw new Error("Saved reuse requires a fresh identity allocator");
  const beforeProject = canonicalJson(project), beforeRequest = canonicalJson(rawRequest);
  const snapshot = structuredClone(project), request = referenceMotionTemplateReuseRequestSchema.parse(structuredClone(rawRequest));
  const controller = new AbortController();
  const cancel = () => controller.abort();
  dependencies.signal?.addEventListener("abort", cancel, { once: true });
  if (dependencies.signal?.aborted) cancel();
  const timer = setTimeout(cancel, Math.max(0, deadline - performance.now()));
  const check = () => {
    if (performance.now() >= deadline) throw new Error("Saved reuse exceeded its original 10-second deadline");
    if (controller.signal.aborted) throw new Error("Saved reuse preparation cancelled; no commands were applied");
    if (canonicalJson(project) !== beforeProject || canonicalJson(rawRequest) !== beforeRequest) {
      throw new Error("Saved reuse project, source or input generation changed during preparation");
    }
  };
  const bounded = async <T>(operation: () => Promise<T>): Promise<T> => {
    check();
    return new Promise<T>((resolve, reject) => {
      const stop = () => {
        try { check(); } catch (error) { reject(error); }
      };
      const dispose = () => controller.signal.removeEventListener("abort", stop);
      controller.signal.addEventListener("abort", stop, { once: true });
      if (controller.signal.aborted) { dispose(); stop(); return; }
      try {
        operation().then(value => { dispose(); try { check(); resolve(value); } catch (error) { reject(error); } },
          error => { dispose(); reject(error); });
      } catch (error) { dispose(); reject(error); }
    });
  };
  try {
    check(); validateProject(snapshot);
    if (snapshot.revision !== request.expectedProjectRevision) throw new Error("Saved reuse project revision is stale");
    const inspection = await bounded(() => inspectReferenceMotionTemplateInstance(snapshot, request.sourceInstanceId));
    if (inspection.status !== "CURRENT" || !inspection.instance) throw new Error(`${inspection.status}: ${inspection.reason}`);
    const sourceInstance = inspection.instance;
    if (sourceInstance.instanceRevision !== request.expectedInstanceRevision) throw new Error("Saved reuse source instance revision is stale");
    if (request.evidenceRefs.some(ref => sourceInstance.input.evidenceRefs.includes(ref))) {
      throw new Error("Saved reuse requires fresh target evidence; previous source references cannot be reused as new observation");
    }
    if (sourceInstance.input.clipId === request.targetClipId) throw new Error("Saved reuse requires a different target clip");
    const original = snapshot.tracks.flatMap(track => track.clips).find(clip => clip.id === sourceInstance.input.clipId);
    const originalAsset = snapshot.assets.find(asset => asset.id === original?.assetId);
    if (!original || !originalAsset) throw new Error("MISSING: saved reuse original source no longer exists");
    const targetTrack = snapshot.tracks.find(track => track.clips.some(clip => clip.id === request.targetClipId));
    const target = targetTrack?.clips.find(clip => clip.id === request.targetClipId);
    const asset = snapshot.assets.find(asset => asset.id === target?.assetId);
    if (!target || !targetTrack || targetTrack.kind !== "video" || targetTrack.locked || targetTrack.muted
      || target.layer?.enabled === false || (target.layer?.role !== undefined && target.layer.role !== "content")
      || !asset || asset.kind !== "video" || asset.compositionId || asset.imageSequence) {
      throw new Error("Saved reuse target requires a distinct editable, unmuted real video clip");
    }
    if ((snapshot.referenceMotionInstances ?? []).some(instance => instance.input.clipId === target.id
      || instance.roles.some(role => role.id === target.id || role.parentId === target.id))
      || snapshot.templateApplication?.generatedClips?.some(clip => clip.clipId === target.id)
      || snapshot.templateApplication?.applied.clips.some(clip => clip.clipId === target.id)) {
      throw new Error("Saved reuse target is already owned by another template instance");
    }
    if (asset.id === originalAsset.id || sourceIdentity(asset) === sourceIdentity(originalAsset)
      || (asset.derivatives?.sourceSha256 !== undefined && originalAsset.derivatives?.sourceSha256 !== undefined
        && asset.derivatives.sourceSha256 === originalAsset.derivatives.sourceSha256)) {
      throw new Error("Saved reuse needs different content, not the same asset, URI or pinned source-byte alias");
    }
    const window = targetWindow(snapshot, target, asset);
    for (const source of request.sources) exactFrame(source.sourceStart, snapshot.fps, "additional source start");
    const selectedAssets = [asset, ...request.sources.map(source => {
      const selected = snapshot.assets.find(item => item.id === source.assetId);
      if (!selected) throw new Error("Saved reuse additional source is missing");
      return selected;
    })];
    const selectedPaths = selectedAssets.map(sourceIdentity), selectedPins = selectedAssets.flatMap(item => item.derivatives?.sourceSha256 ? [item.derivatives.sourceSha256] : []);
    if (new Set(selectedPaths).size !== selectedPaths.length || new Set(selectedPins).size !== selectedPins.length) {
      throw new Error("Saved reuse additional sources must be distinct content, not path or pinned source-byte aliases");
    }
    const input = structuredClone(sourceInstance.input);
    input.clipId = target.id;
    input.startFrame = window.startFrame;
    input.durationFrames = window.durationFrames;
    input.sources = structuredClone(request.sources);
    input.purpose = request.purpose;
    input.evidenceRefs = [...request.evidenceRefs];
    // An observed crop belongs to the old scene. New source evidence must make
    // this selection explicitly; brand_recap otherwise contains the full source.
    delete input.focusRegion;
    if (request.focusRegion !== undefined) input.focusRegion = structuredClone(request.focusRegion);
    if (input.templateId === "comparison_pair" && input.mediaPresentation === undefined) {
      throw new Error("Saved reuse cannot implicitly upgrade an omitted historical comparison presentation");
    }
    const prepared = await bounded(() => prepareReferenceMotionTemplateInstance(snapshot, input, idFactory, {
      signal: controller.signal,
      prepareText: async (faceId, text) => { check(); const run = await bounded(() => dependencies.prepareText(faceId, text)); check(); return run; },
    }));
    check();
    const candidate = applyCommand(snapshot, { type: "batch", commands: prepared.commands });
    const retained = await bounded(() => inspectReferenceMotionTemplateInstance(candidate, sourceInstance.id));
    if (retained.status !== "CURRENT" || !retained.instance
      || canonicalJson(retained.instance) !== canonicalJson(sourceInstance)) {
      throw new Error("Saved reuse commands changed the original saved template owner or managed scope");
    }
    const created = await bounded(() => inspectReferenceMotionTemplateInstance(candidate, prepared.instance.id));
    if (created.status !== "CURRENT") throw new Error("Saved reuse commands did not recreate the new current instance scope");
    const reusedFrom: ReferenceMotionTemplateReuseOrigin = {
      sourceInstanceId: sourceInstance.id, expectedInstanceRevision: sourceInstance.instanceRevision,
      sourceScopeSha256: sourceInstance.appliedScopeSha256,
    };
    check();
    return { ...prepared, status: "PREPARED_NOT_APPLIED" as const, readOnly: true as const, reusedFrom,
      planDeclaration: { schema: "editkin.reference-motion-plan/v1" as const, instances: [{
        instanceId: prepared.instance.id, mode: "create" as const,
        commandIndexes: prepared.commands.map((_, index) => index), reuseOrigin: { ...reusedFrom },
      }] },
      reuseBinding: { sourceInstanceId: sourceInstance.id, targetClipId: target.id, targetAssetId: asset.id,
        sourceUri: asset.uri, sourceStartFrame: window.sourceStartFrame, startFrame: window.startFrame,
        durationFrames: window.durationFrames, sourceRights: "new_source_validation_required" as const,
        previousQaOrArtworkApprovalReusable: false as const },
    };
  } finally {
    clearTimeout(timer); dependencies.signal?.removeEventListener("abort", cancel); controller.abort();
  }
}

export type ReferenceMotionTemplateReusePreparation = Awaited<ReturnType<typeof prepareReferenceMotionTemplateReuse>>;
