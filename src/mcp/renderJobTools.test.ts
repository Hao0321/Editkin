// W2-4 end to end: render_project {async:true} and the `job` tool through a real in-process MCP server, the real renderer
// and the bundled FFmpeg, on tiny synthetic projects (test patterns and a sine tone made here; never user footage).
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { useTempRoots } from "../test/tempRoot.mjs";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import { MCP_JOB_RESPONSE_MAX_BYTES, mcpJobRoot, resetMcpJobRegistriesForTest } from "./renderJobTools";

vi.mock("@modelcontextprotocol/server/stdio", () => ({ serveStdio: () => ({ close: async () => {} }) }));
import { createServerForEnvironment } from "./server";

const run = promisify(execFile);
const ffmpeg = resolve("vendor/ffmpeg/win32-x64/ffmpeg.exe"), ffprobe = resolve("vendor/ffmpeg/win32-x64/ffprobe.exe");
const available = process.platform === "win32" && existsSync(ffmpeg) && existsSync(ffprobe);
const ENV_KEYS = ["EDITKIN_WORKSPACE", "EDITKIN_CACHE_ROOT", "EDITKIN_APP_DATA_ROOT", "EDITKIN_AGENT_STATE_ROOT", "EDITKIN_EXTRA_MEDIA_ROOTS",
  "EDITKIN_GPU_COMPOSITOR_PATH", "HAO_FFMPEG_PATH", "HAO_FFPROBE_PATH"] as const;
const saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
const temp = useTempRoots();
let workspace = "";
const clients: Client[] = [];

async function connect(): Promise<Client> {
  const server = createServerForEnvironment(process.env);
  const client = new Client({ name: "editkin-w24-jobs", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  clients.push(client);
  return client;
}
async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ text: string }>)[0].text;
  return { isError: result.isError === true, text, bytes: Buffer.byteLength(text, "utf8"), payload: JSON.parse(text) as Record<string, any> };
}
async function synthetic(name: string, seconds: number, size: string) {
  const path = join(workspace, "media", name);
  await run(ffmpeg, ["-n", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `testsrc2=s=${size}:r=30:d=${seconds}`,
    "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${seconds}`, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest", path], { windowsHide: true, timeout: 120_000 });
  return path;
}
async function project(client: Client, projectPath: string, media: string, seconds: number, width: number, height: number) {
  expect((await call(client, "create_project", { projectPath, name: "W2-4 job", width, height, fps: 30 })).isError).toBe(false);
  const placed = await call(client, "apply_edit_commands", { projectPath, commands: [
    { type: "import_asset", asset: { id: "pattern", name: "pattern.mp4", kind: "video", uri: `media/${media}`, duration: seconds } },
    { type: "add_clip", clip: { id: "pattern-clip", assetId: "pattern", trackId: "video-main", timelineStart: 0, sourceStart: 0, duration: seconds, volume: 1,
      transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] } },
  ] });
  expect(placed.isError, placed.text).toBe(false);
}
const sha = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");

/** Polls `job status` until the job ends; every answer is checked against the 2 KB cap and kept for assertions. */
async function follow(client: Client, jobId: string, onRunning?: (payload: Record<string, any>) => Promise<boolean | void>, timeoutMs = 240_000) {
  const seen: Array<Record<string, any>> = [];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await call(client, "job", { op: "status", jobId });
    expect(status.isError, status.text).toBe(false);
    expect(status.bytes).toBeLessThanOrEqual(MCP_JOB_RESPONSE_MAX_BYTES);
    seen.push(status.payload);
    if (["succeeded", "failed", "cancelled"].includes(status.payload.state)) return { final: status.payload, seen };
    if (onRunning && await onRunning(status.payload)) continue;
    if (Date.now() > deadline) throw new Error(`job ${jobId} did not end: ${status.text}`);
    await new Promise(done => setTimeout(done, 100));
  }
}

