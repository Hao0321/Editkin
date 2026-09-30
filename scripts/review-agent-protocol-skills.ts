// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 djguan-jpg (https://github.com/djguan-jpg)
// Agent contribution: urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d. See AGENT-NOTICE.md.
/** Acceptance against the exact packaged local gateway and original MCP, without cloud calls. */
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { estimateAgentContextTokens, AGENT_CONTEXT_MAX_TOKENS } from "../src/application/agentContextBudget";
import inventory from "../src/shared/originalAgentSkills.json";

const packageRoot = resolve(process.argv[2] || "");
if (!process.argv[2]) throw Error("Pass the exact portable-preview package directory");
const report = resolve(process.argv[3] || join(dirname(packageRoot), "agent-protocol-skills-review.json"));
const workspace = await mkdtemp(join(dirname(report), "agent-protocol-skills-"));
const project = join(workspace, "protocol.editkin.json");
const kit = join(packageRoot, "resources/video-autopilot-kit");
const runtime = join(packageRoot, "resources/runtime");
const transports: StdioClientTransport[] = [], clients: Client[] = [], processIds: number[] = [];
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const baseEnv = Object.fromEntries(["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "PATHEXT", "COMSPEC"].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
const environment = { ...baseEnv, EDITKIN_WORKSPACE: workspace, EDITKIN_AGENT_PROJECT_PATH: project,
  EDITKIN_CACHE_ROOT: join(workspace, "cache"), EDITKIN_PLUGIN_ROOTS: join(packageRoot, "resources/plugins"),
  EDITKIN_VIDEO_AUTOPILOT_SKILL: join(kit, "SKILL.md"), EDITKIN_CREATIVE_PACK_ROOT: join(workspace, "creative"),
  EDITKIN_PERSONAL_MUSIC_ROOT: join(workspace, "music") };
async function connect(file: string, extra: Record<string, string> = {}) {
  const client = new Client({ name: "editkin-packaged-agent-protocol-review", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [file], cwd: workspace,
    env: { ...environment, ...extra }, stderr: "pipe" });
  transports.push(transport); clients.push(client);
  await client.connect(transport).catch((error) => { throw Error(`Packaged MCP connect failed: ${file}`, { cause: error }); });
  if (transport.pid) processIds.push(transport.pid);
  return client;
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args }).catch((error) => { throw Error(`Packaged protocol request failed: ${name}`, { cause: error }); });
  assert.notEqual(result.isError, true, `Tool failed: ${name}`);
  const text = result.content.filter((item) => item.type === "text").map((item) => item.type === "text" ? item.text : "").join("\n");
  return JSON.parse(text);
}
try {
  await Promise.all(["cache", "creative", "music"].map((name) => mkdir(join(workspace, name))));
  // Bootstrap the isolated project before asking the original MCP to bind its canonical path.
  const direct = await connect(join(runtime, "mcp.mjs"), { EDITKIN_AGENT_PROJECT_PATH: "" });
  await call(direct, "create_project", { projectPath: project, name: "Protocol acceptance", width: 960, height: 540, fps: 30 });
  await call(direct, "apply_edit_commands", { projectPath: project, commands: [{ type: "add_caption", caption: { id: "protocol-caption", start: 0, duration: 2, text: "Before review" } }] });
  const originalTools = (await direct.listTools()).tools.map(tool => tool.name).sort();
  const gateway = await connect(join(runtime, "agent-gateway.mjs"), { EDITKIN_AGENT_GATEWAY_TARGET: join(runtime, "mcp.mjs") });
  const caps = await call(gateway, "get_editkin_agent_capabilities");
  assert.equal(caps.editor, "editkin"); assert.equal(caps.transport, "local-stdio-mcp");
  assert.equal(caps.editorToolCount, originalTools.length);
  assert.equal(caps.editorToolCatalogSha256, digest(JSON.stringify(originalTools)));
  assert.equal(caps.skills.inventoryDigest, inventory.inventoryDigest);
  assert.equal(caps.skills.resourceCount, inventory.files.length);
  assert.deepEqual(caps.skills.skills, inventory.skills);
  assert(estimateAgentContextTokens(JSON.stringify(caps)) <= AGENT_CONTEXT_MAX_TOKENS);
  const packagedInventory = JSON.parse(await readFile(join(kit, "original-agent-skills.json"), "utf8"));
  assert.deepEqual(packagedInventory, inventory);
  const resources: string[] = []; let offset = 0;
  do {
    const page = await call(gateway, "list_kit_resources", { offset, limit: 20 });
    assert(estimateAgentContextTokens(JSON.stringify(page)) <= AGENT_CONTEXT_MAX_TOKENS);
    resources.push(...page.resources.map((resource: { resource: string }) => resource.resource));
    if (page.nextOffset === undefined) break;
    assert(page.nextOffset > offset); offset = page.nextOffset;
  } while (true);
  assert.deepEqual(resources, inventory.files.map(file => file.resource));
  let resourcePages = 0;
  for (const file of inventory.files) {
    const bytes = await readFile(join(kit, file.resource));
    assert.equal(digest(bytes), file.sha256); assert.equal(bytes.length, file.bytes);
    let text = "", offset = 0;
    do {
      const page = await call(gateway, "read_kit_resource", { resource: file.resource, offset });
      resourcePages++;
      assert.equal(page.sha256, file.sha256); assert.equal(page.inventoryDigest, inventory.inventoryDigest);
      assert(estimateAgentContextTokens(JSON.stringify(page)) <= AGENT_CONTEXT_MAX_TOKENS);
      text += page.text;
      if (page.complete) { assert.equal(page.nextOffset, undefined); break; }
      assert(page.nextOffset > offset); offset = page.nextOffset;
    } while (true);
    assert.equal(text, new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  }
  for (const resource of ["../.env", "auth.json", "upstream/../private.md"]) {
    const result = await gateway.callTool({ name: "read_kit_resource", arguments: { resource } });
    assert.equal(result.isError, true);
  }
  const editorCall = (name: string, args: Record<string, unknown>) => call(gateway, "call_editkin_tool", { name, arguments: args });
  const skills = await editorCall("list_installed_editkin_skills", { context: { format: "longform", domain: "general", semanticRoles: [] } });
  assert(skills.candidates.some((skill: { skillId: string }) => skill.skillId === "studio.hao.creator-workflow/balanced-creator-workflow"));
  const pack = await editorCall("get_editkin_skill_pack", { pluginId: "studio.hao.creator-workflow", capabilityId: "balanced-creator-workflow" });
  assert.equal(pack.status, "GREEN"); assert.equal(pack.guardrails.structuredCommandsOnly, true);
  const before = JSON.parse(await readFile(project, "utf8"));
  const edit = await editorCall("apply_edit_commands", { projectPath: project,
    commands: [{ type: "update_caption", captionId: "protocol-caption", patch: { text: "Direct protocol verified" } }] });
  const after = JSON.parse(await readFile(project, "utf8"));
  assert.equal(after.captions[0].text, "Direct protocol verified");
  assert.deepEqual(after.assets, before.assets); assert.deepEqual(after.tracks, before.tracks);
  const readback = await call(direct, "get_project_summary", { projectPath: project });
  const forbidden = await gateway.callTool({ name: "call_editkin_tool", arguments: { name: "create_project", arguments: { projectPath: join(workspace, "other.editkin.json"), name: "Out of scope" } } });
  assert.equal(forbidden.isError, true);
  await writeFile(report, JSON.stringify({ status: "PASS", packageRoot, workspace, processIds, capabilities: caps,
    resourceFiles: resources.length, resourcePages, allOriginalResourcesHashVerified: true, editorPackStatus: pack.status,
    captionMutationReadback: true, projectScopeRejected: true, unlistedPathsRejected: true, edit, readback,
    limitation: "Maintenance Skill is reference only; host grants preserved. Cloud authentication/billing and full film human review are separate." }, null, 2));
  process.stdout.write(JSON.stringify({ status: "PASS", report, resourceFiles: resources.length, resourcePages, editorTools: originalTools.length }) + "\n");
} finally {
  for (const client of clients.reverse()) await client.close().catch(() => undefined);
  for (const transport of transports.reverse()) await transport.close().catch(() => undefined);
}
