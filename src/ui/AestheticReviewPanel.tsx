import { useEffect, useId, useState } from "react";
import { AESTHETIC_BENCHMARKS, BENCHMARK_AXES, evaluateAestheticBenchmarks, validAestheticArtifact } from "../domain/aestheticBenchmarks";
import { scoreAestheticReview } from "../domain/aestheticReview";
import type { AestheticArtifactBinding, AestheticBenchmarkAxis, AestheticBenchmarkReview, AestheticReview, AestheticSystem } from "../domain/types";
import "./aestheticReviewPanel.css";

export interface AestheticReviewPanelProps {
  system: AestheticSystem;
  playhead: number;
  timelineFps: number;
  timelineDurationFrames: number;
  /** Supplied only by the current output owner. Never reconstructed from review data. */
  currentArtifact?: AestheticArtifactBinding;
  onSeek: (time: number) => void;
  onReviewChange: (review: AestheticReview, message: string) => void;
}

interface EvidenceDraft { fromTime: string; toTime: string; observation: string }
interface ItemDraft { rating?: number; evidence: EvidenceDraft[] }
export interface AestheticReviewDraft {
  ratings: Record<string, number>;
  artifact?: AestheticArtifactBinding;
  axes: Partial<Record<AestheticBenchmarkAxis, Record<string, ItemDraft>>>;
}
const AXIS_LABELS: Record<AestheticBenchmarkAxis, string> = {
  mrbeast_information_energy: "MrBeast · 資訊能量",
  yingshi_hurricane_cinematic_craft: "影視颶風 · 電影工藝",
};
const AXIS_DESCRIPTIONS: Record<AestheticBenchmarkAxis, string> = {
  mrbeast_information_energy: "承諾是否清楚、重點是否看懂、最後有沒有回報。",
  yingshi_hurricane_cinematic_craft: "鏡頭、剪點、聲音與光影，是否一起服務敘事。",
};

export function sameAestheticArtifact(left?: AestheticArtifactBinding, right?: AestheticArtifactBinding): boolean {
  return validAestheticArtifact(left) && validAestheticArtifact(right)
    && left.outputSha256 === right.outputSha256 && left.fps === right.fps && left.durationFrames === right.durationFrames;
}

