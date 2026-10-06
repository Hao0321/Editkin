import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, delimiter, resolve, join } from "node:path";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createEmptyProject, migrateProject, validateProject, animatedClipState } from "../src/domain/editGraph";
import { applyCommand } from "../src/domain/commands";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, DEFAULT_COLOR_MANAGEMENT, type EditProject, type MediaAsset } from "../src/domain/types";
import { projectSchema } from "../src/domain/schema";
import { inspectMedia } from "../src/application/inspectMedia";
import { compositorSourceColorPlan } from "../src/render/sourceColorFilters";
import { buildReferenceMotionTemplateCommands } from "../src/application/referenceMotionTemplateCommands";
import { REFERENCE_MOTION_TEMPLATES, type ReferenceMotionTemplateId, type ReferenceMotionTemplateInput } from "../src/motion/referenceMotionTemplates";
import { renderProject } from "../src/render/ffmpeg";

const run = promisify(execFile), root = resolve(import.meta.dirname, ".."), evidence = resolve(root, ".rd/benchmarks/motion-reference-templates-20260930");
const ffmpeg = resolve(root, "vendor/ffmpeg/win32-x64/ffmpeg.exe"), ffprobe = resolve(root, "vendor/ffmpeg/win32-x64/ffprobe.exe");
const sha = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const duration = 5, fps = 30, renderOptions = { ffmpegPath: ffmpeg, ffprobePath: ffprobe, fontRoot: resolve(root, "public/fonts"), preferGpu: false, timeoutMs: 240_000 };
// Owned footage and music are explicit local inputs; public source never names private media.
const ownedSources = (process.env.EDITKIN_REFERENCE_MOTION_OWNED_SOURCES ?? "").split(delimiter).map(item => item.trim()).filter(Boolean).map(item => resolve(item));
if (ownedSources.length !== 4) throw new Error(`請設定 EDITKIN_REFERENCE_MOTION_OWNED_SOURCES：依序填入四支自有 1080×1920 直式影片路徑（以「${delimiter}」分隔，第一支至少 8 秒）；公開原始碼不內建私人素材`);
if (!process.env.EDITKIN_REFERENCE_MOTION_OWNED_MUSIC) throw new Error("請設定 EDITKIN_REFERENCE_MOTION_OWNED_MUSIC：一個自有配樂檔路徑；公開原始碼不內建私人配樂");
const musicPath = resolve(process.env.EDITKIN_REFERENCE_MOTION_OWNED_MUSIC);
await mkdir(join(evidence, "sources"), { recursive: true });
const priorReport = await readFile(join(evidence, "render-report.json"), "utf8").then(JSON.parse).catch(() => undefined);
const repairOnly = process.argv.find(arg => arg.startsWith("--only="))?.slice(7).split(",");
if (priorReport && !await readFile(join(evidence, "first-art-failure.json")).then(() => true).catch(() => false)) {
  await writeFile(join(evidence, "first-art-failure.json"), JSON.stringify({ status: "ART_REJECTED", report: priorReport,
    reasons: ["Decoded enlargement was cropped to the first small overlay frame; keyframes alone did not prove output geometry", "Strike line exceeded the actual phrase", "Level title panel covered the source gesture", "Context and recap needed distinct visual treatments"],
    correction: "Fixed negotiated alpha canvas for animated scale; original navy/iris palette; glyph-length strike, upper title band, distinct cards and typographic recap" }, null, 2));
  for (const name of ["evidence_takeover", "focus_wall"]) await copyFile(join(evidence, `${name}-sequence.png`), join(evidence, `first-failure-${name}.png`));
}
const priorSources = await readFile(join(evidence, "owned-source-receipts.json"), "utf8").then(JSON.parse).catch(() => []);
const assets: MediaAsset[] = [], receipts: unknown[] = [];
const musicProbe = await inspectMedia(musicPath, ffprobe);
const demoMusic: MediaAsset = { id: "owned-demo-music", name: basename(musicPath), kind: "audio", uri: musicPath,
  duration: musicProbe.duration, role: "background-music" };
