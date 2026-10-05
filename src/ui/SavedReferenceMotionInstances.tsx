import { useEffect, useState } from "react";
import type { EditorCommand } from "../domain/commands";
import type { ReferenceMotionTemplateInstance, ReferenceMotionTemplateRevisionPatch } from "../domain/referenceMotionInstance";
import type { EditProject, MediaAsset, TimelineClip } from "../domain/types";
import type { ProjectSession } from "../application/projectSession";
import { acceptProjectTask } from "../application/projectTask";
import { inspectReferenceMotionTemplateInstance } from "../application/referenceMotionTemplateInstances";
import { referenceMotionReuseSourceIdentity, type ReferenceMotionTemplateReuseRequest } from "../application/referenceMotionTemplateReuse";
import { referenceMotionTemplate } from "../motion/referenceMotionTemplates";
import { bundledFontFamilies } from "../typography/fontFaces";
import { createMotionTemplateTextPreparer, type MotionTemplateTextPreparer } from "../typography/motionTemplateTextPreparation";

type Inspection = Awaited<ReturnType<typeof inspectReferenceMotionTemplateInstance>>;
type EditableInstance = Pick<ReferenceMotionTemplateInstance, "id" | "instanceRevision" | "authoringGeneration" | "input">;
export interface ReferenceMotionInstanceDraft {
  graphicCadence: NonNullable<ReferenceMotionTemplateInstance["input"]["graphicCadence"]>;
  strikePresentation?: "legacy_layout" | "semantic_replace_v1";
  strikeSurface?: "standalone" | "source_overlay";
  brandMark?: string;
  title: string; kicker: string; subtitle: string; previousText: string; primaryLabel: string;
  items: Array<{ label: string; detail: string }>;
  networkLabels: [string, string, string]; hubLabel: string;
  palette: ReferenceMotionTemplateInstance["input"]["style"]["palette"];
  typography: ReferenceMotionTemplateInstance["input"]["style"]["typography"];
}

export function referenceMotionInstanceDraft(instance: EditableInstance): ReferenceMotionInstanceDraft {
  const input = instance.input;
  return { graphicCadence: input.graphicCadence ?? "legacy", title: input.title, kicker: input.kicker ?? "", subtitle: input.subtitle ?? "", previousText: input.previousText ?? "",
    ...(input.templateId === "strike_reframe" ? { strikePresentation: input.strikePresentation ?? "legacy_layout", brandMark: input.brandMark ?? "",
      ...(input.strikeSurface === undefined ? {} : { strikeSurface: input.strikeSurface }) } : {}),
    primaryLabel: input.primaryLabel ?? "", items: (input.items ?? []).map(item => ({ label: item.label, detail: item.detail ?? "" })),
    networkLabels: input.network?.labels ? [input.network.labels[0], input.network.labels[1], input.network.labels[2]] : ["", "", ""], hubLabel: input.network?.hubLabel ?? "",
    palette: { ...input.style.palette }, typography: { ...input.style.typography } };
}

