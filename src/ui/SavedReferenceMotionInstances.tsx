import { GraphicTimingControlsV2 } from "./GraphicTimingControlsV2";
import type { GraphicTimingV2 } from "../domain/graphicTimingV2";
import { translateUi as uiText, translateUiStatus, useI18n } from "./i18n/interfacePreferences";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { EditorCommand, EditorCommandContext } from "../domain/commands";
import type { PickedMedia, PrepareMediaResult } from "../desktop/mediaTypes";
import { SavedReferenceMotionSourceReplacement } from "./SavedReferenceMotionSourceReplacement";
import type { ReferenceMotionSourceReplacementRequest } from "../application/referenceMotionSourceReplacement";
import { referenceMotionUiCommitContext } from "./referenceMotionUiCommitContext";
import type { ReferenceMotionTemplateInstance, ReferenceMotionTemplateRevisionPatch } from "../domain/referenceMotionInstance";
import type { EditProject, MediaAsset, NormalizedRect, TimelineClip } from "../domain/types";
import type { ProjectSession } from "../application/projectSession";
import { acceptProjectTask } from "../application/projectTask";
import { inspectReferenceMotionTemplateInstance, plainReferenceMotionRebuildReason, prepareReferenceMotionTemplateReapply,
  referenceMotionTemplateReapplyPatch, referenceMotionTemplatesBehindUpdate, type ReferenceMotionTemplatesUpdate } from "../application/referenceMotionTemplateInstances";
import { canRunTemplatesUpdate, publishTemplatesUpdateReport, requestTemplatesUpdate, templatesUpdateRunning } from "../application/templatesUpdateRuns";
import { referenceMotionReuseSourceIdentity, type ReferenceMotionTemplateReuseRequest } from "../application/referenceMotionTemplateReuse";
import { referenceMotionTemplateSourceColorAdmitted } from "../application/referenceMotionTemplateCommands";
import { referenceMotionManualReuseRequest } from "./referenceMotionManualReuse";
import { REFERENCE_MOTION_DESIGN_CONTRACT, isNativeReferenceMotionPresentation, referenceMotionTemplate } from "../motion/referenceMotionTemplates";
import { bundledFontFamilies } from "../typography/fontFaces";
import { createMotionTemplateTextPreparer, type MotionTemplateTextPreparer } from "../typography/motionTemplateTextPreparation";
import { subscribeTemplateEditorRequests } from "./templateEditorRequests";
import "./savedReferenceMotionInstances.css";

type Inspection = Awaited<ReturnType<typeof inspectReferenceMotionTemplateInstance>>;
type EditableInstance = Pick<ReferenceMotionTemplateInstance, "id" | "instanceRevision" | "authoringGeneration" | "input">
  & { frameFormat?: Pick<ReferenceMotionTemplateInstance["frameFormat"], "fps"> };

/** Where on-footage text sits: the template's own place, or one of three plain choices. */
export type ReferenceMotionTextPosition = "default" | "top" | "middle" | "bottom" | "custom";
/** Generous quiet regions (fractions of the source frame) so a whole reading group fits inside each one. */
export const REFERENCE_MOTION_TEXT_POSITIONS: Readonly<Record<"top" | "middle" | "bottom", NormalizedRect>> = Object.freeze({
  top: { x: .085, y: .08, width: .83, height: .42 },
  middle: { x: .085, y: .29, width: .83, height: .42 },
  bottom: { x: .085, y: .5, width: .83, height: .42 },
});

export function referenceMotionTextPosition(region: NormalizedRect | undefined): ReferenceMotionTextPosition {
  if (!region) return "default";
  for (const key of ["top", "middle", "bottom"] as const) {
    const preset = REFERENCE_MOTION_TEXT_POSITIONS[key];
    if ((["x", "y", "width", "height"] as const).every(side => Math.abs(region[side] - preset[side]) < 1e-6)) return key;
  }
  return "custom";
}

export interface ReferenceMotionInstanceDraft {
  graphicCadence: NonNullable<ReferenceMotionTemplateInstance["input"]["graphicCadence"]>;
  graphicTimingV2?: GraphicTimingV2;
  strikePresentation?: "legacy_layout" | "semantic_replace_v1";
  strikeSurface?: "standalone" | "source_overlay" | "source_overlay_v2";
  brandMark?: string;
  /** Design themes: the word of the title set in the accent colour. */
  accentText?: string;
  /** Design-theme strike_reframe: the short label on the image block. */
  tag?: string;
  /** On-footage text (source_overlay_v2 / source_editorial_v1): where the words sit. */
  textPosition?: ReferenceMotionTextPosition;
  title: string; kicker: string; subtitle: string; previousText: string; primaryLabel: string;
  items: Array<{ label: string; detail: string }>;
  networkLabels: [string, string, string]; hubLabel: string;
  palette: ReferenceMotionTemplateInstance["input"]["style"]["palette"];
  typography: ReferenceMotionTemplateInstance["input"]["style"]["typography"];
}

const isDesign = (instance: EditableInstance) => instance.input.designSystem !== undefined;

/** True when this saved template can place its words in another part of the footage. */
export function referenceMotionTextPositionSupported(instance: EditableInstance, draft: Pick<ReferenceMotionInstanceDraft, "strikePresentation" | "strikeSurface">): boolean {
  const input = instance.input;
  if (isDesign(instance)) return false;
  if (input.templateId === "strike_reframe") {
    return (draft.strikePresentation ?? input.strikePresentation ?? "legacy_layout") === "semantic_replace_v1"
      && (draft.strikeSurface ?? input.strikeSurface ?? "standalone") === "source_overlay_v2";
  }
  return input.overlayPresentation === "source_editorial_v1";
}

/** The accent word must be part of the title; a changed title can leave it out. */
export function referenceMotionAccentConflict(instance: EditableInstance, draft: Pick<ReferenceMotionInstanceDraft, "accentText" | "title">): string | undefined {
  if (!isDesign(instance)) return undefined;
  const accent = (draft.accentText ?? "").trim();
  return accent && !draft.title.trim().includes(accent) ? accent : undefined;
}

