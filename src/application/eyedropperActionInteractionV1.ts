import type { ColorAdjustments, ColorGradeV2, ColorManagementSettings, MediaAsset, TimelineClip } from "../domain/types";
import { DEFAULT_COLOR } from "../domain/types";
import { animatedClipState } from "../domain/editGraph";
import { combineLookColor } from "../creative/corePack";
import { addGradeNodeV1 } from "../domain/colorGradePanelEditsV1";
import { COLOR_GRADE_V2_MAX_NODES } from "../domain/colorGradeV2Schema";
import { secondaryHslSourceNodesV1 } from "../domain/secondaryHslV1Nodes";
import { hasAuthoredClipTimeRemapV1 } from "../domain/clipTimeRemapV1";
import type { PreviewPickerSampleV1 } from "../ui/colorPreviewPickerControllerV1";
import type { ColorLutClientV1 } from "../color/colorLutClientV1";
import type { ColorLutResolver } from "../color/gradeV2";
import { colorWorkspaceInputAdmissionV1 } from "../color/colorWorkspaceInputAdmissionV1";
import { EyedropperRefusalV1, eyedropperPrefixGradeV1, neutralBalanceNodeForWorkingRgbV1, projectOriginalSampleThroughPrefixV1,
  refuseEyedropperV1, seedQualifierFromWorkingRgbV1, type EyedropperRefusalCodeV1, type EyedropperSelectorWidthsV1 } from "../color/eyedropperActionsV1";

export type EyedropperActionKindV1 = "neutral" | "hsl";
export interface EyedropperActionHostV1 {
  projectOwner: object; contentOwner: object; sessionId: number; revision: number; projectId: string; projectPath?: string;
  asset: MediaAsset; clip: TimelineClip; management: ColorManagementSettings; localTime: number; sourceKey: string;
  selectedNodeId?: string; editable: boolean; locked: boolean; selectorWidths: EyedropperSelectorWidthsV1; neutralNodeLabel: string;
  lutClient?: Pick<ColorLutClientV1, "readCube">;
  /** Synchronous true only after the ordinary existing command was accepted as one Undo. */
  onApply(grade: ColorGradeV2): boolean;
}
export interface EyedropperSampleStateV1 { sample?: PreviewPickerSampleV1; contextKey: string; ready: boolean; }
export type EyedropperActionContextV1 = EyedropperActionHostV1 & EyedropperSampleStateV1;
export interface EyedropperActionStateV1 {
  status: "idle" | "pending" | "applied" | "unchanged" | "held" | "cancelled" | "uncertain";
  code?: EyedropperRefusalCodeV1;
}
// A picker owns the sample object. Reopening its action strip must not replay an
// already applied or uncertain synchronous write with that same sample.
const consumedEyedropperSamplesV1 = new WeakSet<object>();

function neutralPrimary(color: ColorAdjustments) {
  return Object.entries(DEFAULT_COLOR).every(([key, value]) => color[key as keyof ColorAdjustments] === value)
    && [color.whiteBalanceRed ?? 0, color.whiteBalanceGreen ?? 0, color.whiteBalanceBlue ?? 0].every(v => v === 0);
}

