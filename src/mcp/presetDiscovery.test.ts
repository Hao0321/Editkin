import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers = vi.hoisted(() => new Map<string, (request: unknown) => Promise<any>>());
vi.mock("@modelcontextprotocol/server", () => ({
  McpServer: class {
    registerTool(name: string, _configuration: unknown, handler: (request: unknown) => Promise<any>) {
      handlers.set(name, handler);
    }
  },
}));
vi.mock("@modelcontextprotocol/server/stdio", () => ({ serveStdio: () => ({ close: async () => {} }) }));
import { createServer } from "./server";
import { compactMotionGraphicPresets, findMotionGraphicPreset } from "../creative/motionGraphicPresets";

beforeEach(() => { handlers.clear(); createServer(); });
const call = (request: unknown) => handlers.get("list_creative_presets")!(request);
const body = (result: any) => JSON.parse(result.content.find((item: any) => item.type === "text").text);

describe("progressive motion-preset discovery", () => {
  it("keeps the complete compact index available without expanding seeds", async () => {
    const value = body(await call({ kind: "motion" }));
    expect(value.presets.motionGraphics).toEqual(compactMotionGraphicPresets());
    expect(value.presets.motionGraphics.every((preset: any) => !("seed" in preset))).toBe(true);
  });
  it.each(["travel_editorial_hero", "travel_editorial_eyebrow_dark"])("expands %s without retransmitting the whole catalog", async motionPresetId => {
    const value = body(await call({ kind: "motion", motionPresetId }));
    expect(value.presets.selectedMotionPreset).toEqual(findMotionGraphicPreset(motionPresetId));
    expect(value.presets).not.toHaveProperty("motionGraphics");
    expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThan(8192);
  });
  it("preserves other explicitly requested families for kind=all", async () => {
    const value = body(await call({ kind: "all", motionPresetId: "travel_editorial_hero" }));
    expect(value.presets.looks.length).toBeGreaterThan(0);
    expect(value.presets.formatTemplates.shortForm.length).toBeGreaterThan(0);
    expect(value.presets.selectedMotionPreset.seed.presetId).toBe("travel_editorial_hero");
    expect(value.presets).not.toHaveProperty("motionGraphics");
  });
  it("rejects unknown ids instead of fabricating a seed", async () => {
    expect((await call({ kind: "motion", motionPresetId: "not-a-registered-preset" })).isError).toBe(true);
  });
  it("rejects a mismatched kind instead of silently ignoring the selector", async () => {
    expect((await call({ kind: "look", motionPresetId: "travel_editorial_hero" })).isError).toBe(true);
  });
});
