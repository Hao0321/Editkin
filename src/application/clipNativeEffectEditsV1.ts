import type { EditorCommand } from "../domain/commandTypes";
import type { EditProject, NativeEffectInstance } from "../domain/types";
import type { PluginRegistrySummary } from "../desktop/pluginTypes";
import type { ProjectSessionSnapshot } from "./projectSession";
import type { GraphicEditingSelectionSnapshotV1 } from "./graphicEditingSelectionV1";
import { findClip } from "../domain/editGraph";
import { nativeEffectInstanceSchema } from "../domain/clipCreativeSchema";
import { createNativeEffectParameterEditActionsV1, EFFECT_PARAMETER_EDIT_INVALID_V1, EFFECT_PARAMETER_EDIT_STALE_V1 } from "./nativeEffectParameterEditsV1";

interface Host {
  getSnapshot: () => ProjectSessionSnapshot;
  getSelectionSnapshot: () => GraphicEditingSelectionSnapshotV1;
  getRegistry?: () => PluginRegistrySummary | undefined;
  runCommand: (command: EditorCommand, message?: string) => boolean | void;
  setStatus: (message: string) => void;
}
interface View { project: EditProject; clipId?: string; selection: GraphicEditingSelectionSnapshotV1 }
type Patch = Partial<Pick<NativeEffectInstance, "enabled" | "parameters">>;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const identity = (e: NativeEffectInstance) => [e.id, e.pluginId, e.capabilityId, e.pluginVersion, e.manifestSha256, e.runtimeType ?? "native_effect"];
const order = (effects: readonly NativeEffectInstance[]) => effects.map(identity);
function retired(command: EditorCommand, clipId: string, instanceId?: string): boolean {
  if (command.type === "batch") return command.commands.some(c => retired(c, clipId, instanceId));
  if (command.type === "add_clip") return command.clip.id === clipId;
  return "clipId" in command && command.clipId === clipId && (command.type === "delete_clip" || command.type === "ripple_delete_clip"
    || instanceId !== undefined && (command.type === "remove_native_effect" && command.instanceId === instanceId
      || command.type === "add_native_effect" && command.instance.id === instanceId));
}
function changesStack(command: EditorCommand, clipId: string): boolean {
  if (command.type === "batch") return command.commands.some(c => changesStack(c, clipId));
  return "clipId" in command && command.clipId === clipId
    && ["add_native_effect", "remove_native_effect", "reorder_native_effect"].includes(command.type);
}

