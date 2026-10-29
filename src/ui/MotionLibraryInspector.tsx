import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { motionLibraryClipSecondsV1, motionLibraryFrameRateV1, motionLibraryFieldStatusV1 } from "../domain/motionLibraryV1";
import type { TimelineTransition } from "../domain/timelineTransitionV1";
import type { EditProject, TimelineClip } from "../domain/types";
import { getMotionLibraryItem } from "../motionLibrary/catalog";
import { MOTION_PALETTES } from "../motionLibrary/palettes";
import { resolveMotionLibraryParams } from "../motionLibrary/params";
import { MOTION_ENERGIES, MOTION_PALETTE_ROLES, MOTION_PALETTE_THEMES, MOTION_TEXT_FONT_ROLES, MOTION_TEXT_MAX_LINE_CODE_POINTS, MOTION_TEXT_PLATES,
  MOTION_TRANSITION_DIRECTIONS, type MotionLibraryItem, type MotionPaletteRole, type MotionPaletteTheme } from "../motionLibrary/types";
import { translateUi as uiText, useI18n } from "./i18n/interfacePreferences";
import { MotionLibraryIcon } from "./MotionLibraryIcons";
import { MotionLibraryThumb } from "./MotionLibraryThumb";
import { motionLibraryBadgeV1, motionLibraryThumbnailSizeV1 } from "./motionLibraryCatalogViewV1";
import type { MotionLibraryControllerV1 } from "./motionLibraryControllerV1";
import { findTransitionCutV1, matteTransitionFrameLimitsV1, resizeTransitionWindowV1 } from "./motionLibraryCutsV1";
import { sharedMotionLibraryThumbnailServiceV1, type MotionLibraryThumbnailServiceV1 } from "./motionLibraryThumbnailServiceV1";
import type { MotionLibraryUiStoreV1 } from "./motionLibraryUiStoreV1";
import "./motionLibrary.css";

/**
 * Inspector section 「動態素材」 (PHASE3_INTEGRATION_DESIGN §4): text lines, theme + a colour well per palette role, plate,
 * energy, duration and seed (「換一個」), plus speed/density for backgrounds and direction for transitions. The live SVG
 * preview follows every change at once; the clip re-renders in the background 300 ms after the last change and that
 * render lands as one Undo step. Typing never reaches the editor's keys (text fields own them).
 */

export interface MotionLibraryInspectorProps {
  readonly project: EditProject;
  readonly controller: MotionLibraryControllerV1;
  readonly store: MotionLibraryUiStoreV1;
  readonly service?: MotionLibraryThumbnailServiceV1;
  readonly target: { readonly kind: "clip"; readonly clip: TimelineClip } | { readonly kind: "transition"; readonly transition: TimelineTransition };
  readonly canRender: boolean;
  /** Test seam: the debounce (ms) before an edit re-renders. */
  readonly commitDelayMs?: number;
}

type Params = Record<string, unknown> & { palette?: Record<string, string>; lines?: string[] };

const ROLE_LABEL: Record<MotionPaletteRole, string> = { bg: "底色", ink: "墨色", paper: "紙色", accent: "主色", accent2: "副色" };
const PLATE_LABEL: Record<string, string> = { none: "透明", bg: "底色", accent: "主色", paper: "紙色" };
const ENERGY_LABEL: Record<string, string> = { calm: "平靜", standard: "標準", punchy: "有力", hype: "爆發" };
const FONT_LABEL: Record<string, string> = { display: "黑體", serif: "明體", hand: "手寫", latin: "英文" };
const DIRECTION_LABEL: Record<string, string> = { left_to_right: "→", right_to_left: "←", top_to_bottom: "↓", bottom_to_top: "↑" };
const THEME_LABEL: Record<string, string> = { hao_impact: "Hao 衝擊", swiss_blue: "瑞士藍", travel_note: "旅遊手帳", tech_spec: "科技規格", esports_hud: "電競 HUD" };
const DURATION_LIMITS = { text: [0.5, 30], background: [0.5, 120], transition: [0.2, 2] } as const;
const themeLabel = (theme: string) => THEME_LABEL[theme] ? uiText(THEME_LABEL[theme]) : theme.replace(/^ref_/, "").replace(/^./, letter => letter.toUpperCase());