/** Only the supported revision vocabulary leaves this editor; source/timing/topology never do. */
export function referenceMotionInstanceDraftPatch(instance: EditableInstance, draft: ReferenceMotionInstanceDraft): ReferenceMotionTemplateRevisionPatch {
  if (draft.items.length !== (instance.input.items?.length ?? 0)) throw new Error("模板重點數與順序必須保留。");
  const labels = draft.networkLabels.map(value => value.trim());
  if (instance.input.network && labels.some(Boolean) && !labels.every(Boolean)) throw new Error("能力標籤須填滿三個，或全部清除。");
  return { ...(draft.graphicCadence !== (instance.input.graphicCadence ?? "legacy") ? { graphicCadence: draft.graphicCadence } : {}),
    ...(instance.input.templateId === "strike_reframe" ? {
      ...(draft.strikePresentation !== undefined && draft.strikePresentation !== (instance.input.strikePresentation ?? "legacy_layout")
        ? { strikePresentation: draft.strikePresentation } : {}),
      ...(instance.authoringGeneration === 2 && draft.strikePresentation === "semantic_replace_v1" && draft.strikeSurface !== undefined
        && draft.strikeSurface !== (instance.input.strikeSurface ?? "standalone") ? { strikeSurface: draft.strikeSurface } : {}),
      ...(draft.strikePresentation === "semantic_replace_v1" && (draft.brandMark ?? "") !== (instance.input.brandMark ?? "")
        ? { brandMark: draft.brandMark || null } : {}),
    } : {}),
    title: draft.title, kicker: draft.kicker || null, subtitle: draft.subtitle || null,
    ...(instance.input.templateId === "strike_reframe" ? { previousText: draft.previousText || null } : {}),
    ...(instance.input.sources.length ? { primaryLabel: draft.primaryLabel || null } : {}),
    ...(instance.input.items ? { items: draft.items.map(item => ({ label: item.label, detail: item.detail || null })) } : {}),
    ...(instance.input.network ? { network: { labels: labels.every(Boolean) ? [labels[0], labels[1], labels[2]] : null, hubLabel: draft.hubLabel || null } } : {}),
    style: { palette: { ...draft.palette }, typography: { ...draft.typography } } };
}

export interface ReferenceMotionUiPreparationOptions {
  project: EditProject; session: ProjectSession; controller: AbortController;
  isMounted: () => boolean; action: string;
  prepare: (prepareText: MotionTemplateTextPreparer["prepareText"], signal: AbortSignal) => Promise<{ status: "REVIEW_REQUIRED" | "UNCHANGED"; commands: EditorCommand[] }>;
  onCommand: (command: EditorCommand, message?: string) => boolean | void;
  onStatus: (message: string) => void;
  createTextPreparer?: typeof createMotionTemplateTextPreparer;
}

/** Own the actual preparation until it settles; cancellation never commits an older content owner. */
export async function runReferenceMotionUiPreparation(options: ReferenceMotionUiPreparationOptions): Promise<"APPLIED" | "UNCHANGED" | "CANCELLED" | "STALE" | "FAILED"> {
  const { project, session, controller, action, onStatus } = options;
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
    if (prepared.status === "UNCHANGED") {
      if (prepared.commands.length) throw new Error("未變更的模板不能附帶修改指令。");
      onStatus("模板內容沒有變更；保留目前版本與復原紀錄。"); return "UNCHANGED";
    }
    if (!prepared.commands.length) throw new Error("模板準備缺少實際修改指令。");
    const accepted = options.onCommand({ type: "batch", commands: prepared.commands }, "已更新專案中的 Motion 模板，文字、字型與配色可再修改；可一次復原。仍需審看成片。");
    return accepted === false ? "FAILED" : "APPLIED";
  } catch (error) {
    if (!options.isMounted()) return "CANCELLED";
    if (!task.isCurrent()) { acceptProjectTask(task, onStatus, action); return "STALE"; }
    if (controller.signal.aborted) return "CANCELLED";
    onStatus(error instanceof Error ? error.message : "Motion 模板準備失敗。"); return "FAILED";
  } finally { unsubscribe(); provider?.dispose(); }
}

