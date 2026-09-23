export type CinematicRecipeId =
  | "spatial_orientation"
  | "dialogue_flow"
  | "match_action_carry"
  | "reveal_ladder"
  | "semantic_punch_in"
  | "process_progress_result"
  | "parallel_ab_montage"
  | "rhythmic_crescendo"
  | "beat_aligned_montage"
  | "multicam_performance"
  | "time_sculpt";

export type CinematicRecipeExecutionStatus = "planning_only" | "evidence_compilable";
export type CinematicCompilerTool = "compile_beat_montage";

export interface CinematicLanguageRecipe {
  id: CinematicRecipeId;
  name: string;
  family: "continuity" | "dialogue" | "reveal" | "tutorial" | "montage" | "performance" | "time_design";
  intents: string[];
  beatRoles: string[];
  operations: string[];
  requirements: string[];
  avoidWhen: string[];
  fallbackId?: CinematicRecipeId;
  executionStatus: CinematicRecipeExecutionStatus;
  compilerTool?: CinematicCompilerTool;
  commandScopes: Array<"cut" | "audio_split" | "transition" | "retime" | "marker" | "camera_selection">;
  tokenContract: "recipe_id_plus_evidence_refs";
  provenance: "Editkin original editorial recipe";
}

type CinematicRecipeSeed = Omit<CinematicLanguageRecipe, "executionStatus" | "compilerTool" | "tokenContract" | "provenance"> & {
  executionStatus?: CinematicRecipeExecutionStatus;
  compilerTool?: CinematicCompilerTool;
};

const recipe = (value: CinematicRecipeSeed): CinematicLanguageRecipe => ({
  ...value,
  executionStatus: value.executionStatus ?? "planning_only",
  tokenContract: "recipe_id_plus_evidence_refs",
  provenance: "Editkin original editorial recipe",
});

export const CINEMATIC_LANGUAGE_RECIPES: readonly CinematicLanguageRecipe[] = Object.freeze([
  recipe({ id: "spatial_orientation", name: "空間建立", family: "continuity", intents: ["orientation", "location_intro"], beatRoles: ["setup"], operations: ["wide_establishing", "medium_relationship", "detail_insert", "preserve_screen_direction"], requirements: ["shot_scale_labels", "scene_boundaries"], avoidWhen: ["single_shot_only"], commandScopes: ["cut", "camera_selection", "marker"] }),
  recipe({ id: "dialogue_flow", name: "對話聲畫流", family: "dialogue", intents: ["conversation", "interview"], beatRoles: ["explain", "reaction"], operations: ["master_audio", "shot_reverse_shot", "reaction_insert", "j_cut", "l_cut"], requirements: ["speaker_turns", "clean_dialogue"], avoidWhen: ["music_only"], fallbackId: "spatial_orientation", commandScopes: ["cut", "audio_split", "camera_selection"] }),
  recipe({ id: "match_action_carry", name: "動作接力", family: "continuity", intents: ["motion_continuity", "energy"], beatRoles: ["build", "impact"], operations: ["match_motion_axis", "cut_mid_action", "preserve_subject_position", "optional_axis_transition"], requirements: ["motion_vectors_or_track", "shot_handles"], avoidWhen: ["crossing_motion_high", "tracking_low_confidence"], fallbackId: "spatial_orientation", commandScopes: ["cut", "transition", "marker"] }),
  recipe({ id: "reveal_ladder", name: "階梯式揭示", family: "reveal", intents: ["mystery", "payoff", "product_reveal"], beatRoles: ["setup", "build", "impact"], operations: ["obscured_detail", "partial_information", "audio_lead", "wide_reveal"], requirements: ["detail_and_wide_shots"], avoidWhen: ["answer_already_visible"], commandScopes: ["cut", "audio_split", "camera_selection", "marker"] }),
  recipe({ id: "semantic_punch_in", name: "語意推近", family: "tutorial", intents: ["emphasis", "proof", "metric"], beatRoles: ["impact", "explain"], operations: ["detect_semantic_peak", "bounded_punch_in", "vary_consecutive_scale", "protect_caption_safe_area"], requirements: ["semantic_timestamps", "source_resolution_headroom"], avoidWhen: ["already_tight_closeup"], fallbackId: "process_progress_result", commandScopes: ["transition", "marker"] }),
  recipe({ id: "process_progress_result", name: "流程進度成果", family: "tutorial", intents: ["tutorial", "build_in_public", "product_demo"], beatRoles: ["problem", "process", "proof", "payoff"], operations: ["problem_context", "hand_or_ui_action", "milestone", "failure_or_correction", "result"], requirements: ["semantic_segments"], avoidWhen: ["no_process_footage"], commandScopes: ["cut", "camera_selection", "marker"] }),
  recipe({ id: "parallel_ab_montage", name: "A／B 平行蒙太奇", family: "montage", intents: ["comparison", "parallel_action", "before_after"], beatRoles: ["build", "comparison"], operations: ["build_two_storylines", "match_object_or_action", "alternate_tracks", "audio_bridge", "resolve_comparison"], requirements: ["two_semantic_groups", "shared_match_feature"], avoidWhen: ["unclear_a_b_identity"], fallbackId: "process_progress_result", commandScopes: ["cut", "audio_split", "marker"] }),
  recipe({ id: "rhythmic_crescendo", name: "節奏漸強蒙太奇", family: "montage", intents: ["energy", "progress", "challenge"], beatRoles: ["build", "impact"], operations: ["decreasing_shot_duration_ratio", "one_counter_pause", "music_phrase_alignment", "payoff_hold"], requirements: ["enough_distinct_shots", "beat_grid_or_event_peaks"], avoidWhen: ["sensitive_dialogue", "repetitive_shots"], commandScopes: ["cut", "audio_split", "marker"] }),
  recipe({ id: "beat_aligned_montage", name: "節拍對齊蒙太奇", family: "montage", intents: ["beat_alignment", "energy", "showreel"], beatRoles: ["build", "impact"], operations: ["select_by_salience", "story_order", "source_trim", "align_cut_points_to_beat_grid"], requirements: ["shot_evidence", "caller_beat_grid"], avoidWhen: ["sensitive_dialogue", "insufficient_compatible_shots"], commandScopes: ["cut"], executionStatus: "evidence_compilable", compilerTool: "compile_beat_montage" }),
  recipe({ id: "multicam_performance", name: "多機位表演剪接", family: "performance", intents: ["performance", "podcast", "event"], beatRoles: ["explain", "reaction", "impact"], operations: ["master_audio", "sync_angles", "cut_on_phrase_or_gesture", "reaction_priority", "avoid_same_scale_jump"], requirements: ["two_or_more_synced_cameras"], avoidWhen: ["unsynced_sources"], fallbackId: "dialogue_flow", commandScopes: ["cut", "audio_split", "camera_selection", "marker"] }),
  recipe({ id: "time_sculpt", name: "時間雕刻", family: "time_design", intents: ["impact", "sports", "transformation"], beatRoles: ["build", "impact", "resolution"], operations: ["normal_speed", "speed_ramp", "slow_or_freeze", "resume_motion", "flow_quality_gate"], requirements: ["frame_rate_metadata", "motion_quality_analysis"], avoidWhen: ["flow_occlusion_failure"], fallbackId: "match_action_carry", commandScopes: ["retime", "cut", "marker"] }),
]);