function themeOf(palette: Record<string, string> | undefined): MotionPaletteTheme | undefined {
  if (!palette) return undefined;
  return MOTION_PALETTE_THEMES.find(theme => MOTION_PALETTE_ROLES.every(role => MOTION_PALETTES[theme][role] === palette[role]?.toUpperCase()));
}

export default function MotionLibraryInspector({ project, controller, store, service: serviceProp, target, canRender, commitDelayMs = 300 }: MotionLibraryInspectorProps) {
  useI18n();
  const service = serviceProp ?? sharedMotionLibraryThumbnailServiceV1();
  const jobs = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot).jobs;
  const field = target.kind === "clip" ? target.clip.motionLibrary : target.transition.motionLibrary;
  const item = useMemo<MotionLibraryItem | undefined>(() => { try { return field ? getMotionLibraryItem(field.itemId) : undefined; } catch { return undefined; } }, [field?.itemId]);
  const ownerId = target.kind === "clip" ? target.clip.id : target.transition.id;
  const [draft, setDraft] = useState<Params>(() => structuredClone((field?.params ?? {}) as Params));
  const [playing, setPlaying] = useState(true);
  const [previewError, setPreviewError] = useState<string>();
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dirty = useRef(false);

  // A field that changed under us (Undo, Redo, another clip) resets the draft unless an edit of ours is waiting.
  useEffect(() => {
    if (pending.current) return;
    dirty.current = false;
    setDraft(structuredClone((field?.params ?? {}) as Params));
  }, [ownerId, field?.cacheKey]);
  useEffect(() => () => { if (pending.current) clearTimeout(pending.current); }, []);

  if (target.kind === "transition" && !field) return <BasicTransitionInspector project={project} controller={controller} transition={target.transition} />;
  if (!field || !item) return null;

  const validation = (() => { try { resolveMotionLibraryParams(item, draft); return undefined; } catch (error) { return error instanceof Error ? error.message : String(error); } })();
  const job = jobs.find(entry => target.kind === "clip" ? entry.target.kind === "clip" && entry.target.clipId === target.clip.id
    : entry.target.kind === "cut" && entry.target.cut.fromClipId === target.transition.fromClipId && entry.target.cut.toClipId === target.transition.toClipId);
  const stale = motionLibraryFieldStatusV1(field) === "stale_engine";
  const badge = motionLibraryBadgeV1(item);
  const size = motionLibraryThumbnailSizeV1(project, 360);

  const commit = (next: Params) => {
    dirty.current = true;
    if (pending.current) clearTimeout(pending.current);
    pending.current = setTimeout(() => {
      pending.current = undefined;
      try { resolveMotionLibraryParams(item, next); } catch { return; }
      if (target.kind === "clip") void controller.updateClipParams(target.clip.id, next);
      else void controller.updateTransitionParams(target.transition.id, next);
    }, commitDelayMs);
  };
  const edit = (patch: Params) => { const next = { ...draft, ...patch }; setDraft(next); setPreviewError(undefined); commit(next); };
  const palette = (draft.palette ?? {}) as Record<string, string>;
  const theme = themeOf(palette);
  const lines = Array.isArray(draft.lines) ? draft.lines as string[] : [];
  const kindLabel = item.kind === "text" ? "文字動畫" : item.kind === "transition" ? "轉場" : "背景";
  const [minSeconds, maxSeconds] = DURATION_LIMITS[item.kind];
  const seconds = Number(draft.durationSeconds ?? item.defaultDurationSeconds);

  return <section className="inspector-section ml-inspector" data-testid="motion-library-inspector" data-item-id={item.id} aria-label={uiText("動態素材")}>
    <header className="ml-inspector-head">
      <span className="ml-title-mark"><MotionLibraryIcon name={item.kind === "text" ? "text" : item.kind === "transition" ? "transition" : "background"} size={15} /></span>
      <div><strong>{uiText("動態素材")}</strong><span>{item.names.zh}<small> · {item.id} · {uiText(kindLabel)}</small></span></div>
      {badge && <span className="ml-badge is-inline">{uiText(badge)}</span>}
    </header>
    <div className="ml-preview" data-plate={item.kind === "text" ? String(draft.plate ?? "none") : undefined}>
      <MotionLibraryThumb service={service} item={item} size={size} purpose="preview" params={draft} visible animating={playing} onError={setPreviewError} />
      <button type="button" className="ml-preview-play" onClick={() => setPlaying(value => !value)} aria-pressed={playing}
        title={playing ? uiText("暫停預覽") : uiText("播放預覽")}><MotionLibraryIcon name={playing ? "pause" : "play"} size={13} />{playing ? uiText("暫停") : uiText("播放")}</button>
      {job && <div className="ml-preview-job" role="status"><span>{uiText("正在套用到時間軸… {value0}%", { value0: Math.round(job.fraction * 100) })}</span>
        <button type="button" onClick={job.cancel}><MotionLibraryIcon name="close" size={12} />{uiText("取消")}</button></div>}
    </div>
    {!canRender && <p className="ml-note">{uiText("瀏覽器預覽：這裡可以即時預覽修改；套用到時間軸需要 Editkin 桌面版。")}</p>}
    {stale && <p className="ml-note">{uiText("這段是舊版引擎產生的；改任何一項都會用新版重新產生。")}</p>}
    {(validation || previewError) && <p className="ml-error" role="alert">{validation ?? previewError}</p>}

    {item.kind === "text" && <div className="ml-field">
      <span className="ml-label">{uiText("文字")}</span>
      {lines.map((line, index) => <div className="ml-line" key={index}>
        <input type="text" value={line} maxLength={MOTION_TEXT_MAX_LINE_CODE_POINTS * 2} aria-label={uiText("第 {value0} 行文字", { value0: index + 1 })}
          data-testid={`motion-library-line-${index}`} onChange={event => edit({ lines: lines.map((value, at) => at === index ? event.target.value : value) })} />
        {lines.length > 1 && <button type="button" className="ml-icon-button" onClick={() => edit({ lines: lines.filter((_, at) => at !== index) })}
          aria-label={uiText("刪除第 {value0} 行", { value0: index + 1 })} title={uiText("刪除這一行")}><MotionLibraryIcon name="close" size={12} /></button>}
      </div>)}
      {lines.length < 4 && <button type="button" className="mini-action ml-add-line" onClick={() => edit({ lines: [...lines, lines.at(-1) ?? "新的一行"] })}>
        <MotionLibraryIcon name="plus" size={12} />{uiText("加一行")}</button>}
    </div>}

    {item.kind === "text" && <Segmented label="字型" value={String(draft.font ?? "display")} options={MOTION_TEXT_FONT_ROLES.map(value => [value, FONT_LABEL[value] ?? value])}
      onChange={value => edit({ font: value })} />}

    <div className="ml-field">
      <span className="ml-label">{uiText("配色")}<small>{theme ? themeLabel(theme) : uiText("自訂")}</small></span>
      <div className="ml-themes" role="group" aria-label={uiText("配色主題")}>
        {MOTION_PALETTE_THEMES.map(value => <button key={value} type="button" className="ml-theme" aria-pressed={theme === value} title={themeLabel(value)}
          aria-label={themeLabel(value)} onClick={() => edit({ palette: { ...MOTION_PALETTES[value] } })}>
          {MOTION_PALETTE_ROLES.map(role => <i key={role} style={{ background: MOTION_PALETTES[value][role] }} />)}
        </button>)}
      </div>
      <div className="ml-wells">
        {MOTION_PALETTE_ROLES.map(role => <label key={role} className="ml-well" title={uiText(ROLE_LABEL[role])}>
          <input type="color" value={(palette[role] ?? "#000000").toLowerCase()} aria-label={uiText(ROLE_LABEL[role])} data-testid={`motion-library-color-${role}`}
            onChange={event => edit({ palette: { ...palette, [role]: event.target.value.toUpperCase() } })} />
          <span>{uiText(ROLE_LABEL[role])}</span>
        </label>)}
      </div>
    </div>

    {item.kind === "text" && <Segmented label="底板" value={String(draft.plate ?? "none")} options={MOTION_TEXT_PLATES.map(value => [value, PLATE_LABEL[value]])}
      onChange={value => edit({ plate: value })} help="透明：疊在影片上；其他：鋪滿底色當字卡" />}
    <Segmented label="力度" value={String(draft.energy ?? "standard")} options={MOTION_ENERGIES.map(value => [value, ENERGY_LABEL[value]])} onChange={value => edit({ energy: value })} />
    {item.kind === "transition" && item.supportedDirections?.length ? <Segmented label="方向" value={String(draft.direction ?? item.supportedDirections[0])}
      options={MOTION_TRANSITION_DIRECTIONS.filter(value => item.supportedDirections!.includes(value)).map(value => [value, DIRECTION_LABEL[value]])}
      onChange={value => edit({ direction: value })} /> : null}

    <div className="ml-field ml-row">
      <label className="ml-number"><span className="ml-label">{uiText("長度")}</span>
        <input type="number" min={minSeconds} max={maxSeconds} step={0.1} value={Number(seconds.toFixed(3))} data-testid="motion-library-duration"
          onChange={event => {
            const value = Number(event.target.value);
            if (!Number.isFinite(value)) return;
            if (target.kind === "transition") return resizeTransition(target.transition, value);
            edit({ durationSeconds: Math.max(minSeconds, Math.min(maxSeconds, value)) });
          }} /><small>{uiText("秒")}</small></label>
      <div className="ml-seed"><span className="ml-label">{uiText("變化")}<small>#{String(draft.seed ?? 1)}</small></span>
        <button type="button" className="mini-action" data-testid="motion-library-reseed" onClick={() => edit({ seed: Math.floor(Math.random() * 2_000_000_000) })}
          title={uiText("同一個效果換一種隨機變化")}><MotionLibraryIcon name="shuffle" size={13} />{uiText("換一個")}</button></div>
    </div>

    {item.kind === "background" && <div className="ml-field ml-row">
      <label className="ml-number"><span className="ml-label">{uiText("速度")}</span>
        <input type="range" min={0.25} max={2} step={0.25} value={Number(draft.speed ?? 1)} onChange={event => edit({ speed: Number(event.target.value) })} /><small>×{Number(draft.speed ?? 1)}</small></label>
      <label className="ml-number"><span className="ml-label">{uiText("密度")}</span>
        <input type="range" min={0.5} max={2} step={0.25} value={Number(draft.density ?? 1)} onChange={event => edit({ density: Number(event.target.value) })} /><small>×{Number(draft.density ?? 1)}</small></label>
    </div>}
    {target.kind === "transition" && <div className="ml-field ml-row ml-transition-actions">
      <small className="ml-hint">{uiText("拖曳時間軸上轉場的左右邊緣也能改長度。")}</small>
      <button type="button" className="mini-action danger-action" onClick={() => controller.removeTransition(target.transition.id)} aria-keyshortcuts="Delete"
        title={uiText("移除轉場（Delete）")}><MotionLibraryIcon name="trash" size={13} />{uiText("移除")}</button>
    </div>}
  </section>;

  function resizeTransition(transition: TimelineTransition, value: number) {
    const cut = findTransitionCutV1(project, transition.id);
    if (!cut) return;
    const rate = motionLibraryFrameRateV1(project.fps), limits = matteTransitionFrameLimitsV1(project.fps);
    const frames = Math.round(Math.max(0.2, Math.min(2, value)) * project.fps);
    const current = { before: transition.beforeFrames, after: transition.afterFrames };
    const delta = frames - (current.before + current.after);
    const grown = resizeTransitionWindowV1(cut, resizeTransitionWindowV1(cut, current, "after", Math.ceil(delta / 2), limits), "before", Math.floor(delta / 2), limits);
    setDraft({ ...draft, durationSeconds: motionLibraryClipSecondsV1(grown.before + grown.after, rate) });
    if (pending.current) clearTimeout(pending.current);
    pending.current = setTimeout(() => { pending.current = undefined; void controller.resizeTransition(transition.id, grown); }, commitDelayMs);
  }
}

