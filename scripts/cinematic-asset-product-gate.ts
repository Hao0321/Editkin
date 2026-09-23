import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BULLET_TIME_CAPABILITIES,
  CINEMATIC_LANGUAGE_RECIPES,
  compactCinematicLanguageIndex,
} from "../src/creative/cinematicLanguage";
import { LOOK_PRESETS, TRANSITION_PRESETS } from "../src/creative/corePack";
import {
  initializeStudioCreativeAssets,
  STUDIO_CINEMATIC_LOOKS,
  STUDIO_CINEMATIC_TRANSITIONS,
  STUDIO_COMPOUND_TRANSITIONS,
} from "../src/creative/studioAssets";
import { initializeWave2Registry } from "../src/creative/wave2Registry";
import {
  assertCinematicAssetProductGate,
  evaluateCinematicAssetProductGate,
  type CinematicAssetGateInput,
} from "./lib/cinematic-asset-product-gate";

const root = resolve(import.meta.dirname, "..");
const selfTest = process.argv.includes("--self-test");

function cloneRecords(value: readonly unknown[]): Array<Record<string, unknown>> {
  return structuredClone(value) as Array<Record<string, unknown>>;
}

export function buildCanonicalCinematicAssetGateInput(): CinematicAssetGateInput {
  initializeStudioCreativeAssets();
  initializeWave2Registry();
  return {
    recipes: cloneRecords(CINEMATIC_LANGUAGE_RECIPES),
    bulletTime: cloneRecords(BULLET_TIME_CAPABILITIES),
    looks: cloneRecords(LOOK_PRESETS),
    transitions: cloneRecords(TRANSITION_PRESETS),
    cinematicLooks: cloneRecords(STUDIO_CINEMATIC_LOOKS),
    cinematicTransitions: cloneRecords([...STUDIO_CINEMATIC_TRANSITIONS, ...STUDIO_COMPOUND_TRANSITIONS]),
    compactIndex: structuredClone(compactCinematicLanguageIndex()) as Record<string, unknown>,
  };
}

function mutated(input: CinematicAssetGateInput, mutation: (candidate: CinematicAssetGateInput) => void): CinematicAssetGateInput {
  const candidate = structuredClone(input);
  mutation(candidate);
  return candidate;
}

function requireRejected(
  input: CinematicAssetGateInput,
  name: string,
  expectedFailure: string,
  mutation: (candidate: CinematicAssetGateInput) => void,
): string {
  const result = evaluateCinematicAssetProductGate(mutated(input, mutation));
  if (result.status !== "BLOCK" || !result.failures.some((failure) => failure.startsWith(expectedFailure))) {
    throw new Error(`evaluator accepted or misclassified ${name}: ${JSON.stringify(result)}`);
  }
  return name;
}

