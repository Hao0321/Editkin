import { useState } from "react";
import type { EditProject } from "../domain/types";
import type { StoryDraftArtifact } from "../application/localStoryDraft";
import { candidatesFromMaterialReview, makeStoryEvidenceBoard, materialReviewFingerprint, materialReviewJobKey,
  type StoryEvidenceBeat, type StoryEvidenceCandidate } from "../application/storyEvidenceBoard";

const candidateKey = (item: StoryEvidenceCandidate) => `${item.jobId}:${item.frameId}`;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const lyricLines = (lyrics: string) => [...new Set(lyrics.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];

export function StoryEvidenceBoardPanel({ project, story, stale }: { project: EditProject; story: StoryDraftArtifact; stale: boolean }) {
  const desktop = window.haoDesktop;
  const [beats, setBeats] = useState<StoryEvidenceBeat[]>(() => [
    { id: crypto.randomUUID(), lyricExcerpt: "", event: story.draft.setup },
    { id: crypto.randomUUID(), lyricExcerpt: "", event: story.draft.turn },
    { id: crypto.randomUUID(), lyricExcerpt: "", event: story.draft.resolution },
  ]);
  const [candidates, setCandidates] = useState<StoryEvidenceCandidate[]>([]);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [viewed, setViewed] = useState<Record<string, string>>({});
  const [observations, setObservations] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("手動指定歌詞行、可見事件與候選影格；不會修改時間軸。");

  const updateBeat = (id: string, change: Partial<StoryEvidenceBeat>) => setBeats((current) => current.map((item) => item.id === id
    ? { ...item, ...change, ...(change.event !== undefined || change.lyricExcerpt !== undefined ? { candidate: undefined } : {}) } : item));

  const loadEvidence = async () => {
    if (!desktop || busy) return;
    setBusy(true); setStatus("正在核對已完成素材工作的封存證據…");
    const found: StoryEvidenceCandidate[] = [];
    let skipped = 0;
    try {
      for (const clip of project.tracks.flatMap((track) => track.clips).slice(0, 40)) {
        const asset = project.assets.find((item) => item.id === clip.assetId);
        if (!asset) continue;
        let saved: { jobId?: string; fingerprint?: string } | undefined;
        try { saved = JSON.parse(localStorage.getItem(materialReviewJobKey(project.id, clip.id)) ?? "null") as typeof saved; }
        catch { skipped++; continue; }
        if (!saved?.jobId || saved.fingerprint !== materialReviewFingerprint(asset, clip, project.fps)) { if (saved) skipped++; continue; }
        try { found.push(...candidatesFromMaterialReview(project, await desktop.getMaterialReview(saved.jobId))); }
        catch { skipped++; }
      }
      setCandidates([...new Map(found.map((item) => [candidateKey(item), item])).values()]);
      setViewed({});
      setStatus(`已取得 ${found.length} 張候選影格；${skipped} 個工作連結過期或無法核對。須逐張開啟、寫下人工觀察後才能引用。`);
    } catch (error) { setStatus(`讀取素材證據失敗：${message(error)}`); }
    finally { setBusy(false); }
  };

  const viewFrame = async (beatId: string) => {
    if (!desktop || busy) return;
    const item = candidates.find((candidate) => candidateKey(candidate) === selected[beatId]);
    if (!item) return;
    setBusy(true);
    try {
      const result = await desktop.getMaterialReviewFrame(item.jobId, item.frameId);
      if (result.frameId !== item.frameId || result.sha256 !== item.frameSha256) throw Error("影格 SHA 與封存清單不一致");
      setViewed((current) => ({ ...current, [candidateKey(item)]: result.dataUrl }));
      setStatus("已開啟並驗證影格；請只描述畫面中確實可見的事物，不能推斷抽樣間的動作。");
    } catch (error) { setStatus(`無法核對影格：${message(error)}`); }
    finally { setBusy(false); }
  };

  const attach = (beatId: string) => {
    const item = candidates.find((candidate) => candidateKey(candidate) === selected[beatId]);
    const observation = observations[beatId]?.trim();
    if (!item || !viewed[candidateKey(item)] || !observation) return;
    updateBeat(beatId, { candidate: { ...item, observation } });
    setStatus("候選影格已連至事件；這是人工觀察草稿，尚無 semantic receipt 或音訊對齊。");
  };

  const download = async () => {
    if (busy || !desktop || stale) return;
    setBusy(true); setStatus("正在重新核對每個候選影格及工作收據…");
    try {
      const jobs = [...new Set(beats.flatMap((beat) => beat.candidate ? [beat.candidate.jobId] : []))];
      const live: StoryEvidenceCandidate[] = [];
      const sourceChecks: { jobId: string; sha256: string; verifiedAt: string }[] = [];
      for (const jobId of jobs) {
        const pinned = beats.find((beat) => beat.candidate?.jobId === jobId)?.candidate;
        const clip = project.tracks.flatMap((track) => track.clips).find((item) => item.id === pinned?.clipId);
        const asset = project.assets.find((item) => item.id === clip?.assetId);
        const saved = clip && asset ? JSON.parse(localStorage.getItem(materialReviewJobKey(project.id, clip.id)) ?? "null") as { jobId?: string; fingerprint?: string } | null : null;
        if (!clip || !asset || saved?.jobId !== jobId || saved.fingerprint !== materialReviewFingerprint(asset, clip, project.fps)) {
          throw Error("素材工作連結與目前片段不一致，請重新分析");
        }
        live.push(...candidatesFromMaterialReview(project, await desktop.getMaterialReview(jobId)));
        const verified = await desktop.verifyMaterialReviewSource(project, clip.id, jobId);
        sourceChecks.push({ jobId, ...verified });
      }
      for (const beat of beats) if (beat.candidate) {
        const result = await desktop.getMaterialReviewFrame(beat.candidate.jobId, beat.candidate.frameId);
        if (result.sha256 !== beat.candidate.frameSha256 || result.frameId !== beat.candidate.frameId) throw Error("候選影格驗證失敗");
      }
      const board = makeStoryEvidenceBoard(story, beats, project, live, sourceChecks);
      const url = URL.createObjectURL(new Blob([`${JSON.stringify(board, null, 2)}\n`], { type: "application/json" }));
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = "editkin-story-evidence-board.json"; anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus("已匯出暫定故事證據稿並重新核對原檔 SHA；歌曲時間、完整動作與語意收據仍未核對，不能套用剪輯。");
    } catch (error) { setStatus(`證據稿未匯出：${message(error)}`); }
    finally { setBusy(false); }
  };

  const lines = story.context.mode === "mv" ? lyricLines(story.context.lyrics ?? "") : [];
  return <section className="story-evidence-board" aria-label="故事段落與候選素材證據" data-testid="story-evidence-board">
    <h3>故事段落與候選素材</h3>
    <p>每段先寫觀眾看得懂的事件，再指定歌詞原文和已看過的抽樣影格。歌詞尚未與音訊對齊；單張影格不能證明整段動作。</p>
    <div className="story-evidence-toolbar">
      <button type="button" onClick={() => void loadEvidence()} disabled={!desktop || busy} data-testid="story-evidence-load">讀取已封存影格</button>
      <button type="button" onClick={() => setBeats((current) => [...current, { id: crypto.randomUUID(), lyricExcerpt: "", event: "" }])} disabled={busy || beats.length >= 32}>新增事件段落</button>
      <button type="button" onClick={() => void download()} disabled={!desktop || busy || stale} data-testid="story-evidence-download">匯出暫定證據稿</button>
    </div>
    <p role="status" aria-live="polite">{status}</p>
    {stale && <p role="alert">故事、歌詞或素材清單已改變；請重新建立段落後再匯出。</p>}
    {!desktop && <p>桌面版才能讀取封存影格與匯出含素材引用的證據稿。</p>}
    {beats.map((beat, index) => {
      const chosen = candidates.find((candidate) => candidateKey(candidate) === selected[beat.id]);
      const frame = chosen ? viewed[candidateKey(chosen)] : undefined;
      return <div className="story-evidence-beat" key={beat.id} data-testid="story-evidence-beat">
        <div className="story-evidence-beat-heading"><strong>事件 {index + 1}</strong><button type="button" onClick={() => setBeats((current) => current.filter((item) => item.id !== beat.id))} disabled={busy || beats.length <= 1}>移除</button></div>
        {story.context.mode === "mv" && <label>對應歌詞原文（手動指定，尚未對齊音訊）<select value={beat.lyricExcerpt} onChange={(event) => updateBeat(beat.id, { lyricExcerpt: event.target.value })}>
          <option value="">選擇歌詞行</option>{lines.map((line, lineIndex) => <option key={`${lineIndex}:${line}`} value={line}>{line}</option>)}
        </select></label>}
        <label>觀眾會看到的事件<textarea value={beat.event} maxLength={500} rows={2} onChange={(event) => updateBeat(beat.id, { event: event.target.value })} /></label>
        <label>候選影格<select value={selected[beat.id] ?? ""} onChange={(event) => {
          setSelected((current) => ({ ...current, [beat.id]: event.target.value }));
          setObservations((current) => ({ ...current, [beat.id]: "" }));
          updateBeat(beat.id, { candidate: undefined });
        }}>
          <option value="">未選擇</option>{candidates.map((item) => <option key={candidateKey(item)} value={candidateKey(item)}>{project.assets.find((asset) => asset.id === item.assetId)?.name ?? item.assetId} · 片段 {item.clipId.slice(0, 8)} · +{item.frameTime.toFixed(2)} 秒</option>)}
        </select></label>
        {chosen && <button type="button" onClick={() => void viewFrame(beat.id)} disabled={busy}>開啟並核對這張影格</button>}
        {frame && chosen && <figure><img src={frame} alt={`候選影格 ${chosen.frameId}`} /><figcaption>影格 SHA-256 {chosen.frameSha256} · 來源 SHA-256 {chosen.sourceSha256}</figcaption></figure>}
        {frame && <label>人工觀察（只寫畫面確實可見）<textarea value={observations[beat.id] ?? ""} maxLength={500} rows={2} onChange={(event) => setObservations((current) => ({ ...current, [beat.id]: event.target.value }))} /></label>}
        {frame && <button type="button" onClick={() => attach(beat.id)} disabled={!observations[beat.id]?.trim()}>引用這張影格</button>}
        {beat.candidate && <p>已引用：{beat.candidate.frameId} · +{beat.candidate.frameTime.toFixed(2)} 秒 · {beat.candidate.observation}</p>}
      </div>;
    })}
  </section>;
}
