import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { appendFileSync, constants } from "node:fs";
import { mkdir, open, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { createInterface } from "node:readline";
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
  const interactive = process.argv.includes("--interactive");
  if (interactive === Boolean(callsPath)) throw new Error("Choose --calls <calls.json> or --interactive --capture-dir <directory> --deadline-utc <ISO timestamp>");
  const deadline = interactive ? Date.parse(argument("--deadline-utc") ?? "") : Infinity;
  if (interactive && (!argument("--capture-dir") || !Number.isFinite(deadline) || deadline <= Date.now() || deadline - Date.now() > 7_200_000)) throw new Error("Interactive mode requires a future fixed deadline within two hours and a capture directory");

  const appRoot = resolve(import.meta.dirname, "..");
  const readCalls = async (path: string) => {
    // Check and read the same opened file, so the path cannot be swapped in between.
    const handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 4 * 1024 * 1024) throw new Error("calls.json must be a regular file no larger than 4 MiB");
      const source = await handle.readFile("utf8");
      if (Buffer.byteLength(source, "utf8") > 4 * 1024 * 1024) throw new Error("calls.json exceeds 4 MiB");
      return validateBatchCalls(JSON.parse(source));
    } finally {
      await handle.close();
    }
  };
  const initialCalls = callsPath ? await readCalls(resolve(callsPath)) : undefined;

  const outputPath = argument("--output");
  const captureDirectory = resolve(argument("--capture-dir") ?? resolve(callsPath!, "../captures"));
  await mkdir(captureDirectory, { recursive: true });
  let capturedBytes = 0;
  const abort = new AbortController();
  const lineReader = interactive ? createInterface({ input: process.stdin, terminal: false }) : undefined;
  const deadlineTimer = interactive ? setTimeout(() => { abort.abort(new Error("Fixed session deadline expired")); lineReader?.close(); }, deadline - Date.now()) : undefined;
  const reserve = (bytes: number) => {
    if (interactive && capturedBytes + bytes > 256 * 1024 * 1024 - 64 * 1024) throw new Error("Interactive capture byte limit reached");
    capturedBytes += bytes;
  };
  const save = async (name: string, data: string | Buffer) => {
    reserve(Buffer.byteLength(data));
    const path = resolve(captureDirectory, name);
    await writeFile(path, data, interactive ? { flag: "wx" } : undefined);
    return path;
  };
  if (interactive) await save("SESSION_STARTED.json", JSON.stringify({ schema: "editkin.mcp-interactive-session/v1", startedUtc: new Date().toISOString(), deadlineUtc: new Date(deadline).toISOString(), reconnect: 0, crossRequestReferences: false }, null, 2));

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
  let callCount = 0;
  let connected = false;
  let closeCompleted = false;
  let terminalReason = "batch_complete";
  const ids = new Set<string>();
  // Drain stderr from the beginning; a full log must not stall the server.
  transport.stderr?.on("data", (chunk: Buffer | string) => {
    try {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      reserve(bytes.length);
      appendFileSync(resolve(captureDirectory, "server.stderr.log"), bytes);
    } catch (error) { abort.abort(error); lineReader?.close(); }
  });
  const run = async (calls: ReturnType<typeof validateBatchCalls>) => {
    if (ids.size + calls.length > 128) throw new Error("Session exceeds 128 unique calls");
    for (const call of calls) {
      if (ids.has(call.id)) throw new Error(`Session call ID already issued: ${call.id}`);
      ids.add(call.id);
    }
    if (interactive && callCount === 0 && calls[0].name !== "get_autopilot_contract") throw new Error("First interactive call must be get_autopilot_contract");
    return await executeBatchCalls(calls, async (call, argumentsValue) => {
      const remaining = deadline - Date.now() - 15_000;
      if (abort.signal.aborted || remaining <= 0) throw new Error("Session deadline leaves no safe tool window");
      const cap = call.name === "render_original_motion_project" ? 600_000 : 180_000;
      const timeout = interactive ? Math.min(call.timeoutMs ?? cap, cap, remaining) : call.timeoutMs;
      await save(`${call.id}.request.json`, JSON.stringify({ name: call.name, arguments: argumentsValue }, null, 2));
      callCount += 1;
      return await client.callTool(
        { name: call.name, arguments: argumentsValue },
        { ...(timeout ? { timeout, maxTotalTimeout: timeout } : {}), signal: abort.signal, resetTimeoutOnProgress: false },
      ) as unknown as BatchToolResult;
    }, async (call, result) => {
      // Preserve the complete SDK result before converting image payloads for display.
      await save(`${call.id}.result.raw.json`, JSON.stringify(result, null, 2));
      const content: Array<Record<string, unknown>> = [];
      let imageIndex = 0;
      for (const item of result.content) {
        if (item.type !== "image") { content.push(item as unknown as Record<string, unknown>); continue; }
        imageIndex += 1;
        if (typeof item.mimeType !== "string" || typeof item.data !== "string") throw new Error("MCP image response is malformed");
        const path = await save(`${call.id}-${String(imageIndex).padStart(2, "0")}${mediaExtension(item.mimeType)}`, Buffer.from(item.data, "base64"));
        content.push({ type: "image_file", mimeType: item.mimeType, path, bytes: Buffer.byteLength(item.data, "base64") });
      }
      return content;
    });
  };
  try {
    await client.connect(transport);
    connected = true;
    if (!interactive) results = await run(initialCalls!);
    else {
      process.stdout.write(`${JSON.stringify({ event: "ready", pid: transport.pid, deadlineUtc: new Date(deadline).toISOString(), crossRequestReferences: false })}\n`);
      terminalReason = "stdin_eof";
      for await (const line of lineReader!) {
        if (abort.signal.aborted) throw abort.signal.reason;
        if (Buffer.byteLength(line) > 4096) throw new Error("Interactive line exceeds 4096 bytes; use a request file");
        const message: unknown = JSON.parse(line);
        if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("Expected requestFile or close object");
        const entry = message as Record<string, unknown>;
        if (Object.keys(entry).length === 1 && entry.close === true) { terminalReason = "explicit_close"; break; }
        if (Object.keys(entry).length !== 1 || typeof entry.requestFile !== "string" || !isAbsolute(entry.requestFile)) throw new Error("Use {requestFile:absolutePath}; references only work within that file");
        const rows = await run(await readCalls(entry.requestFile));
        results.push(...rows);
        const summaryPath = await save(`${rows[0].id}.batch-result.json`, JSON.stringify({ schema: "editkin.mcp-batch-result/v1", calls: rows }, null, 2));
        process.stdout.write(`${JSON.stringify({ event: "request_complete", summaryPath, calls: rows.map(row => ({ id: row.id, name: row.name, isError: row.isError, failurePhase: row.failurePhase, executionMayHaveOccurred: row.executionMayHaveOccurred, rawResultPath: resolve(captureDirectory, `${row.id}.result.raw.json`) })) })}\n`);
        if (rows.some(row => row.failurePhase)) { terminalReason = "transport_or_capture_failure"; break; }
      }
      if (callCount === 0) throw new Error("Interactive session ended without a first contract call");
    }
  } catch (error) {
    terminalReason = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
    if (!interactive) throw error;
  } finally {
    lineReader?.close();
    if (deadlineTimer) clearTimeout(deadlineTimer);
    let closeTimer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([client.close().then(() => { closeCompleted = true; }), new Promise<never>((_resolve, reject) => { closeTimer = setTimeout(() => reject(new Error("Client close exceeded 15 seconds")), 15_000); })]);
    } finally {
      if (closeTimer) clearTimeout(closeTimer);
      if (interactive) {
        const terminal = { schema: "editkin.mcp-interactive-terminal/v1", terminal: true, connected, connectAttempts: 1, callCount, closeCompleted, capturedBytes, terminalReason, reconnect: 0, endedUtc: new Date().toISOString(), pid: transport.pid };
        await writeFile(resolve(captureDirectory, "SESSION_TERMINAL.json"), JSON.stringify(terminal, null, 2), { flag: "wx" });
        process.stdout.write(`${JSON.stringify({ event: "terminal", ...terminal })}\n`);
      }
    }
  }

  const payload = { schema: "editkin.mcp-batch-result/v1", calls: results };
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  if (outputPath) await writeFile(resolve(outputPath), serialized, "utf8");
  if (!interactive) process.stdout.write(serialized);
  if (results.some((result) => result.isError)) process.exitCode = 1;
}

void main();
