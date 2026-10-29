import { describe, expect, it } from "vitest";
import type { CreativeLibraryAsset } from "../application/creativeLibrary";
import { automaticMusicPreferences, selectAutomaticMusicAsset } from "./musicSelection";

const music = (id: string, name: string, category: string, duration: number, bpm: number, suggestedUse: string): CreativeLibraryAsset => ({
  id: `music:${id}`,
  name,
  category,
  role: "background-music",
  domains: [category, suggestedUse],
  mediaKind: "audio",
  bytes: 100,
  license: "HAO-COMMUNITY-ASSET-GRANT-1.0",
  provenance: "test",
  redistributable: true,
  duration,
  bpm,
  energyDb: -14,
  suggestedUse,
});

describe("automatic music selection", () => {
  it("prefers semantic gaming music over a long unrelated travel track when looping is available", () => {
    const selected = selectAutomaticMusicAsset([
      music("travel", "歐洲街道", "出國", 396, 92, "general/explain"),
      music("toy", "機器人、模型", "玩具開箱", 38, 117, "hook/reveal (high energy)"),
    ], {
      projectName: "正版 vs 仿冒 12 局實測",
      duration: 304,
      targetBpm: 132,
      contentHints: ["gaming", "玩具", "模型", "陀螺", "對戰"],
      preferHighEnergy: true,
    });
    expect(selected?.id).toBe("music:toy");
  });

  it("maps the creator's genre to the same library hints as auto_add_music", () => {
    const library = [music("travel", "歐洲街道", "出國", 120, 100, "general/explain"), music("toy", "機器人、模型", "玩具開箱", 120, 100, "general/explain")];
    const pick = (profile: Parameters<typeof automaticMusicPreferences>[0]) => selectAutomaticMusicAsset(library, { projectName: "第三天", duration: 30, targetBpm: 100, ...automaticMusicPreferences(profile) })?.id;
    expect(pick("travel")).toBe("music:travel");
    expect(pick("gaming")).toBe("music:toy");
    expect(automaticMusicPreferences("gaming").preferHighEnergy).toBe(true);
    expect(automaticMusicPreferences("food").contentHints).toEqual(["food", "美食", "料理"]);
    expect(automaticMusicPreferences("podcast_no_face").contentHints).toContain("訪談");
    expect(automaticMusicPreferences("auto")).toEqual({ contentHints: [] });
  });
});
