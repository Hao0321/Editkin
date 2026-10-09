import type { EditProject } from "../domain/types";

const OLLAMA_ORIGIN = new URL("http://127.0.0.1:11434/");
const LAN_QWEN_ROUTE = "/__local_llm/openai-compatible/v1";
const LAN_QWEN_MODEL = "qwen3.8-27b-nvfp4";

function ollamaUrl(path: "api/tags" | "api/generate"): string {
  const url = new URL(path, OLLAMA_ORIGIN);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.port !== "11434" || url.username || url.password) {
    throw new Error("Ollama 位址必須固定在本機 loopback");
  }
  return url.href;
}

export interface StoryModel {
  source: "lan-qwen" | "ollama";
  name: string;
  label: string;
}

export interface StoryDraft {
  premise: string;
  setup: string;
  turn: string;
  resolution: string;
  visualIdeas: string;
  pacing: string;
  evidenceToCheck: string;
}

export interface StoryContext {
  mode: "general" | "mv";
  lyrics?: string;
}

export interface StoryDraftArtifact {
  schema: "editkin.story-draft/v1";
  project: { id: string; revision: number; updatedAt: string; contextSignature: string };
  sourceLabel: string;
  brief: string;
  context: StoryContext;
  draft: StoryDraft;
  status: "unverified";
  exportedAt: string;
}

/** Exactly the project facts exposed to the story model, plus local source identity when known. */
export function storyProjectContextSignature(project: EditProject): string {
  return JSON.stringify({ projectId: project.id, assets: project.assets.filter((asset) => asset.id !== "asset-demo")
    .slice(0, 40).map((asset) => ({ id: asset.id, name: asset.name.slice(0, 160), kind: asset.kind,
      durationSeconds: asset.duration, sourceSha256: asset.derivatives?.sourceSha256 ?? null })) });
}

export function makeStoryDraftArtifact(input: {
  project: StoryDraftArtifact["project"];
  sourceLabel: string; brief: string; context: StoryContext; draft: StoryDraft;
}): StoryDraftArtifact {
  const brief = input.brief.trim();
  if (!brief || brief.length > 2000) throw new Error("故事需求需有 1 到 2000 字");
  if (input.context.mode !== "mv" && input.context.mode !== "general") throw new Error("未辨識的故事模式");
  const context = input.context.mode === "mv"
    ? { mode: "mv" as const, lyrics: input.context.lyrics?.trim() }
    : { mode: "general" as const };
  if (context.mode === "mv" && (!context.lyrics || context.lyrics.length > 8000)) throw new Error("MV 提案需要有效歌詞");
  if (!input.sourceLabel.trim() || input.sourceLabel.length > 200) throw new Error("草稿來源不合法");
  if (!input.project.id || !Number.isSafeInteger(input.project.revision) || input.project.revision < 0
    || !input.project.updatedAt || !input.project.contextSignature || input.project.contextSignature.length > 100_000) throw new Error("專案版本不合法");
  return { schema: "editkin.story-draft/v1", project: { id: input.project.id, revision: input.project.revision,
    updatedAt: input.project.updatedAt, contextSignature: input.project.contextSignature },
    sourceLabel: input.sourceLabel.trim(), brief, context, draft: parseStoryDraft(input.draft),
    status: "unverified", exportedAt: new Date().toISOString() };
}

export function parseStoryDraftArtifact(value: unknown): StoryDraftArtifact {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("提案檔案格式不正確");
  const data = value as Partial<StoryDraftArtifact>;
  if (data.schema !== "editkin.story-draft/v1" || data.status !== "unverified" || !data.project
    || typeof data.project.id !== "string" || typeof data.project.revision !== "number"
    || typeof data.project.updatedAt !== "string" || typeof data.project.contextSignature !== "string" || typeof data.sourceLabel !== "string"
    || typeof data.brief !== "string" || !data.context || !data.draft
    || typeof data.exportedAt !== "string" || !Number.isFinite(Date.parse(data.exportedAt))) {
    throw new Error("提案檔案格式不正確");
  }
  return { ...makeStoryDraftArtifact({ project: data.project, sourceLabel: data.sourceLabel,
    brief: data.brief, context: data.context, draft: data.draft }), exportedAt: data.exportedAt };
}

const DRAFT_FIELDS: (keyof StoryDraft)[] = [
  "premise", "setup", "turn", "resolution", "visualIdeas", "pacing", "evidenceToCheck",
];
const cloudModelName = (name: string) => /(?:^|[:/\-])cloud(?:$|[:/\-])/i.test(name);

