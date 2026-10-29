import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";

vi.mock("@modelcontextprotocol/server/stdio", () => ({ serveStdio: () => ({ close: async () => {} }) }));
import { createServerForEnvironment } from "./server";
import { EDITKIN_MCP_INSTRUCTIONS } from "./materialIntelligenceTools";
import { ADMIN_TOOLS, ALWAYS_ADVERTISED_TOOLS, COMPAT_LEGACY_TOOLS, mcpProfileFromEnvironment, profileToolNames, V5_TOOL_SLOTS } from "./mcpProfiles";

async function connect(environment: NodeJS.ProcessEnv) {
  const server = createServerForEnvironment(environment);
  const client = new Client({ name: "editkin-profile-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const listed = await client.listTools();
  return { client, server, names: listed.tools.map(tool => tool.name), bytes: Buffer.byteLength(JSON.stringify(listed.tools)), tools: listed.tools };
}

describe("W2-1 MCP profiles", () => {
  it("defaults to compat and refuses an unknown profile instead of widening", () => {
    expect(mcpProfileFromEnvironment({})).toBe("compat");
    expect(mcpProfileFromEnvironment({ EDITKIN_MCP_PROFILE: "" })).toBe("compat");
    for (const profile of ["compat", "v5", "full", "admin"]) expect(mcpProfileFromEnvironment({ EDITKIN_MCP_PROFILE: profile })).toBe(profile);
    expect(() => mcpProfileFromEnvironment({ EDITKIN_MCP_PROFILE: "ful" })).toThrow(/must be one of/);
    expect(() => createServerForEnvironment({ EDITKIN_MCP_PROFILE: "everything" })).toThrow(/must be one of/);
  });

  it("advertises each profile's tools, keeps the SDK's own definitions, and stays within its byte budget", async () => {
    const full = await connect({ EDITKIN_MCP_PROFILE: "full" });
    const compat = await connect({});
    const v5 = await connect({ EDITKIN_MCP_PROFILE: "v5" });
    const admin = await connect({ EDITKIN_MCP_PROFILE: "admin" });
    try {
      // Every name a profile reserves for legacy tools exists (no stale names), and nothing else leaks in.
      for (const name of [...COMPAT_LEGACY_TOOLS, ...ADMIN_TOOLS, ...ALWAYS_ADVERTISED_TOOLS]) expect(full.names).toContain(name);
      expect(new Set(compat.names)).toEqual(new Set(full.names.filter(name => profileToolNames("compat").includes(name))));
      // W2-4 registered the first Agent API v5 slot (`job`); the others stay reserved until their packages land.
      const registeredSlots = V5_TOOL_SLOTS.filter(slot => full.names.includes(slot));
      expect(registeredSlots).toEqual(["job"]);
      expect(compat.names).toHaveLength(COMPAT_LEGACY_TOOLS.length + ALWAYS_ADVERTISED_TOOLS.length + registeredSlots.length);
      expect(new Set(v5.names)).toEqual(new Set([...ALWAYS_ADVERTISED_TOOLS, ...registeredSlots]));
      expect(new Set(admin.names)).toEqual(new Set([...ALWAYS_ADVERTISED_TOOLS, ...ADMIN_TOOLS]));
      // Filtering never rewrites a definition: compat entries are byte-identical to full's.
      const fullByName = new Map(full.tools.map(tool => [tool.name, JSON.stringify(tool)]));
      for (const tool of compat.tools) expect(JSON.stringify(tool)).toBe(fullByName.get(tool.name));
      expect(full.bytes).toBeLessThan(320_000);
      expect(compat.bytes).toBeLessThan(200_000);
      expect(v5.bytes).toBeLessThan(4_000);
      expect(admin.bytes).toBeLessThan(40_000);
    } finally {
      await Promise.all([full, compat, v5, admin].map(async ({ client }) => client.close()));
    }
  }, 300_000);

  it("advertises in compat every tool Editkin's own instructions and session workflow tell an agent to call", async () => {
    const full = await connect({ EDITKIN_MCP_PROFILE: "full" });
    try {
      const mentioned = full.names.filter(name => new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(EDITKIN_MCP_INSTRUCTIONS));
      const workflow = ["prepare_ai_material", "view_material_keyframes", "get_material_context", "record_material_semantics", "prepare_original_motion_source",
        "prepare_original_motion_source_revision", "inspect_roto_keyer_capabilities", "record_roto_keyer_evidence", "build_autopilot_roto_keyer_decision",
        "prepare_autopilot_auto_roto", "resolve_autopilot_inference_route", "audit_autopilot_plan", "apply_autopilot_plan", "audit_longform_plan_set",
        "apply_longform_plan_set", "render_project", "render_original_motion_project"];
      expect(mentioned.length).toBeGreaterThan(20);
      for (const name of [...mentioned, ...workflow]) expect(profileToolNames("compat"), name).toContain(name);
    } finally { await full.client.close(); }
  }, 300_000);

  it("keeps in the default profile everything the desktop Agent Connect probe requires (src-tauri agent_runtime_probe.rs)", async () => {
    const compat = await connect({});
    try {
      for (const name of ["get_autopilot_contract", "start_ai_editing_session", "audit_autopilot_plan", "apply_autopilot_plan", "render_project",
        "get_remote_setup_status", "prepare_remote_setup", "configure_remote_access", "verify_remote_access"]) expect(compat.names).toContain(name);
      expect(compat.names.length).toBeGreaterThanOrEqual(35);
      const required = (name: string) => ((compat.tools.find(tool => tool.name === name)?.inputSchema as { required?: string[] } | undefined)?.required ?? []);
      expect(required("audit_autopilot_plan")).toEqual(expect.arrayContaining(["projectPath", "plan"]));
      expect(required("apply_autopilot_plan")).toEqual(expect.arrayContaining(["projectPath", "plan", "auditReceipt"]));
    } finally { await compat.client.close(); }
  }, 300_000);

  it("keeps a tool a profile hides callable by its exact name (dispatch is never filtered)", async () => {
    const v5 = await connect({ EDITKIN_MCP_PROFILE: "v5" });
    const full = await connect({ EDITKIN_MCP_PROFILE: "full" });
    try {
      expect(v5.names).not.toContain("validate_project");
      const result = await v5.client.callTool({ name: "validate_project", arguments: { projectPath: "../escape.editkin.json" } });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("EDITKIN_WORKSPACE");
      const status = await v5.client.callTool({ name: "get_editkin_status", arguments: {} });
      const payload = JSON.parse((status.content as Array<{ text: string }>)[0].text);
      expect(payload.engine).toMatchObject({ mcpProfile: "v5", advertisedTools: 3 });
      expect(payload.engine.registeredTools).toBe(full.names.length);
    } finally { await Promise.all([v5.client.close(), full.client.close()]); }
  }, 300_000);
});