export function runCinematicAssetGateSelfTest(input = buildCanonicalCinematicAssetGateInput()) {
  assertCinematicAssetProductGate(input);
  const rejectedNegativeControls = [
    requireRejected(input, "duplicate-id", "id:duplicate", (candidate) => {
      candidate.recipes.push(structuredClone(candidate.recipes[0]));
    }),
    requireRejected(input, "missing-transition-fallback", "transition:fallback", (candidate) => {
      const routing = candidate.cinematicTransitions[0].routing as Record<string, unknown>;
      routing.fallbackId = "missing-transition";
      const registered = candidate.transitions.find((item) => item.id === candidate.cinematicTransitions[0].id)!;
      (registered.routing as Record<string, unknown>).fallbackId = "missing-transition";
    }),
    requireRejected(input, "planning-apply-ready", "recipe:apply-ready-marker", (candidate) => {
      candidate.recipes[0].applyReady = true;
    }),
    requireRejected(input, "compiler-status-downgrade", "recipe:execution-contract:beat_aligned_montage", (candidate) => {
      candidate.recipes.find((item) => item.id === "beat_aligned_montage")!.executionStatus = "planning_only";
    }),
    requireRejected(input, "compiler-tool-drift", "recipe:compiler-contract:beat_aligned_montage", (candidate) => {
      candidate.recipes.find((item) => item.id === "beat_aligned_montage")!.compilerTool = "unknown_compiler";
    }),
    requireRejected(input, "planning-recipe-compiler", "recipe:compiler-contract:spatial_orientation", (candidate) => {
      candidate.recipes.find((item) => item.id === "spatial_orientation")!.compilerTool = "compile_beat_montage";
    }),
    requireRejected(input, "bullet-time-label", "bullet-time:honesty", (candidate) => {
      candidate.bulletTime[0].honestLabel = "真實子彈時間";
    }),
    requireRejected(input, "transition-renderer", "transition:renderer", (candidate) => {
      candidate.transitions[0].renderer = "brand-magic-transition";
    }),
    requireRejected(input, "transition-parameter-name", "transition:parameter-not-supported", (candidate) => {
      const transition = candidate.transitions.find((item) => item.id === "cine_semantic_punch")!;
      (transition.parameters as Record<string, unknown>).flashStrength = 0.5;
    }),
    requireRejected(input, "transition-parameter-range", "transition:parameter-range", (candidate) => {
      const transition = candidate.transitions.find((item) => item.id === "cine_payoff_burst")!;
      (transition.parameters as Record<string, unknown>).flashStrength = 4;
    }),
    requireRejected(input, "compound-transition-renderers", "transition:compound-renderers", (candidate) => {
      const id = "cine_soft_fade_push";
      const declared = candidate.cinematicTransitions.find((item) => item.id === id)!;
      const registered = candidate.transitions.find((item) => item.id === id)!;
      declared.renderers = [declared.renderer];
      registered.renderers = [registered.renderer];
    }),
    requireRejected(input, "compound-transition-parameter", "transition:compound-parameter", (candidate) => {
      const id = "cine_proof_flash_push";
      const declared = candidate.cinematicTransitions.find((item) => item.id === id)!;
      const registered = candidate.transitions.find((item) => item.id === id)!;
      delete (declared.parameters as Record<string, unknown>).zoomAmount;
      delete (registered.parameters as Record<string, unknown>).zoomAmount;
    }),
    requireRejected(input, "recipe-requirements", "recipe:requirements", (candidate) => {
      candidate.recipes[0].requirements = [];
    }),
    requireRejected(input, "recipe-fallback", "recipe:fallback", (candidate) => {
      candidate.recipes[1].fallbackId = "missing-recipe";
    }),
    requireRejected(input, "look-range", "look:color", (candidate) => {
      const look = candidate.looks.find((item) => item.id === "cine_creator_clean_pop")!;
      (look.color as Record<string, unknown>).saturation = 8;
    }),
    requireRejected(input, "look-registration-drift", "cinematic-look:registration-drift", (candidate) => {
      candidate.cinematicLooks[0].name = "unregistered mutation";
    }),
    requireRejected(input, "compact-apply-ready", "compact-index:apply-ready-marker", (candidate) => {
      (candidate.compactIndex.recipes as Array<Record<string, unknown>>)[0].executionStatus = "APPLY_READY";
    }),
    requireRejected(input, "compact-compiler-missing", "compact-index:recipe-execution-contract:beat_aligned_montage", (candidate) => {
      const recipe = (candidate.compactIndex.recipes as Array<Record<string, unknown>>).find((item) => item.id === "beat_aligned_montage")!;
      delete recipe.compilerTool;
    }),
  ];
  return {
    status: "GREEN" as const,
    schema: "editkin.cinematic-asset-product-gate-self-test/v1" as const,
    rejectedNegativeControls,
  };
}

async function evaluatorIdentity(): Promise<{ sha256: string; files: string[] }> {
  const files = [
    resolve(root, "scripts/cinematic-asset-product-gate.ts"),
    resolve(root, "scripts/lib/cinematic-asset-product-gate.ts"),
  ];
  const hash = createHash("sha256");
  for (const path of files) hash.update(path).update("\0").update(await readFile(path)).update("\0");
  return { sha256: hash.digest("hex"), files };
}

async function main(): Promise<void> {
  if (selfTest) {
    process.stdout.write(`${JSON.stringify(runCinematicAssetGateSelfTest())}\n`);
    return;
  }
  const result = assertCinematicAssetProductGate(buildCanonicalCinematicAssetGateInput());
  process.stdout.write(`${JSON.stringify({ ...result, evaluator: await evaluatorIdentity() })}\n`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]).toLowerCase() : "";
if (fileURLToPath(import.meta.url).toLowerCase() === invokedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  });
}