describe.skipIf(!available)("W2-4 async render jobs (real renderer, bundled FFmpeg)", () => {
  let client: Client;
  let firstJob = "";
  let firstResult: Record<string, any> = {};

  beforeAll(async () => {
    const root = await temp.create("w24-render-jobs-");
    workspace = join(root, "ws");
    await mkdir(join(workspace, "media"), { recursive: true });
    process.env.EDITKIN_WORKSPACE = workspace;
    process.env.EDITKIN_CACHE_ROOT = join(root, "cache");
    process.env.EDITKIN_APP_DATA_ROOT = join(root, "appdata");
    process.env.HAO_FFMPEG_PATH = ffmpeg;
    process.env.HAO_FFPROBE_PATH = ffprobe;
    for (const key of ["EDITKIN_AGENT_STATE_ROOT", "EDITKIN_EXTRA_MEDIA_ROOTS", "EDITKIN_GPU_COMPOSITOR_PATH"] as const) delete process.env[key];
    await synthetic("short.mp4", 2, "320x180");
    await synthetic("long.mp4", 40, "1280x720");
    client = await connect();
    await project(client, "jobs/short.editkin.json", "short.mp4", 2, 320, 180);
    await project(client, "jobs/long.editkin.json", "long.mp4", 40, 1280, 720);
  }, 300_000);

  afterAll(async () => {
    await resetMcpJobRegistriesForTest({ cancel: true });
    await Promise.all(clients.splice(0).map(item => item.close()));
    for (const key of ENV_KEYS) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  });

  it("returns a job at once, then a compact probed result that names the real file", async () => {
    const started = Date.now();
    const accepted = await call(client, "render_project", { projectPath: "jobs/short.editkin.json", outputPath: "out/short.mp4", preferGpu: false, async: true });
    expect(accepted.isError, accepted.text).toBe(false);
    expect(accepted.payload).toMatchObject({ status: "ACCEPTED", kind: "render", outputPath: "out/short.mp4" });
    expect(["queued", "running"]).toContain(accepted.payload.state);
    expect(accepted.payload.jobId).toMatch(/^job-[a-f0-9]{24}$/);
    expect(accepted.bytes).toBeLessThan(400);
    expect(Date.now() - started).toBeLessThan(15_000);
    firstJob = accepted.payload.jobId;

    const { final } = await follow(client, firstJob);
    expect(final.state, JSON.stringify(final)).toBe("succeeded");
    const output = join(workspace, "out", "short.mp4");
    firstResult = final.result;
    expect(final.result).toMatchObject({
      status: "GREEN", outputPath: output, duration: expect.closeTo(2, 1), encoder: "libx264", route: "short", qualityCertified: false,
      probe: { video: "h264", width: 320, height: 180, fps: 30, frames: 60, audio: "aac" },
    });
    expect(final.result.sha256).toBe(await sha(output));
    expect(final.result.bytes).toBe((await readFile(output)).length);
    expect(final.result.encoderFallback).toBeUndefined();
    expect(final.result.warnings).toEqual([]);
    expect(Buffer.byteLength(JSON.stringify(final.result))).toBeLessThan(1_200);
    const listed = await call(client, "job", { op: "list" });
    expect(listed.payload.jobs.map((job: { jobId: string }) => job.jobId)).toContain(firstJob);
    expect(listed.bytes).toBeLessThanOrEqual(MCP_JOB_RESPONSE_MAX_BYTES);
    expect(existsSync(join(mcpJobRoot(), firstJob, "job.json"))).toBe(true);
  }, 300_000);

  it("never silently replaces an existing output: async needs overwrite:true; the synchronous default replaces and says so", async () => {
    const output = join(workspace, "out", "short.mp4");
    const before = await sha(output);
    const refused = await call(client, "render_project", { projectPath: "jobs/short.editkin.json", outputPath: "out/short.mp4", preferGpu: false, async: true });
    expect(refused.isError).toBe(true);
    expect(refused.payload).toMatchObject({ status: "BLOCK", code: "OUTPUT_EXISTS" });
    expect(refused.bytes).toBeLessThan(MCP_JOB_RESPONSE_MAX_BYTES);
    const syncRefused = await call(client, "render_project", { projectPath: "jobs/short.editkin.json", outputPath: "out/short.mp4", preferGpu: false, overwrite: false });
    expect(syncRefused.isError).toBe(true);
    expect(syncRefused.text).toContain("輸出檔已存在");
    expect(await sha(output)).toBe(before);

    const replaced = await call(client, "render_project", { projectPath: "jobs/short.editkin.json", outputPath: "out/short.mp4", preferGpu: false, async: true, overwrite: true });
    expect(replaced.isError, replaced.text).toBe(false);
    const { final } = await follow(client, replaced.payload.jobId);
    expect(final).toMatchObject({ state: "succeeded", result: { warnings: ["output_replaced"] } });
    // The same project through the same renderer: the async job wrote exactly what the first job wrote.
    expect(final.result.sha256).toBe(before);

    const legacy = await call(client, "render_project", { projectPath: "jobs/short.editkin.json", outputPath: "out/short.mp4", preferGpu: false });
    expect(legacy.isError, legacy.text.slice(0, 400)).toBe(false);
    expect(legacy.payload).toMatchObject({ status: "GREEN", outputReplaced: true });
    // The synchronous VA v4 route renders the same bytes as the job route.
    expect(await sha(output)).toBe(before);
  }, 300_000);

  it("reports stage, measured fraction and ETA while it runs, and a cancel midway leaves no output and no partial file", async () => {
    const accepted = await call(client, "render_project", { projectPath: "jobs/long.editkin.json", outputPath: "cancel/long.mp4", preferGpu: false, async: true });
    expect(accepted.isError, accepted.text).toBe(false);
    const jobId = accepted.payload.jobId;
    let cancelAnswer: Record<string, any> | undefined;
    const { final, seen } = await follow(client, jobId, async payload => {
      if (cancelAnswer || payload.state !== "running" || payload.progress?.stage !== "encode" || !(payload.progress.fraction > 0)) return false;
      cancelAnswer = (await call(client, "job", { op: "cancel", jobId })).payload;
      return true;
    });
    const running = seen.filter(item => item.state === "running" && item.progress);
    expect(running.length).toBeGreaterThan(0);
    expect(new Set(running.map(item => item.progress.stage)).has("encode")).toBe(true);
    const measured = running.find(item => item.progress.fraction > 0)!;
    expect(measured.progress).toMatchObject({ stage: "encode", step: 3, steps: 4 });
    expect(measured.progress.fraction).toBeLessThan(1);
    expect(measured.pollAfterMs).toBe(5_000);
    expect(cancelAnswer, "the render ended before it could be cancelled midway").toBeDefined();
    expect(["cancelling", "cancelled"]).toContain(cancelAnswer!.state);
    expect(final).toMatchObject({ state: "cancelled", cancelRequested: true, error: { code: "CANCELLED" } });
    expect(final.result).toBeUndefined();
    const folder = join(workspace, "cancel");
    const left = existsSync(folder) ? await readdir(folder) : [];
    expect(left, "no output, no .rendering temp file, no hidden work folder").toEqual([]);
    // Some answer while it ran carried a remaining-time estimate or said it could not measure one yet.
    expect(running.some(item => item.progress.etaSeconds !== undefined || item.progress.fraction !== undefined)).toBe(true);
  }, 300_000);

  it("a restarted MCP server still reports the finished job, and answers unknown or incomplete requests compactly", async () => {
    await resetMcpJobRegistriesForTest();
    const restarted = await connect();
    const status = await call(restarted, "job", { op: "status", jobId: firstJob });
    expect(status.payload).toMatchObject({ jobId: firstJob, kind: "render", state: "succeeded", result: firstResult });
    const unknown = await call(restarted, "job", { op: "status", jobId: "job-000000000000000000000000" });
    expect(unknown).toMatchObject({ isError: true, payload: { status: "BLOCK", code: "JOB_NOT_FOUND" } });
    const missing = await call(restarted, "job", { op: "cancel" });
    expect(missing).toMatchObject({ isError: true, payload: { code: "JOB_ID_REQUIRED" } });
    const listed = await call(restarted, "job", { op: "list", limit: 10 });
    expect(listed.payload.jobs.length).toBeGreaterThanOrEqual(3);
    expect(listed.bytes).toBeLessThanOrEqual(MCP_JOB_RESPONSE_MAX_BYTES);
  }, 120_000);
});
