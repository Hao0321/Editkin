import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createAutopilotV4Fixture } from "../src/application/autopilotPlanFixture";
import { MOTION_TREATMENT_FAMILIES, motionCommandFamilies } from "../src/application/motionTreatment";
import {
  AUTOPILOT_MAX_CONTEXT_TOKENS,
  autopilotPlanSha256,
  parseAutopilotPlan,
  type CurrentAutopilotPlan,
} from "../src/application/autopilotPlan";
import { parseProject } from "../src/application/projectFiles";
import { findMotionGraphicPreset } from "../src/creative/motionGraphicPresets";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject } from "../src/domain/types";
import { createMotionGraphic } from "../src/motion/composition";

const appRoot = resolve(import.meta.dirname, "..");
const artifactParent = resolve(appRoot, ".rd/artifacts");
const artifactRoot = resolve(process.env.EDITKIN_CONTROLLED_E2E_ARTIFACT_ROOT ?? resolve(artifactParent, "autopilot-edit-quality-controlled-e2e"));
const reportPath = resolve(process.env.EDITKIN_CONTROLLED_E2E_REPORT_PATH ?? resolve(appRoot, ".rd/benchmarks/editkin-autopilot-edit-quality-controlled-e2e/report.json"));
const ffmpegPath = resolve(appRoot, "vendor/ffmpeg/win32-x64/ffmpeg.exe");
const ffprobePath = resolve(appRoot, "vendor/ffmpeg/win32-x64/ffprobe.exe");
const nativeCorePath = resolve(appRoot, "native/bin/win32-x64/hao-core.exe");
const projectFileName = "controlled.editkin.json";
const baselineFileName = "baseline.mp4";
const candidateFileName = "candidate.mp4";
const sourceFileName = "source.mp4";
const musicFileName = "music.wav";
const qualityReceiptFileName = "quality-receipt.json";
const SHA256 = /^[a-f0-9]{64}$/i;

type JsonRecord = Record<string, any>;
type FamilyId = "smartCut" | "captions" | "motionGraphics" | "transitions" | "audio" | "color" | "qa";

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256Json(value: unknown): string {
  return sha256(JSON.stringify(value));
}

async function sha256File(path: string): Promise<string> {
  return sha256(await readFile(path));
}

function cleanEnvironment(extra: Record<string, string>): Record<string, string> {
  const current = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  return { ...current, ...extra };
}

