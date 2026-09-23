export interface CinematicAssetGateInput {
  recipes: Array<Record<string, unknown>>;
  bulletTime: Array<Record<string, unknown>>;
  looks: Array<Record<string, unknown>>;
  transitions: Array<Record<string, unknown>>;
  cinematicLooks: Array<Record<string, unknown>>;
  cinematicTransitions: Array<Record<string, unknown>>;
  compactIndex: Record<string, unknown>;
}

export interface CinematicAssetGateResult {
  schema: "editkin.cinematic-asset-product-gate/v1";
  status: "GREEN" | "BLOCK";
  failures: string[];
  counts: {
    recipes: number;
    bulletTimeTiers: number;
    looks: number;
    transitions: number;
    cinematicLooks: number;
    cinematicTransitions: number;
    evidenceCompilableRecipes: number;
    terminalBlockingRecipes: number;
  };
  closedWorld: {
    recipeIds: string[];
    bulletTimeIds: string[];
    cinematicLookIds: string[];
    cinematicTransitionIds: string[];
  };
}

const REQUIRED_RECIPE_IDS = [
  "spatial_orientation",
  "dialogue_flow",
  "match_action_carry",
  "reveal_ladder",
  "semantic_punch_in",
  "process_progress_result",
  "parallel_ab_montage",
  "rhythmic_crescendo",
  "beat_aligned_montage",
  "multicam_performance",
  "time_sculpt",
] as const;

const EVIDENCE_COMPILABLE_RECIPE = {
  id: "beat_aligned_montage",
  compilerTool: "compile_beat_montage",
  operations: ["select_by_salience", "story_order", "source_trim", "align_cut_points_to_beat_grid"],
  requirements: ["shot_evidence", "caller_beat_grid"],
} as const;

const REQUIRED_BULLET_TIME = {
  bt_l1_25d_orbit: {
    status: "prototype",
    honestLabel: "2.5D 模擬；非真實新視角",
    requirements: ["subject_matte", "depth_map", "background_inpaint", "bounded_camera_arc"],
  },
  bt_l2_monocular_reconstruction: {
    status: "research",
    honestLabel: "AI 重建視角；不可見區可能推測生成",
    requirements: ["camera_poses", "intrinsics", "dynamic_depth_or_3dgs", "temporal_occlusion_qa"],
  },
  bt_l3_volumetric_capture: {
    status: "capture_required",
    honestLabel: "真實多機體積擷取",
    requirements: ["synchronized_cameras", "intrinsics_extrinsics", "lens_calibration", "timecode_or_genlock", "volumetric_reconstruction"],
  },
} as const;

const REQUIRED_CINEMATIC_LOOK_IDS = [
  "cine_neutral_balance",
  "cine_creator_clean_pop",
  "cine_soft_daylight_skin",
  "cine_cool_precision",
  "cine_warm_documentary",
  "cine_muted_editorial",
  "cine_dense_print",
  "cine_pastel_air",
  "cine_neon_night_guard",
  "cine_dawn_gold",
  "cine_moonlit_steel",
  "cine_silver_monochrome",
] as const;

const REQUIRED_CINEMATIC_TRANSITION_IDS = [
  "cine_short_fade_through_base",
  "cine_emotion_fade_through_base",
  "cine_chapter_fade_through_base",
  "cine_semantic_punch",
  "cine_impact_zoom",
  "cine_ui_detail_push",
  "cine_axis_carry_left",
  "cine_axis_carry_right",
  "cine_soft_direction_slide",
  "cine_proof_flash",
  "cine_payoff_burst",
  "cine_exposure_breath",
  "cine_soft_fade_push",
  "cine_memory_fade_push",
  "cine_left_slide_fade",
  "cine_right_slide_fade",
  "cine_proof_flash_push",
  "cine_payoff_flash_push",
  "cine_left_energy_relay",
  "cine_right_energy_relay",
] as const;

const REQUIRED_COMPOUND_TRANSITION_IDS = new Set([
  "cine_soft_fade_push",
  "cine_memory_fade_push",
  "cine_left_slide_fade",
  "cine_right_slide_fade",
  "cine_proof_flash_push",
  "cine_payoff_flash_push",
  "cine_left_energy_relay",
  "cine_right_energy_relay",
]);

