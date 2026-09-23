import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { probeMedia } from "../src/render/ffmpeg";
import { resolveCreativeLibraryAsset } from "../src/application/creativeLibrary";
import { parseSkillEditorialBatchPlan, type SkillEditorialBatchPlan } from "../src/application/skillEditorialBatch";
import { resolveCoreEditorialSfx } from "../src/application/coreSfx";

interface FingerprintReceipt {
  schema: "hao.editorial-recut-receipt/v1";
  current_sha256: string;
  payload: {
    schema: "hao.editorial-fingerprint/v1";
    segment_sequence: Array<{ source: string; in: number; duration: number }>;
    captions: Array<{ segment: number; kind: string; text: string }>;
    opening?: { place?: string; what?: string };
  };
}

interface VisualPlan {
  duration: number;
  caption_system?: {
    events?: Array<{ start: number; end: number; text: string; source_kind?: string }>;
  };
}

interface TrackingSpec {
  tracked_labels?: Array<{
    id: string;
    text: string;
    start: number;
    end: number;
    profile?: string;
    pointer_color?: [number, number, number];
    track_quality_status?: string;
    keyframes: Array<{ time: number; bbox: [number, number, number, number] }>;
  }>;
}

function argumentsMap(argv: string[]) {
  const values = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error(`未知參數：${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${key} 缺少值`);
    values.set(key, [...(values.get(key) ?? []), value]);
    index += 1;
  }
  return values;
}

function required(values: Map<string, string[]>, key: string): string {
  const value = values.get(key)?.at(-1);
  if (!value) throw new Error(`缺少 ${key}`);
  return resolve(value);
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function safeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 72) || "short";
}

