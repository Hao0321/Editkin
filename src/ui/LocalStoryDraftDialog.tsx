import { useEffect, useRef, useState } from "react";
import { generateLanQwenStoryDraft, generateOllamaStoryDraft, listStoryModels, makeStoryDraftArtifact, parseStoryDraftArtifact, storyDraftMarkdown, storyProjectContextSignature, type StoryContext, type StoryDraft, type StoryModel } from "../application/localStoryDraft";
import type { EditProject } from "../domain/types";
import { StoryEvidenceBoardPanel } from "./StoryEvidenceBoardPanel";
import "./localStoryDraftDialog.css";

const LABELS: { key: keyof StoryDraft; label: string }[] = [
  { key: "premise", label: "一句話故事" },
  { key: "setup", label: "開端" },
  { key: "turn", label: "轉折" },
  { key: "resolution", label: "結局" },
  { key: "visualIdeas", label: "視覺想法" },
  { key: "pacing", label: "節奏" },
  { key: "evidenceToCheck", label: "看片後待核對" },
];

export function LocalStoryDraftDialog({ project, onClose, docked = false }: { project: EditProject; onClose: () => void; docked?: boolean }) {
  const [models, setModels] = useState<StoryModel[]>([]);
  const [model, setModel] = useState("");
  const [origin, setOrigin] = useState("");
  const [brief, setBrief] = useState("");
  const [mode, setMode] = useState<StoryContext["mode"]>("mv");
  const [lyrics, setLyrics] = useState("");
  const [draft, setDraft] = useState<StoryDraft>();
  const [draftModel, setDraftModel] = useState("");
  const [draftBrief, setDraftBrief] = useState("");
  const [draftContext, setDraftContext] = useState<StoryContext>({ mode: "general" });
  const [draftProjectVersion, setDraftProjectVersion] = useState("");
  const [evidenceStory, setEvidenceStory] = useState<ReturnType<typeof makeStoryDraftArtifact>>();
  const [evidenceFingerprint, setEvidenceFingerprint] = useState("");
  const [status, setStatus] = useState("正在讀取區網 Qwen 與本機 Ollama 模型…");
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | undefined>(undefined);
  const desktopJob = useRef<string | undefined>(undefined);
  const desktop = window.haoDesktop;
  const projectVersion = storyProjectContextSignature(project);
  const stale = Boolean(draft && (draftProjectVersion !== projectVersion || draftBrief !== brief.trim()
    || draftContext.mode !== mode || (mode === "mv" && draftContext.lyrics !== lyrics.trim())));
  const currentEvidenceFingerprint = JSON.stringify([projectVersion, brief.trim(), mode, lyrics.trim(), draft]);
  const evidenceStale = Boolean(evidenceStory && evidenceFingerprint !== currentEvidenceFingerprint);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      if (desktop) setOrigin(await desktop.getLocalStoryOrigin());
      return desktop ? desktop.listLocalStoryModels() : listStoryModels(controller.signal);
    };
    void load().then((available) => {
      if (controller.signal.aborted) return;
      setModels(available);
      setModel((current) => available.some((item) => `${item.source}:${item.name}` === current) ? current : available[0] ? `${available[0].source}:${available[0].name}` : "");
      setStatus(available.length ? "已讀取模型清單；生成仍須實際驗證。只傳送需求、你貼的歌詞與素材檔名／類型／長度。" : "找不到可用的區網 Qwen 或本機 Ollama 模型。");
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setStatus(error instanceof Error ? `無法讀取模型：${error.message}` : "無法讀取模型");
    });
    return () => { controller.abort(); request.current?.abort(); if (desktopJob.current) void desktop?.cancelLocalStory(desktopJob.current); };
  }, []);

  const saveOrigin = async () => {
    if (!desktop) return;
    try {
      setStatus("正在檢查本機與區網模型…");
      await desktop.saveLocalStoryOrigin(origin);
      const available = await desktop.listLocalStoryModels();
      setModels(available);
      setModel((current) => available.some((item) => `${item.source}:${item.name}` === current) ? current : available[0] ? `${available[0].source}:${available[0].name}` : "");
      setStatus(available.length ? "已讀取可用模型；生成仍需實際請求驗證。" : "尚未找到可用的本機或區網模型。");
    } catch (error) { setStatus(error instanceof Error ? error.message : "模型位址設定失敗"); }
  };

  const cancel = () => {
    request.current?.abort();
    if (desktopJob.current) void desktop?.cancelLocalStory(desktopJob.current);
  };

  const generate = async () => {
    const selected = models.find((item) => `${item.source}:${item.name}` === model);
    if (busy || !selected || !brief.trim() || (mode === "mv" && !lyrics.trim())) return;
    const controller = new AbortController();
    request.current = controller;
    const requestedVersion = projectVersion;
    const requestedBrief = brief.trim();
    const context: StoryContext = { mode, ...(mode === "mv" ? { lyrics: lyrics.trim() } : {}) };
    setBusy(true);
    setStatus(`${selected.label} 正在寫故事草稿；可按取消停止這次請求。`);
    try {
      let next: StoryDraft;
      if (desktop) {
        const jobId = crypto.randomUUID();
        desktopJob.current = jobId;
        next = await desktop.generateLocalStory(jobId, selected.source, selected.name, requestedBrief, project, context);
      } else {
        next = await (selected.source === "lan-qwen" ? generateLanQwenStoryDraft : generateOllamaStoryDraft)({ model: selected.name, brief: requestedBrief, project, context, signal: controller.signal });
      }
      if (controller.signal.aborted) {
        setStatus("已取消這次生成；沒有修改時間軸。");
        return;
      }
      setDraft(next);
      setDraftModel(selected.label);
      setDraftBrief(requestedBrief);
      setDraftContext(context);
      setDraftProjectVersion(requestedVersion);
      setStatus("草稿已產生，可逐欄修改或下載 Markdown；尚未套用剪輯。");
    } catch (error) {
      setStatus(controller.signal.aborted ? "已取消這次生成；沒有修改時間軸。" : error instanceof Error ? error.message : "本機模型產生草稿失敗");
    } finally {
      if (request.current === controller) request.current = undefined;
      desktopJob.current = undefined;
      setBusy(false);
    }
  };

  const download = () => {
    if (!draft) return;
    const file = new Blob([storyDraftMarkdown(draft, draftModel, draftBrief, draftContext)], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(file);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "editkin-story-draft.md";
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const downloadJson = () => {
    if (!draft || stale) return;
    try {
      const artifact = makeStoryDraftArtifact({ project: { id: project.id, revision: project.revision,
        updatedAt: project.updatedAt, contextSignature: projectVersion }, sourceLabel: draftModel,
        brief: draftBrief, context: draftContext, draft });
      const file = new Blob([`${JSON.stringify(artifact, null, 2)}\n`], { type: "application/json" });
      const url = URL.createObjectURL(file);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "editkin-story-draft.json";
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus("已下載可重新載入的 JSON 提案；仍需看片核對，沒有套用剪輯。");
    } catch (error) { setStatus(error instanceof Error ? error.message : "提案匯出失敗"); }
  };

  const startManualDraft = () => {
    if (!brief.trim() || (mode === "mv" && !lyrics.trim())) { setStatus("先填故事需求；MV 也需要歌詞。"); return; }
    setDraft({ premise: "", setup: "", turn: "", resolution: "", visualIdeas: "", pacing: "", evidenceToCheck: "" });
    setDraftModel("人工撰寫");
    setDraftBrief(brief.trim());
    setDraftContext({ mode, ...(mode === "mv" ? { lyrics: lyrics.trim() } : {}) });
    setDraftProjectVersion(projectVersion);
    setStatus("已開啟人工編劇表單。填完故事事件後，可建立逐段候選素材證據稿。");
  };

  const startEvidenceBoard = () => {
    if (!draft || stale) return;
    try {
      const story = makeStoryDraftArtifact({ project: { id: project.id, revision: project.revision,
        updatedAt: project.updatedAt, contextSignature: projectVersion }, sourceLabel: draftModel,
        brief: draftBrief, context: draftContext, draft });
      setEvidenceStory(story);
      setEvidenceFingerprint(currentEvidenceFingerprint);
      setStatus("已建立故事段落表；歌詞行與影格須逐段人工核對。");
    } catch (error) { setStatus(error instanceof Error ? error.message : "故事欄位尚未填妥"); }
  };

  const importJson = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 128 * 1024) { setStatus("提案檔案超過 128 KiB"); return; }
    try {
      const artifact = parseStoryDraftArtifact(JSON.parse(await file.text()) as unknown);
      if (artifact.project.id !== project.id) throw new Error("這份提案屬於另一個專案");
      setBrief(artifact.brief);
      setMode(artifact.context.mode);
      setLyrics(artifact.context.lyrics ?? "");
      setDraft(artifact.draft);
      setDraftModel(artifact.sourceLabel);
      setDraftBrief(artifact.brief);
      setDraftContext(artifact.context);
      setDraftProjectVersion(artifact.project.contextSignature);
      setStatus("已載入結構化故事提案；仍需看片核對，沒有套用剪輯。");
    } catch (error) { setStatus(error instanceof Error ? error.message : "提案檔案無法載入"); }
  };

  const content = <section className={`local-story-dialog${docked ? " docked" : ""}`} role={docked ? "region" : "dialog"} aria-modal={docked ? undefined : true} aria-labelledby="local-story-title" data-testid="local-story-dialog">
      <button type="button" className="modal-close" onClick={onClose} aria-label="關閉">×</button>
      <small>區網 Qwen / 本機 Ollama · 先編劇再剪輯</small>
      <h2 id="local-story-title">故事與選鏡提案</h2>
      <p>模型會收到文字需求、你貼的歌詞和素材清單；尚未看過畫面或聽過歌曲。此處的草稿不會改動時間軸。區網 HTTP 未加密，只在可信任的內網使用，且不要在這個入口放 API key。</p>
      <div className="local-story-controls">
        {desktop && <label>區網模型位址（HTTP 私有 IP 與連接埠；留空可只用 Ollama）
          <span className="local-story-origin"><input value={origin} onChange={(event) => setOrigin(event.target.value)} disabled={busy} placeholder="http://192.168.x.x:port" data-testid="local-story-origin" />
            <button type="button" onClick={() => void saveOrigin()} disabled={busy} data-testid="local-story-save-origin">儲存並檢查</button></span>
        </label>}
        <label>模型來源<select value={model} onChange={(event) => setModel(event.target.value)} disabled={busy || models.length === 0} data-testid="local-story-model">
          {models.length === 0 && <option value="">沒有可用模型</option>}
          {models.map((item) => <option key={`${item.source}:${item.name}`} value={`${item.source}:${item.name}`}>{item.label}</option>)}
        </select></label>
        <label>內容類型<select value={mode} onChange={(event) => setMode(event.target.value as StoryContext["mode"])} disabled={busy} data-testid="local-story-mode">
          <option value="general">一般影片</option><option value="mv">歌曲 MV（先讀歌詞）</option>
        </select></label>
        <label className="local-story-brief">故事需求<textarea value={brief} onChange={(event) => setBrief(event.target.value)} maxLength={2000} rows={4} placeholder="說明觀眾要看懂的事件、情緒轉折與成片用途" data-testid="local-story-brief" /></label>
        {mode === "mv" && <label>歌詞（必填；尚未對齊歌曲時間）<textarea value={lyrics} onChange={(event) => setLyrics(event.target.value)} maxLength={8000} rows={7} placeholder="貼上這首歌的歌詞，保留段落與換行" data-testid="local-story-lyrics" /></label>}
      </div>
      <div className="local-story-actions">
        <button type="button" onClick={() => void generate()} disabled={busy || !model || !brief.trim() || (mode === "mv" && !lyrics.trim())} data-testid="local-story-generate">產生故事草稿</button>
        <button type="button" onClick={startManualDraft} disabled={busy || !brief.trim() || (mode === "mv" && !lyrics.trim())} data-testid="local-story-manual">自行編寫故事</button>
        {busy && <button type="button" onClick={cancel} data-testid="local-story-cancel">取消這次生成</button>}
        {draft && <button type="button" onClick={download} data-testid="local-story-download">下載 Markdown 草稿</button>}
        {draft && <button type="button" onClick={downloadJson} disabled={stale} data-testid="local-story-download-json">下載 JSON 提案</button>}
        {draft && <button type="button" onClick={startEvidenceBoard} disabled={stale} data-testid="local-story-start-evidence">建立／重建故事段落</button>}
        <label className="local-story-import">載入 JSON 提案<input type="file" accept=".json,application/json" disabled={busy} onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          void importJson(file);
        }} /></label>
      </div>
      <p role="status" aria-live="polite" className="local-story-status">{status}</p>
      {stale && <p role="alert" className="local-story-stale">專案、需求或歌詞已變更；這份提案需重新核對。</p>}
      {draft && <p>草稿來源：{draftModel}。本機／區網運算未呼叫付費 API；可能有設備電力成本。</p>}
      {draft && <p className="local-story-evidence-warning">模型可能寫出素材裡不存在的人物或場景。看片並核對每個事件前，這份內容只能當寫作提議。</p>}
      {draft && <div className="local-story-fields">{LABELS.map(({ key, label }) => <label key={key}>{label}<textarea value={draft[key]} onChange={(event) => setDraft((current) => current ? { ...current, [key]: event.target.value } : current)} rows={key === "visualIdeas" || key === "evidenceToCheck" ? 4 : 2} /></label>)}</div>}
      {evidenceStory && <StoryEvidenceBoardPanel key={evidenceStory.exportedAt} project={project} story={evidenceStory} stale={evidenceStale} />}
    </section>;
  return docked ? content : <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>{content}</div>;
}