const TRANSITION_PARAMETER_CONTRACT: Record<string, Record<string, { min: number; max: number; integer?: boolean; values?: readonly number[] }>> = {
  "transition-fade": { fadeCurve: { min: 0.1, max: 4 } },
  "transition-zoom": { zoomAmount: { min: 0, max: 0.5 } },
  "transition-whip": {
    travelPercent: { min: 0, max: 200 },
    direction: { min: -1, max: 1, integer: true, values: [-1, 1] },
  },
  "transition-flash": { flashStrength: { min: 0, max: 1 } },
};

const TRANSITION_REQUIRED_PARAMETERS: Record<string, readonly string[]> = {
  "transition-fade": ["fadeCurve"],
  "transition-zoom": ["zoomAmount"],
  "transition-whip": ["travelPercent", "direction"],
  "transition-flash": ["flashStrength"],
};

const LOOK_RENDERERS = new Set(["ffmpeg-eq", "editkin-primary-grade"]);
const FORBIDDEN_APPLY_KEY = /^(apply[_-]?ready|is[_-]?apply[_-]?ready|apply[_-]?status|execution[_-]?ready)$/i;
const FORBIDDEN_APPLY_VALUE = /^(apply[_-]?ready|ready[_-]?to[_-]?apply)$/i;

function strings(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

function idOf(item: Record<string, unknown>): string {
  return typeof item.id === "string" ? item.id : "";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function sameClosedSet(actual: string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && [...actual].sort().every((id, index) => id === [...expected].sort()[index]);
}

function requireClosedSet(failures: string[], label: string, actual: string[], expected: readonly string[]): void {
  if (!sameClosedSet(actual, expected)) failures.push(`${label}:closed-world:${actual.join(",")}`);
}

function duplicateIds(items: Array<Record<string, unknown>>): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const item of items) {
    const id = idOf(item);
    if (!id || seen.has(id)) duplicates.add(id || "<missing>");
    seen.add(id);
  }
  return [...duplicates];
}

function hasForbiddenApplyMarker(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value === "string") return FORBIDDEN_APPLY_VALUE.test(value);
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => hasForbiddenApplyMarker(item, seen));
  return Object.entries(value).some(([key, child]) => FORBIDDEN_APPLY_KEY.test(key) || hasForbiddenApplyMarker(child, seen));
}

function sameAsset(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateRegistration(
  failures: string[],
  label: string,
  declared: Array<Record<string, unknown>>,
  registered: Array<Record<string, unknown>>,
): void {
  for (const asset of declared) {
    const matches = registered.filter((candidate) => idOf(candidate) === idOf(asset));
    if (matches.length !== 1) failures.push(`${label}:registration:${idOf(asset)}:${matches.length}`);
    else if (!sameAsset(asset, matches[0])) failures.push(`${label}:registration-drift:${idOf(asset)}`);
  }
}

function validateLook(failures: string[], look: Record<string, unknown>, requireCompleteColor = false): void {
  const id = idOf(look) || "<missing>";
  if (!idOf(look) || typeof look.name !== "string" || !look.name || typeof look.license !== "string" || !look.license || typeof look.provenance !== "string" || !look.provenance) failures.push(`look:identity:${id}`);
  if (typeof look.renderer !== "string" || !LOOK_RENDERERS.has(look.renderer)) failures.push(`look:renderer:${id}:${String(look.renderer)}`);
  const color = record(look.color);
  if (!color) {
    failures.push(`look:color:${id}`);
    return;
  }
  const ranges: Record<string, [number, number]> = {
    brightness: [-1, 1],
    contrast: [0.1, 3],
    saturation: [0, 3],
    hue: [-180, 180],
    exposure: [-5, 5],
    temperature: [-1, 1],
    tint: [-1, 1],
    whiteBalanceRed: [-4, 4],
    whiteBalanceGreen: [-4, 4],
    whiteBalanceBlue: [-4, 4],
    pivot: [0.1, 0.9],
    shadows: [-1, 1],
    highlights: [-1, 1],
    blacks: [-1, 1],
    whites: [-1, 1],
  };
  const requiredKeys = requireCompleteColor
    ? Object.keys(ranges)
    : ["brightness", "contrast", "saturation", "hue"];
  for (const key of requiredKeys) {
    if (!Object.hasOwn(color, key)) failures.push(`look:color:${id}:${key}`);
  }
  for (const [key, [min, max]] of Object.entries(ranges)) {
    const value = color[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)) failures.push(`look:color:${id}:${key}`);
  }
  for (const key of Object.keys(color)) if (!Object.hasOwn(ranges, key)) failures.push(`look:color-parameter:${id}:${key}`);
}

