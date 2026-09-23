import { resolveCreativeLibraryAsset } from "./creativeLibrary";
import { probeMedia } from "../render/ffmpeg";

export const CORE_EDITORIAL_SFX = [
  { assetId: "sfx:editkin-whoosh-01", role: "transition-whoosh" as const },
  { assetId: "sfx:editkin-impact-01", role: "payoff-impact" as const },
  { assetId: "sfx:editkin-countdown-01", role: "countdown-tick" as const },
  { assetId: "sfx:editkin-reveal-01", role: "reveal-spark" as const },
] as const;

export async function resolveCoreEditorialSfx(packRoot: string, ffprobePath = "ffprobe") {
  return Promise.all(CORE_EDITORIAL_SFX.map(async ({ assetId, role }) => {
    const resolved = await resolveCreativeLibraryAsset(packRoot, assetId);
    const probe = await probeMedia(resolved.absolutePath, ffprobePath);
    if (!probe.hasAudio || probe.duration <= 0 || resolved.asset.redistributable === false) throw new Error(`Core SFX 無法解碼或不可散布：${assetId}`);
    return {
      assetId,
      name: resolved.asset.name,
      role,
      path: resolved.absolutePath,
      sha256: resolved.sha256,
      duration: probe.duration,
      license: resolved.asset.license as "CC-BY-4.0" | "MIT" | "CC0-1.0",
      provenance: resolved.asset.provenance,
      redistributable: true as const,
    };
  }));
}
