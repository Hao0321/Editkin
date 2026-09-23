import type { CreativeLibraryAsset } from "../application/creativeLibrary";

export function selectAutomaticMusicAsset(
  assets: readonly CreativeLibraryAsset[],
  options: {
    projectName: string;
    duration: number;
    targetBpm?: number;
    recentAssetIds?: readonly string[];
    contentHints?: readonly string[];
    preferHighEnergy?: boolean;
  },
): CreativeLibraryAsset | undefined {
  const music = assets.filter((asset) => asset.mediaKind === "audio" && asset.role === "background-music" && asset.id.startsWith("music:") && Number.isFinite(asset.duration) && Number.isFinite(asset.bpm));
  const words = `${options.projectName} ${(options.contentHints ?? []).join(" ")}`.toLocaleLowerCase().split(/[\s_\-—，。！？、/]+/).filter(Boolean);
  const recent = new Set(options.recentAssetIds ?? []);
  const targetBpm = options.targetBpm ?? (options.duration <= 60 ? 118 : options.duration <= 8 * 60 ? 105 : 94);
  return music.map((asset) => {
    const searchable = `${asset.name} ${asset.category} ${asset.domains.join(" ")} ${asset.suggestedUse ?? ""}`.toLocaleLowerCase();
    const semantic = words.reduce((score, word) => score + (word.length >= 2 && searchable.includes(word) ? 4 : 0), 0);
    // auto_add_music can loop and crossfade short tracks, so duration must never overpower topic fit.
    const durationFit = 0.75 * Math.min(1, (asset.duration ?? 0) / Math.max(1, Math.min(options.duration, 30)));
    const tempoFit = 3 * (1 - Math.min(1, Math.abs((asset.bpm ?? targetBpm) - targetBpm) / 55));
    const highEnergy = /hook|reveal|high energy/i.test(asset.suggestedUse ?? "");
    const energyFit = highEnergy === (options.preferHighEnergy ?? options.duration <= 60) ? 1.5 : 0;
    const score = semantic + durationFit + tempoFit + energyFit - (recent.has(asset.id) ? 5 : 0);
    return { asset, score };
  }).sort((left, right) => right.score - left.score || left.asset.id.localeCompare(right.asset.id))[0]?.asset;
}
