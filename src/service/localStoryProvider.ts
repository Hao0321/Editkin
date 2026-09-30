import { parseStoryDraft, storyPrompt, type StoryContext, type StoryDraft, type StoryModel } from "../application/localStoryDraft";
import type { EditProject } from "../domain/types";
import { request as httpRequest } from "node:http";

const OLLAMA = "http://127.0.0.1:11434";
const QWEN_MODEL = "qwen3.8-27b-nvfp4";
const MAX_BODY = 2 * 1024 * 1024;

export function assertLocalStoryOrigin(value: string): string {
  const input = value.trim();
  if (!input) return "";
  let url: URL;
  try { url = new URL(input); } catch { throw new Error("區網位址格式不正確"); }
  if (url.protocol !== "http:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("只接受不含帳密或路徑的 HTTP 私有 IP 位址");
  }
  const parts = url.hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    throw new Error("只接受 IPv4 私有 IP 或 loopback，不接受網域名稱");
  }
  const [a, b] = parts;
  if (!(a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168))) {
    throw new Error("位址必須是 loopback 或私有區網 IP");
  }
  return url.origin;
}

async function request(url: string, init: { method?: "GET" | "POST"; body?: string }, timeoutMs: number): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const payload = init.body ? Buffer.from(init.body, "utf8") : undefined;
    const signal = AbortSignal.timeout(timeoutMs);
    const call = httpRequest(url, {
      method: init.method ?? "GET", agent: false, signal,
      headers: payload ? { "Content-Type": "application/json", "Content-Length": payload.byteLength } : undefined,
    }, (response) => {
      const status = response.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        response.resume();
        reject(new Error(status === 503 ? "模型服務暫時無法完成（503）" : `模型服務回應 ${status}`));
        return;
      }
      const length = Number(response.headers["content-length"]);
      if (Number.isFinite(length) && length > MAX_BODY) {
        call.destroy(new Error("模型回應超過大小限制"));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > MAX_BODY) call.destroy(new Error("模型回應超過大小限制"));
        else chunks.push(chunk);
      });
      response.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown); }
        catch { reject(new Error("模型回應不是有效 JSON")); }
      });
      response.on("error", reject);
    });
    call.on("error", (error) => reject(signal.aborted ? new Error("模型請求逾時或已取消") : error));
    if (payload) call.write(payload);
    call.end();
  });
}

export async function listDesktopStoryModels(originInput: string, ollamaOrigin = OLLAMA): Promise<StoryModel[]> {
  const origin = assertLocalStoryOrigin(originInput);
  const models: StoryModel[] = [];
  if (origin) {
    try {
      const body = await request(`${origin}/v1/models`, {}, 7000) as { data?: Array<{ id?: unknown }> };
      if (Array.isArray(body?.data) && body.data.some((entry) => entry?.id === QWEN_MODEL)) {
        models.push({ source: "lan-qwen", name: QWEN_MODEL, label: "區網 Qwen 3.8 27B (PNY)" });
      }
    } catch { /* Unavailable source is omitted, never silently substituted. */ }
  }
  try {
    const body = await request(`${ollamaOrigin}/api/tags`, {}, 5000) as { models?: Array<{ name?: unknown; size?: unknown }> };
    if (Array.isArray(body?.models)) {
      models.push(...body.models.filter((item) => typeof item.name === "string" && typeof item.size === "number" && item.size > 0 && !/(?:^|[:/\\-])cloud(?:$|[:/\\-])/i.test(item.name))
        .map((item) => ({ source: "ollama" as const, name: item.name as string, label: `本機 Ollama · ${item.name}` })));
    }
  } catch { /* No Ollama installed. */ }
  return models;
}

export async function generateDesktopStory(input: {
  origin: string; source: StoryModel["source"]; model: string; brief: string; project: EditProject; context?: StoryContext;
}): Promise<StoryDraft> {
  const origin = assertLocalStoryOrigin(input.origin);
  const prompt = storyPrompt(input.brief, input.project, input.context);
  if (input.source === "lan-qwen") {
    if (!origin || input.model !== QWEN_MODEL) throw new Error("區網 Qwen 未設定或模型不符");
    const body = await request(`${origin}/v1/responses`, {
      method: "POST",
      body: JSON.stringify({ model: input.model, input: prompt, max_output_tokens: 4000 }),
    }, 120_000) as { status?: unknown; output?: Array<{ type?: unknown; content?: Array<{ type?: unknown; text?: unknown }> }> };
    if (body?.status !== "completed" || !Array.isArray(body.output)) throw new Error("區網 Qwen 未完成故事草稿");
    const content = body.output.filter((item) => item?.type === "message")
      .flatMap((item) => Array.isArray(item.content) ? item.content : [])
      .filter((item) => item?.type === "output_text" && typeof item.text === "string")
      .map((item) => item.text).join("\n");
    return parseStoryDraft(content);
  }
  if (input.source !== "ollama" || !input.model.trim() || /(?:^|[:/\\-])cloud(?:$|[:/\\-])/i.test(input.model)) {
    throw new Error("只接受已選取的本機 Ollama 模型");
  }
  const body = await request(`${OLLAMA}/api/generate`, {
    method: "POST",
    body: JSON.stringify({ model: input.model, prompt, format: "json", stream: false, think: false, options: { temperature: 0.4, num_predict: 900 } }),
  }, 120_000) as { response?: unknown };
  if (typeof body?.response !== "string") throw new Error("Ollama 未回傳可讀草稿");
  return parseStoryDraft(body.response);
}