export function formatReviewTime(frame: number, fps: number): string {
  const milliseconds = Math.round(frame / fps * 1000);
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.floor(milliseconds % 60_000 / 1000);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(milliseconds % 1000).padStart(3, "0")}`;
}

/** Accept seconds or MM:SS.mmm / HH:MM:SS.mmm; convert once to the output frame grid. */
export function parseReviewTime(value: string, fps: number): number | undefined {
  if (!Number.isFinite(fps) || fps <= 0 || !/^\d+(?::\d{1,2}){0,2}(?:\.\d{1,6})?$/.test(value.trim())) return undefined;
  const parts = value.trim().split(":").map(Number);
  if (parts.length > 1 && parts.slice(1).some(part => part >= 60)) return undefined;
  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  const frame = Math.round(seconds * fps);
  return Number.isSafeInteger(frame) && frame >= 0 ? frame : undefined;
}

export function createAestheticReviewDraft(system: AestheticSystem, currentArtifact: AestheticArtifactBinding | undefined, timelineFps: number): AestheticReviewDraft {
  const saved = system.review.benchmarkReview;
  const artifact = validAestheticArtifact(currentArtifact) ? structuredClone(currentArtifact) : undefined;
  // A reviewed output must not silently become a review of another output (or an unbound timeline).
  const canReuse = (!saved?.artifact && !artifact) || sameAestheticArtifact(saved?.artifact, artifact);
  const fps = artifact?.fps ?? timelineFps;
  const axes: AestheticReviewDraft["axes"] = {};
  if (canReuse) for (const axis of BENCHMARK_AXES) {
    axes[axis] = Object.fromEntries(Object.entries(saved?.axes[axis] ?? {}).map(([id, item]) => [id, {
      rating: item.rating,
      evidence: item.evidence.map(e => ({ fromTime: formatReviewTime(e.fromFrame, fps), toTime: formatReviewTime(e.toFrame, fps), observation: e.observation })),
    }]));
  }
  return { ratings: { ...system.review.ratings }, artifact, axes };
}

export function prepareAestheticReviewDraft(draft: AestheticReviewDraft, fps: number, durationFrames: number) {
  const errors: string[] = [];
  const axes: AestheticBenchmarkReview["axes"] = {};
  for (const axis of BENCHMARK_AXES) {
    axes[axis] = {};
    for (const criterion of AESTHETIC_BENCHMARKS[axis]) {
      const item = draft.axes[axis]?.[criterion.id];
      if (!item) continue;
      const evidence: NonNullable<AestheticBenchmarkReview["axes"][typeof axis]>[string]["evidence"] = [];
      for (const [index, row] of item.evidence.entries()) {
        const fromFrame = parseReviewTime(row.fromTime, fps);
        const toFrame = parseReviewTime(row.toTime, fps);
        if (fromFrame === undefined || toFrame === undefined || toFrame <= fromFrame || toFrame > durationFrames) {
          errors.push(`${criterion.label}：第 ${index + 1} 筆時間碼需在片長內，且結束晚於開始。`);
        } else evidence.push({ fromFrame, toFrame, observation: row.observation });
      }
      axes[axis]![criterion.id] = { rating: item.rating, evidence };
    }
  }
  const benchmarkReview: AestheticBenchmarkReview = { schema: "editkin.aesthetic-benchmark-review/v1", artifact: draft.artifact, axes };
  return { benchmarkReview, errors };
}

function RatingSelect({ id, label, value, onChange }: { id: string; label: string; value?: number; onChange: (value?: number) => void }) {
  return <label className="aesthetic-rating" htmlFor={id}><span>評分</span><select id={id} aria-label={`${label} 評分`} value={value ?? ""} onChange={event => onChange(event.target.value === "" ? undefined : Number(event.target.value))}>
    <option value="">尚未評分</option>{[1, 2, 3, 3.5, 4, 4.5, 5].map(rating => <option key={rating} value={rating}>{rating} / 5</option>)}
  </select></label>;
}

export function AestheticReviewPanel(props: AestheticReviewPanelProps) {
  // Output changes must neither rebind evidence nor discard unsaved typing.
  // The editor keeps its original draft owner until the reviewer explicitly starts a new draft.
  return <AestheticReviewEditor key={props.system.sourceSha256} {...props} />;
}

function AestheticReviewEditor({ system, playhead, timelineFps, timelineDurationFrames, currentArtifact, onSeek, onReviewChange }: AestheticReviewPanelProps) {
  const prefix = useId();
  const [draft, setDraft] = useState(() => createAestheticReviewDraft(system, currentArtifact, timelineFps));
  const [dirty, setDirty] = useState(false);
  const [attested, setAttested] = useState(false);
  const [notice, setNotice] = useState("");
  const reviewSignature = JSON.stringify(system.review);
  useEffect(() => {
    setDraft(createAestheticReviewDraft(system, currentArtifact, timelineFps));
    setDirty(false); setAttested(false);
    // Only external review changes reset a draft; unrelated project commands must not erase typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewSignature]);
  const fps = draft.artifact?.fps ?? timelineFps;
  const durationFrames = draft.artifact?.durationFrames ?? timelineDurationFrames;
  const general = system.dimensions.filter(dimension => !BENCHMARK_AXES.includes(dimension.id as AestheticBenchmarkAxis));
  const generalComplete = general.filter(dimension => Number.isFinite(draft.ratings[dimension.id])).length;
  const prepared = prepareAestheticReviewDraft(draft, fps, durationFrames);
  const evaluation = evaluateAestheticBenchmarks(prepared.benchmarkReview, currentArtifact);
  const provisional = scoreAestheticReview(system, draft.ratings, { benchmarkReview: prepared.benchmarkReview, currentArtifact });
  const effectiveReview = scoreAestheticReview(system, system.review.ratings, { benchmarkReview: system.review.benchmarkReview, currentArtifact, complete: Boolean(system.review.completedAt), completedAt: system.review.completedAt });
  const bound = sameAestheticArtifact(draft.artifact, currentArtifact);
  const ownerChanged = validAestheticArtifact(currentArtifact) && !sameAestheticArtifact(draft.artifact, currentArtifact);
  const outdated = !!system.review.benchmarkReview?.artifact && !sameAestheticArtifact(system.review.benchmarkReview.artifact, currentArtifact);
  const canComplete = bound && evaluation.complete && generalComplete === general.length && prepared.errors.length === 0 && attested;
  const safeFrame = Math.min(Math.max(0, durationFrames - 1), Math.max(0, Math.round((Number.isFinite(playhead) ? playhead : 0) * fps)));
  const initialEvidence = (): EvidenceDraft => ({ fromTime: formatReviewTime(safeFrame, fps), toTime: formatReviewTime(Math.min(durationFrames, safeFrame + Math.max(1, Math.round(fps))), fps), observation: "" });
  const changeDraft = (change: (value: AestheticReviewDraft) => AestheticReviewDraft) => { setDraft(change); setDirty(true); setAttested(false); setNotice(""); };
  const updateItem = (axis: AestheticBenchmarkAxis, id: string, change: (item: ItemDraft) => ItemDraft) => changeDraft(value => ({ ...value, axes: { ...value.axes, [axis]: { ...value.axes[axis], [id]: change(value.axes[axis]?.[id] ?? { evidence: [] }) } } }));
  const persist = (complete: boolean) => {
    if (prepared.errors.length || (complete && !canComplete)) return;
    const review = scoreAestheticReview(system, draft.ratings, { benchmarkReview: prepared.benchmarkReview, currentArtifact, complete });
    const message = complete ? "已記錄逐項人工評分；最終狀態仍由目前輸出驗證流程判定。" : "已儲存美感評分草稿，尚未完成人工審片。";
    onReviewChange(review, message);
    setDirty(false); setNotice(message);
  };
  return <section className="aesthetic-review-panel" data-testid="aesthetic-review-panel" aria-label="美感審查">
    <header className="aesthetic-panel-heading"><div><h3>美感審查</h3><p>{system.primaryLabel} · 一次專心看一組，不必一次填完。</p></div><span className="aesthetic-review-state">{dirty ? "REVIEW" : effectiveReview.status}{dirty ? " · 未儲存" : " · 評分紀錄"}</span></header>
    <p className="aesthetic-binding-note" data-testid="aesthetic-binding-note">{bound ? "已綁定目前輸出。請對照這份輸出逐項評分；時間碼會按輸出影格對齊。" : "尚未綁定可驗證的目前輸出，目前只能儲存草稿（REVIEW）。時間碼僅作草稿參考，不代表已審過目前成片。"}{outdated && " 先前輸出的逐項證據不會自動套用；原紀錄在儲存新草稿前仍保留。"}</p>
    {ownerChanged && <div className="aesthetic-binding-note"><p>目前輸出已變更。原草稿與輸入仍保留，請先儲存，再為新輸出重新評分。</p><button type="button" disabled={dirty} onClick={() => { if (validAestheticArtifact(currentArtifact)) changeDraft(value => ({ ratings: { ...value.ratings }, artifact: structuredClone(currentArtifact), axes: {} })); }}>開始目前輸出的新評分</button></div>}
    {outdated && <details className="aesthetic-group aesthetic-previous-review" data-testid="aesthetic-previous-review"><summary><span><b>先前輸出的證據（唯讀）</b><small>不是目前成片的認證；需要重新驗證輸出</small></span></summary><div className="aesthetic-items">{BENCHMARK_AXES.map(axis => <details className="aesthetic-criterion" key={axis}><summary><span>{AXIS_LABELS[axis]}</span></summary><div className="aesthetic-criterion-body">{AESTHETIC_BENCHMARKS[axis].map(criterion => {
      const old = system.review.benchmarkReview?.axes[axis]?.[criterion.id];
      return old ? <article key={criterion.id}><h4>{criterion.label} · {old.rating ?? "未評"} / 5</h4>{old.evidence.map((row, index) => <p key={index}>{formatReviewTime(row.fromFrame, system.review.benchmarkReview!.artifact!.fps)}–{formatReviewTime(row.toFrame, system.review.benchmarkReview!.artifact!.fps)}：{row.observation}</p>)}</article> : null;
    })}</div></details>)}</div></details>}
    <details className="aesthetic-group" data-testid="aesthetic-general-group">
      <summary><span><b>一般品質</b><small>構圖、字體、色彩與整體完成度</small></span><strong>{generalComplete} / {general.length}</strong></summary>
      <div className="aesthetic-items">{general.map(dimension => <details className="aesthetic-criterion" key={dimension.id}>
        <summary><span>{dimension.labelZh}</span><small>{draft.ratings[dimension.id] === undefined ? "未評" : `${draft.ratings[dimension.id]} / 5`}</small></summary>
        <div className="aesthetic-criterion-body"><p>{dimension.question}</p><RatingSelect id={`${prefix}-${dimension.id}`} label={dimension.labelZh} value={draft.ratings[dimension.id]} onChange={rating => changeDraft(value => { const ratings = { ...value.ratings }; if (rating === undefined) delete ratings[dimension.id]; else ratings[dimension.id] = rating; return { ...value, ratings }; })} /></div>
      </details>)}</div>
    </details>
    {BENCHMARK_AXES.map(axis => {
      const criteria = AESTHETIC_BENCHMARKS[axis];
      const rated = criteria.filter(criterion => draft.axes[axis]?.[criterion.id]?.rating !== undefined).length;
      return <details key={axis} className="aesthetic-group" data-testid={`aesthetic-axis-${axis}`}>
        <summary><span><b>{AXIS_LABELS[axis]}</b><small>{AXIS_DESCRIPTIONS[axis]}</small></span><strong>{rated} / {criteria.length}</strong></summary>
        <div className="aesthetic-items">{criteria.map(criterion => {
          const item = draft.axes[axis]?.[criterion.id] ?? { evidence: [] };
          return <details key={criterion.id} className="aesthetic-criterion" data-testid={`aesthetic-criterion-${criterion.id}`}>
            <summary><span>{criterion.label}</span><small>{item.rating === undefined ? "未評" : `${item.rating} / 5`} · 證據 {item.evidence.length}</small></summary>
            <div className="aesthetic-criterion-body"><RatingSelect id={`${prefix}-${axis}-${criterion.id}`} label={criterion.label} value={item.rating} onChange={rating => updateItem(axis, criterion.id, previous => ({ ...previous, rating }))} />
              <p className="aesthetic-evidence-help">記下看得見或聽得到的理由。時間碼可輸入秒數或 01:23.400；結束不包含該影格。</p>
              {item.evidence.map((evidence, index) => {
                const baseId = `${prefix}-${axis}-${criterion.id}-${index}`;
                const start = parseReviewTime(evidence.fromTime, fps);
                const end = parseReviewTime(evidence.toTime, fps);
                const invalid = start === undefined || end === undefined || end <= start || end > durationFrames;
                const editEvidence = (patch: Partial<EvidenceDraft>) => updateItem(axis, criterion.id, previous => ({ ...previous, evidence: previous.evidence.map((row, at) => at === index ? { ...row, ...patch } : row) }));
                return <fieldset className="aesthetic-evidence" key={index}><legend>證據 {index + 1}</legend>
                  <div className="aesthetic-time-fields"><label htmlFor={`${baseId}-from`}>開始<input id={`${baseId}-from`} aria-label={`${criterion.label} 證據 ${index + 1} 開始`} inputMode="decimal" value={evidence.fromTime} aria-invalid={invalid} onChange={event => editEvidence({ fromTime: event.target.value })} /></label><label htmlFor={`${baseId}-to`}>結束<input id={`${baseId}-to`} aria-label={`${criterion.label} 證據 ${index + 1} 結束`} inputMode="decimal" value={evidence.toTime} aria-invalid={invalid} onChange={event => editEvidence({ toTime: event.target.value })} /></label></div>
                  <div className="aesthetic-evidence-actions"><button type="button" onClick={() => { const timing = initialEvidence(); editEvidence({ fromTime: timing.fromTime, toTime: timing.toTime }); }}>用目前播放頭</button><button type="button" disabled={start === undefined || start >= durationFrames} onClick={() => { if (start !== undefined) onSeek(start / fps); }}>跳到這裡</button><button type="button" aria-label={`移除${criterion.label}證據 ${index + 1}`} onClick={() => updateItem(axis, criterion.id, previous => ({ ...previous, evidence: previous.evidence.filter((_, at) => at !== index) }))}>移除</button></div>
                  <label htmlFor={`${baseId}-observation`}>觀察與理由<textarea id={`${baseId}-observation`} value={evidence.observation} placeholder="例如：03 秒先露出目標，05 秒才揭曉差距，能看懂這段要解決什麼。" onChange={event => editEvidence({ observation: event.target.value })} /></label>
                  {invalid && <p className="aesthetic-field-error">請填入片長內有效範圍，結束需晚於開始。</p>}
                </fieldset>;
              })}
              <button type="button" className="aesthetic-add-evidence" disabled={!Number.isFinite(fps) || fps <= 0 || durationFrames < 1} onClick={() => updateItem(axis, criterion.id, previous => ({ ...previous, evidence: [...previous.evidence, initialEvidence()] }))}>＋ 在目前播放頭加入證據</button>
            </div>
          </details>;
        })}</div>
      </details>;
    })}
    <footer className="aesthetic-panel-footer"><p>總分試算 {provisional.score.toFixed(1)} / 100。雙基準各需 ≥ 7 / 10；一般維度每項 ≥ {system.scoreContract.minimumDimensionRating}。有分數不等於完成人工審片。</p>
      {system.review.machineBlockers.length > 0 && <p className="aesthetic-field-error">仍有機器阻擋：{system.review.machineBlockers.join("、")}</p>}
      <label className="aesthetic-attestation"><input type="checkbox" checked={attested} disabled={!bound} onChange={event => setAttested(event.target.checked)} /><span>我已觀看目前輸出，並親自完成逐項評分與時間碼證據。</span></label>
      <div className="aesthetic-save-actions"><button type="button" disabled={prepared.errors.length > 0} onClick={() => persist(false)} data-testid="aesthetic-save-draft">儲存評分草稿</button><button type="button" disabled={!canComplete} onClick={() => persist(true)} data-testid="aesthetic-record-review">記錄人工審查</button></div>
      {prepared.errors.length > 0 && <p className="aesthetic-field-error" role="status">{prepared.errors[0]} 修正後才能儲存，未輸入的理由可先留草稿。</p>}
      {!canComplete && <p className="aesthetic-next-step">先儲存草稿也可以。記錄審查需要目前輸出綁定、全部評分、16 項各至少一筆有效證據，以及親自確認。</p>}
      <p className="aesthetic-notice" role="status" aria-live="polite">{notice}</p>
    </footer>
  </section>;
}