export async function listOllamaModels(signal?: AbortSignal): Promise<string[]> {
  const response = await fetch(ollamaUrl("api/tags"), { signal, redirect: "error" });
  if (!response.ok) throw new Error(`本機 Ollama 回應 ${response.status}`);
  const body: unknown = await response.json();
  if (!body || typeof body !== "object" || !Array.isArray((body as { models?: unknown }).models)) {
    throw new Error("Ollama 模型清單格式不正確");
  }
  return (body as { models: unknown[] }).models
    .map((model) => model && typeof model === "object" && typeof (model as { size?: unknown }).size === "number"
      && (model as { size: number }).size > 0 ? (model as { name?: unknown }).name : undefined)
    .filter((name): name is string => typeof name === "string" && name.length > 0)
    .filter((name) => !cloudModelName(name));
}

export async function listStoryModels(signal?: AbortSignal): Promise<StoryModel[]> {
  const [lan, ollama] = await Promise.allSettled([
    fetch(`${LAN_QWEN_ROUTE}/models`, { signal, redirect: "error" }).then(async (response) => {
      if (!response.ok) throw new Error(`區網模型清單回應 ${response.status}`);
      const body: unknown = await response.json();
      const models = body && typeof body === "object" ? (body as { data?: unknown }).data : undefined;
      if (!Array.isArray(models)) throw new Error("區網模型清單格式不正確");
      return models.some((entry) => entry && typeof entry === "object" && (entry as { id?: unknown }).id === LAN_QWEN_MODEL);
    }),
    listOllamaModels(signal),
  ]);
  if (signal?.aborted) throw new DOMException("已取消", "AbortError");
  const available: StoryModel[] = [];
  if (lan.status === "fulfilled" && lan.value) available.push({ source: "lan-qwen", name: LAN_QWEN_MODEL, label: "區網 Qwen 3.8 27B" });
  if (ollama.status === "fulfilled") available.push(...ollama.value.map((name) => ({ source: "ollama" as const, name, label: `本機 Ollama · ${name}` })));
  return available;
}

export function parseStoryDraft(value: unknown): StoryDraft {
  let data = value;
  if (typeof value === "string") {
    const afterThinking = value.includes("</think>") ? value.slice(value.lastIndexOf("</think>") + "</think>".length) : value;
    const start = afterThinking.indexOf("{");
    const end = afterThinking.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("模型未回傳有效的 JSON 故事草稿");
    try { data = JSON.parse(afterThinking.slice(start, end + 1)) as unknown; }
    catch { throw new Error("模型未回傳有效的 JSON 故事草稿"); }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("模型沒有回傳故事草稿");
  const record = data as Record<string, unknown>;
  for (const field of DRAFT_FIELDS) {
    if (typeof record[field] !== "string" || !record[field].trim() || record[field].length > 4000) {
      throw new Error(`模型草稿缺少有效的 ${field} 欄位`);
    }
  }
  return Object.fromEntries(DRAFT_FIELDS.map((field) => [field, (record[field] as string).trim()])) as unknown as StoryDraft;
}

export function storyPrompt(briefInput: string, project: EditProject, context: StoryContext = { mode: "general" }): string {
  const brief = briefInput.trim();
  if (!brief || brief.length > 2000) throw new Error("請輸入 1 到 2000 字的故事需求");
  if (context.mode !== "general" && context.mode !== "mv") throw new Error("未辨識的故事模式");
  const lyrics = context.lyrics?.trim() ?? "";
  if (context.mode === "mv" && (!lyrics || lyrics.length > 8000)) throw new Error("MV 模式請提供 1 到 8000 字的歌詞");
  const assets = project.assets.filter((asset) => asset.id !== "asset-demo").slice(0, 40).map((asset) => ({
    name: asset.name.slice(0, 160), kind: asset.kind, durationSeconds: asset.duration,
  }));
  return [
    "你是影片編劇。只根據使用者需求和素材清單寫繁體中文故事草稿。",
    context.mode === "mv"
      ? "你已讀到使用者提供的歌詞文字，但沒有聽過歌曲，也沒有對齊歌曲時間；先用歌詞建立可理解的起因、轉折和結果，再提出意象。不要照歌詞逐字拍。"
      : "使用者沒有提供歌詞；你沒有聽過聲音。",
    "你沒有看過素材畫面；素材名稱與長度不是內容證據。",
    "不要聲稱看到了人物、動作、場景或聽到了台詞。不要編造精確來源時間碼。",
    "先寫普通觀眾能理解的事件、轉折與結局，再給可拍可剪的視覺想法；把需要看片確認的地方列在 evidenceToCheck。",
    "只回傳 JSON 物件，七個鍵均為非空字串：premise, setup, turn, resolution, visualIdeas, pacing, evidenceToCheck。",
    `使用者需求：${JSON.stringify(brief)}`,
    ...(context.mode === "mv" ? [`使用者提供的歌詞（尚未與音訊對齊）：${JSON.stringify(lyrics)}`] : []),
    `素材清單（僅檔名、類型、長度）：${JSON.stringify(assets)}`,
  ].join("\n");
}

export async function generateOllamaStoryDraft(input: {
  model: string;
  brief: string;
  project: EditProject;
  context?: StoryContext;
  signal: AbortSignal;
}): Promise<StoryDraft> {
  if (!input.model.trim()) throw new Error("請先選擇本機模型");
  if (cloudModelName(input.model)) throw new Error("此來源只允許本機模型，不使用 Ollama Cloud");
  const prompt = storyPrompt(input.brief, input.project, input.context);
  const response = await fetch(ollamaUrl("api/generate"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: input.model, prompt, format: "json", stream: false, think: false, options: { temperature: 0.4, num_predict: 900 } }),
    signal: input.signal,
    redirect: "error",
  });
  if (!response.ok) throw new Error(`本機 Ollama 產生草稿失敗（${response.status}）`);
  const body: unknown = await response.json();
  if (!body || typeof body !== "object" || typeof (body as { response?: unknown }).response !== "string") {
    throw new Error("Ollama 未回傳可讀草稿");
  }
  return parseStoryDraft((body as { response: string }).response);
}

