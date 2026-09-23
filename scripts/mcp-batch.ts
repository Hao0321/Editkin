import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { executeBatchCalls, validateBatchCalls, type BatchResultRow, type BatchToolResult } from "./mcpBatchReferences";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function cleanEnvironment(extra: Record<string, string>): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    ),
    ...extra,
  };
}

function mediaExtension(mimeType: string): string {
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/webp") return ".webp";
  if (mimeType === "image/gif") return ".gif";
  return ".jpg";
}

async function main(): Promise<void> {
  const callsPath = argument("--calls");
  if (!callsPath) throw new Error("Usage: tsx scripts/mcp-batch.ts --calls <calls.json> [--output <result.json>] [--capture-dir <directory>]");

  const appRoot = resolve(import.meta.dirname, "..");
  const callSource = await readFile(resolve(callsPath), "utf8");
  if (Buffer.byteLength(callSource, "utf8") > 4 * 1024 * 1024) throw new Error("calls.json exceeds 4 MiB");
  const calls = validateBatchCalls(JSON.parse(callSource));

  const outputPath = argument("--output");
  const captureDirectory = resolve(argument("--capture-dir") ?? resolve(callsPath, "../captures"));
  await mkdir(captureDirectory, { recursive: true });

  const tsxCli = resolve(appRoot, "node_modules/tsx/dist/cli.mjs");
  const client = new Client({ name: "editkin-local-batch", version: "0.15.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [tsxCli, "src/mcp/server.ts"],
    cwd: appRoot,
    env: cleanEnvironment({
      EDITKIN_WORKSPACE: process.env.EDITKIN_WORKSPACE ?? resolve(appRoot, "../.."),
      EDITKIN_CREATIVE_PACK_ROOT: process.env.EDITKIN_CREATIVE_PACK_ROOT ?? resolve(appRoot, ".creative-packs/hao-creator-library"),
      EDITKIN_PERSONAL_MUSIC_ROOT: process.env.EDITKIN_PERSONAL_MUSIC_ROOT ?? resolve(appRoot, ".personal-packs/hao-music-library"),
      EDITKIN_PLUGIN_ROOTS: process.env.EDITKIN_PLUGIN_ROOTS ?? resolve(appRoot, "plugins"),
      EDITKIN_MODEL_ROOT: process.env.EDITKIN_MODEL_ROOT ?? resolve(appRoot, "../../.rd/models/whisper"),
      EDITKIN_CACHE_ROOT: process.env.EDITKIN_CACHE_ROOT ?? resolve(appRoot, "../../.rd/cache/editkin-mcp"),
      EDITKIN_COLOR_ROOT: process.env.EDITKIN_COLOR_ROOT ?? resolve(appRoot, "public/color/aces2"),
      HAO_FFMPEG_PATH: process.env.HAO_FFMPEG_PATH ?? resolve(appRoot, "vendor/ffmpeg/win32-x64/ffmpeg.exe"),
      HAO_FFPROBE_PATH: process.env.HAO_FFPROBE_PATH ?? resolve(appRoot, "vendor/ffmpeg/win32-x64/ffprobe.exe"),
      HAO_NATIVE_CORE_PATH: process.env.HAO_NATIVE_CORE_PATH ?? resolve(appRoot, "native/bin/win32-x64/hao-core.exe"),
      EDITKIN_WHISPER_CLI_PATH: process.env.EDITKIN_WHISPER_CLI_PATH ?? resolve(appRoot, "vendor/whisper/win32-x64/whisper-cli.exe"),
    }),
    stderr: "pipe",
  });

  let results: BatchResultRow[] = [];
  try {
    await client.connect(transport);
    results = await executeBatchCalls(calls, async (call, argumentsValue) => {
      return await client.callTool(
        { name: call.name, arguments: argumentsValue },
        call.timeoutMs ? { timeout: call.timeoutMs, maxTotalTimeout: call.timeoutMs } : undefined,
      ) as unknown as BatchToolResult;
    }, async (call, result) => {
      const content: Array<Record<string, unknown>> = [];
      let imageIndex = 0;
      for (const item of result.content) {
        if (item.type !== "image") {
          content.push(item as unknown as Record<string, unknown>);
          continue;
        }
        imageIndex += 1;
        if (typeof item.mimeType !== "string" || typeof item.data !== "string") throw new Error("MCP image response is malformed");
        const extension = mediaExtension(item.mimeType);
        const fileName = `${call.id}-${String(imageIndex).padStart(2, "0")}${extension}`;
        const path = resolve(captureDirectory, fileName);
        await writeFile(path, Buffer.from(item.data, "base64"));
        content.push({ type: "image_file", mimeType: item.mimeType, path, bytes: Buffer.byteLength(item.data, "base64") });
      }
      return content;
    });
  } finally {
    await client.close();
  }

  const payload = { schema: "editkin.mcp-batch-result/v1", calls: results };
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  if (outputPath) await writeFile(resolve(outputPath), serialized, "utf8");
  process.stdout.write(serialized);
  if (results.some((result) => result.isError)) process.exitCode = 1;
}

void main();
