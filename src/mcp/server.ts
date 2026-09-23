import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { resolveAestheticSystem } from "../application/editkinAesthetic";
import { findAsset, findClip, findTrack, projectDuration, summarizeProject } from "../domain/editGraph";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { analyzeSmartCut } from "../application/smartCut";
import { transcribeAutomaticCaptions } from "../application/automaticCaptions";
import { buildAutomaticCaptionCommand } from "../application/automaticCaptionCommands";
import { analyzeSceneCuts } from "../application/sceneDetection";
import { buildSceneSplitCommand } from "../application/sceneSplitCommands";
import { planSemanticAutoEdit } from "../application/semanticAutoEdit";
import { buildSemanticAutoEditCommand } from "../application/semanticAutoEditCommands";
import { inspectMedia } from "../application/inspectMedia";
import { creativeAssetIdFromUri, creativeAssetUri, listCreativeLibrary, resolveCreativeLibraryAsset } from "../application/creativeLibrary";
import { selectAutomaticMusicAsset } from "../creative/musicSelection";
import { EFFECT_PRESETS, LOOK_PRESETS, TEXT_STYLE_PRESETS, TRANSITION_PRESETS, captionStyleFromPreset, findEffectPreset, findLookPreset, findTransitionPreset } from "../creative/corePack";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import { editorCommandSchema } from "./schemas";
import { analyzeMotionTrack } from "../application/motionTracking";
import { createMotionGraphic } from "../motion/composition";
import { compactMotionGraphicPresets, findMotionGraphicPreset, motionGraphicPresets } from "../creative/motionGraphicPresets";
import { motionPresetVariantDescriptor } from "../application/motionPresetVariant";
import { compactCinematicLanguageIndex, resolveCinematicRecipe } from "../creative/cinematicLanguage";
import { SHORT_FORM_TEMPLATES } from "../application/shortFormTemplates";
import { LONG_FORM_TEMPLATES } from "../application/longFormTemplates";
import { editorialProfile } from "../application/editorialProfiles";
import { registerAutopilotTools } from "./autopilotTools";
import { EDITKIN_MCP_INSTRUCTIONS, registerMaterialIntelligenceTools } from "./materialIntelligenceTools";
import { registerPodcastTools } from "./podcastTools";
import { registerEditorialBatchTools } from "./editorialBatchTools";
import { registerAutopilotBatchTools } from "./autopilotBatchTools";
import { registerRenderTools } from "./renderTools";
import { registerPluginTools } from "./pluginTools";
import { registerRotoKeyerAutopilotTools } from "./rotoKeyerAutopilotTools";
import { registerMontageTools } from "./montageTools";
import { registerAutoColorTools } from "./autoColorTools";
import { registerRemoteOnboardingTools } from "./remoteOnboardingTools";
import { creativePackRoot, errorResult, personalMusicRoot, personalVisualRoot, textResult } from "./toolRuntime";
import {
  applyProjectCommands,
  createProjectFile,
  inspectProject,
  readProject,
  resolveWorkspaceMediaPath,
  workspaceRoot,
} from "./storage";

export const EDITKIN_REMOTE_ONLY_MCP_INSTRUCTIONS = [
  "Editkin Remote research plane. This server exposes exactly get_remote_setup_status, list_remote_provider_connectors, and prepare_remote_setup.",
  "Do not edit media or projects, do not deploy or log in to a tunnel provider, and never request, read, store, or echo secrets.",
  "List the closed connector registry before preparing proposal v2. prepare_remote_setup only creates a non-secret manifest- and plan-bound proposal; it never approves or executes provider actions. Stop for desktop review; no provider deployment, phone, or Mac verification may be claimed.",
].join(" ");

export function remoteOnlyMcpMode(environment: NodeJS.ProcessEnv = process.env): boolean {
  const mode = environment.EDITKIN_MCP_MODE;
  if (mode === undefined || mode === "") return false;
  if (mode === "remote-only") return true;
  throw new Error("EDITKIN_MCP_MODE is not a supported closed-world mode");
}