function runBuffer(command: string, args: string[], timeout = 120_000): Promise<{ stdout: Buffer; stderr: Buffer }> {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, { encoding: "buffer", windowsHide: true, timeout, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${command} failed: ${Buffer.from(stderr).toString("utf8").slice(-4_000)}`, { cause: error }));
        return;
      }
      resolvePromise({ stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) });
    });
  });
}

async function runText(command: string, args: string[], timeout = 120_000): Promise<{ stdout: string; stderr: string }> {
  const result = await runBuffer(command, args, timeout);
  return { stdout: result.stdout.toString("utf8"), stderr: result.stderr.toString("utf8") };
}

function toolPayload(result: Awaited<ReturnType<Client["callTool"]>>, name: string): JsonRecord {
  assert.equal(result.isError, undefined, `${name} failed: ${JSON.stringify(result.content)}`);
  const text = result.content.find((item) => item.type === "text") as { text?: string } | undefined;
  assert.ok(text?.text, `${name} returned no JSON text`);
  return JSON.parse(text.text) as JsonRecord;
}

async function probeMedia(path: string): Promise<JsonRecord> {
  const { stdout } = await runText(ffprobePath, [
    "-v", "error", "-count_frames",
    "-show_entries", "stream=index,codec_type,codec_name,width,height,nb_read_frames,duration,start_time,sample_rate,channels:format=duration,size,start_time",
    "-of", "json", path,
  ]);
  const raw = JSON.parse(stdout) as JsonRecord;
  const video = raw.streams?.find((stream: JsonRecord) => stream.codec_type === "video");
  const audio = raw.streams?.find((stream: JsonRecord) => stream.codec_type === "audio");
  return {
    video: video ? {
      codec: video.codec_name,
      width: Number(video.width),
      height: Number(video.height),
      decodedFrameCount: Number(video.nb_read_frames),
      durationSeconds: Number(video.duration || raw.format?.duration),
      startSeconds: Number(video.start_time || 0),
    } : undefined,
    audio: audio ? {
      codec: audio.codec_name,
      sampleRate: Number(audio.sample_rate),
      channels: Number(audio.channels),
      durationSeconds: Number(audio.duration || raw.format?.duration),
      startSeconds: Number(audio.start_time || 0),
    } : undefined,
    format: {
      durationSeconds: Number(raw.format?.duration),
      bytes: Number(raw.format?.size),
      startSeconds: Number(raw.format?.start_time || 0),
    },
  };
}

async function decodedFrame(path: string, seconds: number): Promise<Buffer> {
  const { stdout } = await runBuffer(ffmpegPath, [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-ss", seconds.toFixed(3), "-i", path,
    "-frames:v", "1", "-vf", "scale=160:90:flags=area", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1",
  ]);
  assert.equal(stdout.length, 160 * 90 * 3, `decoded frame missing at ${seconds}s`);
  return stdout;
}

function meanAbsoluteDifference(left: Buffer, right: Buffer): number {
  assert.equal(left.length, right.length);
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) sum += Math.abs(left[index] - right[index]);
  return sum / left.length;
}

async function decodedAudioHash(path: string): Promise<{ sha256: string; bytes: number }> {
  const { stdout } = await runBuffer(ffmpegPath, [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-i", path,
    "-map", "0:a:0", "-vn", "-ar", "48000", "-ac", "2", "-f", "s16le", "pipe:1",
  ]);
  return { sha256: sha256(stdout), bytes: stdout.length };
}

async function measureLoudness(path: string): Promise<JsonRecord> {
  const { stderr } = await runText(ffmpegPath, [
    "-hide_banner", "-nostdin", "-i", path,
    "-map", "0:a:0", "-af", "loudnorm=I=-18:TP=-3:LRA=7:print_format=json", "-f", "null", "NUL",
  ]);
  const match = stderr.match(/\{\s*"input_i"[\s\S]*?\}/g)?.at(-1);
  assert.ok(match, "FFmpeg loudnorm did not emit JSON");
  const raw = JSON.parse(match) as JsonRecord;
  return {
    integratedLufs: Number(raw.input_i),
    truePeakDbtp: Number(raw.input_tp),
    loudnessRangeLu: Number(raw.input_lra),
    targetOffsetLu: Number(raw.target_offset),
  };
}

function findClip(project: EditProject, id: string) {
  return project.tracks.flatMap((track) => track.clips).find((clip) => clip.id === id);
}

function evaluateFamilyObservations(observations: Record<FamilyId, JsonRecord>): Record<FamilyId, boolean> {
  return {
    smartCut: observations.smartCut.segmentIds?.length === 2
      && Math.abs(observations.smartCut.keptDurationSeconds - 3.8) <= 1 / 30
      && Math.abs(observations.smartCut.removedDurationSeconds - 0.2) <= 1 / 30,
    captions: observations.captions.count === 1 && observations.captions.separateEditableLayer === true
      && observations.captions.pureWhitePolicy === true && observations.captions.activeFrameMad > 1,
    motionGraphics: observations.motionGraphics.count === 1 && observations.motionGraphics.presetBound === true
      && observations.motionGraphics.activeFrameMad > 1,
    transitions: observations.transitions.pairedAdjacentTransition === true
      && observations.transitions.presetId === "luma_fade" && observations.transitions.activeFrameMad > 1,
    audio: observations.audio.hasDecodedAudio === true && observations.audio.changedFromBaseline === true
      && observations.audio.decodedBytes > 0 && Math.abs(observations.audio.integratedLufs + 18) <= 0.75
      && observations.audio.truePeakDbtp <= -2.8,
    color: observations.color.patchPersisted === true && observations.color.lookPersisted === true
      && observations.color.activeFrameMad > 1,
    qa: observations.qa.sourcePreserved === true && observations.qa.editableTimelineReopened === true
      && observations.qa.projectRevisionDelta === 1 && observations.qa.hasVideo === true && observations.qa.hasAudio === true
      && observations.qa.decodedFrameCount > 1 && observations.qa.uniqueTailFrames >= 2,
  };
}

function calibrateFamilyEvaluator(observations: Record<FamilyId, JsonRecord>): Record<FamilyId, number> {
  const positive = evaluateFamilyObservations(observations);
  for (const [family, passed] of Object.entries(positive)) assert.equal(passed, true, `${family} positive observation failed`);
  const mutations: Array<[FamilyId, (value: Record<FamilyId, JsonRecord>) => void]> = [
    ["smartCut", (value) => { value.smartCut.segmentIds = ["clip-source"]; }],
    ["captions", (value) => { value.captions.pureWhitePolicy = false; }],
    ["motionGraphics", (value) => { value.motionGraphics.activeFrameMad = 0; }],
    ["transitions", (value) => { value.transitions.pairedAdjacentTransition = false; }],
    ["audio", (value) => { value.audio.changedFromBaseline = false; }],
    ["color", (value) => { value.color.patchPersisted = false; }],
    ["qa", (value) => { value.qa.sourcePreserved = false; }],
  ];
  const rejected = Object.fromEntries((Object.keys(positive) as FamilyId[]).map((family) => [family, 0])) as Record<FamilyId, number>;
  for (const [family, mutate] of mutations) {
    const candidate = structuredClone(observations);
    mutate(candidate);
    assert.equal(evaluateFamilyObservations(candidate)[family], false, `family evaluator missed ${family} negative control`);
    rejected[family] += 1;
  }
  return rejected;
}

async function main(): Promise<void> {
  const artifactRelation = relative(artifactParent, artifactRoot);
  assert.ok(artifactRelation && !artifactRelation.startsWith("..") && !isAbsolute(artifactRelation), "unsafe controlled artifact path");
  const benchmarkParent = resolve(appRoot, ".rd/benchmarks");
  const reportRelation = relative(benchmarkParent, reportPath);
  assert.ok(reportRelation && !reportRelation.startsWith("..") && !isAbsolute(reportRelation), "unsafe controlled report path");
  await rm(artifactRoot, { recursive: true, force: true });
  await mkdir(artifactRoot, { recursive: true });
  await mkdir(resolve(reportPath, ".."), { recursive: true });

  const sourcePath = join(artifactRoot, sourceFileName);
  const musicPath = join(artifactRoot, musicFileName);
  const projectPath = join(artifactRoot, projectFileName);
  const baselinePath = join(artifactRoot, baselineFileName);
  const candidatePath = join(artifactRoot, candidateFileName);
  const qualityReceiptPath = join(artifactRoot, qualityReceiptFileName);
  await runText(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=960x540:rate=30:duration=4",
    "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:duration=4",
    "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18",
    "-pix_fmt", "yuv420p", "-x264-params", "colorprim=bt709:transfer=bt709:colormatrix=bt709:range=tv",
    "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv",
    "-c:a", "aac", "-b:a", "128k", "-t", "4", sourcePath]);
  await runText(ffmpegPath, [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000:duration=4",
    "-af", "volume=0.12", "-c:a", "pcm_s16le", musicPath,
  ]);
  const sourceSha256 = await sha256File(sourcePath);
  const musicSha256 = await sha256File(musicPath);
  const generatedAt = new Date().toISOString();
  const tsxCli = resolve(appRoot, "node_modules/tsx/dist/cli.mjs");
  const client = new Client({ name: "editkin-autopilot-quality-controlled-e2e", version: "0.15.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [tsxCli, "src/mcp/server.ts"],
    cwd: appRoot,
    env: cleanEnvironment({
      EDITKIN_WORKSPACE: artifactRoot,
      EDITKIN_CREATIVE_PACK_ROOT: resolve(appRoot, ".creative-packs/hao-creator-library"),
      EDITKIN_PERSONAL_MUSIC_ROOT: resolve(appRoot, ".personal-packs/hao-music-library"),
      EDITKIN_MODEL_ROOT: resolve(appRoot, "../../.rd/models/whisper"),
      EDITKIN_CACHE_ROOT: resolve(artifactRoot, "material-cache"),
      EDITKIN_PLUGIN_ROOTS: resolve(appRoot, "plugins"),
      EDITKIN_COLOR_ROOT: resolve(appRoot, "public/color/aces2"),
      HAO_FFMPEG_PATH: ffmpegPath,
      HAO_FFPROBE_PATH: ffprobePath,
      HAO_NATIVE_CORE_PATH: nativeCorePath,
    }),
    stderr: "pipe",
  });

  let report: JsonRecord | undefined;
  try {
    await client.connect(transport);
    const contract = toolPayload(await client.callTool({ name: "get_autopilot_contract", arguments: {} }), "get_autopilot_contract");
    assert.equal(contract.status, "GREEN");
    assert.equal(contract.requiredPlanSource.invocationBindingSha256, contract.liveInvocation.bindingSha256);
    assert.match(contract.liveInvocation.bindingSha256, SHA256);
    const inferenceRoute = toolPayload(await client.callTool({
      name: "resolve_autopilot_inference_route",
      arguments: { taskClass: "quality_critical", priority: "quality" },
    }), "resolve_autopilot_inference_route");
    assert.equal(inferenceRoute.route.secondPassRequired, true);

    toolPayload(await client.callTool({
      name: "create_project",
      arguments: { projectPath: projectFileName, name: "Controlled v4 Quality Journey", width: 640, height: 360, fps: 30 },
    }), "create_project");
    toolPayload(await client.callTool({
      name: "apply_edit_commands",
      arguments: {
        projectPath: projectFileName,
        commands: [
          {
            type: "import_asset",
            asset: {
              id: "asset-source", name: "Controlled source", kind: "video", uri: sourcePath,
              duration: 4, width: 960, height: 540,
              derivatives: { sourceSha256, generatedAt },
            },
          },
          {
            type: "add_clip",
            clip: {
              id: "clip-source", assetId: "asset-source", trackId: "video-main",
              timelineStart: 0, sourceStart: 0, duration: 4, volume: 1,
              transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [],
            },
          },
        ],
      },
    }), "apply_edit_commands:init");

    const initialProjectBytes = await readFile(projectPath);
    const initialProject = parseProject(JSON.parse(initialProjectBytes.toString("utf8")));
    const baselineRender = toolPayload(await client.callTool({
      name: "render_project",
      arguments: { projectPath: projectFileName, outputPath: baselineFileName, preferGpu: false },
    }), "render_project:baseline");
    assert.ok((await stat(baselinePath)).size > 20_000);

    const prepared = toolPayload(await client.callTool({
      name: "prepare_ai_material",
      arguments: { projectPath: projectFileName, clipId: "clip-source", includeTranscript: false, maxKeyframes: 4 },
    }), "prepare_ai_material");
    assert.match(prepared.packet.materialId, SHA256);
    assert.equal(prepared.packet.source.sourceSha256, sourceSha256);
    const frameIds = prepared.packet.keyframes.slice(0, 4).map((frame: JsonRecord) => frame.id);
    assert.ok(frameIds.length > 0);
    const viewed = await client.callTool({
      name: "view_material_keyframes",
      arguments: { materialId: prepared.packet.materialId, frameIds },
    });
    assert.equal(viewed.isError, undefined, `view_material_keyframes failed: ${JSON.stringify(viewed.content)}`);
    const viewedImages = viewed.content.filter((item) => item.type === "image").length;
    assert.equal(viewedImages, frameIds.length);
    const context = toolPayload(await client.callTool({
      name: "get_material_context",
      arguments: { materialId: prepared.packet.materialId, start: 0, end: 4, maxCues: 20, maxTokens: 800, maxCuts: 20 },
    }), "get_material_context");
    const contextTokens = Number(context.context.budget.estimatedTokens);
    assert.ok(Number.isInteger(contextTokens) && contextTokens > 0 && contextTokens <= 800);
    const semantic = toolPayload(await client.callTool({
      name: "record_material_semantics",
      arguments: {
        materialId: prepared.packet.materialId,
        sourceSha256,
        overallTopic: "Editkin current-v4 controlled engineering quality fixture",
        contentType: "software-demo",
        language: "none",
        people: [],
        locations: [],
        segments: [{
          start: 0, end: 4,
          summary: "可見彩色測試圖樣；工程樣片用來驗證可編輯字幕、圖卡、調色和音訊輸出",
          subjects: ["synthetic test pattern"], actions: ["motion test"], objects: ["colour bars"], importance: 0.9,
          evidenceFrameIds: frameIds, transcriptCueIndexes: [],
        }],
      },
    }), "record_material_semantics");
    const semanticReceiptSha256 = semantic.receipt.semanticReceiptSha256 as string;
    assert.match(semanticReceiptSha256, SHA256);

    const preset = findMotionGraphicPreset("studio_marker_burst");
    const graphic = createMotionGraphic(
      "graphic-proof", "title", "可編輯・可重做", 2.3, 1, undefined, preset.seed,
    );
    const fixture = structuredClone(createAutopilotV4Fixture(contract.requiredPlanSource));
    const commands: JsonRecord[] = [
      { type: "set_aesthetic_system", aestheticSystem: fixture.aesthetic },
      { type: "smart_cut_clip", clipId: "clip-source", keepRanges: [{ start: 0, end: 1.9 }, { start: 2.1, end: 4 }], segmentIds: ["clip-source", "clip-source-b"] },
      { type: "set_clip_creative", clipId: "clip-source", patch: { lookPresetId: "ai_cobalt_crisp", effectPresetIds: ["scanline_focus"], transitionOut: { presetId: "luma_fade", duration: 0.15 } } },
      { type: "set_clip_creative", clipId: "clip-source-b", patch: { lookPresetId: "ai_cobalt_crisp", effectPresetIds: ["scanline_focus"], transitionIn: { presetId: "luma_fade", duration: 0.15 } } },
      { type: "set_clip_color", clipId: "clip-source", patch: { exposure: 0.18, contrast: 1.08, saturation: 1.05 } },
      { type: "set_clip_color", clipId: "clip-source-b", patch: { exposure: 0.18, contrast: 1.08, saturation: 1.05 } },
      { type: "add_caption", caption: { id: "caption-proof", text: "這是可編輯字幕", start: 0.3, duration: 1 } },
      { type: "set_caption_style", patch: { presetId: "clean_caption", fontFamily: "Noto Sans TC", fontSize: 42, color: "#FFFFFF", translationColor: "#FFFFFF", outlineColor: "#000000", outlineWidth: 4, backgroundColor: "#00000000", marginV: 42 } },
      { type: "add_motion_graphic", graphic },
      {
        type: "import_asset",
        asset: {
          id: "asset-music", name: "Controlled music", kind: "audio", uri: musicPath, duration: 4,
          derivatives: { sourceSha256: musicSha256, generatedAt },
        },
      },
      { type: "add_track", track: { id: "audio-quality-music", name: "品質驗證音樂", kind: "audio", locked: false, muted: false, clips: [] } },
      { type: "add_clip", clip: { id: "clip-music", assetId: "asset-music", trackId: "audio-quality-music", timelineStart: 0, sourceStart: 0, duration: 3.8, volume: 0.12, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] } },
      { type: "add_director_marker", marker: { id: "marker-review", time: 2.3, title: "檢查圖卡", note: "工程 evidence，不代表真人審美通過", kind: "note", status: "open", createdAt: generatedAt } },
      { type: "rename_project", name: "Controlled v4 Autopilot Edited" },
    ];
    const designRequest = {
      format: fixture.route.format, domain: fixture.route.domain,
      topic: "可編輯自動剪輯工程驗證", duration: 3,
      beats: fixture.editorial.narrative.beats.map(beat => ({
        id: beat.id, role: beat.id === "promise" ? "first_frame" : beat.id === "payoff" ? "payoff" : "chapter",
        energy: beat.energy, subject: beat.primaryFocus,
      })),
    };
    const designPages = new Map<string, JsonRecord>();
    for (const pageId of ["context", ...designRequest.beats.map(beat => `beat:${beat.id}`)]) {
      let offset = 0; let content = ""; let page: JsonRecord;
      do {
        page = toolPayload(await client.callTool({ name: "get_autopilot_design_brief",
          arguments: { projectPath: projectFileName, request: designRequest, pageId, offset, maxTokens: 900 } }),
        `get_autopilot_design_brief:${pageId}`);
        assert.equal(page.status, "GREEN");
        content += page.text;
        offset = page.nextOffset;
      } while (page.hasMore);
      JSON.parse(content);
      designPages.set(pageId, page);
    }
    const designContext = designPages.get("context")!;
    const beatCommandIndexes: Record<string, number[]> = { promise: [2], setup: [6], payoff: [8] };
    const motionTreatment = { schema: "editkin.motion-treatment/v1", decisions: MOTION_TREATMENT_FAMILIES.map(family => {
      const commandIndexes = commands.flatMap((command, index) =>
        motionCommandFamilies(command as CurrentAutopilotPlan["commands"][number]).includes(family) ? [index] : []);
      return { family, action: commandIndexes.length ? "use" : "omit",
        reason: commandIndexes.length ? `工程驗證素材的 ${family} 命令有實際畫面或聲音用途` : `工程驗證素材沒有 ${family} 的必要語意與證據，保持乾淨`,
        beatIds: commandIndexes.length ? designRequest.beats.map(beat => beat.id) : [], commandIndexes };
    }) };
    const planInput = {
      ...fixture,
      budget: { ...fixture.budget, contextTokens },
      inference: { ...fixture.inference, context: { ...fixture.inference.context, packetTokens: contextTokens } },
      materialEvidence: {
        schema: "hao.editkin.material-intelligence/v1",
        receipts: [{
          materialId: prepared.packet.materialId,
          sourceSha256,
          assetId: "asset-source",
          clipId: "clip-source",
          semanticReceiptSha256,
        }],
      },
      designEvidence: { schema: "editkin.autopilot-design-evidence/v1", request: designRequest,
        projectSha256: designContext.projectSha256, sourceSha256: designContext.sourceSha256,
        briefSha256: designContext.briefSha256,
        decisions: designRequest.beats.map(beat => ({ beatId: beat.id,
          recipeSha256: designPages.get(`beat:${beat.id}`)!.recipeSha256,
          application: `以真實來源畫面實作 ${beat.subject}，並保持可讀的視覺層級`,
          commandIndexes: beatCommandIndexes[beat.id] })) },
      editorial: {
        ...fixture.editorial,
        motionTreatment,
        graphics: [{
          id: "graphic-proof", presetId: "studio_marker_burst", range: { startFrame: 69, endFrame: 99 },
          kind: "title_card", purpose: "payoff", message: "可編輯・可重做", evidenceRefs: ["receipt:controlled-v4"],
        }],
        transitions: [{ id: "transition-proof", atFrame: 57, kind: "short_dissolve", motivation: "continuity", evidenceRefs: ["material:controlled-source"] }],
        audio: {
          ...fixture.editorial.audio,
          layers: [
            { id: "dialogue", role: "dialogue", purpose: "保留來源聲音", evidenceRefs: ["asset:asset-source:audio"] },
            { id: "music", role: "music", purpose: "低音量節奏底", evidenceRefs: ["asset:asset-music"] },
          ],
        },
        color: { ...fixture.editorial.color, primaryLookId: "ai_cobalt_crisp" },
      },
      commands,
    };
    const parsed = parseAutopilotPlan(planInput);
    assert.equal(parsed.schema, "hao.video-autopilot.edit-plan/v4");
    const plan = parsed as CurrentAutopilotPlan;
    const planSha256 = autopilotPlanSha256(plan);
    assert.match(planSha256, SHA256);

    const audit = toolPayload(await client.callTool({
      name: "audit_autopilot_plan",
      arguments: { projectPath: projectFileName, plan },
    }), "audit_autopilot_plan");
    assert.equal(audit.status, "ACCEPTED");
    assert.equal(audit.planSha256, planSha256);
    assert.equal(audit.auditReceipt.invocation.bindingSha256, contract.liveInvocation.bindingSha256);
    const auditReceiptSha256 = audit.auditReceipt.receiptSha256 as string;
    assert.match(auditReceiptSha256, SHA256);
    const tampered = await client.callTool({
      name: "apply_autopilot_plan",
      arguments: {
        projectPath: projectFileName,
        plan,
        auditReceipt: { ...audit.auditReceipt, receiptSha256: "0".repeat(64) },
      },
    });
    assert.equal(tampered.isError, true, "tampered audit receipt was accepted");

    const applied = toolPayload(await client.callTool({
      name: "apply_autopilot_plan",
      arguments: { projectPath: projectFileName, plan, auditReceipt: audit.auditReceipt },
    }), "apply_autopilot_plan");
    assert.equal(applied.status, "REVIEW_REQUIRED");
    assert.equal(applied.receipt.planSha256, planSha256);
    assert.equal(applied.receipt.coverage.level, "current_multimodal_editorial_contract");
    assert.equal(applied.receipt.materialEvidence.receiptCount, 1);
    assert.equal(applied.receipt.audit.receiptSha256, auditReceiptSha256);
    assert.equal(applied.receipt.projectRevisionAfter, applied.receipt.projectRevisionBefore + 1);
    assert.equal(applied.appliedCommandCount, commands.length);

    const committedReceiptPath = join(artifactRoot, ".editkin-receipts", applied.receipt.receiptFile);
    const executionReceiptBytes = await readFile(committedReceiptPath);
    const executionReceipt = JSON.parse(executionReceiptBytes.toString("utf8")) as JsonRecord;
    assert.equal(executionReceipt.state, "committed");
    assert.equal(executionReceipt.planSha256, planSha256);
    assert.equal(executionReceipt.projectRevisionAfter, applied.receipt.projectRevisionAfter);
    const executionReceiptSha256 = sha256(executionReceiptBytes);

    const projectBytes = await readFile(projectPath);
    const project = parseProject(JSON.parse(projectBytes.toString("utf8")));
    assert.equal(project.revision, applied.receipt.projectRevisionAfter);
    const first = findClip(project, "clip-source");
    const second = findClip(project, "clip-source-b");
    const music = findClip(project, "clip-music");
    assert.ok(first && second && music, "editable timeline is missing planned clips");
    assert.equal(first.timelineStart + first.duration, second.timelineStart);
    assert.equal(first.creative?.transitionOut?.presetId, "luma_fade");
    assert.equal(second.creative?.transitionIn?.presetId, "luma_fade");
    assert.equal(project.captions.length, 1);
    assert.equal(project.motionGraphics.length, 1);
    assert.equal(project.captionStyle.color, "#FFFFFF");
    assert.equal(project.captionStyle.translationColor, "#FFFFFF");
    assert.equal(project.motionGraphics[0].presetId, "studio_marker_burst");
    const sourceShaAfter = await sha256File(sourcePath);
    assert.equal(sourceShaAfter, sourceSha256, "source bytes changed during apply");

    const candidateRender = toolPayload(await client.callTool({
      name: "render_project",
      arguments: { projectPath: projectFileName, outputPath: candidateFileName, preferGpu: false },
    }), "render_project:candidate");
    const [baselineProbe, candidateProbe, baselineAudio, candidateAudio, loudness] = await Promise.all([
      probeMedia(baselinePath),
      probeMedia(candidatePath),
      decodedAudioHash(baselinePath),
      decodedAudioHash(candidatePath),
      measureLoudness(candidatePath),
    ]);
    assert.ok(candidateProbe.video && candidateProbe.audio, "candidate render is missing decoded streams");
    const sampleTimes = { caption: 0.8, color: 1.4, transition: 1.82, motion: 2.7 } as const;
    const decodedComparisons: JsonRecord = {};
    for (const [id, time] of Object.entries(sampleTimes)) {
      const [baselineFrame, candidateFrame] = await Promise.all([decodedFrame(baselinePath, time), decodedFrame(candidatePath, time)]);
      decodedComparisons[id] = {
        time,
        baselineSha256: sha256(baselineFrame),
        candidateSha256: sha256(candidateFrame),
        meanAbsoluteDifference: meanAbsoluteDifference(baselineFrame, candidateFrame),
      };
    }
    const tailTimes = [3.45, 3.6, 3.72];
    const tailHashes = await Promise.all(tailTimes.map(async (time) => sha256(await decodedFrame(candidatePath, time))));
    const uniqueTailFrames = new Set(tailHashes).size;
    const outputBytes = await readFile(candidatePath);
    const outputSha256 = sha256(outputBytes);
    const projectSha256 = sha256(projectBytes);

    const familyObservations: Record<FamilyId, JsonRecord> = {
      smartCut: {
        segmentIds: [first.id, second.id], keptDurationSeconds: first.duration + second.duration,
        removedDurationSeconds: 4 - first.duration - second.duration,
        sourceRanges: [{ start: first.sourceStart, duration: first.duration }, { start: second.sourceStart, duration: second.duration }],
      },
      captions: {
        count: project.captions.length, separateEditableLayer: project.captions[0]?.id === "caption-proof",
        pureWhitePolicy: project.captionStyle.color === "#FFFFFF" && project.captionStyle.translationColor === "#FFFFFF",
        activeFrameMad: decodedComparisons.caption.meanAbsoluteDifference,
      },
      motionGraphics: {
        count: project.motionGraphics.length,
        presetBound: project.motionGraphics[0]?.presetId === "studio_marker_burst" && project.motionGraphics[0]?.text === "可編輯・可重做",
        activeFrameMad: decodedComparisons.motion.meanAbsoluteDifference,
      },
      transitions: {
        pairedAdjacentTransition: first.creative?.transitionOut?.presetId === "luma_fade"
          && second.creative?.transitionIn?.presetId === "luma_fade"
          && Math.abs(first.timelineStart + first.duration - second.timelineStart) <= 1 / 30,
        presetId: first.creative?.transitionOut?.presetId,
        activeFrameMad: decodedComparisons.transition.meanAbsoluteDifference,
      },
      audio: {
        hasDecodedAudio: Boolean(candidateProbe.audio),
        changedFromBaseline: baselineAudio.sha256 !== candidateAudio.sha256,
        baselinePcmSha256: baselineAudio.sha256,
        candidatePcmSha256: candidateAudio.sha256,
        decodedBytes: candidateAudio.bytes,
        integratedLufs: loudness.integratedLufs,
        truePeakDbtp: loudness.truePeakDbtp,
        musicTrackId: "audio-quality-music",
      },
      color: {
        patchPersisted: first.color.exposure === 0.18 && second.color.exposure === 0.18,
        lookPersisted: first.creative?.lookPresetId === "ai_cobalt_crisp" && second.creative?.lookPresetId === "ai_cobalt_crisp",
        activeFrameMad: decodedComparisons.color.meanAbsoluteDifference,
      },
      qa: {
        sourcePreserved: sourceShaAfter === sourceSha256,
        editableTimelineReopened: true,
        projectRevisionDelta: applied.receipt.projectRevisionAfter - applied.receipt.projectRevisionBefore,
        hasVideo: Boolean(candidateProbe.video), hasAudio: Boolean(candidateProbe.audio),
        decodedFrameCount: candidateProbe.video.decodedFrameCount,
        uniqueTailFrames,
      },
    };
    const negativeControlsRejected = calibrateFamilyEvaluator(familyObservations);
    const familyChecks = evaluateFamilyObservations(familyObservations);
    assert.ok(Object.values(familyChecks).every(Boolean));
    const familyEvidenceSha256 = sha256Json(familyObservations);
    const decodedProbe = {
      schema: "editkin.autopilot-independent-decode/v1",
      ffprobe: candidateProbe,
      baseline: baselineProbe,
      comparisons: decodedComparisons,
      tail: { times: tailTimes, hashes: tailHashes, uniqueFrames: uniqueTailFrames },
      audio: { baseline: baselineAudio, candidate: candidateAudio, loudness },
    };
    const decodedProbeSha256 = sha256Json(decodedProbe);
    const journeyId = `controlled-current-v4-${randomUUID()}`;
    const bindingBase = {
      bindingSchema: "editkin.autopilot-quality-binding/v1",
      journeyId,
      sourceSha256,
      semanticReceiptSha256,
      liveInvocationBindingSha256: contract.liveInvocation.bindingSha256,
      planSha256,
      auditReceiptSha256,
      executionReceiptSha256,
      projectSha256,
      projectRevision: project.revision,
      outputSha256,
      decodedProbeSha256,
      familyEvidenceSha256,
    };
    const bindingSha256 = sha256Json(bindingBase);
    const qualityReceipt = {
      schema: "editkin.autopilot-decoded-quality-receipt/v1",
      ...bindingBase,
      bindingSha256,
      reviewState: "REVIEW_REQUIRED",
      certified: false,
      createdAt: new Date().toISOString(),
      claimBoundary: "One deterministic four-second local fixture proves current-v4 engineering integration only; creator-grade longform and shortform editorial quality remain unmeasured.",
    };
    await writeFile(qualityReceiptPath, `${JSON.stringify(qualityReceipt, null, 2)}\n`, "utf8");
    const qualityReceiptFileSha256 = await sha256File(qualityReceiptPath);

    const families = Object.fromEntries((Object.keys(familyObservations) as FamilyId[]).map((family) => [family, {
      state: "measured",
      status: "GREEN",
      sameJourney: true,
      journeyId,
      bindingSha256,
      evidenceLevel: "decoded-artifact",
      evaluatorCalibrated: true,
      negativeControlsRejected: negativeControlsRejected[family],
      reportSha256: sha256Json(familyObservations[family]),
    }]));
    const aggregateEvidence = {
      schema: "editkin.autopilot-edit-quality-evidence/v1",
      fixtureOnly: false,
      journey: {
        id: journeyId,
        sourceSha256,
        plan: {
          retainedEvidence: true,
          schema: plan.schema,
          sha256: planSha256,
          sourceSha256,
          invocationBindingSha256: contract.liveInvocation.bindingSha256,
          contextTokens,
          maximumContextTokens: AUTOPILOT_MAX_CONTEXT_TOKENS,
          semanticReceiptCount: 1,
          semanticReceiptSha256,
          auditReceiptSha256,
          auditAccepted: audit.status === "ACCEPTED",
          secondPassRequired: plan.inference.safeguards.secondPassRequired,
        },
        apply: {
          retainedEvidence: true,
          schema: executionReceipt.schema,
          planSha256,
          sourceSha256,
          invocationBindingSha256: contract.liveInvocation.bindingSha256,
          projectRevisionBefore: applied.receipt.projectRevisionBefore,
          projectRevisionAfter: applied.receipt.projectRevisionAfter,
          atomic: true,
          editableTimelineReopened: true,
          singleAtomicBatchBoundary: true,
          sourcePreserved: sourceShaAfter === sourceSha256,
          executionReceiptSha256,
        },
        render: {
          retainedEvidence: true,
          schema: "editkin.autopilot-render-receipt/v1",
          planSha256,
          sourceSha256,
          projectRevision: project.revision,
          outputSha256,
          bytes: outputBytes.length,
          durationSeconds: candidateProbe.format.durationSeconds,
          hasVideo: Boolean(candidateProbe.video),
          hasAudio: Boolean(candidateProbe.audio),
          decodedFrameCount: candidateProbe.video.decodedFrameCount,
          uniqueTailFrames,
          decodedProbeSha256,
        },
        qualityReceipt: {
          retainedEvidence: true,
          schema: qualityReceipt.schema,
          journeyId,
          planSha256,
          sourceSha256,
          projectRevision: project.revision,
          outputSha256,
          reviewState: qualityReceipt.reviewState,
          certified: false,
          bindingSha256,
          semanticReceiptSha256,
          auditReceiptSha256,
          executionReceiptSha256,
          decodedProbeSha256,
        },
      },
      families,
      humanEditorial: {
        state: "unmeasured", blind: false, independentGroundTruth: false, datasetVisibility: "none",
        caseCount: 0, reviewerCount: 0, responseCount: 0, winRateExcludingTies: 0,
        severeErrorRate: 0, meanScoreDelta: 0,
      },
    };
    report = {
      schema: "editkin.autopilot-edit-quality-controlled-e2e/report-v1",
      status: "GREEN_ENGINEERING_BOUNDED",
      editorialQualityClaim: "BLOCK_UNMEASURED",
      measuredAt: new Date().toISOString(),
      claimBoundary: "This is one deterministic four-second engineering fixture. It proves the current-v4 plan-to-editable-timeline-to-decoded-render receipt chain and calibrated negative controls. It does not measure whether real longform or shortform edits are creator-grade, competitive, or preferred by blind reviewers.",
      journey: {
        id: journeyId,
        source: { path: sourcePath, sha256: sourceSha256, unchangedAfterApply: sourceShaAfter === sourceSha256 },
        liveInvocation: contract.liveInvocation,
        requiredPlanSource: contract.requiredPlanSource,
        inferenceRoute: inferenceRoute.route,
        material: {
          id: prepared.packet.materialId,
          contextTokens,
          contextMaximumTokens: 800,
          keyframeIds: frameIds,
          viewedImageCount: viewedImages,
          semanticReceiptSha256,
        },
        plan: { schema: plan.schema, sha256: planSha256, retained: plan, auditReceiptSha256 },
        apply: {
          projectRevisionBefore: applied.receipt.projectRevisionBefore,
          projectRevisionAfter: applied.receipt.projectRevisionAfter,
          appliedCommandCount: applied.appliedCommandCount,
          tamperedAuditNegativeRejected: tampered.isError === true,
          executionReceiptPath: committedReceiptPath,
          executionReceiptSha256,
          projectPath,
          projectSha256,
          editableTimelineReopened: true,
        },
        render: {
          baseline: { path: baselinePath, sha256: await sha256File(baselinePath), response: baselineRender },
          candidate: { path: candidatePath, sha256: outputSha256, bytes: outputBytes.length, response: candidateRender },
          decodedProbe,
          decodedProbeSha256,
        },
        quality: {
          familyObservations,
          familyChecks,
          negativeControlsRejected,
          familyEvidenceSha256,
          qualityReceiptPath,
          qualityReceiptFileSha256,
          bindingSha256,
        },
      },
      aggregateEvidence,
      editorialAcceptance: {
        state: "BLOCK_UNMEASURED",
        missing: ["frozen real longform holdout", "frozen real shortform holdout", "at least three independent blind reviewers", "pairwise preference and severe-error results"],
      },
      nextExperiment: "Run frozen real longform and shortform blind holdouts with at least three independent reviewers. Keep this controlled fixture only as the engineering regression gate.",
    };
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  } finally {
    await client.close().catch(() => undefined);
  }

  assert.ok(report);
  process.stdout.write(`${JSON.stringify({
    status: report.status,
    editorialQualityClaim: report.editorialQualityClaim,
    report: relative(appRoot, reportPath).replaceAll("\\", "/"),
    output: relative(appRoot, join(artifactRoot, candidateFileName)).replaceAll("\\", "/"),
    bindingSha256: report.journey.quality.bindingSha256,
    familyNegativeControlsRejected: Object.values(report.journey.quality.negativeControlsRejected).reduce((sum: number, value) => sum + Number(value), 0),
  })}\n`);
}

await main();
