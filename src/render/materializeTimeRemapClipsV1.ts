import { createHash } from "node:crypto";
import { canonicalJson } from "../shared/canonicalJson";
import type { EditProject } from "../domain/types";
import { hasAuthoredClipTimeRemapV1 } from "../domain/clipTimeRemapV1";
import { validateProject } from "../domain/projectValidation";
import { admitTimeRemapCacheClipV1, parseTimeRemapCacheReceiptV1 } from "./timeRemapCacheContractV1";
import { getTimeRemapRenderCacheV1, type TimeRemapCacheRuntimeV1, type TimeRemapCacheArtifactV1 } from "./timeRemapCacheServiceV1";

/** Export/preview clone only. The caller holds leases until decoders/encoders close, then releases.
 * No authored project/source/clock, transform, colour, mask or keyframe is rewritten in place. */
export async function materializeTimeRemapClipsV1(project: EditProject, input: {
  projectRoot: string; assetBase?: string; sourceSha256ByAssetId: Readonly<Record<string, string>>;
}, runtime: TimeRemapCacheRuntimeV1) {
  const before = canonicalJson(project);
  if (project.compositions.some(c => c.tracks.some(t => t.clips.some(hasAuthoredClipTimeRemapV1)))) throw Error("TIME_REMAP_CACHE_NESTED_CLOCK_REQUIRES_MATERIALIZATION");
  const clips = project.tracks.flatMap(t => t.clips).filter(hasAuthoredClipTimeRemapV1);
  for (const clip of clips) {
    const asset = project.assets.find(a => a.id === clip.assetId);
    if (!asset || !/^[a-f0-9]{64}$/.test(input.sourceSha256ByAssetId[asset.id] ?? "")) throw Error("TIME_REMAP_CACHE_SELECTED_SOURCE_AND_SHA_REQUIRED");
    admitTimeRemapCacheClipV1(project, clip, asset);
  }
  const result = structuredClone(project), artifacts: TimeRemapCacheArtifactV1[] = [], derived = new Map<string, string>();
  let released = false;
  const release = async () => { if (!released) { for (const a of [...artifacts].reverse()) await a.release(); released = true; } };
  try {
    for (const original of clips) {
      runtime.signal?.throwIfAborted();
      const cached = await getTimeRemapRenderCacheV1({ project, clipId: original.id, projectRoot: input.projectRoot, assetBase: input.assetBase,
        expectedSourceSha256: input.sourceSha256ByAssetId[original.assetId] }, runtime); artifacts.push(cached);
      if (canonicalJson(project) !== before) throw Error("TIME_REMAP_CACHE_PROJECT_CHANGED");
      const source = project.assets.find(a => a.id === original.assetId)!, reuse = `${source.id}:${cached.receipt.key}`;
      const checked = parseTimeRemapCacheReceiptV1(cached.receipt), expected = admitTimeRemapCacheClipV1(project, original, source);
      if (checked.keyInputs.sourceSha256 !== input.sourceSha256ByAssetId[source.id] || checked.keyInputs.sourceStart !== original.sourceStart
        || checked.duration !== original.duration || checked.fps !== project.fps || checked.frames !== expected.clock.totalOutputFrames
        || checked.width !== expected.width || checked.height !== expected.height || checked.keyInputs.speed !== (original.speed ?? null)
        || canonicalJson(checked.keyInputs.timeRemap) !== canonicalJson(original.timeRemap ?? null)) throw Error("TIME_REMAP_CACHE_RETURNED_WRONG_CLIP_CLOCK");
      let assetId = derived.get(reuse);
      if (!assetId) {
        const suffix = createHash("sha256").update(source.id).digest("hex").slice(0, 8), base = `clock-cache-${cached.receipt.key.slice(0, 20)}-${suffix}`;
        assetId = base; for (let n = 1; result.assets.some(a => a.id === assetId); n++) assetId = `${base}-${n}`;
        const asset = { ...structuredClone(source), id: assetId, uri: cached.mediaPath, duration: cached.receipt.duration, width: cached.receipt.width, height: cached.receipt.height,
          color: { interpretation: "rec709" as const, primaries: "bt709", transfer: "bt709", matrix: "gbr", range: "pc" } };
        delete asset.derivatives; delete asset.clipRetime; delete asset.compositionId; delete asset.imageSequence;
        // The bake is the admitted source's square-pixel upright raster (width x height); its raw FFV1 stream carries no
        // SAR, so the original's saved display ratio would make export geometry checks refuse a ratio they cannot read.
        delete asset.displayAspectRatio;
        result.assets.push(asset); derived.set(reuse, assetId);
      }
      const clip = result.tracks.flatMap(t => t.clips).find(c => c.id === original.id)!;
      clip.assetId = assetId; clip.sourceStart = 0; delete clip.speed; delete clip.timeRemap;
      if (!["pitch_preserving_constant_pcm_f32", "shared_phase_constant_pcm_f32_candidate"].includes(cached.receipt.audio)) clip.volume = 0;
    }
    if (canonicalJson(project) !== before) throw Error("TIME_REMAP_CACHE_PROJECT_CHANGED");
    validateProject(result);
    return { project: result, artifacts, release, ordinaryEditorPreviewIntegrated: false as const, exportHookIntegrated: false as const };
  } catch (e) { await release(); throw e; }
}

/** A caller displays pending/failed state explicitly; there is no original-source 1x fallback. */
export function selectTimeRemapPreviewSourceV1(value: { status: "pending" | "failed"; reason?: string } | { status: "ready"; artifact: TimeRemapCacheArtifactV1 }) {
  return value.status === "ready" ? { status: "ready" as const, uri: value.artifact.mediaPath, sourceStart: 0, key: value.artifact.receipt.key }
    : { status: value.status, uri: undefined, reason: value.reason };
}
