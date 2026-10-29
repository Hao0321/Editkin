import type { EditorCommand } from "../domain/commandTypes";
import type { EditProject } from "../domain/types";
import type { ProjectSession } from "./projectSession";
import { parseRotoV2Request, type AnalyzeProductAutoRotoRequestV2, type RotoV2Settings } from "./autoRotoV2Contract";
import type { RotoCutoutClipResultV1 } from "./rotoCutoutClipV1";
import { assertRotoCutoutSourceV1, planRotoCutoutProjectV1, rotoCutoutLocalSourcePathV1 } from "./rotoCutoutProjectV1";

type Ids = Parameters<typeof planRotoCutoutProjectV1>[3];
export interface RotoCutoutActionOptionsV1 {
  projectSession: ProjectSession; project: EditProject; clipId: string; maskId: string; playhead: number;
  settings: RotoV2Settings; maxDimension: number; ids: Ids; signal?: AbortSignal; seedRect?: AnalyzeProductAutoRotoRequestV2["initialRect"];
  execute?: (request: AnalyzeProductAutoRotoRequestV2, signal?: AbortSignal) => Promise<RotoCutoutClipResultV1>;
  busy: { current: boolean }; onBusy: (value: boolean) => void; onPlaying: (value: boolean) => void;
  onCommand: (command: EditorCommand) => void;
}
export type RotoCutoutActionOutcomeV1 = { status: "applied"; result: RotoCutoutClipResultV1 }
  | { status: "busy" | "stale" | "unavailable" | "cancelled" } | { status: "failed"; error: Error };

export function mapRotoCorrectionClockV1(strokes: AnalyzeProductAutoRotoRequestV2["corrections"], oldFps: number | undefined, fps: number, duration: number) {
  if (strokes.length && (!oldFps || !Number.isFinite(oldFps) || oldFps <= 0)) throw Error("ROTO_CUTOUT_CORRECTION_CLOCK_REQUIRED");
  const count = Math.floor(duration * fps + 1e-8);
  return strokes.map(s => {
    const time = s.frame / oldFps!;
    if (!Number.isFinite(time) || time < 0 || time >= duration || count < 1) throw Error("ROTO_CUTOUT_CORRECTION_TIME_OUTSIDE");
    return { ...structuredClone(s), frame: Math.min(count - 1, Math.round(time * fps)) };
  });
}

/** No user-facing copy here: the owning UI maps outcome/error codes through its locale pack.
 * An analysis result never sets subject trust; that remains an explicit later review action. */
export async function runRotoCutoutActionV1(o: RotoCutoutActionOptionsV1): Promise<RotoCutoutActionOutcomeV1> {
  if (o.busy.current) return { status: "busy" };
  const task = o.projectSession.beginTask(o.project); if (!task.isCurrent()) return { status: "stale" };
  if (!o.execute) return { status: "unavailable" };
  o.busy.current = true;
  try {
    o.signal?.throwIfAborted(); const { source, sourceClip } = assertRotoCutoutSourceV1(o.project, o.clipId);
    const mask = sourceClip.masks?.find(m => m.id === o.maskId && m.kind === "subject");
    if (!mask || mask.matteSequence?.staleReason === "clip-time-range-changed") throw Error("ROTO_CUTOUT_SUBJECT_MASK_OR_TIME_BINDING_REQUIRED");
    const xs = mask.path.map(p => p.x), ys = mask.path.map(p => p.y);
    if (!o.seedRect && (mask.trackId || mask.keyframes.length)) throw Error("ROTO_CUTOUT_EXPLICIT_CURRENT_SEED_REQUIRED");
    const corrections = mapRotoCorrectionClockV1(mask.rotoCorrections ?? [], mask.matteSequence?.analysisFps, o.project.fps, sourceClip.duration);
    const request = parseRotoV2Request({ sourcePath: rotoCutoutLocalSourcePathV1(source.uri), sourceStart: sourceClip.sourceStart, duration: sourceClip.duration,
      fps: o.project.fps, initialTime: Math.max(0, Math.min(sourceClip.duration, o.playhead - sourceClip.timelineStart)),
      initialRect: o.seedRect ?? { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) },
      sourceColor: "rec709-rgb8", maxDimension: o.maxDimension, edgeSettings: o.settings, sourceSha256: source.derivatives?.sourceSha256, corrections });
    o.onPlaying(false); o.onBusy(true); const result = await o.execute(request, o.signal);
    o.signal?.throwIfAborted(); if (!task.isCurrent()) return { status: "stale" };
    const { command } = planRotoCutoutProjectV1(o.projectSession.getSnapshot().history.present, o.clipId, result, o.ids);
    o.onCommand(command); return { status: "applied", result };
  } catch (e) {
    if (o.signal?.aborted) return { status: "cancelled" }; if (!task.isCurrent()) return { status: "stale" };
    return { status: "failed", error: e instanceof Error ? e : Error(String(e)) };
  } finally { o.busy.current = false; o.onBusy(false); }
}
