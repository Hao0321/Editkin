import type { CreativeLibraryAsset, CreativeLibrarySummary } from "../application/creativeLibrary";

export const ORIGINAL_SFX_CANDIDATE_CATEGORY_V1 = "original-sfx-candidate";
export interface OriginalSfxCandidateAssetV1 extends CreativeLibraryAsset {
  category: "original-sfx-candidate"; mediaKind: "audio"; redistributable: false;
  distributionScope: "private-owner-only"; certification: "AUDIO_PENDING_HAO_CLAUDE"; defaultEnabled: false;
}
export interface OriginalSfxCandidateSummaryV1 extends CreativeLibrarySummary {
  candidateOnly: true; defaultEnabled: false; assets: OriginalSfxCandidateAssetV1[];
}
export function isOriginalSfxCandidateIdV1(id: string): boolean {
  return /^sfx:editkin-procedural-v1-(whoosh|pop|ding|riser|impact|tick|cash|glitch)-0[1-5]$/.test(id);
}
export function assertOriginalSfxCandidateSummaryV1(value: OriginalSfxCandidateSummaryV1) {
  if (!value || value.candidateOnly !== true || value.defaultEnabled !== false || !Array.isArray(value.assets) || value.assets.length !== 40
    || value.assetCount !== 40 || value.sfxAssetCount !== 40 || value.musicAssetCount !== 0 || value.restrictedAssetCount !== 40
    || new Set(value.assets.map(a => a.id)).size !== 40 || value.assetBytes !== value.assets.reduce((n, a) => n + a.bytes, 0)) throw new Error("SFX_CANDIDATE_SUMMARY_INVALID");
  for (const a of value.assets) if (!isOriginalSfxCandidateIdV1(a.id) || a.category !== ORIGINAL_SFX_CANDIDATE_CATEGORY_V1 || a.mediaKind !== "audio"
    || a.redistributable !== false || a.defaultEnabled !== false || a.distributionScope !== "private-owner-only" || a.certification !== "AUDIO_PENDING_HAO_CLAUDE"
    || a.role !== "sound-effect" || !Array.isArray(a.domains) || a.domains.length !== 0 || !Number.isSafeInteger(a.bytes) || a.bytes <= 44 || a.bytes > 96044
    || !Number.isFinite(a.duration) || a.duration! <= 0 || a.duration! > 1 || !a.name?.trim() || !a.license?.trim() || !a.provenance?.trim()) throw new Error("SFX_CANDIDATE_ASSET_INVALID");
}
export function mergeOriginalSfxCandidatesV1(base: CreativeLibrarySummary | undefined, candidates: OriginalSfxCandidateSummaryV1 | undefined): CreativeLibrarySummary | undefined {
  if (!candidates) return base;
  assertOriginalSfxCandidateSummaryV1(candidates);
  if (!base) return candidates;
  const ids = new Set(base.assets.map(a => a.id));
  if (candidates.assets.some(a => ids.has(a.id))) throw new Error("SFX_CANDIDATE_ID_COLLISION");
  return { ...base, id: `${base.id}+original-sfx-v1`, version: `${base.version}+original-sfx-v1`, assets: [...base.assets, ...candidates.assets],
    assetCount: base.assetCount + candidates.assetCount, assetBytes: base.assetBytes + candidates.assetBytes,
    sfxAssetCount: base.sfxAssetCount + candidates.sfxAssetCount, restrictedAssetCount: base.restrictedAssetCount + candidates.restrictedAssetCount };
}