export function referenceMotionInstanceDraft(instance: EditableInstance): ReferenceMotionInstanceDraft {
  const input = instance.input, design = isDesign(instance);
  const draft: ReferenceMotionInstanceDraft = { ...(input.graphicTimingV2 ? { graphicTimingV2: structuredClone(input.graphicTimingV2) } : {}), graphicCadence: input.graphicCadence ?? "legacy", title: input.title, kicker: input.kicker ?? "", subtitle: input.subtitle ?? "", previousText: input.previousText ?? "",
    ...(input.templateId === "strike_reframe" && !design ? { strikePresentation: input.strikePresentation ?? "legacy_layout", brandMark: input.brandMark ?? "",
      ...(input.strikeSurface === undefined ? {} : { strikeSurface: input.strikeSurface }) } : {}),
    ...(design ? { brandMark: input.brandMark ?? "", accentText: input.accentText ?? "", ...(input.templateId === "strike_reframe" ? { tag: input.tag ?? "" } : {}) } : {}),
    primaryLabel: input.primaryLabel ?? "", items: (input.items ?? []).map(item => ({ label: item.label, detail: item.detail ?? "" })),
    networkLabels: input.network?.labels ? [input.network.labels[0], input.network.labels[1], input.network.labels[2]] : ["", "", ""], hubLabel: input.network?.hubLabel ?? "",
    palette: { ...input.style.palette }, typography: { ...input.style.typography } };
  if (referenceMotionTextPositionSupported(instance, draft)) draft.textPosition = referenceMotionTextPosition(input.textRegion);
  return draft;
}

const changed = (next: string | undefined, saved: string | undefined) => (next ?? "").trim() !== (saved ?? "").trim();
const orNull = (value: string | undefined) => (value ?? "").trim() || null;

/** Only supported graphic revisions leave this editor; source windows and topology never do. */
export function referenceMotionInstanceDraftPatch(instance: EditableInstance, draft: ReferenceMotionInstanceDraft): ReferenceMotionTemplateRevisionPatch {
  if (draft.items.length !== (instance.input.items?.length ?? 0)) throw new Error("模板重點數與順序必須保留。");
  const labels = draft.networkLabels.map(value => value.trim());
  if (instance.input.network && labels.some(Boolean) && !labels.every(Boolean)) throw new Error("能力標籤須填滿三個，或全部清除。");
  const accentConflict = referenceMotionAccentConflict(instance, draft);
  // A text change never drops the accent word silently: the creator removes it or puts it back in the title first.
  if (accentConflict) throw new Error(`重點字「${accentConflict}」不在標題裡；請改重點字，或按「拿掉重點字」。`);
  const input = instance.input, design = isDesign(instance);
  const position = referenceMotionTextPositionSupported(instance, draft) ? draft.textPosition : undefined;
  return { ...(JSON.stringify(draft.graphicTimingV2) !== JSON.stringify(input.graphicTimingV2) ? { graphicTimingV2: draft.graphicTimingV2 ?? null } : {}),
    ...(draft.graphicCadence !== (input.graphicCadence ?? "legacy") ? { graphicCadence: draft.graphicCadence } : {}),
    ...(input.templateId === "strike_reframe" && !design ? {
      ...(draft.strikePresentation !== undefined && draft.strikePresentation !== (input.strikePresentation ?? "legacy_layout")
        ? { strikePresentation: draft.strikePresentation } : {}),
      ...(instance.authoringGeneration === 2 && draft.strikePresentation === "semantic_replace_v1" && draft.strikeSurface !== undefined
        && draft.strikeSurface !== (input.strikeSurface ?? "standalone") ? { strikeSurface: draft.strikeSurface } : {}),
      ...(draft.strikePresentation === "semantic_replace_v1" && (draft.brandMark ?? "") !== (input.brandMark ?? "")
        ? { brandMark: draft.brandMark || null } : {}),
    } : {}),
    ...(design ? {
      ...(changed(draft.accentText, input.accentText) ? { accentText: orNull(draft.accentText) } : {}),
      ...(input.templateId === "strike_reframe" && changed(draft.tag, input.tag) ? { tag: orNull(draft.tag) } : {}),
      ...(changed(draft.brandMark, input.brandMark) ? { brandMark: orNull(draft.brandMark) } : {}),
    } : {}),
    ...(position !== undefined && position !== "custom" && position !== referenceMotionTextPosition(input.textRegion)
      ? { textRegion: position === "default" ? null : { ...REFERENCE_MOTION_TEXT_POSITIONS[position] } } : {}),
    title: draft.title, kicker: draft.kicker || null, subtitle: draft.subtitle || null,
    ...(input.templateId === "strike_reframe" ? { previousText: draft.previousText || null } : {}),
    ...(input.sources.length ? { primaryLabel: draft.primaryLabel || null } : {}),
    ...(input.items ? { items: draft.items.map(item => ({ label: item.label, detail: item.detail || null })) } : {}),
    ...(input.network ? { network: { labels: labels.every(Boolean) ? [labels[0], labels[1], labels[2]] : null, hubLabel: draft.hubLabel || null } } : {}),
    style: { palette: { ...draft.palette }, typography: { ...draft.typography } } };
}

/** What the template's check means for the creator, in plain words (the engine's own reason is kept out of sight). */
export function plainReferenceMotionInspection(inspection: Pick<Inspection, "status" | "reason"> | undefined): string {
  if (!inspection) return "正在核對模板和字型…";
  if (inspection.status === "CURRENT") return "可以修改文字、字型和配色。";
  if (inspection.status === "MISSING") return "模板的一部分或影片不見了，不能直接改字；可以重新套用，或解除模板連結、保留畫面。";
  if (inspection.status === "ENVIRONMENT_CHANGED") return "這個模板或字型的版本已經更新，要重新套用後才能改字。";
  const reason = inspection.reason;
  if (reason.includes("external keyframe or enabled mask")) return "主片段上另外加了動畫或遮罩，模板暫時不能改字。";
  if (reason.includes("generated template track contains an external clip")) return "模板自己的軌道裡多了別的片段，模板暫時不能改字。";
  if (reason.includes("external clip depends")) return "有別的片段依附在這個模板上，模板暫時不能改字。";
  if (reason.includes("another instance owner")) return "這些圖層同時屬於另一個模板，模板暫時不能改字。";
  if (reason.includes("malformed")) return "模板資料不完整，不能再改字；可以解除模板連結，保留畫面。";
  return "主片段或模板裡的字和圖被改過，模板還是原來的樣子。";
}

const seconds = (frames: number, fps: number) => (Math.abs(frames / fps) < 0.005 ? 0 : frames / fps).toFixed(2);