function validateTransition(failures: string[], transition: Record<string, unknown>): void {
  const id = idOf(transition) || "<missing>";
  if (!idOf(transition) || typeof transition.name !== "string" || !transition.name || typeof transition.license !== "string" || !transition.license || typeof transition.provenance !== "string" || !transition.provenance) failures.push(`transition:identity:${id}`);
  const renderer = typeof transition.renderer === "string" ? transition.renderer : "";
  const declaredRenderers = transition.renderers === undefined ? [renderer] : strings(transition.renderers);
  const rendererSet = new Set(declaredRenderers);
  if (declaredRenderers.length === 0 || declaredRenderers.length > 3 || rendererSet.size !== declaredRenderers.length || !rendererSet.has(renderer)) failures.push(`transition:renderers:${id}`);
  if (REQUIRED_COMPOUND_TRANSITION_IDS.has(id) && declaredRenderers.length <= 1) failures.push(`transition:compound-renderers:${id}`);
  for (const candidate of declaredRenderers) if (!TRANSITION_PARAMETER_CONTRACT[candidate]) failures.push(`transition:renderer:${id}:${candidate || "<missing>"}`);
  if (!TRANSITION_PARAMETER_CONTRACT[renderer]) failures.push(`transition:renderer:${id}:${renderer || "<missing>"}`);
  const parameterContract = Object.assign({}, ...declaredRenderers.map((candidate) => TRANSITION_PARAMETER_CONTRACT[candidate] ?? {})) as Record<string, { min: number; max: number; integer?: boolean; values?: readonly number[] }>;
  const duration = transition.defaultDuration;
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0.05 || duration > 2) failures.push(`transition:duration:${id}`);
  const parameters = transition.parameters === undefined ? undefined : record(transition.parameters);
  if (REQUIRED_COMPOUND_TRANSITION_IDS.has(id)) {
    if (!parameters) failures.push(`transition:compound-parameter:${id}:<missing>`);
    else {
      for (const candidate of declaredRenderers) {
        for (const key of TRANSITION_REQUIRED_PARAMETERS[candidate] ?? []) {
          if (!Object.hasOwn(parameters, key)) failures.push(`transition:compound-parameter:${id}:${candidate}:${key}`);
        }
      }
    }
  }
  if (transition.parameters !== undefined) {
    if (!parameters) failures.push(`transition:parameters:${id}`);
    else {
      for (const [key, value] of Object.entries(parameters)) {
        const contract = parameterContract[key];
        if (!contract) {
          failures.push(`transition:parameter-not-supported:${id}:${declaredRenderers.join("+")}:${key}`);
          continue;
        }
        if (typeof value !== "number" || !Number.isFinite(value) || value < contract.min || value > contract.max || (contract.integer && !Number.isInteger(value)) || (contract.values && !contract.values.includes(value))) failures.push(`transition:parameter-range:${id}:${key}`);
      }
    }
  }
}

function validateTransitionFallbacks(
  failures: string[],
  transitions: Array<Record<string, unknown>>,
  cinematicTransitions: Array<Record<string, unknown>>,
): void {
  const byId = new Map(transitions.map((item) => [idOf(item), item]));
  for (const transition of cinematicTransitions) {
    const id = idOf(transition);
    const routing = record(transition.routing);
    if (!routing) {
      failures.push(`transition:routing:${id}`);
      continue;
    }
    for (const key of ["intents", "beatRoles", "avoidRoles"] as const) if (strings(routing[key]).length === 0) failures.push(`transition:routing:${id}:${key}`);
    if (!Number.isInteger(routing.requiredHandlesFrames) || Number(routing.requiredHandlesFrames) < 0 || Number(routing.requiredHandlesFrames) > 300) failures.push(`transition:routing:${id}:requiredHandlesFrames`);
    if (!["low", "medium", "high"].includes(String(routing.intensity))) failures.push(`transition:routing:${id}:intensity`);
    const fallbackId = typeof routing.fallbackId === "string" ? routing.fallbackId : "";
    if (!fallbackId || fallbackId === id || !byId.has(fallbackId)) failures.push(`transition:fallback:${id}:${fallbackId || "<missing>"}`);
  }
  for (const transition of cinematicTransitions) {
    const visited = new Set<string>();
    let cursor: Record<string, unknown> | undefined = transition;
    while (cursor) {
      const id = idOf(cursor);
      if (visited.has(id)) {
        failures.push(`transition:fallback-cycle:${idOf(transition)}:${id}`);
        break;
      }
      visited.add(id);
      const routing = record(cursor.routing);
      const fallbackId = typeof routing?.fallbackId === "string" ? routing.fallbackId : "";
      cursor = fallbackId ? byId.get(fallbackId) : undefined;
    }
  }
}

