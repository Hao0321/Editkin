import { useEffect, useRef, useState } from "react";
import type { EditProject } from "../domain/types";
import type { EditorCommand } from "../domain/commandTypes";
import type { ProjectSession } from "../application/projectSession";
import type { AutoReframeModeV1, AutoReframeProgressV1, AutoReframeReplyV1, AutoReframeRequestV1, AutoReframeSubjectV1 } from "../application/autoReframeEditV1";
import type { ReframeNewProjectIdentityV1 } from "../application/autoReframePortraitProjectV1";
import { createAutoReframeInteractionV1, autoReframeInteractionErrorKindV1, type AutoReframeInteractionStateV1 } from "../application/autoReframeInteractionV1";
import "./autoReframeButtonV1.css";

/** H15 supplies these labels after reviewing proposed pack68. No runtime catalogue,
 * main-app mount, backend dispatcher, hotkey or default capability is installed here. */
export interface AutoReframeLabelsV1 {
  title: string; current: string; newProject: string; analyze: string; apply: string; create: string; cancel: string;
  idle: string; preparing: string; analyzing: string; applying: string; done: string; candidate: string; graph: string;
  confirmedSubject: string; saliencySubject: string; help: string; unknownCoverage: string; crop: string; startPoint: string; endPoint: string;
  locked: string; camera: string; dependency: string; source: string; stale: string; subjectChanged: string; unavailable: string; failed: string;
  stage: Record<AutoReframeProgressV1["stage"], string>;
  coverage(percent: string, valid: string, unknown: string): string;
  preserved(audio: string, captions: string, masks: string): string;
  newProjectName(sourceName: string): string;
}
export interface AutoReframeButtonPropsV1 {
  project: EditProject; projectSession: ProjectSession; clipId: string; subject: AutoReframeSubjectV1; labels: AutoReframeLabelsV1;
  locale?: string; outputWidth?: number; outputHeight?: number; engineHostReady?: boolean; disabled?: boolean;
  onAnalyze?(project: EditProject, request: AutoReframeRequestV1, runtime: { signal: AbortSignal; onProgress(progress: AutoReframeProgressV1): void }): Promise<AutoReframeReplyV1>;
  onCommand?(command: EditorCommand, expectedRevision: number): Promise<{ status: "applied" | "cancelled" }> | { status: "applied" | "cancelled" };
  /** Host creates a separate document and owns save/dirty dialogs. Never overwrite the source. */
  onNewProject?(request: { baseProject: EditProject; command: EditorCommand; expectedSourceId: string; expectedSourceRevision: number }): Promise<{ status: "created" | "cancelled" }> | { status: "created" | "cancelled" };
  makeNewProjectIdentity?(source: EditProject): ReframeNewProjectIdentityV1;
  onPause?(): void; onError?(error: unknown): void;
}
export function AutoReframeButtonV1(props: AutoReframeButtonPropsV1) {
  const latest = useRef(props); latest.current = props;
  const alive = useRef(true), [state, setState] = useState<AutoReframeInteractionStateV1>({ status: "idle" });
  const [mode, setMode] = useState<AutoReframeModeV1>(props.project.width * 16 === props.project.height * 9 ? "current_portrait" : "new_portrait_project");
  const interaction = useRef<ReturnType<typeof createAutoReframeInteractionV1>>(undefined);
  if (!interaction.current) interaction.current = createAutoReframeInteractionV1({
    read: () => { const p = latest.current; return { project: p.project, projectSession: p.projectSession, clipId: p.clipId, subject: p.subject,
      outputWidth: p.outputWidth ?? 1080, outputHeight: p.outputHeight ?? 1920, hostReady: !!p.engineHostReady && !!p.onAnalyze,
      currentProjectHostReady: !!p.onCommand, newProjectHostReady: !!p.onNewProject, disabled: p.disabled }; },
    analyze: (project, request, runtime) => { const fn = latest.current.onAnalyze; if (!fn) throw Error("AUTO_REFRAME_UI_UNAVAILABLE"); return fn(project, request, runtime); },
    apply: application => { const p = latest.current;
      if (application.kind === "command") { if (!p.onCommand) throw Error("AUTO_REFRAME_UI_UNAVAILABLE"); return p.onCommand(application.command, application.expectedRevision); }
      if (!p.onNewProject) throw Error("AUTO_REFRAME_UI_UNAVAILABLE"); return p.onNewProject(application);
    },
    makeIdentity: source => latest.current.makeNewProjectIdentity?.(source) ?? { id: `portrait-${crypto.randomUUID()}`,
      name: latest.current.labels.newProjectName(source.name).slice(0, 160), createdAt: new Date().toISOString() },
    onState: value => { if (alive.current) setState(value); }, onError: error => latest.current.onError?.(error), onPause: () => latest.current.onPause?.(),
  });
  const driver = interaction.current;
  useEffect(() => { alive.current = true; driver.resume(); return () => { alive.current = false; driver.dispose(); }; }, []);
  useEffect(() => { driver.invalidate(); }, [props.project, props.projectSession, props.clipId, props.subject.kind,
    props.subject.kind === "confirmed-matte-v2" ? props.subject.confirmationSha256 : "", props.outputWidth, props.outputHeight,
    props.engineHostReady, props.disabled, !!props.onAnalyze, !!props.onCommand, !!props.onNewProject]);
  useEffect(() => props.projectSession.subscribe(() => driver.invalidate()), [props.projectSession]);
  const l = props.labels, busy = ["preparing", "analyzing", "applying"].includes(state.status), plan = state.plan;
  const width = props.outputWidth ?? 1080, height = props.outputHeight ?? 1920;
  const currentEligible = props.project.width === width && props.project.height === height && !!props.onCommand;
  const hostReady = props.engineHostReady && !!props.onAnalyze && (mode === "new_portrait_project" ? !!props.onNewProject : currentEligible);
  const clipTrack = props.project.tracks.find(t => t.clips.some(c => c.id === props.clipId)), locked = !!clipTrack?.locked;
  const number = new Intl.NumberFormat(props.locale ?? "zh-TW", { maximumFractionDigits: 0 });
  const percent = new Intl.NumberFormat(props.locale ?? "zh-TW", { style: "percent", maximumFractionDigits: 1 });
  const progress = state.progress, p = plan?.preview;
  const status = state.error ? l[autoReframeInteractionErrorKindV1(state.error)] : locked ? l.locked : !hostReady ? l.unavailable
    : state.status === "ready" ? l.candidate : state.status === "failed" ? l.failed : l[state.status];
  const viewHeight = p ? 1000 * p.sourceHeight / p.sourceWidth : 625;
  const path = p?.points.map((point, i) => `${!i || point.jump ? "M" : "L"}${point.x * 1000},${point.y * viewHeight}`).join(" ") ?? "";
  const first = p?.points[0], last = p?.points.at(-1);
  const choose = (value: AutoReframeModeV1) => { if (!busy) { driver.cancel(); setMode(value); } };
  return <section className="auto-reframe-v1" aria-label={l.title} data-testid="auto-reframe" data-state={state.status} aria-busy={busy}
    onKeyDown={e => { if (e.key === "Escape" && state.status !== "applying") { e.preventDefault(); e.stopPropagation(); driver.cancel(); } }}>
    <strong>{l.title}</strong>
    <div className="auto-reframe-modes" role="group" aria-label={l.title}>
      <button type="button" aria-pressed={mode === "current_portrait"} disabled={busy || !currentEligible || props.disabled} onClick={() => choose("current_portrait")} data-testid="reframe-mode-current">{l.current}</button>
      <button type="button" aria-pressed={mode === "new_portrait_project"} disabled={busy || !props.onNewProject || props.disabled} onClick={() => choose("new_portrait_project")} data-testid="reframe-mode-new">{l.newProject}</button>
    </div>
    <p className="auto-reframe-help" data-testid="reframe-subject">{props.subject.kind === "confirmed-matte-v2" ? l.confirmedSubject : l.saliencySubject}</p>
    <p role="status" aria-live="polite" data-testid="reframe-status">{status}</p>
    {progress && busy && <div className="auto-reframe-progress"><span>{l.stage[progress.stage]} {percent.format(progress.completed / progress.total)}</span>
      <progress max={progress.total} value={progress.completed} aria-label={l.stage[progress.stage]} /></div>}
    {p && <>
      <svg viewBox={`0 0 1000 ${viewHeight}`} role="img" aria-label={l.graph} data-testid="reframe-path" preserveAspectRatio="xMidYMid meet">
        <title>{l.graph}</title><rect className="auto-reframe-boundary" x={0} y={0} width={1000} height={viewHeight} />
        {first && <rect className="auto-reframe-crop" x={(first.x - p.cropWidth / 2) * 1000} y={(first.y - p.cropHeight / 2) * viewHeight}
          width={p.cropWidth * 1000} height={p.cropHeight * viewHeight} aria-label={l.crop} />}
        <path d={path} className="auto-reframe-line" />
        {first && <circle className="auto-reframe-start" cx={first.x * 1000} cy={first.y * viewHeight} r={9} aria-label={l.startPoint} data-testid="reframe-start-point" />}
        {last && first && Math.hypot(last.x - first.x, last.y - first.y) > 1e-9 && <circle className="auto-reframe-end" cx={last.x * 1000} cy={last.y * viewHeight} r={9} aria-label={l.endPoint} />}
      </svg>
      <p data-testid="reframe-coverage">{p.central60Ratio === null ? l.unknownCoverage : l.coverage(percent.format(p.central60Ratio), number.format(p.validSubjects), number.format(p.unknownFrames))}</p>
      {p.summary && <p className="auto-reframe-help" data-testid="reframe-preserved">{l.preserved(number.format(p.summary.linkedAudioClips), number.format(p.summary.captions), number.format(p.summary.masks))}</p>}
    </>}
    <div className="auto-reframe-actions">
      <button type="button" disabled={!hostReady || busy || locked || props.disabled} onClick={() => { void driver.start(mode); }} data-testid="reframe-analyze">{l.analyze}</button>
      {state.status === "ready" && <button type="button" disabled={props.disabled || !hostReady} onClick={() => { void driver.apply(); }} data-testid="reframe-apply">{mode === "new_portrait_project" ? l.create : l.apply}</button>}
      {["preparing", "analyzing", "ready"].includes(state.status) && <button type="button" onClick={() => driver.cancel()} data-testid="reframe-cancel">{l.cancel}</button>}
    </div>
    <p className="auto-reframe-help">{l.help}</p>
  </section>;
}