export interface ReferenceMotionUiPreparationOptions {
  project: EditProject; session: ProjectSession; controller: AbortController;
  isMounted: () => boolean; action: string;
  /** templatesUpdate: 「把標題更新到新版」's own report, said instead of the single-template message and published. */
  prepare: (prepareText: MotionTemplateTextPreparer["prepareText"], signal: AbortSignal) => Promise<{ status: "REVIEW_REQUIRED" | "UNCHANGED" | "PREPARED_NOT_APPLIED"; commands: EditorCommand[]; preparedMedia?: PrepareMediaResult[]; pickedMedia?: PickedMedia[];
    templatesUpdate?: Pick<ReferenceMotionTemplatesUpdate, "updated" | "notUpdated" | "message"> }>;
  onCommand: (command: EditorCommand, message?: string, context?: EditorCommandContext) => boolean | void;
  successMessage?: string;
  onPrepared?: (prepared: { preparedMedia?: PrepareMediaResult[]; pickedMedia?: PickedMedia[] }) => void;
  onStatus: (message: string) => void;
  createTextPreparer?: typeof createMotionTemplateTextPreparer;
}

/** Plain names for the operation, for hosts that still pass the older engineering label. */
const PLAIN_ACTIONS: Readonly<Record<string, string>> = { "Motion 模板準備": "更新標題模板" };

/** Own the actual preparation until it settles; cancellation never commits an older content owner. */
export async function runReferenceMotionUiPreparation(options: ReferenceMotionUiPreparationOptions): Promise<"APPLIED" | "UNCHANGED" | "CANCELLED" | "STALE" | "FAILED"> {
  const { project, session, controller, onStatus } = options, action = PLAIN_ACTIONS[options.action] ?? options.action;
  const task = session.beginTask(project);
  if (!acceptProjectTask(task, onStatus, action)) return "STALE";
  const unsubscribe = session.subscribe(() => { if (!task.isCurrent()) controller.abort(); });
  let provider: MotionTemplateTextPreparer | undefined;
  try {
    if (controller.signal.aborted || !options.isMounted()) return "CANCELLED";
    provider = (options.createTextPreparer ?? createMotionTemplateTextPreparer)({ signal: controller.signal });
    const prepared = await options.prepare(provider.prepareText, controller.signal);
    if (!options.isMounted()) return "CANCELLED";
    if (!task.isCurrent()) { acceptProjectTask(task, onStatus, action); return "STALE"; }
    if (controller.signal.aborted) return "CANCELLED";
    const report = prepared.templatesUpdate;
    if (prepared.status === "UNCHANGED") {
      if (prepared.commands.length) throw new Error("標題模板沒有更新成功；請再試一次。");
      onStatus(report?.message ?? "模板沒有變更，不用再套用。");
      if (report) publishTemplatesUpdateReport(project.id, report);
      return "UNCHANGED";
    }
    if (!prepared.commands.length) throw new Error("標題模板沒有更新成功；請再試一次。");
    const accepted = options.onCommand({ type: "batch", commands: prepared.commands },
      report?.message ?? options.successMessage ?? "已更新標題模板；文字、字型和配色還可以再改，一次復原即可還原。改完記得看一次成片。",
      referenceMotionUiCommitContext(project, prepared));
    if (accepted === false) return "FAILED";
    options.onPrepared?.(prepared);
    if (report) publishTemplatesUpdateReport(project.id, report);
    return "APPLIED";
  } catch (error) {
    if (!options.isMounted()) return "CANCELLED";
    if (!task.isCurrent()) { acceptProjectTask(task, onStatus, action); return "STALE"; }
    if (controller.signal.aborted) return "CANCELLED";
    onStatus(error instanceof Error ? error.message : "標題模板沒有更新成功；請再試一次。"); return "FAILED";
  } finally { unsubscribe(); provider?.dispose(); }
}

/** Whether 「依目前片段重新套用」 can lay the template out again on its main clip as it is now (a dry run, nothing kept). */
export interface ReferenceMotionReapplyCheck {
  state: "CHECKING" | "READY" | "BLOCKED";
  /** Plain words: why it cannot, when BLOCKED. */
  reason?: string;
}

