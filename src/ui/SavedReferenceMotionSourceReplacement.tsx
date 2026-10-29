import { useEffect, useRef, useState } from "react";
import type { EditProject } from "../domain/types";
import type { ReferenceMotionTemplateInstance } from "../domain/referenceMotionInstance";
import type { ProjectSession } from "../application/projectSession";
import { inspectReferenceMotionTemplateInstance } from "../application/referenceMotionTemplateInstances";
import { referenceMotionClipOwner, referenceMotionSourceSlots, sourceReplacementMinimumFrames,
  type ReferenceMotionSourceReplacementRequest } from "../application/referenceMotionSourceReplacement";
import type { PickedMedia } from "../desktop/mediaTypes";
import type { HaoDesktopApi } from "../desktop/types";
import { translateUi as t, useI18n } from "./i18n/interfacePreferences";
import { referenceMotionSourceDraft, referenceMotionSourceDraftAsset, referenceMotionSourceChoices, referenceMotionSourceDraftRequest,
  referenceMotionSourceDurationLimit, selectReferenceMotionDraftAsset, snappedReferenceMotionSourceTime } from "./referenceMotionSourceDraft";
import "./savedReferenceMotionSourceReplacement.css";

type Inspection = Awaited<ReturnType<typeof inspectReferenceMotionTemplateInstance>>;
export interface ReferenceMotionSourceFormProps {
  project: EditProject; instance: ReferenceMotionTemplateInstance; session: ProjectSession;
  inspection?: Pick<Inspection, "status" | "reason">; selectedClipId?: string; busy: boolean;
  api?: Pick<HaoDesktopApi, "pickMedia">;
  onReplace: (request: ReferenceMotionSourceReplacementRequest, picked?: PickedMedia) => void;
  onCancel: () => void;
}
/** Both mounts use this exact form. Draft files never enter the project until the complete source batch commits. */
export function SavedReferenceMotionSourceReplacement(props: ReferenceMotionSourceFormProps) {
  try { referenceMotionSourceSlots(props.project, props.instance); }
  catch { return <p role="status">{t("模板資料不完整，請重新開啟。")}</p>; }
  return <ReferenceMotionSourceReplacementForm {...props} />;
}
function ReferenceMotionSourceReplacementForm(props: ReferenceMotionSourceFormProps) {
  useI18n();
  const { project, instance, session, busy } = props;
  const [draft, setDraft] = useState(() => referenceMotionSourceDraft(project, instance, props.selectedClipId));
  const [error, setError] = useState<string>();
  const [picking, setPicking] = useState(false), mounted = useRef(true), chooserGeneration = useRef(0);
  const [observed, setObserved] = useState<{ project: EditProject; instance: ReferenceMotionTemplateInstance; value: Inspection }>();
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (props.inspection) return;
    const task = session.beginTask(project); let live = true;
    void inspectReferenceMotionTemplateInstance(project, instance.id).then(value => {
      if (live && task.isCurrent()) setObserved({ project, instance, value });
    }, () => { if (live && task.isCurrent()) setError("模板資料不完整，請重新開啟。"); });
    return () => { live = false; };
  }, [project, instance, session, props.inspection]);
  const inspection = props.inspection ?? (observed?.project === project && observed.instance === instance ? observed.value : undefined);
  const current = inspection?.status === "CURRENT", disabled = busy || picking || !current;
  const slots = referenceMotionSourceSlots(project, instance), slot = draft.slots[draft.selectedSlot];
  const asset = referenceMotionSourceDraftAsset(project, draft), time = snappedReferenceMotionSourceTime(slot.sourceStart, project.fps);
  const choices = referenceMotionSourceChoices(project, instance, draft), max = referenceMotionSourceDurationLimit(project, instance, draft);
  const primary = project.tracks.flatMap(track => track.clips).find(clip => clip.id === instance.input.clipId)!;
  let ready = false;
  try { referenceMotionSourceDraftRequest(project, instance, draft, "readiness-only"); ready = true; } catch { /* One inline hint covers incomplete drafts. */ }
  const change = (patch: Partial<typeof draft>) => { if (!disabled) { setDraft(value => ({ ...value, ...patch })); setError(undefined); } };
  const changeSlot = (patch: Partial<typeof slot>) => change({ slots: draft.slots.map((value, index) => index === draft.selectedSlot ? { ...value, ...patch } : value), confirmed: false });
  const pick = async () => {
    if (!props.api || disabled) return;
    const task = session.beginTask(project), generation = ++chooserGeneration.current; setPicking(true); setError(undefined);
    try {
      const files = await props.api.pickMedia();
      if (!mounted.current || !task.isCurrent() || generation !== chooserGeneration.current) return;
      if (!files.length) return;
      if (files.length !== 1) throw new Error("請只選一個影片檔。");
      if (files[0].asset.kind !== "video") throw new Error("只能選擇一般影片檔。");
      setDraft(value => {
        const restored = value.picked ? { ...value, slots: value.slots.map((item, index) => item.assetId === value.picked!.asset.id
          ? { assetId: slots[index].assetId, sourceStart: String(slots[index].sourceStart), label: slots[index].label ?? "" } : item) } : value;
        return selectReferenceMotionDraftAsset({ ...restored, picked: files[0] }, files[0].asset.id);
      });
    } catch (failure) { if (mounted.current && task.isCurrent() && generation === chooserGeneration.current) setError(failure instanceof Error ? failure.message : "無法讀取影片檔。"); }
    finally { if (mounted.current && generation === chooserGeneration.current) setPicking(false); }
  };
  return <details className="saved-template-source" data-testid="saved-template-source-replacement">
    <summary>{t("更換影片")}<small>{t("模板會保留文字與動態")}</small></summary>
    <p>{t("此片段屬於標題模板「{title}」", { title: instance.input.title })}</p>
    {!current && <p role="status">{t(inspection ? "模板已被修改，請先解除模板連結再替換影片。" : "正在確認已保存模板…")}</p>}
    <fieldset disabled={disabled} aria-busy={busy || picking}>
      {slots.length > 1 && <label>{t("要換哪一段")}<select aria-label={t("模板影片位置")} value={draft.selectedSlot} onChange={event => change({ selectedSlot: Number(event.target.value) })}>
        {slots.map(item => <option key={item.slot} value={item.slot}>{item.slot === 0 ? t("主影片") : t("影片 {n} · {label}", { n: item.slot + 1, label: draft.slots[item.slot].label })}</option>)}
      </select></label>}
      {instance.input.templateId === "focus_wall" && <small>{t("放大的主影片會一起更換。")}</small>}
      <label>{t("新影片")}<select data-testid="template-replacement-asset" aria-label={t("模板新影片")} value={slot.assetId}
        onChange={event => { if (!disabled) { setDraft(selectReferenceMotionDraftAsset(draft, event.target.value)); setError(undefined); } }}>
        <option value="">{t("選擇影片…")}</option>{choices.map(choice => <option key={choice.id} value={choice.id}>{choice.id === draft.picked?.asset.id ? t("新：{name}", { name: choice.name }) : choice.name}</option>)}
      </select></label>
      {props.api && <button type="button" onClick={() => void pick()} data-testid="pick-template-replacement-video">{t("從電腦選擇…")}</button>}
      <label>{t("起點（秒）")}<input type="number" min="0" step={1 / project.fps} aria-label={t("新影片起點秒數")} value={slot.sourceStart} onChange={event => changeSlot({ sourceStart: event.target.value })} /></label>
      {time && <small>{t("實際從 {time} 秒開始（第 {frame} 格）", { time: time.seconds.toFixed(3), frame: time.frame })}</small>}
      {asset && time && <small>{t("這段影片可用到 {left} 秒", { left: Math.max(0, asset.duration - time.seconds).toFixed(2) })}</small>}
      {draft.selectedSlot > 0 && <label>{t("新素材標籤")}<input maxLength={20} aria-label={t("新素材標籤")} value={slot.label} onChange={event => changeSlot({ label: event.target.value })} /></label>}
      <label>{t("長度")}<select aria-label={t("模板換片長度")} value={draft.durationMode} onChange={event => change({ durationMode: event.target.value as "keep" | "change" })}>
        <option value="keep">{t("保持 {s} 秒", { s: (instance.input.durationFrames / project.fps).toFixed(2) })}</option><option value="change">{t("改為指定秒數")}</option>
      </select></label>
      {draft.durationMode === "change" && <input type="number" min={sourceReplacementMinimumFrames(project, instance) / project.fps} max={max} step={1 / project.fps}
        aria-label={t("新模板長度秒數")} value={draft.duration} onChange={event => change({ duration: event.target.value })} />}
      <small>{t("可設 {min}–{max} 秒；時間軸位置不變，後面的片段不會移動。", { min: (sourceReplacementMinimumFrames(project, instance) / project.fps).toFixed(2), max: max.toFixed(2) })}</small>
      <label>{t("主影片聲音")}<select aria-label={t("主影片聲音")} value={draft.primaryAudio} onChange={event => change({ primaryAudio: event.target.value as typeof draft.primaryAudio })}>
        <option value="keep_level">{t("保留目前音量（{volume}）", { volume: Math.round(primary.volume * 100) + "%" })}</option>
        <option value="mute">{t("靜音")}</option><option value="unity">{t("播放主影片聲音（100%）")}</option>
      </select></label>
      {slots.length > 1 && <small>{t("其他影片聲音：固定靜音")}</small>}
      {instance.input.focusRegion && <label className="saved-template-source-check"><input type="checkbox" checked={draft.keepFocus} onChange={event => change({ keepFocus: event.target.checked })} />{t("沿用原本的主體取景")}</label>}
      {instance.input.textRegion && <label className="saved-template-source-check"><input type="checkbox" checked={draft.keepText} onChange={event => change({ keepText: event.target.checked })} />{t("沿用原本的文字位置")}</label>}
      <small>{t("取景與文字位置預設重設；換片後請重新確認。")}</small>
      <small>{t("影格率未知；會以專案 {fps} fps 播放。", { fps: project.fps })}</small>
      <label>{t("新影片用途")}<input maxLength={160} aria-label={t("新影片用途")} value={draft.purpose} onChange={event => change({ purpose: event.target.value })} /></label>
      <label className="saved-template-source-check"><input type="checkbox" checked={draft.confirmed} onChange={event => change({ confirmed: event.target.checked })} />{t("已確認影片內容與取景")}</label>
      <button type="button" data-testid="replace-template-source" disabled={!ready} onClick={() => {
        try { props.onReplace(referenceMotionSourceDraftRequest(project, instance, draft, crypto.randomUUID()), draft.picked); }
        catch (failure) { setError(failure instanceof Error ? failure.message : "請檢查換片設定。"); }
      }}>{t("更換並保留模板")}</button>
      {!ready && <small>{t("請選擇夠長的影片、填寫用途與素材標籤，再確認取景。")}</small>}
    </fieldset>
    {error && <p role="alert">{t(error)}</p>}
    {(busy || picking) && <button type="button" onClick={() => { chooserGeneration.current++; setPicking(false); props.onCancel(); }}>{t("取消")}</button>}
  </details>;
}
export function ReferenceMotionSourceClipControl(props: Omit<ReferenceMotionSourceFormProps, "instance" | "inspection"> & { clipId: string }) {
  let owner: ReturnType<typeof referenceMotionClipOwner>;
  try { owner = referenceMotionClipOwner(props.project, props.clipId); } catch { return <p role="status">{t("模板資料不完整，請重新開啟。")}</p>; }
  if (!owner) return null;
  return <SavedReferenceMotionSourceReplacement {...props} instance={owner.instance} selectedClipId={props.clipId}
    key={`${props.session.getSnapshot().sessionId}:${owner.instance.id}:${owner.instance.instanceRevision}:${props.clipId}`} />;
}
export function hasReferenceMotionSourceOwner(project: EditProject, clipId: string | undefined): boolean {
  try { return Boolean(clipId && referenceMotionClipOwner(project, clipId)); } catch { return true; }
}
