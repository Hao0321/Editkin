import { beforeEach, describe, expect, it, vi } from "vitest";

const registrations = vi.hoisted(() => ({
  instructions: [] as string[],
  tools: [] as string[],
  configurations: new Map<string, Record<string, unknown>>(),
}));

vi.mock("@modelcontextprotocol/server", () => ({
  McpServer: class {
    constructor(_identity: unknown, options?: { instructions?: string }) {
      registrations.instructions.push(options?.instructions ?? "");
    }

    registerTool(name: string, configuration: Record<string, unknown>) {
      registrations.tools.push(name);
      registrations.configurations.set(name, configuration);
    }
  },
}));
vi.mock("@modelcontextprotocol/server/stdio", () => ({
  serveStdio: () => ({ close: async () => undefined }),
}));

import {
  createServerForEnvironment,
  EDITKIN_REMOTE_ONLY_MCP_INSTRUCTIONS,
  remoteOnlyMcpMode,
} from "./server";

beforeEach(() => {
  registrations.instructions.length = 0;
  registrations.tools.length = 0;
  registrations.configurations.clear();
});

describe("Remote-only MCP server", () => {
  it("publishes only the three bounded Remote research tools and Remote-only instructions", () => {
    createServerForEnvironment({ EDITKIN_MCP_MODE: "remote-only" });
    expect(registrations.tools.sort()).toEqual([
      "get_remote_setup_status",
      "list_remote_provider_connectors",
      "prepare_remote_setup",
    ]);
    expect(registrations.instructions).toEqual([EDITKIN_REMOTE_ONLY_MCP_INSTRUCTIONS]);
    expect(registrations.instructions[0]).not.toMatch(/auto.?edit|material intelligence|computer use/i);
    expect(registrations.instructions[0]).toMatch(/do not deploy|no phone or Mac verification/i);
    const prepare = registrations.configurations.get("prepare_remote_setup")!;
    expect(prepare.description).toMatch(/不登入供應商、不部署、不付款/);
    expect(prepare.description).not.toMatch(/一鍵完成|最佳品質|已連線/);
    const inputSchema = prepare.inputSchema as { safeParse(value: unknown): { success: boolean } };
    expect(inputSchema.safeParse({ transport: "https-tunnel", providerId: "legacy-shallow-input" }).success).toBe(false);
    expect(inputSchema.safeParse({
      connectorId: "tailscale-funnel",
      transport: "https-tunnel",
      provider: { id: "tailscale", displayName: "Tailscale", productName: "Funnel", region: "Taiwan" },
      expectedEndpoint: { transport: "https-tunnel", publicOriginRequired: true, description: "Public HTTPS route to Editkin Remote" },
      pricing: { kind: "unknown", amountMicros: null, currency: null, billingUnit: "unknown", summary: "No verified public price is available" },
      freeTier: "No verified free tier",
      quota: "Quota has not been verified",
      permissions: ["Create one tunnel"],
      plannedMutations: ["Create one provider tunnel"],
      cancellationOrDeletionConsequences: "The public route is removed only after provider deletion is confirmed",
      sources: [{ label: "Provider documentation", url: "https://docs.example.test/tunnel" }],
      uncertainties: ["Price and quota require user review"],
      unsupportedPrerequisites: ["Provider login is outside Stage 1"],
    }).success).toBe(true);
  });

  it("rejects a misspelled mode instead of widening to the full server", () => {
    expect(() => remoteOnlyMcpMode({ EDITKIN_MCP_MODE: "remote-ony" })).toThrow(/not a supported closed-world mode/);
    expect(() => createServerForEnvironment({ EDITKIN_MCP_MODE: "remote-ony" })).toThrow(/not a supported closed-world mode/);
  });
});
