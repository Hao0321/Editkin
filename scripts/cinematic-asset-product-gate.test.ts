import { describe, expect, it } from "vitest";
import {
  buildCanonicalCinematicAssetGateInput,
  runCinematicAssetGateSelfTest,
} from "./cinematic-asset-product-gate";
import { evaluateCinematicAssetProductGate } from "./lib/cinematic-asset-product-gate";

describe("cinematic asset closed-world product gate", () => {
  it("accepts the canonical Editkin registries with exact product counts", () => {
    const result = evaluateCinematicAssetProductGate(buildCanonicalCinematicAssetGateInput());
    expect(result).toMatchObject({
      status: "GREEN",
      failures: [],
      counts: {
        recipes: 11,
        bulletTimeTiers: 3,
        cinematicLooks: 12,
        cinematicTransitions: 20,
        evidenceCompilableRecipes: 1,
      },
    });
    expect(result.counts.terminalBlockingRecipes).toBeGreaterThan(0);
  });

  it("calibrates every task-shaped negative control", () => {
    const result = runCinematicAssetGateSelfTest();
    expect(result.status).toBe("GREEN");
    expect(result.rejectedNegativeControls).toEqual([
      "duplicate-id",
      "missing-transition-fallback",
      "planning-apply-ready",
      "compiler-status-downgrade",
      "compiler-tool-drift",
      "planning-recipe-compiler",
      "bullet-time-label",
      "transition-renderer",
      "transition-parameter-name",
      "transition-parameter-range",
      "compound-transition-renderers",
      "compound-transition-parameter",
      "recipe-requirements",
      "recipe-fallback",
      "look-range",
      "look-registration-drift",
      "compact-apply-ready",
      "compact-compiler-missing",
    ]);
  });

  it.each(["whiteBalanceRed", "whiteBalanceGreen", "whiteBalanceBlue"])("validates the explicit linear gain contract for %s without allowing unknown fields", (key) => {
    const mutate = (value: unknown, remove = false) => {
      const input = buildCanonicalCinematicAssetGateInput();
      const declared = input.cinematicLooks[0];
      const registered = input.looks.find((look) => look.id === declared.id)!;
      for (const look of [declared, registered]) {
        const color = look.color as Record<string, unknown>;
        if (remove) delete color[key];
        else color[key] = value;
      }
      return evaluateCinematicAssetProductGate(input);
    };
    for (const value of [-4, 0, 4]) expect(mutate(value).status).toBe("GREEN");
    for (const value of [-4.001, 4.001, NaN, Infinity, "0", undefined]) {
      const result = mutate(value, value === undefined);
      expect(result.status).toBe("BLOCK");
      expect(result.failures.some((failure) => failure.startsWith("look:color:") && failure.endsWith(`:${key}`))).toBe(true);
    }
    const input = buildCanonicalCinematicAssetGateInput();
    (input.looks[0].color as Record<string, unknown>).unregisteredGain = 0;
    expect(evaluateCinematicAssetProductGate(input).failures.some((failure) => failure.startsWith("look:color-parameter:") && failure.endsWith(":unregisteredGain"))).toBe(true);
  });
});
