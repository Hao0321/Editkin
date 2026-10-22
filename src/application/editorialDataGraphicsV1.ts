import * as z from "zod/v4";
import type { EditProject } from "../domain/types";
import type { EditorCommand } from "../domain/commandTypes";
import { applyCommand } from "../domain/commands";
import { dispatchCommandSafely } from "../domain/history";
import { TRACK_LOCKED_MESSAGE } from "../domain/trackLock";
import { canonicalJson } from "../shared/canonicalJson";
import { createProjectSession, type ProjectSession } from "./projectSession";
import { prepareProceduralSfxPlacementV1, applyPreparedProceduralSfxPlacementV1, type PreparedProceduralSfxPlacementV1, type ProceduralSfxPlacementResolverV1 } from "./proceduralSfxPlacementV1";
import type { ProceduralSfxLibraryV1 } from "./proceduralSfxLibraryV1";
import { selectCounterSoundHitsV1 } from "./counterSoundHitSelectionV1";
import type { CounterVisualTickV1 } from "./counterVisualTicksV1";

export const editorialDataSoundV1Schema = z.strictObject({ enabled: z.literal(true), variant: z.number().int().min(1).max(5), gain: z.number().finite().positive().max(1),
  trackId: z.string().min(1).max(160), newTrack: z.strictObject({ name: z.string().trim().min(1).max(120) }).optional() });
export type EditorialDataSoundLibraryV1 = Pick<ProceduralSfxLibraryV1, "list"> & ProceduralSfxPlacementResolverV1;
export interface EditorialDataRuntimeV1 {
  signal?: AbortSignal; timeoutMs?: number; maximumCompiledFrames?: number;
  onProgress?(progress: { graphicId: string; completed: number; total: number }): void;
}
/** Preparation lifetime belongs to this explicit operation, never to a later editor generation. */
export function beginEditorialDataGraphicsV1(session: ProjectSession, expectedRevision: number, runtime: EditorialDataRuntimeV1 = {}) {
  const settings = { ...runtime }, source = session.getSnapshot().history.present, task = session.beginTask(source), fingerprint = canonicalJson(source);
  const timeout = settings.timeoutMs ?? 10000, cap = settings.maximumCompiledFrames ?? 72000;
  if (source.revision !== expectedRevision) throw Error("EDITORIAL_DATA_REVISION_CHANGED");
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 60000 || !Number.isSafeInteger(cap) || cap < 1 || cap > 144000) throw Error("EDITORIAL_DATA_RESOURCE_BUDGET");
  if (!Number.isFinite(source.fps) || source.fps < 1 || source.fps > 240 || ![source.width, source.height].every(n => Number.isSafeInteger(n) && n > 0 && n <= 16384)) throw Error("EDITORIAL_DATA_PROJECT_CLOCK");
  let until = performance.now() + timeout, applySignal: AbortSignal | undefined;
  const current = () => { settings.signal?.throwIfAborted(); applySignal?.throwIfAborted();
    if (!task.isCurrent() || canonicalJson(session.getSnapshot().history.present) !== fingerprint) throw Error("EDITORIAL_DATA_PROJECT_CHANGED"); };
  const remaining = () => { current(); const left = until - performance.now(); if (left <= 0) throw Error("EDITORIAL_DATA_TIMEOUT"); return left; };
  const wait = <T>(operation: () => Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    let done = false; const sources = [...new Set([settings.signal, applySignal].filter((s): s is AbortSignal => !!s))];
    const listeners: { signal: AbortSignal; callback: () => void }[] = [];
    const finish = (action: () => void) => { if (done) return; done = true; clearTimeout(timer); for (const l of listeners) l.signal.removeEventListener("abort", l.callback); action(); };
    const timer = setTimeout(() => finish(() => reject(Error("EDITORIAL_DATA_TIMEOUT"))), remaining());
    for (const signal of sources) { if (done) break; const callback = () => finish(() => reject(signal.reason)); listeners.push({ signal, callback }); signal.addEventListener("abort", callback, { once: true }); if (signal.aborted) callback(); }
    Promise.resolve().then(() => { remaining(); return operation(); }).then(value => finish(() => { try { remaining(); resolve(value); } catch (error) { reject(error); } }), error => finish(() => reject(error)));
  });
  remaining();
  return { session, source, settings, cap, current, remaining, wait, renewForApply(signal?: AbortSignal) { applySignal = signal; until = performance.now() + timeout; remaining(); } };
}
export type EditorialDataContextV1 = ReturnType<typeof beginEditorialDataGraphicsV1>;

