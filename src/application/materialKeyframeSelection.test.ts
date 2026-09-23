import { expect, it } from "vitest";
import { prepareMaterialIntelligence, selectMaterialKeyframeTimes, type PrepareMaterialRequest } from "./materialIntelligence";
import { registerMaterialIntelligenceTools } from "../mcp/materialIntelligenceTools";
import type { McpServer } from "@modelcontextprotocol/server";

it("targets a local event exactly instead of silently substituting uniform overview frames", () => {
  const times = [23, 23.25, 23.5, 24, 24.5, 25, 25.5, 26];
  const selected = selectMaterialKeyframeTimes(431.96666666666664, [], 8, times);
  expect(selected).toEqual(times);
  expect(selected).not.toBe(times);
  selected[0] = 99;
  expect(times[0]).toBe(23);
});

it("retains the known-good default sampling control", () => {
  expect(selectMaterialKeyframeTimes(12, [], 8)).toEqual([0.1, 6, 11.9]);
});

it("retains exact subframe requests without rounding", () => {
  expect(selectMaterialKeyframeTimes(1, [], 2, [0, 1 / 60])).toEqual([0, 1 / 60]);
  expect(selectMaterialKeyframeTimes(1, [], 12, Array.from({ length: 12 }, (_, i) => i / 20))).toHaveLength(12);
});

it.each([
  [], [NaN], [Infinity], [-0.1], [1], [0.2, 0.2], [0.3, 0.2], [true], ["0.2"], null,
  Array.from({ length: 13 }, (_, i) => i / 20),
].map(times => [times]))("rejects invalid or excessive explicit samples: %j", (times) => {
  expect(() => selectMaterialKeyframeTimes(1, [], 12, times as number[])).toThrow(/keyframe|抽幀/i);
});

it("never raises the requested material budget to accommodate more samples", () => {
  expect(() => selectMaterialKeyframeTimes(1, [], 2, [0.1, 0.2, 0.3])).toThrow(/keyframe|抽幀/i);
});

it("validates explicit sampling before touching sources or starting analysis", async () => {
  const request = { assetId: "a", clipId: "c", sourcePath: "missing-source", sourceStart: 0, duration: 1, fps: 30, kind: "video", keyframeTimes: [1] } as PrepareMaterialRequest;
  const runtime = { ffmpegPath: "missing-tool", cacheRoot: "missing-cache", modelRoot: "missing-model" };
  await expect(prepareMaterialIntelligence(request, runtime)).rejects.toThrow(/keyframe|抽幀/i);
  for (const kind of ["audio", "image"] as const) {
    await expect(prepareMaterialIntelligence({ ...request, kind, keyframeTimes: [0.1] }, runtime)).rejects.toThrow(/keyframe|抽幀/i);
  }
});

it("exposes explicit samples through the real MCP input schema rather than stripping them", () => {
  const configurations = new Map<string, { inputSchema: { parse(input: unknown): unknown } }>();
  registerMaterialIntelligenceTools({ registerTool: (name: string, configuration: never) => configurations.set(name, configuration) } as unknown as McpServer);
  const schema = configurations.get("prepare_ai_material")!.inputSchema;
  expect(schema.parse({ projectPath: "p", clipId: "c", keyframeTimes: [23, 24] })).toMatchObject({ keyframeTimes: [23, 24] });
  expect(() => schema.parse({ projectPath: "p", clipId: "c", keyframeTimes: [true] })).toThrow();
  expect(() => schema.parse({ projectPath: "p", clipId: "c", keyframeTimes: Array(13).fill(0.1) })).toThrow();
});
