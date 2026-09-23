import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { resolveCreativeLibraryAsset } from "../src/application/creativeLibrary";
import { parseSkillEditorialBatchPlan, type SkillEditorialBatchPlan } from "../src/application/skillEditorialBatch";
import { probeMedia } from "../src/render/ffmpeg";
import { resolveCoreEditorialSfx } from "../src/application/coreSfx";

interface BattleTarget {
  id: string;
  start: number;
  launch: number;
  end: number;
  resultStart: number;
  resultEnd: number;
}

interface DeliverableTarget {
  id: string;
  title: string;
  payoff: string;
  battleIds: string[];
  legacyReceiptRoot?: string;
}

interface BattleReelsTarget {
  schema: "hao.editkin.battle-reels-target/v1";
  batchId: string;
  battles: BattleTarget[];
  deliverables: DeliverableTarget[];
}

interface LegacyFingerprint {
  payload: { segment_sequence: Array<{ in: number; duration: number }> };
}

interface LegacyTracking {
  tracked_labels?: Array<{
    id: string;
    text: string;
    start: number;
    end: number;
    pointer_color?: [number, number, number];
    keyframes: Array<{ time: number; bbox: [number, number, number, number] }>;
  }>;
}

function value(name: string): string {
  const index = process.argv.indexOf(name);
  const result = index >= 0 ? process.argv[index + 1] : undefined;
  if (!result) throw new Error(`缺少 ${name}`);
  return resolve(result);
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function safeId(input: string): string {
  const id = input.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 72);
  if (!id) throw new Error(`ID 不合法：${input}`);
  return id;
}

function splitBattle(battle: BattleTarget): Array<{ sourceStart: number; duration: number }> {
  const launchStart = Math.max(battle.start + 0.5, battle.launch - 0.45);
  const actionStart = Math.min(battle.end - 0.5, battle.launch + 2.6);
  const boundaries = [battle.start, launchStart, actionStart, battle.end];
  return boundaries.slice(0, -1).map((start, index) => ({ sourceStart: start, duration: boundaries[index + 1] - start }));
}

function sourceToTimeline(segments: Array<{ sourceStart: number; duration: number }>, sourceTime: number): number | undefined {
  let timeline = 0;
  for (const segment of segments) {
    if (sourceTime >= segment.sourceStart - 1 / 60 && sourceTime <= segment.sourceStart + segment.duration + 1 / 60) {
      return timeline + Math.max(0, Math.min(segment.duration, sourceTime - segment.sourceStart));
    }
    timeline += segment.duration;
  }
  return undefined;
}

function legacyTimelineToSource(segments: Array<{ in: number; duration: number }>, timelineTime: number): number | undefined {
  let cursor = 0;
  for (const segment of segments) {
    if (timelineTime >= cursor - 1 / 60 && timelineTime <= cursor + segment.duration + 1 / 60) {
      return segment.in + Math.max(0, Math.min(segment.duration, timelineTime - cursor));
    }
    cursor += segment.duration;
  }
  return undefined;
}

