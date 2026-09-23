import { describe, expect, it } from "vitest";
import type { CreativeLibraryAsset } from "../application/creativeLibrary";
import { selectAutomaticMusicAsset } from "./musicSelection";

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
});
