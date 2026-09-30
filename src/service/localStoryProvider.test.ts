import { afterEach, describe, expect, it } from "vitest";
import { createServer, type RequestListener, type Server } from "node:http";
import { createEmptyProject } from "../domain/editGraph";
import { assertLocalStoryOrigin, generateDesktopStory, listDesktopStoryModels } from "./localStoryProvider";

const draft = {
  premise: "一個人必須做出決定。", setup: "消息傳來。", turn: "原計畫失效。",
  resolution: "主角自己決定。", visualIdeas: "用空間變化表現。", pacing: "轉折前放慢。",
  evidenceToCheck: "逐鏡確認動作。",
};
const servers: Server[] = [];
async function mockServer(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server missing port");
  return `http://127.0.0.1:${address.port}`;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()))));
});

describe("desktop local story provider", () => {
  it("accepts only private-IP origins without credentials or paths", () => {
    expect(assertLocalStoryOrigin("http://192.168.1.8:8000/")).toBe("http://192.168.1.8:8000");
    for (const bad of ["https://192.168.1.8:8000", "http://example.com:8000", "http://8.8.8.8:8000", "http://user:pass@10.0.0.1:8000", "http://10.0.0.1:8000/v1", "http://10.0.0.1:8000/?next=x"]) {
      expect(() => assertLocalStoryOrigin(bad)).toThrow();
    }
  });

  it("directly discovers Qwen and filters Ollama Cloud despite proxy environment", async () => {
    const requests: string[] = [];
    const origin = await mockServer((req, res) => {
      requests.push(req.url ?? "");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(req.url === "/v1/models"
        ? { data: [{ id: "qwen3.8-27b-nvfp4" }, { id: "other" }] }
        : { models: [{ name: "local:latest", size: 100 }, { name: "other-cloud", size: 100 }] }));
    });
    const before = process.env.HTTP_PROXY;
    process.env.HTTP_PROXY = "http://127.0.0.1:1";
    try {
      expect(await listDesktopStoryModels(origin, origin)).toEqual([
        { source: "lan-qwen", name: "qwen3.8-27b-nvfp4", label: "區網 Qwen 3.8 27B (PNY)" },
        { source: "ollama", name: "local:latest", label: "本機 Ollama · local:latest" },
      ]);
      expect(requests).toEqual(["/v1/models", "/api/tags"]);
    } finally {
      if (before === undefined) delete process.env.HTTP_PROXY;
      else process.env.HTTP_PROXY = before;
    }
  });

  it("sends only brief and asset metadata to Qwen, then rejects incomplete output", async () => {
    let body = "";
    let incomplete = false;
    const origin = await mockServer((req, res) => {
      req.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(incomplete ? { status: "incomplete", output: [] } : { status: "completed", output: [
          { type: "reasoning", content: [{ type: "reasoning_text", text: "internal" }] },
          { type: "message", content: [{ type: "output_text", text: JSON.stringify(draft) }] },
        ] }));
      });
    });
    const project = createEmptyProject();
    project.assets.push({ id: "asset-1", name: "clip.mp4", kind: "video", uri: "C:/private/clip.mp4", duration: 8 });
    const before = JSON.stringify(project);
    const input = { origin, source: "lan-qwen" as const, model: "qwen3.8-27b-nvfp4", brief: "主角做決定", project,
      context: { mode: "mv" as const, lyrics: "副歌：主角做決定" } };
    expect(await generateDesktopStory(input)).toEqual(draft);
    expect(body).toContain("clip.mp4");
    expect(body).toContain("副歌：主角做決定");
    expect(body).not.toContain("C:/private/clip.mp4");
    expect(JSON.stringify(project)).toBe(before);
    incomplete = true;
    await expect(generateDesktopStory(input)).rejects.toThrow(/未完成/);
  });
});