export function SavedReferenceMotionInstanceForm({ instance, assets, inspection, draft, onDraftChange, busy, onRevise, onDetach, onCancel }: {
  instance: EditableInstance; assets: readonly MediaAsset[]; inspection?: Pick<Inspection, "status" | "reason">;
  draft: ReferenceMotionInstanceDraft; onDraftChange: (draft: ReferenceMotionInstanceDraft) => void;
  busy: boolean; onRevise: (patch: ReferenceMotionTemplateRevisionPatch) => void; onDetach: () => void; onCancel: () => void;
}) {
  const input = instance.input, current = inspection?.status === "CURRENT", recipe = referenceMotionTemplate(input.templateId);
  const ready = Boolean(draft.title.trim()) && draft.items.every(item => item.label.trim())
    && (input.templateId !== "strike_reframe" || Boolean(draft.previousText.trim()))
    && (input.templateId !== "strike_reframe" || Array.from((draft.brandMark ?? "").trim()).length <= 16)
    && (!input.sources.length || Boolean(draft.primaryLabel.trim()))
    && (!input.network || draft.networkLabels.every(value => !value.trim()) || draft.networkLabels.every(value => value.trim()));
  const copy = (key: "title" | "kicker" | "subtitle" | "previousText" | "primaryLabel" | "hubLabel" | "brandMark", value: string) => {
    if (!busy && current) onDraftChange({ ...draft, [key]: value });
  };
  const statusText = !inspection ? "正在核對模板範圍與字型…" : ({ CURRENT: "可更新", EDITED: "圖層已有手動修改", MISSING: "模板圖層或素材已缺少", ENVIRONMENT_CHANGED: "模板或字型環境已變更" })[inspection.status];
  return <section className="floating-source-slots" data-testid="saved-reference-motion-instance" data-instance-id={instance.id} data-instance-revision={instance.instanceRevision}>
    <h3>{recipe.name} · 版本 {instance.instanceRevision}</h3>
    <p role="status" data-testid="reference-instance-status">{statusText}{inspection?.reason ? `：${inspection.reason}` : ""}</p>
    <small>可明確更新圖卡節奏；素材窗口、原片速度、音訊與重點順序保持原設定。重新編譯後須重新審看成片。</small>
    <dl data-testid="reference-instance-source-windows"><dt>原片片段</dt><dd>{input.clipId}</dd><dt>時間</dt><dd>第 {input.startFrame} 格起，{input.durationFrames} 格</dd>
      {input.sources.map((source, index) => <div key={`${index}-${source.assetId}`}><dt>素材 {index + 2}</dt><dd>{assets.find(asset => asset.id === source.assetId)?.name ?? "缺少素材"} · {source.assetId} · 入點 {source.sourceStart} 秒 · {source.label}</dd></div>)}
    </dl>
    <fieldset disabled={busy || !current} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
      <label>圖卡節奏<select aria-label="已儲存模板圖卡節奏" value={draft.graphicCadence} onChange={event => {
        if (!busy && current) onDraftChange({ ...draft, graphicCadence: event.target.value as ReferenceMotionInstanceDraft["graphicCadence"] });
      }}><option value="brisk">俐落動態</option><option value="legacy">保留舊版節奏</option></select></label>
      <label>主標題<input aria-label="已儲存模板主標題" maxLength={32} value={draft.title} onChange={event => copy("title", event.target.value)} /></label>
      <label>眉題<input aria-label="已儲存模板眉題" maxLength={24} value={draft.kicker} onChange={event => copy("kicker", event.target.value)} /></label>
      <label>補充短句<input aria-label="已儲存模板補充短句" maxLength={40} value={draft.subtitle} onChange={event => copy("subtitle", event.target.value)} /></label>
      {input.templateId === "strike_reframe" && <>
        <label>替換呈現<select aria-label="已儲存模板刪線呈現" value={draft.strikePresentation ?? "legacy_layout"} onChange={event => {
          const value = event.target.value;
          if (!busy && current && (value === "legacy_layout" || value === "semantic_replace_v1")) {
            onDraftChange({ ...draft, strikePresentation: value });
          }
        }}><option value="legacy_layout">保留舊版排版</option><option value="semantic_replace_v1">原句退場，重點原位接續</option></select></label>
        <label>要刪去的原句<input aria-label="已儲存模板刪線原句" maxLength={24} value={draft.previousText} onChange={event => copy("previousText", event.target.value)} /></label>
        {draft.strikePresentation === "semantic_replace_v1" && <>
          {instance.authoringGeneration === 2 && <label>畫面用途<select aria-label="已儲存刪線畫面用途" value={draft.strikeSurface ?? "standalone"} onChange={event => {
            const value = event.target.value;
            if (!busy && current && (value === "standalone" || value === "source_overlay")) onDraftChange({ ...draft, strikeSurface: value });
          }}><option value="standalone">原創圖形場景</option><option value="source_overlay">在原素材上提示</option></select>
            <small>未變更時保留已儲存設定；在原素材上提示保留完整原畫面與時鐘，只加入局部閱讀襯底。</small></label>}
          <label>品牌短字<input aria-label="已儲存模板品牌短字" maxLength={32} value={draft.brandMark ?? ""} onChange={event => copy("brandMark", event.target.value)} />
            <small>最多 16 字；這是可編輯文字，不是圖片 Logo，也不代表名稱權利已驗證。</small></label>
        </>}
      </>}
      {input.sources.length > 0 && <label>原片短標籤<input aria-label="已儲存模板原片標籤" maxLength={20} value={draft.primaryLabel} onChange={event => copy("primaryLabel", event.target.value)} /></label>}
      {draft.items.map((item, index) => <div key={index}><label>重點 {index + 1}<input aria-label={`已儲存模板重點 ${index + 1}`} maxLength={24} value={item.label} onChange={event => { if (!busy && current) onDraftChange({ ...draft, items: draft.items.map((row, i) => i === index ? { ...row, label: event.target.value } : row) }); }} /></label>
        <label>補充<input aria-label={`已儲存模板重點補充 ${index + 1}`} maxLength={40} value={item.detail} onChange={event => { if (!busy && current) onDraftChange({ ...draft, items: draft.items.map((row, i) => i === index ? { ...row, detail: event.target.value } : row) }); }} /></label></div>)}
      {input.network && <div><small>排列種子 {input.network.seed} · {input.network.points} 點</small>{draft.networkLabels.map((label, index) => <label key={index}>能力 {index + 1}<input aria-label={`已儲存模板能力 ${index + 1}`} maxLength={6} value={label} onChange={event => { if (!busy && current) onDraftChange({ ...draft, networkLabels: draft.networkLabels.map((row, i) => i === index ? event.target.value : row) as [string, string, string] }); }} /></label>)}
        <label>連結中心<input aria-label="已儲存模板連結中心" maxLength={6} value={draft.hubLabel} onChange={event => copy("hubLabel", event.target.value)} /></label></div>}
      {(["headingFamily", "bodyFamily"] as const).map(key => <label key={key}>{key === "headingFamily" ? "標題字型" : "內文字型"}<select aria-label={key === "headingFamily" ? "已儲存模板標題字型" : "已儲存模板內文字型"} value={draft.typography[key]} onChange={event => { if (!busy && current) onDraftChange({ ...draft, typography: { ...draft.typography, [key]: event.target.value } }); }}>{bundledFontFamilies().map(family => <option key={family}>{family}</option>)}</select></label>)}
      {(["surface", "text", "accent", "muted", "separator"] as const).map(key => <label key={key}>{({ surface: "底色", text: "文字色", accent: "重點色", muted: "次要文字", separator: "面板色" })[key]}<input aria-label={`已儲存模板配色 ${key}`} type="color" value={draft.palette[key]} onChange={event => { if (!busy && current) onDraftChange({ ...draft, palette: { ...draft.palette, [key]: event.target.value } }); }} /></label>)}
      <button type="button" data-testid="revise-reference-motion-instance" disabled={busy || !current || !ready} onClick={() => { if (!busy && current && ready) onRevise(referenceMotionInstanceDraftPatch(instance, draft)); }}>重新編譯並更新模板</button>
    </fieldset>
    <button type="button" data-testid="detach-reference-motion-instance" disabled={busy} onClick={() => { if (!busy) onDetach(); }}>解除模板連結，保留圖層</button>
    {busy && <button type="button" data-testid="cancel-reference-motion-instance" onClick={onCancel}>取消準備</button>}
  </section>;
}

