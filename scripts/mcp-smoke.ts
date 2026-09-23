import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { copyFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { strict as assert } from "node:assert";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createAutopilotV3Fixture, createAutopilotV4Fixture } from "../src/application/autopilotPlanFixture";
import { sha256Canonical } from "../src/application/autopilotInvocationIdentity";
import { MOTION_TREATMENT_FAMILIES, motionCommandFamilies } from "../src/application/motionTreatment";
import type { EditorCommand } from "../src/domain/commands";
import { discoverInstalledPlugins, findInstalledCapability, installedSkillPackCandidates } from "../src/plugins/registry";
import { safeEmptyWorkflowProfile } from "../src/plugins/workflowProfileFileStore";

function cleanEnvironment(extra: Record<string, string>): Record<string, string> {
  const current = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  return { ...current, ...extra };
}

async function main() {
  const appRoot = resolve(import.meta.dirname, "..");
  const workspace = await mkdtemp(join(tmpdir(), "editkin-mcp-"));
  const tsxCli = resolve(appRoot, "node_modules/tsx/dist/cli.mjs");
  const client = new Client({ name: "editkin-smoke", version: "0.15.0" });
  const packagedCommand = process.env.HAO_MCP_COMMAND;
  const packagedArgs = process.env.HAO_MCP_ARGS_JSON ? JSON.parse(process.env.HAO_MCP_ARGS_JSON) as string[] : undefined;
  const ffmpegPath = process.env.HAO_FFMPEG_PATH ?? resolve(appRoot, "vendor/ffmpeg/win32-x64/ffmpeg.exe");
  const pluginRoot = resolve(appRoot, "plugins");
  const workflowProfilePath = join(workspace, "workflow-profile.json");
  const hostRegistry = await discoverInstalledPlugins([pluginRoot]);
  const hostSkill = installedSkillPackCandidates(hostRegistry).find((candidate) => candidate.skillId === "studio.hao.creator-workflow/balanced-creator-workflow");
  if (!hostSkill) throw new Error("MCP smoke 缺少 bundled Workflow Skill");
  const hostPluginCapability = findInstalledCapability(hostRegistry, "studio.hao.creator-accelerators", "clean-creator-polish");
  const hostWorkflowProfile = {
    ...safeEmptyWorkflowProfile(),
    id: "mcp-smoke",
    enabledSkills: [hostSkill.skillId],
    priority: [hostSkill.skillId],
    grants: [{ skillId: hostSkill.skillId, manifestSha256: hostSkill.manifestSha256, packSha256: hostSkill.packSha256, permissions: ["workflow.read" as const] }],
    pluginGrants: [{
      pluginId: hostPluginCapability.plugin.manifest.id,
      manifestSha256: hostPluginCapability.plugin.manifestSha256,
      capabilityIds: [hostPluginCapability.capability.id],
      permissions: ["project.write" as const],
    }],
  };
  const writeProfileThroughNativeServiceBoundary = async (profile: unknown) => {
    const request = JSON.stringify({
      command: "write_workflow_profile",
      payload: { path: workflowProfilePath, profile },
      runtime: { pluginRoots: [pluginRoot] },
    });
    const envelope = await new Promise<{ ok: boolean; result?: unknown; error?: string }>((accept, reject) => {
      const child = spawn(process.execPath, [tsxCli, "src/service/cli.ts"], {
        cwd: appRoot,
        env: cleanEnvironment({}),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
      child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
      child.once("error", reject);
      child.once("close", (code) => {
        try {
          const parsed = JSON.parse(Buffer.concat(stdout).toString("utf8"));
          if (code !== 0) reject(new Error(Buffer.concat(stderr).toString("utf8") || parsed.error || `service exit ${code}`));
          else accept(parsed);
        } catch (error) { reject(error); }
      });
      child.stdin.end(request);
    });
    if (!envelope.ok) throw new Error(envelope.error ?? "Workflow Profile service write failed");
    return envelope.result;
  };
  await writeProfileThroughNativeServiceBoundary(hostWorkflowProfile);
  const transport = new StdioClientTransport({
    command: packagedCommand ?? process.execPath,
    args: packagedArgs ?? [tsxCli, "src/mcp/server.ts"],
    cwd: appRoot,
    env: cleanEnvironment({
      EDITKIN_WORKSPACE: workspace,
      EDITKIN_CREATIVE_PACK_ROOT: resolve(appRoot, ".creative-packs/hao-creator-library"),
      EDITKIN_PERSONAL_MUSIC_ROOT: resolve(appRoot, ".personal-packs/hao-music-library"),
      EDITKIN_MODEL_ROOT: resolve(appRoot, "../../.rd/models/whisper"),
      EDITKIN_WHISPER_CLI_PATH: resolve(appRoot, "vendor/whisper/win32-x64/whisper-cli.exe"),
      EDITKIN_CACHE_ROOT: resolve(appRoot, "../../.rd/cache/editkin-mcp"),
      EDITKIN_PLUGIN_ROOTS: pluginRoot,
      EDITKIN_WORKFLOW_PROFILE_PATH: workflowProfilePath,
      HAO_FFMPEG_PATH: ffmpegPath,
      HAO_FFPROBE_PATH: resolve(appRoot, "vendor/ffmpeg/win32-x64/ffprobe.exe"),
      HAO_NATIVE_CORE_PATH: resolve(appRoot, "native/bin/win32-x64/hao-core.exe"),
    }),
    stderr: "pipe",
  });

  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ["add_creative_asset_to_timeline", "apply_autopilot_plan", "apply_creative_preset", "apply_edit_commands", "audit_autopilot_plan", "audit_editorial_batch_plan", "auto_add_music", "auto_cut_silence", "auto_edit_highlights", "auto_split_scenes", "auto_transcribe_captions", "build_autopilot_roto_keyer_decision", "cancel_material_preparation_job", "compile_beat_montage", "compile_plugin_application", "configure_remote_access", "create_editorial_batch_projects", "create_project", "direct_podcast_speakers", "get_autopilot_batch_status", "get_autopilot_contract", "get_autopilot_design_brief", "get_editkin_skill_pack", "get_editkin_workflow_profile", "get_material_context", "get_material_preparation_job", "get_plugin_capability", "get_project_summary", "get_remote_setup_status", "get_timeline_window", "inspect_roto_keyer_capabilities", "list_community_editing_knowledge", "list_creative_assets", "list_creative_presets", "list_installed_editkin_skills", "list_installed_plugins", "list_remote_provider_connectors", "prepare_ai_material", "prepare_autopilot_auto_roto", "prepare_remote_setup", "propose_auto_color_exposure", "propose_reference_white_balance", "read_community_editing_knowledge", "record_autopilot_outcome", "record_material_semantics", "record_roto_keyer_evidence", "render_editorial_batch", "render_project", "resolve_autopilot_inference_route", "resolve_cinematic_recipe", "resolve_editkin_skill_workflow", "run_autopilot_batch", "start_ai_editing_session", "track_subject_and_attach_label", "validate_project", "verify_remote_access", "view_material_keyframes"]);

    const autopilotContract = await client.callTool({ name: "get_autopilot_contract", arguments: {} });
    assert.equal(autopilotContract.isError, undefined);
    assert.equal(JSON.stringify(autopilotContract.content).includes("Private\\"), false);
    const autopilotContractPayload = JSON.parse(String((autopilotContract.content[0] as { text?: string })?.text ?? "{}"));
    assert.equal(autopilotContractPayload.status, "GREEN");
    assert.equal(autopilotContractPayload.liveInvocation.skill.id, "video-autopilot");
    assert.equal(autopilotContractPayload.liveInvocation.workflow.legacyPlanPolicy, "reject");
    assert.equal(autopilotContractPayload.requiredPlanSource.invocationBindingSha256, autopilotContractPayload.liveInvocation.bindingSha256);
    const inferenceRoute = await client.callTool({ name: "resolve_autopilot_inference_route", arguments: { taskClass: "quality_critical", priority: "quality" } });
    assert.equal(inferenceRoute.isError, undefined);
    const routePayload = JSON.parse(String((inferenceRoute.content[0] as { text?: string })?.text ?? "{}"));
    assert.equal(routePayload.route.secondPassRequired, true);
    assert.equal(routePayload.route.claimState, "official_positioning_only_quality_unmeasured");

    const communityKnowledge = await client.callTool({ name: "list_community_editing_knowledge", arguments: { tags: [], query: "" } });
    assert.equal(communityKnowledge.isError, undefined);
    const communityPayload = JSON.parse(String((communityKnowledge.content[0] as { text?: string })?.text ?? "{}"));
    assert.equal(communityPayload.modules.length, 16);
    assert.ok(communityPayload.totalModules >= 35);
    assert.equal(communityPayload.nextOffset, 16);
    const secondCommunityKnowledge = await client.callTool({ name: "list_community_editing_knowledge", arguments: { tags: [], query: "", offset: communityPayload.nextOffset, limit: 16 } });
    const secondCommunityPayload = JSON.parse(String((secondCommunityKnowledge.content[0] as { text?: string })?.text ?? "{}"));
    assert.notEqual(secondCommunityPayload.modules[0].id, communityPayload.modules[0].id);
    const knowledgePage = await client.callTool({
      name: "read_community_editing_knowledge",
      arguments: { moduleId: communityPayload.modules[0].id, offset: 0, maxChars: 500, maxTokens: 300 },
    });
    assert.equal(knowledgePage.isError, undefined);
    const knowledgeText = String((knowledgePage.content[0] as { text?: string })?.text ?? "");
    assert.ok(JSON.parse(knowledgeText).page.text.length <= 500);
    assert.ok(JSON.parse(knowledgeText).page.estimatedTokens <= 300);
    assert.equal(/Hao0321|駱君昊|[A-Z]:\\Users\\|@[A-Za-z0-9_]{2,}/i.test(knowledgeText), false);

    const presets = await client.callTool({ name: "list_creative_presets", arguments: { kind: "all" } });
    assert.equal(presets.isError, undefined);
    const presetsPayload = JSON.parse(String((presets.content[0] as { text?: string })?.text ?? "{}"));
    assert.equal(presetsPayload.presets.motionGraphics.length, 64);
    assert.deepEqual(presetsPayload.presets.motionGraphics
      .filter((preset: { id: string }) => preset.id.startsWith("travel_editorial_"))
      .map((preset: { id: string }) => preset.id).sort(), [
      "travel_editorial_eyebrow", "travel_editorial_eyebrow_dark", "travel_editorial_hero", "travel_editorial_hero_dark",
    ]);
    assert.equal(presetsPayload.presets.transitions.length, 52);
    assert.equal(presetsPayload.presets.cinematicLanguage.recipes.length, 11);
    assert.equal(presetsPayload.presets.cinematicLanguage.recipes.filter((recipe: { executionStatus: string }) => recipe.executionStatus === "planning_only").length, 10);
    assert.equal(presetsPayload.presets.cinematicLanguage.recipes.filter((recipe: { executionStatus: string }) => recipe.executionStatus === "evidence_compilable").length, 1);
    assert.equal(presetsPayload.presets.cinematicLanguage.bulletTime.length, 3);
    assert.equal(presetsPayload.presets.formatTemplates.shortForm.length, 10);
    assert.equal(presetsPayload.presets.formatTemplates.longForm.length, 6);
    assert.equal(presetsPayload.presets.formatTemplates.longForm.every((template: Record<string, unknown>) => template.captionColorPolicy === "white_only"), true);
    assert.equal(presetsPayload.presets.formatTemplates.shortForm.every((template: Record<string, unknown>) => template.executionBoundary === "visual_package_now_recipe_requires_evidence_gate"), true);
    assert.equal(presetsPayload.presets.motionGraphics.every((preset: Record<string, unknown>) => !Object.hasOwn(preset, "seed")), true);
    const compoundTransition = presetsPayload.presets.transitions.find((preset: { id: string }) => preset.id === "cine_proof_flash_push");
    assert.deepEqual(compoundTransition.renderers, ["transition-flash", "transition-zoom"]);
    const cinematicDraft = await client.callTool({ name: "resolve_cinematic_recipe", arguments: { recipeId: "rhythmic_crescendo", availableCapabilities: ["enough_distinct_shots", "beat_grid_or_event_peaks"] } });
    assert.equal(cinematicDraft.isError, undefined);
    const cinematicDraftPayload = JSON.parse(String((cinematicDraft.content[0] as { text?: string })?.text ?? "{}"));
    assert.equal(cinematicDraftPayload.status, "DRAFT_PLAN_CANDIDATE");
    assert.equal(cinematicDraftPayload.executionStatus, "planning_only");
    assert.equal(cinematicDraftPayload.evidenceAuthority, "caller_asserted_unverified");
    const montageCompilerDraft = await client.callTool({ name: "resolve_cinematic_recipe", arguments: { recipeId: "beat_aligned_montage", availableCapabilities: ["shot_evidence", "caller_beat_grid"] } });
    assert.equal(montageCompilerDraft.isError, undefined);
    const montageCompilerDraftPayload = JSON.parse(String((montageCompilerDraft.content[0] as { text?: string })?.text ?? "{}"));
    assert.equal(montageCompilerDraftPayload.status, "DRAFT_COMPILER_CANDIDATE");
    assert.equal(montageCompilerDraftPayload.executionStatus, "evidence_compilable");
    assert.equal(montageCompilerDraftPayload.compilerTool, "compile_beat_montage");
    assert.equal(montageCompilerDraftPayload.directApplyAllowed, false);
    assert.equal(montageCompilerDraftPayload.evidenceAuthority, "caller_asserted_unverified");
    const selectedMotionPreset = await client.callTool({
      name: "list_creative_presets",
      arguments: { kind: "motion", motionPresetId: "studio_marker_burst" },
    });
    assert.equal(selectedMotionPreset.isError, undefined);
    const selectedMotionPayload = JSON.parse(String((selectedMotionPreset.content[0] as { text?: string })?.text ?? "{}"));
    assert.equal(selectedMotionPayload.presets.selectedMotionPreset.seed.presetId, "studio_marker_burst");
    assert.equal(selectedMotionPayload.presets.selectedMotionPreset.seed.animation, "pop");
    const creativeAssets = await client.callTool({ name: "list_creative_assets", arguments: { query: "fashion", category: "broll", limit: 5 } });
    assert.equal(creativeAssets.isError, undefined);
    assert.equal(JSON.stringify(creativeAssets.content).includes("absolutePath"), false);

    const created = await client.callTool({
      name: "create_project",
      arguments: { projectPath: "smoke.editkin.json", name: "MCP Smoke", width: 960, height: 540, fps: 30 },
    });
    assert.equal(created.isError, undefined);

    const autopilotPlan = createAutopilotV3Fixture();
    const audited = await client.callTool({ name: "audit_autopilot_plan", arguments: { projectPath: "smoke.editkin.json", plan: autopilotPlan } });
    assert.equal(audited.isError, true, "legacy v3 must be rejected by the product audit path");
    const legacyApply = await client.callTool({
      name: "apply_autopilot_plan",
      arguments: {
        projectPath: "smoke.editkin.json",
        plan: autopilotPlan,
      },
    });
    assert.equal(legacyApply.isError, true, "legacy v3 must be rejected by the product apply path");

    const mediaPath = join(workspace, "demo-source.mp4");
    const speechPath = join(workspace, "speech.wav");
    const scenePath = join(workspace, "scenes.mp4");
    const highlightPath = join(workspace, "highlight.mp4");
    await copyFile(resolve(appRoot, "public/demo-source.mp4"), mediaPath);
    await promisify(execFile)(ffmpegPath, ["-hide_banner", "-nostdin", "-y", "-f", "lavfi", "-i", "flite=text='Turn speech into captions automatically.':voice=slt", "-ar", "16000", "-ac", "1", speechPath], { windowsHide: true, timeout: 60_000 });
    await promisify(execFile)(ffmpegPath, [
      "-hide_banner", "-nostdin", "-y",
      "-f", "lavfi", "-i", "color=c=red:s=640x360:r=30:d=2",
      "-f", "lavfi", "-i", "color=c=blue:s=640x360:r=30:d=2",
      "-f", "lavfi", "-i", "color=c=green:s=640x360:r=30:d=2",
      "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0,format=yuv420p", "-c:v", "libx264",
      "-x264-params", "colorprim=bt709:transfer=bt709:colormatrix=bt709:range=tv", scenePath,
    ], { windowsHide: true, timeout: 60_000 });
    await promisify(execFile)(ffmpegPath, [
      "-hide_banner", "-nostdin", "-y", "-i", scenePath, "-stream_loop", "-1", "-i", speechPath,
      "-map", "0:v:0", "-map", "1:a:0", "-t", "6", "-c:v", "copy", "-c:a", "aac", "-b:a", "128k", highlightPath,
    ], { windowsHide: true, timeout: 60_000 });
    const changed = await client.callTool({
      name: "apply_edit_commands",
      arguments: {
        projectPath: "smoke.editkin.json",
        commands: [
          { type: "rename_project", name: "Agent Edited" },
          { type: "import_asset", asset: { id: "asset-demo", name: "Demo", kind: "video", uri: mediaPath, duration: 12, width: 960, height: 540 } },
          { type: "add_clip", clip: { id: "clip-demo", assetId: "asset-demo", trackId: "video-main", timelineStart: 0, sourceStart: 0, duration: 12, volume: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, color: { brightness: 0, contrast: 1, saturation: 1, hue: 0, exposure: 0, temperature: 0, tint: 0, pivot: 0.5, shadows: 0, highlights: 0, blacks: 0, whites: 0 }, keyframes: [] } },
          { type: "import_asset", asset: { id: "asset-speech", name: "Speech", kind: "audio", uri: speechPath, duration: 8 } },
          { type: "add_clip", clip: { id: "clip-speech", assetId: "asset-speech", trackId: "audio-main", timelineStart: 0, sourceStart: 0, duration: 8, volume: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, color: { brightness: 0, contrast: 1, saturation: 1, hue: 0, exposure: 0, temperature: 0, tint: 0, pivot: 0.5, shadows: 0, highlights: 0, blacks: 0, whites: 0 }, keyframes: [] } },
          { type: "add_track", track: { id: "video-scenes", name: "Scene Detection", kind: "video", locked: false, muted: false, clips: [] } },
          { type: "import_asset", asset: { id: "asset-scenes", name: "Scenes", kind: "video", uri: scenePath, duration: 6, width: 640, height: 360 } },
          { type: "add_clip", clip: { id: "clip-scenes", assetId: "asset-scenes", trackId: "video-scenes", timelineStart: 0, sourceStart: 0, duration: 6, volume: 0, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, color: { brightness: 0, contrast: 1, saturation: 1, hue: 0, exposure: 0, temperature: 0, tint: 0, pivot: 0.5, shadows: 0, highlights: 0, blacks: 0, whites: 0 }, keyframes: [] } },
          { type: "add_track", track: { id: "video-highlights", name: "Semantic Highlights", kind: "video", locked: false, muted: false, clips: [] } },
          { type: "import_asset", asset: { id: "asset-highlight", name: "Highlight", kind: "video", uri: highlightPath, duration: 6, width: 640, height: 360 } },
          { type: "add_clip", clip: { id: "clip-highlight", assetId: "asset-highlight", trackId: "video-highlights", timelineStart: 12, sourceStart: 0, duration: 6, volume: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, color: { brightness: 0, contrast: 1, saturation: 1, hue: 0, exposure: 0, temperature: 0, tint: 0, pivot: 0.5, shadows: 0, highlights: 0, blacks: 0, whites: 0 }, keyframes: [] } },
          { type: "add_caption", caption: { id: "caption-demo", text: "MCP Render", start: 1, duration: 2 } },
        ],
      },
    });
    assert.equal(changed.isError, undefined, JSON.stringify(changed.content));

    const montageProjectPath = join(workspace, "smoke.editkin.json");
    const montageBytesBefore = await readFile(montageProjectPath);
    const compiledMontage = await client.callTool({
      name: "compile_beat_montage",
      arguments: {
        projectPath: "smoke.editkin.json",
        beatTimes: [20, 21, 22],
        candidates: [
          { shotId: "setup", assetId: "asset-demo", sourceStart: 0, sourceEnd: 4, salience: .8, storyOrder: 1 },
          { shotId: "payoff", assetId: "asset-demo", sourceStart: 4, sourceEnd: 8, salience: .9, storyOrder: 2 },
        ],
        clipIds: ["montage-setup", "montage-payoff"],
      },
    });
    assert.equal(compiledMontage.isError, undefined, JSON.stringify(compiledMontage.content));
    const montagePayload = JSON.parse(String((compiledMontage.content[0] as { text?: string })?.text ?? "{}"));
    assert.equal(montagePayload.status, "DRAFT_COMMAND_CANDIDATE");
    assert.equal(montagePayload.mutationPerformed, false);
    assert.equal(montagePayload.evidenceAuthority, "caller_asserted_unverified");
    assert.equal(montagePayload.targetTrackId, "video-main");
    assert.equal(montagePayload.directApplyAllowed, false);
    assert.equal(montagePayload.executionBoundary, "compile_only_v4_plan_audit_atomic_apply_required");
    assert.equal(montagePayload.command.type, "batch");
    assert.equal(montagePayload.command.commands.length, 2);
    assert.equal(montagePayload.guarantees.cutPointsOnBeat, true);
    assert.equal(montagePayload.guarantees.pairwiseTransitions, false);
    assert.deepEqual(await readFile(montageProjectPath), montageBytesBefore, "compile_beat_montage must not mutate project bytes");

    const installedPlugins = await client.callTool({ name: "list_installed_plugins", arguments: { kind: "all", automationReadyOnly: true } });
    assert.equal(installedPlugins.isError, undefined);
    const pluginsPayload = JSON.parse(String((installedPlugins.content[0] as { text?: string })?.text ?? "{}"));
    const creatorPluginId = "studio.hao.creator-accelerators";
    const creatorCapabilities = pluginsPayload.candidates.filter((capability: { pluginId: string }) => capability.pluginId === creatorPluginId);
    assert.equal(creatorCapabilities.length, 8);
    for (const capabilityId of ["clean-punch-gpu", "mono-editorial-gpu", "warm-cinematic-gpu"]) {
      assert.equal(creatorCapabilities.some((capability: { capabilityId: string }) => capability.capabilityId === capabilityId), true);
    }
    const pluginCapability = await client.callTool({ name: "get_plugin_capability", arguments: { pluginId: creatorPluginId, capabilityId: "clean-creator-polish" } });
    assert.equal(pluginCapability.isError, undefined);
    const capabilityPayload = JSON.parse(String((pluginCapability.content[0] as { text?: string })?.text ?? "{}"));
    assert.equal(capabilityPayload.status, "AUTOMATION_READY");
    assert.equal(capabilityPayload.authorProseOmitted, true);
    for (const forbidden of ["description", "requires", "avoidWhen", "template", "readinessDetail", "name"]) {
      assert.equal(Object.hasOwn(capabilityPayload.capability, forbidden), false, `Agent capability detail leaked ${forbidden}`);
    }
    const skillList = await client.callTool({ name: "list_installed_editkin_skills", arguments: { context: { format: "longform", domain: "technology", semanticRoles: ["technology", "tutorial"] } } });
    assert.equal(skillList.isError, undefined);
    const skillListPayload = JSON.parse(String((skillList.content[0] as { text?: string })?.text ?? "{}"));
    const creatorSkill = skillListPayload.candidates.find((item: { skillId: string }) => item.skillId === "studio.hao.creator-workflow/balanced-creator-workflow");
    assert.ok(creatorSkill);
    const skillDetail = await client.callTool({ name: "get_editkin_skill_pack", arguments: { pluginId: "studio.hao.creator-workflow", capabilityId: "balanced-creator-workflow" } });
    assert.equal(skillDetail.isError, undefined);
    assert.equal(JSON.stringify(skillDetail.content).includes("description"), false, "automation Skill detail must not expose author prose");
    const hostProfile = await client.callTool({ name: "get_editkin_workflow_profile", arguments: {} });
    assert.equal(hostProfile.isError, undefined);
    const hostProfilePayload = JSON.parse(String((hostProfile.content[0] as { text?: string })?.text ?? "{}"));
    assert.equal(hostProfilePayload.configured, true);
    assert.deepEqual(hostProfilePayload.profile.enabledSkills, [creatorSkill.skillId]);
    const skillResolved = await client.callTool({ name: "resolve_editkin_skill_workflow", arguments: {
      context: { format: "longform", domain: "technology", semanticRoles: ["technology", "tutorial"] },
    } });
    assert.equal(skillResolved.isError, undefined, JSON.stringify(skillResolved.content));
    const skillResolvedPayload = JSON.parse(String((skillResolved.content[0] as { text?: string })?.text ?? "{}"));
    assert.equal(skillResolvedPayload.receipt.selected.length, 1);
    assert.equal(skillResolvedPayload.receipt.pluginRegistrySha256, autopilotContractPayload.liveInvocation.plugins.sha256);
    assert.equal(skillResolvedPayload.capabilityResolution.skillSelectionReceiptSha256, skillResolvedPayload.receipt.receiptSha256);
    assert.equal(skillResolvedPayload.capabilityResolution.resolutions.length, skillResolvedPayload.receipt.compiled.capabilityQueries.length);
    assert.equal(skillResolvedPayload.capabilityResolution.resolutions.every((resolution: { candidates: unknown[]; maxCandidates: number }) => resolution.candidates.length <= resolution.maxCandidates), true);
    const compilePlugin = async (capabilityId: string, targetClipId: string, parameters: Record<string, unknown>) => {
      const result = await client.callTool({
        name: "compile_plugin_application",
        arguments: { pluginId: creatorPluginId, capabilityId, targetClipId, parameters },
      });
      assert.equal(result.isError, undefined, JSON.stringify(result.content));
      const payload = JSON.parse(String((result.content[0] as { text?: string })?.text ?? "{}"));
      assert.equal(payload.mutationPerformed, false);
      return payload;
    };
    const compileAndApplyPlugin = async (capabilityId: string, targetClipId: string, parameters: Record<string, unknown>) => {
      const compiled = await compilePlugin(capabilityId, targetClipId, parameters);
      const applied = await client.callTool({
        name: "apply_edit_commands",
        arguments: { projectPath: "smoke.editkin.json", commands: compiled.commands },
      });
      assert.equal(applied.isError, undefined, JSON.stringify(applied.content));
      return compiled;
    };
    const pluginCompiled = await compileAndApplyPlugin("clean-creator-polish", "clip-demo", { effect: "scanline_focus" });
    assert.equal(pluginCompiled.commands.length, 1);
    assert.match(pluginCompiled.binding.manifestSha256, /^[a-f0-9]{64}$/);
    const particleCompiled = await compileAndApplyPlugin("particle-highlight-vfx", "clip-demo", {
      start: 0.6, duration: 0.8, rate: 72, lifetime: 1.5, radius: 4.5, velocity_y: -82, gravity_y: 96, emitter_y: 0.74,
    });
    assert.equal(particleCompiled.commands.length, 2);
    const persistedParticle = JSON.parse(await readFile(join(workspace, "smoke.editkin.json"), "utf8")).particleSimulation;
    assert.deepEqual(persistedParticle, {
      schema: "editkin.particle-simulation/v1", enabled: true, timeline: { start: 0.6, duration: 0.8 }, seed: 32021, ratePerSecond: 72,
      lifetimeSeconds: 1.5, maxParticles: 64, emitterPosition: [0.5, 0.74], initialVelocity: [18, -82],
      gravity: [0, 96], radiusPixels: 4.5, color: [1, 0.42, 0.06, 0.92],
    });
    const dualParticleCompiled = await compileAndApplyPlugin("dual-particle-burst-vfx", "project-context", {
      start: 0.6, duration: 0.8, secondary_start: 0.8, secondary_duration: 0.6, primary_rate: 48, secondary_rate: 36,
    });
    assert.equal(dualParticleCompiled.commands.length, 2);
    const persistedDualParticle = JSON.parse(await readFile(join(workspace, "smoke.editkin.json"), "utf8")).particleSimulation;
    assert.deepEqual(persistedDualParticle.additionalEmitters, [{
      id: "cool-trail", timeline: { start: 0.8, duration: 0.6 }, seed: 90210, ratePerSecond: 36,
      lifetimeSeconds: 0.9, maxParticles: 48, emitterPosition: [0.35, 0.62], initialVelocity: [-22, -58],
      gravity: [0, 70], radiusPixels: 2.5, color: [0.1, 0.65, 1, 0.85],
    }]);
    const beforeRejectedPlugin = await client.callTool({ name: "get_project_summary", arguments: { projectPath: "smoke.editkin.json" } });
    const rejectedPlugin = await client.callTool({
      name: "compile_plugin_application",
      arguments: { pluginId: creatorPluginId, capabilityId: "attention-punch", targetClipId: "clip-demo", parameters: { scale: 2 } },
    });
    assert.equal(rejectedPlugin.isError, true);
    const afterRejectedPlugin = await client.callTool({ name: "get_project_summary", arguments: { projectPath: "smoke.editkin.json" } });
    assert.deepEqual(afterRejectedPlugin.content, beforeRejectedPlugin.content, "被拒絕的外掛不得改動專案");

    const session = await client.callTool({ name: "start_ai_editing_session", arguments: { projectPath: "smoke.editkin.json" } });
    assert.equal(session.isError, undefined);
    const sessionText = JSON.stringify(session.content);
    assert.equal(sessionText.includes("apiKeyRequiredByEditkin\\\":false"), true);
    assert.equal(sessionText.includes(mediaPath), false);

    const prepared = await client.callTool({
      name: "prepare_ai_material",
      arguments: { projectPath: "smoke.editkin.json", clipId: "clip-scenes", includeTranscript: false, maxKeyframes: 4 },
    });
    assert.equal(prepared.isError, undefined);
    const preparedPayload = JSON.parse(String((prepared.content[0] as { text?: string })?.text ?? "{}"));
    assert.match(preparedPayload.packet.materialId, /^[a-f0-9]{64}$/);
    assert.equal(preparedPayload.packet.keyframes.length >= 3, true);
    assert.equal(JSON.stringify(preparedPayload).includes(scenePath), false);

    const frameIds = preparedPayload.packet.keyframes.slice(0, 4).map((frame: { id: string }) => frame.id);
    const viewed = await client.callTool({ name: "view_material_keyframes", arguments: { materialId: preparedPayload.packet.materialId, frameIds } });
    assert.equal(viewed.isError, undefined);
    assert.equal(viewed.content.filter((item) => item.type === "image").length, frameIds.length);
    const context = await client.callTool({ name: "get_material_context", arguments: { materialId: preparedPayload.packet.materialId, start: 0, end: 6, maxCues: 20 } });
    assert.equal(context.isError, undefined);

    const semantics = await client.callTool({
      name: "record_material_semantics",
      arguments: {
        materialId: preparedPayload.packet.materialId,
        sourceSha256: preparedPayload.packet.source.sourceSha256,
        overallTopic: "三段純色場景，用於驗證素材視覺理解與切換",
        contentType: "test-pattern",
        language: "none",
        people: [], locations: [],
        segments: [{ start: 0, end: 6, summary: "紅、藍、綠三個場景依序切換", subjects: [], actions: ["color changes"], objects: ["red", "blue", "green"], importance: 0.8, evidenceFrameIds: frameIds, transcriptCueIndexes: [] }],
      },
    });
    assert.equal(semantics.isError, undefined);
    const semanticsPayload = JSON.parse(String((semantics.content[0] as { text?: string })?.text ?? "{}"));
    const currentPlan = createAutopilotV4Fixture(autopilotContractPayload.requiredPlanSource);
    const planSkillSelection = await client.callTool({ name: "resolve_editkin_skill_workflow", arguments: {
      context: { format: "longform", domain: "technology", semanticRoles: [] },
    } });
    assert.equal(planSkillSelection.isError, undefined, JSON.stringify(planSkillSelection.content));
    const planSkillSelectionPayload = JSON.parse(String((planSkillSelection.content[0] as { text?: string })?.text ?? "{}"));
    const pluginCommandStart = currentPlan.commands.length;
    const designRequest = {
      format: currentPlan.route.format,
      domain: currentPlan.route.domain,
      topic: "三段純色場景的剪輯證據",
      duration: 90 / 30,
      styleFamily: currentPlan.aesthetic.primaryFamily,
      beats: currentPlan.editorial.narrative.beats.map((beat) => ({
        id: beat.id,
        role: beat.id === "promise" ? "first_frame" : beat.id === "payoff" ? "payoff" : "chapter",
        energy: beat.energy,
        subject: beat.primaryFocus,
      })),
    };
    const readDesignPage = async (pageId: string) => {
      let offset = 0;
      let identity: { projectSha256: string; sourceSha256: string; briefSha256: string; recipeSha256?: string } | undefined;
      for (let pageNumber = 0; pageNumber < 30; pageNumber += 1) {
        const result = await client.callTool({ name: "get_autopilot_design_brief", arguments: {
          projectPath: "smoke.editkin.json", request: designRequest, pageId, offset, maxTokens: 900,
        } }, { timeout: 120_000 });
        assert.equal(result.isError, undefined, JSON.stringify(result.content));
        const payload = JSON.parse(String((result.content[0] as { text?: string })?.text ?? "{}"));
        assert.equal(payload.status, "GREEN");
        assert.equal(payload.pageId, pageId);
        const pageIdentity = {
          projectSha256: payload.projectSha256 as string,
          sourceSha256: payload.sourceSha256 as string,
          briefSha256: payload.briefSha256 as string,
          recipeSha256: payload.recipeSha256 as string | undefined,
        };
        if (identity) assert.deepEqual(pageIdentity, identity, "current design identity changed during page reads");
        else identity = pageIdentity;
        assert.equal(typeof payload.text, "string");
        if (!payload.hasMore) return identity;
        assert.equal(payload.nextOffset > offset, true);
        offset = payload.nextOffset;
      }
      throw new Error(`Current design page did not finish: ${pageId}`);
    };
    const designIdentity = await readDesignPage("context");
    const designRecipes = await Promise.all(designRequest.beats.map(async (beat) => {
      const recipe = await readDesignPage(`beat:${beat.id}`);
      assert.equal(recipe.projectSha256, designIdentity.projectSha256);
      assert.equal(recipe.sourceSha256, designIdentity.sourceSha256);
      assert.equal(recipe.briefSha256, designIdentity.briefSha256);
      assert.match(recipe.recipeSha256 ?? "", /^[a-f0-9]{64}$/);
      return recipe.recipeSha256!;
    }));
    const designCommandStart = pluginCommandStart + pluginCompiled.commands.length;
    const designCommands = currentPlan.editorial.narrative.beats.map((beat, index) => ({
      type: "add_caption" as const,
      caption: { id: `smoke-v4-design-${beat.id}`, text: beat.summary,
        start: beat.range.startFrame / 30, duration: (beat.range.endFrame - beat.range.startFrame) / 30 },
    }));
    const planCommands = [...currentPlan.commands, ...pluginCompiled.commands, ...designCommands];
    const motionTreatment = { schema: "editkin.motion-treatment/v1" as const,
      decisions: MOTION_TREATMENT_FAMILIES.map((family) => {
        const commandIndexes = planCommands.flatMap((command, index) =>
          motionCommandFamilies(command as EditorCommand).includes(family) ? [index] : []);
        return { family, action: commandIndexes.length ? "use" as const : "omit" as const,
          reason: commandIndexes.length ? "以實際時間軸命令呈現本段視覺證據" : "純色素材不需要這類視覺或聲音處理",
          beatIds: commandIndexes.length ? designRequest.beats.map((beat) => beat.id) : [], commandIndexes };
      }),
    };
    const evidencePlan = {
      ...currentPlan,
      editorial: { ...currentPlan.editorial, motionTreatment },
      designEvidence: { schema: "editkin.autopilot-design-evidence/v1" as const, request: designRequest,
        projectSha256: designIdentity.projectSha256, sourceSha256: designIdentity.sourceSha256,
        briefSha256: designIdentity.briefSha256,
        decisions: designRequest.beats.map((beat, index) => ({
          beatId: beat.id, recipeSha256: designRecipes[index],
          application: `以單色場景和清楚字幕呈現${beat.subject}，對應第 ${index + 1} 段敘事證據`,
          commandIndexes: [designCommandStart + index],
        })) },
      materialEvidence: { schema: currentPlan.materialEvidence.schema, receipts: [{
        materialId: preparedPayload.packet.materialId,
        sourceSha256: preparedPayload.packet.source.sourceSha256,
        assetId: "asset-scenes",
        clipId: "clip-scenes",
        semanticReceiptSha256: semanticsPayload.receipt.semanticReceiptSha256,
      }] },
      extensions: {
        skillSelection: planSkillSelectionPayload.receipt,
        pluginApplications: [{ ...pluginCompiled.binding, commandIndexes: pluginCompiled.commands.map((_: unknown, index: number) => pluginCommandStart + index) }],
      },
      commands: planCommands,
    };
    for (const [field, value] of [
      ["skillSha256", "0".repeat(64)],
      ["workflowContractSha256", "1".repeat(64)],
      ["knowledgeSha256", "2".repeat(64)],
      ["pluginRegistrySha256", "3".repeat(64)],
    ] as const) {
      const rejectedIdentity = await client.callTool({
        name: "audit_autopilot_plan",
        arguments: { projectPath: "smoke.editkin.json", plan: { ...evidencePlan, source: { ...evidencePlan.source, [field]: value } } },
      });
      assert.equal(rejectedIdentity.isError, true, `${field} drift must be rejected`);
    }

    const currentAudit = await client.callTool({ name: "audit_autopilot_plan", arguments: { projectPath: "smoke.editkin.json", plan: evidencePlan } });
    assert.equal(currentAudit.isError, undefined, JSON.stringify(currentAudit.content));
    const currentAuditPayload = JSON.parse(String((currentAudit.content[0] as { text?: string })?.text ?? "{}"));
    assert.equal(currentAuditPayload.status, "ACCEPTED");
    assert.equal(currentAuditPayload.auditReceipt.project.revision >= 1, true);
    assert.equal(currentAuditPayload.auditReceipt.invocation.bindingSha256, autopilotContractPayload.liveInvocation.bindingSha256);

    await writeProfileThroughNativeServiceBoundary(safeEmptyWorkflowProfile());
    const profileDriftApply = await client.callTool({
      name: "apply_autopilot_plan",
      arguments: { projectPath: "smoke.editkin.json", plan: evidencePlan, auditReceipt: currentAuditPayload.auditReceipt },
    });
    assert.equal(profileDriftApply.isError, true, "host Workflow Profile drift after audit must be rejected");
    await writeProfileThroughNativeServiceBoundary(hostWorkflowProfile);

    const tamperedApply = await client.callTool({
      name: "apply_autopilot_plan",
      arguments: { projectPath: "smoke.editkin.json", plan: evidencePlan, auditReceipt: { ...currentAuditPayload.auditReceipt, receiptSha256: "0".repeat(64) } },
    });
    assert.equal(tamperedApply.isError, true, "tampered audit receipt must be rejected");
    const { receiptSha256: _receiptSha256, issuerProof, ...forgedBase } = {
      ...currentAuditPayload.auditReceipt,
      auditedAt: "2026-01-01T00:00:00.000Z",
    };
    const forgedApply = await client.callTool({
      name: "apply_autopilot_plan",
      arguments: {
        projectPath: "smoke.editkin.json",
        plan: evidencePlan,
        auditReceipt: { ...forgedBase, receiptSha256: sha256Canonical(forgedBase), issuerProof },
      },
    });
    assert.equal(forgedApply.isError, true, "a public self-hash must not forge an issuer-accepted audit receipt");

    const projectDrift = await client.callTool({
      name: "apply_edit_commands",
      arguments: { projectPath: "smoke.editkin.json", commands: [{ type: "rename_project", name: "Audit receipt drift fixture" }] },
    });
    assert.equal(projectDrift.isError, undefined);
    const staleApply = await client.callTool({
      name: "apply_autopilot_plan",
      arguments: { projectPath: "smoke.editkin.json", plan: evidencePlan, auditReceipt: currentAuditPayload.auditReceipt },
    });
    assert.equal(staleApply.isError, true, "project revision drift after audit must be rejected");

    const staleDesignAudit = await client.callTool({ name: "audit_autopilot_plan", arguments: { projectPath: "smoke.editkin.json", plan: evidencePlan } });
    assert.equal(staleDesignAudit.isError, true, "project changes must invalidate current design evidence");
    const refreshedDesign = await readDesignPage("context");
    assert.notEqual(refreshedDesign.projectSha256, designIdentity.projectSha256);
    assert.equal(refreshedDesign.sourceSha256, designIdentity.sourceSha256);
    assert.equal(refreshedDesign.briefSha256, designIdentity.briefSha256);
    evidencePlan.designEvidence.projectSha256 = refreshedDesign.projectSha256;
    const refreshedAudit = await client.callTool({ name: "audit_autopilot_plan", arguments: { projectPath: "smoke.editkin.json", plan: evidencePlan } });
    assert.equal(refreshedAudit.isError, undefined);
    const refreshedAuditPayload = JSON.parse(String((refreshedAudit.content[0] as { text?: string })?.text ?? "{}"));
    const currentApply = await client.callTool({
      name: "apply_autopilot_plan",
      arguments: { projectPath: "smoke.editkin.json", plan: evidencePlan, auditReceipt: refreshedAuditPayload.auditReceipt },
    });
    assert.equal(currentApply.isError, undefined);
    const currentPayload = JSON.parse(String((currentApply.content[0] as { text?: string })?.text ?? "{}"));
    assert.equal(currentPayload.receipt.coverage.level, "current_multimodal_editorial_contract");
    assert.equal(currentPayload.receipt.materialEvidence.receiptCount, 1);
    assert.equal(currentPayload.receipt.audit.receiptSha256, refreshedAuditPayload.auditReceipt.receiptSha256);
    const replayedApply = await client.callTool({
      name: "apply_autopilot_plan",
      arguments: { projectPath: "smoke.editkin.json", plan: evidencePlan, auditReceipt: refreshedAuditPayload.auditReceipt },
    });
    assert.equal(replayedApply.isError, true, "an accepted audit receipt must be single-use");

    const outcome = await client.callTool({
      name: "record_autopilot_outcome",
      arguments: {
        projectPath: "smoke.editkin.json",
        outcome: {
          schema: "hao.video-autopilot.learning-event/v1",
          planSha256: currentPayload.receipt.planSha256,
          checkpoint: "human_review",
          platform: "youtube",
          artifactId: "smoke-main-v1",
          selectedMemoryRuleIds: ["M117"],
          metrics: {},
          review: { accepted: true, severeError: false, note: "smoke" },
        },
      },
    });
    assert.equal(outcome.isError, undefined);
    const outcomePayload = JSON.parse(String((outcome.content[0] as { text?: string })?.text ?? "{}"));
    assert.equal(outcomePayload.handoff.attribution.skillSelectionReceiptSha256, planSkillSelectionPayload.receipt.receiptSha256);
    assert.deepEqual(outcomePayload.handoff.attribution.selectedSkills.map((item: { skillId: string }) => item.skillId), [hostSkill.skillId]);
    const persistedOutcome = JSON.parse(await readFile(join(workspace, ".editkin-learning", outcomePayload.eventFile), "utf8"));
    assert.deepEqual(persistedOutcome.attribution.selectedSkills.map((item: { skillId: string }) => item.skillId), [hostSkill.skillId]);

    const tracked = await client.callTool({
      name: "track_subject_and_attach_label",
      arguments: { projectPath: "smoke.editkin.json", clipId: "clip-demo", initialTime: 0, rect: { x: 0.2, y: 0.2, width: 0.3, height: 0.3 }, label: "MCP 追蹤" },
    });
    assert.equal(tracked.isError, undefined);
    const trackedPayload = JSON.parse(String((tracked.content[0] as { text?: string })?.text ?? "{}"));
    assert.ok(trackedPayload.trackId?.startsWith("motion-track-") && trackedPayload.graphicId?.startsWith("motion-"));

    const smartCut = await client.callTool({
      name: "auto_cut_silence",
      arguments: { projectPath: "smoke.editkin.json", clipId: "clip-demo" },
    });
    assert.equal(smartCut.isError, undefined);

    const transcribed = await client.callTool({
      name: "auto_transcribe_captions",
      arguments: { projectPath: "smoke.editkin.json", clipId: "clip-speech", language: "en" },
    });
    assert.equal(transcribed.isError, undefined, JSON.stringify(transcribed.content));
    const transcriptPayload = JSON.parse(String((transcribed.content[0] as { text?: string })?.text ?? "{}"));
    assert.ok(transcriptPayload.addedCaptions > 0);

    const sceneSplit = await client.callTool({
      name: "auto_split_scenes",
      arguments: { projectPath: "smoke.editkin.json", clipId: "clip-scenes", threshold: 10, minSceneDuration: 0.5 },
    });
    assert.equal(sceneSplit.isError, undefined);
    const scenePayload = JSON.parse(String((sceneSplit.content[0] as { text?: string })?.text ?? "{}"));
    assert.equal(scenePayload.splitCount, 2);

    const semantic = await client.callTool({
      name: "auto_edit_highlights",
      arguments: { projectPath: "smoke.editkin.json", clipId: "clip-highlight", language: "en", targetRatio: 0.65 },
    });
    assert.equal(semantic.isError, undefined, JSON.stringify(semantic.content));
    const semanticPayload = JSON.parse(String((semantic.content[0] as { text?: string })?.text ?? "{}"));
    assert.equal(semanticPayload.engine, "editkin-explainable-highlight-0.2");
    assert.ok(semanticPayload.addedCaptions > 0);
    assert.ok(semanticPayload.keptSeconds > 0 && semanticPayload.keptSeconds <= 6);

    const music = await client.callTool({ name: "auto_add_music", arguments: { projectPath: "smoke.editkin.json", targetBpm: 100 } });
    assert.equal(music.isError, undefined);
    const musicPayload = JSON.parse(String((music.content[0] as { text?: string })?.text ?? "{}"));
    assert.equal(musicPayload.ducking, true);
    assert.equal(musicPayload.sha256Verified, true);

    const windowed = await client.callTool({
      name: "get_timeline_window",
      arguments: { projectPath: "smoke.editkin.json", start: 0, end: 5, maxItems: 20 },
    });
    assert.equal(windowed.isError, undefined);
    const windowPayload = JSON.parse(String((windowed.content[0] as { text?: string })?.text ?? "{}"));
    assert.equal(JSON.stringify(windowPayload).includes(mediaPath), false);
    assert.ok(windowPayload.returnedItems > 0);

    const addedCreative = await client.callTool({
      name: "add_creative_asset_to_timeline",
      arguments: { projectPath: "smoke.editkin.json", creativeAssetId: "broll:0d152ac1677e", assetId: "asset-creative", clipId: "clip-creative", trackId: "video-main", timelineStart: 12 },
    });
    assert.equal(addedCreative.isError, undefined);

    const styled = await client.callTool({
      name: "apply_creative_preset",
      arguments: {
        projectPath: "smoke.editkin.json", clipId: "clip-creative", lookPresetId: "ai_cobalt_crisp",
        effectPresetIds: ["scanline_focus"], textStylePresetId: "cobalt_system",
        motionGraphic: { presetId: "studio_marker_burst", graphicId: "motion-preset-smoke", text: "動態重點", timelineStart: 0.5, duration: 1.5 },
      },
    });
    assert.equal(styled.isError, undefined);
    const styledProject = JSON.parse(await readFile(join(workspace, "smoke.editkin.json"), "utf8"));
    const persistedMotion = styledProject.motionGraphics.find((graphic: { id: string }) => graphic.id === "motion-preset-smoke");
    assert.equal(persistedMotion?.presetId, "studio_marker_burst");
    assert.equal(persistedMotion?.animation, "pop");
    assert.equal(persistedMotion?.accentColor, "#F7E04A");

    const rendered = await client.callTool({
      name: "render_project",
      arguments: { projectPath: "smoke.editkin.json", outputPath: "smoke.mp4", preferGpu: true },
    });
    assert.equal(rendered.isError, undefined);
    assert.ok((await stat(join(workspace, "smoke.mp4"))).size > 100_000);

    const gpuCapability = await client.callTool({ name: "get_plugin_capability", arguments: { pluginId: creatorPluginId, capabilityId: "warm-cinematic-gpu" } });
    assert.equal(gpuCapability.isError, undefined);
    const gpuCapabilityPayload = JSON.parse(String((gpuCapability.content[0] as { text?: string })?.text ?? "{}"));
    assert.equal(gpuCapabilityPayload.status, "AUTOMATION_READY");
    assert.equal(gpuCapabilityPayload.capability.runtimeType, "gpu_effect_graph");
    const gpuPluginCompiled = await compileAndApplyPlugin("warm-cinematic-gpu", "clip-demo", {});
    assert.equal(gpuPluginCompiled.commands.length, 1);

    const validated = await client.callTool({
      name: "validate_project",
      arguments: { projectPath: "smoke.editkin.json" },
    });
    assert.equal(validated.isError, undefined);
    console.log(JSON.stringify({ status: "GREEN", tools: names, workspaceBoundary: "PASS", atomicWrite: "PASS", autopilotV4Only: "PASS", liveAutopilotIdentity: "PASS", acceptedAuditReceipt: "PASS", receiptTamperRejected: "PASS", publicSelfHashForgeryRejected: "PASS", auditReceiptReplayRejected: "PASS", staleProjectRejected: "PASS", hostWorkflowProfileDriftRejected: "PASS", skillWorkflowKnowledgePluginDriftRejected: "PASS", smartCut: "PASS", automaticCaptions: "PASS", automaticSceneSplit: "PASS", semanticAutoEdit: "PASS", automaticMusic: "PASS", motionTracking: "PASS", boundedTimelineWindow: "PASS", boundedAnonymousKnowledge: "PASS", privatePathHidden: "PASS", creatorPack: "PASS", pluginAutomation: "PASS", gpuEffectAutomation: "PASS", portableCreativeUri: "PASS", render: "PASS" }));
  } finally {
    await client.close();
    await rm(workspace, { recursive: true, force: true });
  }
}

void main();
