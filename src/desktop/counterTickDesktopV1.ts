import type { HaoDesktopApi } from "./apiTypes";
import type { PickedMedia } from "./mediaTypes";
import type { ProjectSession } from "../application/projectSession";
import { prepareCounterTickPlacementV1 } from "../application/counterTickPlacementV1";
import type { ProceduralSfxLibraryEntryV1 } from "../domain/proceduralSfxLibraryContractV1";
import { proceduralSfxLibraryRequestV1Schema } from "../domain/proceduralSfxLibraryContractV1";
import { assertOriginalSfxCandidateSummaryV1, type OriginalSfxCandidateAssetV1 } from "../domain/originalSfxCandidateContractV1";
import { proceduralSfxRecipeV1 } from "../application/proceduralSfxCatalogueV1";
import { creativeAssetUri } from "../shared/creativeAssetUri";

type Api = Pick<HaoDesktopApi, "listOriginalSfxCandidates" | "resolveOriginalSfxCandidate" | "prepareMedia">;
function entry(asset: OriginalSfxCandidateAssetV1): ProceduralSfxLibraryEntryV1 {
  const recipe = proceduralSfxRecipeV1(asset.id), provenance = /^Local original mathematical synthesis; source-sha256=([a-f0-9]{64}); wav-sha256=([a-f0-9]{64})$/.exec(asset.provenance);
  if (!provenance || asset.duration !== recipe.durationSamples / 48_000 || asset.bytes !== 44 + recipe.durationSamples * 2
    || asset.rightsBasis !== recipe.rightsBasis) throw new Error("COUNTER_SOURCE_METADATA_INVALID");
  return { id: asset.id, name: asset.name, kind: recipe.kind, sha256: provenance[2], bytes: asset.bytes, durationSamples: recipe.durationSamples,
    durationSeconds: recipe.durationSamples / 48_000, sourceSha256: provenance[1], source: recipe.source, rightsBasis: recipe.rightsBasis,
    distributionScope: recipe.distributionScope, certification: recipe.certification, defaultEnabled: false, redistributable: false, contentVerified: false };
}
function verifyPicked(picked: PickedMedia & { absolutePath: string }, listed: OriginalSfxCandidateAssetV1, expected: ProceduralSfxLibraryEntryV1) {
  const a = picked.asset, path = picked.absolutePath;
  if (!picked.previewUrl?.trim() || typeof path !== "string" || !/^(?:[a-z]:[\\/]|\/(?!\/))/i.test(path)
    || /^[\\/]{2}/.test(path) || /[\u0000-\u001f]/.test(path) || path.split(/[\\/]/).includes("..")
    || a.kind !== "audio" || a.uri !== creativeAssetUri(expected.id) || a.role !== "sound-effect" || a.redistributable !== false
    || a.distributionScope !== "private-owner-only" || a.rightsBasis !== expected.rightsBasis || a.provenance !== listed.provenance
    || a.license !== listed.license || a.name !== listed.name || !Number.isFinite(a.duration) || Math.abs(a.duration - expected.durationSeconds) > 1 / 48_000 + 1e-9) throw new Error("COUNTER_VERIFIED_HOST_REPLY_INVALID");
}

/** Existing host import verifies complete original WAV/SOURCE and probes it. No renderer-supplied root or fake PCM. */
export async function prepareCounterTickDesktopV1(session: ProjectSession, api: Api, payload: unknown, signal?: AbortSignal) {
  if (!api.listOriginalSfxCandidates || !api.resolveOriginalSfxCandidate) throw new Error("COUNTER_DESKTOP_API_REQUIRED");
  const project = session.getSnapshot().history.present, task = session.beginTask(project), pickedById = new Map<string, PickedMedia & { absolutePath: string }>();
  const current = () => { signal?.throwIfAborted(); if (!task.isCurrent()) throw new Error("COUNTER_PROJECT_CHANGED"); };
  let sources: Map<string, OriginalSfxCandidateAssetV1> | undefined;
  const host = {
    list: async (payload: { offset?: number; limit?: number; kind?: ProceduralSfxLibraryEntryV1["kind"] } = {}, operationSignal?: AbortSignal) => {
      current(); operationSignal?.throwIfAborted();
      if (!sources) {
        const reply = await api.listOriginalSfxCandidates!(); current(); operationSignal?.throwIfAborted(); assertOriginalSfxCandidateSummaryV1(reply);
        sources = new Map(structuredClone(reply.assets).map(a => [a.id, a]));
      }
      const request = proceduralSfxLibraryRequestV1Schema.parse({ ...payload, operation: "list" });
      if (request.operation !== "list") throw new Error("COUNTER_LIST_INVALID");
      const rows = [...sources.values()].map(entry).filter(e => !request.kind || e.kind === request.kind), end = Math.min(rows.length, request.offset + request.limit);
      return { entries: rows.slice(request.offset, end), total: rows.length, ...(end < rows.length ? { nextOffset: end } : {}) };
    },
    resolve: async (reference: { id: string; sha256: string }, operationSignal?: AbortSignal) => {
      signal?.throwIfAborted(); operationSignal?.throwIfAborted();
      const listed = sources?.get(reference.id); if (!listed) throw new Error("COUNTER_SOURCE_NOT_LISTED");
      const expected = entry(listed); if (reference.sha256 !== expected.sha256) throw new Error("COUNTER_SOURCE_SHA_CONFLICT");
      const picked = await api.resolveOriginalSfxCandidate!(reference.id); signal?.throwIfAborted(); operationSignal?.throwIfAborted();
      verifyPicked(picked, listed, expected); pickedById.set(reference.id, structuredClone(picked));
      return { entry: { ...expected, contentVerified: true }, absolutePath: picked.absolutePath };
    },
  };
  const prepared = await prepareCounterTickPlacementV1(session, host, payload, signal); current();
  if (prepared.placement.command.type !== "batch") throw new Error("COUNTER_BATCH_REQUIRED");
  const imported = prepared.placement.command.commands.filter(c => c.type === "import_asset");
  if (imported.length !== 1 || imported[0].type !== "import_asset") throw new Error("COUNTER_SINGLE_SOURCE_REQUIRED");
  const asset = structuredClone(imported[0].asset), hostPicked = pickedById.get(prepared.visual.soundId)!;
  const media = await api.prepareMedia(asset); current();
  if (media.assetId !== asset.id || media.derivatives?.sourceSha256 !== prepared.wavSha256 || typeof media.runtimeUrls?.[asset.id] !== "string"
    || !media.runtimeUrls[asset.id].trim()) throw new Error("COUNTER_MEDIA_SOURCE_SHA_INVALID");
  return { ...prepared, media, picked: { asset, previewUrl: hostPicked.previewUrl } satisfies PickedMedia };
}
