import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { MATERIAL_INTELLIGENCE_SCHEMA, type MaterialIntelligencePacket } from "../src/application/materialIntelligence";

function payload(result: { content: Array<{ type: string; text?: string }> }) {
  return JSON.parse(String(result.content.find((item) => item.type === "text")?.text ?? "{}"));
}

const appRoot = resolve(import.meta.dirname, "..");
const workspace = await mkdtemp(join(tmpdir(), "editkin-context-mcp-"));
const cacheRoot = join(workspace, "cache");
const client = new Client({ name: "editkin-context-budget-smoke", version: "0.15.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(appRoot, "node_modules/tsx/dist/cli.mjs"), "src/mcp/server.ts"],
  cwd: appRoot,
  env: {
    ...process.env,
    EDITKIN_WORKSPACE: workspace,
    EDITKIN_CACHE_ROOT: cacheRoot,
    EDITKIN_CREATIVE_PACK_ROOT: resolve(appRoot, ".creative-packs/hao-creator-library"),
    EDITKIN_PERSONAL_MUSIC_ROOT: resolve(appRoot, ".personal-packs/hao-music-library"),
    EDITKIN_PLUGIN_ROOTS: resolve(appRoot, "plugins"),
  } as Record<string, string>,
  stderr: "pipe",
});

try {
  await client.connect(transport);
  const created = await client.callTool({
    name: "create_project",
    arguments: { projectPath: "context.editkin.json", name: "Context budget", width: 960, height: 540, fps: 30 },
  });
  assert.equal(created.isError, undefined, JSON.stringify(created.content));
  const commands = [
    { type: "import_asset", asset: { id: "asset-long", name: "Long local source", kind: "video", uri: "media/long.mp4", duration: 25, width: 960, height: 540 } },
    ...Array.from({ length: 25 }, (_, index) => ({
      type: "add_clip",
      clip: {
        id: `clip-${String(index).padStart(2, "0")}`,
        assetId: "asset-long",
        trackId: "video-main",
        timelineStart: index,
        sourceStart: index,
        duration: 1,
        volume: 1,
        transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
        color: { brightness: 0, contrast: 1, saturation: 1, hue: 0, exposure: 0, temperature: 0, tint: 0, pivot: 0.5, shadows: 0, highlights: 0, blacks: 0, whites: 0 },
        keyframes: [],
      },
    })),
  ];
  const applied = await client.callTool({ name: "apply_edit_commands", arguments: { projectPath: "context.editkin.json", commands } });
  assert.equal(applied.isError, undefined, JSON.stringify(applied.content));

  const firstSession = payload(await client.callTool({
    name: "start_ai_editing_session",
    arguments: { projectPath: "context.editkin.json", clipOffset: 0, clipLimit: 10 },
  }));
  assert.equal(firstSession.clips.length, 10);
  assert.equal(firstSession.clipPage.totalClips, 25);
  assert.equal(firstSession.clipPage.nextOffset, 10);
  const secondSession = payload(await client.callTool({
    name: "start_ai_editing_session",
    arguments: { projectPath: "context.editkin.json", clipOffset: firstSession.clipPage.nextOffset, clipLimit: 10 },
  }));
  assert.equal(secondSession.clips[0].clipId, "clip-10");

  const materialId = "a".repeat(64);
  const packet: MaterialIntelligencePacket = {
    schema: MATERIAL_INTELLIGENCE_SCHEMA,
    materialId,
    source: { assetId: "asset-long", clipId: "clip-00", sourceSha256: "b".repeat(64), sourceStart: 0, duration: 100, kind: "video", fps: 30, hasAudio: true },
    analysis: {
      scene: { state: "ready", engine: "fixture", cuts: Array.from({ length: 100 }, (_, index) => ({ time: index, frame: index * 30, score: 70 })) },
      transcript: {
        state: "ready",
        engine: "fixture",
        language: "zh",
        cueCount: 120,
        cues: Array.from({ length: 120 }, (_, index) => ({ start: index * 0.5, end: index * 0.5 + 0.4, text: `第${index + 1}段${"逐字稿".repeat(20)}` })),
      },
    },
    keyframes: [],
    createdAt: "2026-08-28T00:00:00.000Z",
  };
  const manifestPath = join(cacheRoot, "material-intelligence", materialId, "manifest.json");
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, JSON.stringify(packet), "utf8");
  const firstContext = payload(await client.callTool({
    name: "get_material_context",
    arguments: { materialId, start: 0, end: 60, maxCues: 80, maxTokens: 600, maxCuts: 20 },
  })).context;
  assert.ok(firstContext.budget.estimatedTokens <= 600);
  assert.equal(firstContext.transcript.hasMore, true);
  const secondContext = payload(await client.callTool({
    name: "get_material_context",
    arguments: { materialId, start: 0, end: 60, maxCues: 80, maxTokens: 600, maxCuts: 20, afterCueIndex: firstContext.transcript.nextCueIndex },
  })).context;
  assert.ok(secondContext.transcript.cues[0].index > firstContext.transcript.cues.at(-1).index);

  const firstKnowledge = payload(await client.callTool({ name: "list_community_editing_knowledge", arguments: { offset: 0, limit: 16 } }));
  assert.equal(firstKnowledge.modules.length, 16);
  assert.ok(firstKnowledge.nextOffset > 0);
  const knowledge = payload(await client.callTool({
    name: "read_community_editing_knowledge",
    arguments: { moduleId: firstKnowledge.modules[0].id, offset: 0, maxChars: 6_000, maxTokens: 300 },
  }));
  assert.ok(knowledge.page.estimatedTokens <= 300);

  const report = {
    schema: "editkin.agent-context-budget-mcp-smoke/v1",
    status: "GREEN",
    sessionPagination: { totalClips: firstSession.clipPage.totalClips, pageSize: firstSession.clips.length },
    materialPagination: {
      firstEstimatedTokens: firstContext.budget.estimatedTokens,
      firstCueCount: firstContext.transcript.cues.length,
      secondStartsAfter: firstContext.transcript.nextCueIndex,
    },
    knowledgePagination: { totalModules: firstKnowledge.totalModules, pageSize: firstKnowledge.modules.length, pageEstimatedTokens: knowledge.page.estimatedTokens },
  };
  await writeFile(resolve(appRoot, "../../.rd/benchmarks/editkin-agent-context-budget-mcp-smoke.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report));
} finally {
  await client.close().catch(() => undefined);
  await rm(workspace, { recursive: true, force: true });
}
