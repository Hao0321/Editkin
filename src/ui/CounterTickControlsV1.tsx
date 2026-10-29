import { useEffect, useRef, useState } from "react";
import type { EditProject } from "../domain/types";
import type { ReferenceMotionTemplateInstance } from "../domain/referenceMotionInstance";
import type { ProjectSession } from "../application/projectSession";
import type { HaoDesktopApi } from "../desktop/apiTypes";
import type { PickedMedia, PrepareMediaResult } from "../desktop/mediaTypes";
import { prepareCounterTickDesktopV1 } from "../desktop/counterTickDesktopV1";
import { applyPreparedProceduralSfxPlacementV1 } from "../application/proceduralSfxPlacementV1";
import { makeId } from "../lib/format";
import { translateUi as t, useI18n } from "./i18n/interfacePreferences";
type Prepared = Awaited<ReturnType<typeof prepareCounterTickDesktopV1>>;
export function CounterTickControlsV1({ project, session, instance, current, busy, api, onPause, onStatus, onPreview, onPrepared }: {
  project: EditProject; session: ProjectSession; instance: ReferenceMotionTemplateInstance; current: boolean; busy: boolean; api?: HaoDesktopApi;
  onPause: () => void; onStatus: (message: string) => void; onPreview?: (soundId: string) => void;
  onPrepared: (media: PrepareMediaResult, picked: PickedMedia) => void;
}) {
  useI18n();
  const [variant, setVariant] = useState(1), [gain, setGain] = useState(.42), [trackId, setTrackId] = useState("");
  const [state, setState] = useState<"idle" | "preparing" | "prepared" | "applying">("idle"), [packet, setPacket] = useState<Prepared>(), [message, setMessage] = useState("");
  const owner = useRef<{ controller: AbortController; api: HaoDesktopApi; phase: string } | undefined>(undefined), mounted = useRef(true), latestApi = useRef(api);
  latestApi.current = api;
  const contentOwner = session.getSnapshot().contentOwner;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; owner.current?.controller.abort(); owner.current = undefined; }; }, []);
  const invalidate = () => { owner.current?.controller.abort(); owner.current = undefined; setPacket(undefined); setState("idle"); };
  useEffect(() => {
    if (owner.current?.phase === "applying" && owner.current.api === api) return;
    invalidate();
  }, [api, session, contentOwner, instance.id, instance.instanceRevision]);
  const supported = ["stat_reveal", "stat_cycle"].includes(instance.input.templateId);
  if (!supported || !api?.listOriginalSfxCandidates || !api.resolveOriginalSfxCandidate) return null;
  const active = state === "preparing" || state === "applying", disabled = busy || active || !current;
  const tracks = project.tracks.filter(track => track.kind === "audio" && !track.locked && !track.muted && (!project.tracks.some(t => t.solo) || track.solo));
  const owns = (operation: NonNullable<typeof owner.current>) => mounted.current && owner.current === operation && latestApi.current === operation.api;
  const cancel = () => { invalidate(); setMessage(t("計數音效已取消，專案未變更。")); };
  const prepare = async () => {
    if (disabled || owner.current?.phase === "preparing" || owner.current?.phase === "applying") return;
    invalidate(); onPause(); const operation = { controller: new AbortController(), api, phase: "preparing" }; owner.current = operation;
    setState("preparing"); setMessage("");
    try {
      const prefix = makeId("counter-tick"), chosen = trackId && tracks.some(t => t.id === trackId) ? trackId : `${prefix}-track`;
      const result = await prepareCounterTickDesktopV1(session, api, { enabled: true, durationFrames: Math.round(instance.input.startFrame + instance.input.durationFrames),
        trackId: chosen, idPrefix: prefix, ...(chosen === trackId ? {} : { newTrack: { name: t("計數音效") } }),
        bindings: [{ source: "reference_instance", instanceId: instance.id }], sound: { variant, gain } }, operation.controller.signal);
      if (!owns(operation) || operation.controller.signal.aborted) return;
      operation.phase = "prepared"; setPacket(result); setState("prepared");
    } catch {
      if (!owns(operation)) return; owner.current = undefined; setState("idle"); setPacket(undefined);
      setMessage(operation.controller.signal.aborted ? t("計數音效已取消，專案未變更。") : t("計數音效未能準備，請確認模板與音軌後重試。"));
    }
  };
  const apply = async () => {
    const operation = owner.current; if (!packet || !operation || operation.phase !== "prepared" || disabled) return;
    operation.phase = "applying"; setState("applying"); onPause();
    try {
      const reply = await applyPreparedProceduralSfxPlacementV1(session, packet.placement, operation.controller.signal);
      if (!owns(operation)) return;
      const text = t("已加入 {count} 個計數音效，可一次復原。", { count: reply.insertedHits });
      // Preview cache admission must not turn an already committed edit into a false failure report.
      try { onPrepared(packet.media, packet.picked); } catch { /* original verified source remains on the timeline */ }
      setMessage(text); onStatus(text); owner.current = undefined; setPacket(undefined); setState("idle");
    } catch {
      if (!owns(operation)) return; owner.current = undefined; setPacket(undefined); setState("idle");
      setMessage(t("計數音效未能加入，專案變更或來源失效；請重新檢查。"));
    }
  };
  return <section data-testid="counter-tick-controls-v1">
    <strong>{t("計數音效")}</strong><p><small>{t("使用本機原創 tick，先檢查數字節點，再由你加入；音效仍待試聽確認。")}</small></p>
    <label>{t("Tick 版本")}<select data-testid="counter-tick-variant" value={variant} disabled={disabled} onChange={e => { invalidate(); setVariant(Number(e.target.value)); }}>{[1,2,3,4,5].map(n => <option key={n} value={n}>{n}</option>)}</select></label>
    <label>{t("音量")}<input data-testid="counter-tick-gain" type="number" min=".01" max="1" step=".01" value={gain} disabled={disabled} onChange={e => { invalidate(); setGain(Number(e.target.value)); }} /></label>
    <label>{t("音效軌道")}<select data-testid="counter-tick-track" value={trackId} disabled={disabled} onChange={e => { invalidate(); setTrackId(e.target.value); }}><option value="">{t("新增音效軌道（可一次復原）")}</option>{tracks.map(track => <option key={track.id} value={track.id}>{track.name}</option>)}</select></label>
    <button type="button" data-testid="counter-tick-prepare" disabled={disabled || !Number.isFinite(gain) || gain <= 0 || gain > 1} onClick={() => void prepare()}>{t("檢查計數音效")}</button>
    {packet && <><p data-testid="counter-tick-report">{t("{count} 個數字節點，將加入 {selected} 個完整音效；略過 {skipped} 個重疊、尾端或超出上限的節點。", { count: packet.visual.hooks.length, selected: packet.visual.selected.length, skipped: packet.visual.suppressed.length })}</p>
      <button type="button" data-testid="counter-tick-preview" disabled={disabled || !onPreview} onClick={() => onPreview?.(packet.visual.soundId)}>{t("試聽這個 tick")}</button>
      <button type="button" data-testid="counter-tick-apply" disabled={disabled} onClick={() => void apply()}>{t("加入計數音效")}</button></>}
    {state !== "idle" && <button type="button" data-testid="counter-tick-cancel" onClick={cancel}>{t("取消")}</button>}
    {message && <p role="status" data-testid="counter-tick-status">{message}</p>}
  </section>;
}
