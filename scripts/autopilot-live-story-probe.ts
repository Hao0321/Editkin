import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createEmptyProject } from "../src/domain/editGraph";
import { generateDesktopStory, listDesktopStoryModels } from "../src/service/localStoryProvider";

const output = process.argv[2];
if (!output || !process.argv.includes("--execute")) {
  throw new Error("Usage: tsx scripts/autopilot-live-story-probe.ts <output.json> --execute");
}
const appData = process.env.APPDATA;
if (!appData) throw new Error("APPDATA is unavailable");
const saved = JSON.parse(readFileSync(join(appData, "studio.hao.autopilotdesk.communitypreview", "local-story", "origin.json"), "utf8")) as { origin?: unknown };
if (typeof saved.origin !== "string") throw new Error("Saved local model origin is missing");
const model = "qwen3.8-27b-nvfp4";
const started = Date.now();
const available = await listDesktopStoryModels(saved.origin);
if (!available.some((item) => item.source === "lan-qwen" && item.name === model)) {
  throw new Error("Selected LAN Qwen is not present in its model list");
}
const lyrics = "桌上留著一封信，風翻過空白的頁；我停在門口沒有走，等到天亮才敢讀。";
try {
  const draft = await generateDesktopStory({
    origin: saved.origin, source: "lan-qwen", model,
    brief: "寫一個普通觀眾能看懂、有起因、轉折與結局的短篇 MV 故事。情緒克制，避免反覆走路和逐字照歌詞拍。",
    context: { mode: "mv", lyrics }, project: createEmptyProject("Synthetic story probe"),
  });
  writeFileSync(output, JSON.stringify({ kind: "synthetic-story-probe", model, lyrics, elapsedMs: Date.now() - started, draft }, null, 2), "utf8");
  process.stdout.write(JSON.stringify({ status: "completed", elapsedMs: Date.now() - started,
    fields: Object.keys(draft), output }) + "\n");
} catch (error) {
  process.stdout.write(JSON.stringify({ status: "failed", elapsedMs: Date.now() - started,
    error: error instanceof Error ? error.message : String(error) }) + "\n");
  process.exitCode = 1;
}