function hex(color?: [number, number, number], fallback = "#FFD84D"): string {
  if (!color) return fallback;
  return `#${color.map((channel) => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

function textRole(event: { text: string; source_kind?: string }, index: number, total: number, start: number, duration: number) {
  if (index === 0 || event.source_kind === "hook") return "hook" as const;
  if (/go\s*shoot|3\s*[・·.、]\s*2\s*[・·.、]\s*1/i.test(event.text)) return "launch" as const;
  if (/第\s*[一二三四五六七八九十\d]+\s*(?:局|輪)|round\s*\d+/i.test(event.text)) return "round" as const;
  if (index === total - 1 && start >= duration * 0.55) return "payoff" as const;
  return "status" as const;
}

async function json<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function main() {
  const args = argumentsMap(process.argv.slice(2));
  const sourcePath = required(args, "--source");
  const outputPath = required(args, "--output");
  const personalMusicRoot = required(args, "--music-root");
  const roots = (args.get("--root") ?? []).map((root) => resolve(root));
  if (!roots.length) throw new Error("至少要提供一個 --root");
  const batchId = safeId(args.get("--batch-id")?.at(-1) ?? `skill-batch-${Date.now()}`);
  const musicId = args.get("--music-id")?.at(-1) ?? "music:00023fd57a4e6b788434";
  const ffprobePath = args.get("--ffprobe")?.at(-1) ?? "ffprobe";
  const sourceProbe = await probeMedia(sourcePath, ffprobePath);
  if (!sourceProbe.hasVideo || !sourceProbe.width || !sourceProbe.height) throw new Error("來源不是可解碼影片");
  const music = await resolveCreativeLibraryAsset(process.cwd(), musicId, personalMusicRoot);
  if (!music.asset.duration || !music.asset.bpm || music.asset.redistributable !== true) throw new Error("配樂 metadata 不完整或不可散布");

  const deliverables: SkillEditorialBatchPlan["deliverables"] = [];
  for (const [index, root] of roots.entries()) {
    const fingerprintPath = resolve(root, "current_editorial_fingerprint.json");
    const visualPath = resolve(root, "current_visual_plan.json");
    const trackingPath = resolve(root, "current_tracked_graphics_spec.json");
    const fingerprint = await json<FingerprintReceipt>(fingerprintPath);
    const visual = await json<VisualPlan>(visualPath);
    let tracking: TrackingSpec = {};
    try { tracking = await json<TrackingSpec>(trackingPath); } catch { /* tracking is optional */ }
    if (fingerprint.schema !== "hao.editorial-recut-receipt/v1" || fingerprint.payload.schema !== "hao.editorial-fingerprint/v1") {
      throw new Error(`${root} 不是支援的 video-autopilot editorial receipt`);
    }
    const duration = fingerprint.payload.segment_sequence.reduce((sum, segment) => sum + segment.duration, 0);
    const captionEvents = visual.caption_system?.events?.length
      ? visual.caption_system.events
      : fingerprint.payload.captions.map((caption) => {
        const start = fingerprint.payload.segment_sequence.slice(0, caption.segment).reduce((sum, segment) => sum + segment.duration, 0);
        return { start, end: Math.min(duration, start + 1.8), text: caption.text, source_kind: caption.kind };
      });
    const unitName = basename(dirname(root));
    const id = safeId(unitName);
    deliverables.push({
      id,
      ordinal: index + 1,
      name: `${unitName} ${fingerprint.payload.opening?.place ?? fingerprint.payload.opening?.what ?? "自動剪輯"}`,
      segments: fingerprint.payload.segment_sequence.map((segment) => ({ sourceStart: segment.in, duration: segment.duration })),
      textEvents: captionEvents.map((event, eventIndex) => ({
        id: `${id}-text-${eventIndex + 1}`,
        start: event.start,
        end: Math.min(duration, event.end),
        text: event.text,
        role: textRole(event, eventIndex, captionEvents.length, event.start, duration),
      })),
      trackedLabels: (tracking.tracked_labels ?? [])
        .filter((label) => label.track_quality_status === undefined || label.track_quality_status === "GREEN")
        .map((label, labelIndex) => ({
          id: `${id}-track-${labelIndex + 1}`,
          text: label.text,
          start: label.start,
          end: label.end,
          accentColor: hex(label.pointer_color, label.profile?.includes("cyan") ? "#42D7FF" : "#FFD84D"),
          points: label.keyframes.map((point) => ({
            time: Math.max(label.start, Math.min(label.end, point.time)),
            rect: {
              x: Math.max(0, Math.min(1, point.bbox[0] / 1080)),
              y: Math.max(0, Math.min(1, point.bbox[1] / 1920)),
              width: Math.max(0, Math.min(1, point.bbox[2] / 1080)),
              height: Math.max(0, Math.min(1, point.bbox[3] / 1920)),
            },
            confidence: 0.92,
          })),
        })),
      creative: { lookPresetId: "toy_arena_punch", effectPresetIds: ["scanline_focus"], transitionPresetId: "prism_flash_cut" },
      evidence: {
        editorialFingerprintSha256: await sha256File(fingerprintPath),
        visualPlanSha256: await sha256File(visualPath),
        trackingSpecSha256: tracking.tracked_labels ? await sha256File(trackingPath) : undefined,
      },
    });
  }

  const interpretation = sourceProbe.colorTransfer === "arib-std-b67" ? "hlg"
    : sourceProbe.colorTransfer === "smpte2084" ? "pq" : "rec709";
  const plan = parseSkillEditorialBatchPlan({
    schema: "hao.video-autopilot.editorial-batch/v1",
    batchId,
    format: "shorts",
    expectedDeliverableCount: deliverables.length,
    revisionPolicy: { intent: "migration", baselineRole: "benchmark_only", requireMaterialDecisionChange: false },
    source: { path: sourcePath, sha256: await sha256File(sourcePath), duration: sourceProbe.duration, width: sourceProbe.width, height: sourceProbe.height, colorInterpretation: interpretation },
    music: { assetId: music.asset.id, name: music.asset.name, path: music.absolutePath, sha256: music.sha256, duration: music.asset.duration, bpm: music.asset.bpm, license: music.asset.license, provenance: music.asset.provenance, redistributable: true },
    soundEffects: await resolveCoreEditorialSfx(resolve(process.cwd(), ".creative-packs/hao-creator-library"), ffprobePath),
    policy: { oneEditableProjectPerDeliverable: true, muteOriginalAudio: true, addMusic: true, useAces2: true, requireVisibleTypography: true, preserveMeaningfulWaits: true, allowCompilationFallback: false, allowSourceReuse: false },
    deliverables,
  });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ status: "GREEN", outputPath, expectedDeliverableCount: plan.expectedDeliverableCount, music: plan.music.name })}\n`);
}

await main();