function rgb(color?: [number, number, number]): string {
  if (!color) return "#FFD84D";
  return `#${color.map((channel) => Math.round(Math.max(0, Math.min(255, channel))).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

async function trackedLabels(target: DeliverableTarget, segments: Array<{ sourceStart: number; duration: number }>, id: string) {
  if (!target.legacyReceiptRoot) return [];
  const root = resolve(target.legacyReceiptRoot);
  const fingerprint = JSON.parse(await readFile(resolve(root, "current_editorial_fingerprint.json"), "utf8")) as LegacyFingerprint;
  const tracking = JSON.parse(await readFile(resolve(root, "current_tracked_graphics_spec.json"), "utf8")) as LegacyTracking;
  const segmentWindows = segments.map((segment, index) => ({
    index,
    start: segments.slice(0, index).reduce((sum, item) => sum + item.duration, 0),
    end: segments.slice(0, index + 1).reduce((sum, item) => sum + item.duration, 0),
  }));
  return (tracking.tracked_labels ?? []).flatMap((label, labelIndex) => {
    const mapped = label.keyframes.flatMap((point) => {
      const sourceTime = legacyTimelineToSource(fingerprint.payload.segment_sequence, point.time);
      const time = sourceTime === undefined ? undefined : sourceToTimeline(segments, sourceTime);
      return time === undefined ? [] : [{
        time,
        rect: {
          x: Math.max(0, Math.min(1, point.bbox[0] / 1080)),
          y: Math.max(0, Math.min(1, point.bbox[1] / 1920)),
          width: Math.max(0, Math.min(1, point.bbox[2] / 1080)),
          height: Math.max(0, Math.min(1, point.bbox[3] / 1920)),
        },
        confidence: 0.9,
      }];
    });
    // A native MotionTrack belongs to exactly one timeline clip. Legacy Skill
    // receipts may span several clips, so split them instead of silently
    // attaching unrelated points to the first clip or inventing fake tracking.
    return segmentWindows.flatMap((window) => {
      const points = mapped.filter((point) => point.time >= window.start - 1 / 30 && point.time <= window.end + 1 / 30);
      if (points.length < 2) return [];
      return [{
        id: `${id}-track-${labelIndex + 1}-clip-${window.index + 1}`,
        text: label.text,
        start: Math.min(...points.map((point) => point.time)),
        end: Math.max(...points.map((point) => point.time)),
        accentColor: rgb(label.pointer_color),
        points,
      }];
    });
  });
}

async function main() {
  const sourcePath = value("--source");
  const targetPath = value("--target");
  const outputPath = value("--output");
  const musicRoot = value("--music-root");
  const musicIdIndex = process.argv.indexOf("--music-id");
  const musicId = musicIdIndex >= 0 ? process.argv[musicIdIndex + 1] : "music:00023fd57a4e6b788434";
  const ffprobeIndex = process.argv.indexOf("--ffprobe");
  const ffprobePath = ffprobeIndex >= 0 ? resolve(process.argv[ffprobeIndex + 1]) : "ffprobe";
  const target = JSON.parse(await readFile(targetPath, "utf8")) as BattleReelsTarget;
  if (target.schema !== "hao.editkin.battle-reels-target/v1") throw new Error("battle reels target schema 不支援");
  const battleById = new Map(target.battles.map((battle) => [battle.id, battle]));
  const source = await probeMedia(sourcePath, ffprobePath);
  if (!source.hasVideo || !source.width || !source.height) throw new Error("來源影片無法解碼");
  const music = await resolveCreativeLibraryAsset(process.cwd(), musicId, musicRoot);
  const soundEffects = await resolveCoreEditorialSfx(resolve(process.cwd(), ".creative-packs/hao-creator-library"), ffprobePath);
  if (!music.asset.duration || !music.asset.bpm || music.asset.redistributable !== true) throw new Error("配樂不完整或不可散布");
  const targetSha256 = await sha256(targetPath);
  const editorialFingerprintSha256 = createHash("sha256").update(JSON.stringify({ targetSha256, recipe: "editkin-battle-reels-v4", audio: "music+sfx-v1", tracking: "per-clip-honest-v1", color: "aces2-rec709" })).digest("hex");
  const deliverables: SkillEditorialBatchPlan["deliverables"] = [];
  for (const [index, targetDeliverable] of target.deliverables.entries()) {
    const id = safeId(targetDeliverable.id);
    const battles = targetDeliverable.battleIds.map((battleId) => {
      const battle = battleById.get(battleId);
      if (!battle) throw new Error(`${id} 引用不存在的 battle：${battleId}`);
      return battle;
    });
    const segments = battles.flatMap(splitBattle);
    const duration = segments.reduce((sum, segment) => sum + segment.duration, 0);
    const textEvents: SkillEditorialBatchPlan["deliverables"][number]["textEvents"] = [
      { id: `${id}-hook`, start: 0.1, end: Math.min(2.6, duration), text: targetDeliverable.title, role: "hook" },
    ];
    for (const [battleIndex, battle] of battles.entries()) {
      const battleStart = sourceToTimeline(segments, battle.start)!;
      const launch = sourceToTimeline(segments, battle.launch)!;
      const actionEnd = sourceToTimeline(segments, battle.end)!;
      if (battles.length > 1) textEvents.push({ id: `${id}-round-${battleIndex + 1}`, start: Math.max(2.7, battleStart + 0.1), end: Math.min(actionEnd, Math.max(3.8, battleStart + 1.35)), text: `ROUND ${battleIndex + 1}`, role: "round" });
      textEvents.push({ id: `${id}-launch-${battleIndex + 1}`, start: Math.max(0, launch - 0.1), end: Math.min(actionEnd, launch + 1.15), text: "3・2・1 Go Shoot！", role: "launch" });
      const fightDuration = battle.end - battle.launch;
      if (fightDuration >= 18) {
        const status = sourceToTimeline(segments, battle.launch + fightDuration * 0.58)!;
        textEvents.push({ id: `${id}-status-${battleIndex + 1}`, start: status, end: Math.min(actionEnd, status + 1.8), text: "耐力還沒分出來", role: "status" });
      }
    }
    const finalBattle = battles.at(-1)!;
    const payoffStart = sourceToTimeline(segments, finalBattle.resultStart) ?? Math.max(duration * 0.75, duration - 3);
    textEvents.push({ id: `${id}-payoff`, start: payoffStart, end: Math.min(duration, Math.max(payoffStart + 1.4, sourceToTimeline(segments, finalBattle.resultEnd) ?? duration)), text: targetDeliverable.payoff, role: "payoff" });
    deliverables.push({
      id,
      ordinal: index + 1,
      name: `${id} ${targetDeliverable.title}`,
      segments,
      textEvents,
      trackedLabels: await trackedLabels(targetDeliverable, segments, id),
      creative: { lookPresetId: "toy_arena_punch", effectPresetIds: ["scanline_focus"], transitionPresetId: "prism_flash_cut" },
      evidence: {
        editorialFingerprintSha256,
        previousEditorialFingerprintSha256: targetDeliverable.legacyReceiptRoot ? await sha256(resolve(targetDeliverable.legacyReceiptRoot, "current_editorial_fingerprint.json")) : undefined,
        visualPlanSha256: targetSha256,
        trackingSpecSha256: targetDeliverable.legacyReceiptRoot ? await sha256(resolve(targetDeliverable.legacyReceiptRoot, "current_tracked_graphics_spec.json")) : undefined,
      },
    });
  }
  const interpretation = source.colorTransfer === "arib-std-b67" ? "hlg" : source.colorTransfer === "smpte2084" ? "pq" : "rec709";
  const plan = parseSkillEditorialBatchPlan({
    schema: "hao.video-autopilot.editorial-batch/v1",
    batchId: safeId(target.batchId),
    format: "reels",
    expectedDeliverableCount: deliverables.length,
    revisionPolicy: { intent: "recut", baselineRole: "benchmark_only", requireMaterialDecisionChange: true },
    source: { path: sourcePath, sha256: await sha256(sourcePath), duration: source.duration, width: source.width, height: source.height, colorInterpretation: interpretation },
    music: { assetId: music.asset.id, name: music.asset.name, path: music.absolutePath, sha256: music.sha256, duration: music.asset.duration, bpm: music.asset.bpm, license: music.asset.license, provenance: music.asset.provenance, redistributable: true },
    soundEffects,
    policy: { oneEditableProjectPerDeliverable: true, muteOriginalAudio: true, addMusic: true, useAces2: true, requireVisibleTypography: true, preserveMeaningfulWaits: true, allowCompilationFallback: false, allowSourceReuse: false },
    deliverables,
  });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ status: "GREEN", outputPath, deliverables: plan.deliverables.map((item) => ({ id: item.id, duration: item.segments.reduce((sum, segment) => sum + segment.duration, 0), segments: item.segments.length, tracking: item.trackedLabels.length })) })}\n`);
}

await main();
