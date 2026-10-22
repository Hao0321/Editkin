import type { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { registerMultiSourceShortToolsV2, MULTI_SOURCE_SHORT_TOOLS_V2 } from "./multiSourceShortToolsV2";

describe("unapproved multi-source version boundary", () => {
  it("is absent from default AI/VA tool discovery", () => {
    const registerTool = vi.fn();
    registerMultiSourceShortToolsV2({ registerTool } as unknown as McpServer, {});
    expect(registerTool).not.toHaveBeenCalled();
  });
  it("registers its separate version only when the engineering runtime explicitly opts in", () => {
    const registerTool = vi.fn();
    registerMultiSourceShortToolsV2({ registerTool } as unknown as McpServer, { EDITKIN_ENABLE_MULTI_SHORT_V2: "1" });
    expect(registerTool.mock.calls.map(call => call[0])).toEqual([...MULTI_SOURCE_SHORT_TOOLS_V2]);
    expect(registerTool.mock.calls.some(call => call[0] === "make_template_short")).toBe(false);
  });
});