function validateRecipeFallbacks(failures: string[], recipes: Array<Record<string, unknown>>): number {
  const byId = new Map(recipes.map((item) => [idOf(item), item]));
  let terminals = 0;
  for (const recipe of recipes) {
    const id = idOf(recipe) || "<missing>";
    if (strings(recipe.operations).length < 4) failures.push(`recipe:operations:${id}`);
    if (strings(recipe.requirements).length === 0) failures.push(`recipe:requirements:${id}`);
    if (strings(recipe.avoidWhen).length === 0) failures.push(`recipe:avoidWhen:${id}`);
    if (strings(recipe.commandScopes).length === 0) failures.push(`recipe:commandScopes:${id}`);
    const evidenceCompilable = id === EVIDENCE_COMPILABLE_RECIPE.id;
    const expectedStatus = evidenceCompilable ? "evidence_compilable" : "planning_only";
    if (recipe.executionStatus !== expectedStatus) failures.push(`recipe:execution-contract:${id}`);
    if (recipe.tokenContract !== "recipe_id_plus_evidence_refs") failures.push(`recipe:token-contract:${id}`);
    if (evidenceCompilable) {
      if (recipe.compilerTool !== EVIDENCE_COMPILABLE_RECIPE.compilerTool) failures.push(`recipe:compiler-contract:${id}`);
      if (!sameClosedSet(strings(recipe.operations), EVIDENCE_COMPILABLE_RECIPE.operations)) failures.push(`recipe:compiler-operations:${id}`);
      if (!sameClosedSet(strings(recipe.requirements), EVIDENCE_COMPILABLE_RECIPE.requirements)) failures.push(`recipe:compiler-requirements:${id}`);
    } else if (recipe.compilerTool !== undefined) failures.push(`recipe:compiler-contract:${id}`);
    if (hasForbiddenApplyMarker(recipe)) failures.push(`recipe:apply-ready-marker:${id}`);
    const fallbackId = typeof recipe.fallbackId === "string" ? recipe.fallbackId : "";
    if (fallbackId && (fallbackId === id || !byId.has(fallbackId))) failures.push(`recipe:fallback:${id}:${fallbackId}`);
    if (!fallbackId) terminals += 1;
  }
  for (const recipe of recipes) {
    const visited = new Set<string>();
    let cursor: Record<string, unknown> | undefined = recipe;
    while (cursor) {
      const id = idOf(cursor);
      if (visited.has(id)) {
        failures.push(`recipe:fallback-cycle:${idOf(recipe)}:${id}`);
        break;
      }
      visited.add(id);
      const fallbackId: string = typeof cursor.fallbackId === "string" ? cursor.fallbackId : "";
      cursor = fallbackId ? byId.get(fallbackId) : undefined;
    }
  }
  if (terminals === 0) failures.push("recipe:missing-terminal-block");
  return terminals;
}

function validateBulletTime(failures: string[], tiers: Array<Record<string, unknown>>): void {
  const contract = REQUIRED_BULLET_TIME as Record<string, { status: string; honestLabel: string; requirements: readonly string[] }>;
  for (const tier of tiers) {
    const id = idOf(tier) || "<missing>";
    const expected = contract[id];
    if (!expected) continue;
    if (tier.status !== expected.status || tier.honestLabel !== expected.honestLabel || tier.executionStatus !== "planning_only") failures.push(`bullet-time:honesty:${id}`);
    const requirements = new Set(strings(tier.requirements));
    for (const requirement of expected.requirements) if (!requirements.has(requirement)) failures.push(`bullet-time:requirement:${id}:${requirement}`);
    if (typeof tier.forbiddenClaim !== "string" || !tier.forbiddenClaim) failures.push(`bullet-time:forbidden-claim:${id}`);
    if (hasForbiddenApplyMarker(tier)) failures.push(`bullet-time:apply-ready-marker:${id}`);
  }
}