/** Admission is intentionally separate from the independent working-RGB algorithms. */
export function assertEyedropperBrowserAdmissionV1(c: EyedropperActionContextV1, kind: EyedropperActionKindV1): void {
  if (!c || typeof c.projectOwner !== "object" || !c.projectOwner || typeof c.contentOwner !== "object" || !c.contentOwner
    || !Number.isSafeInteger(c.sessionId) || !Number.isSafeInteger(c.revision) || c.sessionId < 0 || c.revision < 0
    || typeof c.projectId !== "string" || !c.projectId || typeof c.sourceKey !== "string" || !c.sourceKey || typeof c.onApply !== "function") refuseEyedropperV1("EYEDROPPER_UNAVAILABLE");
  if (c.locked !== false || c.editable !== true) refuseEyedropperV1("EYEDROPPER_LOCKED");
  const s = c.sample;
  if (c.ready !== true || !s || typeof c.contextKey !== "string" || !c.contextKey || s.contextKey !== c.contextKey) refuseEyedropperV1("EYEDROPPER_STALE");
  if (s.basis !== "decoded-source-preview") refuseEyedropperV1("EYEDROPPER_GRADED");
  if (![s.x, s.y, s.width, s.height, s.patchWidth, s.patchHeight, s.validPixels].every(Number.isSafeInteger)
    || s.x < 0 || s.y < 0 || s.x >= s.width || s.y >= s.height || s.width > 32768 || s.height > 32768 || s.patchWidth < 1 || s.patchHeight < 1
    || s.patchWidth > 9 || s.patchHeight > 9 || s.validPixels < 1 || s.validPixels > s.patchWidth * s.patchHeight) refuseEyedropperV1("EYEDROPPER_SAMPLE");
  if (!Array.isArray(s.rgb) || s.rgb.length !== 3 || !s.rgb.every(v => Number.isInteger(v) && v >= 0 && v <= 255)) refuseEyedropperV1("EYEDROPPER_SAMPLE");
  if (c.management.mode !== "rec709" || c.management.outputTransform !== "rec709_sdr") refuseEyedropperV1("EYEDROPPER_CALIBRATION");
  const admission = colorWorkspaceInputAdmissionV1(c.asset, c.management), clip = c.clip;
  if (admission.metadataInvalid || admission.legacyInput !== "rec709" || !["image", "video"].includes(c.asset.kind)
    || clip.assetId !== c.asset.id || c.asset.compositionId || c.asset.imageSequence || c.asset.clipRetime
    || clip.masks?.some(m => m.enabled) || clip.chromaKey?.enabled || clip.layer?.trackMatte || clip.creative?.nativeEffectInstances?.some(effect => effect.enabled !== false)
    || clip.floatingFrame || clip.creative?.transitionIn || clip.creative?.transitionOut || Object.keys(clip.expressions ?? {}).length
    || hasAuthoredClipTimeRemapV1(clip)) refuseEyedropperV1("EYEDROPPER_SOURCE");
  if (!Number.isFinite(clip.duration) || clip.duration <= 0 || !Number.isFinite(c.localTime) || c.localTime < 0 || c.localTime > clip.duration) refuseEyedropperV1("EYEDROPPER_STALE");
  const primary = combineLookColor(animatedClipState(clip, c.localTime).color, clip.creative?.lookPresetId);
  if (!neutralPrimary(primary)) refuseEyedropperV1("EYEDROPPER_CALIBRATION");
  eyedropperPrefixGradeV1(clip.gradeV2, kind === "hsl" ? c.selectedNodeId ?? "" : undefined);
}

const data = (c: EyedropperActionContextV1) => ({ asset: c.asset, clip: c.clip, management: c.management, localTime: c.localTime,
  sourceKey: c.sourceKey, selectedNodeId: c.selectedNodeId, editable: c.editable, locked: c.locked, contextKey: c.contextKey,
  projectId: c.projectId, projectPath: c.projectPath, revision: c.revision, sessionId: c.sessionId,
  selectorWidths: c.selectorWidths, neutralNodeLabel: c.neutralNodeLabel, sample: c.sample });

function draft(c: EyedropperActionContextV1, kind: EyedropperActionKindV1, resolveLut: ColorLutResolver): ColorGradeV2 | undefined {
  const prefix = eyedropperPrefixGradeV1(c.clip.gradeV2, kind === "hsl" ? c.selectedNodeId ?? "" : undefined);
  const rgb = projectOriginalSampleThroughPrefixV1(c.sample!.rgb, prefix, resolveLut);
  if (kind === "hsl") {
    const grade = structuredClone(c.clip.gradeV2!);
    grade.nodes = grade.nodes!.map(node => node.id === c.selectedNodeId ? seedQualifierFromWorkingRgbV1(node, rgb, c.selectorWidths) : node);
    return JSON.stringify(grade) === JSON.stringify(c.clip.gradeV2) ? undefined : grade;
  }
  // Identity samples produce no node and no Undo even when the grade is already full.
  if (Math.max(...rgb) - Math.min(...rgb) <= 1e-12) return undefined;
  if ((c.clip.gradeV2?.nodes?.length ?? 0) >= COLOR_GRADE_V2_MAX_NODES) refuseEyedropperV1("EYEDROPPER_NODE_LIMIT");
  const grade = addGradeNodeV1(c.clip.gradeV2), node = grade.nodes!.at(-1)!;
  grade.nodes![grade.nodes!.length - 1] = neutralBalanceNodeForWorkingRgbV1(rgb, "rec709_display", node.id, c.neutralNodeLabel)!;
  return grade;
}

function abortable<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((yes, no) => {
    const stop = () => no(new EyedropperRefusalV1("EYEDROPPER_CANCELLED"));
    signal.addEventListener("abort", stop, { once: true });
    task.then(v => { signal.removeEventListener("abort", stop); yes(v); }, e => { signal.removeEventListener("abort", stop); no(e); });
    if (signal.aborted) stop();
  });
}

