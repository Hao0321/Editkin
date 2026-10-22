import { expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/server";
import { longformCaptionDraftInputV1, registerLongformCaptionDraftToolsV1 } from "./longformCaptionDraftToolsV1";
import type { readLongformCaptionDraftV1 } from "../application/longformCaptionDraftV1";
function fixture() {
  let handler!: (input: any) => Promise<any>, config: any;
  const server = { registerTool: (name: string, value: any, callback: any) => { expect(name).toBe("read_longform_caption_draft"); config = value; handler = callback; } } as unknown as McpServer;
  const read = vi.fn(async () => ({ lines: [], contentVerified: false, projectModified: false } as unknown as Awaited<ReturnType<typeof readLongformCaptionDraftV1>>));
  registerLongformCaptionDraftToolsV1(server, { EDITKIN_WORKSPACE: "D:/owned", EDITKIN_CACHE_ROOT: "D:/owned/cache" }, read);
  return { handler, config, read };
}
it("registers only a read-only strict page schema and passes the actual workspace/cache through", async () => {
  const f = fixture(); expect(f.config.annotations.readOnlyHint).toBe(true);
  expect(longformCaptionDraftInputV1.safeParse({ artifactId: "a".repeat(64), apply: true }).success).toBe(false);
  expect(longformCaptionDraftInputV1.safeParse({ artifactId: "a".repeat(64), limit: 201 }).success).toBe(false);
  const response = await f.handler({ artifactId: "a".repeat(64), offset: 1, limit: 2 });
  expect(response.isError).not.toBe(true);
  expect(f.read).toHaveBeenCalledWith(expect.objectContaining({ sourceRoot: expect.stringMatching(/owned$/), cacheRoot: expect.stringMatching(/cache$/) }), "a".repeat(64), 15, 1, 2);
});
it("returns a bounded refusal for a single oversized source word without splitting its clock", async () => {
  const f = fixture(); f.read.mockResolvedValueOnce({ lines: [{ text: "x".repeat(270000) }] } as any);
  const response = await f.handler({ artifactId: "a".repeat(64) });
  expect(response.isError).toBe(true); expect(response.content[0].text).toContain("RESPONSE_BUDGET");
});
it("surfaces original source validation failures without reporting a prepared page", async () => {
  const f = fixture(); f.read.mockRejectedValueOnce(Error("WORD_TIMING_WINDOW_CACHE_SHA"));
  const response = await f.handler({ artifactId: "a".repeat(64) });
  expect(response.isError).toBe(true); expect(response.content[0].text).toContain("WINDOW_CACHE_SHA");
});