export function evaluateCinematicAssetProductGate(input: CinematicAssetGateInput): CinematicAssetGateResult {
  const failures: string[] = [];
  const recipeIds = input.recipes.map(idOf);
  const bulletTimeIds = input.bulletTime.map(idOf);
  const cinematicLookIds = input.cinematicLooks.map(idOf);
  const cinematicTransitionIds = input.cinematicTransitions.map(idOf);

  requireClosedSet(failures, "recipe", recipeIds, REQUIRED_RECIPE_IDS);
  requireClosedSet(failures, "bullet-time", bulletTimeIds, Object.keys(REQUIRED_BULLET_TIME));
  requireClosedSet(failures, "cinematic-look", cinematicLookIds, REQUIRED_CINEMATIC_LOOK_IDS);
  requireClosedSet(failures, "cinematic-transition", cinematicTransitionIds, REQUIRED_CINEMATIC_TRANSITION_IDS);

  const allAssetGroups = [input.recipes, input.bulletTime, input.looks, input.transitions];
  for (const [index, group] of allAssetGroups.entries()) {
    for (const duplicate of duplicateIds(group)) failures.push(`id:duplicate:group-${index + 1}:${duplicate}`);
  }
  for (const duplicate of duplicateIds(allAssetGroups.flat())) failures.push(`id:duplicate:global:${duplicate}`);

  const terminalBlockingRecipes = validateRecipeFallbacks(failures, input.recipes);
  validateBulletTime(failures, input.bulletTime);
  const cinematicLookSet = new Set(cinematicLookIds);
  input.looks.forEach((look) => validateLook(failures, look, cinematicLookSet.has(idOf(look))));
  input.transitions.forEach((transition) => validateTransition(failures, transition));
  validateTransitionFallbacks(failures, input.transitions, input.cinematicTransitions);
  validateRegistration(failures, "cinematic-look", input.cinematicLooks, input.looks);
  validateRegistration(failures, "cinematic-transition", input.cinematicTransitions, input.transitions);
  if (hasForbiddenApplyMarker(input.compactIndex)) failures.push("compact-index:apply-ready-marker");
  const compact = input.compactIndex;
  const compactRecipes = Array.isArray(compact.recipes) ? compact.recipes : [];
  const compactBulletTime = Array.isArray(compact.bulletTime) ? compact.bulletTime : [];
  if (compactRecipes.length !== input.recipes.length || compactBulletTime.length !== input.bulletTime.length) failures.push("compact-index:closed-world-count");
  requireClosedSet(failures, "compact-recipe", compactRecipes.map((item) => idOf(record(item) ?? {})), REQUIRED_RECIPE_IDS);
  for (const value of compactRecipes) {
    const item = record(value) ?? {};
    const id = idOf(item);
    const evidenceCompilable = id === EVIDENCE_COMPILABLE_RECIPE.id;
    const expectedStatus = evidenceCompilable ? "evidence_compilable" : "planning_only";
    if (item.executionStatus !== expectedStatus || (evidenceCompilable ? item.compilerTool !== EVIDENCE_COMPILABLE_RECIPE.compilerTool : item.compilerTool !== undefined)) failures.push(`compact-index:recipe-execution-contract:${id || "<missing>"}`);
  }
  if (compactBulletTime.some((item) => record(item)?.executionStatus !== "planning_only")) failures.push("compact-index:bullet-time-planning-contract");

  return {
    schema: "editkin.cinematic-asset-product-gate/v1",
    status: failures.length === 0 ? "GREEN" : "BLOCK",
    failures,
    counts: {
      recipes: input.recipes.length,
      bulletTimeTiers: input.bulletTime.length,
      looks: input.looks.length,
      transitions: input.transitions.length,
      cinematicLooks: input.cinematicLooks.length,
      cinematicTransitions: input.cinematicTransitions.length,
      evidenceCompilableRecipes: input.recipes.filter((recipe) => recipe.executionStatus === "evidence_compilable").length,
      terminalBlockingRecipes,
    },
    closedWorld: { recipeIds, bulletTimeIds, cinematicLookIds, cinematicTransitionIds },
  };
}

export function assertCinematicAssetProductGate(input: CinematicAssetGateInput): CinematicAssetGateResult {
  const result = evaluateCinematicAssetProductGate(input);
  if (result.status !== "GREEN") throw new Error(`cinematic asset product gate BLOCK: ${result.failures.join(" | ")}`);
  return result;
}