async function prefixResolver(c: EyedropperActionContextV1, kind: EyedropperActionKindV1, signal: AbortSignal, check: () => void): Promise<ColorLutResolver> {
  const prefix = eyedropperPrefixGradeV1(c.clip.gradeV2, kind === "hsl" ? c.selectedNodeId ?? "" : undefined);
  const cubes = new Map<string, Awaited<ReturnType<ColorLutClientV1["readCube"]>>["cube"]>(); let bytes = 0;
  for (const node of secondaryHslSourceNodesV1(prefix.nodes ?? [])) {
    const ref = node.lut; if (!ref || node.enabled === false || ref.strength <= 0 || cubes.has(ref.sha256)) continue;
    check(); if (!c.lutClient) refuseEyedropperV1("EYEDROPPER_LUT");
    let loaded: Awaited<ReturnType<ColorLutClientV1["readCube"]>>;
    try { loaded = await abortable(c.lutClient.readCube(ref, "rec709_display"), signal); }
    catch (error) { check(); if (error instanceof EyedropperRefusalV1) throw error; refuseEyedropperV1("EYEDROPPER_LUT"); }
    check();
    bytes += loaded.cube.values.byteLength;
    if (bytes > 32 * 1024 ** 2) refuseEyedropperV1("EYEDROPPER_LUT");
    cubes.set(ref.sha256, loaded.cube);
  }
  return ref => { const cube = cubes.get(ref.sha256); if (!cube) refuseEyedropperV1("EYEDROPPER_LUT"); return cube; };
}

/** One live sample, at most one synchronous acknowledged grade dispatch. */
export function createEyedropperActionInteractionV1(getContext: () => EyedropperActionContextV1 | undefined, emit: (state: EyedropperActionStateV1) => void) {
  let live = true, pending: AbortController | undefined, state: EyedropperActionStateV1 = { status: "idle" };
  const consumed = consumedEyedropperSamplesV1;
  const publish = (next: EyedropperActionStateV1) => { state = next; if (live) emit(next); return next; };
  const cancel = () => { if (pending) { pending.abort(); publish({ status: "cancelled", code: "EYEDROPPER_CANCELLED" }); } };
  const run = async (kind: EyedropperActionKindV1) => {
    if (!live || pending) return state;
    const token = new AbortController(); pending = token; let applying = false;
    try {
      if (kind !== "neutral" && kind !== "hsl") refuseEyedropperV1("EYEDROPPER_PARAMETERS");
      const first = getContext(); if (!first) refuseEyedropperV1("EYEDROPPER_UNAVAILABLE");
      assertEyedropperBrowserAdmissionV1(first, kind);
      const sample = first.sample!, owner = first.projectOwner, content = first.contentOwner, session = first.sessionId;
      const lutClient = first.lutClient, reader = lutClient?.readCube;
      if (consumed.has(sample)) refuseEyedropperV1("EYEDROPPER_STALE");
      const fingerprint = JSON.stringify(data(first)), captured = { ...first, ...structuredClone(data(first)) };
      const check = () => {
        if (!live || token.signal.aborted) refuseEyedropperV1("EYEDROPPER_CANCELLED");
        const now = getContext();
        if (!now || now.projectOwner !== owner || now.contentOwner !== content || now.sessionId !== session || now.sample !== sample
          || now.ready !== true || now.lutClient !== lutClient || now.lutClient?.readCube !== reader || typeof now.onApply !== "function"
          || JSON.stringify(data(now)) !== fingerprint) refuseEyedropperV1("EYEDROPPER_STALE");
        return now;
      };
      publish({ status: "pending" }); check();
      const resolveLut = await prefixResolver(captured, kind, token.signal, check); check();
      const grade = draft(captured, kind, resolveLut);
      if (!grade) { consumed.add(sample); return publish({ status: "unchanged" }); }
      const current = check(); consumed.add(sample); applying = true;
      const accepted: unknown = current.onApply(grade);
      if (accepted && typeof accepted === "object" && "then" in accepted) void Promise.resolve(accepted).catch(() => {});
      if (accepted !== true) return publish({ status: accepted === false ? "held" : "uncertain", code: "EYEDROPPER_UNAVAILABLE" });
      return publish({ status: "applied" });
    } catch (error) {
      if (applying) return publish({ status: "uncertain", code: "EYEDROPPER_UNAVAILABLE" });
      const code = error instanceof EyedropperRefusalV1 ? error.code : "EYEDROPPER_PARAMETERS";
      return publish({ status: code === "EYEDROPPER_CANCELLED" ? "cancelled" : "held", code });
    } finally { if (pending === token) pending = undefined; }
  };
  return { run, cancel, state: () => state, consumed: (sample?: PreviewPickerSampleV1) => Boolean(sample && consumed.has(sample)), dispose: () => { live = false; pending?.abort(); } };
}
