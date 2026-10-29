import type { McpServer } from "@modelcontextprotocol/server";

/**
 * MCP profiles decide which registered tools tools/list advertises (W2-1). Dispatch is unchanged in every profile: a
 * registered tool that a profile does not advertise still answers tools/call by its exact name, byte for byte, so no
 * stored VA request, harness replay or receipt can break because of a profile. Only the advertised surface (and so
 * the agent's token cost) changes.
 *
 * - compat (default): the tools VA v4 and its harnesses call, plus the tools Editkin's own instructions point to.
 * - v5: the ten Agent API v5 slots (empty until those packages land) plus the always-advertised status tools.
 * - full: every registered tool (old harnesses, Codex replay).
 * - admin: remote onboarding and installed skill-pack management.
 */
export const MCP_PROFILES = ["compat", "v5", "full", "admin"] as const;
export type McpProfile = typeof MCP_PROFILES[number];
export const MCP_PROFILE_ENV = "EDITKIN_MCP_PROFILE";

/** Agent API v5 (AREA_C §4.2). Reserved names only; a slot is advertised once a later package registers it. */
export const V5_TOOL_SLOTS = Object.freeze([
  "project", "material_prepare", "material_view", "catalog", "draft_apply",
  "preview_frames", "seal", "render", "job", "review",
] as const);

/** Advertised in every profile. */
export const ALWAYS_ADVERTISED_TOOLS = Object.freeze(["get_editkin_status", "describe_tool_input_schema"] as const);

/**
 * compat legacy tools, with the evidence for each group (W2-1 cross-check, 2026-10-23):
 * A. named anywhere in the canonical VA skill (60; the public Kit v0.25.0 names a subset of 33);
 * B. called by recorded VA v4 runs (videos/_AUTOPILOT/editkin-v4/**\/*.request.json, 1,538 calls) and not in A;
 * C. harness readback tools (mcp-batch / run_unit setup and verification);
 * D. named by Editkin's own server instructions or start_ai_editing_session workflow and not above;
 * E. named by the core project write refusals (storage.ts) as the tool to use instead;
 * F. required in tools/list by the desktop "連接 AI 助手" runtime probe (src-tauri agent_runtime_probe.rs: remote setup
 *    status/prepare/configure/verify), plus the connector list prepare_remote_setup needs first. They move to admin only
 *    once that probe stops requiring them.
 */
export const COMPAT_LEGACY_TOOLS = Object.freeze([
  // A. canonical VA + public Kit
  "add_creative_asset_to_timeline", "apply_autopilot_plan", "apply_creative_preset", "apply_longform_plan_set",
  "audit_autopilot_plan", "audit_longform_plan_set", "auto_add_music", "cancel_material_preparation_job",
  "compile_beat_montage", "compile_plugin_application", "get_autopilot_contract", "get_autopilot_design_brief",
  "get_material_context", "get_material_preparation_job", "get_plugin_capability", "inspect_reference_motion_instances",
  "list_creative_assets", "list_creative_presets", "list_editkin_modules", "list_editkin_templates",
  "list_installed_plugins", "list_mesh_3d_templates", "list_reference_motion_templates", "prepare_ai_material",
  "prepare_autopilot_motion_track", "prepare_autopilot_template_package", "prepare_clip_motion_preset", "prepare_editkin_module",
  "prepare_editkin_template", "prepare_floating_frame_scene", "prepare_illustrated_music_video_draft", "prepare_mesh_3d_template",
  "prepare_motion_graphic_creation", "prepare_motion_graphic_kit", "prepare_music_video_draft", "prepare_native_geometry_motion",
  "prepare_native_motion_revision", "prepare_native_motion_sequence", "prepare_native_reel_scene", "prepare_original_element",
  "prepare_original_motion_scene_2d", "prepare_original_motion_source", "prepare_original_motion_source_revision",
  "prepare_original_scene_graphic_revision", "prepare_proof_still", "prepare_reference_motion_design",
  "prepare_reference_motion_template", "prepare_reference_motion_template_reuse", "prepare_reference_motion_template_revision",
  "propose_auto_color_exposure", "propose_reference_white_balance", "rank_style_shots", "record_autopilot_outcome",
  "record_material_semantics", "render_original_motion_project", "render_project", "resolve_autopilot_inference_route",
  "resolve_cinematic_recipe", "start_ai_editing_session", "view_material_keyframes",
  // B. recorded VA v4 runs
  "create_project", "prepare_media_bootstrap", "apply_edit_commands", "get_project_summary", "resolve_editkin_skill_workflow",
  // C. harness readback
  "get_timeline_window", "validate_project",
  // D. Editkin server instructions / session workflow
  "inspect_roto_keyer_capabilities", "record_roto_keyer_evidence", "build_autopilot_roto_keyer_decision",
  "prepare_autopilot_auto_roto", "track_subject_and_attach_label",
  // E. named by storage.ts write refusals
  "prepare_media_source_relink", "apply_media_source_relink", "prepare_reference_motion_template_source_replacement",
  // F. desktop Agent Connect probe
  "get_remote_setup_status", "prepare_remote_setup", "configure_remote_access", "verify_remote_access", "list_remote_provider_connectors",
] as const);