export function requireEditorialDataClipV1(context: EditorialDataContextV1, clipId: string) {
  context.remaining(); const matches = context.source.tracks.flatMap(track => track.clips.filter(c => c.id === clipId).map(clip => ({ track, clip })));
  if (matches.length !== 1) throw Error("EDITORIAL_DATA_CLIP_MISSING_OR_AMBIGUOUS");
  const { track, clip } = matches[0], fps = context.source.fps;
  if (track.locked) throw Error(TRACK_LOCKED_MESSAGE);
  if (track.kind !== "video" || track.hidden) throw Error("EDITORIAL_DATA_CLIP_NOT_VISIBLE");
  const start = Math.round(clip.timelineStart * fps), end = Math.round((clip.timelineStart + clip.duration) * fps);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end / fps > 86400
    || Math.abs(start / fps - clip.timelineStart) > 1e-8 || Math.abs(end / fps - clip.timelineStart - clip.duration) > 1e-8) throw Error("EDITORIAL_DATA_CLIP_CLOCK");
  return { track, clip, start, end };
}
export interface PreparedEditorialDataGraphicsV1 {
  schema: "editkin.editorial-data-plan/v1"; family: "value_ladder" | "challenge_progress"; expectedRevision: number;
  descriptor: unknown; hooks: CounterVisualTickV1[];
  sound: ReturnType<typeof selectCounterSoundHitsV1> | null;
  defaultEnabled: false; qualityState: "ART_PENDING_CLAUDE"; audioQualityState: "AUDIO_PENDING_HAO_CLAUDE" | "NOT_REQUESTED";
}
interface OwnedPlan {
  context: EditorialDataContextV1; commands: EditorCommand[]; fingerprint: string;
  audio?: { session: ProjectSession; packet: PreparedProceduralSfxPlacementV1 };
}
const plans = new WeakMap<PreparedEditorialDataGraphicsV1, OwnedPlan>();
/** One private draft; the existing frozen producers and SFX packet own their respective semantics. */
export async function prepareEditorialDataGraphicsV1(context: EditorialDataContextV1, family: PreparedEditorialDataGraphicsV1["family"],
  commands: EditorCommand[], descriptor: unknown, hooks: CounterVisualTickV1[], durationFrames: number, idPrefix: string,
  sound?: z.infer<typeof editorialDataSoundV1Schema>, library?: EditorialDataSoundLibraryV1): Promise<PreparedEditorialDataGraphicsV1> {
  context.remaining();
  if (!Number.isSafeInteger(durationFrames) || durationFrames < 1 || durationFrames / context.source.fps > 86400 || hooks.length > 256) throw Error("EDITORIAL_DATA_CLOCK_OR_HOOK_BUDGET");
  const ownedCommands = structuredClone(commands), draft = applyCommand(structuredClone(context.source), { type: "batch", commands: ownedCommands });
  let selection: PreparedEditorialDataGraphicsV1["sound"] = null, audio: OwnedPlan["audio"];
  if (sound) {
    const settings = editorialDataSoundV1Schema.parse(sound);
    if (!library) throw Error("EDITORIAL_DATA_SOUND_LIBRARY_REQUIRED");
    const host = { list: library.list.bind(library), resolve: library.resolve.bind(library) };
    selection = selectCounterSoundHitsV1(draft.fps, { durationFrames, sound: settings }, hooks);
    if (!selection.selected.length) throw Error("EDITORIAL_DATA_NO_COMPLETE_HITS");
    const page = await context.wait(() => host.list({ kind: "tick", limit: 5 }, context.settings.signal));
    const entry = page.entries.find(e => e.id === selection!.soundId);
    if (!entry || entry.durationSamples !== selection.durationSamples) throw Error("EDITORIAL_DATA_TICK_SOURCE_MISSING");
    const shadow = createProjectSession(draft), resolver: ProceduralSfxPlacementResolverV1 = {
      resolve: (request, signal) => context.wait(() => host.resolve(request, signal)),
    };
    const packet = await context.wait(() => prepareProceduralSfxPlacementV1(shadow, resolver, { trackId: settings.trackId, idPrefix: `${idPrefix}-sfx`,
      ...(settings.newTrack ? { newTrack: settings.newTrack } : {}), hits: selection!.selected.map(h => ({ id: entry.id, sha256: entry.sha256, frame: h.frame, gain: settings.gain })) }, context.settings.signal));
    audio = { session: shadow, packet };
  }
  context.remaining();
  const plan: PreparedEditorialDataGraphicsV1 = { schema: "editkin.editorial-data-plan/v1", family, expectedRevision: context.source.revision,
    descriptor: structuredClone(descriptor), hooks: structuredClone(hooks), sound: structuredClone(selection), defaultEnabled: false,
    qualityState: "ART_PENDING_CLAUDE", audioQualityState: sound ? "AUDIO_PENDING_HAO_CLAUDE" : "NOT_REQUESTED" };
  plans.set(plan, { context, commands: ownedCommands, audio, fingerprint: canonicalJson(plan) }); return plan;
}
/** Recheck files on the private draft, then one synchronous dispatch through existing history.
 * Each attempt consumes the preparation, including failures; reprepare after cancellation/stale data. */
export async function applyPreparedEditorialDataGraphicsV1(session: ProjectSession, plan: PreparedEditorialDataGraphicsV1, signal?: AbortSignal) {
  const owned = plans.get(plan);
  if (!owned || owned.context.session !== session || owned.fingerprint !== canonicalJson(plan)) throw Error("EDITORIAL_DATA_PACKET_INVALID");
  plans.delete(plan); const { context, commands, audio } = owned;
  context.renewForApply(signal);
  if (audio) await context.wait(() => applyPreparedProceduralSfxPlacementV1(audio.session, audio.packet, signal));
  context.remaining();
  const audioCommands = audio?.packet.command;
  if (audioCommands && audioCommands.type !== "batch") throw Error("EDITORIAL_DATA_AUDIO_BATCH_REQUIRED");
  const command: EditorCommand = { type: "batch", commands: structuredClone([...commands, ...(audioCommands?.type === "batch" ? audioCommands.commands : [])]) };
  const result = dispatchCommandSafely(session.getSnapshot().history, command);
  if (result.error) throw Error(result.error);
  context.remaining(); session.setHistory(result.state);
  return { undoSteps: 1 as const, family: plan.family, insertedHits: plan.sound?.selected.length ?? 0,
    qualityState: plan.qualityState, audioQualityState: plan.audioQualityState, defaultEnabled: false as const };
}