export function SavedReferenceMotionInstanceForm({ instance, assets, inspection, draft, onDraftChange, busy, onRevise, onDetach, onCancel, clipName, onReapply, reapply, updateAll }: {
  instance: EditableInstance; assets: readonly MediaAsset[]; inspection?: Pick<Inspection, "status" | "reason">;
  draft: ReferenceMotionInstanceDraft; onDraftChange: (draft: ReferenceMotionInstanceDraft) => void;
  busy: boolean; onRevise: (patch: ReferenceMotionTemplateRevisionPatch) => void; onDetach: () => void; onCancel: () => void;
  /** The main clip's media name, shown instead of its internal ID. */
  clipName?: string;
  /** 「依目前片段重新套用」 for a template that went out of date; the check says whether it can and why not. */
  onReapply?: () => void; reapply?: ReferenceMotionReapplyCheck;
  /** 「把標題更新到新版」 for every title an Editkin update left behind, offered on each of them (`count` in all). */
  updateAll?: { count: number; running: boolean; onUpdate: () => void };
}) {
  const { mode } = useI18n();
  const input = instance.input, current = inspection?.status === "CURRENT", recipe = referenceMotionTemplate(input.templateId);
  const design = isDesign(instance), fps = instance.frameFormat?.fps ?? 30;
  const accentConflict = referenceMotionAccentConflict(instance, draft);
  const tagLimit = REFERENCE_MOTION_DESIGN_CONTRACT.tagMaxCodepoints;
  const showPosition = referenceMotionTextPositionSupported(instance, draft);
  const ready = Boolean(draft.title.trim()) && draft.items.every(item => item.label.trim())
    && (input.templateId !== "strike_reframe" || Boolean(draft.previousText.trim()))
    && (input.templateId !== "strike_reframe" || Array.from((draft.brandMark ?? "").trim()).length <= 16)
    && (!design || Array.from((draft.brandMark ?? "").trim()).length <= 16)
    && (!design || Array.from((draft.accentText ?? "").trim()).length <= 12)
    && (draft.tag === undefined || Array.from(draft.tag.trim()).length <= tagLimit)
    && !accentConflict
    && (!input.sources.length || Boolean(draft.primaryLabel.trim()))
    && (!input.network || draft.networkLabels.every(value => !value.trim()) || draft.networkLabels.every(value => value.trim()));
  const copy = (key: "title" | "kicker" | "subtitle" | "previousText" | "primaryLabel" | "hubLabel" | "brandMark" | "accentText" | "tag", value: string) => {
    if (!busy && current) onDraftChange({ ...draft, [key]: value });
  };
  const statusText = !inspection ? "正在檢查模板…" : ({ CURRENT: "一切正常", EDITED: "要重新套用才能改字", MISSING: "模板少了東西", ENVIRONMENT_CHANGED: "模板或字型更新了" })[inspection.status];
  const positions: Array<[ReferenceMotionTextPosition, string]> = [["default", "模板原本位置"], ["top", "畫面上方"], ["middle", "畫面中間"], ["bottom", "畫面下方"]];
  const reapplyBlocked = reapply?.state === "BLOCKED";
  return <section className="floating-source-slots saved-template-form" data-testid="saved-reference-motion-instance" data-instance-id={instance.id} data-instance-revision={instance.instanceRevision}>
    {/* The saved version number means nothing to a creator: simple mode shows only the template's name; advanced mode
        keeps the number in the heading's tooltip (and data-instance-revision above, for support). */}
    <h3 data-testid="saved-template-heading" title={mode === "advanced" ? uiText("版本 {revision}", { revision: instance.instanceRevision }) : undefined}>{recipe.name}</h3>
    {/* The engine's own reason stays out of sight (data-engine-reason, for support); the creator reads plain words. */}
    <p role="status" data-testid="reference-instance-status" data-status={inspection?.status} data-engine-reason={inspection && !current ? inspection.reason : undefined}>
      <strong>{uiText(statusText)}</strong>{" "}{uiText(plainReferenceMotionInspection(inspection))}</p>
    {inspection && !current && updateAll && <div className="saved-template-reapply saved-template-update" data-testid="saved-template-update">
      <button type="button" data-testid="update-reference-motion-templates" aria-describedby={`saved-template-update-note-${instance.id}`}
        disabled={busy || updateAll.running} onClick={() => { if (!busy && !updateAll.running) updateAll.onUpdate(); }}>
        {updateAll.running ? uiText("正在更新…") : uiText("把標題更新到新版")}</button>
      <span id={`saved-template-update-note-${instance.id}`} data-testid="saved-template-update-note">{updateAll.count === 1
        ? uiText("這個標題會照新版重新排好；文字、字型和配色都保留。")
        : uiText("專案裡 {count} 個舊版標題會一起更新；文字、字型和配色都保留。", { count: updateAll.count })}</span>
    </div>}
    {inspection && !current && onReapply && <div className="saved-template-reapply" data-testid="saved-template-reapply" data-state={reapply?.state ?? "READY"}>
      <button type="button" data-testid="reapply-reference-motion-instance" aria-describedby={`saved-template-reapply-reason-${instance.id}`}
        disabled={busy || reapplyBlocked} onClick={() => { if (!busy && !reapplyBlocked) onReapply(); }}>{uiText("依目前片段重新套用")}</button>
      <span id={`saved-template-reapply-reason-${instance.id}`} data-testid="saved-template-reapply-reason">
        {reapplyBlocked ? translateUiStatus(reapply?.reason ?? "模板沒辦法照目前的片段重新排好。")
          : reapply?.state === "CHECKING" ? uiText("正在檢查能不能照目前的片段重新套用…")
            : uiText("按下後，模板會照目前片段的位置和長度重新排好；文字、字型和配色都保留。")}</span>
    </div>}
    <small>{uiText("可以改文字、字型、配色和動態節奏；片段、聲音和重點的順序不會變。改完記得看一次成片。")}</small>
    <dl data-testid="reference-instance-source-windows"><dt>{uiText("主片段")}</dt><dd>{clipName ?? uiText("找不到主片段")}</dd><dt>{uiText("時間")}</dt>
      <dd>{uiText("從 {start} 秒開始，長 {duration} 秒", { start: seconds(input.startFrame, fps), duration: seconds(input.durationFrames, fps) })}</dd>
      {input.sources.map((source, index) => <div key={`${index}-${source.assetId}`}><dt>{uiText("素材")}{index + 2}</dt><dd>{assets.find(asset => asset.id === source.assetId)?.name ?? uiText("缺少素材")} · {uiText("從 {seconds} 秒開始", { seconds: source.sourceStart.toFixed(2) })} · {source.label}</dd></div>)}
    </dl>
    <fieldset disabled={busy || !current} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
      <label>{uiText("圖卡節奏")}<select aria-label={uiText("已儲存模板圖卡節奏")} value={draft.graphicCadence} onChange={event => {
        if (!busy && current) onDraftChange({ ...draft, graphicCadence: event.target.value as ReferenceMotionInstanceDraft["graphicCadence"] });
      }}><option value="kinetic">{uiText("流暢動態")}</option><option value="brisk">{uiText("俐落動態")}</option><option value="legacy">{uiText("保留舊版節奏")}</option></select></label>
      <GraphicTimingControlsV2 value={draft.graphicTimingV2} disabled={busy || !current} onChange={graphicTimingV2 => {
        if (!busy && current) onDraftChange({ ...draft, graphicTimingV2 });
      }} />
      <label>{uiText("主標題")}<input aria-label={uiText("已儲存模板主標題")} data-testid="saved-template-title" maxLength={32} value={draft.title} onChange={event => copy("title", event.target.value)} /></label>
      {design && <label>{uiText("重點字")}<input aria-label={uiText("已儲存模板重點字")} data-testid="saved-template-accent" maxLength={12} value={draft.accentText ?? ""} onChange={event => copy("accentText", event.target.value)} />
        <small>{uiText("標題裡要換成重點色的字，要是標題裡有的字；不填就不變色。")}</small></label>}
      {accentConflict && <div className="saved-template-warning" role="alert" data-testid="saved-template-accent-warning">
        <strong>{uiText("重點字「{word}」不在標題裡", { word: accentConflict })}</strong>
        <span>{uiText("改了標題之後，這個重點字會被拿掉。要保留，請把它放回標題，或改成標題裡的字。")}</span>
        <button type="button" data-testid="saved-template-drop-accent" disabled={busy || !current} onClick={() => copy("accentText", "")}>{uiText("拿掉重點字")}</button>
      </div>}
      {design && input.templateId === "strike_reframe" && <label>{uiText("圖片標籤")}<input aria-label={uiText("已儲存模板圖片標籤")} data-testid="saved-template-tag" maxLength={16} value={draft.tag ?? ""} onChange={event => copy("tag", event.target.value)} />
        <small>{uiText("貼在畫面上的短標籤，最多 {count} 個字；不填就不顯示。", { count: tagLimit })}</small></label>}
      <label>{uiText("眉題")}<input aria-label={uiText("已儲存模板眉題")} maxLength={24} value={draft.kicker} onChange={event => copy("kicker", event.target.value)} /></label>
      <label>{uiText("補充短句")}<input aria-label={uiText("已儲存模板補充短句")} maxLength={40} value={draft.subtitle} onChange={event => copy("subtitle", event.target.value)} /></label>
      {input.templateId === "strike_reframe" && <>
        {!design && <label>{uiText("換句方式")}<select aria-label={uiText("已儲存模板刪線呈現")} value={draft.strikePresentation ?? "legacy_layout"} onChange={event => {
          const value = event.target.value;
          if (!busy && current && (value === "legacy_layout" || value === "semantic_replace_v1")) {
            onDraftChange({ ...draft, strikePresentation: value });
          }
        }}><option value="legacy_layout">{uiText("保留舊版排版")}</option><option value="semantic_replace_v1">{uiText("舊句子退場，重點在原位出現")}</option></select></label>}
        <label>{uiText("要刪去的原句")}<input aria-label={uiText("已儲存模板刪線原句")} maxLength={24} value={draft.previousText} onChange={event => copy("previousText", event.target.value)} /></label>
        {!design && draft.strikePresentation === "semantic_replace_v1" && <>
          {instance.authoringGeneration === 2 && <label>{uiText("畫面用途")}<select aria-label={uiText("已儲存刪線畫面用途")} value={draft.strikeSurface ?? "standalone"} onChange={event => {
            const value = event.target.value;
            if (!busy && current && (value === "standalone" || value === "source_overlay" || value === "source_overlay_v2")) onDraftChange({ ...draft, strikeSurface: value });
          }}><option value="standalone">{uiText("原創圖形場景")}</option><option value="source_overlay">{uiText("在原素材上提示")}</option><option value="source_overlay_v2">{uiText("實拍留白直接上字（無底框）")}</option></select>
            <small>{uiText("沒改就照原本的設定。「在原素材上提示」會保留整個畫面，只在字後面加一點底色。")}</small></label>}
          <label>{uiText("品牌短字")}<input aria-label={uiText("已儲存模板品牌短字")} maxLength={32} value={draft.brandMark ?? ""} onChange={event => copy("brandMark", event.target.value)} />
            <small>{uiText("最多 16 個字。這是可以改的文字，不是 Logo 圖片；用別人的名稱前，請先確認可以使用。")}</small></label>
        </>}
      </>}
      {design && <label>{uiText("品牌短字")}<input aria-label={uiText("已儲存模板品牌短字")} maxLength={32} value={draft.brandMark ?? ""} onChange={event => copy("brandMark", event.target.value)} />
        <small>{uiText("最多 16 個字。這是可以改的文字，不是 Logo 圖片；用別人的名稱前，請先確認可以使用。")}</small></label>}
      {showPosition && <div className="saved-template-position" role="group" aria-label={uiText("文字位置")} data-testid="saved-template-position">
        <span>{uiText("文字位置")}</span>
        <div>{positions.map(([value, label]) => <button type="button" key={value} aria-pressed={(draft.textPosition ?? "default") === value} data-testid={`saved-template-position-${value}`}
          disabled={busy || !current} onClick={() => { if (!busy && current) onDraftChange({ ...draft, textPosition: value }); }}>{uiText(label)}</button>)}
          {draft.textPosition === "custom" && <button type="button" aria-pressed={true} disabled data-testid="saved-template-position-custom">{uiText("自訂位置")}</button>}</div>
        <small>{uiText("白字會放在你選的區域；如果那裡太亮或字放不下，更新時會說明原因，原本的模板不會被改。")}</small>
      </div>}
      {input.sources.length > 0 && <label>{uiText("原片短標籤")}<input aria-label={uiText("已儲存模板原片標籤")} maxLength={20} value={draft.primaryLabel} onChange={event => copy("primaryLabel", event.target.value)} /></label>}
      {draft.items.map((item, index) => <div key={index}><label>{uiText("重點")}{index + 1}<input aria-label={uiText("已儲存模板重點 {value0}", { value0: index + 1 })} maxLength={24} value={item.label} onChange={event => { if (!busy && current) onDraftChange({ ...draft, items: draft.items.map((row, i) => i === index ? { ...row, label: event.target.value } : row) }); }} /></label>
        <label>{uiText("補充")}<input aria-label={uiText("已儲存模板重點補充 {value0}", { value0: index + 1 })} maxLength={40} value={item.detail} onChange={event => { if (!busy && current) onDraftChange({ ...draft, items: draft.items.map((row, i) => i === index ? { ...row, detail: event.target.value } : row) }); }} /></label></div>)}
      {input.network && <div>{draft.networkLabels.map((label, index) => <label key={index}>{uiText("能力")}{index + 1}<input aria-label={uiText("已儲存模板能力 {value0}", { value0: index + 1 })} maxLength={6} value={label} onChange={event => { if (!busy && current) onDraftChange({ ...draft, networkLabels: draft.networkLabels.map((row, i) => i === index ? event.target.value : row) as [string, string, string] }); }} /></label>)}
        <label>{uiText("連結中心")}<input aria-label={uiText("已儲存模板連結中心")} maxLength={6} value={draft.hubLabel} onChange={event => copy("hubLabel", event.target.value)} /></label></div>}
      {(["headingFamily", "bodyFamily"] as const).map(key => <label key={key}>{key === "headingFamily" ? uiText("標題字型") : uiText("內文字型")}<select aria-label={key === "headingFamily" ? uiText("已儲存模板標題字型") : uiText("已儲存模板內文字型")} value={draft.typography[key]} onChange={event => { if (!busy && current) onDraftChange({ ...draft, typography: { ...draft.typography, [key]: event.target.value } }); }}>{bundledFontFamilies().map(family => <option key={family}>{family}</option>)}</select></label>)}
      {(["surface", "text", "accent", "muted", "separator"] as const).map(key => <label key={key}>{({ surface: uiText("底色"), text: uiText("文字色"), accent: uiText("重點色"), muted: uiText("次要文字"), separator: uiText("面板色") })[key]}<input aria-label={uiText("已儲存模板配色 {value0}", { value0: key })} type="color" value={draft.palette[key]} onChange={event => { if (!busy && current) onDraftChange({ ...draft, palette: { ...draft.palette, [key]: event.target.value } }); }} /></label>)}
      <button type="button" data-testid="revise-reference-motion-instance" disabled={busy || !current || !ready} onClick={() => { if (!busy && current && ready) onRevise(referenceMotionInstanceDraftPatch(instance, draft)); }}>{uiText("套用修改")}</button>
    </fieldset>
    <button type="button" data-testid="detach-reference-motion-instance" disabled={busy} onClick={() => { if (!busy) onDetach(); }}>{uiText("解除模板連結（畫面保留）")}</button>
    {busy && <button type="button" data-testid="cancel-reference-motion-instance" onClick={onCancel}>{uiText("取消")}</button>}
  </section>;
}