export const ADMIN_TOOLS = Object.freeze([
  "get_remote_setup_status", "list_remote_provider_connectors", "prepare_remote_setup", "configure_remote_access", "verify_remote_access",
  "list_installed_editkin_skills", "get_editkin_skill_pack", "get_editkin_workflow_profile",
] as const);

const PROFILE_SETS: Record<Exclude<McpProfile, "full">, ReadonlySet<string>> = {
  compat: new Set<string>([...ALWAYS_ADVERTISED_TOOLS, ...COMPAT_LEGACY_TOOLS, ...V5_TOOL_SLOTS]),
  v5: new Set<string>([...ALWAYS_ADVERTISED_TOOLS, ...V5_TOOL_SLOTS]),
  admin: new Set<string>([...ALWAYS_ADVERTISED_TOOLS, ...ADMIN_TOOLS]),
};

/** Closed world: an unknown profile is a configuration error, like EDITKIN_MCP_MODE. Empty or unset = compat. */
export function mcpProfileFromEnvironment(environment: NodeJS.ProcessEnv = process.env): McpProfile {
  const value = environment[MCP_PROFILE_ENV];
  if (value === undefined || value === "") return "compat";
  if ((MCP_PROFILES as readonly string[]).includes(value)) return value as McpProfile;
  throw new Error(`${MCP_PROFILE_ENV} must be one of ${MCP_PROFILES.join(", ")}`);
}

export function profileAdvertisesTool(profile: McpProfile, toolName: string): boolean {
  return profile === "full" || PROFILE_SETS[profile].has(toolName);
}

/** The names a profile reserves (registered or not); `full` reserves none beyond what is registered. */
export function profileToolNames(profile: Exclude<McpProfile, "full">): string[] {
  return [...PROFILE_SETS[profile]].sort();
}

export interface McpProfileState {
  readonly profile: McpProfile;
  /** Every tool registered on this server, in registration order. */
  readonly registered: readonly string[];
  advertised(): string[];
}

type RequestHandler = (request: unknown, context: unknown) => unknown;
type ToolsListResult = { tools: Array<{ name: string }> } & Record<string, unknown>;

/**
 * Install before the first registerTool: records registrations, and for every profile except `full` wraps the SDK's
 * own tools/list handler so it emits the SDK's exact tool definitions, filtered to the profile. tools/call is untouched.
 */
export function installMcpProfile(server: McpServer, profile: McpProfile): McpProfileState {
  const registered: string[] = [];
  const register = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
  Object.assign(server, {
    registerTool: (...args: unknown[]) => {
      const result = register(...args);
      registered.push(String(args[0]));
      return result;
    },
  });
  const protocol = (server as unknown as { server?: { setRequestHandler?: (...args: unknown[]) => unknown } }).server;
  if (profile !== "full" && protocol && typeof protocol.setRequestHandler === "function") {
    const setRequestHandler = protocol.setRequestHandler.bind(protocol);
    protocol.setRequestHandler = (...args: unknown[]) => {
      const [method, handler] = args;
      if (method === "tools/list" && args.length === 2 && typeof handler === "function") {
        const listTools = handler as RequestHandler;
        return setRequestHandler(method, async (request: unknown, context: unknown) => {
          const listed = await listTools(request, context) as ToolsListResult;
          return { ...listed, tools: listed.tools.filter((tool) => profileAdvertisesTool(profile, tool.name)) };
        });
      }
      return setRequestHandler(...args);
    };
  }
  return {
    profile,
    registered,
    advertised: () => registered.filter((name) => profileAdvertisesTool(profile, name)),
  };
}