/** Five UI actions, one canonical session/selection/parameter validator and command runner. */
export function createClipNativeEffectEditsV1(host: Host, view: View) {
  const captured = host.getSnapshot(), journal = captured.history.journal;
  const ownParameters = new Map<string, NativeEffectInstance["parameters"]>(), ownEnabled = new Map<string, boolean>();
  const ownRecords = new Set<object>();
  let ownOrder: ReturnType<typeof order> | undefined;
  const status = (message: string) => { if (host.getSnapshot().sessionId === captured.sessionId) host.setStatus(message); };
  const refuse = (message = EFFECT_PARAMETER_EDIT_STALE_V1) => { status(message); return false; };
  function context(instanceId?: string) {
    const snapshot = host.getSnapshot(), project = snapshot.history.present, selection = host.getSelectionSnapshot();
    if (snapshot.sessionId !== captured.sessionId) return undefined;
    if (captured.history.present !== view.project || project.id !== view.project.id || !view.clipId
      || selection !== view.selection || !selection.active || selection.selection
      || selection.timelineSelection.primaryClipId !== view.clipId || selection.timelineSelection.primaryCaptionId !== undefined) {
      refuse(); return undefined;
    }
    const clip = findClip(project, view.clipId), before = findClip(view.project, view.clipId);
    const liveJournal = snapshot.history.journal;
    if (clip.assetId !== before.assetId || clip.trackId !== before.trackId || liveJournal.length < journal.length
      || journal.length > 0 && liveJournal[journal.length - 1] !== journal.at(-1)
      || liveJournal.slice(journal.length).some(record => retired(record.command, clip.id, instanceId))) { refuse(); return undefined; }
    const effects = clip.creative?.nativeEffectInstances ?? [], beforeEffects = before.creative?.nativeEffectInstances ?? [];
    const effect = effects.find(e => e.id === instanceId), expected = beforeEffects.find(e => e.id === instanceId);
    if (instanceId !== undefined && (!effect || !expected || !same(identity(effect), identity(expected)))) { refuse(); return undefined; }
    return { snapshot, clip, effects, beforeEffects, effect, expected };
  }
  type Context = NonNullable<ReturnType<typeof context>>;
  const fresh = (ctx: Context) => {
    const live = host.getSnapshot();
    return live.sessionId === ctx.snapshot.sessionId && live.history === ctx.snapshot.history && host.getSelectionSnapshot() === view.selection;
  };
  const expectedEffect = (effect: NativeEffectInstance): NativeEffectInstance => ({
    ...effect, parameters: { ...effect.parameters, ...ownParameters.get(effect.id) },
    enabled: ownEnabled.get(effect.id) ?? effect.enabled,
  });
  const stackCurrent = (ctx: Context) => same(order(ctx.effects), ownOrder ?? order(ctx.beforeEffects))
    && !ctx.snapshot.history.journal.slice(journal.length).some(record => !ownRecords.has(record) && changesStack(record.command, ctx.clip.id));
  function commit(ctx: Context, command: EditorCommand, message: string): boolean {
    if (!fresh(ctx)) return refuse();
    if (host.runCommand(command, message) === false) return false;
    const after = host.getSnapshot();
    if (after.sessionId !== captured.sessionId) return false;
    if (after.history === ctx.snapshot.history) return refuse(EFFECT_PARAMETER_EDIT_INVALID_V1);
    const effects = findClip(after.history.present, ctx.clip.id).creative?.nativeEffectInstances ?? [];
    let matched = false;
    switch (command.type) {
      case "add_native_effect": matched = effects.some(e => same(e, command.instance)); break;
      case "remove_native_effect": matched = !effects.some(e => e.id === command.instanceId); break;
      case "reorder_native_effect": matched = effects[command.toIndex]?.id === command.instanceId; break;
      case "update_native_effect": {
        const effect = effects.find(e => e.id === command.instanceId);
        matched = Boolean(effect && (command.patch.enabled === undefined || effect.enabled === command.patch.enabled)
          && (command.patch.parameters === undefined || same(effect.parameters, command.patch.parameters)));
        break;
      }
    }
    if (!matched) return refuse(EFFECT_PARAMETER_EDIT_INVALID_V1);
    for (const record of after.history.journal.slice(ctx.snapshot.history.journal.length)) ownRecords.add(record);
    if (command.type === "update_native_effect") {
      if (command.patch.enabled !== undefined) ownEnabled.set(command.instanceId, command.patch.enabled);
    } else ownOrder = order(effects);
    return true;
  }
  function parameters(ctx: Context, expected: NativeEffectInstance, values: NativeEffectInstance["parameters"], enabled?: boolean): boolean {
    if (!ctx.effect || !ctx.expected || !same(expected, ctx.expected)) return refuse();
    const effective = expectedEffect(expected);
    if (enabled !== undefined && ctx.effect.enabled !== effective.enabled) return refuse();
    let dispatched = false;
    const actions = createNativeEffectParameterEditActionsV1({
      getSnapshot: host.getSnapshot, getRegistry: host.getRegistry, setStatus: status,
      runCommand: (command, message) => {
        if (command.type !== "update_native_effect") return refuse(EFFECT_PARAMETER_EDIT_INVALID_V1);
        dispatched = true;
        const result = commit(ctx, enabled === undefined ? command : { ...command, patch: { ...command.patch, enabled } },
          message ?? "已更新原生效果；正式輸出會使用這組參數。");
        if (result) ownParameters.set(expected.id, { ...ownParameters.get(expected.id), ...values });
        return result;
      },
    });
    const accepted = actions.apply({ sessionId: captured.sessionId, projectId: view.project.id, clipId: ctx.clip.id }, effective, values);
    if (!accepted) return false;
    if (!dispatched && enabled !== undefined && enabled !== ctx.effect.enabled) {
      return commit(ctx, { type: "update_native_effect", clipId: ctx.clip.id, instanceId: expected.id, patch: { enabled } },
        "已更新原生效果；正式輸出會使用這組參數。");
    }
    return true;
  }
  const safe = (action: () => boolean): boolean => {
    try { return action(); } catch (error) { return refuse(error instanceof Error ? error.message : EFFECT_PARAMETER_EDIT_INVALID_V1); }
  };
  return {
    add: (instance: NativeEffectInstance): boolean => safe(() => {
      const ctx = context(); if (!ctx) return false;
      if (!stackCurrent(ctx)) return refuse();
      const parsed = nativeEffectInstanceSchema.strict().safeParse(instance);
      if (!parsed.success) return refuse(EFFECT_PARAMETER_EDIT_INVALID_V1);
      return commit(ctx, { type: "add_native_effect", clipId: ctx.clip.id, instance: parsed.data },
        "已加入原生 GPU 動態模糊；預覽與輸出共用 shutter sampling。 ");
    }),
    update: (instanceId: string, patch: Patch): boolean => safe(() => {
      const ctx = context(instanceId); if (!ctx || !ctx.effect || !ctx.expected) return false;
      if (!patch || typeof patch !== "object" || Array.isArray(patch)
        || Object.keys(patch).some(key => key !== "enabled" && key !== "parameters")
        || Object.hasOwn(patch, "enabled") && typeof patch.enabled !== "boolean") return refuse(EFFECT_PARAMETER_EDIT_INVALID_V1);
      const effective = expectedEffect(ctx.expected);
      const enabled = patch.enabled !== undefined && patch.enabled !== effective.enabled ? patch.enabled : undefined;
      if (enabled !== undefined && ctx.effect.enabled !== effective.enabled) return refuse();
      if (Object.hasOwn(patch, "parameters")) {
        const parsed = nativeEffectInstanceSchema.shape.parameters.safeParse(patch.parameters);
        if (!parsed.success) return refuse(EFFECT_PARAMETER_EDIT_INVALID_V1);
        const payload = parsed.data;
        if (Object.keys(ctx.expected.parameters).some(key => !Object.hasOwn(payload, key))) return refuse(EFFECT_PARAMETER_EDIT_INVALID_V1);
        // This legacy whole-record port describes changes against its rendered record, not absent/deleted unknown live fields.
        const values = Object.fromEntries(Object.entries(payload).filter(([key, value]) =>
          !Object.hasOwn(ctx.expected!.parameters, key) || value !== ctx.expected!.parameters[key]));
        return parameters(ctx, ctx.expected, values, enabled);
      }
      return enabled === undefined || commit(ctx, { type: "update_native_effect", clipId: ctx.clip.id, instanceId, patch: { enabled } },
        "已更新原生效果；正式輸出會使用這組參數。");
    }),
    parameters: (expected: NativeEffectInstance, values: NativeEffectInstance["parameters"]): boolean => safe(() => {
      const ctx = context(expected.id); return ctx ? parameters(ctx, expected, values) : false;
    }),
    reorder: (instanceId: string, toIndex: number): boolean => safe(() => {
      const ctx = context(instanceId); if (!ctx) return false;
      if (!stackCurrent(ctx)) return refuse();
      if (!Number.isSafeInteger(toIndex) || toIndex < 0 || toIndex >= ctx.effects.length) return refuse(EFFECT_PARAMETER_EDIT_INVALID_V1);
      return ctx.effects[toIndex].id === instanceId || commit(ctx, { type: "reorder_native_effect", clipId: ctx.clip.id, instanceId, toIndex },
        "已調整效果順序；預覽與正式輸出會依這個順序執行。");
    }),
    remove: (instanceId: string): boolean => safe(() => {
      const ctx = context(instanceId); if (!ctx || !ctx.expected || !ctx.effect) return false;
      if (!same(ctx.effect, expectedEffect(ctx.expected))) return refuse();
      return commit(ctx, { type: "remove_native_effect", clipId: ctx.clip.id, instanceId }, "已移除原生效果；可直接復原。");
    }),
  };
}