function InstanceEditor(props: Omit<Parameters<typeof SavedReferenceMotionInstanceForm>[0], "draft" | "onDraftChange">) {
  useI18n();
  const [draft, setDraft] = useState(() => referenceMotionInstanceDraft(props.instance));
  return <SavedReferenceMotionInstanceForm {...props} draft={draft} onDraftChange={setDraft} />;
}

/** Display candidates only; the producer independently verifies the actual target. */
export function referenceMotionReuseTargetChoices(project: EditProject, instance: EditableInstance): Array<{ clip: TimelineClip; asset: MediaAsset; trackName: string }> {
  if (!Number.isFinite(project.fps) || project.fps <= 0 || project.fps > 240) return [];
  const ownedClips = new Set((project.referenceMotionInstances ?? []).flatMap(saved => [saved.input.clipId,
    ...saved.roles.filter(role => role.kind === "clip").map(role => role.id)]));
  for (const clip of project.templateApplication?.generatedClips ?? []) ownedClips.add(clip.clipId);
  for (const clip of project.templateApplication?.applied.clips ?? []) ownedClips.add(clip.clipId);
  ownedClips.add(instance.input.clipId);
  const original = project.tracks.flatMap(track => track.clips).find(clip => clip.id === instance.input.clipId);
  const originalAsset = project.assets.find(asset => asset.id === original?.assetId);
  const sourceUri = (uri: string) => { try { return referenceMotionReuseSourceIdentity(uri); } catch { return undefined; } };
  const recipe = referenceMotionTemplate(instance.input.templateId);
  return project.tracks.filter(track => track.kind === "video" && !track.locked && !track.hidden).flatMap(track => track.clips.flatMap(clip => {
    const asset = project.assets.find(item => item.id === clip.assetId);
    if (ownedClips.has(clip.id) || clip.layer?.enabled === false || (clip.layer?.role !== undefined && clip.layer.role !== "content")
      || !asset || asset.kind !== "video" || asset.compositionId || asset.imageSequence || !Number.isFinite(asset.duration) || asset.duration <= 0
      || !originalAsset || asset.id === originalAsset.id || sourceUri(asset.uri) === undefined || sourceUri(asset.uri) === sourceUri(originalAsset.uri)
      || (asset.derivatives?.sourceSha256 !== undefined && asset.derivatives.sourceSha256 === originalAsset.derivatives?.sourceSha256)
      || !asset.uri.trim() || !referenceMotionTemplateSourceColorAdmitted(project, asset, isNativeReferenceMotionPresentation(instance.input.graphicPresentation)) || !Number.isFinite(clip.duration) || clip.duration < recipe.minSeconds
      || !Number.isFinite(clip.timelineStart) || clip.timelineStart < 0 || !Number.isFinite(clip.sourceStart) || clip.sourceStart < 0
      || clip.sourceStart + clip.duration > asset.duration + 1e-6
      || [clip.timelineStart, clip.duration, clip.sourceStart].some(value => !Number.isSafeInteger(Math.round(value * project.fps))
        || Math.abs(value * project.fps - Math.round(value * project.fps)) > 1e-7)
      || project.motionGraphics.some(graphic => graphic.timelineStart < clip.timelineStart + clip.duration && graphic.timelineStart + graphic.duration > clip.timelineStart)) return [];
    return [{ clip, asset, trackName: track.name }];
  }));
}

