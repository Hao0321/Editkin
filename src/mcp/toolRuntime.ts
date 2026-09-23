import { resolve } from "node:path";

export function textResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

export function errorResult(error: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ status: "BLOCK", error: error instanceof Error ? error.message : String(error) }) }],
    isError: true,
  };
}

export function creativePackRoot(): string {
  return process.env.EDITKIN_CREATIVE_PACK_ROOT ?? resolve(process.cwd(), ".creative-packs/hao-creator-library");
}

export function personalMusicRoot(): string {
  return process.env.EDITKIN_PERSONAL_MUSIC_ROOT ?? resolve(process.cwd(), ".personal-packs/hao-music-library");
}

/** Owner-only assets are separate from the redistributable creator/music packs. */
export function personalVisualRoot(): string {
  return process.env.EDITKIN_PERSONAL_VISUAL_ROOT ?? resolve(process.cwd(), ".personal-packs/hao-visual-library");
}