export async function generateLanQwenStoryDraft(input: {
  model: string;
  brief: string;
  project: EditProject;
  context?: StoryContext;
  signal: AbortSignal;
}): Promise<StoryDraft> {
  if (input.model !== LAN_QWEN_MODEL) throw new Error("未辨識的區網 Qwen 模型");
  const prompt = storyPrompt(input.brief, input.project, input.context);
  const response = await fetch(`${LAN_QWEN_ROUTE}/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: input.model, input: prompt, max_output_tokens: 4000 }),
    signal: input.signal,
    redirect: "error",
  });
  if (!response.ok) throw new Error(response.status === 503
    ? "區網 Qwen 推理服務目前無法完成（503）；時間軸未修改。"
    : `區網 Qwen 產生草稿失敗（${response.status}）`);
  const body: unknown = await response.json();
  if (!body || typeof body !== "object" || (body as { status?: unknown }).status !== "completed") {
    throw new Error("區網 Qwen 未完成故事草稿");
  }
  const output = (body as { output?: unknown }).output;
  if (!Array.isArray(output)) throw new Error("區網 Qwen 未回傳可讀草稿");
  const content = output.flatMap((item) => item && typeof item === "object" && (item as { type?: unknown }).type === "message"
    && Array.isArray((item as { content?: unknown }).content) ? (item as { content: unknown[] }).content : [])
    .filter((item): item is { type: string; text: string } => Boolean(item && typeof item === "object" && (item as { type?: unknown }).type === "output_text" && typeof (item as { text?: unknown }).text === "string"))
    .map((item) => item.text).join("\n");
  if (!content.trim()) throw new Error("區網 Qwen 未回傳可讀草稿");
  return parseStoryDraft(content);
}

export function storyDraftMarkdown(draft: StoryDraft, sourceLabel: string, brief: string, context: StoryContext = { mode: "general" }): string {
  const lyricSection = context.mode === "mv" ? `\n## 使用者提供的歌詞（尚未對齊歌曲）\n\n${context.lyrics?.trim() ?? ""}\n` : "";
  return `# 故事與選鏡草稿\n\n來源：${sourceLabel}\n計費：本機／區網運算，未呼叫付費 API；可能有設備電力成本\n狀態：尚未看片、尚未核對素材、尚未套用時間軸；模型可能寫出不存在的人物或場景\n\n## 需求\n\n${brief}\n${lyricSection}\n## 一句話故事\n\n${draft.premise}\n\n## 開端\n\n${draft.setup}\n\n## 轉折\n\n${draft.turn}\n\n## 結局\n\n${draft.resolution}\n\n## 視覺想法\n\n${draft.visualIdeas}\n\n## 節奏\n\n${draft.pacing}\n\n## 看片後待核對\n\n${draft.evidenceToCheck}\n`;
}