interface ReferenceMotionReuseDraft {
  targetClipId: string; purpose: string;
  sources: Array<{ assetId: string; sourceStart: string; label: string }>;
}

/** A separate draft owner: it never reads or submits the revision editor draft. */
export function SavedReferenceMotionReuseForm({ project, instance, inspection, busy, onReuse, onCancel }: {
  project: EditProject; instance: EditableInstance; inspection?: Pick<Inspection, "status" | "reason">;
  busy: boolean; onReuse: (request: ReferenceMotionTemplateReuseRequest) => void; onCancel: () => void;
}) {
  useI18n();
  const recipe = referenceMotionTemplate(instance.input.templateId);
  const slotCount = instance.input.templateId === "focus_wall" ? instance.input.sources.length : recipe.sourceSlots;
  const [draft, setDraft] = useState<ReferenceMotionReuseDraft>(() => ({ targetClipId: "", purpose: "",
    sources: Array.from({ length: slotCount }, () => ({ assetId: "", sourceStart: "", label: "" })) }));
  const current = inspection?.status === "CURRENT", targets = referenceMotionReuseTargetChoices(project, instance);
  const target = targets.find(item => item.clip.id === draft.targetClipId);
  const sourceUri = (uri: string) => { try { return referenceMotionReuseSourceIdentity(uri); } catch { return undefined; } };
  const assets = project.assets.filter(asset => asset.kind === "video" && !asset.compositionId && !asset.imageSequence
    && asset.id !== target?.asset.id && sourceUri(asset.uri) !== undefined && sourceUri(asset.uri) !== (target ? sourceUri(target.asset.uri) : undefined)
    && !(target?.asset.derivatives?.sourceSha256 && asset.derivatives?.sourceSha256 === target.asset.derivatives.sourceSha256)
    && asset.uri.trim() && referenceMotionTemplateSourceColorAdmitted(project, asset, isNativeReferenceMotionPresentation(instance.input.graphicPresentation)));
  const selectedUris = draft.sources.map(slot => assets.find(asset => asset.id === slot.assetId)).map(asset => asset ? sourceUri(asset.uri) : undefined);
  const selectedPins = draft.sources.flatMap(slot => {
    const pin = assets.find(asset => asset.id === slot.assetId)?.derivatives?.sourceSha256;
    return pin ? [pin] : [];
  });
  const ready = Boolean(target) && Boolean(draft.purpose.trim()) && draft.purpose.trim().length <= 160
    && draft.sources.length === slotCount && new Set(draft.sources.map(slot => slot.assetId)).size === slotCount
    && selectedUris.every(uri => uri !== undefined) && new Set(selectedUris).size === selectedUris.length && new Set(selectedPins).size === selectedPins.length
    && draft.sources.every(slot => {
      const asset = assets.find(item => item.id === slot.assetId), start = Number(slot.sourceStart);
      return Boolean(asset) && Boolean(slot.label.trim()) && slot.label.trim().length <= 20 && Boolean(slot.sourceStart.trim())
        && Number.isFinite(start) && start >= 0 && Number.isSafeInteger(Math.round(start * project.fps))
        && Math.abs(start * project.fps - Math.round(start * project.fps)) <= 1e-7
        && start + (target?.clip.duration ?? Infinity) <= asset!.duration + 1e-6;
    });
  const copy = (key: "targetClipId" | "purpose", value: string) => {
    if (!busy && current) setDraft(valueBefore => ({ ...valueBefore, [key]: value }));
  };
  const slot = (index: number, patch: Partial<ReferenceMotionReuseDraft["sources"][number]>) => {
    if (!busy && current) setDraft(valueBefore => ({ ...valueBefore, sources: valueBefore.sources.map((item, i) => i === index ? { ...item, ...patch } : item) }));
  };
  return <section data-testid="saved-reference-motion-reuse" style={{ marginTop: 16, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
    <h3>{uiText("套用到另一段素材")}</h3>
    <p>{uiText("套用已保存版本，不含未保存修改。建立獨立的新模板，原模板與原片段保持不變。")}</p>
    <fieldset disabled={busy || !current} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }} aria-busy={busy}>
      <label>{uiText("要套用的片段")}<select aria-label={uiText("模板重用目標片段")} value={draft.targetClipId} onChange={event => copy("targetClipId", event.target.value)}>
        <option value="">{uiText("選擇另一段已匯入的影片")}</option>
        {targets.map(({ clip, asset, trackName }) => <option key={clip.id} value={clip.id}>{asset.name} · {trackName} · {uiText("{start} 秒起 · {duration} 秒", { start: clip.timelineStart.toFixed(2), duration: clip.duration.toFixed(2) })}</option>)}
      </select></label>
      {!targets.length && <p role="status">{uiText("沒有可以套用的片段；請先加入另一段夠長、沒有鎖定、上面也沒有其他標題的影片。")}</p>}
      {target && <small>{uiText("使用整段片段：從 {start} 秒開始，長 {duration} 秒。原片入點與音訊速度保持。", { start: target.clip.timelineStart.toFixed(2), duration: target.clip.duration.toFixed(2) })}</small>}
      <label>{uiText("這次的用途")}<input aria-label={uiText("模板重用新用途")} maxLength={160} placeholder={uiText("例如：用新作品示範同一個重點")} value={draft.purpose} onChange={event => copy("purpose", event.target.value)} /></label>
      <small>{uiText("會記錄這次選取的片段；素材授權仍需自行確認，完成後請看一次成片。")}</small>
      {draft.sources.map((source, index) => <div key={index}>
        <label>{uiText("額外素材")}{index + 1}<select aria-label={uiText("模板重用素材 {value0}", { value0: index + 1 })} value={source.assetId} onChange={event => slot(index, { assetId: event.target.value })}>
          <option value="">{uiText("重新選擇這次的素材")}</option>{assets.map(asset => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
        </select></label>
        <label>{uiText("從素材第幾秒開始")}<input aria-label={uiText("模板重用入點 {value0}", { value0: index + 1 })} type="number" min={0} step={1 / project.fps} value={source.sourceStart} onChange={event => slot(index, { sourceStart: event.target.value })} /></label>
        <label>{uiText("素材短標籤")}<input aria-label={uiText("模板重用標籤 {value0}", { value0: index + 1 })} maxLength={20} value={source.label} onChange={event => slot(index, { label: event.target.value })} /></label>
      </div>)}
      <small>{uiText("另外的素材和開始秒數都要重新選；舊的選擇不會帶過來，沒選取景時用整個畫面。做好後記得看一次成片。")}</small>
      <button type="button" data-testid="reuse-reference-motion-instance" disabled={busy || !current || !ready} onClick={() => {
        if (busy || !current || !ready || !target) return;
        onReuse(referenceMotionManualReuseRequest(project, { sourceInstanceId: instance.id, expectedInstanceRevision: instance.instanceRevision, expectedProjectRevision: project.revision,
          targetClipId: target.clip.id, purpose: draft.purpose.trim(),
          sources: draft.sources.map(source => ({ assetId: source.assetId, sourceStart: Number(source.sourceStart), label: source.label.trim() })) }));
      }}>{uiText("建立新模板並套用")}</button>
    </fieldset>
    {busy && <button type="button" className="secondary-action" data-testid="cancel-reference-motion-reuse" onClick={onCancel}>{uiText("取消")}</button>}
  </section>;
}

/** Reopen is a new draft owner even if its saved instance ID and revision match. */
export function referenceMotionInstanceEditorKey(session: ProjectSession, instance: EditableInstance): string {
  return JSON.stringify([session.getSnapshot().sessionId, instance.id, instance.instanceRevision]);
}

function clipNameOf(project: EditProject, clipId: string): string | undefined {
  const clip = project.tracks.flatMap(track => track.clips).find(item => item.id === clipId);
  return clip ? project.assets.find(asset => asset.id === clip.assetId)?.name : undefined;
}

/**
 * Root-reachable metadata manager: it does not require a surviving selected clip. It also opens on request from the
 * timeline, the main clip's Inspector, the Motion studio or a title in the preview, selects that template and puts
 * the cursor in its title. Escape closes it and gives the keyboard back to whatever opened it. For a template that went
 * out of date it checks, without changing anything, whether 「依目前片段重新套用」 can lay it out again on its clip.
 */
export function SavedReferenceMotionInstances({ project, session, busy, onRevise, onDetach, onReuse, onSourceReplace, onCancel, counterTicksControl }: {
  project: EditProject; session: ProjectSession; busy: boolean;
  onRevise: (id: string, patch: ReferenceMotionTemplateRevisionPatch, expectedInstanceRevision: number) => void;
  onReuse?: (request: ReferenceMotionTemplateReuseRequest) => void;
  onSourceReplace?: (request: ReferenceMotionSourceReplacementRequest, picked?: PickedMedia) => void;
  counterTicksControl?: (instance: ReferenceMotionTemplateInstance, current: boolean) => ReactNode;
  onDetach: (id: string, expectedInstanceRevision: number) => void; onCancel: () => void;
}) {
  useI18n();
  const instances = project.referenceMotionInstances ?? [];
  const [selectedId, setSelectedId] = useState(instances[0]?.id);
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const summary = useRef<HTMLElement>(null);
  // Whatever opened the editor (a timeline block, the Inspector, the footer button) gets the keyboard back on close.
  const opener = useRef<HTMLElement | null>(null);
  const selected = instances.find(instance => instance.id === selectedId) ?? instances[0];
  const [observed, setObserved] = useState<{ project: EditProject; instance: ReferenceMotionTemplateInstance; inspection: Inspection }>();
  const [reapplyCheck, setReapplyCheck] = useState<{ project: EditProject; instance: ReferenceMotionTemplateInstance; check: ReferenceMotionReapplyCheck }>();
  const known = useRef(new Set<string>());
  known.current = new Set(instances.map(instance => instance.id));
  const rememberOpener = () => {
    if (opener.current || typeof document === "undefined") return;
    const active = document.activeElement as HTMLElement | null;
    opener.current = active && active !== document.body && typeof active.focus === "function" && !panel.current?.contains(active) ? active : null;
  };
  const close = () => {
    setOpen(false);
    const back = opener.current?.isConnected ? opener.current : summary.current;
    opener.current = null;
    back?.focus?.({ preventScroll: true });
  };
  const closeOnEscape = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || !open) return;
    event.preventDefault(); event.stopPropagation();
    close();
  };
  useEffect(() => subscribeTemplateEditorRequests(request => {
    if (!known.current.has(request.instanceId)) return;
    if (!busy) setSelectedId(request.instanceId);
    rememberOpener();
    setOpen(true);
    // After the panel renders: bring it into view and put the cursor in the title, ready to type.
    const focus = () => {
      const title = panel.current?.querySelector<HTMLInputElement>('[data-testid="saved-template-title"]');
      panel.current?.scrollIntoView?.({ block: "nearest" });
      if (title && !title.disabled) title.focus({ preventScroll: true });
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => requestAnimationFrame(focus)); else focus();
  }), [busy]);
  useEffect(() => {
    if (!selected) return;
    const task = session.beginTask(project); let live = true;
    const unsubscribe = session.subscribe(() => { if (!task.isCurrent()) live = false; });
    void inspectReferenceMotionTemplateInstance(project, selected.id).then(inspection => {
      if (live && task.isCurrent()) setObserved({ project, instance: selected, inspection });
    }).catch(error => {
      if (live && task.isCurrent()) setObserved({ project, instance: selected, inspection: { status: "ENVIRONMENT_CHANGED", reason: error instanceof Error ? error.message : "模板核對失敗。" } });
    });
    return () => { live = false; unsubscribe(); };
  }, [project, selected, session]);
  const inspection = selected && observed?.project === project && observed.instance === selected ? observed.inspection : undefined;
  const stale = inspection !== undefined && inspection.status !== "CURRENT";
  // A dry run of 「依目前片段重新套用」 on the open editor's out-of-date template: the button and its one-line reason.
  useEffect(() => {
    if (!open || !stale || busy || !selected) return;
    const controller = new AbortController(), task = session.beginTask(project);
    const unsubscribe = session.subscribe(() => { if (!task.isCurrent()) controller.abort(); });
    const preparer = createMotionTemplateTextPreparer({ signal: controller.signal });
    let made = 0;
    setReapplyCheck({ project, instance: selected, check: { state: "CHECKING" } });
    void prepareReferenceMotionTemplateReapply(project, selected.id, { prepareText: preparer.prepareText, signal: controller.signal,
      expectedInstanceRevision: selected.instanceRevision, idFactory: prefix => `${prefix}-check-${++made}` })
      .then((): ReferenceMotionReapplyCheck => ({ state: "READY" }), (error): ReferenceMotionReapplyCheck => ({ state: "BLOCKED", reason: plainReferenceMotionRebuildReason(error) }))
      .then(check => { if (!controller.signal.aborted && task.isCurrent()) setReapplyCheck({ project, instance: selected, check }); })
      .finally(() => preparer.dispose());
    return () => { controller.abort(); unsubscribe(); };
  }, [open, stale, busy, project, selected, session]);
  // While the editor is open: which titles an Editkin update left behind and nobody changed since (「把標題更新到新版」).
  const [behind, setBehind] = useState<{ project: EditProject; ids: ReadonlySet<string> }>();
  useEffect(() => {
    if (!open || !instances.length) return;
    const task = session.beginTask(project); let live = true;
    const unsubscribe = session.subscribe(() => { if (!task.isCurrent()) live = false; });
    void referenceMotionTemplatesBehindUpdate(project).then(found => {
      if (live && task.isCurrent()) setBehind({ project, ids: new Set(found.filter(item => !item.editedSince).map(item => item.instance.id)) });
    }, () => undefined);
    return () => { live = false; unsubscribe(); };
  }, [open, project, session, instances.length]);
  if (!selected) return null;
  const reapply = reapplyCheck?.project === project && reapplyCheck.instance === selected ? reapplyCheck.check : undefined;
  // The window's own update runner (the notice host) runs it; without one the button is not offered.
  const outdated = behind?.project === project ? behind.ids : undefined;
  const updateAll = outdated?.has(selected.id) && canRunTemplatesUpdate()
    ? { count: outdated.size, running: templatesUpdateRunning(), onUpdate: () => void requestTemplatesUpdate() } : undefined;
  return <details data-testid="saved-reference-motion-instances" className="saved-template-manager" style={{ position: "relative" }} open={open}
    onToggle={event => { const opened = event.currentTarget.open; if (opened) rememberOpener(); else opener.current = null; setOpen(opened); }}
    onKeyDown={closeOnEscape}>
    <summary ref={summary} aria-label={uiText("打開標題模板編輯器")}>{uiText("標題模板（{count}）", { count: instances.length })}</summary>
    <div ref={panel} className="saved-template-panel" role="dialog" aria-label={uiText("標題模板編輯器")}>
      <header className="saved-template-header"><strong>{uiText("標題模板編輯器")}</strong>
        <button type="button" className="saved-template-close" data-testid="close-saved-template-editor" onClick={close}>{uiText("關閉")}</button></header>
      <label>{uiText("已儲存模板")}<select aria-label={uiText("選擇標題模板")} value={selected.id} disabled={busy} onChange={event => { if (!busy) setSelectedId(event.target.value); }}>{instances.map(instance => <option key={instance.id} value={instance.id}>{instance.input.title} · {referenceMotionTemplate(instance.input.templateId).name}</option>)}</select></label>
      <InstanceEditor key={referenceMotionInstanceEditorKey(session, selected)} instance={selected} assets={project.assets} inspection={inspection} busy={busy}
        clipName={clipNameOf(project, selected.input.clipId)}
        onRevise={patch => onRevise(selected.id, patch, selected.instanceRevision)} onDetach={() => onDetach(selected.id, selected.instanceRevision)} onCancel={onCancel}
        onReapply={() => onRevise(selected.id, referenceMotionTemplateReapplyPatch(), selected.instanceRevision)} reapply={reapply} updateAll={updateAll} />
      {open && counterTicksControl?.(selected, inspection?.status === "CURRENT")}
      {onSourceReplace && <SavedReferenceMotionSourceReplacement key={`source:${referenceMotionInstanceEditorKey(session, selected)}`}
        project={project} instance={selected} session={session} inspection={inspection} busy={busy} api={window.haoDesktop}
        onReplace={onSourceReplace} onCancel={onCancel} />}
      {onReuse && <SavedReferenceMotionReuseForm key={`reuse:${referenceMotionInstanceEditorKey(session, selected)}:${project.revision}`}
        project={project} instance={selected} inspection={inspection} busy={busy} onReuse={onReuse} onCancel={onCancel} />}
    </div>
  </details>;
}
