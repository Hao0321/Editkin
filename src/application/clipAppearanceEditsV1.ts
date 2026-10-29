import type { EditorCommand } from "../domain/commandTypes";
import type { ColorAdjustments, EditProject, TimelineClip, Transform2D, Transform3D } from "../domain/types";
import { DEFAULT_TRANSFORM_3D } from "../domain/types";
import type { ProjectSessionSnapshot } from "./projectSession";
import type { GraphicEditingSelectionSnapshotV1 } from "./graphicEditingSelectionV1";
import { alignTime, animatedClipState, findClip } from "../domain/editGraph";
import { editorCommandSchema } from "../domain/schema";
import { assertClipVolume } from "../domain/audioGain";

export const CLIP_APPEARANCE_STALE_V1 = "此圖層或選取內容已變更，請重新選取後再修改。";
export const CLIP_APPEARANCE_INVALID_V1 = "無法更新片段設定。";
export const CLIP_APPEARANCE_EXPRESSION_V1 = "此屬性由表達式控制，請先停用表達式再修改。";
export interface ClipAppearanceTransportV1 { playhead: number; seekRevision: number }
interface Host {
  getSnapshot: () => ProjectSessionSnapshot;
  getSelectionSnapshot: () => GraphicEditingSelectionSnapshotV1;
  /** Latest rendered transport, not another clock or an immediate queued-seek acknowledgement. */
  getTransport: () => ClipAppearanceTransportV1;
  runCommand: (command: EditorCommand, message?: string) => boolean | void;
  setStatus: (message: string) => void;
  makeId: (prefix: string) => string;
}
interface View {
  project: EditProject; clipId?: string; selection: GraphicEditingSelectionSnapshotV1;
  transport: ClipAppearanceTransportV1;
}
export interface ClipAppearancePlanV1 { command?: EditorCommand }
export interface Transform3dAxisIntentV1 { property: keyof Transform3D; index: 0 | 1 | 2 }
type Property = "transform" | "color";
type Values = Record<string, number | boolean | undefined>;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function replacesClip(command: EditorCommand, id: string): boolean {
  if (command.type === "batch") return command.commands.some(item => replacesClip(item, id));
  if (command.type === "add_clip") return command.clip.id === id;
  return "clipId" in command && command.clipId === id && (command.type === "delete_clip" || command.type === "ripple_delete_clip"
    || command.type === "delete_keyframe" || command.type === "update_keyframe" && command.patch.time !== undefined);
}
const inside = (clip: TimelineClip, time: number) => time >= clip.timelineStart && time <= clip.timelineStart + clip.duration;
/** Inspector numbers use the same authored editing-frame clock as the original command planner. */
export function clipAppearanceNumberValuesV1(clip: TimelineClip, playhead: number, fps: number): Pick<TimelineClip, "transform" | "color"> {
  return inside(clip, playhead)
    ? animatedClipState(clip, alignTime(Math.max(0, Math.min(clip.duration, playhead - clip.timelineStart)), fps), fps)
    : clip;
}
function restartsScene(command: EditorCommand): boolean {
  return command.type === "configure_scene_25d" || command.type === "batch" && command.commands.some(restartsScene);
}