function Segmented({ label, value, options, onChange, help }: { label: string; value: string; options: ReadonlyArray<readonly [string, string]>; onChange: (value: string) => void; help?: string }) {
  return <div className="ml-field" title={help ? uiText(help) : undefined}>
    <span className="ml-label">{uiText(label)}</span>
    <div className="ml-segmented" role="group" aria-label={uiText(label)}>
      {options.map(([id, text]) => <button key={id} type="button" aria-pressed={value === id} onClick={() => onChange(id)}>{uiText(text)}</button>)}
    </div>
  </div>;
}

/** 溶接 / 黑場 transitions: their kind and length (no render needed). */
function BasicTransitionInspector({ project, controller, transition }: { project: EditProject; controller: MotionLibraryControllerV1; transition: TimelineTransition }) {
  const frames = transition.beforeFrames + transition.afterFrames;
  const cut = findTransitionCutV1(project, transition.id);
  const setKind = (kind: "dissolve" | "dip") => { if (cut && kind !== transition.kernel) void controller.applyTransition({ kind }, cut, { frames }); };
  return <section className="inspector-section ml-inspector" data-testid="motion-library-transition-inspector" aria-label={uiText("轉場")}>
    <header className="ml-inspector-head">
      <span className="ml-title-mark"><MotionLibraryIcon name={transition.kernel === "dip" ? "dip" : "dissolve"} size={15} /></span>
      <div><strong>{uiText("轉場")}</strong><span>{uiText(transition.kernel === "dip" ? "黑場" : "溶接")}<small> · {(frames / project.fps).toFixed(2)} {uiText("秒")}</small></span></div>
    </header>
    <Segmented label="種類" value={transition.kernel} options={[["dissolve", "溶接"], ["dip", "黑場"]]} onChange={value => setKind(value as "dissolve" | "dip")} />
    <div className="ml-field ml-row">
      <label className="ml-number"><span className="ml-label">{uiText("長度")}</span>
        <input type="number" min={2 / project.fps} max={10} step={0.1} value={Number((frames / project.fps).toFixed(3))} onChange={event => {
          const value = Number(event.target.value);
          if (!cut || !Number.isFinite(value)) return;
          const target = Math.max(2, Math.round(value * project.fps)), delta = target - frames, limits = { min: 2, max: Math.round(10 * project.fps) };
          const window = resizeTransitionWindowV1(cut, resizeTransitionWindowV1(cut, { before: transition.beforeFrames, after: transition.afterFrames }, "after", Math.ceil(delta / 2), limits),
            "before", Math.floor(delta / 2), limits);
          void controller.resizeTransition(transition.id, window);
        }} /><small>{uiText("秒")}</small></label>
      <button type="button" className="mini-action danger-action" onClick={() => controller.removeTransition(transition.id)} aria-keyshortcuts="Delete" title={uiText("移除轉場（Delete）")}>
        <MotionLibraryIcon name="trash" size={13} />{uiText("移除")}</button>
    </div>
    <p className="ml-hint">{uiText("拖曳時間軸上轉場的左右邊緣也能改長度；換成動態轉場請到「動態素材庫 → 轉場」。")}</p>
  </section>;
}
