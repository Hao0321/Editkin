import { describe, expect, it } from "vitest";
import { clampLSystemIterationsV1, expandLSystemV1, growLSystemV1, interpretLSystemV1, LSystemBudgetError, lsystemGrowthScheduleV1, type LSystemGrammarV1 } from "./lsystem";
import { growPresetV1, LSYSTEM_PRESET_IDS_V1, LSYSTEM_PRESETS_V1 } from "./lsystemPresets";

const base: Omit<LSystemGrammarV1, "axiom" | "rules"> = { angle: 90, step: 1, width: 1 };
const close = (a: readonly number[], b: readonly number[]) => a.forEach((value, i) => expect(value).toBeCloseTo(b[i], 9));

describe("L-system expander", () => {
  it("rewrites deterministically (Lindenmayer's algae grows by Fibonacci)", () => {
    const algae: LSystemGrammarV1 = { ...base, axiom: "A", rules: { A: "AB", B: "A" } };
    expect([0, 1, 2, 3, 4, 5, 6].map(n => expandLSystemV1(algae, n, 1).length)).toEqual([1, 2, 3, 5, 8, 13, 21]);
    expect(expandLSystemV1(algae, 4, 1).map(symbol => symbol.char).join("")).toBe("ABAABABA");
    expect(() => expandLSystemV1(algae, 17, 1)).toThrow(/iterations/);
  });

  it("tracks generations: a kept symbol (F → FF) keeps its age, new symbols are born in their iteration", () => {
    const plant: LSystemGrammarV1 = { ...base, axiom: "X", rules: { X: "F[+X]FX", F: "FF" } };
    const symbols = expandLSystemV1(plant, 2, 1);
    // X → F[+X]FX (gen 1); then each gen-1 F becomes FF (still gen 1) and each X a fresh gen-2 F[+X]FX.
    expect(symbols.filter(symbol => symbol.char === "F").map(symbol => symbol.generation)).toEqual([1, 1, 2, 2, 1, 1, 2, 2]);
  });

  it("picks stochastic successors by seed: the same seed is the same plant, another seed another plant", () => {
    const grammar = LSYSTEM_PRESETS_V1.tree.grammar;
    const a = growLSystemV1(grammar, 7, 11), b = growLSystemV1(grammar, 7, 11), c = growLSystemV1(grammar, 7, 12);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(c));
  });

  it("refuses to grow past its symbol budget, and clamps iterations to a segment budget", () => {
    const bush: LSystemGrammarV1 = { ...base, axiom: "F", rules: { F: "F[+F]F[-F]F" } };
    expect(() => expandLSystemV1(bush, 8, 1, 10_000)).toThrow(LSystemBudgetError);
    // F count is 5^n: the largest n with at most 1000 segments is 4 (625).
    expect(clampLSystemIterationsV1(bush, 8, 1, 1000)).toBe(4);
    expect(growLSystemV1(bush, 4, 1).segments).toHaveLength(625);
  });
});

describe("turtle", () => {
  it("draws F forward from the origin heading up; + turns left, − right; [ ] branch; L marks a tip", () => {
    const result = interpretLSystemV1({ ...base, axiom: "", rules: {}, angle: 90 }, [..."F[+F]F[-FL]"].map(char => ({ char, generation: 0 })), 1);
    expect(result.segments).toHaveLength(4);
    close(result.segments[0].a, [0, 0, 0]); close(result.segments[0].b, [0, 1, 0]);
    close(result.segments[1].b, [-1, 1, 0]);
    close(result.segments[2].a, [0, 1, 0]); close(result.segments[2].b, [0, 2, 0]);
    close(result.segments[3].b, [1, 2, 0]);
    expect(result.segments.map(segment => [segment.depth, segment.parent, segment.distance])).toEqual([[0, -1, 0], [1, 0, 1], [0, 0, 1], [1, 2, 2]]);
    expect(result.tips).toHaveLength(1);
    close(result.tips[0].at, [1, 2, 0]);
    close([...result.bounds.min, ...result.bounds.max], [-1, 0, 0, 1, 2, 0]);
  });

  it("pitches and rolls in 3D, shortens with \" and tapers per branch depth", () => {
    const g: LSystemGrammarV1 = { angle: 90, step: 2, width: 1, widthScale: 0.5, shrink: 0.5, axiom: "", rules: {} };
    const r = interpretLSystemV1(g, [..."&F"].map(char => ({ char, generation: 0 })), 1);
    // Pitch (&) turns the heading out of the x/y plane.
    expect(Math.abs(r.segments[0].b[2])).toBeCloseTo(2, 9);
    const s = interpretLSystemV1(g, [..."F\"F[F]"].map(char => ({ char, generation: 0 })), 1);
    expect(s.segments.map(segment => [segment.b[1] - segment.a[1], segment.width])).toEqual([[2, 1], [1, 0.5], [1, 0.25]]);
  });
});

describe("growth schedule", () => {
  it("is generation-major with a per-segment stagger along the path, inside 0..1, ending at 1", () => {
    const result = growPresetV1(LSYSTEM_PRESETS_V1.tree, 7, 7), schedule = lsystemGrowthScheduleV1(result);
    expect(schedule).toHaveLength(result.segments.length);
    for (const [s0, s1] of schedule) { expect(s0).toBeGreaterThanOrEqual(0); expect(s1).toBeLessThanOrEqual(1 + 1e-9); expect(s1).toBeGreaterThan(s0); }
    expect(Math.max(...schedule.map(([, s1]) => s1))).toBeCloseTo(1, 9);
    // Generations start in order; inside a generation, nearer segments start first.
    const firstStart = new Map<number, number>();
    for (const segment of result.segments) firstStart.set(segment.generation, Math.min(firstStart.get(segment.generation) ?? 1, schedule[segment.index][0]));
    const ordered = [...firstStart.entries()].sort((a, b) => a[0] - b[0]).map(([, start]) => start);
    expect(ordered).toEqual([...ordered].sort((a, b) => a - b));
    const gen3 = result.segments.filter(segment => segment.generation === 3).sort((a, b) => a.distance - b.distance);
    expect(gen3.map(segment => schedule[segment.index][0])).toEqual([...gen3.map(segment => schedule[segment.index][0])].sort((a, b) => a - b));
  });
});

describe("presets", () => {
  it("every preset grows deterministically for a seed, within a few thousand segments, with tips to mark", () => {
    for (const id of LSYSTEM_PRESET_IDS_V1) {
      const preset = LSYSTEM_PRESETS_V1[id];
      const a = growPresetV1(preset, 5), b = growPresetV1(preset, 5);
      expect(JSON.stringify(a), id).toBe(JSON.stringify(b));
      // vine_frame is one tendril (the renderer lays the framing stem and sprouts many of them).
      expect(a.segments.length, id).toBeGreaterThan(id === "vine_frame" ? 3 : 20);
      expect(a.segments.length, id).toBeLessThan(6000);
      if (id !== "lightning") expect(a.tips.length, id).toBeGreaterThan(0);
    }
    // Radial presets grow one arm per direction (and lanes per arm): the circuit grows outward on all four sides.
    const circuit = growPresetV1(LSYSTEM_PRESETS_V1.circuit, 5);
    expect(circuit.bounds.min[0]).toBeLessThan(-7); expect(circuit.bounds.max[0]).toBeGreaterThan(7);
    expect(circuit.bounds.min[1]).toBeLessThan(-7); expect(circuit.bounds.max[1]).toBeGreaterThan(7);
  });
});
