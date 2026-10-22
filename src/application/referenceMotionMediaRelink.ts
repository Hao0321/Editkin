import type { EditProject } from "../domain/types";
import type { EditorCommand } from "../domain/commandTypes";
import type { ReferenceMotionTemplateInstance } from "../domain/referenceMotionInstance";
import { applyCommand } from "../domain/commands";
import { validateProject } from "../domain/editGraph";
import { canonicalJson } from "../shared/canonicalJson";
import { inspectReferenceMotionTemplateInstance, referenceMotionTemplateInstanceScopeSha256 } from "./referenceMotionTemplateInstances";

export interface ReferenceMotionMediaRelinkPreparation {
  status: "PREPARED_NOT_APPLIED" | "UNCHANGED";
  readOnly: true;
  commands: EditorCommand[];
  sourceGeneration: { projectId: string; projectRevision: number; projectSha256: string };
  binding: { assetId: string; previousUri: string; sourceUri: string; expectedSourceSha256: string };
  affectedInstances: Array<{ instanceId: string; expectedInstanceRevision: number;
    before: ReferenceMotionTemplateInstance; after: ReferenceMotionTemplateInstance }>;
}

async function sha256(value: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("Web Crypto SHA-256 is required for saved-media relocation identity");
  const result = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(result), byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Browser-safe syntax guard only. The formal ingress owns realpath, regular-file,
 * full-byte SHA, true probe and workspace checks; this producer performs no I/O. */
function assertAbsoluteLocalUri(uri: string): void {
  if (typeof uri !== "string" || !uri || uri.trim() !== uri || uri.length > 1024 || /[\u0000\r\n]/.test(uri)
    || !( /^[A-Za-z]:[\\/]/.test(uri) || /^\/[^/]/.test(uri))) {
    throw new Error("Saved-media relocation requires a canonical absolute local file path");
  }
}

/** Pure graph preparation for an explicitly verified SAME-BYTE relocation.
 * A caller-supplied digest is not source authority or legal rights verification.
 * Only the formal neutral-relocation boundary may execute the returned commands;
 * ordinary editing and v4 plans must not use them to replace source media. */
export async function prepareReferenceMotionMediaRelink(project: EditProject, assetId: string,
  sourceUri: string, expectedSourceSha256: string): Promise<ReferenceMotionMediaRelinkPreparation> {
  assertAbsoluteLocalUri(sourceUri);
  if (typeof assetId !== "string" || !assetId || assetId.trim() !== assetId || assetId.length > 160) {
    throw new Error("Saved-media relocation requires an existing asset identity");
  }
  if (typeof expectedSourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(expectedSourceSha256)) {
    throw new Error("Saved-media relocation requires a previously pinned SHA-256");
  }
  const signature = canonicalJson(project), snapshot = structuredClone(project);
  validateProject(snapshot);
  const check = () => {
    if (canonicalJson(project) !== signature) throw new Error("Saved-media relocation project changed during preparation");
  };
  const asset = snapshot.assets.find(value => value.id === assetId);
  if (!asset || (asset.kind !== "video" && asset.kind !== "audio") || asset.compositionId || asset.imageSequence
    || /^(?:creative|editkin-composition|blob|data|https?):/i.test(asset.uri)) {
    throw new Error("Saved-media relocation supports existing ordinary single-file video/audio only");
  }
  if (asset.derivatives?.sourceSha256 !== expectedSourceSha256) {
    throw new Error("Saved-media relocation SHA-256 differs from the existing pinned source");
  }
  const sourceGeneration = { projectId: snapshot.id, projectRevision: snapshot.revision, projectSha256: await sha256(signature) };
  check();
  const binding = { assetId, previousUri: asset.uri, sourceUri, expectedSourceSha256 };
  const sourceClips = snapshot.tracks.flatMap(track => track.clips);
  const affected: ReferenceMotionTemplateInstance[] = [];
  for (const instance of snapshot.referenceMotionInstances ?? []) {
    const primary = sourceClips.find(clip => clip.id === instance.input.clipId);
    // The primary asset is identified by the actual clip, not duplicated in
    // instance input. Without that clip we cannot prove this owner unrelated.
    if (!primary) throw new Error(`MISSING: cannot establish saved source ownership (${instance.id})`);
    if (primary.assetId === assetId || instance.input.sources.some(source => source.assetId === assetId)) affected.push(instance);
  }
  const beforeInstances: ReferenceMotionTemplateInstance[] = [];
  for (const instance of affected) {
    const inspection = await inspectReferenceMotionTemplateInstance(snapshot, instance.id);
    check();
    if (inspection.status !== "CURRENT" || !inspection.instance) {
      throw new Error(`${inspection.status}: saved-media relocation cannot refresh an edited or stale template (${instance.id}): ${inspection.reason}`);
    }
    beforeInstances.push(structuredClone(inspection.instance));
  }
  if (asset.uri === sourceUri) {
    return { status: "UNCHANGED", readOnly: true, commands: [], sourceGeneration, binding,
      affectedInstances: beforeInstances.map(before => ({ instanceId: before.id, expectedInstanceRevision: before.instanceRevision,
        before, after: structuredClone(before) })) };
  }
  const commands: EditorCommand[] = [{ type: "relink_asset_source", assetId, sourceUri, expectedSourceSha256 }];
  const relocated = applyCommand(snapshot, commands[0]);
  const affectedInstances: ReferenceMotionMediaRelinkPreparation["affectedInstances"] = [];
  for (const before of beforeInstances) {
    if (!Number.isSafeInteger(before.instanceRevision + 1)) throw new Error("Saved-media relocation instance revision is unsafe");
    const after = { ...structuredClone(before), instanceRevision: before.instanceRevision + 1 };
    // URI remains part of this exact fingerprint. No visual, recipe, input,
    // clock or physical-glyph dependency is regenerated or removed.
    after.appliedScopeSha256 = await referenceMotionTemplateInstanceScopeSha256(relocated, after);
    check();
    commands.push({ type: "upsert_reference_motion_instance", instance: after, expectedInstanceRevision: before.instanceRevision });
    affectedInstances.push({ instanceId: before.id, expectedInstanceRevision: before.instanceRevision, before, after });
  }
  const candidate = applyCommand(snapshot, { type: "batch", commands });
  for (const row of affectedInstances) {
    const inspection = await inspectReferenceMotionTemplateInstance(candidate, row.instanceId);
    check();
    if (inspection.status !== "CURRENT") throw new Error("Saved-media relocation commands did not reproduce the exact current saved scope");
  }
  check();
  return { status: "PREPARED_NOT_APPLIED", readOnly: true, commands, sourceGeneration, binding, affectedInstances };
}
