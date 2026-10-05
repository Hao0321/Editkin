import { describe, expect, it } from "vitest";
import { EDITKIN_AESTHETIC_STANDARD, resolveAestheticSystem, resolveAestheticSystemForDomain, scoreAestheticReview } from "./editkinAesthetic";

describe("anonymous Editkin aesthetic standard", () => {
  it("ships the complete ten-dimension, fourteen-family current contract", () => {
    expect(Object.keys(EDITKIN_AESTHETIC_STANDARD.dimensions)).toHaveLength(10);
    expect(Object.keys(EDITKIN_AESTHETIC_STANDARD.style_families)).toHaveLength(14);
    expect(Object.values(EDITKIN_AESTHETIC_STANDARD.dimensions).reduce((sum, row) => sum + row.weight, 0)).toBe(100);
  });

  it("routes gaming footage to the arcade family and preserves format-specific weights", () => {
    const shorts = resolveAestheticSystem("gaming", "shorts");
    const longform = resolveAestheticSystem("gaming", "longform");
    expect(shorts.primaryFamily).toBe("arcade_pop");
    expect(shorts.dimensions.find((row) => row.id === "temporal_design")!.weight)
      .toBeGreaterThan(longform.dimensions.find((row) => row.id === "temporal_design")!.weight);
  });

  it("routes a technology autopilot plan to the same family as the domain standard", () => {
    const system = resolveAestheticSystemForDomain("technology", "longform");
    expect(system.domain).toBe("technology");
    expect(system.primaryFamily).toBe(EDITKIN_AESTHETIC_STANDARD.domain_routes.technology.primary);
  });

  it("routes illustrated music MV to character led motion rather than an event template", () => {
    const system = resolveAestheticSystem("music_mv", "longform");
    expect(system.domain).toBe("illustrated_music_mv");
    expect(system.primaryFamily).toBe("illustrated_mv");
    expect(system.avoid).toContain("static lyric cards over unrelated footage");
  });

  it("never lets machine checks impersonate the required human review", () => {
    const system = resolveAestheticSystem("gaming", "shorts");
    const perfect = Object.fromEntries(system.dimensions.map((row) => [row.id, 5]));
    expect(scoreAestheticReview(system, perfect).status).toBe("REVIEW");
    // Legacy ten totals cannot replace the new sixteen evidence-backed subreviews.
    expect(scoreAestheticReview(system, perfect, { complete: true }).status).toBe("REVIEW");
    expect(scoreAestheticReview(system, perfect, { complete: true, machineBlockers: ["visual_density_overload"] }).status).toBe("BLOCKED");
  });
});
