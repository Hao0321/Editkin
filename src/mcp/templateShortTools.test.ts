import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse as parsePath, resolve } from "node:path";
import * as z from "zod/v4";
import type { EditProject } from "../domain/types";
import { compactAutopilotContract } from "../application/autopilotPlan";
import { acquireProjectLock } from "../application/projectFiles";
import { TEMPLATE_SHORT_BRIEF_SCHEMA, TEMPLATE_SHORT_START_SCHEMA } from "../application/templateShortBrief";
import { TEMPLATE_SHORT_FIXTURE_COPY, TEMPLATE_SHORT_FIXTURE_POLICY, templateShortFixtureProject } from "../application/templateShortFixtures";
import type { TemplateShortDeps } from "../application/templateShortRun";
import { TEMPLATE_SHORT_RULING, TEMPLATE_SHORT_TOOLS, registerTemplateShortTools, templateShortProvider } from "./templateShortTools";

// M1 one-tool Short wave 2 step 2.4: the four MCP tools over the orchestrator (fake product boundary, real files).
type Handler = (input: any) => Promise<{ isError?: boolean; content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> }>;
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const FRAME_BYTES = 400_000;
const frame = (id: string) => Buffer.concat([Buffer.from(`jpeg:${id}:`), Buffer.alloc(FRAME_BYTES - 9 - id.length)]);
let root = "", tools = new Map<string, { config: { description?: string; inputSchema?: unknown }; handler: Handler }>(), project: EditProject | undefined;

function deps(): TemplateShortDeps {
  const keyframes = ["kf-1", "kf-2", "kf-3"].map((id, index) => ({ id, time: [0.1, 5.5, 10.9][index], sceneIndex: 0, sha256: sha(frame(id)), bytes: FRAME_BYTES,
    mimeType: "image/jpeg" as const, fileName: `frame-0${index + 1}.jpg` }));
  const packet = () => ({ schema: "hao.editkin.material-intelligence/v1", materialId: "5".repeat(64), keyframes,
    source: { assetId: "source-img-4022", clipId: "clip-img-4022", sourceSha256: "4".repeat(64), sourceStart: 0, duration: 11, kind: "video", fps: 30, hasAudio: true },
    analysis: { scene: { state: "ready", cuts: [] }, transcript: { state: "not_applicable", cueCount: 0, cues: [] } }, createdAt: "2026-10-09T00:00:00.000Z" }) as never;
  const unused = async () => { throw new Error("not used by these tool checks"); };
  return {
    root, now: () => new Date("2026-10-09T12:00:00+08:00"), randomHex: () => "3f9a1c",
    readDefaults: async () => ({ defaults: { schema: "editkin.template-short-defaults/v1", confirmedBy: "creator", confirmedAt: "2026-10-09T00:00:00+08:00", excludedSources: [],
      rights: [{ scope: "videos", declaration: { provenance: "本人拍攝", rightsBasis: "本人著作權", distributionScope: "自有頻道", license: "creator-owned" } }] }, sha256: "a".repeat(64) }),
    resolveSource: async path => ({ absolute: resolve(root, path), relative: path }),
    probe: async () => ({ duration: 11.333, width: 1080, height: 1920, hasVideo: true, hasAudio: true }),
    readReviewPolicy: async () => ({ policy: TEMPLATE_SHORT_FIXTURE_POLICY }),
    createProject: async projectPath => { const created = templateShortFixtureProject(); created.assets = []; created.tracks[0].clips = [];
      await mkdir(parsePath(resolve(root, projectPath)).dir, { recursive: true }); await writeFile(resolve(root, projectPath), JSON.stringify(created)); return created; },
    prepareBootstrap: async input => { project = templateShortFixtureProject({ durationFrames: input.durationFrames });
      project.assets[0].id = input.assetId; project.tracks[0].clips[0] = { ...project.tracks[0].clips[0], id: input.clipId, assetId: input.assetId };
      return { commands: [], binding: { source: { sha256: "4".repeat(64), bytes: 1 } } }; },
    applyBootstrap: async projectPath => { await writeFile(resolve(root, projectPath), JSON.stringify(project)); return structuredClone(project!); },
    readProject: async () => structuredClone(project!),
    fileSha256: async () => "b".repeat(64),
    speechModelReady: async () => false,
    prepareMaterial: async () => ({ packet: packet(), cacheHit: true }),
    readMaterial: async () => packet(),
    readKeyframe: async (_material, frameId) => ({ frame: keyframes.find(row => row.id === frameId)!, data: frame(frameId) }),
    recordSemantics: unused, readFactSources: unused, readIdentity: unused, resolveSkill: unused, compileTemplate: unused, compileDesign: unused,
    designIdentity: () => { throw new Error("not used"); }, prepareBatch: unused, executeBatch: unused, readback: unused,
    freeBytes: async () => 500 * 1024 ** 3, tempDirectory: () => tmpdir(), lock: path => acquireProjectLock(path), writeLearningEvent: unused, readExecutionAttribution: unused,
  };
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "editkin-template-short-tools-"));
  tools = new Map();
  const server = { server: { getClientVersion: () => ({ name: "claude-code", version: "2.0.0" }) },
    registerTool: (name: string, config: { inputSchema?: unknown }, handler: Handler) => { tools.set(name, { config, handler }); } };
  registerTemplateShortTools(server as never, deps());
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const call = (name: string, input: unknown) => tools.get(name)!.handler(input);
const json = (result: Awaited<ReturnType<Handler>>) => JSON.parse(result.content.find(item => item.type === "text")!.text!);

