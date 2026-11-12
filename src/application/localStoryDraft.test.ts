import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { generateLanQwenStoryDraft, generateOllamaStoryDraft, listOllamaModels, listStoryModels, makeStoryDraftArtifact, parseStoryDraft, parseStoryDraftArtifact, storyDraftMarkdown, storyProjectContextSignature, storyPrompt } from "./localStoryDraft";

const draft = {
  premise: "一個人必須決定是否留下。",
  setup: "主角收到消息。",
  turn: "原先的選擇失效。",
  resolution: "主角自己做出決定。",
  visualIdeas: "用空間變化表現決定。",
  pacing: "轉折前放慢。",
  evidenceToCheck: "確認素材是否有可見的決定動作。",
};

afterEach(() => vi.unstubAllGlobals());

describe("local story draft", () => {
  it("excludes cloud and non-local model entries", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ models: [
      { name: "local:latest", size: 1000 }, { name: "remote:cloud", size: 0 }, { name: "other-cloud", size: 1000 },
    ] }), { status: 200 })));
    expect(await listOllamaModels()).toEqual(["local:latest"]);
  });

  it("prefers the verified LAN Qwen model while retaining local Ollama choices", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("/v1/models")
      ? { data: [{ id: "qwen3.8-27b-nvfp4" }, { id: "other-cloud" }] }
      : { models: [{ name: "local:latest", size: 1000 }] }), { status: 200 })));
    expect(await listStoryModels()).toEqual([
      { source: "lan-qwen", name: "qwen3.8-27b-nvfp4", label: "區網 Qwen 3.8 27B" },
      { source: "ollama", name: "local:latest", label: "本機 Ollama · local:latest" },
    ]);
  });

  it("rejects incomplete model output instead of presenting it as a reviewable draft", () => {
    expect(() => parseStoryDraft(JSON.stringify({ premise: "只有一句話" }))).toThrow(/setup/);
    expect(() => parseStoryDraft("沒有 JSON")).toThrow(/有效的 JSON/);
    expect(parseStoryDraft(`思考內容 </think>\n${JSON.stringify(draft)}`)).toEqual(draft);
  });

  it("requires lyrics for MV and identifies them as user text, without claiming audio alignment", () => {
    const project = createEmptyProject();
    expect(() => storyPrompt("一封信被送達", project, { mode: "mv" })).toThrow(/歌詞/);
    const prompt = storyPrompt("一封信被送達", project, { mode: "mv", lyrics: "第一段：留著信\n副歌：終於寄出" });
    expect(prompt).toContain("第一段：留著信");
    expect(prompt).toContain("沒有對齊歌曲時間");
    expect(prompt).toContain("沒有看過素材畫面");
    expect(storyDraftMarkdown(draft, "區網 Qwen", "一封信被送達", { mode: "mv", lyrics: "副歌：終於寄出" })).toContain("副歌：終於寄出");
  });

  it("roundtrips an unverified story card without paths and tracks asset changes across saves", () => {
    const project = createEmptyProject();
    project.assets.push({ id: "asset-1", name: "scene.mp4", kind: "video", uri: "C:/private/scene.mp4", duration: 8 });
    const contextSignature = storyProjectContextSignature(project);
    const artifact = makeStoryDraftArtifact({ project: { id: project.id, revision: project.revision,
      updatedAt: project.updatedAt, contextSignature }, sourceLabel: "區網 Qwen", brief: "一封信被讀到",
      context: { mode: "mv", lyrics: "副歌：終於看見" }, draft });
    expect(parseStoryDraftArtifact(JSON.parse(JSON.stringify(artifact)))).toEqual(artifact);
    expect(JSON.stringify(artifact)).not.toContain("C:/private/scene.mp4");
    expect(artifact.status).toBe("unverified");
    project.revision += 1;
    project.updatedAt = new Date().toISOString();
    expect(storyProjectContextSignature(project)).toBe(contextSignature);
    project.assets.find((asset) => asset.id === "asset-1")!.name = "replacement.mp4";
    expect(storyProjectContextSignature(project)).not.toBe(contextSignature);
    expect(() => parseStoryDraftArtifact({ ...artifact, draft: { premise: "只有一句" } })).toThrow(/setup/);
    expect(() => parseStoryDraftArtifact({ ...artifact, status: "approved" })).toThrow(/格式/);
  });

  it("sends only brief and asset metadata to fixed loopback Ollama, without changing the project", async () => {
    const project = createEmptyProject();
    project.assets.push({ id: "asset-1", name: "test.mp4", kind: "video", uri: "C:/private/source.mp4", duration: 8 });
    const before = JSON.stringify(project);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ response: JSON.stringify(draft) }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await generateOllamaStoryDraft({ model: "local-test", brief: "主角做決定", project, signal: new AbortController().signal });
    expect(result).toEqual(draft);
    expect(JSON.stringify(project)).toBe(before);
    const [url, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:11434/api/generate");
    expect(options.body).toContain("test.mp4");
    expect(options.body).not.toContain("C:/private/source.mp4");
    expect(storyDraftMarkdown(result, "local-test", "主角做決定")).toContain("尚未看片、尚未核對素材、尚未套用時間軸");
    await expect(generateOllamaStoryDraft({ model: "remote:cloud", brief: "主角做決定", project, signal: new AbortController().signal })).rejects.toThrow(/Ollama Cloud/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends LAN Qwen only the brief and asset metadata through the local proxy", async () => {
    const project = createEmptyProject();
    project.assets.push({ id: "asset-1", name: "test.mp4", kind: "video", uri: "C:/private/source.mp4", duration: 8 });
    const before = JSON.stringify(project);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: "completed", output: [
      { type: "reasoning", content: [{ type: "reasoning_text", text: "internal reasoning" }] },
      { type: "message", content: [{ type: "output_text", text: JSON.stringify(draft) }] },
    ] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await generateLanQwenStoryDraft({ model: "qwen3.8-27b-nvfp4", brief: "主角做決定", project, context: { mode: "mv", lyrics: "副歌：自己決定" }, signal: new AbortController().signal })).toEqual(draft);
    const [url, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/__local_llm/openai-compatible/v1/responses");
    expect(options.body).toContain("test.mp4");
    expect(options.body).toContain("副歌：自己決定");
    expect(options.body).not.toContain("C:/private/source.mp4");
    expect(JSON.stringify(project)).toBe(before);
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ status: "incomplete", output: [] }), { status: 200 }));
    await expect(generateLanQwenStoryDraft({ model: "qwen3.8-27b-nvfp4", brief: "主角做決定", project, signal: new AbortController().signal })).rejects.toThrow(/未完成/);
  });
});
