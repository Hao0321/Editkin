import { findClip } from "../domain/editGraph";
import { applyCommand } from "../domain/commands";
import type { EditorCommand } from "../domain/commandTypes";
import type { DirectorMarker, EditProject } from "../domain/types";
import { encodeProjectBytes } from "./projectCodec";
import { beatMarkerJobSourceV1, BEAT_MARKER_BATCH_LIMIT_V1, type BeatMarkerJobV1, type BeatMarkerOptionsV1, type BeatMarkerSourceV1 } from "./beatMarkersV1";
import { musicBeatsRequestSchemaV1, validateMusicBeatsReceiptV1, type MusicBeatsRequestV1 } from "./musicBeatsTypesV1";
import { musicRhythmEventsInWindowV2, type MusicRhythmEventV2 } from "./musicRhythmV2";

export interface RefinedBeatMarkerLabelsV2 {
  observedPulse: string; observedBar: string; inferredPulse: string; inferredBar: string;
  observedNote: string; inferredNote: string; confidence: string; sourceTime: string;
}
export interface RefinedBeatMarkerOptionsV2 {
  mode?: "bars" | "all"; timelineRange?: { start: number; end: number };
  idPrefix: string; createdAt: string; labels: RefinedBeatMarkerLabelsV2; signal?: AbortSignal;
}
type MarkerKindV2 = "observedPulse" | "observedBar" | "inferredPulse" | "inferredBar";
interface MarkerSourceV2 extends MusicRhythmEventV2 { kind: MarkerKindV2 }
interface MarkerEventV2 {
  frame: number; time: number; sourceSeconds: number; kind: MarkerKindV2; confidence: number;
  inferred: boolean; quantizationErrorFrames: number; sources: MarkerSourceV2[];
}
const plans = new WeakMap<object, { job: BeatMarkerJobV1; options: RefinedBeatMarkerOptionsV2; command?: EditorCommand }>();
const labelKeys = ["observedPulse", "observedBar", "inferredPulse", "inferredBar", "observedNote", "inferredNote", "confidence", "sourceTime"] as const;
function snapshotOptions(options: RefinedBeatMarkerOptionsV2): RefinedBeatMarkerOptionsV2 {
  if (!["bars", "all"].includes(options.mode ?? "bars") || !options.labels || Object.keys(options.labels).length !== labelKeys.length
    || labelKeys.some(key => typeof options.labels[key] !== "string" || !options.labels[key].trim() || options.labels[key].length > 2048)) throw Error("REFINED_BEAT_MARKER_LABELS_OR_MODE_REQUIRED");
  if (new Set([options.labels.observedPulse, options.labels.observedBar, options.labels.inferredPulse, options.labels.inferredBar].map(s => s.trim())).size !== 4
    || options.labels.observedNote.trim() === options.labels.inferredNote.trim()) throw Error("REFINED_BEAT_MARKER_DISTINCT_INFERENCE_LABELS_REQUIRED");
  return Object.freeze({ ...options, labels: Object.freeze({ ...options.labels }),
    ...(options.timelineRange ? { timelineRange: Object.freeze({ ...options.timelineRange }) } : {}) });
}
function baseOptions(options: RefinedBeatMarkerOptionsV2): BeatMarkerOptionsV1 {
  return { ...options, mode: options.mode === "all" ? "all" : "downbeats",
    labels: { beat: options.labels.observedPulse, downbeat: options.labels.observedBar, candidateNote: options.labels.observedNote } };
}
/** Shares the existing live selection guard; a Node host must not deserialize live jobs. */
export function refinedBeatMarkerJobSourceV2(project: EditProject, job: BeatMarkerJobV1, requested: RefinedBeatMarkerOptionsV2) {
  const options = snapshotOptions(requested); options.signal?.throwIfAborted();
  return beatMarkerJobSourceV1(project, job, baseOptions(options));
}
const priority: Record<MarkerKindV2, number> = { observedBar: 4, inferredBar: 3, observedPulse: 2, inferredPulse: 1 };
function markerEvents(project: EditProject, clipId: string, options: RefinedBeatMarkerOptionsV2, window: Pick<ReturnType<typeof musicRhythmEventsInWindowV2>, "pulses" | "bars">) {
  const clip = findClip(project, clipId), range = options.timelineRange ?? { start: clip.timelineStart, end: clip.timelineStart + clip.duration };
  const existing = new Set(project.director.markers.filter(m => m.kind === "beat").map(m => Math.round(m.time * project.fps)));
  const groups = new Map<number, MarkerEventV2>(); let boundaryEvents = 0, alreadyMarkedEvents = 0, mergedEvents = 0;
  const sources: MarkerSourceV2[] = [...window.pulses.map(p => ({ ...p, kind: p.inferred ? "inferredPulse" as const : "observedPulse" as const })),
    ...window.bars.map(b => ({ ...b, kind: b.inferred ? "inferredBar" as const : "observedBar" as const }))];
  for (const source of sources) {
    const exact = clip.timelineStart + (source.timeSeconds - clip.sourceStart), frame = Math.round(exact * project.fps), time = frame / project.fps;
    if (time < range.start || time >= range.end) { boundaryEvents++; continue; }
    if (existing.has(frame)) { alreadyMarkedEvents++; continue; }
    const current = groups.get(frame), next: MarkerEventV2 = { frame, time, sourceSeconds: source.timeSeconds, kind: source.kind,
      confidence: source.confidence, inferred: source.inferred, quantizationErrorFrames: frame - exact * project.fps, sources: [source] };
    if (current) {
      mergedEvents++; const all = [...current.sources, source];
      if (priority[next.kind] > priority[current.kind] || next.kind === current.kind && next.confidence > current.confidence) groups.set(frame, { ...next, sources: all });
      else current.sources = all;
    } else groups.set(frame, next);
    if (groups.size > BEAT_MARKER_BATCH_LIMIT_V1) throw Error("REFINED_BEAT_MARKER_BATCH_LIMIT");
  }
  return { events: [...groups.values()].sort((a, b) => a.frame - b.frame), range, stats: { expandedEvents: sources.length, mergedEvents, boundaryEvents, alreadyMarkedEvents } };
}
function markerCommand(project: EditProject, events: MarkerEventV2[], options: RefinedBeatMarkerOptionsV2) {
  const ids = new Set(project.director.markers.map(m => m.id));
  const commands: EditorCommand[] = events.map(event => {
    const id = `${options.idPrefix}-${event.frame}`; if (ids.has(id)) throw Error("REFINED_BEAT_MARKER_ID_COLLISION"); ids.add(id);
    const labels = options.labels, note = `${event.inferred ? labels.inferredNote : labels.observedNote} · ${labels.sourceTime} ${event.sourceSeconds.toFixed(3)}s · ${labels.confidence} ${(event.confidence * 100).toFixed(1)}%`;
    const marker: DirectorMarker = Object.freeze({ id, time: event.time, title: labels[event.kind], note, kind: "beat", status: "open", createdAt: options.createdAt });
    return Object.freeze({ type: "add_director_marker" as const, marker });
  });
  if (!commands.length) return { command: undefined, projectedBytes: undefined };
  const command = Object.freeze({ type: "batch" as const, commands: Object.freeze(commands) }) as unknown as EditorCommand;
  // Scratch dispatch/real codec preflight: actual history mutation still happens only once in the host.
  const projectedBytes = encodeProjectBytes(applyCommand(project, command)).byteLength;
  return { command, projectedBytes };
}
/** Explicit v2 only. Native observations remain immutable; guessed bar positions keep their inference label. */
export function prepareRefinedBeatMarkersV2(project: EditProject, job: BeatMarkerJobV1, input: {
  request: MusicBeatsRequestV1; source: BeatMarkerSourceV1; receipt: unknown;
}, requestedOptions: RefinedBeatMarkerOptionsV2) {
  const options = snapshotOptions(requestedOptions), selected = refinedBeatMarkerJobSourceV2(project, job, options);
  if (input.source.assetId !== selected.assetId || input.source.assetUri !== selected.assetUri) throw Error("REFINED_BEAT_MARKER_SOURCE_MISMATCH");
  const request = musicBeatsRequestSchemaV1.parse(input.request); if (!request.rhythmRefinementV2) throw Error("REFINED_BEAT_MARKER_EXPLICIT_V2_REQUIRED");
  const receipt = validateMusicBeatsReceiptV1(input.receipt, request, input.source), end = selected.sourceStartSeconds + selected.durationSeconds;
  if (request.sourceStartSeconds > selected.sourceStartSeconds || request.sourceStartSeconds + request.durationSeconds < end) throw Error("REFINED_BEAT_MARKER_ANALYSIS_WINDOW_INCOMPLETE");
  const readStart = Math.max(selected.sourceStartSeconds, receipt.analysis.sourceStartSeconds), readEnd = Math.min(end, receipt.analysis.sourceStartSeconds + receipt.analysis.durationSeconds);
  const window = readStart < readEnd ? musicRhythmEventsInWindowV2(receipt.analysis, { sourceStartSeconds: readStart, sourceEndSeconds: readEnd,
    priorBpm: request.priorBpm, include: options.mode === "all" ? "both" : "bars" }) : { pulses: [], bars: [] };
  const selectedEvents = markerEvents(project, job.clipId, options, window), { command, projectedBytes } = markerCommand(project, selectedEvents.events, options);
  refinedBeatMarkerJobSourceV2(project, job, options);
  const plan = Object.freeze({ schema: "editkin.refined-beat-marker-plan/v2" as const, state: command ? "ready" as const : "empty" as const,
    markerCount: selectedEvents.events.length, command, projectedBytes, mode: options.mode ?? "bars", range: Object.freeze({ ...selectedEvents.range }),
    events: Object.freeze(selectedEvents.events.map(e => Object.freeze({ ...e, sources: Object.freeze(e.sources.map(s => Object.freeze(s))) }))), stats: Object.freeze(selectedEvents.stats),
    readWindow: Object.freeze({ requestedStart: selected.sourceStartSeconds, requestedEnd: end, readStart, readEnd }),
    sourceSha256: receipt.sourceSha256, pcmSha256: receipt.pcmSha256, tempo: Object.freeze({ ...receipt.analysis.rhythmV2!.tempo }),
    inferredBars: selectedEvents.events.filter(e => e.kind === "inferredBar").length, inferredPulses: selectedEvents.events.filter(e => e.kind === "inferredPulse").length,
    realMusicQualityCertified: false as const, ordinaryEditorIntegrated: false as const, vaDefaultEligible: false as const });
  plans.set(plan, { job, options, command }); return plan;
}
export function refinedBeatMarkerCommandForProjectV2(project: EditProject, plan: object): EditorCommand | undefined {
  const saved = plans.get(plan); if (!saved) throw Error("REFINED_BEAT_MARKER_PLAN_FOREIGN");
  refinedBeatMarkerJobSourceV2(project, saved.job, saved.options);
  return saved.command ? structuredClone(saved.command) : undefined;
}