await writeFile(join(evidence, "demo-music-receipt.json"), JSON.stringify({ path: musicPath, sha256: sha(await readFile(musicPath)),
  source: "owner-supplied music (EDITKIN_REFERENCE_MOTION_OWNED_MUSIC)", probe: musicProbe, distributedWithProduct: false }, null, 2));
// One local SDR working derivative per owned source; the original camera HLG files stay untouched.
for (const [index, original] of ownedSources.entries()) {
  const file = basename(original), probe = await inspectMedia(original, ffprobe);
  const asset: MediaAsset = { id: `owned-${index}`, name: file, kind: "video", uri: original, duration: probe.duration,
    width: probe.width, height: probe.height, color: { interpretation: probe.colorTransfer === "arib-std-b67" ? "hlg" : "rec709",
      primaries: probe.colorPrimaries, transfer: probe.colorTransfer, matrix: probe.colorMatrix, range: probe.colorRange } };
  const sourceDuration = index === 0 ? 8 : duration;
  if (probe.duration < sourceDuration || probe.width !== 1080 || probe.height !== 1920) throw new Error("Owned source dimensions/duration require explicit redesign");
  const output = join(evidence, "sources", `${asset.id}-sdr.mp4`);
  const filters = [...compositorSourceColorPlan(asset, 1080, 1920, "rgba", 255, DEFAULT_COLOR_MANAGEMENT).filters, "setsar=1", "format=yuv420p", "setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709"];
  const originalSha256 = sha(await readFile(original)), old = priorSources.find((r: any) => r.originalPath === original && r.originalSha256 === originalSha256 && r.normalizedProbe.duration >= sourceDuration && JSON.stringify(r.method) === JSON.stringify(filters));
  const reused = old && await readFile(output).then(bytes => sha(bytes) === old.normalizedSha256).catch(() => false);
  if (!reused) await run(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-i", original, "-t", String(sourceDuration), "-vf", filters.join(","), "-c:v", "libx264", "-crf", "18", "-preset", "fast", "-r", String(fps), "-c:a", "aac", "-b:a", "192k", output], { windowsHide: true, timeout: 180_000 });
  const normalized = await inspectMedia(output, ffprobe);
  receipts.push({ originalPath: original, originalSha256, sourceProbe: probe, normalizedPath: output, normalizedSha256: sha(await readFile(output)), normalizedProbe: normalized, method: filters, originalReadOnly: true, reused: Boolean(reused) });
  assets.push({ ...asset, uri: output, duration: sourceDuration, color: { interpretation: "rec709", primaries: normalized.colorPrimaries,
    transfer: normalized.colorTransfer, matrix: normalized.colorMatrix, range: normalized.colorRange } });
}
await writeFile(join(evidence, "owned-source-receipts.json"), JSON.stringify(receipts, null, 2));

function base(name: string, width = 540, height = 960) {
  const network = ["kinetic_network", "control_network"].includes(name);
  const sceneDuration = ["brand_recap", "control_recap", "kinetic_network", "control_network"].includes(name) ? 8 : duration;
  const project = createEmptyProject(name, { id: `motion-${name}`, width, height, fps });
  project.assets = structuredClone(assets);
  project.tracks[0].clips.push({ id: "main", assetId: assets[0].id, trackId: "video-main", sourceStart: 0, timelineStart: 0, duration: sceneDuration, volume: network ? 0 : .5,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [], layer: { enabled: true, blendMode: "normal", role: "content" } });
  if (network) {
    project.assets.push(structuredClone(demoMusic));
    project.tracks.push({ id: "demo-music", name: "概念示範配樂", kind: "audio", locked: false, muted: false, clips: [{ id: "demo-music-clip",
      assetId: demoMusic.id, trackId: "demo-music", sourceStart: 0, timelineStart: 0, duration: sceneDuration, volume: .45,
      transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] }] });
  }
  return project;
}
function sceneInput(templateId: ReferenceMotionTemplateId): ReferenceMotionTemplateInput {
  const title = { strike_reframe: "也是手的痕跡", level_bridge: "手勢，留下形", comparison_pair: "同一雙手，不同細節", context_stack: "讓手慢慢說話", evidence_takeover: "靠近手的細節", focus_wall: "選一個觀看角度", brand_recap: "手的痕跡，留在器上", kinetic_network: "把能力連起來" }[templateId];
  return { templateId, clipId: "main", startFrame: 0, durationFrames: (["brand_recap", "kinetic_network"].includes(templateId) ? 8 : duration) * fps, title,
    kicker: templateId === "kinetic_network" ? "自由工坊 · 概念動態" : templateId === "evidence_takeover" ? "特寫" : "手作 · 陶藝",
    subtitle: templateId === "strike_reframe" ? "每一道曲線，都經過雙手" : templateId === "level_bridge" ? "每一道曲線，都經過雙手" : undefined,
    previousText: templateId === "strike_reframe" ? "只是一塊土" : undefined,
    items: templateId === "kinetic_network" ? [{ label: "各自出發", detail: "每個人都有專長" }, { label: "找到彼此", detail: "讓能力找到夥伴" }, { label: "一起創造", detail: "一起做出作品" }]
      : ["context_stack", "brand_recap"].includes(templateId) ? [{ label: "泥土", detail: "讓材質留下觸感" }, { label: "手勢", detail: "力道改變曲線" }, { label: "輪廓", detail: "讓形狀慢慢出現" }] : undefined,
    sources: templateId === "comparison_pair" ? [{ assetId: assets[1].id, sourceStart: 0, label: "塑形細節" }]
      : templateId === "focus_wall" ? assets.slice(1).map((a, index) => ({ assetId: a.id, sourceStart: 0, label: ["塑形", "拉坯", "工作坊環境"][index] })) : [],
    primaryLabel: "主要手勢", focusRegion: templateId === "brand_recap" ? { x: 0, y: .11, width: 1, height: .58 } : undefined,
    network: templateId === "kinetic_network" ? { seed: 32021, points: 32, labels: ["設計", "開發", "創作"], hubLabel: "共創" } : undefined,
    purpose: templateId === "kinetic_network" ? "抽象概念示範：分散專長、找到彼此、共創；圖形不代表真實會員數或平台成果"
      : "使用自有陶藝素材驗證觀看順序；此示範文案不是正式旁白逐字稿",
    evidenceRefs: templateId === "kinetic_network" ? ["copy:user-supplied-freetwai-introduction", "illustration:original-connection-metaphor"] : ["owned:pottery-research", "copy:original-motion-demo"] };
}
const outputs: any[] = [];
async function output(project: EditProject, name: string, packet?: ReturnType<typeof buildReferenceMotionTemplateCommands>) {
  const sceneDuration = project.tracks[0].clips[0].duration;
  const reopened = validateProject(migrateProject(projectSchema.parse(JSON.parse(JSON.stringify(project)))));
  const projectPath = join(evidence, `${name}.editkin.json`), path = join(evidence, `${name}.mp4`);
  if (repairOnly && !repairOnly.includes(name)) {
    const prior = priorReport?.outputs.find((item: any) => item.name === name);
    const priorBytes = await readFile(projectPath), priorProject = JSON.parse(priorBytes.toString("utf8"));
    // New in-memory clocks are not a graph change. Reuse the exact saved file
    // only after semantic comparison and both original SHA bindings pass.
    reopened.updatedAt = priorProject.updatedAt;
    if (reopened.director && priorProject.director) reopened.director.updatedAt = priorProject.director.updatedAt;
    const proposedBytes = Buffer.from(JSON.stringify(reopened, null, 2));
    if (!prior || prior.projectSha256 !== sha(priorBytes) || sha(proposedBytes) !== sha(priorBytes)
      || prior.outputSha256 !== sha(await readFile(path))) {
      const changes: string[] = [];
      const compare = (a: any, b: any, key = "project") => {
        if (JSON.stringify(a) === JSON.stringify(b) || changes.length >= 12) return;
        if (a && b && typeof a === "object" && typeof b === "object") {
          for (const child of new Set([...Object.keys(a), ...Object.keys(b)])) compare(a[child], b[child], `${key}.${child}`);
        } else changes.push(`${key}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
      };
      compare(priorProject, reopened);
      throw new Error(`RENDER_REQUIRED: ${name} also changed; ${changes.join("; ") || "saved file/output binding differs"}`);
    }
    outputs.push({ ...prior, reusedUnchangedEvidence: true }); return;
  }
  const bytes = Buffer.from(JSON.stringify(reopened, null, 2)); await writeFile(projectPath, bytes);
  const start = performance.now(), rendered = await renderProject(reopened, path, renderOptions), elapsedMs = performance.now() - start;
  const { stdout: probeText } = await run(ffprobe, ["-v", "error", "-count_frames", "-show_streams", "-of", "json", path], { windowsHide: true });
  const probe = JSON.parse(probeText), stream = probe.streams.find((s: any) => s.codec_type === "video");
  if (Number(stream.nb_read_frames) !== sceneDuration * fps) throw new Error(`Wrong frame count: ${name}`);
  await run(ffmpeg, ["-v", "error", "-xerror", "-i", path, "-map", "0:v:0", "-map", "0:a:0", "-f", "null", "-"], { timeout: 120_000, windowsHide: true });
  const { stdout: audioPcmSha } = await run(ffmpeg, ["-v", "error", "-i", path, "-map", "0:a:0", "-f", "hash", "-hash", "sha256", "-"], { windowsHide: true });
  const stillTime = name === "kinetic_network" ? 6.5 : name === "strike_reframe" ? 3.7 : name === "brand_recap" ? 3.8 : name === "context_stack" ? 2.8 : name.startsWith("focus_wall") ? 3.8 : 2.7;
  await run(ffmpeg, ["-v", "error", "-y", "-ss", String(stillTime), "-i", path, "-frames:v", "1", join(evidence, `${name}-still.png`)], { windowsHide: true });
  await run(ffmpeg, ["-v", "error", "-y", "-i", path, "-vf", `fps=2,scale=216:-1,tile=5x${Math.ceil(sceneDuration * 2 / 5)}`, "-frames:v", "1", join(evidence, `${name}-sequence.png`)], { windowsHide: true });
  if (packet) for (const phase of packet.phases.filter(p => p.role === "hold")) {
    for (const clip of reopened.tracks.flatMap(t => t.clips)) for (let frame = phase.startFrame; frame < phase.endFrame; frame++) {
      if (JSON.stringify(animatedClipState(clip, frame / fps).transform) !== JSON.stringify(animatedClipState(clip, phase.startFrame / fps).transform)) throw new Error("Motion geometry drifts within the reading hold");
    }
  }
  const receipt = { name, path, outputSha256: sha(await readFile(path)), projectPath, projectSha256: sha(bytes), elapsedMs,
    frameCount: Number(stream.nb_read_frames), width: stream.width, height: stream.height, duration: sceneDuration, audioPcmSha: audioPcmSha.trim(), fullDecodeExit: 0,
    renderer: rendered.planner, geometryHoldVerified: Boolean(packet), phases: packet?.phases, sourceCount: packet?.sourceCount, installedGeneration: false };
  outputs.push(receipt); process.stdout.write(JSON.stringify({ name, elapsedMs, frames: receipt.frameCount, sourceCount: receipt.sourceCount }) + "\n");
}
await output(base("control"), "control");
await output(base("control_recap"), "control_recap");
await output(base("control_network"), "control_network");
for (const recipe of [...REFERENCE_MOTION_TEMPLATES].sort((a, b) => ["evidence_takeover", "focus_wall"].indexOf(b.id) - ["evidence_takeover", "focus_wall"].indexOf(a.id))) {
  let i = 0; const project = base(recipe.id), packet = buildReferenceMotionTemplateCommands(project, sceneInput(recipe.id), p => `${p}-${i++}`);
  await writeFile(join(evidence, `${recipe.id}-packet.json`), JSON.stringify(packet, null, 2));
  await output(applyCommand(project, { type: "batch", commands: packet.commands }), recipe.id, packet);
}
if (outputs.some(item => item.audioPcmSha !== outputs.find(c => c.name === (["kinetic_network", "control_network"].includes(item.name) ? "control_network" : item.duration === 8 ? "control_recap" : "control"))!.audioPcmSha)) throw new Error("Decoded authored audio changed across templates");

// Source MCP transport journey: actual discovery and prepare, with no project mutation.
const client = new Client({ name: "motion-template-source-gate", version: "1.0" });
const transport = new StdioClientTransport({ command: process.execPath, args: [resolve(root, "node_modules/tsx/dist/cli.mjs"), "src/mcp/server.ts"], cwd: root,
  env: Object.fromEntries(Object.entries({ ...process.env, EDITKIN_WORKSPACE: root, EDITKIN_MCP_MODE: "" }).filter((v): v is [string, string] => v[1] !== undefined)), stderr: "pipe" });
let mcp: unknown;
try {
  await client.connect(transport); const listing = await client.listTools();
  if (!["list_reference_motion_templates", "prepare_reference_motion_template"].every(name => listing.tools.some(t => t.name === name))) throw new Error("Source MCP did not discover template tools");
  const catalog = await client.callTool({ name: "list_reference_motion_templates", arguments: {} });
  const before = await readFile(join(evidence, "control.editkin.json"));
  const prepared = await client.callTool({ name: "prepare_reference_motion_template", arguments: { ...sceneInput("comparison_pair"), projectPath: join(evidence, "control.editkin.json") } });
  if (prepared.isError || sha(before) !== sha(await readFile(join(evidence, "control.editkin.json")))) throw new Error("MCP prepare failed or mutated the project");
  const networkBefore = await readFile(join(evidence, "control_network.editkin.json"));
  const networkPrepared = await client.callTool({ name: "prepare_reference_motion_template", arguments: { ...sceneInput("kinetic_network"), projectPath: join(evidence, "control_network.editkin.json") } });
  if (networkPrepared.isError || sha(networkBefore) !== sha(await readFile(join(evidence, "control_network.editkin.json")))) throw new Error("MCP connection scene prepare failed or mutated the project");
  mcp = { discoveryPass: true, catalog, prepared, networkPrepared, projectUnchanged: true, installedGeneration: false };
} finally { await client.close(); }
await writeFile(join(evidence, "mcp-source-journey.json"), JSON.stringify(mcp, null, 2));
const files = REFERENCE_MOTION_TEMPLATES.map(t => `file '${join(evidence, `${t.id}.mp4`).replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n");
await writeFile(join(evidence, "preview-concat.txt"), files);
await run(ffmpeg, ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", join(evidence, "preview-concat.txt"), "-c", "copy", "-movflags", "+faststart", join(evidence, "motion-templates-preview.mp4")], { windowsHide: true });
await writeFile(join(evidence, "render-report.json"), JSON.stringify({ schema: "editkin.reference-motion-template-render/v1", status: "SOURCE_RENDER_PASS_ART_REVIEW_PENDING",
  sourceOnly: true, installedGeneration: false, templates: REFERENCE_MOTION_TEMPLATES.length, outputs, originalAudioUnchanged: true,
  boundaries: ["source MCP only; installed runtime unchanged", "flat focus wall is not a 3D sphere", "owned SDR derivatives used; camera HLG originals unchanged", "demonstration copy is not a user film script"], verifiedAt: new Date().toISOString() }, null, 2));