export function createServerForEnvironment(environment: NodeJS.ProcessEnv): McpServer {
  if (remoteOnlyMcpMode(environment)) {
    const server = new McpServer(
      { name: "editkin", version: "0.15.0" },
      { instructions: EDITKIN_REMOTE_ONLY_MCP_INSTRUCTIONS },
    );
    registerRemoteOnboardingTools(server, environment, { includeConfigure: false, includeVerify: false });
    return server;
  }
  // MCP is a standalone process, so it must initialize the same creative extensions
  // as the editor UI before any planner lists or applies a preset.
  motionGraphicPresets();
  const server = new McpServer(
    { name: "editkin", version: "0.15.0" },
    { instructions: EDITKIN_MCP_INSTRUCTIONS },
  );
  registerAutopilotTools(server);
  registerMaterialIntelligenceTools(server);
  registerPodcastTools(server);
  registerEditorialBatchTools(server);
  registerAutopilotBatchTools(server);
  registerRenderTools(server);
  registerPluginTools(server);
  registerRotoKeyerAutopilotTools(server);
  registerMontageTools(server);
  registerAutoColorTools(server);
  registerRemoteOnboardingTools(server);

  server.registerTool("list_creative_presets", {
    description: "列出 Editkin 原生可輸出的調色、特效、轉場、字幕文字、動態圖文與鏡頭語言 presets。動態圖文預設回低 Token 索引；傳 motionPresetId 只展開單一 seed，不重送整份動態圖文索引。鏡頭語言與子彈時間會附真實能力前置與降級標示。",
    inputSchema: z.object({
      kind: z.enum(["all", "look", "effect", "transition", "text", "motion", "template", "cinematic"]).default("all"),
      motionPresetId: z.string().min(1).max(128).optional(),
    }),
  }, async ({ kind, motionPresetId }) => {
    const compact = (items: Array<{ id: string; name: string; renderer: string; renderers?: string[]; parameters?: unknown; routing?: unknown }>) => items.map(({ id, name, renderer, renderers, parameters, routing }) => ({ id, name, renderer, ...(renderers ? { renderers } : {}), ...(parameters ? { parameters } : {}), ...(routing ? { routing } : {}) }));
    if (motionPresetId && kind !== "all" && kind !== "motion") return errorResult(new Error("motionPresetId 只能搭配 all 或 motion"));
    let selectedMotionPreset: ReturnType<typeof findMotionGraphicPreset> | undefined;
    try {
      selectedMotionPreset = motionPresetId ? findMotionGraphicPreset(motionPresetId) : undefined;
    } catch (error) { return errorResult(error); }
    return textResult({ status: "GREEN", version: "0.15.0", presets: {
      looks: kind === "all" || kind === "look" ? compact(LOOK_PRESETS) : undefined,
      effects: kind === "all" || kind === "effect" ? compact(EFFECT_PRESETS) : undefined,
      transitions: kind === "all" || kind === "transition" ? compact(TRANSITION_PRESETS) : undefined,
      textStyles: kind === "all" || kind === "text" ? compact(TEXT_STYLE_PRESETS) : undefined,
      motionGraphics: !motionPresetId && (kind === "all" || kind === "motion") ? compactMotionGraphicPresets() : undefined,
      formatTemplates: kind === "all" || kind === "template" ? {
        shortForm: SHORT_FORM_TEMPLATES.map(({ id, name, category, bestFor, rhythm, lookPresetId, effectPresetIds, transitionPresetId, captionPresetId, cinematicRecipeId }) => ({ id, name, category, bestFor, rhythm, lookPresetId, effectPresetIds, transitionPresetId, captionPresetId, cinematicRecipeId, executionBoundary: "visual_package_now_recipe_requires_evidence_gate" })),
        longForm: LONG_FORM_TEMPLATES.map(({ id, name, category, bestFor, lookPresetId, effectPresetIds, introTransitionPresetId, cinematicRecipeId, cadence }) => ({ id, name, category, bestFor, lookPresetId, effectPresetIds, introTransitionPresetId, cinematicRecipeId, cadence, captionColorPolicy: "white_only", executionBoundary: "visual_package_now_recipe_requires_evidence_gate" })),
      } : undefined,
      cinematicLanguage: kind === "all" || kind === "cinematic" ? compactCinematicLanguageIndex() : undefined,
      selectedMotionPreset,
      motionPresetVariant: selectedMotionPreset ? motionPresetVariantDescriptor(selectedMotionPreset) : undefined,
    } });
  });

  server.registerTool("resolve_cinematic_recipe", {
    description: "用 caller 提供、尚未驗證的素材能力提示解析鏡頭語言；只回 planning draft、read-only DRAFT_COMPILER_CANDIDATE、宣告 fallback 或 BLOCKED。compiler candidate 仍是 caller-unverified，必須另呼叫指定 compiler tool，再把 command 放進 v4 plan 綁定素材 receipts，經 audit 才能 apply；本工具本身不編譯或修改 EditGraph。",
    inputSchema: z.object({ recipeId: z.string().min(1).max(128), availableCapabilities: z.array(z.string().min(1).max(128)).max(64) }),
  }, async ({ recipeId, availableCapabilities }) => {
    try { return textResult(resolveCinematicRecipe(recipeId, availableCapabilities)); } catch (error) { return errorResult(error); }
  });

  server.registerTool("apply_creative_preset", {
    description: "原子套用調色／特效／片段入出場動畫／字幕文字樣式，或用已註冊 seed 新增可編輯動態圖文；設定會進 EditGraph，可 Undo。",
    inputSchema: z.object({
      projectPath: z.string(),
      clipId: z.string().optional(),
      lookPresetId: z.string().nullable().optional(),
      effectPresetIds: z.array(z.string()).max(4).optional(),
      transitionInPresetId: z.string().nullable().optional(),
      transitionOutPresetId: z.string().nullable().optional(),
      textStylePresetId: z.string().optional(),
      motionGraphic: z.object({
        presetId: z.string().min(1).max(128),
        graphicId: z.string().min(1).max(128),
        text: z.string().trim().min(1).max(180),
        timelineStart: z.number().nonnegative(),
        duration: z.number().positive().max(600),
        trackId: z.string().min(1).max(128).optional(),
      }).optional(),
    }),
  }, async ({ projectPath, clipId, lookPresetId, effectPresetIds, transitionInPresetId, transitionOutPresetId, textStylePresetId, motionGraphic }) => {
    try {
      const commands = [] as import("../domain/commands").EditorCommand[];
      if (lookPresetId) findLookPreset(lookPresetId);
      for (const id of effectPresetIds ?? []) findEffectPreset(id);
      const transitionIn = transitionInPresetId ? findTransitionPreset(transitionInPresetId) : undefined;
      const transitionOut = transitionOutPresetId ? findTransitionPreset(transitionOutPresetId) : undefined;
      const hasClipPatch = lookPresetId !== undefined || effectPresetIds !== undefined || transitionInPresetId !== undefined || transitionOutPresetId !== undefined;
      if (hasClipPatch) {
        if (!clipId) throw new Error("套用片段 Creative preset 時必須提供 clipId");
        commands.push({ type: "set_clip_creative", clipId, patch: {
          lookPresetId,
          effectPresetIds,
          transitionIn: transitionInPresetId === null ? null : transitionIn ? { presetId: transitionIn.id, duration: transitionIn.defaultDuration } : undefined,
          transitionOut: transitionOutPresetId === null ? null : transitionOut ? { presetId: transitionOut.id, duration: transitionOut.defaultDuration } : undefined,
        } });
      }
      if (textStylePresetId) commands.push({ type: "set_caption_style", patch: captionStyleFromPreset(textStylePresetId) });
      if (motionGraphic) {
        const preset = findMotionGraphicPreset(motionGraphic.presetId);
        const kind = preset.seed.kind ?? "card";
        commands.push({ type: "add_motion_graphic", graphic: createMotionGraphic(
          motionGraphic.graphicId,
          kind,
          motionGraphic.text,
          motionGraphic.timelineStart,
          motionGraphic.duration,
          motionGraphic.trackId,
          preset.seed,
        ) });
      }
      if (!commands.length) throw new Error("至少提供一個 Creative preset");
      const project = await applyProjectCommands(projectPath, commands);
      return textResult({ status: "GREEN", appliedCommandCount: commands.length, summary: summarizeProject(project) });
    } catch (error) { return errorResult(error); }
  });

  server.registerTool("list_creative_assets", {
    description: "搜尋安裝包內經授權與隱私 gate 的 Hao 素材庫；只回傳 metadata，不回傳本機絕對路徑。",
    inputSchema: z.object({ query: z.string().default(""), category: z.string().optional(), limit: z.number().int().min(1).max(100).default(30) }),
  }, async ({ query, category, limit }) => {
    try {
      const library = await listCreativeLibrary(creativePackRoot(), personalMusicRoot(), personalVisualRoot());
      const term = query.trim().toLocaleLowerCase();
      const assets = library.assets.filter((asset) => (!category || asset.category === category)
        && (!term || `${asset.name} ${asset.sourceFilename ?? ""} ${asset.role} ${asset.domains.join(" ")}`.toLocaleLowerCase().includes(term))).slice(0, limit);
      return textResult({ status: "GREEN", pack: { id: library.id, version: library.version }, total: library.assetCount, returned: assets.length, assets });
    } catch (error) { return errorResult(error); }
  });

  server.registerTool("add_creative_asset_to_timeline", {
    description: "驗證 Creative Pack 素材 SHA-256 後，用可攜 creative:// URI 匯入專案並放上 Timeline；不把安裝路徑寫入專案。",
    inputSchema: z.object({ projectPath: z.string(), creativeAssetId: z.string(), assetId: z.string(), clipId: z.string(), trackId: z.string(), timelineStart: z.number().nonnegative() }),
  }, async ({ projectPath, creativeAssetId, assetId, clipId, trackId, timelineStart }) => {
    try {
      const project = await readProject(projectPath);
      const track = findTrack(project, trackId);
      const resolved = await resolveCreativeLibraryAsset(creativePackRoot(), creativeAssetId, personalMusicRoot(), personalVisualRoot());
      const probe = await inspectMedia(resolved.absolutePath, process.env.HAO_FFPROBE_PATH);
      const duration = resolved.asset.mediaKind === "image" ? 5 : probe.duration;
      const kind = resolved.asset.mediaKind;
      if ((track.kind === "video" && kind === "audio") || (track.kind === "audio" && kind === "image")) throw new Error("Creative Pack 素材與目標軌道類型不相容");
      const updated = await applyProjectCommands(projectPath, [
        { type: "import_asset", asset: { id: assetId, name: resolved.asset.name, kind, uri: creativeAssetUri(creativeAssetId), duration, width: probe.width, height: probe.height,
          color: { interpretation: "auto", primaries: probe.colorPrimaries, transfer: probe.colorTransfer, matrix: probe.colorMatrix, range: probe.colorRange },
          role: resolved.asset.role, bpm: resolved.asset.bpm, license: resolved.asset.license, provenance: resolved.asset.provenance,
          redistributable: resolved.asset.redistributable, rightsBasis: resolved.asset.rightsBasis, distributionScope: resolved.asset.distributionScope } },
        { type: "add_clip", clip: { id: clipId, assetId, trackId, timelineStart, sourceStart: 0, duration, volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] } },
      ]);
      return textResult({ status: "GREEN", creativeAssetId, assetId, clipId, sha256Verified: true, summary: summarizeProject(updated) });
    } catch (error) { return errorResult(error); }
  });

  server.registerTool("auto_add_music", {
    description: "從 Hao 社群授權 BGM 庫依專案主題、長度與 BPM 自動選曲，驗證 SHA-256 與可散布標記，鋪滿全片、crossfade 並標記 background-music 讓輸出自動 ducking。一次呼叫完成，不需要 Computer Use。",
    inputSchema: z.object({ projectPath: z.string(), targetBpm: z.number().min(55).max(190).optional() }),
  }, async ({ projectPath, targetBpm }) => {
    try {
      const project = await readProject(projectPath);
      const targetDuration = projectDuration(project);
      if (targetDuration <= 0) throw new Error("專案尚無可配樂的影片長度");
      const library = await listCreativeLibrary(creativePackRoot(), personalMusicRoot(), personalVisualRoot());
      const musicHints = project.editorialProfile === "gaming"
        ? ["game", "gaming", "玩具", "玩具開箱", "模型", "陀螺", "對戰"]
        : project.editorialProfile === "food" ? ["food", "美食", "料理"]
          : project.editorialProfile === "travel" ? ["travel", "旅遊", "出國"]
            : project.editorialProfile.startsWith("podcast") ? ["podcast", "訪談", "教學"] : [];
      const selected = selectAutomaticMusicAsset(library.assets, {
        projectName: project.name,
        duration: targetDuration,
        targetBpm: targetBpm ?? editorialProfile(project.editorialProfile).targetBpm,
        contentHints: musicHints,
        preferHighEnergy: project.editorialProfile === "gaming",
      });
      if (!selected) throw new Error("Hao 社群音樂庫沒有可選曲目");
      const resolved = await resolveCreativeLibraryAsset(creativePackRoot(), selected.id, personalMusicRoot(), personalVisualRoot());
      const probe = await inspectMedia(resolved.absolutePath, process.env.HAO_FFPROBE_PATH);
      const assetId = `asset-music-${randomUUID()}`;
      const commands: import("../domain/commands").EditorCommand[] = [];
      for (const track of project.tracks.filter((item) => item.id === "audio-music-a" || item.id === "audio-music-b")) {
        commands.push(...track.clips.map((clip) => ({ type: "delete_clip" as const, clipId: clip.id })), { type: "delete_track", trackId: track.id });
      }
      commands.push(
        { type: "import_asset", asset: { id: assetId, name: selected.name, kind: "audio", uri: creativeAssetUri(selected.id), duration: probe.duration, role: "background-music", bpm: selected.bpm, license: selected.license, provenance: selected.provenance, redistributable: selected.redistributable } },
        { type: "add_track", track: { id: "audio-music-a", name: "配樂 A", kind: "audio", locked: false, muted: false, clips: [] } },
        { type: "add_track", track: { id: "audio-music-b", name: "配樂 B", kind: "audio", locked: false, muted: false, clips: [] } },
      );
      const crossfade = Math.min(1.2, probe.duration / 5, targetDuration / 5);
      let cursor = 0; let index = 0; let clipCount = 0;
      while (cursor < targetDuration - 0.5 / project.fps) {
        const duration = Math.min(probe.duration, targetDuration - cursor);
        commands.push({ type: "add_clip", clip: { id: `music-clip-${randomUUID()}`, assetId, trackId: index % 2 ? "audio-music-b" : "audio-music-a", timelineStart: cursor, sourceStart: 0, duration, volume: 0.24, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] } });
        clipCount += 1;
        if (duration >= targetDuration - cursor) break;
        cursor += Math.max(1 / project.fps, duration - crossfade); index += 1;
      }
      const updated = await applyProjectCommands(projectPath, commands);
      return textResult({ status: "GREEN", selected: { id: selected.id, name: selected.name, bpm: selected.bpm, category: selected.category }, clipCount, crossfade, ducking: true, sha256Verified: true, summary: summarizeProject(updated) });
    } catch (error) { return errorResult(error); }
  });

  server.registerTool("track_subject_and_attach_label", {
    description: "用 FFmpeg 取樣＋Rust 原生追蹤選定影片的自訂區域，保存 confidence/lost 狀態並綁定 hao.motion-composition/v1 標籤；手動修正可再用 apply_edit_commands 寫 set_motion_track_point。",
    inputSchema: z.object({
      projectPath: z.string(), clipId: z.string(), initialTime: z.number().nonnegative().default(0),
      rect: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().min(0.02).max(1), height: z.number().min(0.02).max(1) }),
      label: z.string().min(1).max(120).default("追蹤重點"),
    }),
  }, async ({ projectPath, clipId, initialTime, rect, label }) => {
    try {
      if (rect.x + rect.width > 1 || rect.y + rect.height > 1) throw new Error("追蹤框超出畫面");
      const project = await readProject(projectPath);
      const clip = findClip(project, clipId);
      const asset = findAsset(project, clip.assetId);
      if (asset.kind !== "video") throw new Error("動態追蹤只支援影片片段");
      const creativeId = creativeAssetIdFromUri(asset.uri);
      const sourcePath = creativeId ? (await resolveCreativeLibraryAsset(creativePackRoot(), creativeId, personalMusicRoot(), personalVisualRoot())).absolutePath : await resolveWorkspaceMediaPath(asset.uri);
      const result = await analyzeMotionTrack({ sourcePath, sourceStart: clip.sourceStart, duration: clip.duration, fps: project.fps,
        sourceWidth: asset.width ?? project.width, sourceHeight: asset.height ?? project.height, initialTime, initialRect: rect,
        sourceSha256: asset.derivatives?.sourceSha256 }, {
        ffmpegPath: process.env.HAO_FFMPEG_PATH ?? (process.platform === "win32" ? resolve(import.meta.dirname, "../../vendor/ffmpeg/win32-x64/ffmpeg.exe") : "ffmpeg"),
        nativeCorePath: process.env.HAO_NATIVE_CORE_PATH ?? (process.platform === "win32" ? resolve(import.meta.dirname, "../../native/bin/win32-x64/hao-core.exe") : "hao-core"),
        cacheRoot: process.env.EDITKIN_CACHE_ROOT,
      });
      const trackId = `motion-track-${randomUUID()}`;
      const graphic = createMotionGraphic(`motion-${randomUUID()}`, "tag", label, clip.timelineStart + initialTime, Math.max(0.5, clip.duration - initialTime), trackId);
      const updated = await applyProjectCommands(projectPath, [{ type: "add_motion_track", track: { id: trackId, clipId, name: label, engine: result.engine, analysisFps: result.analysisFps, initialRect: rect, points: result.points, lostRatio: result.lostRatio, createdAt: new Date().toISOString() } }, { type: "add_motion_graphic", graphic }]);
      return textResult({ status: "GREEN", trackId, graphicId: graphic.id, validPercent: Math.round((1 - result.lostRatio) * 100), cacheHit: result.cacheHit, summary: summarizeProject(updated) });
    } catch (error) { return errorResult(error); }
  });

  server.registerTool("create_project", {
    description: "建立新的 Editkin EditGraph 專案。所有路徑限制在 EDITKIN_WORKSPACE。",
    inputSchema: z.object({
      projectPath: z.string().describe("相對 workspace 的 .editkin.json 路徑（相容舊 .haoedit.json）"),
      name: z.string().min(1),
      width: z.number().int().positive().default(1920),
      height: z.number().int().positive().default(1080),
      fps: z.number().positive().max(240).default(30),
      editorialProfile: z.enum(["auto", "gaming", "food", "travel", "podcast_on_camera", "podcast_no_face"]).default("auto"),
    }),
  }, async ({ projectPath, name, width, height, fps, editorialProfile: profile }) => {
    try {
      const project = await createProjectFile(projectPath, name, width, height, fps);
      const updated = await applyProjectCommands(projectPath, [{ type: "batch", commands: [
        { type: "set_editorial_profile", profile },
        { type: "set_aesthetic_system", aestheticSystem: resolveAestheticSystem(profile, width > height ? "longform" : "shorts") },
      ] }]);
      return textResult({ status: "GREEN", projectPath, editorialProfile: updated.editorialProfile, summary: summarizeProject(updated) });
    } catch (error) { return errorResult(error); }
  });

  server.registerTool("get_project_summary", {
    description: "取得精簡專案摘要，不把完整 Timeline 塞進模型 context。",
    inputSchema: z.object({ projectPath: z.string() }),
  }, async ({ projectPath }) => {
    try { return textResult(await inspectProject(projectPath)); }
    catch (error) { return errorResult(error); }
  });

  server.registerTool("get_timeline_window", {
    description: "只讀指定時間窗的精簡 Timeline，不回傳素材路徑；適合 Agent 低 Token 規劃下一批剪輯。",
    inputSchema: z.object({
      projectPath: z.string(),
      start: z.number().nonnegative().default(0),
      end: z.number().positive(),
      maxItems: z.number().int().min(1).max(200).default(80),
    }),
  }, async ({ projectPath, start, end, maxItems }) => {
    try {
      if (end <= start) throw new Error("end 必須大於 start");
      const project = await readProject(projectPath);
      const assetNames = new Map(project.assets.map((asset) => [asset.id, { name: asset.name, kind: asset.kind }]));
      const allClips = project.tracks.flatMap((track) => track.clips
        .filter((clip) => clip.timelineStart < end && clip.timelineStart + clip.duration > start)
        .map((clip) => ({
          id: clip.id, trackId: track.id, trackName: track.name, trackKind: track.kind,
          assetId: clip.assetId, asset: assetNames.get(clip.assetId),
          timelineStart: clip.timelineStart, sourceStart: clip.sourceStart, duration: clip.duration, volume: clip.volume,
        })))
        .sort((left, right) => left.timelineStart - right.timelineStart);
      const allCaptions = project.captions.filter((caption) => caption.start < end && caption.start + caption.duration > start)
        .map((caption) => ({ id: caption.id, start: caption.start, duration: caption.duration, text: caption.text, translation: caption.translation }));
      const combined = [
        ...allClips.map((item) => ({ type: "clip" as const, time: item.timelineStart, item })),
        ...allCaptions.map((item) => ({ type: "caption" as const, time: item.start, item })),
      ].sort((left, right) => left.time - right.time);
      const page = combined.slice(0, maxItems);
      return textResult({
        status: "GREEN", window: { start, end }, totalItems: combined.length, returnedItems: page.length,
        hasMore: combined.length > page.length,
        clips: page.filter((entry) => entry.type === "clip").map((entry) => entry.item),
        captions: page.filter((entry) => entry.type === "caption").map((entry) => entry.item),
      });
    } catch (error) { return errorResult(error); }
  });

  server.registerTool("validate_project", {
    description: "驗證 EditGraph schema、素材、時間範圍、軌道相容性與 clip overlap。",
    inputSchema: z.object({ projectPath: z.string() }),
  }, async ({ projectPath }) => {
    try { return textResult(await inspectProject(projectPath)); }
    catch (error) { return errorResult(error); }
  });

  server.registerTool("apply_edit_commands", {
    description: "用一個 bounded call 原子套用一批剪輯 commands，成功後回傳精簡摘要。",
    inputSchema: z.object({
      projectPath: z.string(),
      commands: z.array(editorCommandSchema).min(1).max(100),
    }),
  }, async ({ projectPath, commands }) => {
    try {
      const project = await applyProjectCommands(projectPath, commands);
      return textResult({
        status: "GREEN",
        appliedCommandCount: commands.length,
        summary: summarizeProject(project),
      });
    } catch (error) { return errorResult(error); }
  });

  server.registerTool("auto_cut_silence", {
    description: "在本機用 FFmpeg 分析選定片段的停頓，再由 Rust 產生 frame-aligned Smart Cut；一次原子寫回並保留可 Undo 的 EditGraph 語意。",
    inputSchema: z.object({
      projectPath: z.string(),
      clipId: z.string(),
      thresholdDb: z.number().min(-80).max(-10).default(-35),
      minSilence: z.number().min(0.1).max(10).default(0.35),
      padding: z.number().min(0).max(1).default(0.08),
      minKeep: z.number().min(0.05).max(10).default(0.25),
    }),
  }, async ({ projectPath, clipId, thresholdDb, minSilence, padding, minKeep }) => {
    try {
      const project = await readProject(projectPath);
      const clip = findClip(project, clipId);
      const asset = findAsset(project, clip.assetId);
      if (asset.kind === "image") throw new Error("Smart Cut 不支援圖片片段");
      const creativeId = creativeAssetIdFromUri(asset.uri);
      const sourcePath = creativeId ? (await resolveCreativeLibraryAsset(creativePackRoot(), creativeId, personalMusicRoot(), personalVisualRoot())).absolutePath : await resolveWorkspaceMediaPath(asset.uri);
      const result = await analyzeSmartCut({
        sourcePath, sourceStart: clip.sourceStart, duration: clip.duration, fps: project.fps,
        options: { thresholdDb, minSilence, padding, minKeep },
      }, {
        ffmpegPath: process.env.HAO_FFMPEG_PATH ?? (process.platform === "win32" ? resolve(import.meta.dirname, "../../vendor/ffmpeg/win32-x64/ffmpeg.exe") : "ffmpeg"),
        nativeCorePath: process.env.HAO_NATIVE_CORE_PATH ?? (process.platform === "win32" ? resolve(import.meta.dirname, "../../native/bin/win32-x64/hao-core.exe") : "hao-core"),
      });
      if (result.removedFrames <= 0) return textResult({ status: "GREEN", changed: false, result, summary: summarizeProject(project) });
      const keepRanges = result.ranges.map((range) => ({ start: range.startFrame / result.fps, end: range.endFrame / result.fps }));
      const updated = await applyProjectCommands(projectPath, [{
        type: "smart_cut_clip",
        clipId,
        keepRanges,
        segmentIds: keepRanges.map((_, index) => index === 0 ? clipId : `${clipId}-smart-${Date.now()}-${index}`),
      }]);
      return textResult({
        status: "GREEN", changed: true, removedSeconds: result.removedFrames / result.fps,
        cutCount: result.cutCount, engine: result.engine, summary: summarizeProject(updated),
      });
    } catch (error) { return errorResult(error); }
  });

  server.registerTool("auto_transcribe_captions", {
    description: "在本機用 FFmpeg 內建 whisper.cpp 轉錄選定片段，驗證固定模型 SHA-256，並用單一 EditGraph batch 取代該片段範圍的舊字幕；素材不會上傳。",
    inputSchema: z.object({
      projectPath: z.string(),
      clipId: z.string(),
      language: z.string().regex(/^(?:auto|[a-z]{2,3}(?:-[a-z0-9]{2,8})?)$/i).default("auto"),
      translationTarget: z.literal("en").optional().describe("設為 en 會產生原文＋英文雙行字幕；兩行都可再編輯"),
    }),
  }, async ({ projectPath, clipId, language, translationTarget }) => {
    try {
      const project = await readProject(projectPath);
      const clip = findClip(project, clipId);
      const asset = findAsset(project, clip.assetId);
      if (asset.kind === "image") throw new Error("自動字幕不支援圖片片段");
      const creativeId = creativeAssetIdFromUri(asset.uri);
      const sourcePath = creativeId ? (await resolveCreativeLibraryAsset(creativePackRoot(), creativeId, personalMusicRoot(), personalVisualRoot())).absolutePath : await resolveWorkspaceMediaPath(asset.uri);
      const modelRoot = process.env.EDITKIN_MODEL_ROOT ?? resolve(workspaceRoot(), ".editkin-models");
      const result = await transcribeAutomaticCaptions({
        sourcePath,
        sourceStart: clip.sourceStart,
        duration: clip.duration,
        sourceSha256: asset.derivatives?.sourceSha256,
        language,
        translationTarget,
      }, {
        ffmpegPath: process.env.HAO_FFMPEG_PATH ?? (process.platform === "win32" ? resolve(import.meta.dirname, "../../vendor/ffmpeg/win32-x64/ffmpeg.exe") : "ffmpeg"),
        whisperCliPath: process.env.EDITKIN_WHISPER_CLI_PATH ?? (process.platform === "win32" ? resolve(import.meta.dirname, "../../vendor/whisper/win32-x64/whisper-cli.exe") : "whisper-cli"),
        modelRoot,
        modelPath: process.env.EDITKIN_WHISPER_MODEL_PATH,
        cacheRoot: process.env.EDITKIN_CACHE_ROOT ?? resolve(modelRoot, "../media-cache"),
      });
      const planned = buildAutomaticCaptionCommand(project, clip, result, () => `caption-auto-${Date.now()}-${randomUUID()}`);
      const updated = await applyProjectCommands(projectPath, [planned.command]);
      return textResult({
        status: "GREEN",
        addedCaptions: planned.added,
        replacedCaptions: planned.replaced,
        engine: result.engine,
        acceleration: result.acceleration,
        modelDownloaded: result.modelDownloaded,
        cacheHit: result.cacheHit,
        summary: summarizeProject(updated),
      });
    } catch (error) { return errorResult(error); }
  });

  server.registerTool("auto_split_scenes", {
    description: "用本機 FFmpeg scdet 找出選定影片的硬切場景，frame-align 後以單一 EditGraph batch 分割；不使用 Computer Use、不上傳素材，且一次 Undo 可復原。",
    inputSchema: z.object({
      projectPath: z.string(),
      clipId: z.string(),
      threshold: z.number().min(1).max(100).default(10),
      minSceneDuration: z.number().min(0.05).max(30).default(0.5),
    }),
  }, async ({ projectPath, clipId, threshold, minSceneDuration }) => {
    try {
      const project = await readProject(projectPath);
      const clip = findClip(project, clipId);
      const asset = findAsset(project, clip.assetId);
      if (asset.kind !== "video") throw new Error("自動分鏡只支援影片片段");
      const creativeId = creativeAssetIdFromUri(asset.uri);
      const sourcePath = creativeId ? (await resolveCreativeLibraryAsset(creativePackRoot(), creativeId, personalMusicRoot(), personalVisualRoot())).absolutePath : await resolveWorkspaceMediaPath(asset.uri);
      const result = await analyzeSceneCuts({
        sourcePath,
        sourceStart: clip.sourceStart,
        duration: clip.duration,
        fps: project.fps,
        sourceSha256: asset.derivatives?.sourceSha256,
        threshold,
        minSceneDuration,
      }, {
        ffmpegPath: process.env.HAO_FFMPEG_PATH ?? (process.platform === "win32" ? resolve(import.meta.dirname, "../../vendor/ffmpeg/win32-x64/ffmpeg.exe") : "ffmpeg"),
        cacheRoot: process.env.EDITKIN_CACHE_ROOT,
      });
      if (!result.cuts.length) return textResult({ status: "GREEN", changed: false, sceneCount: 1, result, summary: summarizeProject(project) });
      const planned = buildSceneSplitCommand(project, clip, result.cuts, () => `clip-scene-${Date.now()}-${randomUUID()}`);
      const updated = await applyProjectCommands(projectPath, [planned.command]);
      return textResult({
        status: "GREEN", changed: true, splitCount: planned.splitCount, sceneCount: planned.splitCount + 1,
        engine: result.engine, cacheHit: result.cacheHit, summary: summarizeProject(updated),
      });
    } catch (error) { return errorResult(error); }
  });

  server.registerTool("auto_edit_highlights", {
    description: "一鍵在本機轉錄內容、分析場景並以可解釋分數保留重點；字幕與剪輯共用單一 EditGraph batch，可一次 Undo，不透過 Computer Use。",
    inputSchema: z.object({
      projectPath: z.string(),
      clipId: z.string(),
      language: z.string().regex(/^(?:auto|[a-z]{2,3}(?:-[a-z0-9]{2,8})?)$/i).default("auto"),
      targetRatio: z.number().min(0.2).max(1).default(0.65),
    }),
  }, async ({ projectPath, clipId, language, targetRatio }) => {
    try {
      const project = await readProject(projectPath);
      const clip = findClip(project, clipId);
      const asset = findAsset(project, clip.assetId);
      if (asset.kind === "image") throw new Error("智慧成片不支援圖片片段");
      const creativeId = creativeAssetIdFromUri(asset.uri);
      const sourcePath = creativeId ? (await resolveCreativeLibraryAsset(creativePackRoot(), creativeId, personalMusicRoot(), personalVisualRoot())).absolutePath : await resolveWorkspaceMediaPath(asset.uri);
      const ffmpegPath = process.env.HAO_FFMPEG_PATH ?? (process.platform === "win32" ? resolve(import.meta.dirname, "../../vendor/ffmpeg/win32-x64/ffmpeg.exe") : "ffmpeg");
      const modelRoot = process.env.EDITKIN_MODEL_ROOT ?? resolve(workspaceRoot(), ".editkin-models");
      const transcriptPromise = transcribeAutomaticCaptions({
        sourcePath, sourceStart: clip.sourceStart, duration: clip.duration,
        sourceSha256: asset.derivatives?.sourceSha256, language,
      }, {
        ffmpegPath,
        whisperCliPath: process.env.EDITKIN_WHISPER_CLI_PATH
          ?? (process.platform === "win32" ? resolve(import.meta.dirname, "../../vendor/whisper/win32-x64/whisper-cli.exe") : "whisper-cli"),
        modelRoot, modelPath: process.env.EDITKIN_WHISPER_MODEL_PATH,
        cacheRoot: process.env.EDITKIN_CACHE_ROOT ?? resolve(modelRoot, "../media-cache"),
      });
      const scenesPromise = asset.kind === "video" ? analyzeSceneCuts({
        sourcePath, sourceStart: clip.sourceStart, duration: clip.duration, fps: project.fps,
        sourceSha256: asset.derivatives?.sourceSha256,
      }, { ffmpegPath, cacheRoot: process.env.EDITKIN_CACHE_ROOT }) : Promise.resolve({ cuts: [] });
      const [transcript, scenes] = await Promise.all([transcriptPromise, scenesPromise]);
      const plan = planSemanticAutoEdit({ duration: clip.duration, fps: project.fps, cues: transcript.cues, cuts: scenes.cuts, targetRatio });
      const built = buildSemanticAutoEditCommand(project, clip, transcript, plan, (kind, index) => `${kind}-highlight-${Date.now()}-${index}-${randomUUID()}`);
      const updated = await applyProjectCommands(projectPath, [built.command]);
      return textResult({
        status: "GREEN", changed: plan.removedDuration > 0, engine: plan.engine,
        originalSeconds: plan.originalDuration, keptSeconds: plan.keptDuration, removedSeconds: plan.removedDuration,
        segmentCount: built.segmentCount, addedCaptions: built.addedCaptions,
        selectedReasons: plan.segments.filter((segment) => segment.selected).map(({ start, end, score, reasons }) => ({ start, end, score, reasons })),
        transcriptEngine: transcript.engine, sceneEngine: asset.kind === "video" ? "ffmpeg-scdet-8" : "not-applicable",
        summary: summarizeProject(updated),
      });
    } catch (error) { return errorResult(error); }
  });

  return server;
}

export function createServer(): McpServer {
  return createServerForEnvironment(process.env);
}

const handle = serveStdio(createServer);
console.error(`Editkin MCP 0.15.0 ready; workspace=${workspaceRoot()}`);

let closingMaterialJobs = false;
async function closeOwnedMaterialJobs() {
  if (closingMaterialJobs) return;
  closingMaterialJobs = true;
  const { closeMaterialPreparationJobs } = await import("../application/materialPreparationJobs");
  await closeMaterialPreparationJobs();
  await handle.close();
}
process.on("SIGINT", () => { void closeOwnedMaterialJobs(); });
process.on("SIGTERM", () => { void closeOwnedMaterialJobs(); });
process.stdin.on("end", () => { void closeOwnedMaterialJobs(); });