describe("template short MCP tools", () => {
  it("registers exactly the four tools the contract advertises, each quoting the M174 ruling where it acts", () => {
    expect([...tools.keys()]).toEqual([...TEMPLATE_SHORT_TOOLS]);
    expect(compactAutopilotContract().templateShort).toMatchObject({ schema: "editkin.template-short-composer/v1", tools: [...TEMPLATE_SHORT_TOOLS], ruling: TEMPLATE_SHORT_RULING });
    for (const name of ["start_template_short", "make_template_short", "record_template_short_review"]) expect(tools.get(name)!.config.description).toContain(TEMPLATE_SHORT_RULING);
    for (const { config } of tools.values()) {
      expect(() => z.toJSONSchema(config.inputSchema as z.ZodType, { io: "input" })).not.toThrow();
    }
  });

  it("start returns image blocks under the 1,000,000-byte cap and pages the rest; the continuation serves them", async () => {
    const first = await call("start_template_short", { schema: TEMPLATE_SHORT_START_SCHEMA, source: { path: "videos/_INBOX/IMG_4022.MOV", in: 0, out: 11 }, genre: "travel" });
    expect(first.isError).toBeUndefined();
    const images = first.content.filter(item => item.type === "image");
    expect(images).toHaveLength(2);
    expect(images.every(image => image.mimeType === "image/jpeg")).toBe(true);
    expect(images.reduce((sum, image) => sum + Buffer.from(image.data!, "base64").length, 0)).toBeLessThanOrEqual(1_000_000);
    const text = json(first);
    expect(text).toMatchObject({ status: "AWAITING_BRIEF", shortId: "ts-20261009-img-4022-3f9a1c", framesPending: ["kf-3"] });
    const second = await call("start_template_short", { schema: TEMPLATE_SHORT_START_SCHEMA, shortId: text.shortId, framePage: 2 });
    expect(second.content.filter(item => item.type === "image")).toHaveLength(1);
    expect(json(second).framesPending).toEqual([]);
  });

  it("enforces the canonical byte caps (start ≤512 B, make ≤1,024 B) as BLOCK results, not thrown errors", async () => {
    const start = await call("start_template_short", { schema: TEMPLATE_SHORT_START_SCHEMA, source: { path: `videos/${"長".repeat(200)}.mov` }, genre: "travel" });
    expect(start.isError).toBe(true);
    expect(json(start)).toMatchObject({ status: "BLOCK_START", block: { code: "BLOCK_START", detail: expect.stringMatching(/上限 512 bytes/) } });
    const make = await call("make_template_short", { schema: TEMPLATE_SHORT_BRIEF_SCHEMA, shortId: "ts-20261009-img-4022-3f9a1c",
      seen: [{ kf: "kf-1", note: "看".repeat(48) }, { kf: "kf-2", note: "看".repeat(48) }, { kf: "kf-3", note: "看".repeat(48) }, { kf: "kf-4", note: "看".repeat(48) }],
      copy: { ...TEMPLATE_SHORT_FIXTURE_COPY.strike_reframe, proof: "很".repeat(40) } });
    expect(json(make)).toMatchObject({ status: "BLOCK_BRIEF", block: { detail: expect.stringMatching(/上限 1024 bytes/) } });
  });

  it("get returns the durable state under 20 KB and names an unknown short", async () => {
    const text = json(await call("start_template_short", { schema: TEMPLATE_SHORT_START_SCHEMA, source: { path: "videos/_INBOX/IMG_4022.MOV", in: 0, out: 11 }, genre: "travel" }));
    const result = await call("get_template_short", { shortId: text.shortId });
    expect(Buffer.byteLength(result.content[0].text!)).toBeLessThanOrEqual(20 * 1024);
    expect(json(result)).toMatchObject({ schema: "editkin.template-short-result/v1", status: "AWAITING_BRIEF", phase: "awaiting_brief" });
    expect(json(await call("get_template_short", { shortId: "ts-20261009-nope-000000" }))).toMatchObject({ status: "BLOCK_BRIEF" });
  });

  it("maps the MCP client name to the plan's inference provider", () => {
    expect([templateShortProvider("claude-code"), templateShortProvider("Codex CLI"), templateShortProvider("cursor"), templateShortProvider(undefined)])
      .toEqual(["claude_code", "codex", "other", "other"]);
  });
});