/** Displayed clip -> changed-field CAS -> original synchronous command/history. No project copy at construction. */
export function createClipAppearanceEditsV1(host: Host, view: View) {
  const captured = host.getSnapshot(), journal = captured.history.journal;
  // Only fields this callback itself committed may advance its expected value during batched input events.
  const ownWrites = new Map<string, number | boolean | undefined>();
  const transportCurrent = () => {
    const live = host.getTransport();
    return live.playhead === view.transport.playhead && live.seekRevision === view.transport.seekRevision;
  };
  const reject = (message = CLIP_APPEARANCE_STALE_V1) => { host.setStatus(message); return false; };
  function context(requireTransport = true) {
    const snapshot = host.getSnapshot(), project = snapshot.history.present, selection = host.getSelectionSnapshot();
    if (snapshot.sessionId !== captured.sessionId) return undefined; // Old project callbacks must not publish into the new project.
    if (captured.history.present !== view.project || selection !== view.selection || !selection.active
      || selection.selection || !view.clipId || selection.timelineSelection.primaryClipId !== view.clipId
      || selection.timelineSelection.primaryCaptionId !== undefined || project.id !== view.project.id
      || project.fps !== view.project.fps || project.width !== view.project.width || project.height !== view.project.height
      || requireTransport && (!Number.isFinite(view.transport.playhead) || !transportCurrent())) { reject(); return undefined; }
    const current = findClip(project, view.clipId), before = findClip(view.project, view.clipId);
    if (["assetId", "trackId", "timelineStart", "sourceStart", "duration", "speed", "timeRemap"].some(key =>
      !same(current[key as keyof TimelineClip], before[key as keyof TimelineClip]))) { reject(); return undefined; }
    const source = project.assets.find(asset => asset.id === current.assetId), oldSource = view.project.assets.find(asset => asset.id === before.assetId);
    if (!source || !oldSource || ["kind", "uri", "width", "height", "displayAspectRatio", "duration", "compositionId", "imageSequence", "clipRetime"].some(key =>
      !same(source[key as keyof typeof source], oldSource[key as keyof typeof oldSource]))) { reject(); return undefined; }
    const liveJournal = snapshot.history.journal;
    if (liveJournal.length < journal.length || journal.length > 0 && liveJournal[journal.length - 1] !== journal.at(-1)
      || liveJournal.slice(journal.length).some(record => replacesClip(record.command, current.id))) { reject(); return undefined; }
    return { snapshot, current, before };
  }
  function apply(property: Property, patch: Partial<Transform2D> | Partial<ColorAdjustments>, baseOnly = false, planned?: (value: ClipAppearancePlanV1) => void): boolean {
    try {
      const ctx = context(); if (!ctx) return false;
      const { snapshot, current, before } = ctx;
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) return reject(CLIP_APPEARANCE_INVALID_V1);
      const type = property === "transform" ? "update_clip_transform" : "set_clip_color";
      const parsed = editorCommandSchema.safeParse({ type, clipId: current.id, patch });
      if (!parsed.success || !("patch" in parsed.data)) return reject(CLIP_APPEARANCE_INVALID_V1);
      const acceptedPatch = parsed.data.patch;
      if (Object.keys(patch).some(key => !Object.hasOwn(acceptedPatch, key))
        || Object.values(patch).some(value => value === undefined || typeof value === "number" && !Number.isFinite(value))) return reject(CLIP_APPEARANCE_INVALID_V1);
      const localTime = alignTime(Math.max(0, Math.min(before.duration, view.transport.playhead - before.timelineStart)), view.project.fps);
      const animated = !baseOnly && inside(before, view.transport.playhead) && before.keyframes.length > 0;
      if (!baseOnly && animated !== (inside(current, view.transport.playhead) && current.keyframes.length > 0)) return reject();
      const originalFrame = animated ? clipAppearanceNumberValuesV1(before, view.transport.playhead, view.project.fps) : before;
      const liveFrame = animated ? clipAppearanceNumberValuesV1(current, view.transport.playhead, view.project.fps) : current;
      // What an auto-key stores: the keyframes' own values, without expressions. Expressions run on top of keyframes in
      // the preview and the export (animatedClipState), so storing the displayed (post-expression) values of the other
      // fields would apply their expressions twice (as planAddClipKeyframeV1 already avoids for ＋ keyframe).
      const authoredFrame = animated ? clipAppearanceNumberValuesV1({ ...current, expressions: {} }, view.transport.playhead, view.project.fps) : current;
      const numeric: Values = {}, mirrors: Values = {}, written: Array<[string, number | boolean | undefined]> = [];
      for (const [key, next] of Object.entries(patch)) {
        const mirror = property === "transform" && (key === "flipX" || key === "flipY");
        const scope = animated && !mirror ? "frame" : "base", token = scope + "." + property + "." + key;
        const original = (mirror ? before.transform : originalFrame[property]) as unknown as Values;
        const live = (mirror ? current.transform : liveFrame[property]) as unknown as Values;
        const expected = ownWrites.has(token) ? ownWrites.get(token) : original[key];
        if (next === expected) continue;
        if (live[key] !== expected) return reject();
        if (property === "transform" && !mirror) {
          const field = key as keyof NonNullable<TimelineClip["expressions"]>;
          if (current.expressions?.[field] !== before.expressions?.[field]) return reject();
          if (Object.hasOwn(current.expressions ?? {}, key)) return reject(CLIP_APPEARANCE_EXPRESSION_V1);
        }
        if (mirror) mirrors[key] = next; else numeric[key] = next;
        written.push([token, next]);
      }
      if (!written.length) { planned?.({}); return true; }
      const commands: EditorCommand[] = [];
      if (Object.keys(mirrors).length) commands.push({ type: "update_clip_transform", clipId: current.id, patch: mirrors as Partial<Transform2D> });
      let frameId: string | undefined;
      if (Object.keys(numeric).length) {
        if (!animated) commands.push(property === "transform"
          ? { type: "update_clip_transform", clipId: current.id, patch: numeric as Partial<Transform2D> }
          : { type: "set_clip_color", clipId: current.id, patch: numeric as Partial<ColorAdjustments> });
        else {
          const tolerance = .5 / view.project.fps;
          const existing = current.keyframes.find(keyframe => Math.abs(keyframe.time - localTime) <= tolerance);
          frameId = existing?.id ?? host.makeId("keyframe");
          const values = { ...authoredFrame[property], ...numeric };
          if (existing) commands.push({ type: "update_keyframe", clipId: current.id, keyframeId: existing.id,
            patch: property === "transform" ? { transform: values as Transform2D } : { color: values as ColorAdjustments } });
          else commands.push({ type: "add_keyframe", clipId: current.id, keyframe: {
            id: frameId, time: localTime, transform: property === "transform" ? values as Transform2D : authoredFrame.transform,
            color: property === "color" ? values as ColorAdjustments : authoredFrame.color, easing: "linear",
          } });
        }
      }
      const live = host.getSnapshot();
      if (live.sessionId !== snapshot.sessionId || live.history !== snapshot.history
        || host.getSelectionSnapshot() !== view.selection || !transportCurrent()) return reject();
      const command: EditorCommand = commands.length === 1 ? commands[0] : { type: "batch", commands };
      if (planned) { planned({ command }); return true; }
      const message = animated && Object.keys(numeric).length ? (frameId && current.keyframes.some(k => k.id === frameId)
        ? "已更新目前時間的動畫關鍵幀。" : "已自動在目前時間建立關鍵幀。")
        : property === "transform" ? "已更新 Transform。" : "已更新調色。";
      if (host.runCommand(command, message) === false) return false;
      const committed = host.getSnapshot();
      if (committed.sessionId !== snapshot.sessionId) return false;
      if (committed.history === snapshot.history) return reject(CLIP_APPEARANCE_INVALID_V1);
      const clip = findClip(committed.history.present, current.id);
      for (const [token, next] of written) {
        const [scope, group, key] = token.split(".");
        const value = scope === "frame" ? clip.keyframes.find(k => k.id === frameId)?.[group as Property] : clip[group as Property];
        if (!value || (value as unknown as Values)[key] !== next) return reject(CLIP_APPEARANCE_INVALID_V1);
        ownWrites.set(token, next);
      }
      return true;
    } catch (error) {
      if (host.getSnapshot().sessionId !== captured.sessionId) return false;
      return reject(error instanceof Error ? error.message : CLIP_APPEARANCE_INVALID_V1);
    }
  }
  function volume(value: number, planned?: (plan: ClipAppearancePlanV1) => void): boolean {
    try {
      const ctx = context(false); if (!ctx) return false;
      assertClipVolume(value);
      const parsed = editorCommandSchema.safeParse({ type: "set_clip_volume", clipId: ctx.current.id, volume: value });
      if (!parsed.success || parsed.data.type !== "set_clip_volume") return reject(CLIP_APPEARANCE_INVALID_V1);
      const expected = ownWrites.has("volume") ? ownWrites.get("volume") : ctx.before.volume;
      if (ctx.current.volume !== expected) return reject();
      if (value === expected) { planned?.({}); return true; }
      if (planned) { planned({ command: parsed.data }); return true; }
      const live = host.getSnapshot();
      if (live.history !== ctx.snapshot.history || host.getSelectionSnapshot() !== view.selection) return reject();
      if (host.runCommand(parsed.data, "已更新片段音量。") === false) return false;
      const after = host.getSnapshot();
      if (after.sessionId !== captured.sessionId || after.history === ctx.snapshot.history
        || findClip(after.history.present, ctx.current.id).volume !== value) return reject(CLIP_APPEARANCE_INVALID_V1);
      ownWrites.set("volume", value); return true;
    } catch (error) {
      if (host.getSnapshot().sessionId !== captured.sessionId) return false;
      return reject(error instanceof Error ? error.message : CLIP_APPEARANCE_INVALID_V1);
    }
  }
  function transform3d(patch: Partial<Transform3D>, axis?: Transform3dAxisIntentV1): boolean {
    try {
      const ctx = context(false); if (!ctx) return false;
      const { snapshot, current, before } = ctx;
      if (!view.project.scene25d?.enabled || !snapshot.history.present.scene25d?.enabled
        || snapshot.history.journal.slice(journal.length).some(record => restartsScene(record.command))) return reject();
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) return reject(CLIP_APPEARANCE_INVALID_V1);
      const parsed = editorCommandSchema.safeParse({ type: "update_clip_transform_3d", clipId: current.id, patch });
      if (!parsed.success || parsed.data.type !== "update_clip_transform_3d") return reject(CLIP_APPEARANCE_INVALID_V1);
      // Bind the narrowed 3D patch once: the discriminant narrowing of parsed.data does not reach the callbacks below.
      const acceptedPatch = parsed.data.patch;
      if (Object.keys(patch).some(key => !Object.hasOwn(acceptedPatch, key))
        || Object.values(patch).some(value => value === undefined)) return reject(CLIP_APPEARANCE_INVALID_V1);
      const keys = Object.keys(acceptedPatch) as Array<keyof Transform3D>;
      if (axis && (!Number.isInteger(axis.index) || axis.index < 0 || axis.index > 2
        || keys.length !== 1 || keys[0] !== axis.property)) return reject(CLIP_APPEARANCE_INVALID_V1);
      const original = before.transform3d ?? DEFAULT_TRANSFORM_3D, live = current.transform3d ?? DEFAULT_TRANSFORM_3D;
      const merged: Partial<Transform3D> = {}, written: Array<[string, keyof Transform3D, number, number]> = [];
      for (const key of keys) {
        const next = acceptedPatch[key]!, tuple = [...live[key]] as [number, number, number];
        let changed = false;
        for (let index = 0; index < 3; index++) {
          if (axis && axis.index !== index) continue;
          const token = `transform3d.${key}.${index}`, expected = ownWrites.has(token) ? ownWrites.get(token) : original[key][index];
          if (next[index] === expected) continue;
          if (live[key][index] !== expected) return reject();
          tuple[index] = next[index]; changed = true; written.push([token, key, index, next[index]]);
        }
        if (changed) merged[key] = tuple;
      }
      if (!written.length) return true;
      const ready = host.getSnapshot();
      if (ready.sessionId !== snapshot.sessionId || ready.history !== snapshot.history || host.getSelectionSnapshot() !== view.selection) return reject();
      if (host.runCommand({ type: "update_clip_transform_3d", clipId: current.id, patch: merged }, "已更新 2.5D 平面位置。 ") === false) return false;
      const after = host.getSnapshot();
      if (after.sessionId !== captured.sessionId || after.history === snapshot.history) return reject(CLIP_APPEARANCE_INVALID_V1);
      const actual = findClip(after.history.present, current.id).transform3d;
      if (!actual || written.some(([, key, index, next]) => actual[key][index] !== next)) return reject(CLIP_APPEARANCE_INVALID_V1);
      for (const [token, , , next] of written) ownWrites.set(token, next);
      return true;
    } catch (error) {
      if (host.getSnapshot().sessionId !== captured.sessionId) return false;
      return reject(error instanceof Error ? error.message : CLIP_APPEARANCE_INVALID_V1);
    }
  }
  const plan = (action: (accept: (value: ClipAppearancePlanV1) => void) => boolean): ClipAppearancePlanV1 | undefined => {
    let value: ClipAppearancePlanV1 | undefined; return action(next => { value = next; }) ? value : undefined;
  };
  return {
    transform: (patch: Partial<Transform2D>) => apply("transform", patch),
    color: (patch: Partial<ColorAdjustments>) => apply("color", patch),
    baseColor: (patch: Partial<ColorAdjustments>) => apply("color", patch, true),
    volume: (value: number) => volume(value),
    transform3d,
    planTransform: (patch: Partial<Transform2D>) => plan(accept => apply("transform", patch, false, accept)),
    planColor: (patch: Partial<ColorAdjustments>) => plan(accept => apply("color", patch, false, accept)),
    planBaseColor: (patch: Partial<ColorAdjustments>) => plan(accept => apply("color", patch, true, accept)),
    planVolume: (value: number) => plan(accept => volume(value, accept)),
  };
}
