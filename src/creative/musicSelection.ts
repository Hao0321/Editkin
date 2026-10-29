import type { CreativeLibraryAsset } from "../application/creativeLibrary";
import type { EditorialProfileId } from "../domain/types";

/** The library's general-purpose and explainer beds: the safe pick when nothing names the video's topic. */
export const NEUTRAL_MUSIC_CATEGORIES: readonly string[] = ["_通用", "教學"];

/**
 * Genre → library search hints for automatic background music. One table for the MCP auto_add_music tool, the in-app
 * auto edit and batch. neutralFallback: when neither the hints nor the project name match any track (the `auto`
 * profile, a tutorial…), pick from the neutral beds instead of whatever track scores best on tempo alone.
 */
export function automaticMusicPreferences(profile: EditorialProfileId | undefined): { contentHints: string[]; preferHighEnergy?: boolean; neutralFallback: true } {
  if (profile === "gaming") return { contentHints: ["game", "gaming", "玩具", "玩具開箱", "模型", "陀螺", "對戰"], preferHighEnergy: true, neutralFallback: true };
  if (profile === "food") return { contentHints: ["food", "美食", "料理"], neutralFallback: true };
  if (profile === "travel") return { contentHints: ["travel", "旅遊", "出國"], neutralFallback: true };
  if (profile?.startsWith("podcast")) return { contentHints: ["podcast", "訪談", "教學"], neutralFallback: true };
  return { contentHints: [], neutralFallback: true };
}

export interface AutomaticMusicOptions {
  projectName: string;
  duration: number;
  targetBpm?: number;
  recentAssetIds?: readonly string[];
  contentHints?: readonly string[];
  preferHighEnergy?: boolean;
  /** Topic matches win; with none, only NEUTRAL_MUSIC_CATEGORIES compete. Omitted: the legacy single ranking. */
  neutralFallback?: boolean;
}

/** Why a track was picked: `topic` = a hint or project-name word matched it; `neutral` = no topic match, neutral bed. */
export interface AutomaticMusicChoice {
  asset: CreativeLibraryAsset;
  pool: "topic" | "neutral" | "library";
  matchedWords: string[];
}

export function selectAutomaticMusicAsset(assets: readonly CreativeLibraryAsset[], options: AutomaticMusicOptions): CreativeLibraryAsset | undefined {
  return chooseAutomaticMusicAsset(assets, options)?.asset;
}

/** One short sentence for an agent or a status line: what was picked and why. */
export function describeAutomaticMusicChoice(choice: AutomaticMusicChoice, profile: string): string {
  if (choice.pool === "topic") return `依關鍵字「${choice.matchedWords.join("、")}」選曲（片型 ${profile}）`;
  if (choice.pool === "neutral") return `片型 ${profile} 與專案名稱沒有對應主題的曲目，改用中性配樂（${NEUTRAL_MUSIC_CATEGORIES.join("／")}）`;
  return `沒有主題或中性曲目可比對，依節奏與長度選曲（片型 ${profile}）`;
}

export function chooseAutomaticMusicAsset(assets: readonly CreativeLibraryAsset[], options: AutomaticMusicOptions): AutomaticMusicChoice | undefined {
  const music = assets.filter((asset) => asset.mediaKind === "audio" && asset.role === "background-music" && asset.id.startsWith("music:") && Number.isFinite(asset.duration) && Number.isFinite(asset.bpm));
  const words = `${options.projectName} ${(options.contentHints ?? []).join(" ")}`.toLocaleLowerCase().split(/[\s_\-—，。！？、/]+/).filter(Boolean);
  const recent = new Set(options.recentAssetIds ?? []);
  const targetBpm = options.targetBpm ?? (options.duration <= 60 ? 118 : options.duration <= 8 * 60 ? 105 : 94);
  const scored = music.map((asset) => {
    const searchable = `${asset.name} ${asset.category} ${asset.domains.join(" ")} ${asset.suggestedUse ?? ""}`.toLocaleLowerCase();
    const matchedWords = [...new Set(words.filter((word) => word.length >= 2 && searchable.includes(word)))];
    const semantic = words.reduce((score, word) => score + (word.length >= 2 && searchable.includes(word) ? 4 : 0), 0);
    // auto_add_music can loop and crossfade short tracks, so duration must never overpower topic fit.
    const durationFit = 0.75 * Math.min(1, (asset.duration ?? 0) / Math.max(1, Math.min(options.duration, 30)));
    const tempoFit = 3 * (1 - Math.min(1, Math.abs((asset.bpm ?? targetBpm) - targetBpm) / 55));
    const highEnergy = /hook|reveal|high energy/i.test(asset.suggestedUse ?? "");
    const energyFit = highEnergy === (options.preferHighEnergy ?? options.duration <= 60) ? 1.5 : 0;
    const score = semantic + durationFit + tempoFit + energyFit - (recent.has(asset.id) ? 5 : 0);
    return { asset, score, semantic, matchedWords };
  });
  const best = (candidates: typeof scored) => [...candidates].sort((left, right) => right.score - left.score || left.asset.id.localeCompare(right.asset.id))[0];
  const choice = (picked: (typeof scored)[number] | undefined, pool: AutomaticMusicChoice["pool"]): AutomaticMusicChoice | undefined =>
    picked && { asset: picked.asset, pool: picked.semantic > 0 ? "topic" : pool, matchedWords: picked.matchedWords.slice(0, 6) };
  if (!options.neutralFallback) return choice(best(scored), "library");
  const topic = scored.filter((item) => item.semantic > 0);
  if (topic.length) return choice(best(topic), "topic");
  const neutral = scored.filter((item) => NEUTRAL_MUSIC_CATEGORIES.includes(item.asset.category));
  return neutral.length ? choice(best(neutral), "neutral") : choice(best(scored), "library");
}