function InstanceEditor(props: Omit<Parameters<typeof SavedReferenceMotionInstanceForm>[0], "draft" | "onDraftChange">) {
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
  return project.tracks.filter(track => track.kind === "video" && !track.locked && !track.muted).flatMap(track => track.clips.flatMap(clip => {
    const asset = project.assets.find(item => item.id === clip.assetId);
    if (ownedClips.has(clip.id) || clip.layer?.enabled === false || (clip.layer?.role !== undefined && clip.layer.role !== "content")
      || !asset || asset.kind !== "video" || asset.compositionId || asset.imageSequence || !Number.isFinite(asset.duration) || asset.duration <= 0
      || !originalAsset || asset.id === originalAsset.id || sourceUri(asset.uri) === undefined || sourceUri(asset.uri) === sourceUri(originalAsset.uri)
      || (asset.derivatives?.sourceSha256 !== undefined && asset.derivatives.sourceSha256 === originalAsset.derivatives?.sourceSha256)
      || !asset.uri.trim() || (asset.color?.interpretation ?? "rec709") !== "rec709" || !Number.isFinite(clip.duration) || clip.duration < recipe.minSeconds
      || !Number.isFinite(clip.timelineStart) || clip.timelineStart < 0 || !Number.isFinite(clip.sourceStart) || clip.sourceStart < 0
      || clip.sourceStart + clip.duration > asset.duration + 1e-6
      || [clip.timelineStart, clip.duration, clip.sourceStart].some(value => !Number.isSafeInteger(Math.round(value * project.fps))
        || Math.abs(value * project.fps - Math.round(value * project.fps)) > 1e-7)
      || project.motionGraphics.some(graphic => graphic.timelineStart < clip.timelineStart + clip.duration && graphic.timelineStart + graphic.duration > clip.timelineStart)) return [];
    return [{ clip, asset, trackName: track.name }];
  }));
}