export interface BulletTimeCapability {
  id: "bt_l1_25d_orbit" | "bt_l2_monocular_reconstruction" | "bt_l3_volumetric_capture";
  name: string;
  status: "prototype" | "research" | "capture_required";
  honestLabel: string;
  requirements: string[];
  forbiddenClaim: string;
  executionStatus: "planning_only";
}

export const BULLET_TIME_CAPABILITIES: readonly BulletTimeCapability[] = Object.freeze([
  { id: "bt_l1_25d_orbit", name: "2.5D 環繞模擬", status: "prototype", executionStatus: "planning_only", honestLabel: "2.5D 模擬；非真實新視角", requirements: ["subject_matte", "depth_map", "background_inpaint", "bounded_camera_arc"], forbiddenClaim: "真實子彈時間" },
  { id: "bt_l2_monocular_reconstruction", name: "單目重建環繞", status: "research", executionStatus: "planning_only", honestLabel: "AI 重建視角；不可見區可能推測生成", requirements: ["camera_poses", "intrinsics", "dynamic_depth_or_3dgs", "temporal_occlusion_qa"], forbiddenClaim: "任何單鏡一鍵真實新視角" },
  { id: "bt_l3_volumetric_capture", name: "多機體積擷取", status: "capture_required", executionStatus: "planning_only", honestLabel: "真實多機體積擷取", requirements: ["synchronized_cameras", "intrinsics_extrinsics", "lens_calibration", "timecode_or_genlock", "volumetric_reconstruction"], forbiddenClaim: "單機素材可直接取得" },
]);

export function compactCinematicLanguageIndex() {
  return {
    recipes: CINEMATIC_LANGUAGE_RECIPES.map(({ id, name, family, intents, beatRoles, requirements, avoidWhen, fallbackId, executionStatus, compilerTool, commandScopes, tokenContract }) => ({ id, name, family, intents, beatRoles, requirements, avoidWhen, fallbackId, executionStatus, ...(compilerTool ? { compilerTool } : {}), commandScopes, tokenContract })),
    bulletTime: BULLET_TIME_CAPABILITIES,
  };
}

export function resolveCinematicRecipe(recipeId: string, availableCapabilities: readonly string[]) {
  const byId = new Map(CINEMATIC_LANGUAGE_RECIPES.map((item) => [item.id, item]));
  const requested = byId.get(recipeId as CinematicRecipeId);
  if (!requested) throw new Error(`找不到鏡頭語言 recipe：${recipeId}`);
  const available = new Set(availableCapabilities);
  const visited: string[] = [];
  let candidate: CinematicLanguageRecipe | undefined = requested;
  while (candidate && !visited.includes(candidate.id)) {
    visited.push(candidate.id);
    const missingRequirements = candidate.requirements.filter((requirement) => !available.has(requirement));
    if (missingRequirements.length === 0) {
      const compilerCandidate = candidate.executionStatus === "evidence_compilable";
      return {
        status: compilerCandidate
          ? candidate.id === requested.id ? "DRAFT_COMPILER_CANDIDATE" : "FALLBACK_DRAFT_COMPILER_CANDIDATE"
          : candidate.id === requested.id ? "DRAFT_PLAN_CANDIDATE" : "FALLBACK_DRAFT_PLAN_CANDIDATE",
        executionStatus: candidate.executionStatus,
        compilerTool: candidate.compilerTool ?? null,
        directApplyAllowed: false,
        evidenceAuthority: "caller_asserted_unverified",
        requestedId: requested.id,
        selectedId: candidate.id,
        missingRequirements: [],
        fallbackChain: visited,
      } as const;
    }
    candidate = candidate.fallbackId ? byId.get(candidate.fallbackId) : undefined;
  }
  return { status: "BLOCKED", executionStatus: requested.executionStatus, compilerTool: requested.compilerTool ?? null, directApplyAllowed: false, evidenceAuthority: "caller_asserted_unverified", requestedId: requested.id, selectedId: null, missingRequirements: requested.requirements.filter((requirement) => !available.has(requirement)), fallbackChain: visited } as const;
}