interface ReferenceMotionReuseDraft {
  targetClipId: string; purpose: string; evidence: string;
  sources: Array<{ assetId: string; sourceStart: string; label: string }>;
}

/** A separate draft owner: it never reads or submits the revision editor draft. */
export function SavedReferenceMotionReuseForm({ project, instance, inspection, busy, onReuse, onCancel }: {
  project: EditProject; instance: EditableInstance; inspection?: Pick<Inspection, "status" | "reason">;
  busy: boolean; onReuse: (request: ReferenceMotionTemplateReuseRequest) => void; onCancel: () => void;
}) {
  const recipe = referenceMotionTemplate(instance.input.templateId);
  const slotCount = instance.input.templateId === "focus_wall" ? instance.input.sources.length : recipe.sourceSlots;
  const [draft, setDraft] = useState<ReferenceMotionReuseDraft>(() => ({ targetClipId: "", purpose: "", evidence: "",
    sources: Array.from({ length: slotCount }, () => ({ assetId: "", sourceStart: "", label: "" })) }));
  const current = inspection?.status === "CURRENT", targets = referenceMotionReuseTargetChoices(project, instance);
  const target = targets.find(item => item.clip.id === draft.targetClipId);
  const sourceUri = (uri: string) => { try { return referenceMotionReuseSourceIdentity(uri); } catch { return undefined; } };
  const assets = project.assets.filter(asset => asset.kind === "video" && !asset.compositionId && !asset.imageSequence
    && asset.id !== target?.asset.id && sourceUri(asset.uri) !== undefined && sourceUri(asset.uri) !== (target ? sourceUri(target.asset.uri) : undefined)
    && !(target?.asset.derivatives?.sourceSha256 && asset.derivatives?.sourceSha256 === target.asset.derivatives.sourceSha256)
    && asset.uri.trim() && (asset.color?.interpretation ?? "rec709") === "rec709");
  const evidenceRefs = draft.evidence.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  const selectedUris = draft.sources.map(slot => assets.find(asset => asset.id === slot.assetId)).map(asset => asset ? sourceUri(asset.uri) : undefined);
  const selectedPins = draft.sources.flatMap(slot => {
    const pin = assets.find(asset => asset.id === slot.assetId)?.derivatives?.sourceSha256;
    return pin ? [pin] : [];
  });
  const ready = Boolean(target) && Boolean(draft.purpose.trim()) && draft.purpose.trim().length <= 160
    && evidenceRefs.length >= 1 && evidenceRefs.length <= 8 && evidenceRefs.every(value => value.length <= 160 && !instance.input.evidenceRefs.includes(value))
    && draft.sources.length === slotCount && new Set(draft.sources.map(slot => slot.assetId)).size === slotCount
    && selectedUris.every(uri => uri !== undefined) && new Set(selectedUris).size === selectedUris.length && new Set(selectedPins).size === selectedPins.length
    && draft.sources.every(slot => {
      const asset = assets.find(item => item.id === slot.assetId), start = Number(slot.sourceStart);
      return Boolean(asset) && Boolean(slot.label.trim()) && slot.label.trim().length <= 20 && Boolean(slot.sourceStart.trim())
        && Number.isFinite(start) && start >= 0 && Number.isSafeInteger(Math.round(start * project.fps))
        && Math.abs(start * project.fps - Math.round(start * project.fps)) <= 1e-7
        && start + (target?.clip.duration ?? Infinity) <= asset!.duration + 1e-6;
    });
  const copy = (key: "targetClipId" | "purpose" | "evidence", value: string) => {
    if (!busy && current) setDraft(valueBefore => ({ ...valueBefore, [key]: value }));
  };
  const slot = (index: number, patch: Partial<ReferenceMotionReuseDraft["sources"][number]>) => {
    if (!busy && current) setDraft(valueBefore => ({ ...valueBefore, sources: valueBefore.sources.map((item, i) => i === index ? { ...item, ...patch } : item) }));
  };
  return <section data-testid="saved-reference-motion-reuse" style={{ marginTop: 16, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
    <h3>套用到另一段素材</h3>
    <p>套用已保存版本，不含未保存修改。建立獨立的新模板，原模板與原片段保持不變。</p>
    <fieldset disabled={busy || !current} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }} aria-busy={busy}>
      <label>要套用的片段<select aria-label="模板重用目標片段" value={draft.targetClipId} onChange={event => copy("targetClipId", event.target.value)}>
        <option value="">選擇另一段已匯入的影片</option>
        {targets.map(({ clip, asset, trackName }) => <option key={clip.id} value={clip.id}>{asset.name} · {trackName} · {clip.timelineStart.toFixed(2)} 秒起 · {clip.duration.toFixed(2)} 秒</option>)}
      </select></label>
      {!targets.length && <p role="status">沒有可套用的片段；請先加入另一段足夠長、未鎖定且沒有重疊 Motion 的影片。</p>}
      {target && <small>使用整段片段：第 {Math.round(target.clip.timelineStart * project.fps)} 格起，共 {Math.round(target.clip.duration * project.fps)} 格。原片入點與音訊速度保持。</small>}
      <label>這次的用途<input aria-label="模板重用新用途" maxLength={160} placeholder="例如：用新作品示範同一個重點" value={draft.purpose} onChange={event => copy("purpose", event.target.value)} /></label>
      <label>這次內容的依據<textarea aria-label="模板重用新內容依據" rows={3} maxLength={1288} placeholder="填寫這次素材與內容的可核對依據，一行一項" value={draft.evidence} onChange={event => copy("evidence", event.target.value)} />
        <small>1 至 8 項，每項最多 160 字；不沿用旧素材依據或審片結果。填寫依據不代表素材權利已驗證。</small></label>
      {draft.sources.map((source, index) => <div key={index}>
        <label>額外素材 {index + 1}<select aria-label={`模板重用素材 ${index + 1}`} value={source.assetId} onChange={event => slot(index, { assetId: event.target.value })}>
          <option value="">重新選擇這次的素材</option>{assets.map(asset => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
        </select></label>
        <label>來源入點（秒）<input aria-label={`模板重用入點 ${index + 1}`} type="number" min={0} step={1 / project.fps} value={source.sourceStart} onChange={event => slot(index, { sourceStart: event.target.value })} /></label>
        <label>素材短標籤<input aria-label={`模板重用標籤 ${index + 1}`} maxLength={20} value={source.label} onChange={event => slot(index, { label: event.target.value })} /></label>
      </div>)}
      <small>額外素材與入點須全部重新選定；不沿用舊素材槽或取景框，未指定取景時保留完整來源。每個新模板仍須重新審看成片。</small>
      <button type="button" data-testid="reuse-reference-motion-instance" disabled={busy || !current || !ready} onClick={() => {
        if (busy || !current || !ready || !target) return;
        onReuse({ sourceInstanceId: instance.id, expectedInstanceRevision: instance.instanceRevision, expectedProjectRevision: project.revision,
          targetClipId: target.clip.id, purpose: draft.purpose.trim(), evidenceRefs,
          sources: draft.sources.map(source => ({ assetId: source.assetId, sourceStart: Number(source.sourceStart), label: source.label.trim() })) });
      }}>建立新模板並套用</button>
    </fieldset>
    {busy && <button type="button" className="secondary-action" data-testid="cancel-reference-motion-reuse" onClick={onCancel}>取消準備</button>}
  </section>;
}

/** Reopen is a new draft owner even if its saved instance ID and revision match. */
export function referenceMotionInstanceEditorKey(session: ProjectSession, instance: EditableInstance): string {
  return JSON.stringify([session.getSnapshot().sessionId, instance.id, instance.instanceRevision]);
}

/** Root-reachable metadata manager: it does not require a surviving selected clip. */
export function SavedReferenceMotionInstances({ project, session, busy, onRevise, onDetach, onReuse, onCancel }: {
  project: EditProject; session: ProjectSession; busy: boolean;
  onRevise: (id: string, patch: ReferenceMotionTemplateRevisionPatch, expectedInstanceRevision: number) => void;
  onReuse?: (request: ReferenceMotionTemplateReuseRequest) => void;
  onDetach: (id: string, expectedInstanceRevision: number) => void; onCancel: () => void;
}) {
  const instances = project.referenceMotionInstances ?? [];
  const [selectedId, setSelectedId] = useState(instances[0]?.id);
  const selected = instances.find(instance => instance.id === selectedId) ?? instances[0];
  const [observed, setObserved] = useState<{ project: EditProject; instance: ReferenceMotionTemplateInstance; inspection: Inspection }>();
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
  if (!selected) return null;
  const inspection = observed?.project === project && observed.instance === selected ? observed.inspection : undefined;
  return <details data-testid="saved-reference-motion-instances" style={{ position: "relative" }}>
    <summary aria-label="管理已儲存 Motion 模板">Motion 模板 ({instances.length})</summary>
    <div style={{ position: "absolute", bottom: "calc(100% + 8px)", right: 0, zIndex: 85, width: "min(620px, 92vw)", maxHeight: "65vh", overflow: "auto", padding: 16, border: "1px solid var(--line)", borderRadius: 8, background: "var(--surface)", color: "var(--ink)", fontSize: 13, lineHeight: 1.5 }}>
      <label>已儲存模板<select aria-label="選擇已儲存 Motion 模板" value={selected.id} disabled={busy} onChange={event => { if (!busy) setSelectedId(event.target.value); }}>{instances.map(instance => <option key={instance.id} value={instance.id}>{instance.input.title} · {referenceMotionTemplate(instance.input.templateId).name}</option>)}</select></label>
      <InstanceEditor key={referenceMotionInstanceEditorKey(session, selected)} instance={selected} assets={project.assets} inspection={inspection} busy={busy}
        onRevise={patch => onRevise(selected.id, patch, selected.instanceRevision)} onDetach={() => onDetach(selected.id, selected.instanceRevision)} onCancel={onCancel} />
      {onReuse && <SavedReferenceMotionReuseForm key={`reuse:${referenceMotionInstanceEditorKey(session, selected)}:${project.revision}`}
        project={project} instance={selected} inspection={inspection} busy={busy} onReuse={onReuse} onCancel={onCancel} />}
    </div>
  </details>;
}
